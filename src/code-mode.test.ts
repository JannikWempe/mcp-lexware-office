import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { AccountProfile, type AccountInfo } from './account.js';
import { CodeMode } from './code-mode.js';
import { LexwareApiClient, type LexwareClientOptions } from './lexware-client.js';
import { ResponseCache } from './response-cache.js';
import { SandboxState } from './sandbox-state.js';
import { parseWriteAllow } from './write-policy.js';

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json', ...headers },
});

const stubAccount: AccountInfo = { organizationId: 'org-1', companyName: 'Testfirma GmbH' };

// CodeMode over the real QuickJsExecutor and a LexwareApiClient whose fetch is faked.
// `fetched` records every attempt that actually reached fetch. The account is stubbed unless
// `realAccount` is set, so the profile lookup doesn't show up in `fetched`. `state` replaces the default store.
const codeModeWith = (handler: (path: string) => Response | Promise<Response> = () => jsonResponse(200, {}), options: LexwareClientOptions = {}, { realAccount = false, state }: { realAccount?: boolean; state?: SandboxState } = {}) => {
	const fetched: string[] = [];
	const client = new LexwareApiClient({
		apiKey: 'test-key',
		baseUrl: 'https://example.test',
		rateLimitIntervalMs: 0,
		...options,
		fetchImpl: async (input, init) => {
			const path = new URL(String(input)).pathname;
			fetched.push(`${init?.method ?? 'GET'} ${path}`);
			return handler(path);
		},
	});
	return { codeMode: new CodeMode({ client, account: realAccount ? new AccountProfile(client) : { get: async () => stubAccount }, state }), fetched };
};

const textOf = (result: CallToolResult) => {
	const block = result.content[0];
	assert.equal(block?.type, 'text');
	return block.text;
};

// Returns the structured payload and checks it mirrors the text block.
const payloadOf = (result: CallToolResult) => {
	assert.ok(result.structuredContent, 'expected structuredContent');
	assert.deepEqual(JSON.parse(textOf(result)), result.structuredContent);
	return result.structuredContent as Record<string, any>;
};

test('search runs against the catalog and reports writesEnabled from the client', async () => {
	for (const writesEnabled of [false, true]) {
		const { codeMode, fetched } = codeModeWith(undefined, { writesEnabled });

		const result = await codeMode.search(`async () => ({ writesEnabled: spec.info.writesEnabled, hasContacts: 'contacts' in spec.info.domainIndex, lexware: typeof lexware })`);

		assert.equal(result.isError, undefined);
		assert.deepEqual(payloadOf(result), { ok: true, result: { writesEnabled, hasContacts: true, lexware: 'undefined' }, logs: [] });
		assert.equal(fetched.length, 0);
	}
});

test('execute exposes writePolicy and rejects non-allowlisted writes unsent and without consuming budget', async () => {
	const { codeMode, fetched } = codeModeWith(() => jsonResponse(202, { id: 'file' }), { writesEnabled: true, writeAllow: parseWriteAllow('POST /v1/vouchers/{id}/files') });

	const result = await codeMode.execute(`async () => {
		const policy = spec.info.writePolicy;
		const blocked = await lexware.request({ method: 'POST', path: '/v1/contacts', body: {} }).catch((error) => error.message);
		const allowed = await lexware.request({ method: 'POST', path: '/v1/vouchers/v1/files', multipart: [{ name: 'file', filename: 'a.pdf', contentBase64: 'JVBERg==' }] });
		return { policy, blocked, allowedStatus: allowed.status };
	}`, { maxRequests: 1 });

	const payload = payloadOf(result);
	assert.deepEqual(payload.result.policy, { enabled: true, allow: ['POST /v1/vouchers/{id}/files'] });
	assert.match(payload.result.blocked, /POST \/v1\/contacts is blocked: not in LEXWARE_OFFICE_WRITE_ALLOW/);
	assert.equal(payload.result.allowedStatus, 202);
	assert.equal(payload.requestCount, 1);
	assert.deepEqual(payload.requests.map(({ method, path, write, sent }: Record<string, unknown>) => ({ method, path, write, sent })), [
		{ method: 'POST', path: '/v1/contacts', write: true, sent: false },
		{ method: 'POST', path: '/v1/vouchers/v1/files', write: true, sent: true },
	]);
	assert.deepEqual(fetched, ['POST /v1/vouchers/v1/files']);
});

test('execute exposes writesEnabled in the sandbox spec', async () => {
	for (const writesEnabled of [false, true]) {
		const { codeMode } = codeModeWith(undefined, { writesEnabled });
		const result = await codeMode.execute('async () => spec.info.writesEnabled', { maxRequests: 1 });
		assert.equal(payloadOf(result).result, writesEnabled);
	}
});

test('find and describe are available in search and execute', async () => {
	const { codeMode, fetched } = codeModeWith();
	const code = `async () => ({ top: find('upload beleg', { limit: 1 })[0].path, op: describe('GET', '/v1/voucherlist').operationId })`;

	for (const result of [await codeMode.search(code), await codeMode.execute(code, { maxRequests: 1 })]) {
		assert.equal(result.isError, undefined, textOf(result));
		assert.deepEqual(payloadOf(result).result, { top: '/v1/files', op: 'listVoucherSummaries' });
	}
	assert.equal(fetched.length, 0);
});

test('search errors set isError and keep logs', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.search(`async () => { console.log('before'); throw new Error('nope'); }`);

	assert.equal(result.isError, true);
	const payload = payloadOf(result);
	assert.equal(payload.ok, false);
	assert.match(payload.error, /nope/);
	assert.deepEqual(payload.logs, ['before']);
});

test('execute returns result, requestCount, and the requests audit log', async () => {
	const { codeMode, fetched } = codeModeWith(() => jsonResponse(200, [{ countryCode: 'DE' }]));

	const result = await codeMode.execute(`async () => (await lexware.request({ path: '/v1/countries' })).data[0].countryCode`, { maxRequests: 10 });

	assert.equal(result.isError, undefined);
	const { requests, ...payload } = payloadOf(result);
	assert.deepEqual(payload, { ok: true, result: 'DE', logs: [], requestCount: 1 });
	assert.deepEqual(requests.map(({ durationMs: _, ...entry }: Record<string, unknown>) => entry), [{ method: 'GET', path: '/v1/countries', status: 200, ok: true, write: false, sent: true }]);
	assert.deepEqual(fetched, ['GET /v1/countries']);
});

test('failing execute sets isError and still reports requests made before the error', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.execute(`async () => {
		await lexware.request({ path: '/v1/profile' });
		await lexware.request({ method: 'POST', path: '/v1/contacts', body: {} }).catch(() => {});
		throw new Error('boom');
	}`, { maxRequests: 10 });

	assert.equal(result.isError, true);
	const payload = payloadOf(result);
	assert.equal(payload.ok, false);
	assert.match(payload.error, /boom/);
	assert.equal(payload.requestCount, 1);
	assert.deepEqual(payload.requests.map(({ method, status, sent }: Record<string, unknown>) => ({ method, status, sent })), [
		{ method: 'GET', status: 200, sent: true },
		{ method: 'POST', status: undefined, sent: false },
	]);
	assert.match(payload.requests[1].error, /blocked: writes are disabled/);
});

test('maxRequests bounds sent attempts; the over-budget attempt fails without being sent', async () => {
	const { codeMode, fetched } = codeModeWith();

	const result = await codeMode.execute(`async () => {
		const outcomes = [];
		for (let i = 0; i < 3; i++) {
			outcomes.push(await lexware.request({ path: '/v1/countries' }).then((r) => r.status, (e) => String(e.message)));
		}
		return outcomes;
	}`, { maxRequests: 2 });

	const payload = payloadOf(result);
	assert.deepEqual(payload.result, [200, 200, 'Execution exceeded maxRequests=2']);
	assert.equal(fetched.length, 2);
	assert.equal(payload.requestCount, 2);
	assert.deepEqual(payload.requests.map(({ sent, error }: Record<string, unknown>) => ({ sent, error })), [
		{ sent: true, error: undefined },
		{ sent: true, error: undefined },
		{ sent: false, error: 'Execution exceeded maxRequests=2' },
	]);
});

test('uncaught over-budget error fails the execution', async () => {
	const { codeMode, fetched } = codeModeWith();

	const result = await codeMode.execute(`async () => {
		await lexware.request({ path: '/v1/countries' });
		await lexware.request({ path: '/v1/countries' });
	}`, { maxRequests: 1 });

	assert.equal(result.isError, true);
	assert.match(payloadOf(result).error, /Execution exceeded maxRequests=1/);
	assert.equal(fetched.length, 1);
});

test('concurrent requests cannot exceed maxRequests', async () => {
	const { codeMode, fetched } = codeModeWith();

	const result = await codeMode.execute(`async () => {
		const settled = await Promise.allSettled(Array.from({ length: 6 }, () => lexware.request({ path: '/v1/countries' })));
		return settled.filter((s) => s.status === 'fulfilled').length;
	}`, { maxRequests: 4 });

	const payload = payloadOf(result);
	assert.equal(payload.result, 4);
	assert.equal(fetched.length, 4);
	assert.equal(payload.requestCount, 4);
	assert.equal(payload.requests.filter((entry: { sent: boolean }) => entry.sent).length, 4);
});

test('429 retries count against maxRequests', async () => {
	const tooManyThenOk = () => {
		let calls = 0;
		return () => (calls++ === 0 ? jsonResponse(429, {}, { 'retry-after': '0' }) : jsonResponse(200, {}));
	};
	const code = `async () => (await lexware.request({ path: '/v1/countries' })).status`;

	const withBudget = codeModeWith(tooManyThenOk());
	const ok = payloadOf(await withBudget.codeMode.execute(code, { maxRequests: 2 }));
	assert.equal(ok.result, 200);
	assert.equal(ok.requestCount, 2);
	assert.deepEqual(ok.requests.map((entry: { status?: number }) => entry.status), [429, 200]);
	assert.equal(withBudget.fetched.length, 2);

	const withoutBudget = codeModeWith(tooManyThenOk());
	const exhausted = await withoutBudget.codeMode.execute(code, { maxRequests: 1 });
	assert.equal(exhausted.isError, true);
	const payload = payloadOf(exhausted);
	assert.match(payload.error, /Execution exceeded maxRequests=1/);
	assert.equal(payload.requestCount, 1);
	assert.deepEqual(payload.requests.map(({ status, sent }: Record<string, unknown>) => ({ status, sent })), [
		{ status: 429, sent: true },
		{ status: undefined, sent: false },
	]);
	assert.equal(withoutBudget.fetched.length, 1);
});

test('invalid input and blocked writes do not consume the request budget', async () => {
	const { codeMode, fetched } = codeModeWith();

	const result = await codeMode.execute(`async () => {
		const invalid = await lexware.request({ path: 'https://evil.test/v1/x' }).catch((e) => e.message);
		const blocked = await lexware.request({ method: 'DELETE', path: '/v1/contacts/abc' }).catch((e) => e.message);
		const ok = (await lexware.request({ path: '/v1/countries' })).status;
		return { invalid, blocked, ok };
	}`, { maxRequests: 1 });

	const payload = payloadOf(result);
	assert.match(payload.result.invalid, /path must start with \//);
	assert.match(payload.result.blocked, /blocked: writes are disabled/);
	assert.equal(payload.result.ok, 200);
	assert.equal(payload.requestCount, 1);
	assert.deepEqual(payload.requests.map(({ method, sent }: Record<string, unknown>) => ({ method, sent })), [
		{ method: 'DELETE', sent: false },
		{ method: 'GET', sent: true },
	]);
	assert.deepEqual(fetched, ['GET /v1/countries']);
});

test('oversized results are shrunk to valid JSON and still returned as structuredContent', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.execute(`async () => Array.from({ length: 2000 }, (_, id) => ({ id, name: 'item ' + id }))`, { maxRequests: 1 });

	assert.equal(result.isError, undefined);
	const text = textOf(result);
	assert.ok(text.length <= 24_000);
	const payload = payloadOf(result);
	assert.equal(payload.ok, true);
	assert.deepEqual(payload.result[0], { id: 0, name: 'item 0' });
	assert.match(payload.result.at(-1), /^\[truncated: \d+ more items\]$/);
	assert.equal(payload.result.length - 1 + Number(payload.result.at(-1).match(/\d+/)[0]), 2000);
	assert.ok(payload.truncated.originalChars > 24_000);
	assert.match(payload.truncated.note, /Recovery: use a more specific search query/);
	assert.deepEqual(payload.requests, []);
});

test('oversized search results are shrunk to valid JSON too', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.search('async () => spec');

	assert.ok(textOf(result).length <= 24_000);
	const payload = payloadOf(result);
	assert.equal(payload.ok, true);
	assert.ok(payload.truncated.originalChars > 24_000);
	assert.equal(typeof payload.result, 'object');
});

test('truncation never cuts write entries from the requests audit log', async () => {
	const { codeMode } = codeModeWith(() => jsonResponse(201, {}), { writesEnabled: true });

	const result = await codeMode.execute(`async () => {
		for (let i = 0; i < 50; i++) await lexware.request({ method: 'POST', path: '/v1/contacts', body: {} });
		console.log('x'.repeat(100000));
		return 'y'.repeat(100000);
	}`, { maxRequests: 50 });

	assert.ok(textOf(result).length <= 24_000);
	const payload = payloadOf(result);
	assert.equal(payload.requestCount, 50);
	assert.equal(payload.requests.length, 50);
	assert.ok(payload.requests.every((entry: { write: boolean; status: number }) => entry.write && entry.status === 201));
	assert.match(payload.result, /…\[truncated: \d+ chars\]$/);
});

test('a too deeply nested result fails cleanly and still reports the requests audit log', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.execute(`async () => {
		await lexware.request({ path: '/v1/profile' });
		let v = 0;
		for (let i = 0; i < 10000; i++) v = { a: v };
		return v;
	}`, { maxRequests: 1 });

	assert.equal(result.isError, true);
	const payload = payloadOf(result);
	assert.equal(payload.ok, false);
	assert.match(payload.error, /nested too deeply/);
	assert.equal(payload.requestCount, 1);
	assert.deepEqual(payload.requests.map(({ method, path, status }: Record<string, unknown>) => ({ method, path, status })), [
		{ method: 'GET', path: '/v1/profile', status: 200 },
	]);
});

test('a non-serializable result still reports the requests audit log, within the limit', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.execute(`async () => {
		for (let i = 0; i < 300; i++) await lexware.request({ method: 'POST', path: '/v1/contacts', body: {} }).catch(() => {});
		return 1n;
	}`, { maxRequests: 1 });

	const text = textOf(result);
	assert.ok(text.length <= 24_000);
	assert.equal(result.structuredContent, undefined);
	const payload = JSON.parse(text);
	assert.match(payload.error, /not JSON-serializable/);
	assert.equal(payload.ok, undefined);
	assert.equal(payload.requestCount, 0);
	assert.match(payload.requests.at(-1), /^\[truncated: \d+ more items\]$/);
	assert.match(payload.requests[0].error, /blocked: writes are disabled/);
});

test('results within the limit are returned unchanged, without a truncated hint', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.execute(`async () => 'x'.repeat(1000)`, { maxRequests: 1 });

	const payload = { ok: true, result: 'x'.repeat(1000), logs: [], requestCount: 0, requests: [] };
	assert.equal(textOf(result), JSON.stringify(payload, null, 2));
	assert.deepEqual(result.structuredContent, payload);
});

test('more than 5 successful reads are summarised; writes and failures stay listed', async () => {
	const { codeMode } = codeModeWith((path) => path === '/v1/contacts/missing' ? jsonResponse(404, {}) : jsonResponse(200, {}), { writesEnabled: true });

	const result = await codeMode.execute(`async () => {
		for (let i = 0; i < 6; i++) await lexware.request({ path: '/v1/countries' });
		await lexware.request({ path: '/v1/contacts/missing' });
		await lexware.request({ method: 'POST', path: '/v1/contacts', body: {} });
		return 'done';
	}`, { maxRequests: 10 });

	const payload = payloadOf(result);
	assert.equal(payload.requestCount, 8);
	assert.deepEqual(payload.requests.map(({ method, path, status }: Record<string, unknown>) => ({ method, path, status })), [
		{ method: 'GET', path: '/v1/contacts/missing', status: 404 },
		{ method: 'POST', path: '/v1/contacts', status: 200 },
	]);
	assert.deepEqual({ ...payload.readsSummary, totalDurationMs: 0 }, { count: 6, byStatus: { 200: 6 }, totalDurationMs: 0 });
	assert.equal(typeof payload.readsSummary.totalDurationMs, 'number');
});

test('up to 5 successful reads are listed without a readsSummary', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.execute(`async () => {
		for (let i = 0; i < 5; i++) await lexware.request({ path: '/v1/countries' });
	}`, { maxRequests: 10 });

	const payload = payloadOf(result);
	assert.equal(payload.requests.length, 5);
	assert.equal(payload.readsSummary, undefined);
});

test('cached reference data carries over to the next execute call without using its budget', async () => {
	const { codeMode, fetched } = codeModeWith(() => jsonResponse(200, [{ id: 'cat-1' }]), { responseCache: new ResponseCache() });
	await codeMode.execute(`async () => lexware.json({ path: '/v1/posting-categories' })`, { maxRequests: 1 });

	const payload = payloadOf(await codeMode.execute(`async () => {
		const response = await lexware.request({ path: '/v1/posting-categories' });
		return { cached: response.cached, data: response.data };
	}`, { maxRequests: 1 }));
	assert.deepEqual(payload.result, { cached: true, data: [{ id: 'cat-1' }] });
	assert.equal(payload.requestCount, 0);
	assert.deepEqual(payload.requests, [{ method: 'GET', path: '/v1/posting-categories', status: 200, ok: true, write: false, sent: false, cached: true, durationMs: 0 }]);
	assert.deepEqual(fetched, ['GET /v1/posting-categories']);

	const many = payloadOf(await codeMode.execute(`async () => {
		for (let i = 0; i < 6; i++) await lexware.request({ path: '/v1/posting-categories' });
	}`, { maxRequests: 1 }));
	assert.equal(many.requestCount, 0);
	assert.deepEqual({ ...many.readsSummary, totalDurationMs: 0 }, { count: 6, byStatus: { 200: 6 }, totalDurationMs: 0, cached: 6 });
});

test('execute sandbox sees neither the API key nor Node globals', async () => {
	const { codeMode } = codeModeWith(undefined, { apiKey: 'super-secret-test-key' });

	const result = await codeMode.execute(`async () => ({
		lexwareType: typeof lexware,
		requestType: typeof lexware.request,
		processType: typeof process,
		fetchType: typeof fetch,
		requireType: typeof require,
		secretVisible: [
			Object.getOwnPropertyNames(globalThis).join(','),
			JSON.stringify(spec),
			JSON.stringify(await lexware.request({ path: '/v1/countries' })),
		].some((text) => /super-secret-test-key|Bearer/.test(text)),
	})`, { maxRequests: 1 });

	assert.deepEqual(payloadOf(result).result, { lexwareType: 'object', requestType: 'function', processType: 'undefined', fetchType: 'undefined', requireType: 'undefined', secretVisible: false });
	assert.doesNotMatch(JSON.stringify(result), /super-secret-test-key|Bearer/);
});

test('an already aborted signal cancels without sending', async () => {
	const { codeMode, fetched } = codeModeWith(undefined, {}, { realAccount: true });
	const controller = new AbortController();
	controller.abort();

	const result = await codeMode.execute(`async () => lexware.request({ path: '/v1/countries' })`, { maxRequests: 1, signal: controller.signal });

	assert.equal(result.isError, true);
	assert.match(payloadOf(result).error, /Execution cancelled by client/);
	assert.equal(fetched.length, 0);
});

test('spec.info.account comes from one profile lookup that bypasses the execute budget and audit log', async () => {
	const { codeMode, fetched } = codeModeWith((path) => jsonResponse(200, path === '/v1/profile' ? { organizationId: 'org-1', companyName: 'Testfirma GmbH', taxType: 'net', smallBusiness: true, created: { userEmail: 'a@b.test' } } : {}), {}, { realAccount: true });

	const searched = payloadOf(await codeMode.search(`async () => spec.info.account`));
	const executed = payloadOf(await codeMode.execute(`async () => { await lexware.request({ path: '/v1/countries' }); return spec.info.account; }`, { maxRequests: 1 }));

	const account = { organizationId: 'org-1', companyName: 'Testfirma GmbH', taxType: 'net', smallBusiness: true };
	assert.deepEqual(searched.result, account);
	assert.deepEqual(executed.result, account);
	assert.equal(executed.requestCount, 1);
	assert.deepEqual(executed.requests.map(({ path }: Record<string, unknown>) => path), ['/v1/countries']);
	assert.deepEqual(fetched, ['GET /v1/profile', 'GET /v1/countries']);
});

test('search without an API key still works and reports the account as unavailable', async () => {
	const { codeMode, fetched } = codeModeWith(undefined, { apiKey: undefined }, { realAccount: true });

	const result = await codeMode.search(`async () => ({ account: spec.info.account, hasContacts: 'contacts' in spec.info.domainIndex })`);

	assert.equal(result.isError, undefined);
	assert.deepEqual(payloadOf(result).result, { account: { error: 'profile unavailable: no API key configured' }, hasContacts: true });
	assert.deepEqual(fetched, []);
});

test('cancelling while the profile loads ends the call without waiting for it', async () => {
	// The hanging profile fetch outlives the cancellation; requestTimeoutMs only keeps it from lingering.
	const { codeMode } = codeModeWith(() => new Promise<Response>(() => {}), { requestTimeoutMs: 200 }, { realAccount: true });
	const controller = new AbortController();

	const pending = codeMode.search(`async () => 1`, { signal: controller.signal });
	setTimeout(() => controller.abort(), 10);
	const result = await pending;

	assert.equal(result.isError, true);
	assert.match(payloadOf(result).error, /Execution cancelled by client/);
});

test('search waits at most a second for a slow profile and reports it as still loading', async () => {
	let releaseProfile = () => {};
	const { codeMode } = codeModeWith((path) => path === '/v1/profile'
		? new Promise<Response>((resolve) => { releaseProfile = () => resolve(jsonResponse(200, { companyName: 'Testfirma GmbH' })); })
		: jsonResponse(200, {}), {}, { realAccount: true });

	const startedAt = Date.now();
	const loading = payloadOf(await codeMode.search(`async () => spec.info.account`));
	assert.ok(Date.now() - startedAt < 2_000);
	assert.deepEqual(loading.result, { error: 'profile still loading; check again in a later call' });

	releaseProfile();
	assert.deepEqual(payloadOf(await codeMode.search(`async () => spec.info.account`)).result, { companyName: 'Testfirma GmbH' });
});

test('execute still succeeds when the profile lookup fails', async () => {
	const { codeMode, fetched } = codeModeWith((path) => (path === '/v1/profile' ? jsonResponse(401, { message: 'Unauthorized' }) : jsonResponse(200, { ok: 1 })), {}, { realAccount: true });

	const result = await codeMode.execute(`async () => ({ account: spec.info.account, data: await lexware.json({ path: '/v1/countries' }) })`, { maxRequests: 1 });
	await codeMode.execute(`async () => spec.info.account`, { maxRequests: 1 });

	assert.equal(result.isError, undefined);
	assert.deepEqual(payloadOf(result).result, { account: { error: 'profile unavailable: auth (HTTP 401)' }, data: { ok: 1 } });
	assert.deepEqual(fetched, ['GET /v1/profile', 'GET /v1/countries']);
});

test('a dry run sends reads, plans writes without fetching them, and marks the synthetic responses', async () => {
	const { codeMode, fetched } = codeModeWith(() => jsonResponse(200, { id: 'c1', version: 3 }), { writesEnabled: true });

	const result = await codeMode.execute(`async () => {
		const contact = await lexware.json({ path: '/v1/contacts/c1' });
		const response = await lexware.request({ method: 'PUT', path: '/v1/contacts/c1', query: { note: 'x' }, body: { version: contact.version, roles: { customer: {} } } });
		const viaJson = await lexware.json({ method: 'POST', path: '/v1/contacts', body: { version: 0 } });
		return { response, viaJson: viaJson === undefined };
	}`, { maxRequests: 1, dryRun: true });

	assert.equal(result.isError, undefined);
	const payload = payloadOf(result);
	assert.deepEqual(fetched, ['GET /v1/contacts/c1']);
	const planned = { method: 'PUT', path: '/v1/contacts/c1', query: { note: ['x'] }, operationId: 'updateContact', contentType: 'application/json', body: { version: 3, roles: { customer: {} } } };
	assert.deepEqual(payload.result.response, {
		ok: true,
		status: 0,
		statusText: 'DRY RUN – not sent',
		dryRun: true,
		operation: { operationId: 'updateContact', method: 'PUT', pathTemplate: '/v1/contacts/{id}', summary: payload.result.response.operation.summary },
		request: { method: 'PUT', path: '/v1/contacts/c1', query: { note: ['x'] } },
		contentType: '',
		headers: {},
		planned,
	});
	assert.equal(payload.result.viaJson, true);
	assert.equal(payload.dryRun, true);
	assert.deepEqual(payload.plannedWrites, [planned, { method: 'POST', path: '/v1/contacts', query: {}, operationId: 'createContact', contentType: 'application/json', body: { version: 0 } }]);
	// Only the read was sent, so a budget of 1 suffices.
	assert.equal(payload.requestCount, 1);
	assert.deepEqual(payload.requests.map(({ method, write, sent, status, dryRun }: Record<string, unknown>) => ({ method, write, sent, status, dryRun })), [
		{ method: 'GET', write: false, sent: true, status: 200, dryRun: undefined },
		{ method: 'PUT', write: true, sent: false, status: 0, dryRun: true },
		{ method: 'POST', write: true, sent: false, status: 0, dryRun: true },
	]);
});

test('a dry run plans writes the policy would block and flags why', async () => {
	const script = `async () => {
		const response = await lexware.request({ method: 'POST', path: '/v1/invoices', query: { finalize: true }, body: {} });
		return { ok: response.ok, blocked: response.planned.blocked };
	}`;

	const disabled = codeModeWith();
	const disabledPayload = payloadOf(await disabled.codeMode.execute(script, { maxRequests: 1, dryRun: true }));
	assert.equal(disabledPayload.result.ok, true);
	assert.match(disabledPayload.result.blocked, /writes are disabled by default/);
	assert.match(disabledPayload.plannedWrites[0].blocked, /writes are disabled by default/);

	const allowlisted = codeModeWith(undefined, { writesEnabled: true, writeAllow: parseWriteAllow('POST /v1/invoices') });
	assert.match(payloadOf(await allowlisted.codeMode.execute(script, { maxRequests: 1, dryRun: true })).result.blocked, /finalize=true is blocked/);

	assert.deepEqual([...disabled.fetched, ...allowlisted.fetched], []);
	assert.equal(disabledPayload.requestCount, 0);
});

test('a dry run hashes contentPath uploads and still enforces the upload dirs', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'lexware-dry-run-'));
	try {
		const bytes = Buffer.from('%PDF-dry-run');
		const receipt = join(dir, 'receipt.pdf');
		await writeFile(receipt, bytes);
		const upload = (contentPath: string) => `lexware.request({ method: 'POST', path: '/v1/files', multipart: [{ name: 'file', contentType: 'application/pdf', contentPath: ${JSON.stringify(contentPath)} }, { name: 'type', value: 'voucher' }] })`;
		const { codeMode, fetched } = codeModeWith(undefined, { uploadDirs: [dir] });

		const payload = payloadOf(await codeMode.execute(`async () => {
			const response = await ${upload(receipt)};
			const outside = await ${upload('/etc/hosts')}.catch((error) => error.message);
			return { dryRun: response.dryRun, outside };
		}`, { maxRequests: 1, dryRun: true }));

		assert.equal(payload.result.dryRun, true);
		assert.match(payload.result.outside, /outside the allowed upload directories/);
		assert.deepEqual(payload.plannedWrites.map(({ contentType, multipart }: Record<string, unknown>) => ({ contentType, multipart })), [{
			contentType: 'multipart/form-data',
			multipart: [
				{ name: 'file', filename: 'receipt.pdf', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: 'application/pdf' },
				{ name: 'type', value: 'voucher' },
			],
		}]);
		assert.deepEqual(fetched, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a dry run shrinks large planned bodies in plannedWrites but passes them whole to the script', async () => {
	const { codeMode } = codeModeWith(undefined, { writesEnabled: true });

	const payload = payloadOf(await codeMode.execute(`async () => {
		const items = Array.from({ length: 500 }, (_, index) => ({ name: 'Position ' + index, amount: index }));
		const response = await lexware.request({ method: 'POST', path: '/v1/vouchers', body: { voucherItems: items } });
		return response.planned.body.voucherItems.length;
	}`, { maxRequests: 1, dryRun: true }));

	assert.equal(payload.result, 500);
	const body = payload.plannedWrites[0].body;
	assert.ok(JSON.stringify(body, null, 2).length <= 4_000);
	assert.ok(body.truncated, 'expected a truncation hint');
});

test('lexware.uploadVoucherFile in a dry run plans the upload without fetching or waiting', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'lexware-dry-run-'));
	try {
		const bytes = Buffer.from('%PDF-helper');
		const receipt = join(dir, 'receipt.pdf');
		await writeFile(receipt, bytes);
		const { codeMode, fetched } = codeModeWith(undefined, { uploadDirs: [dir] });

		const startedAt = Date.now();
		const payload = payloadOf(await codeMode.execute(`async () => lexware.uploadVoucherFile({ contentPath: ${JSON.stringify(receipt)} })`, { maxRequests: 1, dryRun: true }));

		assert.ok(Date.now() - startedAt < 1_500, 'a dry-run upload must not wait for text recognition');
		assert.equal(payload.result.dryRun, true);
		assert.equal(payload.result.extraction, 'skipped');
		assert.equal(payload.result.planned.multipart[0].sha256, createHash('sha256').update(bytes).digest('hex'));
		assert.deepEqual(payload.plannedWrites, [payload.result.planned]);
		assert.deepEqual(fetched, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a dry run shows how bodies would be encoded', async () => {
	const { codeMode } = codeModeWith(undefined, { writesEnabled: true });
	const bytes = Buffer.from('<xml/>');

	const payload = payloadOf(await codeMode.execute(`async () => {
		await lexware.request({ method: 'POST', path: '/v1/contacts', body: 'true' });
		await lexware.request({ method: 'POST', path: '/v1/contacts', body: 'true', rawBody: true });
		await lexware.request({ method: 'POST', path: '/v1/contacts', bodyBase64: '${bytes.toString('base64')}', contentType: 'application/xml' });
	}`, { maxRequests: 1, dryRun: true }));

	assert.deepEqual(payload.plannedWrites.map(({ contentType, body, rawBody, bytes, sha256 }: Record<string, unknown>) => ({ contentType, body, rawBody, bytes, sha256 })), [
		{ contentType: 'application/json', body: 'true', rawBody: undefined, bytes: undefined, sha256: undefined },
		{ contentType: 'application/octet-stream', body: 'true', rawBody: true, bytes: undefined, sha256: undefined },
		{ contentType: 'application/xml', body: undefined, rawBody: undefined, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
	]);
});

test('a dry run lists concurrent writes in request order, even when an earlier one reads a file', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'lexware-dry-run-'));
	try {
		const receipt = join(dir, 'receipt.pdf');
		await writeFile(receipt, '%PDF');
		const { codeMode } = codeModeWith(undefined, { writesEnabled: true, uploadDirs: [dir] });

		const payload = payloadOf(await codeMode.execute(`async () => {
			await Promise.all([
				lexware.request({ method: 'POST', path: '/v1/files', multipart: [{ name: 'file', contentPath: ${JSON.stringify(receipt)} }] }),
				lexware.request({ method: 'POST', path: '/v1/contacts', body: {} }),
			]);
		}`, { maxRequests: 1, dryRun: true }));

		assert.deepEqual(payload.plannedWrites.map(({ path }: Record<string, unknown>) => path), ['/v1/files', '/v1/contacts']);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('a dry run caps the number of planned writes', async () => {
	const { codeMode } = codeModeWith(undefined, { writesEnabled: true });

	const result = await codeMode.execute(`async () => {
		for (let index = 0; index < 100; index += 1) await lexware.request({ method: 'POST', path: '/v1/contacts', body: { index } });
		await lexware.request({ method: 'POST', path: '/v1/files', multipart: [{ name: 'file', contentPath: '/tmp/receipt.pdf' }] });
	}`, { maxRequests: 1, dryRun: true });

	assert.equal(result.isError, true);
	const payload = payloadOf(result);
	assert.match(payload.error, /Dry run exceeded 100 planned writes/);
	// The 101 entries exceed the result limit together with the plans; `requests` stays whole.
	assert.ok(payload.truncated, 'expected plannedWrites to be shrunk');
	assert.equal(payload.requests.filter((entry: Record<string, unknown>) => entry.dryRun).length, 100);
	assert.deepEqual(payload.requests.at(-1), { ...payload.requests.at(-1), sent: false, error: 'Dry run exceeded 100 planned writes' });
});

test('a dry-run write cancelled while it is planned rejects its plan', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'lexware-dry-run-'));
	try {
		const receipt = join(dir, 'receipt.pdf');
		await writeFile(receipt, '%PDF');
		const client = new LexwareApiClient({ apiKey: 'test-key', uploadDirs: [dir], fetchImpl: async () => assert.fail('dry runs must not fetch') });
		const controller = new AbortController();
		let planning: Promise<unknown> | undefined;

		const request = client.request({ method: 'POST', path: '/v1/files', multipart: [{ name: 'file', contentPath: receipt }] }, {
			dryRun: true,
			signal: controller.signal,
			onPlanned: (write) => {
				planning = write;
				controller.abort();
			},
		});

		await assert.rejects(request, /cancelled/);
		assert.ok(planning);
		await assert.rejects(planning, /cancelled/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('without dryRun the result has no dryRun or plannedWrites fields', async () => {
	const { codeMode } = codeModeWith();

	const payload = payloadOf(await codeMode.execute(`async () => 1`, { maxRequests: 1 }));

	assert.equal('dryRun' in payload, false);
	assert.equal('plannedWrites' in payload, false);
});

test('a value set in one execute call can be read in the next, as a copy, without costing requests', async () => {
	const { codeMode, fetched } = codeModeWith();

	const first = payloadOf(await codeMode.execute(`async () => {
		const job = { ids: ['a', 'b', 'c'], cursor: 0, totalCents: 0 };
		await state.set('job', job);
		job.cursor = 99;
		return { stored: await state.get('job'), keys: await state.keys() };
	}`, { maxRequests: 1 }));
	assert.deepEqual(first.result, { stored: { ids: ['a', 'b', 'c'], cursor: 0, totalCents: 0 }, keys: ['job'] });

	const second = payloadOf(await codeMode.execute(`async () => {
		const job = await state.get('job');
		job.cursor += 2;
		job.totalCents += 1250;
		await state.set('job', job);
		return { job, missing: await state.get('nope') };
	}`, { maxRequests: 1 }));
	assert.deepEqual(second.result, { job: { ids: ['a', 'b', 'c'], cursor: 2, totalCents: 1250 } });

	const third = payloadOf(await codeMode.execute(`async () => { await state.delete('job'); return { job: await state.get('job'), keys: await state.keys() }; }`, { maxRequests: 1 }));
	assert.deepEqual(third.result, { keys: [] });
	assert.equal(fetched.length, 0);
	assert.equal(third.requestCount, 0);
});

test('state.set rejects values that are not JSON-serializable', async () => {
	const { codeMode } = codeModeWith();

	const payload = payloadOf(await codeMode.execute(`async () => {
		const attempt = (value) => state.set('k', value).then(() => 'stored', (error) => error.message);
		const cyclic = {};
		cyclic.self = cyclic;
		return {
			undefinedValue: await attempt(undefined),
			fn: await attempt(() => 1),
			cyclic: await attempt(cyclic),
			bigint: await attempt(1n),
			badKey: await state.set('', 1).then(() => 'stored', (error) => error.message),
			keys: await state.keys(),
		};
	}`, { maxRequests: 1 }));

	assert.match(payload.result.undefinedValue, /state\.set: the value for "k" is not JSON-serializable \(undefined\)\. Use state\.delete/);
	assert.match(payload.result.fn, /not JSON-serializable \(function\)/);
	assert.match(payload.result.cyclic, /not JSON-serializable: .*circular/i);
	assert.match(payload.result.bigint, /not JSON-serializable: /);
	assert.match(payload.result.badKey, /state\.set expects a key of 1 to 256 characters, got 0 characters/);
	assert.deepEqual(payload.result.keys, []);
});

test('state size limits are enforced with clear errors', async () => {
	const { codeMode } = codeModeWith(undefined, {}, { state: new SandboxState({ limits: { maxValueBytes: 100, maxTotalBytes: 150 } }) });

	const payload = payloadOf(await codeMode.execute(`async () => {
		await state.set('a', 'x'.repeat(90));
		const tooBig = await state.set('b', 'x'.repeat(200)).then(() => 'stored', (error) => error.message);
		const tooMuch = await state.set('b', 'x'.repeat(90)).then(() => 'stored', (error) => error.message);
		return { tooBig, tooMuch, keys: await state.keys() };
	}`, { maxRequests: 1 }));

	assert.match(payload.result.tooBig, /the value for "b" is 202 B serialized; the limit is 100 B per value/);
	assert.match(payload.result.tooMuch, /storing "b" would grow the state to 186 B; the limit is 150 B in total/);
	assert.deepEqual(payload.result.keys, ['a']);
});

test('an uncaught state error fails the execution', async () => {
	const { codeMode } = codeModeWith();

	const result = await codeMode.execute(`async () => { await state.set('k', undefined); }`, { maxRequests: 1 });

	assert.equal(result.isError, true);
	assert.match(payloadOf(result).error, /not JSON-serializable/);
});

test('state is not reachable from search', async () => {
	const { codeMode } = codeModeWith();
	await codeMode.execute(`async () => state.set('secret', 1)`, { maxRequests: 1 });

	const payload = payloadOf(await codeMode.search(`async () => ({ state: typeof state, host: Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('__')) })`));

	assert.deepEqual(payload.result, { state: 'undefined', host: ['__capabilitiesJson'] });
});

test('a dry run reads the stored state but discards its changes', async () => {
	const { codeMode } = codeModeWith();
	await codeMode.execute(`async () => state.set('job', { cursor: 0 })`, { maxRequests: 1 });

	const dry = payloadOf(await codeMode.execute(`async () => {
		const job = await state.get('job');
		await state.set('job', { cursor: job.cursor + 20 });
		await state.set('scratch', 1);
		await state.delete('missing');
		return { seen: job, afterSet: await state.get('job'), keys: await state.keys() };
	}`, { maxRequests: 1, dryRun: true }));
	assert.deepEqual(dry.result, { seen: { cursor: 0 }, afterSet: { cursor: 20 }, keys: ['job', 'scratch'] });

	const real = payloadOf(await codeMode.execute(`async () => ({ job: await state.get('job'), keys: await state.keys() })`, { maxRequests: 1 }));
	assert.deepEqual(real.result, { job: { cursor: 0 }, keys: ['job'] });
});

test('the host rejects non-JSON text sent to the state host function directly', async () => {
	const { codeMode } = codeModeWith();

	const payload = payloadOf(await codeMode.execute(`async () => ({
		direct: await globalThis.__stateJson(JSON.stringify({ op: 'set', key: 'k', json: '{not json' })).then(() => 'stored', (error) => error.message),
		unknownOp: await globalThis.__stateJson(JSON.stringify({ op: 'clear' })).then(() => 'ok', (error) => error.message),
		keys: await state.keys(),
	})`, { maxRequests: 1 }));

	assert.deepEqual(payload.result, { direct: 'state.set expects a JSON-serializable value', unknownOp: 'Unknown state operation: clear', keys: [] });
});
