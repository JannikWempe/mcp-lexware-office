import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), 'index.js');

interface JsonRpcResponse {
	id: number;
	result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
	error?: unknown;
}

// Fake Lexware API on a random local port.
async function startFakeLexware(handler: (req: IncomingMessage, res: ServerResponse) => void) {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

// Spawns the built stdio server and speaks raw JSON-RPC (2025-era initialize handshake).
async function startMcp(baseUrl: string) {
	const child = spawn(process.execPath, [serverEntry], {
		env: { ...process.env, LEXWARE_OFFICE_API_KEY: 'test-key', LEXWARE_OFFICE_API_BASE_URL: baseUrl, LEXWARE_OFFICE_ALLOW_WRITES: 'false' },
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
	const request = (method: string, params: Record<string, unknown>) => {
		const id = nextId++;
		const response = new Promise<JsonRpcResponse>((resolve) => pending.set(id, resolve));
		send({ id, method, params });
		return { id, response };
	};

	await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }).response;
	send({ method: 'notifications/initialized' });
	return { request, send, close: () => child.kill() };
}

const callExecute = (mcp: Awaited<ReturnType<typeof startMcp>>, code: string) =>
	mcp.request('tools/call', { name: 'execute', arguments: { code } });

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
			[{ method: 'GET', path: '/v1/countries', status: 200, ok: true, write: false }],
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
			await lexware.request({ path: '/v1/profile' });
			await lexware.request({ method: 'POST', path: '/v1/contacts', body: {} }).catch(() => {});
			throw new Error('boom');
		}`);
		const { result } = await response;

		assert.equal(result?.isError, true);
		assert.match(String(result?.structuredContent?.error), /boom/);
		assert.equal(result?.structuredContent?.requestCount, 2);
		const requests = result?.structuredContent?.requests as Array<Record<string, unknown>>;
		assert.deepEqual(requests.map(({ method, path, status, write }) => ({ method, path, status, write })), [
			{ method: 'GET', path: '/v1/profile', status: 200, write: false },
			{ method: 'POST', path: '/v1/contacts', status: undefined, write: true },
		]);
		assert.match(String(requests[1]?.error), /blocked: writes are disabled/);
	} finally {
		mcp.close();
		lexware.close();
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
