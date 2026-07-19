/**
 * Regression tests for pending async host calls during VM disposal.
 *
 * Before the fix, any of these scenarios could abort the Node process with:
 *   Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c, JS_FreeRuntime)
 *
 * After the fix, all scenarios must return a structured error and leave the
 * process alive.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';

// Helper: run sandbox code with a host function that resolves after `delayMs`.
function executeWithSlowHost(code: string, delayMs: number, timeoutMs = 500): Promise<import('./executor.js').CodeExecutionResult> {
	return new QuickJsExecutor().execute(
		code,
		{ spec: {} },
		{
			timeoutMs,
			hostFunctions: {
				__lexwareRequestJson: (_payload) =>
					new Promise<string>((resolve) =>
						setTimeout(() => resolve(JSON.stringify({ ok: true, data: {} })), delayMs),
					),
			},
		},
	);
}

test('unawaited host call: sandbox returns immediately without awaiting the host promise', async () => {
	// The sandbox fires a host call but does NOT await it, then returns.
	// The host call resolves after the sandbox has already exited.
	// The executor must not crash the process and must complete without error.
	const execution = await executeWithSlowHost(
		// Fire and forget – no await
		`async () => { globalThis.__lexwareRequestJson(JSON.stringify({})); return 'done'; }`,
		50, // host resolves after 50 ms
		200, // executor timeout well above host delay
	);

	// No crash means the test passes; we also assert a clean result.
	assert.equal(execution.error, undefined);
	assert.equal(execution.result, 'done');
});

test('host call resolves after executor timeout: returns structured timeout error, process stays alive', async () => {
	// The sandbox awaits a host call that takes longer than the executor timeout.
	// This was the primary crash scenario before the fix.
	const execution = await executeWithSlowHost(
		`async () => { return await lexware.request({ path: '/v1/countries' }); }`,
		300, // host resolves after 300 ms
		100, // executor times out at 100 ms — before host resolves
	);

	assert.ok(execution.error, 'expected a timeout error, got none');
	assert.match(execution.error, /timed out/i);
	// Process is still alive if we reach this assertion.
});

test('multiple slow host calls hit timeout: returns structured error, process stays alive', async () => {
	// The sandbox starts several concurrent host calls; all are slower than the timeout.
	const execution = await executeWithSlowHost(
		`async () => {
			const [a, b, c] = await Promise.all([
				lexware.request({ path: '/v1/countries' }),
				lexware.request({ path: '/v1/countries' }),
				lexware.request({ path: '/v1/countries' }),
			]);
			return [a, b, c];
		}`,
		300, // each host call resolves after 300 ms
		100, // executor times out first
	);

	assert.ok(execution.error, 'expected a timeout error, got none');
	assert.match(execution.error, /timed out/i);
});

test('host call that rejects after timeout: returns structured error, process stays alive', async () => {
	// The host function rejects (simulating a network error) after the executor timeout.
	const execution = await new QuickJsExecutor().execute(
		`async () => { return await lexware.request({ path: '/v1/countries' }); }`,
		{ spec: {} },
		{
			timeoutMs: 100,
			hostFunctions: {
				__lexwareRequestJson: (_payload) =>
					new Promise<string>((_resolve, reject) =>
						setTimeout(() => reject(new Error('simulated network error')), 300),
					),
			},
		},
	);

	assert.ok(execution.error, 'expected a timeout error, got none');
	assert.match(execution.error, /timed out/i);
});

test('never-settling guest promise: returns timeout error and does not hang teardown', async () => {
	// A guest promise that never resolves or rejects is the primary scenario for an
	// indefinite teardown hang.  Before the fix, the finally block would await the
	// sandboxNativePromise without a time bound and block forever.
	//
	// We enforce a wall-clock deadline on the whole test to guarantee the executor
	// returns within a reasonable time.
	const WALL_CLOCK_LIMIT_MS = 3_000; // generous; fix keeps teardown to ~500 ms cap

	const executorPromise = new QuickJsExecutor().execute(
		// Guest code awaits a promise that never settles.
		`async () => await new Promise(() => {})`,
		{ spec: {} },
		{ timeoutMs: 200 },
	);

	const timeoutSentinel = new Promise<'wall-clock-exceeded'>((resolve) =>
		setTimeout(() => resolve('wall-clock-exceeded'), WALL_CLOCK_LIMIT_MS),
	);

	const winner = await Promise.race([executorPromise, timeoutSentinel]);

	assert.notEqual(winner, 'wall-clock-exceeded', 'executor hung: teardown did not complete within wall-clock limit');

	// At this point winner is a CodeExecutionResult.
	const result = winner as import('./executor.js').CodeExecutionResult;
	assert.ok(result.error, 'expected a timeout error, got none');
	assert.match(result.error, /timed out/i);
});
