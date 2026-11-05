import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
const toolsListSnapshot = join(dirname(fileURLToPath(import.meta.url)), '../src/tools-list.snapshot.json');

interface ListedTool {
	name: string;
	description: string;
	inputSchema: { properties: Record<string, { description?: string }> };
	annotations: Record<string, boolean>;
}

interface ListedPrompt {
	name: string;
	arguments?: Array<{ name: string; required?: boolean }>;
}

interface JsonRpcResponse {
	id: number;
	result?: {
		structuredContent?: Record<string, unknown>;
		isError?: boolean;
		tools?: ListedTool[];
		prompts?: ListedPrompt[];
		messages?: Array<{ role: string; content: { type: string; text: string } }>;
		instructions?: string;
	};
	error?: { code: number; message: string };
}

// Request _meta claim of protocol revision 2026-07-28 (server/discover era).
const modernMeta = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientCapabilities': {},
	'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
};

// Fake Lexware API on a random local port.
async function startFakeLexware(handler: (req: IncomingMessage, res: ServerResponse) => void) {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

// Spawns the built stdio server and speaks raw JSON-RPC: the 2025-era initialize handshake, or with
// era 'modern' a server/discover opening and the _meta claim on every request.
async function startMcp(baseUrl: string, env: Record<string, string> = {}, era: '2025' | 'modern' = '2025') {
	const child = spawn(process.execPath, [serverEntry], {
		env: { ...process.env, LEXWARE_OFFICE_API_KEY: 'test-key', LEXWARE_OFFICE_API_BASE_URL: baseUrl, LEXWARE_OFFICE_ALLOW_WRITES: 'false', ...env },
		stdio: ['pipe', 'pipe', 'ignore'],
	});
	const pending = new Map<number, (message: JsonRpcResponse) => void>();
	let buffer = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length === 0) continue;
			const message = JSON.parse(line) as JsonRpcResponse;
			pending.get(message.id)?.(message);
			pending.delete(message.id);
		}
	});
	const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
	let nextId = 1;
	const timers = new Set<NodeJS.Timeout>();
	const close = () => {
		for (const timer of timers) clearTimeout(timer);
		child.kill();
	};
	const request = (method: string, params: Record<string, unknown>) => {
		const id = nextId++;
		// Rejects instead of hanging the whole test run when a response never arrives; close() drops the timer.
		const response = new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`no response to ${method} within 10s`)), 10_000);
			timers.add(timer);
			pending.set(id, (message) => { clearTimeout(timer); timers.delete(timer); resolve(message); });
		});
		send({ id, method, params: era === 'modern' ? { ...params, _meta: modernMeta } : params });
		return { id, response };
	};

	if (era === 'modern') {
		const discovered = await request('server/discover', {}).response;
		return { initialized: discovered, request, send, close };
	}
	const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }).response;
	send({ method: 'notifications/initialized' });
	return { initialized, request, send, close };
}

const callExecute = (mcp: Awaited<ReturnType<typeof startMcp>>, code: string) =>
	mcp.request('tools/call', { name: 'execute', arguments: { code } });

test('server lists exactly search and execute with docs and write-mode annotations', async () => {
	const lexware = await startFakeLexware((_req, res) => res.end());
	const mcp = await startMcp(lexware.baseUrl);
	try {
		const { result } = await mcp.request('tools/list', {}).response;
		const tools = result?.tools ?? [];

		assert.deepEqual(tools.map((tool) => tool.name), ['search', 'execute']);
		const [search, execute] = tools;
		assert.match(search.description, /spec\.info\.domainIndex: compact map/);
		assert.match(search.description, /spec\.info\.writesEnabled/);
		assert.match(search.description, /spec\.info\.account: the connected organization/);
		assert.match(execute.description, /lexware\.request returns all HTTP responses/);
		assert.match(execute.description, /multipart\?: MultipartPart\[\]/);
		assert.match(execute.description, /contentPath.*LEXWARE_OFFICE_UPLOAD_DIRS/);
		assert.match(execute.description, /The tool result includes requests/);
		assert.match(execute.description, /maxRequests bounds the HTTP attempts actually sent to Lexware, including automatic 429 retries/);
		assert.match(execute.inputSchema.properties.maxRequests?.description ?? '', /including automatic 429 retries/);
		// Started with LEXWARE_OFFICE_ALLOW_WRITES=false.
		assert.equal(execute.annotations.readOnlyHint, true);
		assert.equal(execute.annotations.destructiveHint, false);
	} finally {
		mcp.close();
		lexware.close();
	}
});

// Everything the model sees before its first call. Diff against a checked-in snapshot so description or schema
// changes are always deliberate.
test('instructions, tools/list and prompts/list match the snapshot in read-only and writes-enabled mode', async () => {
	const lexware = await startFakeLexware((_req, res) => res.end());
	const actual: Record<string, unknown> = {};
	try {
		for (const [mode, allowWrites] of [['readOnly', 'false'], ['writesEnabled', 'true']]) {
			const mcp = await startMcp(lexware.baseUrl, { LEXWARE_OFFICE_ALLOW_WRITES: allowWrites });
			try {
				const { result } = await mcp.request('tools/list', {}).response;
				const { result: promptsResult } = await mcp.request('prompts/list', {}).response;
				actual[mode] = { instructions: mcp.initialized.result?.instructions, tools: result?.tools, prompts: promptsResult?.prompts };
			} finally {
				mcp.close();
			}
		}
	} finally {
		lexware.close();
	}

	if (process.env.UPDATE_SNAPSHOTS === '1') {
		writeFileSync(toolsListSnapshot, `${JSON.stringify(actual, null, '\t')}\n`);
	}
	assert.deepEqual(
		actual,
		JSON.parse(readFileSync(toolsListSnapshot, 'utf8')),
		'Model-facing instructions, tools or prompts changed. If intended, run `UPDATE_SNAPSHOTS=1 pnpm test` and commit src/tools-list.snapshot.json.',
	);
});

test('prompts/list and prompts/get serve the workflow prompts in both protocol eras', async () => {
	const lexware = await startFakeLexware((_req, res) => res.end());
	try {
		for (const era of ['2025', 'modern'] as const) {
			const mcp = await startMcp(lexware.baseUrl, {}, era);
			try {
				const { result: listed } = await mcp.request('prompts/list', {}).response;
				assert.deepEqual(listed?.prompts?.map((prompt) => prompt.name), ['upload-receipts', 'revenue-report', 'profit-report', 'create-invoice'], era);

				const { result } = await mcp.request('prompts/get', { name: 'revenue-report', arguments: { dateFrom: '2026-01-01', dateTo: '2026-12-31', basis: 'paid' } }).response;
				assert.equal(result?.messages?.length, 1, era);
				assert.equal(result?.messages?.[0]?.role, 'user', era);
				assert.match(result?.messages?.[0]?.content.text ?? '', /Period: voucherDate 2026-01-01 to 2026-12-31\./, era);
				assert.match(result?.messages?.[0]?.content.text ?? '', /spec\.workflows\.calculatePaidRevenue/, era);

				const { error } = await mcp.request('prompts/get', { name: 'revenue-report', arguments: { basis: 'gross' } }).response;
				assert.ok(error, `${era}: an invalid basis is rejected`);

				const { result: partial, error: partialError } = await mcp.request('prompts/get', { name: 'revenue-report', arguments: { dateFrom: '2026-01-01', dateTo: '', basis: '' } }).response;
				assert.equal(partialError, undefined, `${era}: empty arguments are accepted`);
				assert.match(partial?.messages?.[0]?.content.text ?? '', /Period: voucherDate from 2026-01-01\. Ask the user for the end date/, era);
			} finally {
				mcp.close();
			}
		}
	} finally {
		lexware.close();
	}
});

test('write prompts follow the server write mode', async () => {
	const lexware = await startFakeLexware((_req, res) => res.end());
	try {
		for (const [allowWrites, readOnly] of [['false', true], ['true', false]] as const) {
			const mcp = await startMcp(lexware.baseUrl, { LEXWARE_OFFICE_ALLOW_WRITES: allowWrites });
			try {
				const { result } = await mcp.request('prompts/get', { name: 'upload-receipts', arguments: {} }).response;
				const text = result?.messages?.[0]?.content.text ?? '';
				assert.equal(text.startsWith('This server is read-only'), readOnly, allowWrites);
			} finally {
				mcp.close();
			}
		}
	} finally {
		lexware.close();
	}
});

test('execute stays destructive when writes are narrowed by LEXWARE_OFFICE_WRITE_ALLOW', async () => {
	const lexware = await startFakeLexware((_req, res) => res.end());
	const mcp = await startMcp(lexware.baseUrl, { LEXWARE_OFFICE_ALLOW_WRITES: 'true', LEXWARE_OFFICE_WRITE_ALLOW: 'uploadFile' });
	try {
		const { result } = await mcp.request('tools/list', {}).response;
		const execute = result?.tools?.find((tool) => tool.name === 'execute');
		assert.equal(execute?.annotations.readOnlyHint, false);
		assert.equal(execute?.annotations.destructiveHint, true);
	} finally {
		mcp.close();
		lexware.close();
	}
});

test('server exits at startup with a readable error for an invalid LEXWARE_OFFICE_WRITE_ALLOW', () => {
	const result = spawnSync(process.execPath, [serverEntry], {
		env: { ...process.env, LEXWARE_OFFICE_ALLOW_WRITES: 'true', LEXWARE_OFFICE_WRITE_ALLOW: 'POST /v1/files, PUT /v1/nope' },
		input: '',
		encoding: 'utf8',
	});

	assert.equal(result.status, 1);
	assert.match(result.stderr, /^Lexware Office MCP server: LEXWARE_OFFICE_WRITE_ALLOW entry "PUT \/v1\/nope" does not match a cataloged write/);
	assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('execute reports per-attempt requests on success', async () => {
	const lexware = await startFakeLexware((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
	});
	const mcp = await startMcp(lexware.baseUrl);
	try {
		const { response } = callExecute(mcp, 'async () => (await lexware.request({ path: "/v1/countries" })).status');
		const { result } = await response;

		assert.equal(result?.isError, undefined);
		assert.equal(result?.structuredContent?.result, 200);
		assert.equal(result?.structuredContent?.requestCount, 1);
		assert.deepEqual(
			(result?.structuredContent?.requests as Array<Record<string, unknown>>).map(({ durationMs: _, ...entry }) => entry),
			[{ method: 'GET', path: '/v1/countries', status: 200, ok: true, write: false, sent: true }],
		);
	} finally {
		mcp.close();
		lexware.close();
	}
});

test('failing execute still reports requests made before the error', async () => {
	const lexware = await startFakeLexware((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
	});
	const mcp = await startMcp(lexware.baseUrl);
	try {
		const { response } = callExecute(mcp, `async () => {
			await lexware.request({ path: '/v1/contacts' });
			await lexware.request({ method: 'POST', path: '/v1/contacts', body: {} }).catch(() => {});
			throw new Error('boom');
		}`);
		const { result } = await response;

		assert.equal(result?.isError, true);
		assert.match(String(result?.structuredContent?.error), /boom/);
		// The blocked write was never sent, so it does not count.
		assert.equal(result?.structuredContent?.requestCount, 1);
		const requests = result?.structuredContent?.requests as Array<Record<string, unknown>>;
		assert.deepEqual(requests.map(({ method, path, status, write }) => ({ method, path, status, write })), [
			{ method: 'GET', path: '/v1/contacts', status: 200, write: false },
			{ method: 'POST', path: '/v1/contacts', status: undefined, write: true },
		]);
		assert.match(String(requests[1]?.error), /blocked: writes are disabled/);
	} finally {
		mcp.close();
		lexware.close();
	}
});

test('reference data is cached across execute calls unless LEXWARE_OFFICE_CACHE=off', async () => {
	for (const [env, expectedHits] of [[{}, 1], [{ LEXWARE_OFFICE_CACHE: 'off' }, 2]] as const) {
		let countriesHits = 0;
		const lexware = await startFakeLexware((req, res) => {
			if (req.url === '/v1/countries') countriesHits += 1;
			res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
		});
		const mcp = await startMcp(lexware.baseUrl, env);
		try {
			await callExecute(mcp, 'async () => (await lexware.request({ path: "/v1/countries" })).cached').response;
			const { result } = await callExecute(mcp, 'async () => (await lexware.request({ path: "/v1/countries" })).cached ?? false').response;
			assert.equal(countriesHits, expectedHits, JSON.stringify(env));
			assert.equal(result?.structuredContent?.result, expectedHits === 1);
			assert.equal(result?.structuredContent?.requestCount, expectedHits === 1 ? 0 : 1);
		} finally {
			mcp.close();
			lexware.close();
		}
	}
});

test('client cancellation aborts the in-flight Lexware request', async () => {
	let received!: () => void;
	const requestReceived = new Promise<void>((resolve) => { received = resolve; });
	let aborted!: () => void;
	const requestAborted = new Promise<void>((resolve) => { aborted = resolve; });
	const lexware = await startFakeLexware((_req, res) => {
		// Never respond; resolve once the server side sees the connection dropped.
		res.on('close', aborted);
		received();
	});
	const mcp = await startMcp(lexware.baseUrl);
	try {
		const { id } = callExecute(mcp, 'async () => lexware.request({ path: "/v1/contacts" })');
		await requestReceived;
		mcp.send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'test' } });

		const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000).unref());
		assert.equal(await Promise.race([requestAborted.then(() => 'aborted'), timeout]), 'aborted');
	} finally {
		mcp.close();
		lexware.close();
	}
});
