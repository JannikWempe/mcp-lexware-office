import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_STATE_LIMITS, SandboxState } from './sandbox-state.js';

test('stores JSON text per key and lists, replaces and deletes keys', () => {
	const store = new SandboxState();
	assert.equal(store.get('missing'), undefined);
	store.set('a', '{"n":1}');
	store.set('b', '[1,2]');
	store.set('a', '{"n":2}');
	assert.equal(store.get('a'), '{"n":2}');
	assert.deepEqual(store.keys(), ['a', 'b']);
	store.delete('a');
	store.delete('never-set');
	assert.deepEqual(store.keys(), ['b']);
});

test('defaults: 1 MB per value, 10 MB in total, 1 h idle TTL', () => {
	assert.equal(DEFAULT_STATE_LIMITS.maxValueBytes, 1024 * 1024);
	assert.equal(DEFAULT_STATE_LIMITS.maxTotalBytes, 10 * 1024 * 1024);
	assert.equal(DEFAULT_STATE_LIMITS.idleTtlMs, 60 * 60 * 1000);
});

test('rejects a value above the per-value limit, measured in UTF-8 bytes, and keeps the old value', () => {
	const store = new SandboxState({ limits: { maxValueBytes: 10 } });
	store.set('k', '"ok"');
	assert.throws(() => store.set('k', '"ääääää"'), /the value for "k" is 14 B serialized; the limit is 10 B per value/);
	assert.equal(store.get('k'), '"ok"');
});

test('rejects a set that would exceed the total size, counting replaced values only once', () => {
	const store = new SandboxState({ limits: { maxTotalBytes: 20 } });
	store.set('a', '"1234567"'); // 1 + 9 bytes
	store.set('b', '"1234567"');
	assert.throws(() => store.set('c', '1'), /would grow the state to 22 B; the limit is 20 B in total/);
	store.set('a', '"12345"'); // replaces 10 with 8 bytes
	store.set('c', '1');
	store.delete('a');
	store.set('d', '"1234"');
	assert.deepEqual(store.keys(), ['b', 'c', 'd']);
});

test('rejects new keys beyond maxKeys but still replaces existing ones', () => {
	const store = new SandboxState({ limits: { maxKeys: 2 } });
	store.set('a', '1');
	store.set('b', '2');
	assert.throws(() => store.set('c', '3'), /already holds 2 keys/);
	store.set('b', '22');
	assert.equal(store.get('b'), '22');
});

test('rejects empty, overlong and non-string keys', () => {
	const store = new SandboxState({ limits: { maxKeyLength: 3 } });
	assert.throws(() => store.set('', '1'), /state\.set expects a key of 1 to 3 characters, got 0 characters/);
	assert.throws(() => store.get('abcd'), /state\.get expects a key of 1 to 3 characters, got 4 characters/);
	assert.throws(() => store.delete(undefined as unknown as string), /state\.delete expects a key .*got undefined/);
	assert.throws(() => store.set('a', undefined as unknown as string), /JSON-serializable/);
});

test('entries expire after the idle TTL; reads and writes reset it, and expiry frees their size', () => {
	let now = 0;
	const store = new SandboxState({ now: () => now, limits: { idleTtlMs: 100, maxTotalBytes: 4 } });
	store.set('a', '1');
	store.set('b', '2');
	now = 60;
	store.get('a');
	now = 120;
	assert.deepEqual(store.keys(), ['a'], 'b was idle for 120 ms');
	assert.equal(store.get('b'), undefined);
	store.set('c', '3'); // fits only because b no longer counts
	now = 300;
	assert.deepEqual(store.keys(), []);
});
