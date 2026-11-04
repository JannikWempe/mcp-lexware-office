import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient } from './lexware-client.js';

const upstreamHeaders = {
	'content-type': 'application/json',
	'location': 'https://api.lexware.io/v1/contacts/id',
	'x-ratelimit-remaining': '1',
	'x-amzn-requestid': 'aws-id',
	'x-amz-apigw-id': 'gw-id',
	'content-security-policy': "default-src 'none'",
	'strict-transport-security': 'max-age=31536000',
};

const client = () => new LexwareApiClient({
	apiKey: 'test-key',
	baseUrl: 'https://example.test',
	rateLimitIntervalMs: 0,
	fetchImpl: async () => new Response('{}', { status: 200, headers: upstreamHeaders }),
});

test('responses only include allowlisted headers by default', async () => {
	const response = await client().request({ path: '/v1/countries' });

	assert.deepEqual(response.headers, {
		'content-type': 'application/json',
		'location': 'https://api.lexware.io/v1/contacts/id',
		'x-ratelimit-remaining': '1',
	});
});

test('includeAllHeaders returns every upstream header', async () => {
	const response = await client().request({ path: '/v1/countries', includeAllHeaders: true });

	assert.deepEqual(response.headers, upstreamHeaders);
});

test('includeAllHeaders must be a boolean', async () => {
	await assert.rejects(client().request({ path: '/v1/countries', includeAllHeaders: 'yes' }), /includeAllHeaders must be a boolean/);
});
