import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient, type LexwareRequestOptions, type RequestLogEntry } from './lexware-client.js';
import { ResponseCache } from './response-cache.js';

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A client over a fake fetch answering with `handler`; `fetched` records every attempt that reached fetch.
const cachingClient = (handler: (method: string, url: URL) => Response | Promise<Response> = () => jsonResponse(200, [{ id: 'cat-1' }]), { cache = new ResponseCache(), writesEnabled = true } = {}) => {
	const fetched: string[] = [];
	const client = new LexwareApiClient({
		apiKey: 'test-key',
		baseUrl: 'https://example.test',
		rateLimitIntervalMs: 0,
		writesEnabled,
		responseCache: cache,
		fetchImpl: async (input, init) => {
			const url = new URL(String(input));
			fetched.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
			return handler(init?.method ?? 'GET', url);
		},
	});
	return { client, fetched, cache };
};

// Options counting budget calls the way CodeMode.execute does, and collecting the log.
const auditedOptions = () => {
	const audit = { budgetCalls: 0, entries: [] as RequestLogEntry[] };
	const options: LexwareRequestOptions = { beforeSend: () => { audit.budgetCalls += 1; }, onSettled: (entry) => audit.entries.push(entry) };
	return { audit, options };
};

test('a second identical reference-data GET is served from the cache without fetch or budget', async () => {
	const { client, fetched } = cachingClient();
	const first = await client.request({ path: '/v1/posting-categories' });
	const { audit, options } = auditedOptions();
	const second = await client.request({ path: '/v1/posting-categories' }, options);

	assert.deepEqual(fetched, ['GET /v1/posting-categories']);
	assert.equal(first.cached, undefined);
	assert.equal(second.cached, true);
	assert.deepEqual(second.data, first.data);
	assert.equal(second.operation?.operationId, 'listPostingCategories');
	assert.equal(audit.budgetCalls, 0);
	assert.deepEqual(audit.entries, [{ method: 'GET', path: '/v1/posting-categories', status: 200, ok: true, write: false, sent: false, cached: true, durationMs: 0 }]);
});

test('a cache hit omits the rate-limit and request-id headers of the original response', async () => {
	const { client } = cachingClient(() => new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '1', 'x-request-id': 'req-1' } }));
	const first = await client.request({ path: '/v1/countries' });
	const hit = await client.request({ path: '/v1/countries' });
	assert.equal(first.headers['x-request-id'], 'req-1');
	assert.deepEqual(hit.headers, { 'content-type': 'application/json' });
});

test('a cache hit returns a copy: changing it does not change the cached response', async () => {
	const { client } = cachingClient();
	await client.request({ path: '/v1/countries' });
	const hit = await client.request({ path: '/v1/countries' });
	(hit.data as Array<{ id: string }>)[0].id = 'changed';
	const again = await client.request({ path: '/v1/countries' });
	assert.deepEqual(again.data, [{ id: 'cat-1' }]);
});

test('query order does not matter, but query values, accept and includeAllHeaders do', async () => {
	const { client, fetched } = cachingClient();
	await client.request({ path: '/v1/print-layouts?b=2&a=1' });
	await client.request({ path: '/v1/print-layouts', query: { a: 1, b: 2 } });
	await client.request({ path: '/v1/print-layouts', query: { a: 1, b: 3 } });
	await client.request({ path: '/v1/print-layouts', query: { a: 1, b: 2 }, includeAllHeaders: true });
	await client.request({ path: '/v1/print-layouts', query: { a: 1, b: 2 }, accept: 'application/vnd.test+json' });
	assert.deepEqual(fetched, [
		'GET /v1/print-layouts?b=2&a=1',
		'GET /v1/print-layouts?a=1&b=3',
		'GET /v1/print-layouts?a=1&b=2',
		'GET /v1/print-layouts?a=1&b=2',
	]);
});

test('operations without cacheTtlSeconds are never cached', async () => {
	const { client, fetched } = cachingClient(() => jsonResponse(200, { voucherStatus: 'blank' }));
	await client.request({ path: '/v1/vouchers/abc' });
	await client.request({ path: '/v1/vouchers/abc' });
	await client.request({ path: '/v1/unknown-endpoint' });
	await client.request({ path: '/v1/unknown-endpoint' });
	assert.equal(fetched.length, 4);
});

test('a sent write clears the cache, whatever its outcome', async () => {
	for (const writeResponse of [() => jsonResponse(200, {}), () => jsonResponse(422, {}), () => { throw new Error('socket hang up'); }]) {
		const { client, fetched } = cachingClient((method) => (method === 'GET' ? jsonResponse(200, []) : writeResponse()));
		await client.request({ path: '/v1/payment-conditions' });
		await client.request({ method: 'POST', path: '/v1/contacts', body: {} }).catch(() => {});
		await client.request({ path: '/v1/payment-conditions' });
		assert.deepEqual(fetched, ['GET /v1/payment-conditions', 'POST /v1/contacts', 'GET /v1/payment-conditions']);
	}
});

test('writes that are not sent (blocked, dry run) keep the cache', async () => {
	const blocked = cachingClient(undefined, { writesEnabled: false });
	await blocked.client.request({ path: '/v1/profile' });
	await assert.rejects(() => blocked.client.request({ method: 'POST', path: '/v1/contacts', body: {} }), /blocked/);
	await blocked.client.request({ path: '/v1/profile' });
	assert.deepEqual(blocked.fetched, ['GET /v1/profile']);

	const dryRun = cachingClient();
	await dryRun.client.request({ path: '/v1/profile' });
	await dryRun.client.request({ method: 'POST', path: '/v1/contacts', body: {} }, { dryRun: true });
	const hit = await dryRun.client.request({ path: '/v1/profile' }, { dryRun: true });
	assert.equal(hit.cached, true);
	assert.deepEqual(dryRun.fetched, ['GET /v1/profile']);
});

test('a write stops cache hits as soon as it is sent, before its response arrives', async () => {
	let version = 1;
	let releaseWrite!: () => void;
	let writeSent!: () => void;
	const sent = new Promise<void>((resolve) => { writeSent = resolve; });
	const { client } = cachingClient(async (method) => {
		if (method === 'GET') return jsonResponse(200, { version });
		version = 2;
		writeSent();
		await new Promise<void>((resolve) => { releaseWrite = resolve; });
		return jsonResponse(200, {});
	});
	await client.request({ path: '/v1/profile' });
	const write = client.request({ method: 'POST', path: '/v1/contacts', body: {} });
	await sent;
	const read = await client.request({ path: '/v1/profile' });
	releaseWrite();
	await write;
	assert.equal(read.cached, undefined);
	assert.deepEqual(read.data, { version: 2 });
});

test('a GET answered while a write is in flight is neither served from nor stored in the cache', async () => {
	let version = 1;
	let releaseWrite!: () => void;
	let writeSent!: () => void;
	const sent = new Promise<void>((resolve) => { writeSent = resolve; });
	const { client, fetched } = cachingClient(async (method) => {
		if (method === 'GET') return jsonResponse(200, { version });
		writeSent();
		await new Promise<void>((resolve) => { releaseWrite = resolve; });
		return jsonResponse(200, {});
	});
	const write = client.request({ method: 'POST', path: '/v1/contacts', body: {} });
	await sent;
	await client.request({ path: '/v1/profile' });
	version = 2; // Lexware applies the write before answering it.
	const duringWrite = await client.request({ path: '/v1/profile' });
	releaseWrite();
	await write;
	const afterWrite = await client.request({ path: '/v1/profile' });
	assert.deepEqual([duringWrite.cached, duringWrite.data], [undefined, { version: 2 }]);
	assert.deepEqual([afterWrite.cached, afterWrite.data], [undefined, { version: 2 }]);
	assert.deepEqual(fetched, ['POST /v1/contacts', 'GET /v1/profile', 'GET /v1/profile', 'GET /v1/profile']);
});

test('a GET in flight while a write is sent is not stored', async () => {
	let releaseGet!: () => void;
	const getHeld = new Promise<void>((resolve) => { releaseGet = resolve; });
	const { client, fetched } = cachingClient(async (method) => {
		if (method === 'GET' && fetched.length === 1) await getHeld;
		return jsonResponse(200, []);
	});
	const staleGet = client.request({ path: '/v1/posting-categories' });
	await new Promise((resolve) => setImmediate(resolve));
	await client.request({ method: 'PUT', path: '/v1/vouchers/abc', body: {} });
	releaseGet();
	await staleGet;
	await client.request({ path: '/v1/posting-categories' });
	assert.deepEqual(fetched, ['GET /v1/posting-categories', 'PUT /v1/vouchers/abc', 'GET /v1/posting-categories']);
});

test('cache: false fetches fresh and refreshes the cached response', async () => {
	let version = 0;
	const { client, fetched } = cachingClient(() => jsonResponse(200, { version: ++version }));
	await client.request({ path: '/v1/profile' });
	const fresh = await client.request({ path: '/v1/profile', cache: false });
	const hit = await client.request({ path: '/v1/profile' });
	assert.equal(fetched.length, 2);
	assert.equal(fresh.cached, undefined);
	assert.deepEqual(fresh.data, { version: 2 });
	assert.deepEqual(hit.data, { version: 2 });
	assert.equal(hit.cached, true);
	await assert.rejects(() => client.request({ path: '/v1/profile', cache: 'no' }), /cache must be a boolean/);
});

test('non-2xx, text and binary responses are never cached', async () => {
	const responses = [
		() => jsonResponse(404, { message: 'not found' }),
		() => jsonResponse(500, {}),
		() => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }),
		() => new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }),
		() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } }),
	];
	for (const response of responses) {
		const { client, fetched } = cachingClient(response);
		await client.request({ path: '/v1/countries' });
		const again = await client.request({ path: '/v1/countries' });
		assert.equal(fetched.length, 2);
		assert.equal(again.cached, undefined);
	}
});

test('a 429 retried into a 200 is cached', async () => {
	let calls = 0;
	const { client, fetched } = cachingClient(() => (++calls === 1 ? new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } }) : jsonResponse(200, [])));
	await client.request({ path: '/v1/countries' });
	const hit = await client.request({ path: '/v1/countries' });
	assert.equal(fetched.length, 2);
	assert.equal(hit.cached, true);
});

test('expired entries are fetched again', async () => {
	let now = 0;
	const { client, fetched } = cachingClient(undefined, { cache: new ResponseCache({ now: () => now }) });
	await client.request({ path: '/v1/countries' });
	now += 60 * 60 * 1000;
	await client.request({ path: '/v1/countries' });
	assert.equal(fetched.length, 2);
});

test('a cancelled request is not answered from the cache', async () => {
	const { client } = cachingClient();
	await client.request({ path: '/v1/countries' });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => client.request({ path: '/v1/countries' }, { signal: controller.signal }), /cancelled/);
});

test('without a ResponseCache every GET is sent', async () => {
	const fetched: string[] = [];
	const client = new LexwareApiClient({ apiKey: 'test-key', baseUrl: 'https://example.test', rateLimitIntervalMs: 0, fetchImpl: async (input) => { fetched.push(String(input)); return jsonResponse(200, []); } });
	await client.request({ path: '/v1/countries' });
	await client.request({ path: '/v1/countries' });
	assert.equal(fetched.length, 2);
});
