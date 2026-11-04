import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';
import type { LexwareRequestInput, LexwareRequestOptions, LexwareResponse, MultipartPart } from './lexware-client.js';
import type { LexwareIssue } from './lexware-issues.js';
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

test('lexware.json error lists normalized issues with their hints', async () => {
	const { sdk } = sdkWith(() => okResponse({ IssueList: [{ i18nKey: 'Missing_ContactId', source: 'contactId', type: 'validation_failure' }] }, {
		ok: false,
		status: 406,
		statusText: 'Not Acceptable',
		errorCategory: 'validation',
		issues: [{ field: 'contactId', code: 'Missing_ContactId', hint: 'Set contactId.' }, { field: 'remark', code: 'unknown_code' }, { hint: 'Re-fetch.' }],
	}));

	await assert.rejects(() => sdk.json({ path: '/v1/vouchers', method: 'POST' }), {
		message: 'Lexware API request failed: 406 Not Acceptable for unknown operation. Category: validation. Issues: [contactId Missing_ContactId (hint: Set contactId.); remark unknown_code; hint: Re-fetch.]. Error body: {"IssueList":[{"i18nKey":"Missing_ContactId","source":"contactId","type":"validation_failure"}]}',
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

const storedVoucher = {
	id: 'v-1',
	organizationId: 'org-1',
	type: 'purchaseinvoice',
	voucherStatus: 'unchecked',
	voucherNumber: 'RE-1',
	contactId: 'c-1',
	contactName: 'Supplier GmbH',
	createdDate: '2026-11-01T10:00:00.000+01:00',
	updatedDate: '2026-11-01T10:00:00.000+01:00',
	version: 3,
	files: ['f-1', 'f-2'],
};

// Fake voucher store: GET returns the stored voucher, PUT answers `put(body)` and, if OK, stores the body like Lexware would.
const voucherStore = (put: (body: Record<string, any>) => LexwareResponse = () => okResponse({ id: 'v-1', version: 4 })) => {
	let voucher: Record<string, any> = structuredClone(storedVoucher);
	return (input: Record<string, any>) => {
		if (input.method === 'PUT') {
			const response = put(input.body);
			if (response.ok) {
				voucher = { ...voucher, ...input.body, version: voucher.version + 1, updatedDate: '2026-11-04T10:00:00.000+01:00' };
				delete voucher.useCollectiveContact;
				if (input.body.useCollectiveContact === true) {
					voucher.contactId = 'collective';
				}
			}
			return response;
		}
		return okResponse(structuredClone(voucher));
	};
};
const voucherHost = (put?: (body: Record<string, any>) => LexwareResponse) => sdkWith(voucherStore(put));

test('lexware.updateVoucher PUTs the merged voucher with files and version, without read-only fields', async () => {
	const { sdk, inputs } = voucherHost();

	const result = await sdk.updateVoucher('v-1', { voucherNumber: 'RE-2', voucherStatus: 'open' }, { expectedVersion: 3 });

	assert.deepEqual(inputs.map((input) => [input.method ?? 'GET', input.path]), [['GET', '/v1/vouchers/v-1'], ['PUT', '/v1/vouchers/v-1'], ['GET', '/v1/vouchers/v-1']]);
	assert.deepEqual(inputs[1].body, { type: 'purchaseinvoice', voucherNumber: 'RE-2', voucherStatus: 'open', contactId: 'c-1', version: 3, files: ['f-1', 'f-2'] });
	assert.deepEqual(result.before, storedVoucher);
	assert.equal((result.after as Record<string, unknown>).version, 4);
	assert.deepEqual(result.changed, ['voucherStatus', 'voucherNumber']);
});

test('lexware.updateVoucher drops contactId when switching to the collective contact', async () => {
	const { sdk, inputs } = voucherHost();

	await sdk.updateVoucher('v-1', { useCollectiveContact: true });

	assert.equal(inputs[1].body.useCollectiveContact, true);
	assert.equal(Object.prototype.hasOwnProperty.call(inputs[1].body, 'contactId'), false);
});

test('lexware.updateVoucher drops useCollectiveContact when switching to a contactId', async () => {
	const { sdk, inputs } = sdkWith((input) => okResponse(input.method === 'PUT' ? {} : { ...storedVoucher, contactId: undefined, useCollectiveContact: true }));

	await sdk.updateVoucher('v-1', { contactId: 'c-2' });

	assert.equal(inputs[1].body.contactId, 'c-2');
	assert.equal(Object.prototype.hasOwnProperty.call(inputs[1].body, 'useCollectiveContact'), false);
});

test('lexware.updateVoucher does not write on a version mismatch, a patch version, or dropped files', async () => {
	for (const [patch, options, message] of [
		[{ remark: 'x' }, { expectedVersion: 2 }, /voucher v-1 is at version 3, expected 2\. Nothing was written/],
		[{ version: 2 }, {}, /use options\.expectedVersion instead of patch\.version/],
		[{ files: ['f-1'] }, {}, /would permanently delete file\(s\) f-2 from voucher v-1\. Nothing was written/],
		[{ files: null }, { allowFileRemoval: true }, /patch\.files must be an array/],
	] as const) {
		const { sdk, inputs } = voucherHost();
		await assert.rejects(() => sdk.updateVoucher('v-1', patch as Record<string, unknown>, options), message);
		assert.ok(inputs.every((input) => input.method !== 'PUT'), `no PUT for ${JSON.stringify(patch)}`);
	}
	await assert.rejects(() => sdkWith().sdk.updateVoucher('', {}), /non-empty voucher id/);
});

test('lexware.updateVoucher removes files only with allowFileRemoval', async () => {
	const { sdk, inputs } = voucherHost();

	const result = await sdk.updateVoucher('v-1', { files: ['f-1'] }, { allowFileRemoval: true });

	assert.deepEqual(inputs[1].body.files, ['f-1']);
	assert.deepEqual(result.changed, ['files']);
});

test('lexware.updateVoucher throws with the Lexware issues when the PUT fails', async () => {
	const { sdk, inputs } = voucherHost(() => okResponse({ IssueList: [{ i18nKey: 'invalid_taxamount', source: 'voucherItems[0].taxAmount' }] }, {
		ok: false,
		status: 406,
		statusText: 'Not Acceptable',
		errorCategory: 'validation',
		operation: { operationId: 'updateVoucher', method: 'PUT', pathTemplate: '/v1/vouchers/{id}', summary: 'Update a bookkeeping voucher' },
		issues: [{ field: 'voucherItems[0].taxAmount', code: 'invalid_taxamount' }],
	}));

	await assert.rejects(() => sdk.updateVoucher('v-1', { remark: 'x' }), /406 Not Acceptable for updateVoucher \(PUT \/v1\/vouchers\/\{id\}\)\. Category: validation\. Issues: \[voucherItems\[0\]\.taxAmount invalid_taxamount\]/);
	assert.equal(inputs.length, 2, 'no verification GET after a failed PUT');
});

test('lexware.updateVoucher throws when the re-read voucher lost a file', async () => {
	let reads = 0;
	const { sdk } = sdkWith((input) => {
		if (input.method === 'PUT') return okResponse({ id: 'v-1', version: 4 });
		reads += 1;
		return okResponse(reads === 1 ? storedVoucher : { ...storedVoucher, version: 4, files: ['f-1'] });
	});

	await assert.rejects(() => sdk.updateVoucher('v-1', { remark: 'x' }), /PUT succeeded but voucher v-1 no longer lists file\(s\) f-2/);
});

test('lexware.updateVoucher says the PUT went through when the verification read fails', async () => {
	let reads = 0;
	const { sdk } = sdkWith((input) => {
		if (input.method === 'PUT') return okResponse({});
		reads += 1;
		return reads === 1 ? okResponse(storedVoucher) : rateLimited;
	});

	await assert.rejects(() => sdk.updateVoucher('v-1', { remark: 'x' }), /the PUT succeeded, but re-reading voucher v-1 failed.*Do not repeat the update.*429 Too Many Requests/);
});

test('sandbox lexware.updateVoucher merges and verifies inside QuickJS', async () => {
	const store = voucherStore();
	const puts: unknown[] = [];
	const client = {
		request: async (input: unknown) => {
			const request = input as Record<string, any>;
			if (request.method === 'PUT') puts.push(request.body);
			return store(request);
		},
	};

	const execution = await new QuickJsExecutor().execute(`async () => (await lexware.updateVoucher('v-1', { remark: 'x' }, { expectedVersion: 3 })).changed`, {}, lexwareSandbox(client));

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, ['remark']);
	assert.deepEqual(puts, [{ type: 'purchaseinvoice', voucherNumber: 'RE-1', contactId: 'c-1', version: 3, files: ['f-1', 'f-2'], remark: 'x' }]);
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
const requestFields: Record<keyof LexwareRequestInput, true> = { method: true, path: true, query: true, body: true, bodyBase64: true, multipart: true, contentType: true, rawBody: true, accept: true, includeAllHeaders: true };
const multipartFields: Record<keyof MultipartPart, true> = { name: true, value: true, filename: true, contentType: true, contentBase64: true, contentPath: true };
const issueFields: Record<keyof LexwareIssue, true> = { field: true, code: true, message: true, hint: true };
const responseFields: Record<keyof LexwareResponse, true> = { ok: true, status: true, statusText: true, operation: true, request: true, contentType: true, headers: true, errorCategory: true, retryAfterSeconds: true, issues: true, data: true, text: true, truncated: true, sent: true };

test('declared request, multipart, and response types list the client fields', () => {
	assert.deepEqual(declaredFields('LexwareRequest'), Object.keys(requestFields).sort());
	assert.deepEqual(declaredFields('MultipartPart'), Object.keys(multipartFields).sort());
	assert.deepEqual(declaredFields('LexwareResponse'), Object.keys(responseFields).sort());
	const declaredIssueFields = lexwareSdkDeclaration.match(/^ {2}issues\?: Array<\{ ([^}]*) \}>;/m)?.[1];
	assert.deepEqual(declaredIssueFields?.split('; ').map((field) => field.split('?:')[0]).sort(), Object.keys(issueFields).sort());
});
