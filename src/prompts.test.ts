import assert from 'node:assert/strict';
import test from 'node:test';

import { lexwareSdkDeclaration } from './lexware-sandbox-sdk.js';
import { lexwareSpec, type HttpMethod } from './lexware-spec.js';
import { workflowPrompts, type PromptContext } from './prompts.js';
import { parseWriteAllow } from './write-policy.js';

const prompt = (name: string) => {
	const found = workflowPrompts.find((candidate) => candidate.name === name);
	assert.ok(found, name);
	return found;
};

const contexts: PromptContext[] = [
	{ writesEnabled: false },
	{ writesEnabled: true },
	{ writesEnabled: true, writeAllow: parseWriteAllow('POST /v1/files') },
];

// Every argument value a prompt accepts, plus all omitted, so the contract covers each branch.
const argVariants = [
	{},
	{ files: '/data/a.pdf, /data/b.pdf', mode: 'preview', dateFrom: '2026-01-01', dateTo: '2026-03-31', basis: 'paid', customer: 'Muster GmbH', details: '3 h consulting at 120 EUR net' },
	{ mode: 'apply', basis: 'net' },
	{ basis: 'invoiced' },
];

const renderings = workflowPrompts.flatMap((candidate) => contexts.flatMap((context) => argVariants.map((variant) => {
	const args = candidate.argsSchema.strip().parse(variant);
	return { name: candidate.name, text: candidate.render(args, context) };
})));

// Ignores path parameter names; a trailing '/' is a template literal such as `/v1/invoices/${id}`.
const withoutParamNames = (path: string) => path.replace(/\{[^/}]*\}/g, '{}').replace(/\/$/, '/{}');
const catalogOperations = new Set(Object.entries(lexwareSpec.paths).flatMap(([path, methods]) =>
	Object.keys(methods).map((method) => `${method.toUpperCase()} ${withoutParamNames(path)}`)));

test('prompts mention only cataloged operations', () => {
	for (const { name, text } of renderings) {
		for (const [, method, path] of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/v1\/[\w/{}-]*)/g)) {
			assert.ok(catalogOperations.has(`${method} ${withoutParamNames(path)}`), `${name}: ${method} ${path} is not in spec.paths`);
		}
		for (const [, path] of text.matchAll(/(\/v1\/[\w/{}-]*)/g)) {
			assert.ok(Object.keys(lexwareSpec.paths).some((known) => withoutParamNames(known) === withoutParamNames(path)), `${name}: ${path} is not in spec.paths`);
		}
	}
});

test('prompts mention only existing workflows, spec.info sections and SDK helpers', () => {
	for (const { name, text } of renderings) {
		for (const [, key] of text.matchAll(/(?:spec\.workflows\.|\bworkflow )([a-z]+[A-Z]\w*)/g)) {
			assert.ok(lexwareSpec.workflows[key] !== undefined, `${name}: workflow ${key} does not exist`);
		}
		for (const [, key] of text.matchAll(/spec\.info\.(\w+)/g)) {
			assert.ok(key in lexwareSpec.info || ['account', 'writesEnabled', 'writePolicy'].includes(key), `${name}: spec.info.${key} does not exist`);
		}
		for (const [, helper] of text.matchAll(/\blexware\.(\w+)/g)) {
			assert.match(lexwareSdkDeclaration, new RegExp(`^  ${helper}[<(]`, 'm'), `${name}: lexware.${helper} is not in the SDK`);
		}
	}
});

test('prompt writes are cataloged writes', () => {
	for (const candidate of workflowPrompts) {
		for (const write of candidate.writes) {
			assert.ok(lexwareSpec.paths[write.path]?.[write.method.toLowerCase() as HttpMethod], `${candidate.name}: ${write.method} ${write.path}`);
		}
	}
});

test('write prompts say up front when the server is read-only', () => {
	for (const name of ['upload-receipts', 'create-invoice']) {
		const text = prompt(name).render({}, { writesEnabled: false });
		assert.match(text, /^This server is read-only \(spec\.info\.writesEnabled is false\)/, name);
		assert.match(text, /LEXWARE_OFFICE_ALLOW_WRITES=true/, name);
		assert.doesNotMatch(prompt(name).render({}, { writesEnabled: true }), /read-only/, name);
	}
	for (const name of ['revenue-report', 'profit-report']) {
		assert.equal(prompt(name).writes.length, 0);
		assert.equal(prompt(name).render({}, { writesEnabled: false }), prompt(name).render({}, { writesEnabled: true }), name);
	}
});

test('write prompts name the writes LEXWARE_OFFICE_WRITE_ALLOW blocks', () => {
	const upload = prompt('upload-receipts').render({}, { writesEnabled: true, writeAllow: parseWriteAllow('POST /v1/files') });
	assert.match(upload, /^LEXWARE_OFFICE_WRITE_ALLOW blocks PUT \/v1\/vouchers\/\{id\} \(/);

	const draftsOnly = prompt('create-invoice').render({}, { writesEnabled: true, writeAllow: parseWriteAllow('POST /v1/invoices') });
	assert.match(draftsOnly, /^LEXWARE_OFFICE_WRITE_ALLOW blocks POST \/v1\/invoices\?finalize=true \(/);

	const allowed = prompt('create-invoice').render({}, { writesEnabled: true, writeAllow: parseWriteAllow('POST /v1/invoices?finalize') });
	assert.doesNotMatch(allowed, /LEXWARE_OFFICE_WRITE_ALLOW blocks/);
});

test('write mode preview sends no writes', () => {
	assert.match(prompt('upload-receipts').render({ mode: 'preview' }, { writesEnabled: true }), /Write mode preview: run every execute call that writes with dryRun: true/);
	assert.match(prompt('create-invoice').render({}, { writesEnabled: true }), /Write mode apply/);
});

test('prompts render their arguments', () => {
	const upload = prompt('upload-receipts').render({ files: '/data/a.pdf,\n/data/b.pdf' }, { writesEnabled: true });
	assert.match(upload, /^- \/data\/a\.pdf\n- \/data\/b\.pdf$/m);
	assert.match(upload, /spec\.workflows\.uploadReceipts/);
	assert.match(upload, /spec\.workflows\.reconcileBeforeUpload/);

	const revenue = prompt('revenue-report').render({ dateFrom: '2026-01-01', dateTo: '2026-12-31', basis: 'paid' }, { writesEnabled: false });
	assert.match(revenue, /Period: voucherDate 2026-01-01 to 2026-12-31\./);
	assert.match(revenue, /spec\.workflows\.calculatePaidRevenue/);
	assert.doesNotMatch(revenue, /calculateInvoicedRevenue\)/);

	assert.match(prompt('revenue-report').render({}, { writesEnabled: false }), /Ask the user for the period/);
	assert.match(prompt('revenue-report').render({}, { writesEnabled: false }), /spec\.workflows\.calculateInvoicedRevenue/);

	const profit = prompt('profit-report').render({ dateFrom: '2026-01-01', dateTo: '2026-06-30' }, { writesEnabled: false });
	assert.match(profit, /spec\.workflows\.calculateInvoicedRevenue/);
	assert.match(profit, /spec\.workflows\.listBookkeepingExpenses/);

	const invoice = prompt('create-invoice').render({ customer: 'Muster GmbH' }, { writesEnabled: true });
	assert.match(invoice, /Customer: Muster GmbH/);
	assert.match(invoice, /Ask the user what to invoice/);
	assert.match(invoice, /spec\.workflows\.createAndFinalizeSalesDocument/);
});

test('prompt text comes from spec.workflows, so catalog edits reach the prompts', () => {
	const text = prompt('upload-receipts').render({}, { writesEnabled: true });
	for (const line of [...lexwareSpec.workflows.uploadReceipts.steps, ...(lexwareSpec.workflows.reconcileBeforeUpload.notes ?? [])]) {
		assert.ok(text.includes(line), line);
	}
});
