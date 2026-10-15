import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';
import type { LexwareRequestInput, LexwareRequestOptions, LexwareResponse, MultipartPart } from './lexware-client.js';
import { createLexwareSdk, lexwareSandbox, lexwareSdkDeclaration } from './lexware-sandbox-sdk.js';

const okResponse = (data: unknown, overrides: Partial<LexwareResponse> = {}): LexwareResponse => ({
	ok: true,
	status: 200,
	statusText: 'OK',
	request: { method: 'GET', path: '/v1/countries', query: {} },
	contentType: 'application/json',
	headers: {},
	data,
	...overrides,
});

const unauthorized = okResponse({ message: 'unauthorized' }, {
	ok: false,
	status: 401,
	statusText: 'Unauthorized',
	errorCategory: 'auth',
	operation: { operationId: 'listCountries', method: 'GET', pathTemplate: '/v1/countries', summary: 'List countries and tax classifications' },
});

const rateLimited = okResponse({ message: 'too many requests' }, {
	ok: false,
	status: 429,
	statusText: 'Too Many Requests',
	errorCategory: 'rate_limit',
	retryAfterSeconds: 30,
	operation: { operationId: 'getVoucherList', method: 'GET', pathTemplate: '/v1/voucherlist', summary: 'Retrieve and filter voucherlist' },
	request: { method: 'GET', path: '/v1/voucherlist', query: { page: ['0'], size: ['250'] } },
});

// SDK whose host answers every request with `respond(input)`; `inputs` records the requests.
const sdkWith = (respond: (input: Record<string, any>) => LexwareResponse = () => okResponse({})) => {
	const inputs: Record<string, any>[] = [];
	const sdk = createLexwareSdk(async (payload) => {
		const input = JSON.parse(payload) as Record<string, any>;
		inputs.push(input);
		return JSON.stringify(respond(input));
	});
	return { sdk, inputs };
};

const { sdk: lexware } = sdkWith();

const messageOf = (fn: () => unknown) => {
	try {
		fn();
		return 'no error';
	} catch (error) {
		return (error as Error).message;
	}
};

// Runs guest code in QuickJS with the real prelude; the client stub answers with `respond`.
const runInSandbox = (code: string, respond: () => LexwareResponse = () => okResponse({}), capabilities: Record<string, unknown> = {}) => {
	const client = { request: async () => respond() };
	return new QuickJsExecutor().execute(code, capabilities, lexwareSandbox(client));
};

test('lexware.requireNumber accepts zero, numbers, numeric strings, and dotted paths', () => {
	assert.equal(lexware.requireNumber({ openAmount: 0 }, 'openAmount'), 0);
	assert.equal(lexware.requireNumber({ totalAmount: 12.34 }, 'totalAmount'), 12.34);
	assert.equal(lexware.requireNumber({ totalAmount: '12.34' }, 'totalAmount'), 12.34);
	assert.equal(lexware.requireNumber({ totalAmount: '-12.34' }, 'totalAmount'), -12.34);
	assert.equal(lexware.requireNumber({ totalAmount: '.99' }, 'totalAmount'), 0.99);
	assert.equal(lexware.requireNumber({ totalAmount: '0.00' }, 'totalAmount'), 0);
	assert.equal(lexware.requireNumber({ totalPrice: { totalNetAmount: 10 } }, 'totalPrice.totalNetAmount'), 10);
});

test('lexware.requireNumber throws for missing fields and non-numeric values', () => {
	assert.equal(messageOf(() => lexware.requireNumber({ openAmount: 1 }, 'totalAmount')), 'Missing expected field totalAmount. Available fields: openAmount');
	assert.match(messageOf(() => lexware.requireNumber({ totalPrice: {} }, 'totalPrice.totalNetAmount')), /Missing expected field totalPrice\.totalNetAmount/);
	for (const amount of ['NaN', Infinity, null, '', '  ', false, true]) {
		assert.equal(messageOf(() => lexware.requireNumber({ amount }, 'amount')), `Expected numeric amount, got ${JSON.stringify(amount)}`);
	}
	assert.equal(messageOf(() => lexware.requireNumber({}, '')), 'fieldPath must be a non-empty string');
});

test('lexware money helpers sum integer cents and format stable strings', () => {
	assert.equal(lexware.sumMoney([{ amount: 0.1 }, { amount: 0.2 }], 'amount'), 30);
	assert.equal(lexware.requireMoney({ amount: '60396.07' }, 'amount'), 6039607);
	assert.equal(lexware.requireMoney({ totalPrice: { totalNetAmount: '10.99' } }, 'totalPrice.totalNetAmount'), 1099);
	assert.equal(lexware.requireMoney({ amount: '1.005' }, 'amount'), 101);
	assert.equal(lexware.formatMoney(6039607), 'EUR 60396.07');
	assert.equal(lexware.formatMoney(-123, 'USD'), 'USD -1.23');
});

test('lexware money helpers reject non-numeric amounts, non-array rows, and fractional cents', () => {
	for (const amount of [null, '', false]) {
		assert.match(messageOf(() => lexware.requireMoney({ amount }, 'amount')), /Expected numeric amount/);
	}
	assert.match(messageOf(() => lexware.sumMoney([{ amount: 1 }, {}], 'amount')), /Missing expected field amount/);
	assert.equal(messageOf(() => lexware.sumMoney({} as unknown[], 'amount')), 'lexware.sumMoney expects an array of rows');
	assert.equal(messageOf(() => lexware.formatMoney(1.5)), 'lexware.formatMoney expects integer cents, got 1.5');
});

test('lexware.json error includes status, category, and operation metadata', async () => {
	const { sdk } = sdkWith(() => unauthorized);

	await assert.rejects(() => sdk.json({ path: '/v1/countries' }), {
		message: 'Lexware API request failed: 401 Unauthorized for listCountries (GET /v1/countries). Category: auth. Error body: {"message":"unauthorized"}',
	});
});

test('lexware.json rejects responses without parsed JSON data', async () => {
	const { sdk } = sdkWith(() => ({ ...okResponse(undefined), contentType: 'application/pdf' }));

	await assert.rejects(() => sdk.json({ path: '/v1/files/1' }), /lexware\.json expected parsed JSON at response\.data.*contentType=application\/pdf/);
});

test('lexware.paginate error includes rate-limit retry metadata', async () => {
	const { sdk } = sdkWith(() => rateLimited);

	await assert.rejects(
		() => sdk.paginate({ path: '/v1/voucherlist', query: { voucherType: 'invoice', voucherStatus: 'paid' } }, { maxPages: 1 }),
		/429 Too Many Requests for getVoucherList \(GET \/v1\/voucherlist\)\. Category: rate_limit\. Retry after: 30s\./,
	);
});

test('lexware.paginate collects content across pages and stops on last', async () => {
	const { sdk, inputs } = sdkWith((input) => okResponse({ content: [input.query.page], last: input.query.page === 2 }));

	const items = await sdk.paginate({ path: '/v1/voucherlist', query: { voucherType: 'invoice', page: 1 } });

	assert.deepEqual(items, [1, 2]);
	assert.deepEqual(inputs.map((input) => input.query), [
		{ voucherType: 'invoice', page: 1, size: 250 },
		{ voucherType: 'invoice', page: 2, size: 250 },
	]);
	assert.ok(inputs.every((input) => input.method === 'GET'));
	await assert.rejects(() => sdk.paginate({ method: 'POST', path: '/v1/contacts' }), /only supports GET/);
	await assert.rejects(() => sdk.paginate({ path: '/v1/contacts' }, { maxPages: 0 }), /maxPages must be a positive integer/);
});

test('lexware.request returns non-OK envelopes without throwing', async () => {
	const { sdk } = sdkWith(() => unauthorized);

	assert.deepEqual(await sdk.request({ path: '/v1/countries' }), unauthorized);
});

test('sandbox prelude helpers behave like the TypeScript implementation', async () => {
	const cases: Array<[string, unknown[]]> = [
		['requireNumber', [{ a: { b: '12.50' } }, 'a.b']],
		['requireNumber', [{ a: 'x' }, 'a']],
		['requireNumber', [{ a: 1 }, 'b']],
		['requireNumber', [1, 'a']],
		['requireMoney', [{ a: 0.1 }, 'a']],
		['requireMoney', [{ a: '-60396.075' }, 'a']],
		['requireMoney', [{ a: 1e21 }, 'a']],
		['sumMoney', [[{ a: '0.1' }, { a: 0.2 }], 'a']],
		['sumMoney', ['rows', 'a']],
		['formatMoney', [-5]],
		['formatMoney', [6039607, 'USD']],
		['formatMoney', [0.5]],
	];
	const run = (sdk: Record<string, (...args: unknown[]) => unknown>) => cases.map(([name, args]) => {
		try {
			return { value: sdk[name](...args) };
		} catch (error) {
			return { error: (error as Error).message };
		}
	});

	const execution = await runInSandbox(`async () => (${run.toString()})(lexware)`, undefined, { cases });

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, run(lexware as unknown as Record<string, (...args: unknown[]) => unknown>));
});

test('sandbox lexware.json and lexware.paginate surface the same error messages', async () => {
	const { sdk } = sdkWith(() => rateLimited);
	const expected = await sdk.json({ path: '/v1/voucherlist' }).then(() => '', (error: Error) => error.message);
	assert.match(expected, /^Lexware API request failed: 429/);

	const json = await runInSandbox(`async () => await lexware.json({ path: '/v1/voucherlist' })`, () => rateLimited);
	const paginate = await runInSandbox(`async () => await lexware.paginate({ path: '/v1/voucherlist' })`, () => rateLimited);

	assert.ok(json.error?.startsWith(`Error: ${expected}`), json.error);
	assert.ok(paginate.error?.startsWith(`Error: ${expected}`), paginate.error);
});

test('sandbox requests go through client.request with per-call options and the executor signal', async () => {
	const calls: Array<{ input: unknown; options?: LexwareRequestOptions }> = [];
	const beforeSend = () => {};
	const onSettled = () => {};
	const client = {
		request: async (input: unknown, options?: LexwareRequestOptions) => {
			calls.push({ input, options });
			return okResponse({ content: [{ id: 'a' }], last: true });
		},
	};

	const execution = await new QuickJsExecutor().execute(
		`async () => ({ items: await lexware.paginate({ path: '/v1/contacts' }), status: (await lexware.request()).status })`,
		{},
		lexwareSandbox(client, { beforeSend, onSettled }),
	);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, { items: [{ id: 'a' }], status: 200 });
	assert.deepEqual(calls.map((call) => call.input), [{ path: '/v1/contacts', method: 'GET', query: { page: 0, size: 250 } }, {}]);
	for (const { options } of calls) {
		assert.equal(options?.beforeSend, beforeSend);
		assert.equal(options?.onSettled, onSettled);
		assert.ok(options?.signal instanceof AbortSignal);
		assert.equal(options.signal.aborted, true, 'executor aborts the host signal once execution ends');
	}
});

test('guest lexware is frozen and exposes exactly the declared helpers', async () => {
	const declared = [...lexwareSdkDeclaration.match(/^declare const lexware: \{\n([\s\S]*?)\n\};/m)![1].matchAll(/^ {2}(\w+)(?:<[^>]*>)?\(/gm)].map((match) => match[1]);

	const execution = await runInSandbox(`async () => ({ keys: Object.keys(lexware), frozen: Object.isFrozen(lexware), onGlobal: typeof globalThis.lexware })`);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, { keys: declared, frozen: true, onGlobal: 'undefined' });
	assert.deepEqual(Object.keys(lexware), declared);
});

// Top-level fields of `type <name> = { ... };` in the declaration text.
const declaredFields = (typeName: string) => {
	const body = lexwareSdkDeclaration.match(new RegExp(`^type ${typeName}(?:<[^>]*>)? = \\{\\n([\\s\\S]*?)\\n\\};`, 'm'))?.[1];
	assert.ok(body, `type ${typeName} is not declared`);
	return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]).sort();
};

// Records over keyof make tsc fail when the client types gain or lose fields.
const requestFields: Record<keyof LexwareRequestInput, true> = { method: true, path: true, query: true, body: true, bodyBase64: true, multipart: true, contentType: true, rawBody: true, accept: true };
const multipartFields: Record<keyof MultipartPart, true> = { name: true, value: true, filename: true, contentType: true, contentBase64: true, contentPath: true };
const responseFields: Record<keyof LexwareResponse, true> = { ok: true, status: true, statusText: true, operation: true, request: true, contentType: true, headers: true, errorCategory: true, retryAfterSeconds: true, data: true, text: true, truncated: true, sent: true };

test('declared request, multipart, and response types list the client fields', () => {
	assert.deepEqual(declaredFields('LexwareRequest'), Object.keys(requestFields).sort());
	assert.deepEqual(declaredFields('MultipartPart'), Object.keys(multipartFields).sort());
	assert.deepEqual(declaredFields('LexwareResponse'), Object.keys(responseFields).sort());
});
