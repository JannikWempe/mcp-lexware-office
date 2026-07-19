import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { QuickJsExecutor } from './executor.js';
import { LexwareApiClient, writesEnabled } from './lexware-client.js';
import { lexwareSpec } from './lexware-spec.js';
import { stringifyForMcp, truncateText } from './truncate.js';

interface FetchCall {
	input: RequestInfo | URL;
	init?: RequestInit;
}

const responseFor = (status: number, body: BodyInit | null, headers: HeadersInit = {}, statusText = '') => new Response(body, {
	status,
	statusText,
	headers,
});

const clientWithCalls = (handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) => {
	const calls: FetchCall[] = [];
	const client = new LexwareApiClient({
		apiKey: 'test-key',
		baseUrl: 'https://example.test',
		rateLimitIntervalMs: 0,
		fetchImpl: async (input, init) => {
			calls.push({ input, init });
			return handler(input, init);
		},
	});
	return { client, calls };
};

test('server registers exactly search and execute tools', async () => {
	const source = await readFile('src/index.ts', 'utf8');
	const tools = [...source.matchAll(/server\.tool\(\n\t'([^']+)'/g)].map((match) => match[1]);

	assert.deepEqual(tools, ['search', 'execute']);
	assert.doesNotMatch(source, /get-revenue-summary|allowWrite/);
	assert.match(source, /spec\.info\.domainIndex: compact map/);
	assert.match(source, /lexware\.request returns all HTTP responses/);
});

test('execute sandbox exposes generic request but not API key or Node globals', async () => {
	process.env.LEXWARE_OFFICE_API_KEY = 'super-secret-test-key';
	const execution = await new QuickJsExecutor().execute(
		`async () => ({
			lexwareType: typeof lexware,
			requestType: typeof lexware.request,
			processType: typeof process,
			fetchType: typeof fetch,
			requireType: typeof require,
			secretVisible: Object.getOwnPropertyNames(globalThis).join(',').includes('super-secret-test-key')
		})`,
		{ spec: {} },
		{
			hostFunctions: {
				__lexwareRequestJson: async () => JSON.stringify({ ok: true, status: 200, statusText: 'OK', request: { method: 'GET', path: '/v1/countries', query: {} }, contentType: 'application/json', headers: {}, data: {} }),
			},
		},
	);

	assert.equal(execution.error, undefined);
	assert.deepEqual(execution.result, {
		lexwareType: 'object',
		requestType: 'function',
		processType: 'undefined',
		fetchType: 'undefined',
		requireType: 'undefined',
		secretVisible: false,
	});
});

test('unknown relative /v1 paths are allowed and return request metadata without operation metadata', async () => {
	const { client, calls } = clientWithCalls(async () => responseFor(200, JSON.stringify({ ok: true }), { 'content-type': 'application/json' }, 'OK'));

	const response = await client.request({ path: '/v1/not-in-catalog?from=url', query: { q: 'search', repeated: [1, 2] } });

	assert.equal(response.ok, true);
	assert.equal(response.status, 200);
	assert.equal(response.operation, undefined);
	assert.deepEqual(response.request, {
		method: 'GET',
		path: '/v1/not-in-catalog',
		query: { from: ['url'], q: ['search'], repeated: ['1', '2'] },
	});
	assert.equal(String(calls[0]?.input), 'https://example.test/v1/not-in-catalog?from=url&q=search&repeated=1&repeated=2');
});

test('catalog matches include operation metadata but unknown query parameters no longer block execution', async () => {
	const { client } = clientWithCalls(async () => responseFor(200, JSON.stringify([]), { 'content-type': 'application/json' }, 'OK'));

	const response = await client.request({ path: '/v1/countries', query: { undocumented: true } });

	assert.equal(response.operation?.operationId, 'listCountries');
	assert.deepEqual(response.request.query, { undocumented: ['true'] });
});

test('absolute URLs, protocol-relative URLs, and /v1 escapes are rejected before fetch', async () => {
	const { client, calls } = clientWithCalls(async () => responseFor(200, '{}'));

	await assert.rejects(() => client.request({ path: 'https://evil.test/v1/countries' }), /path must start with \/|relative/);
	await assert.rejects(() => client.request({ path: '//evil.test/v1/countries' }), /relative to the Lexware API host/);
	await assert.rejects(() => client.request({ path: '/v1/../admin' }), /must resolve to \/v1\//);
	assert.equal(calls.length, 0);
});

test('server is read-only by default: writes blocked without ALLOW_WRITES=true', async () => {
	const originalReadOnly = process.env.LEXWARE_OFFICE_READ_ONLY;
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	try {
		delete process.env.LEXWARE_OFFICE_READ_ONLY;
		delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		const { client } = clientWithCalls(async () => responseFor(204, null, {}, 'No Content'));

		// Default: writes are blocked.
		await assert.rejects(() => client.request({ method: 'PATCH', path: '/v1/custom-resource/123', body: { archived: true } }), /writes are disabled by default/);
		await assert.rejects(() => client.request({ method: 'POST', path: '/v1/contacts', body: {} }), /writes are disabled by default/);
	} finally {
		if (originalReadOnly === undefined) delete process.env.LEXWARE_OFFICE_READ_ONLY;
		else process.env.LEXWARE_OFFICE_READ_ONLY = originalReadOnly;
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('ALLOW_WRITES=true enables writes when READ_ONLY is not set', async () => {
	const originalReadOnly = process.env.LEXWARE_OFFICE_READ_ONLY;
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	try {
		delete process.env.LEXWARE_OFFICE_READ_ONLY;
		process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
		const { client, calls } = clientWithCalls(async () => responseFor(204, null, {}, 'No Content'));

		const response = await client.request({ method: 'PATCH', path: '/v1/custom-resource/123', body: { archived: true } });
		assert.equal(response.status, 204);
		assert.equal(calls[0]?.init?.method, 'PATCH');
	} finally {
		if (originalReadOnly === undefined) delete process.env.LEXWARE_OFFICE_READ_ONLY;
		else process.env.LEXWARE_OFFICE_READ_ONLY = originalReadOnly;
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('READ_ONLY=true blocks writes even when ALLOW_WRITES=true', async () => {
	const originalReadOnly = process.env.LEXWARE_OFFICE_READ_ONLY;
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	try {
		process.env.LEXWARE_OFFICE_READ_ONLY = 'true';
		process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
		const { client } = clientWithCalls(async () => responseFor(204, null, {}, 'No Content'));

		await assert.rejects(() => client.request({ method: 'POST', path: '/v1/contacts', body: {} }), /writes are disabled by default/);
	} finally {
		if (originalReadOnly === undefined) delete process.env.LEXWARE_OFFICE_READ_ONLY;
		else process.env.LEXWARE_OFFICE_READ_ONLY = originalReadOnly;
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('JSON, custom content type, and raw body serialization are supported', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const { client, calls } = clientWithCalls(async () => responseFor(200, JSON.stringify({ received: true }), { 'content-type': 'application/json' }, 'OK'));

		await client.request({ method: 'POST', path: '/v1/contacts', contentType: 'application/vnd.lexware+json', body: { name: 'Ada' } });
		assert.equal((calls[0]?.init?.headers as Record<string, string>)['Content-Type'], 'application/vnd.lexware+json');
		assert.equal(calls[0]?.init?.body, JSON.stringify({ name: 'Ada' }));

		const multipart = '--boundary\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello\r\n--boundary\r\nContent-Disposition: form-data; name="type"\r\n\r\nvoucher\r\n--boundary--\r\n';
		await client.request({ method: 'POST', path: '/v1/files', contentType: 'multipart/form-data; boundary=boundary', rawBody: true, body: multipart });
		assert.equal((calls[1]?.init?.headers as Record<string, string>)['Content-Type'], 'multipart/form-data; boundary=boundary');
		assert.equal(calls[1]?.init?.body, multipart);
		// type=voucher must be a multipart form field, not a query parameter
		assert.match(calls[1]?.init?.body as string, /Content-Disposition: form-data; name="file"; filename="[^"]+"/);
		assert.match(calls[1]?.init?.body as string, /Content-Disposition: form-data; name="type"/);
		assert.match(calls[1]?.init?.body as string, /\r\nvoucher\r\n/);
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('bodyBase64 is decoded to binary Buffer and sent with correct Content-Type', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const receivedBodies: BodyInit[] = [];
		const { client } = clientWithCalls(async (_input, init) => {
			if (init?.body !== undefined) receivedBodies.push(init.body as BodyInit);
			return responseFor(200, JSON.stringify({ ok: true }), { 'content-type': 'application/json' }, 'OK');
		});

		// 3 bytes: 0x01 0x02 0x03 → base64 "AQID"
		await client.request({
			method: 'POST',
			path: '/v1/not-in-catalog',
			bodyBase64: 'AQID',
			contentType: 'application/pdf',
		});

		assert.equal(receivedBodies.length, 1);
		assert.ok(receivedBodies[0] instanceof Buffer, 'body must be a Buffer, not a string');
		assert.deepEqual(Array.from(receivedBodies[0] as Buffer), [0x01, 0x02, 0x03]);
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('bodyBase64 defaults Content-Type to application/octet-stream when not specified', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const { client, calls } = clientWithCalls(async () => responseFor(200, JSON.stringify({ ok: true }), { 'content-type': 'application/json' }, 'OK'));

		await client.request({ method: 'POST', path: '/v1/not-in-catalog', bodyBase64: 'AQID' });

		assert.equal((calls[0]?.init?.headers as Record<string, string>)['Content-Type'], 'application/octet-stream');
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('multipart with contentBase64 decodes binary part to Blob in FormData', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const receivedBodies: BodyInit[] = [];
		const { client } = clientWithCalls(async (_input, init) => {
			if (init?.body !== undefined) receivedBodies.push(init.body as BodyInit);
			return responseFor(200, JSON.stringify({ id: 'file-id' }), { 'content-type': 'application/json' }, 'OK');
		});

		// 3 bytes: 0x01 0x02 0x03 → base64 "AQID"
		await client.request({
			method: 'POST',
			path: '/v1/files',
			multipart: [
				{ name: 'file', filename: 'receipt.pdf', contentType: 'application/pdf', contentBase64: 'AQID' },
				{ name: 'type', value: 'voucher' },
			],
		});

		assert.equal(receivedBodies.length, 1);
		assert.ok(receivedBodies[0] instanceof FormData, 'body must be FormData for multipart uploads');

		const formData = receivedBodies[0] as FormData;
		const fileEntry = formData.get('file');
		const typeEntry = formData.get('type');

		assert.ok(fileEntry instanceof Blob, 'binary multipart part must be a Blob');
		assert.equal((fileEntry as Blob).type, 'application/pdf');
		assert.equal(typeEntry, 'voucher');

		const fileBytes = new Uint8Array(await (fileEntry as Blob).arrayBuffer());
		assert.deepEqual(Array.from(fileBytes), [0x01, 0x02, 0x03]);
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('multipart with only string value parts sends FormData without binary blobs', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const receivedBodies: BodyInit[] = [];
		const { client } = clientWithCalls(async (_input, init) => {
			if (init?.body !== undefined) receivedBodies.push(init.body as BodyInit);
			return responseFor(200, JSON.stringify({ id: 'file-id' }), { 'content-type': 'application/json' }, 'OK');
		});

		await client.request({
			method: 'POST',
			path: '/v1/files',
			multipart: [
				{ name: 'type', value: 'voucher' },
				{ name: 'note', value: 'test upload' },
			],
		});

		assert.equal(receivedBodies.length, 1);
		assert.ok(receivedBodies[0] instanceof FormData, 'body must be FormData');
		const formData = receivedBodies[0] as FormData;
		assert.equal(formData.get('type'), 'voucher');
		assert.equal(formData.get('note'), 'test upload');
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('bodyBase64 and body/multipart are mutually exclusive', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const { client } = clientWithCalls(async () => responseFor(200, '{}'));

		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', bodyBase64: 'AQID', body: { x: 1 } }),
			/At most one of body, bodyBase64, or multipart may be set/,
		);
		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', bodyBase64: 'AQID', multipart: [{ name: 'type', value: 'voucher' }] }),
			/At most one of body, bodyBase64, or multipart may be set/,
		);
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('invalid base64 in bodyBase64 or contentBase64 is rejected before fetch', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const { client, calls } = clientWithCalls(async () => responseFor(200, '{}'));

		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', bodyBase64: 'not!valid@base64#' }),
			/bodyBase64 must be a valid base64/,
		);
		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', multipart: [{ name: 'file', filename: 'f.pdf', contentBase64: '!!!' }] }),
			/contentBase64 must be a valid base64/,
		);
		assert.equal(calls.length, 0);
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('multipart with contentPath reads the file host-side and echoes sent bytes/sha256', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	const dir = await mkdtemp(join(tmpdir(), 'lexware-upload-'));
	try {
		const fileBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x01, 0x02, 0x03]); // "%PDF" + binary
		const filePath = join(dir, 'receipt beleg.pdf');
		await writeFile(filePath, fileBytes);

		const receivedBodies: BodyInit[] = [];
		const { client } = clientWithCalls(async (_input, init) => {
			if (init?.body !== undefined) receivedBodies.push(init.body as BodyInit);
			return responseFor(200, JSON.stringify({ id: 'file-id' }), { 'content-type': 'application/json' }, 'OK');
		});

		const response = await client.request({
			method: 'POST',
			path: '/v1/files',
			multipart: [
				{ name: 'file', contentType: 'application/pdf', contentPath: filePath },
				{ name: 'type', value: 'voucher' },
			],
		});

		assert.ok(receivedBodies[0] instanceof FormData, 'body must be FormData');
		const formData = receivedBodies[0] as FormData;
		const fileEntry = formData.get('file');
		assert.ok(fileEntry instanceof File, 'contentPath part must be a file Blob');
		assert.equal((fileEntry as File).name, basename(filePath), 'filename defaults to the contentPath basename');
		assert.equal((fileEntry as Blob).type, 'application/pdf');
		assert.deepEqual(new Uint8Array(await (fileEntry as Blob).arrayBuffer()), new Uint8Array(fileBytes));
		assert.equal(formData.get('type'), 'voucher');

		const expectedSha = createHash('sha256').update(fileBytes).digest('hex');
		assert.deepEqual(response.sent, {
			bytes: fileBytes.length,
			parts: [{ name: 'file', filename: basename(filePath), bytes: fileBytes.length, sha256: expectedSha }],
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('contentPath validation: relative paths, missing files, and mode conflicts are rejected before fetch', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const { client, calls } = clientWithCalls(async () => responseFor(200, '{}'));

		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', multipart: [{ name: 'file', contentPath: 'relative/receipt.pdf' }, { name: 'type', value: 'voucher' }] }),
			/contentPath must be an absolute path/,
		);
		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', multipart: [{ name: 'file', contentPath: '/definitely/not/a/real/file.pdf' }, { name: 'type', value: 'voucher' }] }),
			/contentPath not found or not readable/,
		);
		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', multipart: [{ name: 'file', contentPath: '/tmp/a.pdf', contentBase64: 'AQID' }] }),
			/exactly one of value, contentBase64, or contentPath/,
		);
		assert.equal(calls.length, 0);
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('multipart endpoints reject body/bodyBase64 without an explicit multipart contentType', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const { client, calls } = clientWithCalls(async () => responseFor(200, '{}'));

		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', body: { type: 'voucher' } }),
			/expects multipart\/form-data\. Use the multipart request field/,
		);
		await assert.rejects(
			() => client.request({ method: 'POST', path: '/v1/files', bodyBase64: 'AQID', contentType: 'application/pdf' }),
			/expects multipart\/form-data/,
		);
		assert.equal(calls.length, 0);
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('bodyBase64 responses echo sent bytes and sha256', async () => {
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
	try {
		const { client } = clientWithCalls(async () => responseFor(200, JSON.stringify({ ok: true }), { 'content-type': 'application/json' }, 'OK'));

		const response = await client.request({ method: 'POST', path: '/v1/not-in-catalog', bodyBase64: 'AQID', contentType: 'application/pdf' });

		const expectedSha = createHash('sha256').update(Buffer.from([0x01, 0x02, 0x03])).digest('hex');
		assert.deepEqual(response.sent, { bytes: 3, sha256: expectedSha });
	} finally {
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}
});

test('writesEnabled reflects the env gate and is injected into the sandbox spec', async () => {
	const originalReadOnly = process.env.LEXWARE_OFFICE_READ_ONLY;
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	try {
		delete process.env.LEXWARE_OFFICE_READ_ONLY;
		delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		assert.equal(writesEnabled(), false);

		process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
		assert.equal(writesEnabled(), true);

		process.env.LEXWARE_OFFICE_READ_ONLY = 'true';
		assert.equal(writesEnabled(), false);
	} finally {
		if (originalReadOnly === undefined) delete process.env.LEXWARE_OFFICE_READ_ONLY;
		else process.env.LEXWARE_OFFICE_READ_ONLY = originalReadOnly;
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
	}

	const source = await readFile('src/index.ts', 'utf8');
	assert.match(source, /writesEnabled: writesEnabled\(\)/, 'index.ts must inject writesEnabled into the sandbox spec');
	assert.match(source, /spec\.info\.writesEnabled/, 'tool docs must mention spec.info.writesEnabled');
	assert.match(source, /contentPath/, 'execute tool docs must document contentPath uploads');
	assert.match(source, /multipart\?: MultipartPart\[\]/, 'execute tool docs must document the multipart request field');
});

test('large JSON responses stay parsed so execute code can summarize them', async () => {
	const rows = Array.from({ length: 5 }, (_, index) => ({ countryCode: `C${index}`, countryNameEN: 'x'.repeat(50) }));
	const client = new LexwareApiClient({
		apiKey: 'test-key',
		baseUrl: 'https://example.test',
		rateLimitIntervalMs: 0,
		maxResponseChars: 10,
		fetchImpl: async () => responseFor(200, JSON.stringify(rows), { 'content-type': 'application/json' }, 'OK'),
	});

	const response = await client.request({ path: '/v1/countries' });

	assert.deepEqual(response.data, rows);
	assert.equal(response.text, undefined);
	assert.equal(response.truncated, undefined);
});

test('text, binary metadata, and truncation recovery guidance are returned compactly', async () => {
	const textClient = clientWithCalls(async () => responseFor(200, 'plain text', { 'content-type': 'text/plain' }, 'OK')).client;
	const text = await textClient.request({ path: '/v1/custom-text', accept: 'text/plain' });
	assert.equal(text.text, 'plain text');

	const binaryClient = clientWithCalls(async () => responseFor(200, new Uint8Array([1, 2, 3]), { 'content-type': 'application/pdf', 'content-length': '3' }, 'OK')).client;
	const binary = await binaryClient.request({ path: '/v1/files/file-id', accept: 'application/pdf' });
	assert.deepEqual(binary.data, { binary: true, contentType: 'application/pdf', bytes: 3, bytesSource: 'content-length', omitted: true });

	const defaultAcceptBinaryClient = clientWithCalls(async () => responseFor(200, new Uint8Array([1, 2, 3]), { 'content-type': 'application/pdf', 'content-length': '3' }, 'OK')).client;
	const defaultAcceptBinary = await defaultAcceptBinaryClient.request({ path: '/v1/files/file-id' });
	assert.deepEqual(defaultAcceptBinary.data, { binary: true, contentType: 'application/pdf', bytes: 3, bytesSource: 'content-length', omitted: true });

	const truncated = truncateText('x'.repeat(50), { maxChars: 10 });
	assert.match(truncated, /truncated 40 characters/);
	assert.match(truncated, /Recovery: use a more specific search query/);

	const mcpOutput = stringifyForMcp({ data: 'x'.repeat(50) }, { maxChars: 20 });
	assert.match(mcpOutput, /summarize inside execute/);
});

test('search catalog exposes domain index and operation capability flags', () => {
	assert.ok(lexwareSpec.info.domainIndex.contacts);
	assert.deepEqual(lexwareSpec.info.domainIndex['payment-conditions'].endpoints, [{ method: 'GET', path: '/v1/payment-conditions' }]);
	assert.match(lexwareSpec.paths['/v1/payment-conditions']?.get?.summary ?? '', /payment terms/);
	assert.equal(lexwareSpec.paths['/v1/files']?.post?.capabilities?.multipart, true);
	assert.equal(lexwareSpec.paths['/v1/contacts']?.get?.capabilities?.paginated, true);
	assert.equal(lexwareSpec.paths['/v1/contacts']?.post?.capabilities?.write, true);
	assert.equal(lexwareSpec.paths['/v1/countries']?.get?.capabilities?.executable, true);
});
