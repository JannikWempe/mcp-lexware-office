import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { LexwareApiClient } from './lexware-client.js';

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
	const originalReadOnly = process.env.LEXWARE_OFFICE_READ_ONLY;
	const originalAllowWrites = process.env.LEXWARE_OFFICE_ALLOW_WRITES;
	const originalUploadDirs = process.env.LEXWARE_OFFICE_UPLOAD_DIRS;
	delete process.env.LEXWARE_OFFICE_READ_ONLY;
	delete process.env.LEXWARE_OFFICE_UPLOAD_DIRS;
	process.env.LEXWARE_OFFICE_ALLOW_WRITES = 'true';
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
		if (originalReadOnly === undefined) delete process.env.LEXWARE_OFFICE_READ_ONLY;
		else process.env.LEXWARE_OFFICE_READ_ONLY = originalReadOnly;
		if (originalAllowWrites === undefined) delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		else process.env.LEXWARE_OFFICE_ALLOW_WRITES = originalAllowWrites;
		if (originalUploadDirs === undefined) delete process.env.LEXWARE_OFFICE_UPLOAD_DIRS;
		else process.env.LEXWARE_OFFICE_UPLOAD_DIRS = originalUploadDirs;
	}
}

const uploadClient = (uploadDirs?: string[]) => {
	let calls = 0;
	const client = new LexwareApiClient({
		apiKey: 'test-key',
		baseUrl: 'https://example.test',
		rateLimitIntervalMs: 0,
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

test('LEXWARE_OFFICE_UPLOAD_DIRS is split on the path delimiter and the option overrides it', async () => {
	await withFixture(async ({ allowed, outside }) => {
		process.env.LEXWARE_OFFICE_UPLOAD_DIRS = [outside, allowed].join(delimiter);
		assert.equal((await uploadClient().upload(join(allowed, 'receipt.pdf'))).status, 200);
		assert.equal((await uploadClient().upload(join(outside, 'secret.pdf'))).status, 200);

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
		];

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

		await assert.rejects(() => upload(join(allowed, 'missing.pdf')), /contentPath not found or not readable/);
		await assert.rejects(() => upload(join(allowed, 'folder')), /contentPath must be a regular file/);
		await assert.rejects(() => upload(allowed), /contentPath must be a regular file/);
	});
});

test('write gate runs before the allowlist check', async () => {
	await withFixture(async ({ outside }) => {
		delete process.env.LEXWARE_OFFICE_ALLOW_WRITES;
		await assert.rejects(() => uploadClient([]).upload(join(outside, 'secret.pdf')), /blocked: writes are disabled/);
	});
});
