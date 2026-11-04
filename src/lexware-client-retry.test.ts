import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient, type RequestLogEntry } from './lexware-client.js';

const clientWithFetch = (fetchImpl: typeof fetch, options: Partial<ConstructorParameters<typeof LexwareApiClient>[0]> = {}) => new LexwareApiClient({
	apiKey: 'test-key',
	baseUrl: 'https://example.test',
	rateLimitIntervalMs: 0,
	fetchImpl,
	...options,
});

const tooManyRequests = (retryAfter?: string) => new Response(JSON.stringify({ message: 'slow down' }), {
	status: 429,
	headers: { 'content-type': 'application/json', ...(retryAfter !== undefined && { 'retry-after': retryAfter }) },
});
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

// Returns the queued responses in order, recording when each fetch happened.
const sequenceFetch = (responses: Array<() => Response>) => {
	const sentAt: number[] = [];
	const fetchImpl: typeof fetch = async () => {
		sentAt.push(Date.now());
		const next = responses.shift();
		if (next === undefined) throw new Error('unexpected extra fetch');
		return next();
	};
	return { fetchImpl, sentAt };
};

test('GET 429 with short Retry-After is retried once and both attempts are logged', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests('0'), ok]);
	const entries: RequestLogEntry[] = [];

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' }, { onSettled: (entry) => entries.push(entry) });

	assert.equal(response.status, 200);
	assert.equal(sentAt.length, 2);
	assert.deepEqual(entries.map((entry) => entry.status), [429, 200]);
});

test('retried GET waits for Retry-After and goes through the rate limiter', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests('1'), ok]);

	const response = await clientWithFetch(fetchImpl, { rateLimitIntervalMs: 50 }).request({ path: '/v1/countries' });

	assert.equal(response.status, 200);
	assert.ok(sentAt[1] - sentAt[0] >= 990, `expected ~1s Retry-After wait, got ${sentAt[1] - sentAt[0]}ms`);
});

test('GET 429 is retried at most once', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests('0'), () => tooManyRequests('0')]);

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });

	assert.equal(response.status, 429);
	assert.equal(response.retryAfterSeconds, 0);
	assert.equal(sentAt.length, 2);
});

test('GET 429 is returned without retry when the wait exceeds maxRetryAfterMs', async () => {
	for (const [retryAfter, maxRetryAfterMs] of [['10', undefined], ['2', 1_000], [undefined, 500]] as const) {
		const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests(retryAfter)]);
		const response = await clientWithFetch(fetchImpl, maxRetryAfterMs !== undefined ? { maxRetryAfterMs } : {}).request({ path: '/v1/countries' });
		assert.equal(response.status, 429);
		assert.equal(sentAt.length, 1);
	}
});

test('writes are never retried on 429', async () => {
	for (const retryAfter of ['0', undefined]) {
		const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests(retryAfter)]);
		const response = await clientWithFetch(fetchImpl, { writesEnabled: true }).request({ method: 'POST', path: '/v1/contacts', body: {} });
		assert.equal(response.status, 429);
		assert.equal(sentAt.length, 1);
	}
});

test('GET 429 without Retry-After is retried once after a 1–2 s backoff', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests(), ok]);
	const entries: RequestLogEntry[] = [];

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' }, { onSettled: (entry) => entries.push(entry) });

	assert.equal(response.status, 200);
	const waitedMs = sentAt[1] - sentAt[0];
	assert.ok(waitedMs >= 990 && waitedMs < 2_500, `expected 1–2s backoff, got ${waitedMs}ms`);
	assert.deepEqual(entries.map((entry) => entry.status), [429, 200]);
});

test('backoff retry still counts against the beforeSend budget', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests(), ok]);
	const entries: RequestLogEntry[] = [];
	let sends = 0;
	const beforeSend = () => {
		if (sends >= 1) throw new Error('Execution exceeded maxRequests=1');
		sends += 1;
	};

	await assert.rejects(
		() => clientWithFetch(fetchImpl).request({ path: '/v1/countries' }, { beforeSend, onSettled: (entry) => entries.push(entry) }),
		/maxRequests=1/,
	);

	assert.equal(sentAt.length, 1);
	assert.deepEqual(entries.map(({ status, sent }) => ({ status, sent })), [{ status: 429, sent: true }, { status: undefined, sent: false }]);
});

test('abort during the backoff wait cancels the retry without a second fetch', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests(), ok]);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);
	const startedAt = Date.now();

	await assert.rejects(() => clientWithFetch(fetchImpl).request({ path: '/v1/countries' }, { signal: controller.signal }), /cancelled/);

	assert.ok(Date.now() - startedAt < 500);
	assert.equal(sentAt.length, 1);
});

test('a 429 holds back the shared queue, also for requests already waiting', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests('1'), ok, ok]);
	const client = clientWithFetch(fetchImpl, { rateLimitIntervalMs: 50, writesEnabled: true });

	const [write, read] = await Promise.all([
		client.request({ method: 'POST', path: '/v1/contacts', body: {} }),
		client.request({ path: '/v1/countries' }),
	]);
	const next = await client.request({ path: '/v1/countries' });

	assert.deepEqual([write.status, read.status, next.status], [429, 200, 200]);
	assert.ok(sentAt[1] - sentAt[0] >= 990, `expected queued request to wait ~1s, got ${sentAt[1] - sentAt[0]}ms`);
});

test('abort during the Retry-After wait cancels the retry without a second fetch', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests('1'), ok]);
	const entries: RequestLogEntry[] = [];
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);
	const startedAt = Date.now();

	await assert.rejects(
		() => clientWithFetch(fetchImpl).request({ path: '/v1/countries' }, { signal: controller.signal, onSettled: (entry) => entries.push(entry) }),
		/cancelled/,
	);

	assert.ok(Date.now() - startedAt < 500);
	assert.equal(sentAt.length, 1);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].status, 429);
	assert.match(entries[1].error ?? '', /cancelled/);
});

test('retry after Retry-After: 0 still respects the rate limiter spacing', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests('0'), ok]);

	const response = await clientWithFetch(fetchImpl, { rateLimitIntervalMs: 200 }).request({ path: '/v1/countries' });

	assert.equal(response.status, 200);
	assert.ok(sentAt[1] - sentAt[0] >= 190, `expected ~200ms rate-limit spacing, got ${sentAt[1] - sentAt[0]}ms`);
});

test('abort while the retry is queued for the rate limiter prevents the second fetch', async () => {
	const { fetchImpl, sentAt } = sequenceFetch([() => tooManyRequests('0'), ok]);
	const entries: RequestLogEntry[] = [];
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);
	const startedAt = Date.now();

	await assert.rejects(
		() => clientWithFetch(fetchImpl, { rateLimitIntervalMs: 2_000 }).request({ path: '/v1/countries' }, { signal: controller.signal, onSettled: (entry) => entries.push(entry) }),
		/cancelled/,
	);

	assert.ok(Date.now() - startedAt < 1_000);
	assert.equal(sentAt.length, 1);
	assert.deepEqual(entries.map(({ status, sent }) => ({ status, sent })), [{ status: 429, sent: true }, { status: undefined, sent: false }]);
});
