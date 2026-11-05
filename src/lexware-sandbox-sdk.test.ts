import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';
import type { LexwareRequestInput, LexwareRequestOptions, LexwareResponse, MultipartPart } from './lexware-client.js';
import type { LexwareIssue } from './lexware-issues.js';
import { createLexwareSdk, lexwareSandbox, lexwareSdkDeclaration, MAX_SLEEP_MS } from './lexware-sandbox-sdk.js';

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

// SDK whose host answers every request with `respond(input)`; `inputs` records the requests and `sleeps` the
// lexware.sleep delays, which resolve immediately.
const sdkWith = (respond: (input: Record<string, any>) => LexwareResponse = () => okResponse({})) => {
	const inputs: Record<string, any>[] = [];
	const sleeps: number[] = [];
	const sdk = createLexwareSdk(async (payload) => {
		const input = JSON.parse(payload) as Record<string, any>;
		inputs.push(input);
		return JSON.stringify(respond(input));
	}, async (payload) => {
		sleeps.push(Number(payload));
		return '';
	});
	return { sdk, inputs, sleeps };
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

const uploadAccepted = okResponse({ id: 'file-1', voucherId: 'v-9' }, {
	status: 202,
	statusText: 'Accepted',
	sent: { bytes: 3, parts: [{ name: 'file', filename: 'receipt.pdf', bytes: 3, sha256: 'abc' }] },
});

// Upload host: POST answers `upload`, the voucher GETs answer the statuses in turn (the last one repeats).
const uploadHost = (statuses: string[], upload: LexwareResponse = uploadAccepted) => {
	let reads = 0;
	return sdkWith((input) => {
		if (input.method === 'POST') return upload;
		const voucherStatus = statuses[Math.min(reads, statuses.length - 1)];
		reads += 1;
		return okResponse({ id: 'v-9', voucherStatus, ...(voucherStatus !== 'blank' && { voucherNumber: 'RE-9' }) });
	});
};

test('lexware.uploadVoucherFile uploads type=voucher and polls until text recognition is done', async () => {
	const { sdk, inputs, sleeps } = uploadHost(['blank', 'unchecked']);

	const result = await sdk.uploadVoucherFile({ contentPath: '/data/Receipt.PDF' });

	assert.deepEqual(inputs[0], {
		method: 'POST',
		path: '/v1/files',
		multipart: [{ name: 'file', contentType: 'application/pdf', contentPath: '/data/Receipt.PDF' }, { name: 'type', value: 'voucher' }],
	});
	assert.deepEqual(inputs.slice(1).map((input) => [input.method ?? 'GET', input.path]), [['GET', '/v1/vouchers/v-9'], ['GET', '/v1/vouchers/v-9']]);
	assert.deepEqual(sleeps, [2000, 4000]);
	assert.deepEqual(result, { fileId: 'file-1', voucherId: 'v-9', sent: uploadAccepted.sent, voucher: { id: 'v-9', voucherStatus: 'unchecked', voucherNumber: 'RE-9' }, extraction: 'done' });
});

test('lexware.uploadVoucherFile returns pending on timeout without uploading again', async () => {
	const { sdk, inputs, sleeps } = uploadHost(['blank']);

	const result = await sdk.uploadVoucherFile({ contentBase64: 'AAEC', filename: 'scan.png' });

	assert.equal(inputs.filter((input) => input.method === 'POST').length, 1);
	assert.equal(inputs[0].multipart[0].contentType, 'image/png');
	assert.deepEqual(sleeps, [2000, 4000, 8000, 1000], 'waits 15 s in total by default');
	assert.equal(inputs.length, 5, 'one upload plus four polls');
	assert.equal(result.extraction, 'pending');
	assert.deepEqual(result.voucher, { id: 'v-9', voucherStatus: 'blank' });

	const short = uploadHost(['blank']);
	await short.sdk.uploadVoucherFile({ contentPath: '/data/a.xml', waitForExtraction: { timeoutMs: 3000 } });
	assert.deepEqual(short.sleeps, [2000, 1000]);
});

test('lexware.uploadVoucherFile skips polling with waitForExtraction: false', async () => {
	const { sdk, inputs, sleeps } = uploadHost(['blank']);

	const result = await sdk.uploadVoucherFile({ contentPath: '/data/a.jpg', contentType: 'image/jpeg', waitForExtraction: false });

	assert.equal(inputs.length, 1);
	assert.deepEqual(sleeps, []);
	assert.deepEqual(result, { fileId: 'file-1', voucherId: 'v-9', sent: uploadAccepted.sent, extraction: 'skipped' });
});

test('lexware.uploadVoucherFile throws on a failed upload or a response without voucherId', async () => {
	const rejected = okResponse({ message: 'invalid file' }, { ok: false, status: 406, statusText: 'Not Acceptable', errorCategory: 'validation' });
	await assert.rejects(() => uploadHost(['blank'], rejected).sdk.uploadVoucherFile({ contentPath: '/data/a.pdf' }), /Lexware API request failed: 406 Not Acceptable/);

	const { sdk, inputs } = uploadHost(['blank'], okResponse({ id: 'file-1' }, { status: 202 }));
	await assert.rejects(() => sdk.uploadVoucherFile({ contentPath: '/data/a.pdf' }), /expected POST \/v1\/files to return \{ id, voucherId \}, got status 202: \{"id":"file-1"\}/);
	assert.equal(inputs.length, 1);
});

test('lexware.uploadVoucherFile says the upload succeeded when polling fails', async () => {
	const { sdk } = sdkWith((input) => (input.method === 'POST' ? uploadAccepted : rateLimited));

	await assert.rejects(() => sdk.uploadVoucherFile({ contentPath: '/data/a.pdf' }), /the upload succeeded \(fileId file-1, voucherId v-9\), but waiting for text recognition failed\. Do not upload again.*429/);
});

test('lexware.uploadVoucherFile says the upload succeeded when the wait itself fails', async () => {
	const sdk = createLexwareSdk(async () => JSON.stringify(uploadAccepted), async () => {
		throw new Error('lexware.sleep was aborted: the execution ended');
	});

	await assert.rejects(() => sdk.uploadVoucherFile({ contentPath: '/data/a.pdf' }), /the upload succeeded \(fileId file-1, voucherId v-9\).*Do not upload again.*lexware\.sleep was aborted/);
});

test('lexware upload helpers validate the file input before sending', async () => {
	const { sdk, inputs } = sdkWith();
	for (const [input, message] of [
		[{}, /exactly one of contentPath or contentBase64/],
		[{ contentPath: '/a.pdf', contentBase64: 'AA==' }, /exactly one of contentPath or contentBase64/],
		[{ contentBase64: 'AA==' }, /needs a filename with contentBase64/],
		[{ contentPath: '/data/notes.txt' }, /cannot infer contentType from "\/data\/notes\.txt"/],
		[{ contentPath: '/data/a.pdf', waitForExtraction: 'yes' }, /input\.waitForExtraction must be a boolean or \{ timeoutMs \}/],
		[{ contentPath: '/data/a.pdf', waitForExtraction: { timeoutMs: -1 } }, /timeoutMs must be 0 to 15000 ms/],
		[{ contentPath: '/data/a.pdf', waitForExtraction: { timeoutMs: 15001 } }, /timeoutMs must be 0 to 15000 ms/],
	] as const) {
		await assert.rejects(() => sdk.uploadVoucherFile(input as never), message);
	}
	await assert.rejects(() => sdk.attachFileToVoucher('', { contentPath: '/data/a.pdf' }), /non-empty voucher id/);
	assert.equal(inputs.length, 0);
});

test('lexware.attachFileToVoucher posts the file part to the voucher', async () => {
	const { sdk, inputs } = sdkWith(() => okResponse({ id: 'file-2' }, { status: 202, sent: uploadAccepted.sent }));

	const result = await sdk.attachFileToVoucher('v-1', { contentPath: '/data/b.pdf', filename: 'invoice.pdf' });

	assert.deepEqual(inputs, [{ method: 'POST', path: '/v1/vouchers/v-1/files', multipart: [{ name: 'file', contentType: 'application/pdf', contentPath: '/data/b.pdf', filename: 'invoice.pdf' }] }]);
	assert.deepEqual(result, { fileId: 'file-2', sent: uploadAccepted.sent });
});

test('sandbox lexware.sleep waits, rejects delays above the cap, and rejects on abort', async () => {
	const execution = await runInSandbox(`async () => {
		const started = Date.now();
		await lexware.sleep(20);
		const waited = Date.now() - started;
		const tooLong = await lexware.sleep(${MAX_SLEEP_MS + 1}).then(() => 'resolved', (error) => error.message);
		const negative = await lexware.sleep(-1).then(() => 'resolved', (error) => error.message);
		return { waited: waited >= 15, tooLong, negative };
	}`);
	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, { waited: true, tooLong: `lexware.sleep expects 0 to ${MAX_SLEEP_MS} ms, got ${MAX_SLEEP_MS + 1}`, negative: `lexware.sleep expects 0 to ${MAX_SLEEP_MS} ms, got -1` });

	const sleepHost = Object.entries(lexwareSandbox({ request: async () => okResponse({}) }).hostFunctions).find(([name]) => name.includes('Sleep'))![1];
	const controller = new AbortController();
	const pending = sleepHost('5000', { signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, /lexware\.sleep was aborted/);
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(sleepHost('10', { signal: aborted.signal }), /aborted/);
});

test('the execute timeout ends a pending lexware.sleep', async () => {
	const started = Date.now();
	const execution = await new QuickJsExecutor().execute(`async () => { await lexware.sleep(${MAX_SLEEP_MS}); return 'slept'; }`, {}, { timeoutMs: 100, ...lexwareSandbox({ request: async () => okResponse({}) }) });

	assert.match(execution.error ?? '', /timed out after 100ms/);
	assert.ok(Date.now() - started < 2000, 'does not wait for the sleep to finish');
});

test('sandbox lexware.uploadVoucherFile polls with the host sleep', async () => {
	let reads = 0;
	const client = {
		request: async (input: unknown) => {
			if ((input as Record<string, unknown>).method === 'POST') return uploadAccepted;
			reads += 1;
			return okResponse({ id: 'v-9', voucherStatus: reads === 1 ? 'blank' : 'unchecked' });
		},
	};

	const execution = await new QuickJsExecutor().execute(
		`async () => { const { extraction, voucherId } = await lexware.uploadVoucherFile({ contentPath: '/data/a.pdf', waitForExtraction: { timeoutMs: 60 } }); return { extraction, voucherId }; }`,
		{},
		{ timeoutMs: 5000, ...lexwareSandbox(client) },
	);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, { extraction: 'pending', voucherId: 'v-9' }, 'a 60 ms budget ends after one blank poll');
	assert.equal(reads, 1);
});

const voucherRows = [
	{ id: 'contact-only', voucherNumber: 'X-1', voucherDate: '2026-03-02T00:00:00.000+01:00', contactName: 'Muster GmbH', totalAmount: 50, currency: 'EUR' },
	{ id: 'number-only', voucherNumber: '123-456-7890', voucherDate: '2026-03-01T00:00:00.000+01:00', contactName: 'Other AG', totalAmount: 99, currency: 'EUR' },
	{ id: 'unchecked', voucherNumber: null, voucherDate: '2026-03-03T00:00:00.000+01:00', contactName: 'Muster GmbH', currency: 'EUR' },
	{ id: 'number-amount', voucherNumber: '1234567890', voucherDate: '2026-03-04T00:00:00.000+01:00', contactName: 'Muster GmbH', totalAmount: '119.00', currency: 'EUR' },
	{ id: 'unrelated', voucherNumber: 'Y-9', voucherDate: '2026-03-05T00:00:00.000+01:00', contactName: 'Else KG', totalAmount: 1, currency: 'EUR' },
];
// Voucherlist host: the exact voucherNumber query matches only identical numbers, the window query returns every row on one page.
const voucherlistHost = () => sdkWith((input) => okResponse({
	content: input.query.voucherNumber !== undefined ? voucherRows.filter((row) => row.voucherNumber === input.query.voucherNumber) : voucherRows,
	last: true,
}));

test('lexware.findVouchers returns exact voucherNumber hits from one request', async () => {
	const { sdk, inputs } = voucherlistHost();

	const candidates = await sdk.findVouchers({ voucherNumber: '1234567890', amount: 119 });

	assert.deepEqual(inputs.map((input) => input.query), [{ voucherType: 'purchaseinvoice,purchasecreditnote,salesinvoice,salescreditnote', voucherStatus: 'any', voucherNumber: '1234567890', page: 0, size: 250 }]);
	assert.deepEqual(candidates.map(({ score, matched }) => ({ score, matched })), [{ score: 12, matched: ['voucherNumber', 'amount'] }]);
});

test('lexware.findVouchers falls back to the date window and matches normalized numbers', async () => {
	const { sdk, inputs } = voucherlistHost();

	const candidates = await sdk.findVouchers({ voucherNumber: '123 456 7890', amount: 119, contactName: 'muster', dateFrom: '2026-03-01', dateTo: '2026-03-31', voucherStatus: 'open' });

	assert.deepEqual(inputs.map((input) => input.query), [
		{ voucherType: 'purchaseinvoice,purchasecreditnote,salesinvoice,salescreditnote', voucherStatus: 'open', voucherNumber: '123 456 7890', page: 0, size: 250 },
		{ voucherType: 'purchaseinvoice,purchasecreditnote,salesinvoice,salescreditnote', voucherStatus: 'open', voucherDateFrom: '2026-03-01', voucherDateTo: '2026-03-31', page: 0, size: 250 },
	]);
	assert.deepEqual(candidates.map(({ row, score, matched }) => [(row as { id: string }).id, score, matched]), [
		['number-amount', 15, ['voucherNumber', 'amount', 'contactName', 'date']],
		['number-only', 9, ['voucherNumber', 'date']],
		['contact-only', 3, ['contactName', 'date']],
		['unchecked', 3, ['contactName', 'date']],
	]);
});

test('lexware.findVouchers ignores leading zeros, matches RegExp contacts and skips rows without totalAmount', async () => {
	const { sdk } = sdkWith(() => okResponse({ content: [{ id: 'a', voucherNumber: 're.0042', contactName: 'Muster GmbH' }, { id: 'b', voucherNumber: 'RE-420', contactName: 'Muster AG', totalAmount: 5 }], last: true }));

	const candidates = await sdk.findVouchers({ voucherNumber: 'RE-42', contactName: /gmbh$/, amount: 5, dateFrom: '2026-01-01', dateTo: '2026-12-31' });

	assert.deepEqual(candidates.map(({ row, matched }) => [(row as { id: string }).id, matched]), [['a', ['voucherNumber', 'contactName']], ['b', ['amount']]]);
});

test('lexware.findVouchers scans voucherlist only within a date window', async () => {
	const { sdk, inputs } = voucherlistHost();

	await assert.rejects(() => sdk.findVouchers({ voucherNumber: '123 456 7890' }), /no candidate has the exact number "123 456 7890"\. Pass criteria\.dateFrom and dateTo/);
	assert.equal(inputs.length, 1, 'only the exact query ran');
	await assert.rejects(() => sdk.findVouchers({ amount: 119, dateFrom: '2026-03-01' }), /needs criteria\.dateFrom and dateTo/);
	await assert.rejects(() => sdk.findVouchers({ dateFrom: '2026-03-01', dateTo: '2026-03-31' }), /at least one of criteria\.voucherNumber, contactName or amount/);
	await assert.rejects(() => sdk.findVouchers({ voucherNumber: 'X-1', voucherDateFrom: '2026-03-01' } as never), /criteria has unknown keys voucherDateFrom/);
	await assert.rejects(() => sdk.findVouchers({ amount: 1, dateFrom: '01.03.2026', dateTo: '2026-03-31' }), /dateFrom must be a yyyy-MM-dd string/);
	await assert.rejects(() => sdk.findVouchers({ amount: 1, dateFrom: '2026-04-01', dateTo: '2026-03-31' }), /dateFrom must not be after dateTo/);
	assert.equal(inputs.length, 1, 'invalid criteria send no request');
});

test('lexware.findVouchers scans every window page and drops other currencies', async () => {
	const { sdk, inputs } = sdkWith((input) => okResponse({ content: [{ id: 'p' + input.query.page, contactName: 'Muster', currency: input.query.page === 0 ? 'USD' : 'EUR' }], totalPages: 2, last: input.query.page === 1 }));

	const candidates = await sdk.findVouchers({ contactName: 'muster', currency: 'eur', dateFrom: '2026-01-01', dateTo: '2026-12-31' }, { maxPages: 2 });

	assert.deepEqual(inputs.map((input) => input.query.page), [0, 1]);
	assert.deepEqual(candidates.map(({ row }) => (row as { id: string }).id), ['p1']);
});

test('lexware.findVouchers throws instead of scanning a window with more than maxPages pages', async () => {
	const { sdk, inputs } = sdkWith(() => okResponse({ content: [{ id: 'a', contactName: 'Muster' }], totalPages: 5, last: false }));

	await assert.rejects(() => sdk.findVouchers({ contactName: 'muster', dateFrom: '2026-01-01', dateTo: '2026-12-31' }), /window 2026-01-01\.\.2026-12-31 has 5 voucherlist pages, more than options\.maxPages=4\. Narrow the window/);
	assert.equal(inputs.length, 1, 'stops after the first page');
});

test('lexware.findVouchers falls back to the window when exact hits are in another currency, and skips non-numeric totalAmount', async () => {
	const { sdk, inputs } = sdkWith((input) => okResponse({
		content: input.query.voucherNumber !== undefined
			? [{ id: 'usd', voucherNumber: 'RE-1', currency: 'USD' }]
			: [{ id: 'eur', voucherNumber: 'RE 1', voucherDate: '2026-01-10', currency: 'EUR', totalAmount: 'n/a' }],
		totalPages: 1,
		last: true,
	}));

	const candidates = await sdk.findVouchers({ voucherNumber: 'RE-1', amount: 5, currency: 'EUR', dateFrom: '2026-01-01', dateTo: '2026-01-31' });

	assert.equal(inputs.length, 2);
	assert.deepEqual(candidates.map(({ row, matched }) => [(row as { id: string }).id, matched]), [['eur', ['voucherNumber', 'date']]]);
});

test('sandbox lexware.findVouchers ranks candidates inside QuickJS', async () => {
	const client = {
		request: async (input: unknown) => {
			const query = (input as { query: Record<string, unknown> }).query;
			return okResponse({ content: query.voucherNumber !== undefined ? [] : voucherRows, totalPages: 1, last: true });
		},
	};

	// An en dash in the number checks the normalizer's dash class survives toString() into QuickJS; the exact query misses, so the window scan runs.
	const execution = await new QuickJsExecutor().execute(
		`async () => (await lexware.findVouchers({ voucherNumber: '123\u2013456 7890', amount: 119, contactName: /muster/, dateFrom: '2026-03-01', dateTo: '2026-03-31' })).map((candidate) => candidate.row.id + ':' + candidate.score)`,
		{},
		lexwareSandbox(client),
	);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, ['number-amount:15', 'number-only:9', 'contact-only:3', 'unchecked:3']);
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
const responseFields: Record<keyof LexwareResponse, true> = { ok: true, status: true, statusText: true, operation: true, request: true, contentType: true, headers: true, errorCategory: true, retryAfterSeconds: true, issues: true, data: true, text: true, truncated: true, sent: true, dryRun: true, planned: true };

test('declared request, multipart, and response types list the client fields', () => {
	assert.deepEqual(declaredFields('LexwareRequest'), Object.keys(requestFields).sort());
	assert.deepEqual(declaredFields('MultipartPart'), Object.keys(multipartFields).sort());
	assert.deepEqual(declaredFields('LexwareResponse'), Object.keys(responseFields).sort());
	const declaredIssueFields = lexwareSdkDeclaration.match(/^ {2}issues\?: Array<\{ ([^}]*) \}>;/m)?.[1];
	assert.deepEqual(declaredIssueFields?.split('; ').map((field) => field.split('?:')[0]).sort(), Object.keys(issueFields).sort());
});
