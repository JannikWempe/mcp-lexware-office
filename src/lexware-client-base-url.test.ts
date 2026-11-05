import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient } from './lexware-client.js';

const sentUrl = async (baseUrl: string, request: Parameters<LexwareApiClient['request']>[0]): Promise<string> => {
	let url = '';
	const fetchImpl: typeof fetch = async (input) => {
		url = String(input);
		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	};
	await new LexwareApiClient({ apiKey: 'test-key', baseUrl, rateLimitIntervalMs: 0, fetchImpl }).request(request);
	return url;
};

test('request paths are appended to the base URL, keeping its path prefix', async () => {
	assert.equal(await sentUrl('https://example.test', { path: '/v1/contacts', query: { page: 0 } }), 'https://example.test/v1/contacts?page=0');
	assert.equal(await sentUrl('https://proxy.test/lexware', { path: '/v1/contacts' }), 'https://proxy.test/lexware/v1/contacts');
	assert.equal(await sentUrl('https://proxy.test/lexware/', { path: '/v1/contacts/a%2Fb' }), 'https://proxy.test/lexware/v1/contacts/a%2Fb');
});

test('a binary response whose stream already errored does not reject unhandled', async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on('unhandledRejection', onUnhandled);
	try {
		const fetchImpl: typeof fetch = async () => new Response(
			new ReadableStream({ start: (controller) => controller.error(new Error('stream broke')) }),
			{ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '3' } },
		);
		const client = new LexwareApiClient({ apiKey: 'test-key', baseUrl: 'https://example.test', rateLimitIntervalMs: 0, fetchImpl });
		const result = await client.request({ path: '/v1/files/abc' });
		assert.equal((result.data as { binary?: boolean }).binary, true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});
