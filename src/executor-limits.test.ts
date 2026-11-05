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

test('a trailing line comment or semicolon after the function is accepted', async () => {
	const executor = new QuickJsExecutor();
	for (const code of ['async () => {\n  return 1\n} // main', 'async () => 1;', 'async () => 1 ;;\n\n', 'async () => 1 // done;']) {
		assert.deepEqual(await executor.execute(code, {}), { result: 1, logs: [] }, JSON.stringify(code));
	}
});
