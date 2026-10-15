import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient, readUploadFile } from './lexware-client.js';

const fileBytes = Buffer.from('%PDF-test');

interface Fixture {
	root: string;
	allowed: string;
	outside: string;
	sibling: string;
}

// root/
//   data/            allowed upload dir
//     receipt.pdf
//     nested/receipt.pdf
//     folder/
//     escape.pdf -> ../outside/secret.pdf
//   data2/secret.pdf prefix trick: shares the "data" prefix but is not inside it
//   outside/secret.pdf
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'lexware-upload-dirs-'));
	try {
		const allowed = join(root, 'data');
		const outside = join(root, 'outside');
		const sibling = join(root, 'data2');
		await mkdir(join(allowed, 'nested'), { recursive: true });
		await mkdir(join(allowed, 'folder'));
		await mkdir(outside);
		await mkdir(sibling);
		await writeFile(join(allowed, 'receipt.pdf'), fileBytes);
		await writeFile(join(allowed, 'nested', 'receipt.pdf'), fileBytes);
		await writeFile(join(outside, 'secret.pdf'), fileBytes);
		await writeFile(join(sibling, 'secret.pdf'), fileBytes);
		await symlink(join(outside, 'secret.pdf'), join(allowed, 'escape.pdf'));
		await run({ root, allowed, outside, sibling });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const uploadClient = (uploadDirs?: string[], writesEnabled = true) => {
	let calls = 0;
	const client = new LexwareApiClient({
		apiKey: 'test-key',
		baseUrl: 'https://example.test',
		rateLimitIntervalMs: 0,
		writesEnabled,
		...(uploadDirs !== undefined && { uploadDirs }),
		fetchImpl: async () => {
			calls += 1;
			return new Response(JSON.stringify({ id: 'file-id' }), { status: 200, headers: { 'content-type': 'application/json' } });
		},
	});
	const upload = (contentPath: string) => client.request({
		method: 'POST',
		path: '/v1/files',
		multipart: [{ name: 'file', contentType: 'application/pdf', contentPath }, { name: 'type', value: 'voucher' }],
	});
	return { client, upload, calls: () => calls };
};

const uploadError = async (upload: (contentPath: string) => Promise<unknown>, contentPath: string): Promise<string> => {
	try {
		await upload(contentPath);
	} catch (error) {
		assert.ok(error instanceof Error);
		return error.message;
	}
	assert.fail(`expected upload of ${contentPath} to fail`);
};

test('contentPath is disabled without upload dirs, contentBase64 still works', async () => {
	await withFixture(async ({ allowed }) => {
		const { client, upload, calls } = uploadClient();

		await assert.rejects(() => upload(join(allowed, 'receipt.pdf')), /contentPath uploads are disabled.*LEXWARE_OFFICE_UPLOAD_DIRS/);
		assert.equal(calls(), 0);

		const response = await client.request({
			method: 'POST',
			path: '/v1/files',
			multipart: [{ name: 'file', contentType: 'application/pdf', contentBase64: fileBytes.toString('base64') }, { name: 'type', value: 'voucher' }],
		});
		assert.equal(response.status, 200);
	});
});

test('files inside an allowed dir (including nested) are uploaded', async () => {
	await withFixture(async ({ allowed }) => {
		const { upload, calls } = uploadClient([allowed]);

		const response = await upload(join(allowed, 'receipt.pdf'));
		await upload(join(allowed, 'nested', 'receipt.pdf'));

		assert.equal(response.sent?.parts?.[0]?.bytes, fileBytes.length);
		assert.equal(calls(), 2);
	});
});

test('every configured upload dir is allowed; only configured dirs are', async () => {
	await withFixture(async ({ allowed, outside }) => {
		assert.equal((await uploadClient([outside, allowed]).upload(join(allowed, 'receipt.pdf'))).status, 200);
		assert.equal((await uploadClient([outside, allowed]).upload(join(outside, 'secret.pdf'))).status, 200);

		await assert.rejects(() => uploadClient([allowed]).upload(join(outside, 'secret.pdf')), /outside the allowed upload directories/);
		await assert.rejects(() => uploadClient([]).upload(join(allowed, 'receipt.pdf')), /contentPath uploads are disabled/);
	});
});

test('paths outside the allowlist are rejected without revealing whether they exist', async () => {
	await withFixture(async ({ root, allowed, outside, sibling }) => {
		const { upload, calls } = uploadClient([allowed]);
		const cases = [
			join(outside, 'secret.pdf'),
			join(outside, 'missing.pdf'),
			join(sibling, 'secret.pdf'), // /data2 must not match the /data prefix
			join(allowed, '..', 'outside', 'secret.pdf'),
			join(allowed, 'escape.pdf'), // symlink pointing outside
			join(root, 'missing-dir', 'x.pdf'),
			join(allowed, 'link-out', 'secret.pdf'), // directory symlink pointing outside
			join(allowed, 'link-out', 'missing.pdf'),
			join(allowed, 'link-out', 'missing-dir', 'x.pdf'),
			join(allowed, 'dangling.pdf'), // dangling symlink pointing outside
			join(allowed, 'dangling.pdf', 'x.pdf'),
		];
		await symlink(outside, join(allowed, 'link-out'));
		await symlink(join(outside, 'missing.pdf'), join(allowed, 'dangling.pdf'));

		const messages = [];
		for (const contentPath of cases) {
			const message = await uploadError(upload, contentPath);
			assert.match(message, /outside the allowed upload directories/);
			messages.push(message.replace(contentPath, '<path>'));
		}
		assert.equal(new Set(messages).size, 1, 'messages must not differ between existing and missing paths');
		assert.equal(calls(), 0);
	});
});

test('allowed dirs and targets are compared by real path', async () => {
	await withFixture(async ({ root, allowed }) => {
		const linkToAllowed = join(root, 'link-to-data');
		await symlink(allowed, linkToAllowed);

		assert.equal((await uploadClient([linkToAllowed]).upload(join(allowed, 'receipt.pdf'))).status, 200);
		assert.equal((await uploadClient([allowed]).upload(join(linkToAllowed, 'receipt.pdf'))).status, 200);
		assert.equal((await uploadClient([await realpath(allowed)]).upload(join(allowed, 'receipt.pdf'))).status, 200);
	});
});

test('missing files and directories inside an allowed dir get specific errors', async () => {
	await withFixture(async ({ allowed }) => {
		const { upload } = uploadClient([allowed]);

		await symlink(join(allowed, 'nested'), join(allowed, 'link-in'));
		for (const missing of ['missing.pdf', join('missing-dir', 'x.pdf'), join('link-in', 'missing.pdf')]) {
			await assert.rejects(() => upload(join(allowed, missing)), /contentPath not found or not readable/);
		}
		await assert.rejects(() => upload(join(allowed, 'folder')), /contentPath must be a regular file/);
		await assert.rejects(() => upload(allowed), /contentPath must be a regular file/);
	});
});

test('write gate runs before the allowlist check', async () => {
	await withFixture(async ({ outside }) => {
		await assert.rejects(() => uploadClient([], false).upload(join(outside, 'secret.pdf')), /blocked: writes are disabled/);
	});
});

// Swaps simulate an attacker replacing parts of a validated path between the allowlist
// check and the read (TOCTOU). The outside file holds different bytes so a leak is visible.
const secretBytes = Buffer.from('outside-secret');

test('reads the file bytes when nothing is swapped', async () => {
	await withFixture(async ({ allowed }) => {
		assert.deepEqual(await readUploadFile(join(allowed, 'nested', 'receipt.pdf'), [allowed]), fileBytes);
	});
});

test('file swapped for a symlink after validation is not followed', async () => {
	await withFixture(async ({ allowed, outside }) => {
		await writeFile(join(outside, 'receipt.pdf'), secretBytes);
		const target = join(allowed, 'receipt.pdf');

		await assert.rejects(() => readUploadFile(target, [allowed], {
			beforeOpen: async () => {
				await rm(target);
				await symlink(join(outside, 'receipt.pdf'), target);
			},
		}), /contentPath not found or not readable/);
	});
});

test('parent directory swapped for a symlink after validation is rejected', async () => {
	await withFixture(async ({ allowed, outside }) => {
		await writeFile(join(outside, 'receipt.pdf'), secretBytes);
		const nested = join(allowed, 'nested');
		const swapIn = async () => {
			await rename(nested, `${nested}-orig`);
			await symlink(outside, nested);
		};

		await assert.rejects(() => readUploadFile(join(nested, 'receipt.pdf'), [allowed], { beforeOpen: swapIn }), /outside the allowed upload directories/);
	});
});

test('parent directory swapped out and back around the open is rejected by inode identity', async () => {
	await withFixture(async ({ allowed, outside }) => {
		await writeFile(join(outside, 'receipt.pdf'), secretBytes);
		const nested = join(allowed, 'nested');

		await assert.rejects(() => readUploadFile(join(nested, 'receipt.pdf'), [allowed], {
			beforeOpen: async () => {
				await rename(nested, `${nested}-orig`);
				await symlink(outside, nested);
			},
			afterOpen: async () => {
				await rm(nested);
				await rename(`${nested}-orig`, nested);
			},
		}), /outside the allowed upload directories/);
	});
});
