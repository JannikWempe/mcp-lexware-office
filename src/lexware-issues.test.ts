import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient } from './lexware-client.js';
import { normalizeIssues } from './lexware-issues.js';

const requestWith = (status: number, body: string, contentType = 'application/json') => new LexwareApiClient({
	apiKey: 'test-key',
	baseUrl: 'https://example.test',
	rateLimitIntervalMs: 0,
	writesEnabled: true,
	fetchImpl: async () => new Response(body, { status, headers: { 'content-type': contentType } }),
}).request({ method: 'POST', path: '/v1/vouchers', body: {} });

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

test('bad_request_error keeps its source as the message, not as a field', () => {
	assert.deepEqual(normalizeIssues(400, { IssueList: [{ i18nKey: 'bad_request_error', source: 'size must be between 3 and 255', type: 'bad_request_error' }] })?.map(({ hint: _hint, ...issue }) => issue), [
		{ code: 'bad_request_error', message: 'size must be between 3 and 255' },
	]);
});

test('409 always carries the optimistic locking hint', () => {
	const [withoutBody] = normalizeIssues(409, { message: 'conflict' }) ?? [];
	assert.match(withoutBody?.hint ?? '', /re-fetch the resource/);

	const [withDetails] = normalizeIssues(409, { details: [{ field: 'version', violation: 'STALE' }] }) ?? [];
	assert.equal(withDetails?.field, 'version');
	assert.match(withDetails?.hint ?? '', /re-fetch the resource/);
});

test('bodies without either shape, prototype keys, and successful responses get no issues', async () => {
	assert.equal(normalizeIssues(404, { message: 'not found' }), undefined);
	assert.equal(normalizeIssues(406, null), undefined);
	assert.equal(normalizeIssues(406, ['IssueList']), undefined);
	assert.deepEqual(normalizeIssues(406, { IssueList: [{ i18nKey: 'constructor' }, 'junk'] }), [{ code: 'constructor' }]);

	const ok = await requestWith(200, JSON.stringify({ IssueList: [{ i18nKey: 'missing_entity' }] }));
	assert.equal(Object.prototype.hasOwnProperty.call(ok, 'issues'), false);
	const text = await requestWith(406, 'not json', 'text/plain');
	assert.equal(Object.prototype.hasOwnProperty.call(text, 'issues'), false);
});
