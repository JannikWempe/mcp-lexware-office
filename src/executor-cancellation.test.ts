import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor, type SandboxHostFunction } from './executor.js';

const requestCode = `async () => { return await lexware.request({ path: '/v1/countries' }); }`;

// Host function that only settles when its context signal aborts, like a fetch would.
const abortAwareHost = (seen: AbortSignal[]): SandboxHostFunction => (_payload, { signal }) => {
	seen.push(signal);
	return new Promise<string>((_resolve, reject) => {
		signal.addEventListener('abort', () => reject(new Error('host aborted')), { once: true });
	});
};

test('already-aborted external signal ends execution without host calls', async () => {
	const controller = new AbortController();
	controller.abort();
	let hostCalls = 0;

	const execution = await new QuickJsExecutor().execute(requestCode, { spec: {} }, {
		signal: controller.signal,
		hostFunctions: {
			__lexwareRequestJson: async () => {
				hostCalls += 1;
				return '{}';
			},
		},
	});

	assert.match(execution.error ?? '', /Execution cancelled by client/);
	assert.equal(hostCalls, 0);
});

test('external abort mid-run ends execution promptly and aborts the host signal', async () => {
	const controller = new AbortController();
	const seen: AbortSignal[] = [];
	const host = abortAwareHost(seen);
	const startedAt = Date.now();

	const execution = await new QuickJsExecutor().execute(requestCode, { spec: {} }, {
		timeoutMs: 5_000,
		signal: controller.signal,
		hostFunctions: {
			// Abort once the host call is in flight; a wall-clock timer races QuickJS init on cold runners.
			__lexwareRequestJson: (payload, context) => {
				const pending = host(payload, context);
				setTimeout(() => controller.abort(), 20);
				return pending;
			},
		},
	});

	assert.match(execution.error ?? '', /Execution cancelled by client/);
	assert.doesNotMatch(execution.error ?? '', /timed out/);
	assert.ok(Date.now() - startedAt < 1_000, 'cancellation must not wait for the executor timeout');
	assert.equal(seen.length, 1);
	assert.equal(seen[0].aborted, true);
});

test('executor timeout aborts the host signal so teardown does not wait for in-flight calls', async () => {
	const seen: AbortSignal[] = [];
	const startedAt = Date.now();

	const execution = await new QuickJsExecutor().execute(requestCode, { spec: {} }, {
		timeoutMs: 50,
		hostFunctions: { __lexwareRequestJson: abortAwareHost(seen) },
	});

	assert.match(execution.error ?? '', /timed out/);
	assert.equal(seen[0]?.aborted, true);
	assert.ok(Date.now() - startedAt < 1_000);
});

test('host signal is aborted once execution finishes, cancelling fire-and-forget calls', async () => {
	const seen: AbortSignal[] = [];

	const execution = await new QuickJsExecutor().execute(
		`async () => { globalThis.__lexwareRequestJson(JSON.stringify({})); return 'done'; }`,
		{ spec: {} },
		{ hostFunctions: { __lexwareRequestJson: abortAwareHost(seen) } },
	);

	assert.equal(execution.error, undefined);
	assert.equal(execution.result, 'done');
	assert.equal(seen[0]?.aborted, true);
});

test('guest retries after teardown rejection do not reach the host function', async () => {
	let hostCalls = 0;
	const execution = await new QuickJsExecutor().execute(
		`async () => {
			try {
				return await lexware.request({ path: '/v1/countries' });
			} catch {
				return await lexware.request({ path: '/v1/countries' });
			}
		}`,
		{ spec: {} },
		{
			timeoutMs: 50,
			hostFunctions: {
				__lexwareRequestJson: (_payload, { signal }) => {
					hostCalls += 1;
					return new Promise<string>((_resolve, reject) => {
						signal.addEventListener('abort', () => reject(new Error('host aborted')), { once: true });
					});
				},
			},
		},
	);

	assert.match(execution.error ?? '', /timed out/);
	assert.equal(hostCalls, 1);
});

test('abort right after execute() starts prevents any guest execution', async () => {
	const executor = new QuickJsExecutor();
	await executor.execute(`async () => 1`, {}); // warm up getQuickJS so its promise is cached
	const controller = new AbortController();
	const startedAt = Date.now();

	const pending = executor.execute(`async () => { console.log('ran'); while (true) {} }`, {}, {
		timeoutMs: 2_000,
		signal: controller.signal,
	});
	controller.abort();
	const execution = await pending;

	assert.match(execution.error ?? '', /Execution cancelled by client/);
	assert.deepEqual(execution.logs, []);
	assert.ok(Date.now() - startedAt < 1_000, 'guest code must not run until the executor timeout');
});
