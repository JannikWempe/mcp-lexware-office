/**
 * Regression tests for #51: deep recursion inside QuickJS's WASM can overflow the host (V8) stack
 * before QuickJS's own stack check fires. The host RangeError unwinds WASM frames mid-operation,
 * and disposing that runtime used to abort the Node process with:
 *   Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c, JS_FreeRuntime)
 *
 * Every scenario must return a structured error and leave the process (and later executions) alive.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';

const deep = (depth: number) => `let v = 0; for (let i = 0; i < ${depth}; i++) v = { a: v };`;

// A follow-up execution proves the process and the executor still work.
const assertStillWorks = async (executor: QuickJsExecutor) => {
	assert.deepEqual(await executor.execute(`async () => ({ ok: true })`, {}), { result: { ok: true }, logs: [] });
};

test('a 10,000-deep result returns an error instead of aborting the process', async () => {
	const executor = new QuickJsExecutor();

	const execution = await executor.execute(`async () => { ${deep(10_000)} return v; }`, {});

	assert.equal(execution.result, undefined);
	assert.match(execution.error ?? '', /nested too deeply/);
	await assertStillWorks(executor);
});

test('a deep result after an awaited host call returns an error', async () => {
	const executor = new QuickJsExecutor();

	const execution = await executor.execute(`async () => { await hostCall('{}'); ${deep(10_000)} return v; }`, {}, {
		hostFunctions: { hostCall: async () => '{}' },
	});

	assert.match(execution.error ?? '', /nested too deeply/);
	await assertStillWorks(executor);
});

test('guest JSON.stringify of a deep value in a continuation does not abort the process', async () => {
	const executor = new QuickJsExecutor();

	const execution = await executor.execute(
		`async () => { ${deep(100_000)} await hostCall('{}'); try { JSON.stringify(v); } catch {} return 'survived'; }`,
		{},
		{ hostFunctions: { hostCall: async () => '{}' } },
	);

	// Either QuickJS catches the overflow itself or the run fails cleanly; both keep the process alive.
	if (execution.error !== undefined) assert.match(execution.error, /nested too deeply/);
	else assert.equal(execution.result, 'survived');
	await assertStillWorks(executor);
});

test('logging a deep value does not abort the process', async () => {
	const executor = new QuickJsExecutor();

	const execution = await executor.execute(`async () => { ${deep(100_000)} console.log(v); return 'done'; }`, {});

	if (execution.error !== undefined) assert.match(execution.error, /nested too deeply/);
	else assert.equal(execution.result, 'done');
	await assertStillWorks(executor);
});

test('runaway guest recursion is a catchable QuickJS stack overflow', async () => {
	const executor = new QuickJsExecutor();

	const execution = await executor.execute(
		`async () => { function r() { return r() + 1; } try { r(); } catch (error) { return String(error); } }`,
		{},
	);

	assert.deepEqual(execution, { result: 'InternalError: stack overflow', logs: [] });
	await assertStillWorks(executor);
});

test('moderately deep results still round-trip', async () => {
	const execution = await new QuickJsExecutor().execute(
		`async () => { ${deep(500)} let depth = 0; for (let n = v; typeof n === 'object'; n = n.a) depth++; return { depth, v }; }`,
		{},
	);

	assert.equal(execution.error, undefined);
	assert.equal((execution.result as { depth: number }).depth, 500);
});
