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

test('a trailing semicolon or comment after the function is accepted', async () => {
	const executor = new QuickJsExecutor();
	for (const code of [
		'async () => {\n  return 1\n} // main',
		'async () => 1;',
		'async () => 1 ;;\n\n',
		'async () => 1; // main',
		'async () => {\n  return 1\n}; // main',
		'async () => 1;\n/* x */',
	]) {
		assert.deepEqual(await executor.execute(code, {}), { result: 1, logs: [] }, JSON.stringify(code));
	}
});

test('error positions are relative to the submitted code, not the prelude', async () => {
	const executor = new QuickJsExecutor();
	const options = { filename: 'user.js', prelude: Array.from({ length: 50 }, (_, i) => `const p${i} = ${i};`).join('\n') };

	const thrown = await executor.execute(`async () => {\n  const a = p1;\n  throw new Error('boom');\n}`, {}, options);
	assert.match(thrown.error ?? '', /^Error: boom\n {4}at .*\(user\.js:3:\d+\)/);

	const syntax = await executor.execute(`async () => {\n  const a = ;\n}`, {}, options);
	assert.match(syntax.error ?? '', /^SyntaxError: .*\n {4}at user\.js:2:\d+/);
});

test('code that is no function is rejected', async () => {
	const execution = await new QuickJsExecutor().execute(`({ ok: true })`, {});

	assert.match(execution.error ?? '', /Code must evaluate to a function/);
});

test('a function expression or a plain function is accepted', async () => {
	const executor = new QuickJsExecutor();
	for (const code of ['async function main() { return 1 }', 'async function () { return 1 }', '() => 1', 'function () { return 1 }']) {
		assert.deepEqual(await executor.execute(code, {}), { result: 1, logs: [] }, code);
	}
});
