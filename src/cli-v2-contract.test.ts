import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const buildDir = dirname(fileURLToPath(import.meta.url));

test('lexware-office-v2 bin points at the deprecation wrapper', () => {
	const pkg = JSON.parse(readFileSync(join(buildDir, '..', 'package.json'), 'utf8'));
	assert.equal(pkg.bin['lexware-office'], './build/index.js');
	assert.equal(pkg.bin['lexware-office-v2'], './build/cli-v2.js');
});

test('deprecation wrapper warns on stderr and starts the real entry', () => {
	const wrapper = readFileSync(join(buildDir, 'cli-v2.js'), 'utf8');
	assert.match(wrapper, /^#!\/usr\/bin\/env node/);
	assert.match(wrapper, /console\.error\(.*deprecated.*lexware-office/);
	assert.match(wrapper, /import\(['"]\.\/index\.js['"]\)/);
});
