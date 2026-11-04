import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient } from './lexware-client.js';
import { lexwareSpec } from './lexware-spec.js';

const sentAccept = async (request: Parameters<LexwareApiClient['request']>[0]): Promise<string | undefined> => {
	let accept: string | undefined;
	const fetchImpl: typeof fetch = async (_input, init) => {
		accept = (init?.headers as Record<string, string>).Accept;
		return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } });
	};
	await new LexwareApiClient({ apiKey: 'test-key', baseUrl: 'https://example.test', rateLimitIntervalMs: 0, fetchImpl }).request(request);
	return accept;
};

test('file downloads default to Accept */*', async () => {
	assert.equal(await sentAccept({ path: '/v1/invoices/abc/file' }), '*/*');
	assert.equal(await sentAccept({ path: '/v1/dunnings/abc/file' }), '*/*');
	assert.equal(await sentAccept({ path: '/v1/files/abc' }), '*/*');
});

test('other operations default to Accept application/json', async () => {
	assert.equal(await sentAccept({ path: '/v1/invoices/abc' }), 'application/json');
	assert.equal(await sentAccept({ path: '/v1/unknown-endpoint' }), 'application/json');
});

test('explicit accept always wins', async () => {
	assert.equal(await sentAccept({ path: '/v1/invoices/abc/file', accept: 'application/xml' }), 'application/xml');
	assert.equal(await sentAccept({ path: '/v1/invoices/abc', accept: 'text/plain' }), 'text/plain');
});

test('every GET file download operation declares defaultAccept */*', () => {
	const downloadPaths = Object.keys(lexwareSpec.paths).filter((path) => path.endsWith('/{id}/file') || path === '/v1/files/{id}');
	assert.equal(downloadPaths.length, 8);
	for (const path of downloadPaths) {
		assert.equal(lexwareSpec.paths[path]?.get?.defaultAccept, '*/*', path);
	}
});
