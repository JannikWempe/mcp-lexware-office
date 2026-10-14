import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient, type RequestLogEntry } from './lexware-client.js';

const clientWithFetch = (fetchImpl: typeof fetch) => new LexwareApiClient({
	apiKey: 'test-key',
	baseUrl: 'https://example.test',
	rateLimitIntervalMs: 0,
	fetchImpl,
});

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function withWritesEnv<T>(allowWrites: string | undefined, run: () => Promise<T>): Promise<T> {
	const originalReadOnly = process.env.LEXWARE_OFFICE_READ_ONLY;
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	delete process.env.LEXWARE_OFFICE_READ_ONLY;
	if (allowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	else process.env.LEXWARE_OFFICE_ALLOW_WRITES = allowWrites;
	try {
		return await run();
	} finally {
		if (originalReadOnly === undefined) delete process.env.LEXWARE_OFFICE_READ_ONLY;
		else process.env.LEXWARE_OFFICE_READ_ONLY = originalReadOnly;
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
}

const withoutDuration = ({ durationMs, ...entry }: RequestLogEntry) => {
	assert.ok(typeof durationMs === 'number' && durationMs >= 0);
	return entry;
};

test('successful request is logged once with status and without secrets', async () => {
	const entries: RequestLogEntry[] = [];
	await clientWithFetch(async () => jsonResponse(200, { ok: true }))
		.request({ path: '/v1/contacts', query: { email: 'a@b.test' } }, { onSettled: (entry) => entries.push(entry) });

	assert.deepEqual(entries.map(withoutDuration), [{ method: 'GET', path: '/v1/contacts', status: 200, ok: true, write: false, sent: true }]);
	assert.doesNotMatch(JSON.stringify(entries), /test-key|Bearer|a@b\.test/);
});

test('non-OK status is logged with ok=false', async () => {
	const entries: RequestLogEntry[] = [];
	await withWritesEnv('true', () => clientWithFetch(async () => jsonResponse(422, { message: 'invalid' }))
		.request({ method: 'POST', path: '/v1/invoices', body: { secret: 'payload' } }, { onSettled: (entry) => entries.push(entry) }));

	assert.deepEqual(entries.map(withoutDuration), [{ method: 'POST', path: '/v1/invoices', status: 422, ok: false, write: true, sent: true }]);
	assert.doesNotMatch(JSON.stringify(entries), /payload/);
});

test('network error is logged with the sanitized error message', async () => {
	const entries: RequestLogEntry[] = [];
	await assert.rejects(() => clientWithFetch(async () => {
		throw new Error('connect ECONNREFUSED with Bearer test-key');
	}).request({ path: '/v1/countries' }, { onSettled: (entry) => entries.push(entry) }));

	assert.equal(entries.length, 1);
	assert.deepEqual({ ...withoutDuration(entries[0]), error: undefined }, { method: 'GET', path: '/v1/countries', write: false, sent: true, error: undefined });
	assert.match(entries[0].error ?? '', /network error for GET \/v1\/countries/);
	assert.doesNotMatch(entries[0].error ?? '', /test-key/);
});

test('blocked write is logged with an error and never reaches fetch', async () => {
	const entries: RequestLogEntry[] = [];
	let calls = 0;
	await withWritesEnv(undefined, () => assert.rejects(() => clientWithFetch(async () => {
		calls += 1;
		return jsonResponse(200, {});
	}).request({ method: 'DELETE', path: '/v1/contacts/abc' }, { onSettled: (entry) => entries.push(entry) }), /blocked/));

	assert.equal(calls, 0);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].method, 'DELETE');
	assert.equal(entries[0].write, true);
	assert.equal(entries[0].status, undefined);
	assert.equal(entries[0].sent, false);
	assert.equal(entries[0].outcome, undefined);
	assert.match(entries[0].error ?? '', /blocked: writes are disabled/);
});

test('invalid input fails validation without a log entry', async () => {
	const entries: RequestLogEntry[] = [];
	await assert.rejects(() => clientWithFetch(async () => jsonResponse(200, {}))
		.request({ path: 'https://evil.test/v1/x' }, { onSettled: (entry) => entries.push(entry) }));

	assert.equal(entries.length, 0);
});

test('cancelled request is logged with a cancelled error', async () => {
	const entries: RequestLogEntry[] = [];
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => clientWithFetch(async () => jsonResponse(200, {}))
		.request({ path: '/v1/countries' }, { signal: controller.signal, onSettled: (entry) => entries.push(entry) }));

	assert.equal(entries.length, 1);
	assert.match(entries[0].error ?? '', /cancelled/);
});

// Never settles on its own; rejects like fetch does once its signal aborts.
const hangingFetch: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
	init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});

test('write cancelled while queued is logged as never sent', async () => {
	const entries: RequestLogEntry[] = [];
	let calls = 0;
	const client = new LexwareApiClient({
		apiKey: 'test-key',
		baseUrl: 'https://example.test',
		rateLimitIntervalMs: 5_000,
		fetchImpl: async () => {
			calls += 1;
			return jsonResponse(200, {});
		},
	});
	await client.request({ path: '/v1/countries' });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);

	await withWritesEnv('true', () => assert.rejects(
		() => client.request({ method: 'POST', path: '/v1/contacts', body: {} }, { signal: controller.signal, onSettled: (entry) => entries.push(entry) }),
		/cancelled/,
	));

	assert.equal(calls, 1);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].sent, false);
	assert.equal(entries[0].outcome, undefined);
});

test('write aborted in flight is logged as sent with unknown outcome', async () => {
	const entries: RequestLogEntry[] = [];
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 20);

	await withWritesEnv('true', () => assert.rejects(
		() => clientWithFetch(hangingFetch).request({ method: 'POST', path: '/v1/contacts', body: {} }, { signal: controller.signal, onSettled: (entry) => entries.push(entry) }),
		/cancelled/,
	));

	assert.equal(entries.length, 1);
	assert.equal(entries[0].sent, true);
	assert.equal(entries[0].outcome, 'unknown');
	assert.match(entries[0].error ?? '', /cancelled/);
});

test('timed-out and network-error writes have unknown outcome, reads do not', async () => {
	const entries: RequestLogEntry[] = [];
	const onSettled = (entry: RequestLogEntry) => entries.push(entry);
	const timeoutClient = new LexwareApiClient({ apiKey: 'test-key', baseUrl: 'https://example.test', rateLimitIntervalMs: 0, requestTimeoutMs: 20, fetchImpl: hangingFetch });
	const failingFetch: typeof fetch = async () => {
		throw new Error('socket hang up');
	};

	await withWritesEnv('true', async () => {
		await assert.rejects(() => timeoutClient.request({ method: 'PUT', path: '/v1/contacts/abc', body: {} }, { onSettled }), /timed out/);
		await assert.rejects(() => clientWithFetch(failingFetch).request({ method: 'DELETE', path: '/v1/contacts/abc' }, { onSettled }), /network error/);
		await assert.rejects(() => clientWithFetch(failingFetch).request({ path: '/v1/countries' }, { onSettled }), /network error/);
	});

	assert.deepEqual(entries.map(({ method, sent, outcome }) => ({ method, sent, outcome })), [
		{ method: 'PUT', sent: true, outcome: 'unknown' },
		{ method: 'DELETE', sent: true, outcome: 'unknown' },
		{ method: 'GET', sent: true, outcome: undefined },
	]);
});

test('response body read errors are sanitized in the thrown error and the log entry', async () => {
	const entries: RequestLogEntry[] = [];
	const leakyFetch: typeof fetch = async () => new Response(new ReadableStream({
		pull(controller) {
			controller.error(new Error('stream broke for https://example.test/v1/contacts?email=a@b.test with Bearer test-key'));
		},
	}), { status: 200, headers: { 'content-type': 'application/json' } });

	const error = await clientWithFetch(leakyFetch)
		.request({ path: '/v1/contacts', query: { email: 'a@b.test' } }, { onSettled: (entry) => entries.push(entry) })
		.then(() => assert.fail('expected a read error'), (caught: unknown) => caught);

	assert.ok(error instanceof Error);
	assert.match(error.message, /^Lexware API response read error for GET \/v1\/contacts: /);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].error, error.message);
	for (const text of [error.message, JSON.stringify(entries)]) {
		assert.doesNotMatch(text, /test-key|a@b\.test|https?:/);
	}
});
