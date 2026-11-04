import assert from 'node:assert/strict';
import test from 'node:test';

import { AccountProfile, type AccountProfileOptions } from './account.js';
import { LexwareApiClient, type LexwareClientOptions } from './lexware-client.js';

const profile = {
	organizationId: 'aa93e8a8-2aa3-470b-b914-caad8a255dd8',
	companyName: 'Testfirma GmbH',
	created: { userId: 'u-1', userName: 'Frau Erika Musterfrau', userEmail: 'erika.musterfrau@testfirma.de', date: '2017-01-03T13:15:45.000+01:00' },
	connectionId: 'c-1',
	features: ['cashbox'],
	businessFeatures: ['INVOICING', 'BOOKKEEPING'],
	subscriptionStatus: 'active',
	taxType: 'net',
	smallBusiness: false,
};

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const accountWith = (fetchImpl: typeof fetch, options: AccountProfileOptions = {}, clientOptions: LexwareClientOptions = {}) => {
	const fetched: string[] = [];
	const client = new LexwareApiClient({
		apiKey: 'test-key',
		baseUrl: 'https://example.test',
		rateLimitIntervalMs: 0,
		...clientOptions,
		fetchImpl: async (input, init) => {
			fetched.push(new URL(String(input)).pathname);
			return fetchImpl(input, init);
		},
	});
	return { account: new AccountProfile(client, options), fetched };
};

test('fetches the profile once, keeps only business facts, and reuses it', async () => {
	const { account, fetched } = accountWith(async () => jsonResponse(200, profile));

	const [first, concurrent] = await Promise.all([account.get(), account.get()]);
	const later = await account.get();

	const expected = {
		organizationId: profile.organizationId,
		companyName: 'Testfirma GmbH',
		taxType: 'net',
		smallBusiness: false,
		businessFeatures: ['INVOICING', 'BOOKKEEPING'],
	};
	assert.deepEqual(first, expected);
	assert.deepEqual(concurrent, expected);
	assert.deepEqual(later, expected);
	assert.deepEqual(fetched, ['/v1/profile']);
	assert.doesNotMatch(JSON.stringify(first), /erika|Musterfrau|u-1|c-1/);
});

test('passes distanceSalesPrinciple through when set and prepends the label', async () => {
	const { account } = accountWith(async () => jsonResponse(200, { ...profile, distanceSalesPrinciple: 'DESTINATION' }), { label: 'Firma A' });

	const result = await account.get();

	assert.equal(result.label, 'Firma A');
	assert.equal(result.distanceSalesPrinciple, 'DESTINATION');
	assert.equal(Object.keys(result)[0], 'label');
});

test('without an API key resolves to an error without fetching', async () => {
	const { account, fetched } = accountWith(async () => jsonResponse(200, profile), { label: 'Firma A' }, { apiKey: undefined });

	assert.deepEqual(await account.get(), { label: 'Firma A', error: 'profile unavailable: no API key configured' });
	assert.deepEqual(fetched, []);
});

test('failures resolve to an error field instead of throwing', async () => {
	const cases: Array<[string, typeof fetch, AccountProfileOptions, RegExp]> = [
		['401', async () => jsonResponse(401, { message: 'Unauthorized' }), {}, /^profile unavailable: auth \(HTTP 401\)$/],
		['500', async () => jsonResponse(500, {}), {}, /^profile unavailable: server \(HTTP 500\)$/],
		['non-JSON', async () => new Response('oops', { status: 200, headers: { 'content-type': 'text/plain' } }), {}, /^profile unavailable: unknown \(HTTP 200\)$/],
		['network', async () => { throw new TypeError('fetch failed'); }, {}, /^profile unavailable: network$/],
		['timeout', (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))), { timeoutMs: 20 }, /^profile unavailable: timeout$/],
	];
	for (const [name, fetchImpl, options, expected] of cases) {
		const { account } = accountWith(fetchImpl, options);
		const result = await account.get();
		assert.match(result.error ?? '', expected, name);
		assert.equal(result.companyName, undefined, name);
	}
});

test('a lookup without any profile field is a failure, not an empty account', async () => {
	const { account } = accountWith(async () => jsonResponse(200, { created: { userEmail: 'a@b.test' } }));

	assert.deepEqual(await account.get(), { error: 'profile unavailable: no profile fields in response (HTTP 200)' });
});

test('timeouts and 429s are retried on the next call instead of being cached', async () => {
	let calls = 0;
	const { account, fetched } = accountWith(async (_input, init) => {
		calls += 1;
		if (calls === 1) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
		if (calls <= 3) return jsonResponse(429, {});
		return jsonResponse(200, profile);
	}, { timeoutMs: 20 }, { maxRetryAfterMs: 0 });

	assert.equal((await account.get()).error, 'profile unavailable: timeout');
	assert.equal((await account.get()).error, 'profile unavailable: rate_limit (HTTP 429)');
	assert.equal((await account.get()).error, 'profile unavailable: rate_limit (HTTP 429)');
	assert.equal((await account.get()).companyName, 'Testfirma GmbH');
	assert.equal(fetched.length, 4);
});

test('maxWaitMs resolves with a loading error while the lookup keeps running', async () => {
	let release = () => {};
	const { account, fetched } = accountWith(() => new Promise<Response>((resolve) => { release = () => resolve(jsonResponse(200, profile)); }), { label: 'Firma A' });

	assert.deepEqual(await account.get({ maxWaitMs: 10 }), { label: 'Firma A', error: 'profile still loading; check again in a later call' });
	release();
	assert.equal((await account.get({ maxWaitMs: 10 })).companyName, 'Testfirma GmbH');
	assert.equal(fetched.length, 1);
});

test('a 429 with Retry-After is cached that long; network failures for failureTtlMs', async () => {
	let nowMs = 0;
	const rateLimited = accountWith(async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' } }), { now: () => nowMs }, { maxRetryAfterMs: 0 });
	const offline = accountWith(async () => { throw new TypeError('fetch failed'); }, { failureTtlMs: 1_000, now: () => nowMs });

	await rateLimited.account.get();
	await offline.account.get();
	nowMs = 999;
	await rateLimited.account.get();
	await offline.account.get();
	assert.equal(rateLimited.fetched.length, 1);
	assert.equal(offline.fetched.length, 1);

	nowMs = 1_000;
	await offline.account.get();
	assert.equal(offline.fetched.length, 2);
	nowMs = 3_000;
	await rateLimited.account.get();
	assert.equal(rateLimited.fetched.length, 2);
});

test('a failed lookup is cached for failureTtlMs, then retried', async () => {
	let nowMs = 0;
	let status = 503;
	const { account, fetched } = accountWith(async () => (status === 200 ? jsonResponse(200, profile) : jsonResponse(status, {})), { failureTtlMs: 1_000, now: () => nowMs });

	assert.match((await account.get()).error ?? '', /HTTP 503/);
	nowMs = 999;
	status = 200;
	assert.match((await account.get()).error ?? '', /HTTP 503/);
	assert.equal(fetched.length, 1);

	nowMs = 1_000;
	assert.equal((await account.get()).companyName, 'Testfirma GmbH');
	nowMs = 1_000_000;
	await account.get();
	assert.equal(fetched.length, 2);
});
