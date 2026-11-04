import assert from 'node:assert/strict';
import test from 'node:test';

import { truncateJson } from './truncate.js';

const prettyLength = (value: unknown) => JSON.stringify(value, null, 2).length;

test('values within the limit are returned as is', () => {
	const value = { rows: [1, 2, 3], name: 'small' };
	assert.equal(truncateJson(value, { maxChars: 1000 }), value);
});

test('arrays keep whole leading items and report the omitted count', () => {
	const rows = Array.from({ length: 500 }, (_, id) => ({ id, label: `row ${id}` }));

	const result = truncateJson(rows, { maxChars: 2000 }) as { truncated: { originalChars: number; note: string }; value: unknown[] };

	assert.ok(prettyLength(result) <= 2000);
	assert.equal(result.truncated.originalChars, prettyLength(rows));
	assert.match(result.truncated.note, /Recovery:/);
	const kept = result.value.slice(0, -1);
	assert.ok(kept.length > 0);
	assert.deepEqual(kept, rows.slice(0, kept.length));
	assert.equal(result.value.at(-1), `[truncated: ${500 - kept.length} more items]`);
});

test('objects shrink their largest values first', () => {
	const value = { ok: true, small: 'keep me', big: 'x'.repeat(5000), nested: { huge: Array.from({ length: 1000 }, (_, i) => i), tiny: 1 } };

	const result = truncateJson(value, { maxChars: 3000 }) as Record<string, any>;

	assert.ok(prettyLength(result) <= 3000);
	assert.equal(result.ok, true);
	assert.equal(result.small, 'keep me');
	assert.equal(result.nested.tiny, 1);
	assert.match(result.nested.huge.at(-1), /^\[truncated: \d+ more items\]$/);
	assert.match(result.big, /^x+…\[truncated: \d+ chars\]$/);
	assert.ok(result.truncated.originalChars > 3000);
});

test('long strings are clipped with a marker, also when escaping inflates them', () => {
	for (const char of ['a', '"', '\n']) {
		const result = truncateJson(char.repeat(10_000), { maxChars: 500 }) as { value: string };
		assert.ok(prettyLength(result) <= 500);
		assert.match(result.value, /…\[truncated: \d+ chars\]$/);
	}
});

test('objects with too many keys drop trailing keys', () => {
	const value = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`key${i}`, i]));

	const result = truncateJson(value, { maxChars: 1000 }) as Record<string, unknown>;

	assert.ok(prettyLength(result) <= 1000);
	assert.equal(result.key0, 0);
	assert.match(String(result['[truncated]']), /^\[truncated: \d+ more keys: key\d+, key\d+, .*…/);
});

test('a single oversized array item is shrunk rather than dropped', () => {
	const result = truncateJson([{ text: 'y'.repeat(10_000) }], { maxChars: 1000 }) as { value: Array<{ text: string }> };

	assert.ok(prettyLength(result) <= 1000);
	assert.equal(result.value.length, 1);
	assert.match(result.value[0].text, /^y+…\[truncated: \d+ chars\]$/);
});

test('every truncated result parses as JSON within the limit', () => {
	const deep = (level: number): unknown => level === 0 ? 'z'.repeat(300) : { a: deep(level - 1), b: [deep(level - 1), deep(level - 1)] };
	const values = [deep(6), Array.from({ length: 3000 }, (_, i) => [i, `${i}`]), { list: Array.from({ length: 200 }, () => ({ s: '"\\'.repeat(50) })) }];
	for (const value of values) {
		for (const maxChars of [800, 1500, 24_000]) {
			const result = truncateJson(value, { maxChars });
			const text = JSON.stringify(result, null, 2);
			assert.ok(text.length <= maxChars, `${text.length} > ${maxChars}`);
			assert.deepEqual(JSON.parse(text), result);
		}
	}
});

test('kept top-level keys are never shrunk while they fit', () => {
	const requests = Array.from({ length: 50 }, (_, i) => ({ method: 'POST', path: `/v1/contacts/${i}`, status: 201, ok: true, write: true, sent: true, durationMs: 10 }));
	const value = { ok: true, result: 'y'.repeat(100_000), logs: ['x'.repeat(100_000)], requestCount: 50, requests };

	const result = truncateJson(value, { maxChars: 24_000, keep: ['ok', 'requestCount', 'requests'] }) as Record<string, any>;

	assert.ok(prettyLength(result) <= 24_000);
	assert.deepEqual(Object.keys(result), ['ok', 'result', 'logs', 'requestCount', 'requests', 'truncated']);
	assert.deepEqual(result.requests, requests);
	assert.match(result.result, /…\[truncated: \d+ chars\]$/);
});

test('kept keys that do not fit on their own are shrunk too', () => {
	const value = { requests: Array.from({ length: 1000 }, (_, i) => ({ path: `/v1/contacts/${i}` })), result: 1 };

	const result = truncateJson(value, { maxChars: 2000, keep: ['requests'] }) as Record<string, any>;

	assert.ok(prettyLength(result) <= 2000);
	assert.match(result.requests.at(-1), /^\[truncated: \d+ more items\]$/);
});

test('deeply nested values are shrunk quickly', () => {
	let value: unknown = 0;
	for (let i = 0; i < 2000; i++) value = { a: value };

	const startedAt = Date.now();
	const result = truncateJson(value, { maxChars: 2000 });

	assert.ok(Date.now() - startedAt < 1000);
	assert.ok(prettyLength(result) <= 2000);
});

test('clipping does not split surrogate pairs', () => {
	const result = truncateJson('😀'.repeat(10_000), { maxChars: 1004 }) as { value: string };

	assert.doesNotMatch(result.value, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
