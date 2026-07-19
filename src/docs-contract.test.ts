import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const guide = readFileSync(join(__dirname, '../docs/guide.md'), 'utf8');

// Split into lines so we can check field names only in voucherlist contexts.
// A "voucherlist context" is any code block that references /v1/voucherlist.
const voucherlistCodeBlocks = (() => {
	const blocks: string[] = [];
	const fenceRe = /```[\s\S]*?```/g;
	let match: RegExpExecArray | null;
	while ((match = fenceRe.exec(guide)) !== null) {
		if (match[0].includes('/v1/voucherlist') || match[0].includes('voucherlist')) {
			blocks.push(match[0]);
		}
	}
	return blocks.join('\n');
})();

test('guide voucherlist examples do not reference stale totalGrossAmount field', () => {
	assert.ok(voucherlistCodeBlocks.length > 0, 'Expected at least one voucherlist code block in docs');
	assert.equal(
		voucherlistCodeBlocks.includes('totalGrossAmount'),
		false,
		'guide.md voucherlist example uses stale field totalGrossAmount; use totalAmount instead',
	);
});

test('guide voucherlist examples do not reference stale totalNetAmount field', () => {
	assert.equal(
		voucherlistCodeBlocks.includes('totalNetAmount'),
		false,
		'guide.md voucherlist example uses stale field totalNetAmount; use totalAmount instead',
	);
});

test('guide voucherlist examples use totalAmount', () => {
	assert.match(
		voucherlistCodeBlocks,
		/totalAmount/,
		'guide.md voucherlist example should reference totalAmount',
	);
});
