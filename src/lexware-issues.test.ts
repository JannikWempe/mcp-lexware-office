import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient, type LexwareRequestInput } from './lexware-client.js';
import { normalizeIssues } from './lexware-issues.js';
import { createLexwareSdk } from './lexware-sandbox-sdk.js';

const clientAnswering = (status: number, body: string, contentType = 'application/json') => new LexwareApiClient({
	apiKey: 'test-key',
	baseUrl: 'https://example.test',
	rateLimitIntervalMs: 0,
	writesEnabled: true,
	fetchImpl: async () => new Response(body, { status, headers: { 'content-type': contentType } }),
});

const requestWith = (status: number, body: string, contentType?: string, input: LexwareRequestInput = { method: 'POST', path: '/v1/vouchers', body: {} }) => clientAnswering(status, body, contentType).request(input);

test('legacy IssueList bodies normalize into issues with hints for known codes', async () => {
	const response = await requestWith(406, JSON.stringify({
		IssueList: [
			{ i18nKey: 'Missing_ContactId', source: 'contactId', type: 'validation_failure', additionalData: null, args: null },
			{ i18nKey: 'invalid_taxamount', source: 'voucherItems[0].taxAmount', type: 'validation_failure' },
			{ i18nKey: 'some_new_code', source: 'remark', type: 'validation_failure' },
		],
	}));

	assert.equal(response.errorCategory, 'validation');
	assert.deepEqual(response.issues?.map(({ hint, ...issue }) => ({ ...issue, hasHint: hint !== undefined })), [
		{ field: 'contactId', code: 'Missing_ContactId', hasHint: true },
		{ field: 'voucherItems[0].taxAmount', code: 'invalid_taxamount', hasHint: true },
		{ field: 'remark', code: 'some_new_code', hasHint: false },
	]);
	assert.match(response.issues?.[0]?.hint ?? '', /useCollectiveContact: true/);
	assert.match(response.issues?.[1]?.hint ?? '', /totalTaxAmount must equal the sum/);
	// The raw body stays available next to the normalized issues.
	assert.equal((response.data as { IssueList: unknown[] }).IssueList.length, 3);
});

test('regular details bodies normalize into issues', async () => {
	const response = await requestWith(406, JSON.stringify({
		status: 406,
		error: 'Not Acceptable',
		message: 'Validation failed for request. Please see details list for specific causes.',
		traceId: '90d78d0777be',
		details: [{ violation: 'NOTNULL', field: 'lineItems[0].unitPrice.taxRatePercentage', message: 'darf nicht leer sein' }],
	}));

	assert.equal(response.issues?.length, 1);
	assert.deepEqual({ ...response.issues?.[0], hint: undefined }, { field: 'lineItems[0].unitPrice.taxRatePercentage', code: 'NOTNULL', message: 'darf nicht leer sein', hint: undefined });
	assert.match(response.issues?.[0]?.hint ?? '', /mandatory/);
});

test('legacy sources that hold a message instead of a field become the message', () => {
	const issues = normalizeIssues(400, 'GET', { IssueList: [
		{ i18nKey: 'bad_request_error', source: 'size must be between 3 and 255', type: 'bad_request_error' },
		{ i18nKey: 'technical_error', source: 'contact_vendor_info_not_assigned', type: 'technical_error' },
	] });
	assert.deepEqual(issues?.map(({ hint: _hint, ...issue }) => issue), [
		{ code: 'bad_request_error', message: 'size must be between 3 and 255' },
		{ code: 'technical_error', message: 'contact_vendor_info_not_assigned' },
	]);
});

test('409 on PUT carries the optimistic locking hint; other 409s do not', async () => {
	const [withoutShape] = normalizeIssues(409, 'PUT', { message: 'conflict' }) ?? [];
	assert.match(withoutShape?.hint ?? '', /re-fetch the resource/);

	const [withDetails] = normalizeIssues(409, 'PUT', { details: [{ field: 'version', violation: 'STALE' }] }) ?? [];
	assert.equal(withDetails?.field, 'version');
	assert.match(withDetails?.hint ?? '', /re-fetch the resource/);

	// e.g. GET /v1/invoices/{id}/file on a draft, or POST of a duplicate event subscription.
	assert.equal(normalizeIssues(409, 'GET', { message: 'draft' }), undefined);
	assert.equal(normalizeIssues(409, 'POST', { message: 'duplicate' }), undefined);

	const text = await requestWith(409, 'Conflict', 'text/plain', { method: 'PUT', path: '/v1/vouchers/abc', body: {} });
	assert.match(text.issues?.[0]?.hint ?? '', /re-fetch the resource/);
});

test('bodies without either shape, prototype keys, and successful responses get no issues', async () => {
	assert.equal(normalizeIssues(404, 'GET', { message: 'not found' }), undefined);
	assert.equal(normalizeIssues(406, 'POST', null), undefined);
	assert.equal(normalizeIssues(406, 'POST', ['IssueList']), undefined);
	assert.deepEqual(normalizeIssues(406, 'POST', { IssueList: [{ i18nKey: 'constructor' }, 'junk'] }), [{ code: 'constructor' }]);

	const ok = await requestWith(200, JSON.stringify({ IssueList: [{ i18nKey: 'missing_entity' }] }));
	assert.equal(Object.prototype.hasOwnProperty.call(ok, 'issues'), false);
	const text = await requestWith(406, 'not json', 'text/plain');
	assert.equal(Object.prototype.hasOwnProperty.call(text, 'issues'), false);
});

test('lexware.json and lexware.paginate errors carry the hints of a real client response', async () => {
	const client = clientAnswering(406, JSON.stringify({ IssueList: [{ i18nKey: 'Missing_ContactId', source: 'contactId', type: 'validation_failure' }] }));
	const sdk = createLexwareSdk(async (payload) => JSON.stringify(await client.request(JSON.parse(payload))));

	await assert.rejects(() => sdk.json({ method: 'POST', path: '/v1/vouchers', body: {} }), /Issues: \[contactId Missing_ContactId \(hint: Set contactId to an existing contact/);
	await assert.rejects(() => sdk.paginate({ path: '/v1/contacts' }), /Issues: \[contactId Missing_ContactId \(hint: Set contactId to an existing contact/);
});
