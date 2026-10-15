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
		uploadDirs: [],
		writesEnabled: false,
	});
	const empty = loadConfig({});
	assert.equal(empty.apiKey, undefined);
	assert.equal(empty.baseUrl, undefined);
});
