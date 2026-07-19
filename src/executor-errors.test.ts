import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';

const baseOperation = {
	operationId: 'listCountries',
	method: 'GET',
	pathTemplate: '/v1/countries',
	summary: 'List countries and tax classifications',
};

const baseRequest = {
	method: 'GET',
	path: '/v1/countries',
	query: {},
};

const executeWithResponse = (code: string, response: unknown) => new QuickJsExecutor().execute(
	code,
	{ spec: {} },
	{
		hostFunctions: {
			__lexwareRequestJson: async () => JSON.stringify(response),
		},
	},
);

test('lexware.json error includes status, category, and operation metadata', async () => {
	const response = {
		ok: false,
		status: 401,
		statusText: 'Unauthorized',
		errorCategory: 'auth',
		operation: baseOperation,
		request: baseRequest,
		contentType: 'application/json',
		headers: {},
		data: { message: 'unauthorized' },
	};

	const execution = await executeWithResponse(`async () => await lexware.json({ path: '/v1/countries' })`, response);

	assert.ok(execution.error);
	assert.match(execution.error, /401/);
	assert.match(execution.error, /Category: auth/);
	assert.match(execution.error, /listCountries \(GET \/v1\/countries\)/);
});

test('lexware.paginate error includes rate-limit retry metadata', async () => {
	const response = {
		ok: false,
		status: 429,
		statusText: 'Too Many Requests',
		errorCategory: 'rate_limit',
		retryAfterSeconds: 30,
		operation: {
			operationId: 'getVoucherList',
			method: 'GET',
			pathTemplate: '/v1/voucherlist',
			summary: 'Retrieve and filter voucherlist',
		},
		request: {
			method: 'GET',
			path: '/v1/voucherlist',
			query: { page: ['0'], size: ['250'] },
		},
		contentType: 'application/json',
		headers: {},
		data: { message: 'too many requests' },
	};

	const execution = await executeWithResponse(`async () => await lexware.paginate({
		path: '/v1/voucherlist',
		query: { voucherType: 'invoice', voucherStatus: 'paid' }
	}, { maxPages: 1 })`, response);

	assert.ok(execution.error);
	assert.match(execution.error, /429/);
	assert.match(execution.error, /Category: rate_limit/);
	assert.match(execution.error, /Retry after: 30s/);
});

test('lexware.request returns non-OK envelopes without throwing', async () => {
	const response = {
		ok: false,
		status: 401,
		statusText: 'Unauthorized',
		errorCategory: 'auth',
		operation: baseOperation,
		request: baseRequest,
		contentType: 'application/json',
		headers: {},
		data: { message: 'unauthorized' },
	};

	const execution = await executeWithResponse(`async () => await lexware.request({ path: '/v1/countries' })`, response);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, response);
});
