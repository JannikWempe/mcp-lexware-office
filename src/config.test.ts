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
	});
	const empty = loadConfig({});
	assert.equal(empty.apiKey, undefined);
	assert.equal(empty.accountLabel, undefined);
	assert.equal(loadConfig({ LEXWARE_OFFICE_ACCOUNT_LABEL: 'Firma A' }).accountLabel, 'Firma A');
	assert.equal(empty.baseUrl, undefined);
});

test('WRITE_ALLOW is undefined when unset and parsed into catalog rules when set', () => {
	assert.equal(loadConfig({}).writeAllow, undefined);
	assert.deepEqual(loadConfig({ LEXWARE_OFFICE_WRITE_ALLOW: 'POST /v1/files, uploadFileToVoucher\nput /v1/vouchers/{voucherId}' }).writeAllow, [
		{ operationId: 'uploadFile', method: 'POST', pathTemplate: '/v1/files', finalize: false },
		{ operationId: 'uploadFileToVoucher', method: 'POST', pathTemplate: '/v1/vouchers/{id}/files', finalize: false },
		{ operationId: 'updateVoucher', method: 'PUT', pathTemplate: '/v1/vouchers/{id}', finalize: false },
	]);
});

test('WRITE_ALLOW fails fast on entries that are not cataloged writes', () => {
	for (const value of ['', ' , ', 'POST /v1/nope', 'GET /v1/contacts', 'listContacts', 'uploadfile', 'POST /v1/files?finalize']) {
		assert.throws(() => loadConfig({ LEXWARE_OFFICE_WRITE_ALLOW: value }), /LEXWARE_OFFICE_WRITE_ALLOW/, `WRITE_ALLOW=${JSON.stringify(value)}`);
	}
});
