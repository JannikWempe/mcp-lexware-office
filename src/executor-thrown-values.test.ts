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
		assert.equal(typeof execution.error, 'string');
		assert.ok(execution.error!.length > 0);
		assert.match(execution.error!, message);
		assert.equal(execution.result, undefined);
	});
}

test('thrown non-empty primitives keep their exact error text', async () => {
	for (const [code, error] of [
		["async () => { throw 'boom'; }", 'boom'],
		['async () => { throw null; }', 'null'],
		['async () => { throw 0; }', '0'],
	]) {
		assert.equal((await new QuickJsExecutor().execute(code, {})).error, error);
	}
});

test('console.log prints undefined as undefined', async () => {
	const execution = await new QuickJsExecutor().execute(`async () => { console.log(undefined, 'x'); console.log(undefined); return 1; }`, {});
	assert.deepEqual(execution.logs, ['undefined x', 'undefined']);
});
