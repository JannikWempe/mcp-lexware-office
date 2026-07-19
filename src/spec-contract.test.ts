import assert from 'node:assert/strict';
import test from 'node:test';

import { lexwareSpec, type HttpMethod, type LexwareOperation } from './lexware-spec.js';

/*
Doc-derived fixtures below are pinned from https://developers.lexware.io/docs/
(sections: Voucherlist "Retrieve and Filter Voucherlist", each sales document's
voucherStatus property, Paging of Resources). Update them only against the docs.
*/

const DOCUMENTED_VOUCHERLIST_STATUSES = [
	'draft', 'open', 'overdue', 'paid', 'paidoff', 'voided', 'transferred', 'sepadebit', 'accepted', 'rejected', 'unchecked',
];

const DOCUMENTED_SALES_DOCUMENT_STATUSES: Record<string, string[]> = {
	invoice: ['draft', 'open', 'paid', 'voided'],
	downpaymentinvoice: ['draft', 'open', 'paid', 'voided'],
	quotation: ['draft', 'open', 'accepted', 'rejected'],
	orderconfirmation: ['draft', 'open'],
	creditnote: ['draft', 'open', 'paidoff', 'voided'],
	deliverynote: ['draft', 'open'],
};

const DOCUMENTED_VOUCHERLIST_TYPES = [
	'salesinvoice', 'salescreditnote', 'purchaseinvoice', 'purchasecreditnote',
	'invoice', 'downpaymentinvoice', 'creditnote', 'orderconfirmation', 'quotation', 'deliverynote',
];

const DOCUMENTED_VOUCHERLIST_FILTER_PARAMS = [
	'voucherType', 'voucherStatus', 'archived', 'contactId',
	'voucherDateFrom', 'voucherDateTo', 'createdDateFrom', 'createdDateTo', 'updatedDateFrom', 'updatedDateTo',
	'voucherNumber', 'sort', 'page', 'size',
];

const voucherTypes = lexwareSpec.info.voucherStatusSemantics.voucherTypes;

test('sales-document status lists match the official docs', () => {
	for (const [type, expected] of Object.entries(DOCUMENTED_SALES_DOCUMENT_STATUSES)) {
		const info = voucherTypes[type];
		assert.ok(info, `voucherStatusSemantics.voucherTypes is missing ${type}`);
		assert.deepEqual([...info.statuses].sort(), [...expected].sort(), `statuses for ${type} diverge from docs`);
	}
});

test('catalog voucherTypes cover every documented voucherlist type and no fabricated ones', () => {
	assert.deepEqual(Object.keys(voucherTypes).sort(), [...DOCUMENTED_VOUCHERLIST_TYPES].sort());
});

test('every status token in the catalog is a documented voucherlist status', () => {
	for (const [type, info] of Object.entries(voucherTypes)) {
		for (const status of [...info.statuses, ...info.defaultStatuses]) {
			assert.ok(DOCUMENTED_VOUCHERLIST_STATUSES.includes(status), `voucherTypes.${type} uses undocumented status ${status}`);
		}
	}
});

test('defaultStatuses are a subset of each type\'s statuses', () => {
	for (const [type, info] of Object.entries(voucherTypes)) {
		for (const status of info.defaultStatuses) {
			assert.ok(info.statuses.includes(status), `voucherTypes.${type} default status ${status} is not in its statuses`);
		}
	}
});

test('reportingDefaults only use statuses valid for their voucherType', () => {
	for (const [name, reportingDefault] of Object.entries(lexwareSpec.info.voucherStatusSemantics.reportingDefaults)) {
		const types = reportingDefault.voucherType.split(',');
		const statuses = reportingDefault.voucherStatus.split(',');
		for (const status of statuses) {
			const validSomewhere = types.some((type) => voucherTypes[type]?.statuses.includes(status));
			assert.ok(validSomewhere, `reportingDefaults.${name} uses status ${status} not valid for voucherType ${reportingDefault.voucherType}`);
		}
	}
});

test('finance metrics only use statuses valid for invoice where they target invoices', () => {
	for (const [name, metric] of Object.entries(lexwareSpec.info.financeReportingSemantics.metrics)) {
		if (metric.voucherType !== 'invoice' || !metric.voucherStatus) continue;
		for (const status of metric.voucherStatus.split(',')) {
			assert.ok(voucherTypes.invoice.statuses.includes(status), `metrics.${name} uses status ${status} not valid for invoices`);
		}
	}
});

test('voucherlist operation documents the full documented filter parameter set', () => {
	const operation = lexwareSpec.paths['/v1/voucherlist']?.get;
	assert.ok(operation);
	const parameterNames = (operation.parameters ?? []).map((parameter) => parameter.name);
	for (const name of DOCUMENTED_VOUCHERLIST_FILTER_PARAMS) {
		assert.ok(parameterNames.includes(name), `/v1/voucherlist is missing documented filter param ${name}`);
	}
});

test('voucherlist guidance covers the any wildcard, overdue rules, and the 10k search window cap', () => {
	const semanticsText = JSON.stringify(lexwareSpec.info.voucherStatusSemantics);
	const voucherlistText = JSON.stringify(lexwareSpec.paths['/v1/voucherlist']?.get);
	const paginationText = JSON.stringify(lexwareSpec.info.pagination);

	assert.match(semanticsText + voucherlistText, /wildcard value any/);
	assert.match(semanticsText, /overdue/);
	assert.match(voucherlistText + semanticsText, /cannot be combined with other status/);
	assert.match(paginationText, /Maximum search window size exceeded/);
	assert.match(voucherlistText, /Maximum search window size exceeded/);
});

test('domainIndex covers every resource present in spec.paths', () => {
	const indexedPaths = new Set(
		Object.values(lexwareSpec.info.domainIndex).flatMap((domain) => domain.endpoints.map((endpoint) => endpoint.path)),
	);
	const resourceOf = (path: string): string => path.split('/')[2] ?? path;
	const indexedResources = new Set([...indexedPaths].map(resourceOf));
	for (const path of Object.keys(lexwareSpec.paths)) {
		assert.ok(indexedResources.has(resourceOf(path)), `domainIndex has no entry covering resource of ${path}`);
	}
});

test('domainIndex endpoints all exist in spec.paths with the stated method', () => {
	for (const [name, domain] of Object.entries(lexwareSpec.info.domainIndex)) {
		for (const endpoint of domain.endpoints) {
			const methods = lexwareSpec.paths[endpoint.path] as Partial<Record<HttpMethod, LexwareOperation>> | undefined;
			assert.ok(methods, `domainIndex.${name} references unknown path ${endpoint.path}`);
			assert.ok(methods[endpoint.method.toLowerCase() as HttpMethod], `domainIndex.${name} references missing ${endpoint.method} ${endpoint.path}`);
		}
	}
});
