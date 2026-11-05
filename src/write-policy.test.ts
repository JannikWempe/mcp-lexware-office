import assert from 'node:assert/strict';
import test from 'node:test';

import { describeWritePolicy, parseWriteAllow, requestsFinalize, writeAllowViolation } from './write-policy.js';

const query = (search = '') => new URLSearchParams(search);

test('METHOD path and operationId entries resolve to the same rule; ?finalize is kept', () => {
	assert.deepEqual(parseWriteAllow('POST /v1/invoices'), parseWriteAllow('createInvoice'));
	assert.deepEqual(describeWritePolicy(true, parseWriteAllow('createInvoice?finalize')).allow, ['POST /v1/invoices?finalize']);
	assert.deepEqual(describeWritePolicy(true, parseWriteAllow('updateVoucher?finalize, POST /v1/vouchers?finalize')).allow, ['PUT /v1/vouchers/{id}?finalize', 'POST /v1/vouchers?finalize']);
	assert.deepEqual(describeWritePolicy(true, parseWriteAllow('DELETE /v1/event-subscriptions/{id}')).allow, ['DELETE /v1/event-subscriptions/{subscriptionId}']);
});

test('invalid entries name the entry in the error', () => {
	assert.throws(() => parseWriteAllow('POST /v1/files, PUT /v1/contact/{id}'), /"PUT \/v1\/contact\/\{id\}" does not match a cataloged write.*Known writes: .*PUT \/v1\/contacts\/\{id\}/);
	assert.throws(() => parseWriteAllow('POST /v1/files?finalize'), /POST \/v1\/files cannot finalize/);
	assert.throws(() => parseWriteAllow('   '), /set but empty/);
});

test('only writes matching a rule by operationId are allowed', () => {
	const rules = parseWriteAllow('POST /v1/files, PUT /v1/vouchers/{id}');
	assert.equal(writeAllowViolation(rules, { method: 'POST', path: '/v1/files', query: query(), operationId: 'uploadFile' }), undefined);
	assert.equal(writeAllowViolation(rules, { method: 'PUT', path: '/v1/vouchers/abc', query: query(), operationId: 'updateVoucher' }), undefined);
	assert.match(
		writeAllowViolation(rules, { method: 'POST', path: '/v1/contacts', query: query(), operationId: 'createContact' }) ?? '',
		/POST \/v1\/contacts is blocked: not in LEXWARE_OFFICE_WRITE_ALLOW\. Allowed: POST \/v1\/files, PUT \/v1\/vouchers\/\{id\}\. See spec\.info\.writePolicy\./,
	);
	assert.match(writeAllowViolation(rules, { method: 'PATCH', path: '/v1/custom/1', query: query() }) ?? '', /not in LEXWARE_OFFICE_WRITE_ALLOW/);
});

test('encoded path separators are blocked even when the template matches', () => {
	const rules = parseWriteAllow('PUT /v1/vouchers/{id}');
	for (const path of ['/v1/vouchers/abc%2f..%2fcontacts', '/v1/vouchers/abc%2F', '/v1/vouchers/abc%5Cdef']) {
		assert.match(writeAllowViolation(rules, { method: 'PUT', path, query: query(), operationId: 'updateVoucher' }) ?? '', /rejects encoded '\/' or '\\'/, path);
	}
});

test("';' and encoded ';' in write paths are blocked even when the template matches", () => {
	const rules = parseWriteAllow('uploadFileToVoucher');
	for (const path of ['/v1/vouchers/..;/files', '/v1/vouchers/%2e%2e;/files', '/v1/vouchers/abc%3Bx/files', '/v1/vouchers/abc;jsessionid=1/files']) {
		assert.match(writeAllowViolation(rules, { method: 'POST', path, query: query(), operationId: 'uploadFileToVoucher' }) ?? '', /and ';' in write paths/, path);
	}
	assert.equal(writeAllowViolation(rules, { method: 'POST', path: '/v1/vouchers/abc/files', query: query(), operationId: 'uploadFileToVoucher' }), undefined);
});

test('finalize requires a ?finalize rule; drafts are allowed by either', () => {
	const drafts = parseWriteAllow('POST /v1/invoices');
	const finalize = parseWriteAllow('POST /v1/invoices?finalize');
	const request = (search: string) => ({ method: 'POST', path: '/v1/invoices', query: query(search), operationId: 'createInvoice' });

	assert.equal(writeAllowViolation(drafts, request('')), undefined);
	assert.equal(writeAllowViolation(drafts, request('finalize=false')), undefined);
	for (const search of ['finalize=true', 'finalize=TRUE', 'finalize=1', 'finalize', 'finalize=false&finalize=true', 'FINALIZE=true', 'Finalize=true', 'finalize[]=true']) {
		assert.match(writeAllowViolation(drafts, request(search)) ?? '', /finalize=true is blocked.*ask the server operator to add "POST \/v1\/invoices\?finalize"/, search);
		assert.equal(writeAllowViolation(finalize, request(search)), undefined, search);
	}
	assert.equal(writeAllowViolation(finalize, request('')), undefined);
});

test('updateVoucher with a voucherStatus other than unchecked requires a ?finalize rule', () => {
	const edits = parseWriteAllow('PUT /v1/vouchers/{id}');
	const finalize = parseWriteAllow('updateVoucher?finalize');
	const request = (body: unknown, extra: object = {}) => ({ method: 'PUT', path: '/v1/vouchers/abc', query: query(), operationId: 'updateVoucher', body, ...extra });

	for (const body of [undefined, { version: 1 }, { voucherStatus: 'unchecked' }, { voucherStatus: ' Unchecked ' }, { voucherStatus: 'unchecked', VoucherStatus: 'UNCHECKED' }, '{"version":1}']) {
		assert.equal(writeAllowViolation(edits, request(body)), undefined, JSON.stringify(body));
	}
	for (const body of [{ voucherStatus: 'open' }, { VoucherStatus: 'open' }, { voucherStatus: 'unchecked', VOUCHERSTATUS: 'open' }, { voucherStatus: 1 }, '{"voucherStatus":"open"}',
		{ voucherStatus: null }, { VoucherStatus: null }, { voucherStatus: 'unchecked', VoucherStatus: null }, '{"voucherStatus":null}']) {
		assert.match(writeAllowViolation(edits, request(body)) ?? '', /is blocked: it would finalize the voucher.*omit voucherStatus to edit without finalizing, or ask the server operator to add "PUT \/v1\/vouchers\/\{id\}\?finalize"\. Allowed: PUT \/v1\/vouchers\/\{id\}\./, JSON.stringify(body));
		assert.equal(writeAllowViolation(finalize, request(body)), undefined, JSON.stringify(body));
	}
	assert.match(writeAllowViolation(edits, request({ voucherStatus: 'open' })) ?? '', /^PUT \/v1\/vouchers\/abc with voucherStatus "open" is blocked/);
	assert.match(writeAllowViolation(edits, request({ voucherStatus: null })) ?? '', /^PUT \/v1\/vouchers\/abc with voucherStatus null is blocked/);
});

test('createVoucher requires voucherStatus unchecked unless a ?finalize rule allows it', () => {
	const unchecked = parseWriteAllow('createVoucher');
	const finalize = parseWriteAllow('POST /v1/vouchers?finalize');
	const request = (body: unknown) => ({ method: 'POST', path: '/v1/vouchers', query: query(), operationId: 'createVoucher', body });

	for (const body of [{ voucherStatus: 'unchecked' }, { voucherStatus: ' UNCHECKED ' }, { voucherStatus: 'unchecked', VoucherStatus: 'Unchecked' }, '{"voucherStatus":"unchecked"}']) {
		assert.equal(writeAllowViolation(unchecked, request(body)), undefined, JSON.stringify(body));
	}
	// Only the canonical key counts as unchecked; any other spelling must agree, or a server binding it could finalize.
	const conflicting = [{ VoucherStatus: 'unchecked', voucherStatus: null }, { voucherStatus: 'unchecked', VoucherStatus: null }, { voucherStatus: 'unchecked', VOUCHERSTATUS: 'open' }, '{"VoucherStatus":"unchecked","voucherStatus":null}'];
	for (const body of [undefined, {}, { voucherStatus: null }, { voucherStatus: 'open' }, { VoucherStatus: 'unchecked' }, ...conflicting]) {
		assert.match(writeAllowViolation(unchecked, request(body)) ?? '', /^POST \/v1\/vouchers with .* is blocked: .*send voucherStatus 'unchecked' to create an unchecked voucher, or ask the server operator to add "POST \/v1\/vouchers\?finalize"/, JSON.stringify(body));
		assert.equal(writeAllowViolation(finalize, request(body)), undefined, JSON.stringify(body));
	}
	assert.match(writeAllowViolation(unchecked, request({})) ?? '', /^POST \/v1\/vouchers with no voucherStatus is blocked/);
	assert.match(writeAllowViolation(unchecked, request({ VoucherStatus: 'unchecked', voucherStatus: null })) ?? '', /^POST \/v1\/vouchers with voucherStatus null is blocked/);
});

test('a voucher body that cannot be inspected counts as finalizing', () => {
	const rules = parseWriteAllow('updateVoucher, createVoucher');
	const bodies = [{ body: 'not json' }, { body: '["x"]' }, { body: [] }, { body: 'null' }, { body: null }, { bodyBase64: 'e30=' }, { multipart: [{ name: 'voucherStatus', value: 'unchecked' }] }];
	for (const [method, path, operationId] of [['PUT', '/v1/vouchers/abc', 'updateVoucher'], ['POST', '/v1/vouchers', 'createVoucher']]) {
		for (const body of bodies) {
			assert.match(writeAllowViolation(rules, { method, path, query: query(), operationId, ...body }) ?? '', /with a body that is not a JSON object is blocked/, `${method} ${JSON.stringify(body)}`);
		}
	}
});

test('requestsFinalize treats anything but an explicit false as finalizing', () => {
	assert.equal(requestsFinalize(query('')), false);
	assert.equal(requestsFinalize(query('finalize=false')), false);
	assert.equal(requestsFinalize(query('finalize= False ')), false);
	assert.equal(requestsFinalize(query('finalize=true')), true);
	assert.equal(requestsFinalize(query('finalize=')), true);
	assert.equal(requestsFinalize(query('FINALIZE=true')), true);
	assert.equal(requestsFinalize(query('finalize[]=true')), true);
	assert.equal(requestsFinalize(query('finalized=true')), false);
});
