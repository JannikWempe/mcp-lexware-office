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

const readme = readFileSync(join(__dirname, '../README.md'), 'utf8');

test('docs explain the contentPath upload allowlist and its migration', () => {
	for (const doc of [guide, readme]) {
		assert.match(doc, /LEXWARE_OFFICE_UPLOAD_DIRS/);
		assert.match(doc, /-e LEXWARE_OFFICE_UPLOAD_DIRS=\/data/, 'Docker example must set the upload dir to the container path');
	}
	assert.match(guide, /^## Migrating: `contentPath` requires `LEXWARE_OFFICE_UPLOAD_DIRS`$/m);
	assert.match(readme, /docs\/guide\.md#migrating-contentpath-requires-lexware_office_upload_dirs/);
});

test('guide documents the execute requests audit log and cancellation', () => {
	assert.match(guide, /`requests` is an audit log/);
	assert.match(guide, /Execution cancelled by client/);
	assert.match(guide, /429/);
	assert.match(guide, /"outcome": "unknown"/);
});

// Release Please rewrites the first number on lines marked `x-release-please-major` (inline or inside a
// start-major/end block) to the new major, so marked lines pin the current release. Unmarked pins are history.
test('install docs pin the package.json major only on release-please-marked lines', () => {
	const major = Number(JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')).version.split('.')[0]);
	let markedPins = 0;
	for (const [name, doc] of [['README.md', readme], ['docs/guide.md', guide]]) {
		let inBlock = false;
		for (const line of doc.split('\n')) {
			const marked = inBlock || /x-release-please-major/.test(line);
			if (/x-release-please-start-major/.test(line)) {
				inBlock = true;
			} else if (/x-release-please-end/.test(line)) {
				inBlock = false;
			}
			for (const [, pinned] of line.matchAll(/#semver:\^(\d+)/g)) {
				if (marked) {
					markedPins += 1;
					assert.equal(Number(pinned), major, `${name}: marked pin ^${pinned} must match package.json major ${major}; Release Please bumps it`);
				} else {
					assert.ok(Number(pinned) < major, `${name}: unmarked pin ^${pinned} goes stale on the next major; mark it with x-release-please-major or reword it as history: ${line}`);
				}
			}
		}
	}
	assert.equal(markedPins, 4, 'expected the README (3) and guide (1) install pins to be marked');
});
