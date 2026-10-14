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

	assert.deepEqual(entries.map(withoutDuration), [{ method: 'GET', path: '/v1/contacts', status: 200, ok: true, write: false }]);
	assert.doesNotMatch(JSON.stringify(entries), /test-key|Bearer|a@b\.test/);
});

test('non-OK status is logged with ok=false', async () => {
	const entries: RequestLogEntry[] = [];
	await withWritesEnv('true', () => clientWithFetch(async () => jsonResponse(422, { message: 'invalid' }))
		.request({ method: 'POST', path: '/v1/invoices', body: { secret: 'payload' } }, { onSettled: (entry) => entries.push(entry) }));

	assert.deepEqual(entries.map(withoutDuration), [{ method: 'POST', path: '/v1/invoices', status: 422, ok: false, write: true }]);
	assert.doesNotMatch(JSON.stringify(entries), /payload/);
});

test('network error is logged with the sanitized error message', async () => {
	const entries: RequestLogEntry[] = [];
	await assert.rejects(() => clientWithFetch(async () => {
		throw new Error('connect ECONNREFUSED with Bearer test-key');
	}).request({ path: '/v1/countries' }, { onSettled: (entry) => entries.push(entry) }));

	assert.equal(entries.length, 1);
	assert.deepEqual({ ...withoutDuration(entries[0]), error: undefined }, { method: 'GET', path: '/v1/countries', write: false, error: undefined });
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
