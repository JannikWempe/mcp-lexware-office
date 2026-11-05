import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogLookupDeclaration, catalogLookupPrelude, createCatalogLookup } from './catalog-lookup.js';
import { QuickJsExecutor } from './executor.js';
import { lexwareSpec } from './lexware-spec.js';

const { find, describe } = createCatalogLookup(lexwareSpec);

const ids = (query: string, count: number) => find(query).slice(0, count).map((match) => match.id);

test("find('upload beleg') ranks POST /v1/files and the fileHandling workflow first", () => {
	assert.deepEqual(new Set(ids('upload beleg', 2)), new Set(['uploadFile', 'fileHandling']));
	const upload = find('upload beleg').find((match) => match.id === 'uploadFile');
	assert.deepEqual({ method: upload?.method, path: upload?.path, hint: upload?.hint }, { method: 'POST', path: '/v1/files', hint: 'describe("POST", "/v1/files")' });
});

test("find('umsatz 2026') ranks the voucherlist and the revenue workflows first", () => {
	const top = ids('umsatz 2026', 3);
	assert.equal(top[0], 'listVoucherSummaries');
	assert.ok(top.includes('calculateInvoicedRevenue'), top.join(', '));
});

test('find ranks specific operations for English and German queries', () => {
	assert.equal(ids('invoice pdf download', 1)[0], 'downloadInvoicePdf');
	assert.equal(ids('update voucher', 1)[0], 'updateVoucher');
	assert.equal(ids('posting categories', 1)[0], 'listPostingCategories');
	assert.equal(ids('payment terms', 1)[0], 'listPaymentConditions');
	assert.equal(ids('webhooks', 1)[0], 'listEventSubscriptions');
	assert.equal(ids('GET /v1/vouchers/{id}', 1)[0], 'getVoucher');
	// German synonyms from spec.info.domainIndex tags, and German verbs the catalog only has in English.
	assert.ok(ids('mahnung', 3).includes('createDunning'));
	assert.ok(ids('angebote', 3).includes('createQuotation'));
	assert.deepEqual(new Set(ids('beleg hochladen', 2)), new Set(['uploadFile', 'fileHandling']));
	assert.equal(ids('kunde anlegen', 1)[0], 'createContact');
	assert.equal(ids('Rechnung erstellen', 1)[0], 'createInvoice');
	assert.equal(ids('ausgaben 2025', 1)[0], 'listBookkeepingExpenses');
});

test('find returns semantics entries with a readable hint', () => {
	const match = find('voucher status', { kinds: ['semantics'] })[0];
	assert.deepEqual({ kind: match?.kind, id: match?.id, hint: match?.hint }, { kind: 'semantics', id: 'voucherStatusSemantics', hint: 'spec.info.voucherStatusSemantics' });
	assert.equal(find('pagination')[0]?.id, 'pagination');
});

test('find results stay small, honour limit and kinds, and are sorted by score', () => {
	for (const query of ['upload beleg', 'umsatz 2026', 'invoice', 'voucher status', 'create sales document finalize']) {
		const results = find(query);
		assert.ok(results.length <= 8, query);
		assert.ok(JSON.stringify(results).length < 2_000, `${query}: ${JSON.stringify(results).length} chars`);
		assert.deepEqual(results.map((match) => match.score), results.map((match) => match.score).sort((a, b) => b - a));
	}
	assert.equal(find('invoice', { limit: 3 }).length, 3);
	assert.equal(find('invoice', { limit: 1000 }).length <= 25, true);
	assert.ok(find('invoice', { kinds: ['workflow'] }).every((match) => match.kind === 'workflow'));
	assert.deepEqual(find('xyzzy'), []);
	assert.deepEqual(find('   '), []);
	assert.throws(() => find('invoice', { kinds: ['endpoint' as never] }), /unknown kinds/);
	assert.throws(() => find('invoice', { kinds: 'operation' as never }), /kinds must be an array/);
	assert.throws(() => find('invoice', { limit: Number.NaN }), /limit must be a finite number/);
	assert.throws(() => find('invoice', null as never), /options to be an object/);
	assert.throws(() => find(undefined as never), /expects a string/);
});

test('describe returns a compact operation view and resolves concrete paths', () => {
	const view = describe('get', '/v1/vouchers/0f5d6c1e-0000-4000-8000-000000000000') as Record<string, unknown>;
	assert.equal(view.operationId, 'getVoucher');
	assert.equal(view.path, '/v1/vouchers/{id}');
	assert.equal(view.method, 'GET');
	assert.equal('tags' in view, false);
	assert.equal('capabilities' in view, false);

	const upload = describe('POST', '/v1/files') as { requestBody: Record<string, unknown> };
	assert.equal(upload.requestBody.contentType, 'multipart/form-data');
	assert.equal('shape' in upload.requestBody, false);

	assert.equal((describe('GET', '/v1/vouchers/') as Record<string, unknown>).operationId, 'filterVouchers');
	assert.equal((describe('GET', '/v1/voucherlist?voucherType=invoice') as Record<string, unknown>).operationId, 'listVoucherSummaries');

	assert.throws(() => describe('DELETE', '/v1/vouchers/{id}'), /Methods on \/v1\/vouchers\/\{id\}: GET, PUT/);
	assert.throws(() => describe('GET', '/v1/nope'), /Use find/);
	// Inherited properties are not catalog entries.
	assert.throws(() => describe('constructor', '/v1/vouchers'), /no catalog operation/);
	assert.throws(() => describe('GET', 'constructor'), /no catalog operation/);
	assert.throws(() => describe('GET', '__proto__'), /no catalog operation/);
	assert.throws(() => describe('GET', '/v1/invoices//file'), /no catalog operation/);
});

test('the prelude runs self-contained in QuickJS and matches the host implementation', async () => {
	const queries = ['upload beleg', 'umsatz 2026', 'mahnung', 'GET /v1/vouchers/{id}'];
	const execution = await new QuickJsExecutor().execute(
		`async () => ({ found: queries.map((query) => find(query)), described: describe('GET', '/v1/voucherlist'), onGlobal: typeof globalThis.find })`,
		{ spec: lexwareSpec, queries },
		{ prelude: catalogLookupPrelude },
	);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, {
		found: queries.map((query) => find(query)),
		described: JSON.parse(JSON.stringify(describe('GET', '/v1/voucherlist'))),
		onGlobal: 'undefined',
	});
});

test('the declaration lists the helpers and match fields the implementation provides', () => {
	for (const name of ['find(query: string', 'describe(method: string, path: string)', 'limit?', 'kinds?']) {
		assert.ok(catalogLookupDeclaration.includes(name), name);
	}
	for (const key of Object.keys(find('upload beleg')[0] ?? {})) {
		assert.match(catalogLookupDeclaration, new RegExp(`\\b${key}\\??:`), key);
	}
});
