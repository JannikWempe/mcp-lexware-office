import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient } from './lexware-client.js';

interface FetchCall {
	input: RequestInfo | URL;
	init?: RequestInit;
}

const clientWithFetch = (fetchImpl: typeof fetch, options: Partial<ConstructorParameters<typeof LexwareApiClient>[0]> = {}) => new LexwareApiClient({
	apiKey: 'test-key',
	baseUrl: 'https://example.test',
	rateLimitIntervalMs: 0,
	fetchImpl,
	...options,
});

const responseFor = (status: number, body: BodyInit | null, headers: HeadersInit = {}, statusText = '') => new Response(body, {
	status,
	statusText,
	headers,
});

test('401 JSON error is categorized as auth without exposing the API key', async () => {
	const calls: FetchCall[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		calls.push({ input, init });
		return responseFor(401, JSON.stringify({ message: 'unauthorized' }), { 'content-type': 'application/json' }, 'Unauthorized');
	};

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });

	assert.equal(response.ok, false);
	assert.equal(response.status, 401);
	assert.equal(response.errorCategory, 'auth');
	assert.deepEqual(response.data, { message: 'unauthorized' });
	assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
	assert.doesNotMatch(JSON.stringify(response), /test-key|Bearer/);
});

test('HTTP error statuses are categorized for model recovery decisions', async () => {
	const cases: Array<[number, string]> = [
		[403, 'permission'],
		[404, 'not_found'],
		[409, 'conflict'],
	];

	for (const [status, errorCategory] of cases) {
		const fetchImpl: typeof fetch = async () => responseFor(status, JSON.stringify({ status }), { 'content-type': 'application/json' });
		const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });
		assert.equal(response.ok, false);
		assert.equal(response.status, status);
		assert.equal(response.errorCategory, errorCategory);
	}
});

test('429 Retry-After seconds are surfaced', async () => {
	const fetchImpl: typeof fetch = async () => responseFor(429, JSON.stringify({ message: 'slow down' }), {
		'content-type': 'application/json',
		'retry-after': '30',
	}, 'Too Many Requests');

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });

	assert.equal(response.ok, false);
	assert.equal(response.errorCategory, 'rate_limit');
	assert.equal(response.retryAfterSeconds, 30);
});

test('429 Retry-After HTTP dates are converted to positive seconds', async () => {
	const retryDate = new Date(Date.now() + 60_000).toUTCString();
	const fetchImpl: typeof fetch = async () => responseFor(429, JSON.stringify({ message: 'slow down' }), {
		'content-type': 'application/json',
		'retry-after': retryDate,
	}, 'Too Many Requests');

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });

	assert.equal(response.ok, false);
	assert.equal(response.errorCategory, 'rate_limit');
	assert.ok(response.retryAfterSeconds !== undefined && response.retryAfterSeconds > 0 && response.retryAfterSeconds <= 60);
});

test('500 text/html error keeps the textual body', async () => {
	const fetchImpl: typeof fetch = async () => responseFor(500, '<html>boom</html>', { 'content-type': 'text/html' }, 'Internal Server Error');

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });

	assert.equal(response.ok, false);
	assert.equal(response.errorCategory, 'server');
	assert.equal(response.contentType, 'text/html');
	assert.equal(response.text, '<html>boom</html>');
});

test('malformed JSON response is returned as text and does not throw from request', async () => {
	const fetchImpl: typeof fetch = async () => responseFor(400, '{not valid json', { 'content-type': 'application/json' }, 'Bad Request');

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });

	assert.equal(response.ok, false);
	assert.equal(response.errorCategory, 'validation');
	assert.equal(response.text, '{not valid json');
	assert.equal(Object.prototype.hasOwnProperty.call(response, 'data'), false);
});

test('network errors use sanitized method/path messages', async () => {
	const fetchImpl: typeof fetch = async () => {
		throw new Error('failed to fetch https://example.test/v1/countries?secret=1 with Bearer test-key');
	};

	await assert.rejects(
		() => clientWithFetch(fetchImpl).request({ path: '/v1/countries' }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Lexware API network error for GET \/v1\/countries:/);
			assert.doesNotMatch(error.message, /secret=1|test-key|Bearer test-key|example\.test/);
			return true;
		},
	);
});

test('timeout errors use sanitized method/path messages', async () => {
	const fetchImpl: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
		const signal = init?.signal;
		if (!signal) reject(new Error('missing abort signal'));
		signal?.addEventListener('abort', () => {
			const error = new Error('aborted');
			error.name = 'AbortError';
			reject(error);
		}, { once: true });
	});

	await assert.rejects(
		() => clientWithFetch(fetchImpl, { requestTimeoutMs: 1 }).request({ path: '/v1/countries' }),
		/Lexware API request timed out after 1ms for GET \/v1\/countries/,
	);
});

// Synthetic fixture representing /v1/countries response shape.
// Non-sensitive public reference data (country codes, names, tax classifications).
const COUNTRIES_FIXTURE = [
	{ countryCode: 'DE', countryNameEN: 'Germany', countryNameDE: 'Deutschland', taxClassification: 'intraCommunity' },
	{ countryCode: 'AT', countryNameEN: 'Austria', countryNameDE: 'Österreich', taxClassification: 'intraCommunity' },
	{ countryCode: 'FR', countryNameEN: 'France', countryNameDE: 'Frankreich', taxClassification: 'intraCommunity' },
	{ countryCode: 'US', countryNameEN: 'United States', countryNameDE: 'Vereinigte Staaten', taxClassification: 'thirdPartyCountry' },
	{ countryCode: 'GB', countryNameEN: 'United Kingdom', countryNameDE: 'Vereinigtes Königreich', taxClassification: 'thirdPartyCountry' },
];

// The real /v1/countries list contains ~250 entries; generate a large-enough body
// that would expose any premature truncation before JSON.parse (>24 000 chars).
const LARGE_COUNTRIES_JSON = JSON.stringify(
	Array.from({ length: 250 }, (_, i) => ({
		countryCode: `C${String(i).padStart(2, '0')}`,
		countryNameEN: `Country${i} with a deliberately long name to inflate body size`,
		countryNameDE: `Land${i} mit einem absichtlich langen Namen zur Vergrößerung der Antwort`,
		taxClassification: i % 3 === 0 ? 'intraCommunity' : 'thirdPartyCountry',
	})),
);

test('large valid JSON reference response (like /v1/countries) is parsed into res.data, not truncated to res.text', async () => {
	// Regression: before the BOM-strip fix, a UTF-8 BOM at position 0 caused JSON.parse
	// to throw, falling through to the text-truncation path. Even without BOM, this test
	// verifies that a body >24 000 chars is still fully parsed when it is valid JSON.
	assert.ok(LARGE_COUNTRIES_JSON.length > 24_000, 'fixture must exceed maxResponseChars to expose any truncation-before-parse bug');

	const fetchImpl: typeof fetch = async () => responseFor(200, LARGE_COUNTRIES_JSON, { 'content-type': 'application/json' });
	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });

	assert.equal(response.ok, true);
	assert.equal(response.status, 200);
	assert.equal(response.contentType, 'application/json');
	assert.ok(Array.isArray(response.data), 'res.data must be an array (hasData: true, dataType: "array")');
	assert.equal(Object.prototype.hasOwnProperty.call(response, 'text'), false, 'res.text must be absent for parsed JSON');
	assert.equal(Object.prototype.hasOwnProperty.call(response, 'truncated'), false, 'res.truncated must be absent for parsed JSON');
});

test('binary response with Content-Length returns metadata without consuming the body', async () => {
	let arrayBufferCalled = false;
	const fetchImpl: typeof fetch = async () => {
		const resp = new Response(new Uint8Array([1, 2, 3, 4, 5]), {
			status: 200,
			headers: { 'content-type': 'application/pdf', 'content-length': '5' },
		});
		// Override arrayBuffer to detect if the body is fully buffered
		const origArrayBuffer = resp.arrayBuffer.bind(resp);
		Object.defineProperty(resp, 'arrayBuffer', {
			value: () => { arrayBufferCalled = true; return origArrayBuffer(); },
		});
		return resp;
	};

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/files/abc', accept: 'application/pdf' });

	assert.equal(arrayBufferCalled, false, 'arrayBuffer must not be called when Content-Length is present');
	assert.deepEqual(response.data, { binary: true, contentType: 'application/pdf', bytes: 5, bytesSource: 'content-length', omitted: true });
});

test('binary response without Content-Length returns compact metadata with bytesUnknown', async () => {
	const fetchImpl: typeof fetch = async () => responseFor(200, new Uint8Array([1, 2, 3]), { 'content-type': 'application/octet-stream' });

	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/files/abc', accept: 'application/octet-stream' });

	assert.deepEqual(response.data, { binary: true, contentType: 'application/octet-stream', omitted: true, bytesUnknown: true });
	assert.equal(Object.prototype.hasOwnProperty.call(response.data, 'bytes'), false);
});

test('JSON and text response parsing is unchanged by the binary optimisation', async () => {
	const jsonFetch: typeof fetch = async () => responseFor(200, JSON.stringify({ id: 'abc', name: 'Test' }), { 'content-type': 'application/json' });
	const jsonResponse = await clientWithFetch(jsonFetch).request({ path: '/v1/contacts/abc' });
	assert.deepEqual(jsonResponse.data, { id: 'abc', name: 'Test' });
	assert.equal(Object.prototype.hasOwnProperty.call(jsonResponse, 'text'), false);

	const textFetch: typeof fetch = async () => responseFor(200, 'hello world', { 'content-type': 'text/plain' });
	const textResponse = await clientWithFetch(textFetch).request({ path: '/v1/custom', accept: 'text/plain' });
	assert.equal(textResponse.text, 'hello world');
	assert.equal(Object.prototype.hasOwnProperty.call(textResponse, 'data'), false);
});

test('large valid JSON with UTF-8 BOM is parsed into res.data (BOM regression)', async () => {
	// Reproduce the observed live-testing failure: API returns application/json with a
	// leading UTF-8 BOM (﻿). JSON.parse rejects the BOM, causing the response to
	// fall through to text/truncation handling instead of populating res.data.
	const bomBody = '﻿' + JSON.stringify(COUNTRIES_FIXTURE);
	const fetchImpl: typeof fetch = async () => responseFor(200, bomBody, { 'content-type': 'application/json' });
	const response = await clientWithFetch(fetchImpl).request({ path: '/v1/countries' });

	assert.equal(response.ok, true);
	assert.equal(response.contentType, 'application/json');
	assert.ok(Array.isArray(response.data), 'BOM-prefixed JSON must be parsed into res.data');
	assert.equal(Object.prototype.hasOwnProperty.call(response, 'text'), false);
	assert.equal(Object.prototype.hasOwnProperty.call(response, 'truncated'), false);
	assert.deepEqual(response.data, COUNTRIES_FIXTURE);
});
