import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/server';

import type { AccountInfo } from './account.js';
import { CodeMode } from './code-mode.js';
import { LexwareApiClient, type LexwareClientOptions } from './lexware-client.js';
import { parseWriteAllow } from './write-policy.js';

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json', ...headers },
});

const stubAccount: AccountInfo = { organizationId: 'org-1', companyName: 'Testfirma GmbH' };

// CodeMode over the real QuickJsExecutor and a LexwareApiClient whose fetch is faked.
// `fetched` records every attempt that actually reached fetch. The account is stubbed unless
// `realAccount` is set, so the profile lookup doesn't show up in `fetched`.
const codeModeWith = (handler: (path: string) => Response | Promise<Response> = () => jsonResponse(200, {}), options: LexwareClientOptions = {}, realAccount = false) => {
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
	return { codeMode: new CodeMode({ client, account: realAccount ? undefined : { get: async () => stubAccount } }), fetched };
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
	const { codeMode, fetched } = codeModeWith(undefined, {}, true);
	const controller = new AbortController();
	controller.abort();

	const result = await codeMode.execute(`async () => lexware.request({ path: '/v1/countries' })`, { maxRequests: 1, signal: controller.signal });

	assert.equal(result.isError, true);
	assert.match(payloadOf(result).error, /Execution cancelled by client/);
	assert.equal(fetched.length, 0);
});

test('spec.info.account comes from one profile lookup that bypasses the execute budget and audit log', async () => {
	const { codeMode, fetched } = codeModeWith((path) => jsonResponse(200, path === '/v1/profile' ? { organizationId: 'org-1', companyName: 'Testfirma GmbH', taxType: 'net', smallBusiness: true, created: { userEmail: 'a@b.test' } } : {}), {}, true);

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
	const { codeMode, fetched } = codeModeWith(undefined, { apiKey: undefined }, true);

	const result = await codeMode.search(`async () => ({ account: spec.info.account, hasContacts: 'contacts' in spec.info.domainIndex })`);

	assert.equal(result.isError, undefined);
	assert.deepEqual(payloadOf(result).result, { account: { error: 'profile unavailable: no API key configured' }, hasContacts: true });
	assert.deepEqual(fetched, []);
});

test('cancelling while the profile loads ends the call without waiting for it', async () => {
	// The hanging profile fetch outlives the cancellation; requestTimeoutMs only keeps it from lingering.
	const { codeMode } = codeModeWith(() => new Promise<Response>(() => {}), { requestTimeoutMs: 200 }, true);
	const controller = new AbortController();

	const pending = codeMode.search(`async () => 1`, { signal: controller.signal });
	setTimeout(() => controller.abort(), 10);
	const result = await pending;

	assert.equal(result.isError, true);
	assert.match(payloadOf(result).error, /Execution cancelled by client/);
});
