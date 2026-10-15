import assert from 'node:assert/strict';
import test from 'node:test';

import { createLexwareSdk } from './lexware-sandbox-sdk.js';
import { lexwareSpec } from './lexware-spec.js';

/*
Optional live contract check before releasing reporting changes:
Run a read-only /v1/voucherlist request with size=1 against a non-sensitive account and inspect only the returned field names. Confirm voucherlist rows still expose totalAmount and openAmount. Do not log customer data or amounts in CI.
*/

const lexware = createLexwareSdk(async () => '{}');

test('spec uses voucherlist summary fields', () => {
	const semantics = lexwareSpec.info.financeReportingSemantics;
	assert.match(semantics.defaultPolicy.amountField, /totalAmount/);
	assert.ok(semantics.metrics.grossInvoicedRevenue.amountFields?.includes('totalAmount'));

	const voucherlistNotes = lexwareSpec.paths['/v1/voucherlist']?.get?.notes?.join('\n') ?? '';
	assert.match(voucherlistNotes, /totalAmount/);
	assert.match(voucherlistNotes, /openAmount/);
});

test('spec does not route voucherlist summaries through stale fields', () => {
	const reportingContract = JSON.stringify({
		financeReportingSemantics: lexwareSpec.info.financeReportingSemantics,
		calculateInvoicedRevenue: lexwareSpec.workflows.calculateInvoicedRevenue,
		calculatePaidRevenue: lexwareSpec.workflows.calculatePaidRevenue,
		voucherlist: lexwareSpec.paths['/v1/voucherlist']?.get,
	});
	const staleGrossField = `total${'Gross'}Amount`;
	const staleNetField = `total${'Net'}Amount`;

	assert.equal(reportingContract.includes(staleGrossField), false);
	assert.equal(reportingContract.includes(staleNetField), false);
});

test('search catalog carries finance-safety invariants without silent zero-defaults', () => {
	const catalogText = JSON.stringify({
		financeReportingSemantics: lexwareSpec.info.financeReportingSemantics,
		workflows: lexwareSpec.workflows,
		voucherlist: lexwareSpec.paths['/v1/voucherlist']?.get,
	});
	const staleGrossField = `total${'Gross'}Amount`;
	const staleNetField = `total${'Net'}Amount`;

	assert.match(catalogText, /financeReportingSemantics|gross invoiced\/accrual revenue/);
	assert.match(catalogText, /Do not default missing financial amount fields to zero|Do not default missing amount fields to zero/);
	assert.match(catalogText, /totalAmount/);
	assert.match(catalogText, /openAmount/);
	assert.match(catalogText, /VAT-aware net/);
	assert.match(catalogText, /Never estimate net revenue|Never use a blanket gross \/ 1\.19/);

	assert.equal(catalogText.includes(`${staleGrossField} ?? ${0}`), false);
	assert.equal(catalogText.includes(`${staleNetField} ?? ${0}`), false);
	assert.doesNotMatch(catalogText, /Number\([^)]*\?\? 0[^)]*\)/);
	assert.doesNotMatch(catalogText, /(?:totalAmount|openAmount)[^\n]*\?\? 0/);
});

test('strict fixture aggregate catches schema drift', () => {
	assert.equal(lexware.sumMoney([{ totalAmount: 100, openAmount: 25 }], 'totalAmount'), 10000);
	assert.equal(lexware.requireMoney({ totalAmount: '100.10', openAmount: 25 }, 'openAmount'), 2500);
	assert.throws(
		() => lexware.sumMoney([{ openAmount: 25 }], 'totalAmount'),
		/Missing expected field totalAmount/,
	);
	assert.throws(
		() => lexware.requireMoney({ totalAmount: null }, 'totalAmount'),
		/Expected numeric totalAmount/,
	);
});
