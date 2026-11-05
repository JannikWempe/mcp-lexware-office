import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';

for (const [code, message] of [
	['async () => { throw undefined; }', /threw undefined/],
	["async () => { throw ''; }", /threw an empty string/],
	['async () => { await Promise.reject(); }', /threw undefined/],
	["() => { throw ''; }", /threw an empty string/],
] as const) {
	test(`${code} fails with a non-empty error`, async () => {
		const execution = await new QuickJsExecutor().execute(code, {});
		assert.equal(typeof execution.error, 'string', code);
		assert.ok(execution.error!.length > 0, code);
		assert.match(execution.error!, message, code);
		assert.equal(execution.result, undefined, code);
	});
}

test('thrown non-empty primitives keep their exact error text', async () => {
	for (const [code, error] of [
		["async () => { throw 'boom'; }", 'boom'],
		['async () => { throw null; }', 'null'],
		['async () => { throw 0; }', '0'],
		["async () => { throw Symbol('s'); }", 'Symbol(s)'],
	]) {
		assert.equal((await new QuickJsExecutor().execute(code, {})).error, error, code);
	}
});

test('a thrown function fails with a non-empty error', async () => {
	const execution = await new QuickJsExecutor().execute('async () => { throw () => 1; }', {});
	assert.equal(typeof execution.error, 'string');
	assert.ok(execution.error!.length > 0);
	assert.equal(execution.result, undefined);
});
