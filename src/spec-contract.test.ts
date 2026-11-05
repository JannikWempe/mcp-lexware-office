import assert from 'node:assert/strict';
import test from 'node:test';

import { lexwareSpec, type HttpMethod, type LexwareOperation } from './lexware-spec.js';

/*
Doc-derived fixtures below are pinned from https://developers.lexware.io/docs/
(sections: Voucherlist "Retrieve and Filter Voucherlist", each sales document's
voucherStatus property, Paging of Resources, Vouchers "Voucher Properties" and
"Create a Voucher"). Update them only against the docs.
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

const DOCUMENTED_BOOKKEEPING_VOUCHER_STATUSES = ['blank', 'open', 'paid', 'paidoff', 'voided', 'transferred', 'sepadebit', 'unchecked'];

const DOCUMENTED_CREATE_VOUCHER_FIELDS = ['type', 'taxType', 'voucherNumber', 'voucherDate', 'totalGrossAmount', 'totalTaxAmount', 'voucherItems', 'contactId', 'useCollectiveContact'];

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

test('bookkeeping voucher create and update bodies follow the documented field rules', () => {
	const create = lexwareSpec.paths['/v1/vouchers']?.post;
	const update = lexwareSpec.paths['/v1/vouchers/{id}']?.put;
	assert.ok(create?.requestBody && update?.requestBody);
	for (const body of [create.requestBody, update.requestBody]) {
		const bodyText = JSON.stringify(body.required);
		for (const field of DOCUMENTED_CREATE_VOUCHER_FIELDS) {
			assert.ok(bodyText.includes(field), `voucher body required list misses documented field ${field}`);
		}
		assert.match(JSON.stringify(body.shape), /"taxType":"net\|gross"/);
	}
	assert.ok(update.requestBody.required?.includes('version'));
	assert.doesNotMatch(JSON.stringify(create.examples), /"version"/);
	assert.match(JSON.stringify(create.notes), /prohibits unchecked net vouchers/);
});

test('updateVoucher warns first that omitted file ids are deleted permanently', () => {
	const update = lexwareSpec.paths['/v1/vouchers/{id}']?.put;
	assert.match(update?.notes?.[0] ?? '', /send the complete current files array; omitted file ids are deleted permanently/);
	assert.ok(update?.requestBody?.required?.includes('files'));
});

test('updateVoucher does not claim unchecked vouchers are never updatable', () => {
	const notesText = JSON.stringify(lexwareSpec.paths['/v1/vouchers/{id}']?.put?.notes);
	assert.doesNotMatch(notesText, /cannot be updated/);
	assert.match(notesText, /Omit voucherStatus unless finalizing to open, then GET the voucher to verify/);
});

test('getVoucher lists every documented bookkeeping voucher status, including blank', () => {
	const notesText = JSON.stringify(lexwareSpec.paths['/v1/vouchers/{id}']?.get?.notes);
	for (const status of DOCUMENTED_BOOKKEEPING_VOUCHER_STATUSES) {
		assert.match(notesText, new RegExp(`\\b${status}\\b`), `getVoucher notes miss status ${status}`);
	}
});

test('file uploads document 202 Accepted instead of the shared 200 response', () => {
	const upload = lexwareSpec.paths['/v1/files']?.post;
	const attach = lexwareSpec.paths['/v1/vouchers/{id}/files']?.post;
	for (const operation of [upload, attach]) {
		assert.ok(operation?.responses?.['202']);
		assert.equal(operation.responses['200'], undefined);
	}
	assert.match(upload?.responses?.['202'] ?? '', /voucherId/);
	assert.match(JSON.stringify(upload?.notes), /5 MB/);
	assert.match(JSON.stringify(upload?.notes), /status blank/);
});

test('duplicateVoucher copies the contact choice and keeps voucherNumber for open vouchers', () => {
	const workflowText = JSON.stringify(lexwareSpec.workflows.duplicateVoucher);
	assert.match(workflowText, /useCollectiveContact/);
	assert.doesNotMatch(workflowText, /Omit voucherNumber/);
	assert.match(workflowText, /can be assigned to only one voucher/);
});

/*
Pinned from the docs "Create …" and "Pursue to …" sections of each sales document,
"Event Types", "Update a Contact", "Payments properties" and the FAQ "Datetime Format".
*/
const DOCUMENTED_SALES_REQUIRED: Record<string, string[]> = {
	'/v1/invoices': ['voucherDate', 'address', 'lineItems', 'totalPrice', 'taxConditions', 'shippingConditions'],
	'/v1/order-confirmations': ['voucherDate', 'address', 'lineItems', 'totalPrice', 'taxConditions', 'shippingConditions'],
	'/v1/quotations': ['voucherDate', 'expirationDate', 'address', 'lineItems', 'totalPrice', 'taxConditions'],
	'/v1/credit-notes': ['voucherDate', 'address', 'lineItems', 'totalPrice', 'taxConditions'],
	'/v1/delivery-notes': ['voucherDate', 'address', 'lineItems', 'taxConditions', 'shippingConditions'],
	'/v1/dunnings': ['voucherDate', 'address', 'lineItems', 'totalPrice', 'taxConditions', 'shippingConditions'],
};

const DOCUMENTED_SALES_TAX_TYPES = ['net', 'gross', 'vatfree', 'intraCommunitySupply', 'constructionService13b', 'externalService13b', 'thirdPartyCountryService', 'thirdPartyCountryDelivery', 'photovoltaicEquipment'];

const DOCUMENTED_EVENT_TYPES = [
	'article.created', 'article.changed', 'article.deleted',
	'contact.created', 'contact.changed', 'contact.deleted',
	'credit-note.created', 'credit-note.changed', 'credit-note.deleted', 'credit-note.status.changed',
	'delivery-note.created', 'delivery-note.changed', 'delivery-note.deleted', 'delivery-note.status.changed',
	'down-payment-invoice.created', 'down-payment-invoice.changed', 'down-payment-invoice.deleted', 'down-payment-invoice.status.changed',
	'dunning.created', 'dunning.changed', 'dunning.deleted',
	'invoice.created', 'invoice.changed', 'invoice.deleted', 'invoice.status.changed',
	'order-confirmation.created', 'order-confirmation.changed', 'order-confirmation.deleted', 'order-confirmation.status.changed',
	'quotation.created', 'quotation.changed', 'quotation.deleted', 'quotation.status.changed',
	'recurring-template.created', 'recurring-template.changed', 'recurring-template.deleted',
	'voucher.created', 'voucher.changed', 'voucher.deleted', 'voucher.status.changed',
	'payment.changed', 'token.revoked',
];

const salesCreate = (path: string): LexwareOperation => {
	const operation = lexwareSpec.paths[path]?.post;
	assert.ok(operation, `missing POST ${path}`);
	return operation;
};

test('each sales document create lists exactly its documented required fields', () => {
	for (const [path, expected] of Object.entries(DOCUMENTED_SALES_REQUIRED)) {
		assert.deepEqual([...(salesCreate(path).requestBody?.required ?? [])].sort(), [...expected].sort(), `required fields of POST ${path} diverge from docs`);
	}
	assert.match(salesCreate('/v1/quotations').requestBody?.summary ?? '', /expirationDate is required/);
});

test('sales document bodies document the full enums, datetime format and limits', () => {
	for (const path of Object.keys(DOCUMENTED_SALES_REQUIRED)) {
		const operation = salesCreate(path);
		const shape = operation.requestBody?.shape as { voucherDate: string; lineItems: Array<{ type: string }>; taxConditions: { taxType: string; taxSubType: string } };
		assert.match(shape.voucherDate, /yyyy-MM-ddTHH:mm:ss\.SSSXXX/);
		assert.deepEqual(shape.lineItems[0]?.type.split('|'), ['custom', 'material', 'service', 'text']);
		assert.deepEqual(shape.taxConditions.taxType.split('|').sort(), [...DOCUMENTED_SALES_TAX_TYPES].sort());
		assert.match(shape.taxConditions.taxSubType, /distanceSales\|electronicServices/);
		const notesText = JSON.stringify(operation.notes);
		assert.match(notesText, /At most 300 line items/);
		assert.match(notesText, /unitPrice except on delivery notes, where it is optional/);
		assert.match(notesText, /title 25, introduction and remark 2000/);
		assert.match(notesText, /other formats are rejected with 406/);
		assert.match(notesText, /electronicDocumentProfile .* is read-only/);
		const requiresShipping = DOCUMENTED_SALES_REQUIRED[path]?.includes('shippingConditions');
		assert.equal('shippingConditions' in (operation.requestBody?.shape as object), requiresShipping, `POST ${path} shippingConditions shape`);
	}
	assert.ok('xRechnung' in (salesCreate('/v1/invoices').requestBody?.shape as object));
});

test('pursue rules are spelled out per document type', () => {
	const param = (path: string): string => salesCreate(path).parameters?.find((parameter) => parameter.name === 'precedingSalesVoucherId')?.description ?? '';
	for (const path of ['/v1/invoices', '/v1/order-confirmations', '/v1/credit-notes', '/v1/delivery-notes', '/v1/dunnings']) {
		assert.match(param(path), /invalid pursue action is rejected with 406/);
	}
	assert.match(param('/v1/invoices'), /alternative or optional line items, or a draft order confirmation or delivery note/);
	assert.match(param('/v1/delivery-notes'), /draft order confirmation/);
	assert.match(param('/v1/credit-notes'), /draft invoice is rejected with 406, and a closing invoice cannot be pursued/);
	assert.match(JSON.stringify(salesCreate('/v1/credit-notes').notes), /Only one credit note can relate to an invoice.*immediately gets status paidoff/);
	assert.match(param('/v1/dunnings'), /down-payment invoice/);
	assert.match(JSON.stringify(salesCreate('/v1/dunnings').notes), /taxConditions must match the invoice/);
	assert.equal(salesCreate('/v1/quotations').parameters?.some((parameter) => parameter.name === 'precedingSalesVoucherId'), false);
});

test('creates document 201 instead of the shared 200', () => {
	for (const [path, methods] of Object.entries(lexwareSpec.paths)) {
		const operation = methods.post;
		if (!operation || operation.requestBody?.contentType === 'multipart/form-data') continue;
		assert.ok(operation.responses?.['201'], `POST ${path} has no 201 response`);
		assert.equal(operation.responses['200'], undefined, `POST ${path} still documents 200`);
		if (path !== '/v1/event-subscriptions') assert.equal(operation.responses['409'], undefined, `POST ${path} documents an optimistic-locking 409`);
	}
});

test('event subscriptions list every documented event type and the create semantics', () => {
	const create = lexwareSpec.paths['/v1/event-subscriptions']?.post;
	const shape = create?.requestBody?.shape as { eventType: string };
	const listed = shape.eventType.replace(/^one of: /, '').split(', ');
	assert.deepEqual([...listed].sort(), [...DOCUMENTED_EVENT_TYPES].sort());
	assert.match(create?.responses?.['409'] ?? '', /already exists/);
	assert.match(create?.responses?.['406'] ?? '', /HEAD check/);
	assert.match(JSON.stringify(lexwareSpec.paths['/v1/payments/{voucherId}']?.get?.notes), /payment\.changed event for a draft voucher is expected/);
});

test('contact update explains the more-than-one-entry restriction', () => {
	const notesText = JSON.stringify(lexwareSpec.paths['/v1/contacts/{id}']?.put?.notes);
	assert.match(notesText, /cannot be updated via the API if any of these lists has more than one entry/);
	assert.doesNotMatch(notesText, /replaced as a whole/);
	for (const list of ['addresses.billing', 'addresses.shipping', 'emailAddresses', 'phoneNumbers', 'company.contactPersons']) {
		assert.match(notesText, new RegExp(list.replace('.', '\\.')));
	}
});

test('operation docsUrls point at the operation, not the endpoint root', () => {
	for (const [path, methods] of Object.entries(lexwareSpec.paths)) {
		for (const [method, operation] of Object.entries(methods) as Array<[HttpMethod, LexwareOperation]>) {
			assert.doesNotMatch(operation.docsUrl ?? '', /-endpoint$/, `${method.toUpperCase()} ${path} links the endpoint root`);
		}
	}
});

test('smaller catalog facts match the docs', () => {
	assert.match(JSON.stringify(lexwareSpec.paths['/v1/payments/{voucherId}']?.get?.notes), /irrecoverableReceivable/);
	const sort = lexwareSpec.paths['/v1/recurring-templates']?.get?.parameters?.find((parameter) => parameter.name === 'sort')?.description ?? '';
	assert.match(sort, /createdDate, updatedDate, lastExecutionDate or nextExecutionDate/);
	assert.match(sort, /Default updatedDate,DESC/);
	assert.match(JSON.stringify(lexwareSpec.paths['/v1/articles']?.post?.requestBody?.shape), /"taxRate":"0\|7\|19"/);
	assert.match(JSON.stringify(lexwareSpec.paths['/v1/voucherlist']?.get?.notes), /lexware\.requireMoney throws on such rows/);
});
