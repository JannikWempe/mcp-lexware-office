import assert from 'node:assert/strict';
import test from 'node:test';

import { describeWriteAllowRule, parseWriteAllow, requestsFinalize, writeAllowViolation } from './write-policy.js';

const query = (search = '') => new URLSearchParams(search);

test('METHOD path and operationId entries resolve to the same rule; ?finalize is kept', () => {
	assert.deepEqual(parseWriteAllow('POST /v1/invoices'), parseWriteAllow('createInvoice'));
	assert.deepEqual(parseWriteAllow('createInvoice?finalize').map(describeWriteAllowRule), ['POST /v1/invoices?finalize']);
	assert.deepEqual(parseWriteAllow('DELETE /v1/event-subscriptions/{id}').map(describeWriteAllowRule), ['DELETE /v1/event-subscriptions/{subscriptionId}']);
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

test('finalize requires a ?finalize rule; drafts are allowed by either', () => {
	const drafts = parseWriteAllow('POST /v1/invoices');
	const finalize = parseWriteAllow('POST /v1/invoices?finalize');
	const request = (search: string) => ({ method: 'POST', path: '/v1/invoices', query: query(search), operationId: 'createInvoice' });

	assert.equal(writeAllowViolation(drafts, request('')), undefined);
	assert.equal(writeAllowViolation(drafts, request('finalize=false')), undefined);
	for (const search of ['finalize=true', 'finalize=TRUE', 'finalize=1', 'finalize', 'finalize=false&finalize=true']) {
		assert.match(writeAllowViolation(drafts, request(search)) ?? '', /finalize=true is blocked.*add "POST \/v1\/invoices\?finalize"/, search);
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
});
