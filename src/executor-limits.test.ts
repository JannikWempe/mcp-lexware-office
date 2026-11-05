import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';

const MB = 1024 * 1024;

test('typed arrays and strings hit the memory limit as a catchable out of memory', async () => {
	for (const allocate of [`new Uint8Array(${MB})`, `'x'.repeat(${MB})`]) {
		const execution = await new QuickJsExecutor().execute(
			`async () => {
				const chunks = [];
				try {
					while (chunks.length < 1000) chunks.push(${allocate});
				} catch (error) {
					return { error: String(error), allocatedMb: chunks.length };
				}
				return { allocatedMb: chunks.length };
			}`,
			{},
			{ memoryLimitBytes: 8 * MB, timeoutMs: 10_000 },
		);

		assert.equal(execution.error, undefined, allocate);
		const result = execution.result as { error?: string; allocatedMb: number };
		assert.match(result.error ?? '', /out of memory/, allocate);
		// The heap may grow by the limit beyond the 16 MB the WASM build starts with.
		assert.ok(result.allocatedMb <= 8 + 16, `${allocate}: allocated ${result.allocatedMb} MB`);
	}
});

test('an uncaught out of memory fails the execution and the next execution runs normally', async () => {
	const executor = new QuickJsExecutor();
	const failed = await executor.execute(`async () => { const chunks = []; while (true) chunks.push(new Uint8Array(${MB})); }`, {}, { memoryLimitBytes: 8 * MB, timeoutMs: 10_000 });
	assert.match(failed.error ?? '', /out of memory/);

	const next = await executor.execute(`async () => new Uint8Array(${4 * MB}).length`, {}, { memoryLimitBytes: 8 * MB });
	assert.deepEqual(next, { result: 4 * MB, logs: [] });
});

test('an out of memory after an await is reported like one before it', async () => {
	const executor = new QuickJsExecutor();
	const hostFunctions = { tick: async () => '' };
	const options = { memoryLimitBytes: 8 * MB, timeoutMs: 10_000, hostFunctions };

	const caught = await executor.execute(`async () => { await tick(''); const chunks = []; try { while (true) chunks.push(new Uint8Array(${MB})); } catch (error) { return String(error); } }`, {}, options);
	assert.deepEqual(caught, { result: 'InternalError: out of memory', logs: [] });

	const uncaught = await executor.execute(`async () => { await tick(''); const chunks = []; while (true) chunks.push(new Uint8Array(${MB})); }`, {}, options);
	assert.match(uncaught.error ?? '', /^InternalError: out of memory/);
});

test('a host result that does not fit into a full sandbox heap fails with an out-of-memory error', async () => {
	const execution = await new QuickJsExecutor().execute(
		`async () => { const chunks = []; try { while (true) chunks.push(new Uint8Array(65536)); } catch {} return (await big('')).length; }`,
		{},
		{ memoryLimitBytes: 8 * MB, timeoutMs: 10_000, hostFunctions: { big: async () => 'x'.repeat(4 * MB) } },
	);

	assert.match(execution.error ?? '', /Sandbox out of memory: a value passed into the sandbox/);
});

test('an invalid memory limit is rejected before running guest code', async () => {
	for (const memoryLimitBytes of [-1, Number.NaN, 1.5]) {
		await assert.rejects(() => new QuickJsExecutor().execute(`async () => 1`, {}, { memoryLimitBytes }), /Invalid memoryLimitBytes/, String(memoryLimitBytes));
	}
});

test('synchronous work before the first await counts against the timeout', async () => {
	const startedAt = Date.now();
	const execution = await new QuickJsExecutor().execute(
		`async () => {
			const until = Date.now() + 300;
			while (Date.now() < until) {}
			return await slow('');
		}`,
		{},
		{
			timeoutMs: 400,
			hostFunctions: {
				slow: (_payload, { signal }) => new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve('late'), 2_000);
					signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
				}),
			},
		},
	);

	assert.match(execution.error ?? '', /timed out after 400ms/);
	// Without one shared deadline, the wall-clock timer started after the 300 ms busy loop.
	assert.ok(Date.now() - startedAt < 650, `took ${Date.now() - startedAt} ms`);
});
