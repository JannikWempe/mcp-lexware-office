import { delimiter } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from './config.js';

test('writes are disabled by default', () => {
	assert.equal(loadConfig({}).writesEnabled, false);
});

test('only ALLOW_WRITES=true enables writes', () => {
	assert.equal(loadConfig({ LEXWARE_OFFICE_ALLOW_WRITES: 'true' }).writesEnabled, true);
	for (const value of ['false', '1', 'TRUE', '']) {
		assert.equal(loadConfig({ LEXWARE_OFFICE_ALLOW_WRITES: value }).writesEnabled, false, `ALLOW_WRITES=${value}`);
	}
});

test('READ_ONLY=true overrides ALLOW_WRITES=true', () => {
	assert.equal(loadConfig({ LEXWARE_OFFICE_READ_ONLY: 'true', LEXWARE_OFFICE_ALLOW_WRITES: 'true' }).writesEnabled, false);
	assert.equal(loadConfig({ LEXWARE_OFFICE_READ_ONLY: 'false', LEXWARE_OFFICE_ALLOW_WRITES: 'true' }).writesEnabled, true);
});

test('READ_ONLY fails closed: any value but empty or false blocks writes', () => {
	for (const value of ['TRUE', ' true', '1', 'yes', 'on']) {
		assert.equal(loadConfig({ LEXWARE_OFFICE_READ_ONLY: value, LEXWARE_OFFICE_ALLOW_WRITES: 'true' }).writesEnabled, false, `READ_ONLY=${value}`);
	}
	for (const value of ['', '  ', 'FALSE', ' false ']) {
		assert.equal(loadConfig({ LEXWARE_OFFICE_READ_ONLY: value, LEXWARE_OFFICE_ALLOW_WRITES: 'true' }).writesEnabled, true, `READ_ONLY=${JSON.stringify(value)}`);
	}
});

test('UPLOAD_DIRS is split on the path delimiter, trimmed, and empty entries dropped', () => {
	assert.deepEqual(loadConfig({}).uploadDirs, []);
	assert.deepEqual(loadConfig({ LEXWARE_OFFICE_UPLOAD_DIRS: '' }).uploadDirs, []);
	assert.deepEqual(loadConfig({ LEXWARE_OFFICE_UPLOAD_DIRS: [' /data ', '', '  ', '/tmp/belege'].join(delimiter) }).uploadDirs, ['/data', '/tmp/belege']);
});

test('API key and base URL are passed through, undefined when unset', () => {
	assert.deepEqual(loadConfig({ LEXWARE_OFFICE_API_KEY: 'key', LEXWARE_OFFICE_API_BASE_URL: 'https://example.test' }), {
		apiKey: 'key',
		baseUrl: 'https://example.test',
		accountLabel: undefined,
		uploadDirs: [],
		writesEnabled: false,
		writeAllow: undefined,
		cacheEnabled: true,
	});
	const empty = loadConfig({});
	assert.equal(empty.apiKey, undefined);
	assert.equal(empty.baseUrl, undefined);
});

test('an empty base URL falls back to the default, an invalid one fails at startup', () => {
	for (const value of ['', '  ']) {
		assert.equal(loadConfig({ LEXWARE_OFFICE_API_BASE_URL: value }).baseUrl, undefined, JSON.stringify(value));
	}
	assert.equal(loadConfig({ LEXWARE_OFFICE_API_BASE_URL: ' https://proxy.test/lexware/ ' }).baseUrl, 'https://proxy.test/lexware/');
	for (const value of ['api.lexware.io', 'ftp://example.test']) {
		assert.throws(() => loadConfig({ LEXWARE_OFFICE_API_BASE_URL: value }), /LEXWARE_OFFICE_API_BASE_URL .* is not an http\(s\) URL/, value);
	}
});

test('ACCOUNT_LABEL is passed through, undefined when unset', () => {
	assert.equal(loadConfig({}).accountLabel, undefined);
	assert.equal(loadConfig({ LEXWARE_OFFICE_ACCOUNT_LABEL: 'Firma A' }).accountLabel, 'Firma A');
});

test('WRITE_ALLOW is undefined when unset and parsed into catalog rules when set', () => {
	assert.equal(loadConfig({}).writeAllow, undefined);
	assert.deepEqual(loadConfig({ LEXWARE_OFFICE_WRITE_ALLOW: 'POST /v1/files, uploadFileToVoucher\nput /v1/vouchers/{voucherId}' }).writeAllow, [
		{ operationId: 'uploadFile', method: 'POST', pathTemplate: '/v1/files', finalize: false },
		{ operationId: 'uploadFileToVoucher', method: 'POST', pathTemplate: '/v1/vouchers/{id}/files', finalize: false },
		{ operationId: 'updateVoucher', method: 'PUT', pathTemplate: '/v1/vouchers/{id}', finalize: false },
	]);
});

test('the response cache is on unless CACHE=off', () => {
	assert.equal(loadConfig({}).cacheEnabled, true);
	assert.equal(loadConfig({ LEXWARE_OFFICE_CACHE: 'off' }).cacheEnabled, false);
	for (const value of ['on', 'true', '', 'OFF']) {
		assert.equal(loadConfig({ LEXWARE_OFFICE_CACHE: value }).cacheEnabled, true, `CACHE=${value}`);
	}
});

test('WRITE_ALLOW fails fast on entries that are not cataloged writes', () => {
	for (const value of ['', ' , ', 'POST /v1/nope', 'GET /v1/contacts', 'listContacts', 'uploadfile', 'POST /v1/files?finalize']) {
		assert.throws(() => loadConfig({ LEXWARE_OFFICE_WRITE_ALLOW: value }), /LEXWARE_OFFICE_WRITE_ALLOW/, `WRITE_ALLOW=${JSON.stringify(value)}`);
	}
});
