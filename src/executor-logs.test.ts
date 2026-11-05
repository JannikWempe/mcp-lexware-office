import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';

test('logs up to the cap are returned as is', async () => {
	const { error, logs = [] } = await new QuickJsExecutor().execute(`async () => { for (let i = 0; i < 25; i++) console.log('line', i); return 1; }`, {});
	assert.equal(error, undefined);
	assert.equal(logs.length, 25);
	assert.equal(logs[24], 'line 24');
	assert.ok(logs.every((entry) => !/dropped/.test(entry)));
});

test('entries beyond the cap are counted in one trailing marker', async () => {
	const { error, logs = [] } = await new QuickJsExecutor().execute(`async () => { for (let i = 0; i < 30; i++) console.log('line', i); return 1; }`, {});
	assert.equal(error, undefined);
	assert.equal(logs.length, 26);
	assert.equal(logs[24], 'line 24');
	assert.match(logs[25], /^\.\.\.\[5 more log entries dropped/);
});

test('a custom maxLogEntries is honored and a single drop is singular', async () => {
	const { error, logs = [] } = await new QuickJsExecutor().execute(`async () => { console.log('a'); console.log('b'); console.log('c'); }`, {}, { maxLogEntries: 2 });
	assert.equal(error, undefined);
	assert.deepEqual(logs.slice(0, 2), ['a', 'b']);
	assert.match(logs[2], /^\.\.\.\[1 more log entry dropped/);
	assert.equal(logs.length, 3);
});

test('the marker is kept when the script fails', async () => {
	const { error, logs = [] } = await new QuickJsExecutor().execute(`async () => { console.log('a'); console.log('b'); throw new Error('boom'); }`, {}, { maxLogEntries: 1 });
	assert.match(error ?? '', /boom/);
	assert.equal(logs.length, 2);
	assert.match(logs[1], /1 more log entry dropped/);
});

test('long entries are clipped to maxLogChars', async () => {
	const { error, logs = [] } = await new QuickJsExecutor().execute(`async () => { console.log('x'.repeat(50)); }`, {}, { maxLogChars: 10 });
	assert.equal(error, undefined);
	assert.equal(logs[0], 'x'.repeat(10) + '...[truncated]');
});

test('console.info, warn and error share the cap', async () => {
	const { error, logs = [] } = await new QuickJsExecutor().execute(`async () => { console.info('i'); console.warn('w'); console.error('e'); }`, {}, { maxLogEntries: 2 });
	assert.equal(error, undefined);
	assert.deepEqual(logs.slice(0, 2), ['i', 'w']);
	assert.match(logs[2], /1 more log entry dropped/);
});
