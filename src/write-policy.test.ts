import assert from 'node:assert/strict';
import test from 'node:test';

import { describeWritePolicy, parseWriteAllow, requestsFinalize, writeAllowViolation } from './write-policy.js';

const query = (search = '') => new URLSearchParams(search);

test('METHOD path and operationId entries resolve to the same rule; ?finalize is kept', () => {
	assert.deepEqual(parseWriteAllow('POST /v1/invoices'), parseWriteAllow('createInvoice'));
	assert.deepEqual(describeWritePolicy(true, parseWriteAllow('createInvoice?finalize')).allow, ['POST /v1/invoices?finalize']);
	assert.deepEqual(describeWritePolicy(true, parseWriteAllow('DELETE /v1/event-subscriptions/{id}')).allow, ['DELETE /v1/event-subscriptions/{subscriptionId}']);
});

test('invalid entries name the entry in the error', () => {
	assert.throws(() => parseWriteAllow('POST /v1/files, PUT /v1/contact/{id}'), /"PUT \/v1\/contact\/\{id\}" does not match a cataloged write.*Known writes: .*PUT \/v1\/contacts\/\{id\}/);
	assert.throws(() => parseWriteAllow('PUT /v1/vouchers/{id}?finalize'), /PUT \/v1\/vouchers\/\{id\} has no finalize parameter/);
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
