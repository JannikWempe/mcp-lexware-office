import assert from 'node:assert/strict';
import test from 'node:test';

import { ResponseCache } from './response-cache.js';

const clock = () => {
	let now = 0;
	return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test('entries expire after their TTL', () => {
	const time = clock();
	const cache = new ResponseCache({ now: time.now });
	cache.set('a', '{"x":1}', 1_000, cache.generation);
	time.advance(999);
	assert.equal(cache.get('a'), '{"x":1}');
	time.advance(1);
	assert.equal(cache.get('a'), undefined);
	assert.equal(cache.size, 0);
});

test('the least recently used entry is evicted beyond maxEntries', () => {
	const cache = new ResponseCache({ limits: { maxEntries: 2 } });
	cache.set('a', '1', 60_000, cache.generation);
	cache.set('b', '2', 60_000, cache.generation);
	assert.equal(cache.get('a'), '1');
	cache.set('c', '3', 60_000, cache.generation);
	assert.equal(cache.get('b'), undefined);
	assert.equal(cache.get('a'), '1');
	assert.equal(cache.get('c'), '3');
});

test('entries are evicted beyond maxTotalBytes, and an entry larger than the limit is not stored', () => {
	const cache = new ResponseCache({ limits: { maxTotalBytes: 10 } });
	cache.set('a', '1234', 60_000, cache.generation);
	cache.set('b', '1234', 60_000, cache.generation);
	assert.equal(cache.size, 2);
	cache.set('c', '1234', 60_000, cache.generation);
	assert.equal(cache.get('a'), undefined);
	assert.equal(cache.size, 2);
	cache.set('d', '12345678901', 60_000, cache.generation);
	assert.equal(cache.get('d'), undefined);
	assert.equal(cache.size, 2);
});

test('replacing a key keeps the byte count exact', () => {
	const cache = new ResponseCache({ limits: { maxTotalBytes: 12 } });
	for (let i = 0; i < 5; i += 1) cache.set('a', '12345678', 60_000, cache.generation);
	// 9 + 2 bytes fit; counting each replaced value again would evict a.
	cache.set('b', '1', 60_000, cache.generation);
	assert.equal(cache.get('a'), '12345678');
	assert.equal(cache.get('b'), '1');
});

test('clear() drops all entries and rejects a set with an older generation', () => {
	const cache = new ResponseCache();
	const before = cache.generation;
	cache.set('a', '1', 60_000, before);
	cache.clear();
	assert.equal(cache.get('a'), undefined);
	cache.set('b', '2', 60_000, before);
	assert.equal(cache.get('b'), undefined);
	cache.set('b', '2', 60_000, cache.generation);
	assert.equal(cache.get('b'), '2');
});
