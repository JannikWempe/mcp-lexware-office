import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';

test('capabilities are bound to locals of the same name, copied as JSON', async () => {
	const execution = await new QuickJsExecutor().execute(
		`async () => ({ spec, limits, onGlobal: typeof globalThis.spec })`,
		{ spec: { title: 'catalog' }, limits: [1, 2] },
	);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, { spec: { title: 'catalog' }, limits: [1, 2], onGlobal: 'undefined' });
});

test('capability names that are not identifiers are rejected before running guest code', async () => {
	await assert.rejects(
		() => new QuickJsExecutor().execute(`async () => 1`, { 'a } = {}; globalThis.x = 1; const { b': 1 }),
		/Invalid capability name/,
	);
});

test('prelude declarations are visible to user code but not added to globalThis', async () => {
	const execution = await new QuickJsExecutor().execute(
		`async () => ({ answer: helper.answer(), viaHost: await helper.echo('hi'), onGlobal: typeof globalThis.helper })`,
		{},
		{
			prelude: `const helper = Object.freeze({ answer: () => 42, echo: (text) => hostCall(text) });`,
			hostFunctions: { hostCall: async (payload) => `echo:${payload}` },
		},
	);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, { answer: 42, viaHost: 'echo:hi', onGlobal: 'undefined' });
});

test('without a prelude only capabilities, host functions, and console are exposed', async () => {
	const execution = await new QuickJsExecutor().execute(
		`async () => ({ helper: typeof helper, hostCall: typeof hostCall, console: typeof console.log })`,
		{},
		{ hostFunctions: { hostCall: async () => '' } },
	);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, { helper: 'undefined', hostCall: 'function', console: 'function' });
});

test('prelude errors are reported like guest errors', async () => {
	const execution = await new QuickJsExecutor().execute(`async () => 1`, {}, { prelude: `throw new Error('prelude failed');` });

	assert.match(execution.error ?? '', /prelude failed/);
});
