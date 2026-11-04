import type { SandboxHostFunction } from './executor.js';
import type { LexwareApiClient, LexwareRequestOptions, LexwareResponse } from './lexware-client.js';

// The guest-facing `lexware` object of the execute sandbox: its implementation (createLexwareSdk,
// serialized into the guest prelude), the host binding it calls, and the declarations the
// execute tool description shows to the model. `src/lexware-sandbox-sdk.test.ts` guards drift.

// Globals the executor installs; the guest SDK sends JSON-encoded LexwareRequestInput through the
// first, and a delay in milliseconds through the second.
const HOST_FUNCTION = '__lexwareRequestJson';
const SLEEP_HOST_FUNCTION = '__lexwareSleep';
// lexware.sleep rejects longer waits; the execute timeout (which aborts the signal) bounds the total.
export const MAX_SLEEP_MS = 10_000;

export interface LexwareSandbox {
	prelude: string;
	hostFunctions: Record<string, SandboxHostFunction>;
}

// Executor options exposing `lexware` to guest code. Each sandbox request goes through
// client.request with the per-call options plus the executor's abort signal.
export function lexwareSandbox(client: Pick<LexwareApiClient, 'request'>, options: Omit<LexwareRequestOptions, 'signal'> = {}): LexwareSandbox {
	return {
		prelude: `const lexware = (${createLexwareSdk.toString()})(globalThis.${HOST_FUNCTION}, globalThis.${SLEEP_HOST_FUNCTION});`,
		hostFunctions: {
			[HOST_FUNCTION]: async (payload, { signal }) => {
				const request = JSON.parse(payload) as unknown;
				const response = await client.request(request, { ...options, signal });
				return JSON.stringify(response);
			},
			[SLEEP_HOST_FUNCTION]: (payload, { signal }) => sleep(Number(payload), signal),
		},
	};
}

function sleep(ms: number, signal: AbortSignal): Promise<string> {
	if (!Number.isFinite(ms) || ms < 0 || ms > MAX_SLEEP_MS) {
		return Promise.reject(new Error(`lexware.sleep expects 0 to ${MAX_SLEEP_MS} ms, got ${ms}`));
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('lexware.sleep was aborted: the execution ended'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve('');
		}, ms);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

// Builds the guest `lexware` object on top of a host function taking and returning JSON.
// Runs inside QuickJS via Function.prototype.toString(), so it must stay self-contained:
// no references to imports or module-scope values (type-only references are fine).
export function createLexwareSdk(requestJson: (payload: string) => Promise<string>, sleepHost?: (payload: string) => Promise<string>) {
	const request = async (input?: unknown): Promise<LexwareResponse> => JSON.parse(await requestJson(JSON.stringify(input ?? {})));
	const sleep = async (ms: number): Promise<void> => {
		if (!sleepHost) {
			throw new Error('lexware.sleep is not available in this sandbox');
		}
		await sleepHost(String(ms));
	};
	const assertOkJsonResponse = (response: LexwareResponse, helperName: string): unknown => {
		if (!response || typeof response !== 'object') {
			throw new Error(helperName + ' expected lexware.request to return a LexwareResponse object');
		}
		if (response.ok === false) {
			const operation = response.operation
				? response.operation.operationId + ' (' + response.operation.method + ' ' + response.operation.pathTemplate + ')'
				: 'unknown operation';
			const details = Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response.text;
			const metadata: string[] = [];
			if (response.errorCategory) {
				metadata.push('Category: ' + response.errorCategory + '.');
			}
			if (response.retryAfterSeconds !== undefined) {
				metadata.push('Retry after: ' + response.retryAfterSeconds + 's.');
			}
			if (Array.isArray(response.issues) && response.issues.length > 0) {
				const issueTexts = response.issues.map((issue) => {
					const text = [issue.field, issue.code, issue.message].filter((part) => part !== undefined).join(' ');
					return issue.hint !== undefined ? (text.length > 0 ? text + ' (hint: ' + issue.hint + ')' : 'hint: ' + issue.hint) : text;
				});
				metadata.push('Issues: [' + issueTexts.join('; ') + '].');
			}
			const metadataText = metadata.length > 0 ? ' ' + metadata.join(' ') : '';
			throw new Error('Lexware API request failed: ' + response.status + ' ' + (response.statusText || '') + ' for ' + operation + '.' + metadataText + ' Error body: ' + JSON.stringify(details));
		}
		if (!Object.prototype.hasOwnProperty.call(response, 'data')) {
			throw new Error(helperName + ' expected parsed JSON at response.data, but this response has no data property. Use lexware.request for status/header-aware, empty, text, XML, PDF, or binary responses. contentType=' + (response.contentType || 'unknown'));
		}
		return response.data;
	};
	const json = async (input: unknown) => assertOkJsonResponse(await request(input), 'lexware.json');
	const isObjectLike = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
	const getPathValue = (row: unknown, fieldPath: string): { found: true; value: unknown } | { found: false; availableFields: string } => {
		if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
			throw new Error('fieldPath must be a non-empty string');
		}
		const parts = fieldPath.split('.');
		let current = row;
		for (const part of parts) {
			if (!isObjectLike(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
				return {
					found: false,
					availableFields: isObjectLike(current) ? Object.keys(current).join(', ') : '',
				};
			}
			current = current[part];
		}
		return { found: true, value: current };
	};
	const decimalStringPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
	const requireNumber = (row: unknown, fieldPath: string): number => {
		const result = getPathValue(row, fieldPath);
		if (!result.found) {
			throw new Error('Missing expected field ' + fieldPath + '. Available fields: ' + result.availableFields);
		}
		const raw = result.value;
		if (typeof raw === 'number') {
			if (!Number.isFinite(raw)) {
				throw new Error('Expected numeric ' + fieldPath + ', got ' + JSON.stringify(raw));
			}
			return raw;
		}
		if (typeof raw === 'string') {
			const trimmed = raw.trim();
			if (trimmed.length === 0 || !decimalStringPattern.test(trimmed)) {
				throw new Error('Expected numeric ' + fieldPath + ', got ' + JSON.stringify(raw));
			}
			return Number(trimmed);
		}
		throw new Error('Expected numeric ' + fieldPath + ', got ' + JSON.stringify(raw));
	};
	const decimalStringToCents = (input: string): number => {
		const trimmed = input.trim();
		const sign = trimmed[0] === '-' ? -1 : 1;
		const unsigned = trimmed[0] === '-' || trimmed[0] === '+' ? trimmed.slice(1) : trimmed;
		const parts = unsigned.split('.');
		const whole = parts[0] === '' ? '0' : parts[0];
		const fraction = parts[1] || '';
		let cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
		if ((fraction[2] || '0') >= '5') {
			cents += 1;
		}
		return sign * cents;
	};
	const toCents = (value: unknown): number => {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue)) {
			throw new Error('Expected finite money value, got ' + JSON.stringify(value));
		}
		const decimalText = typeof value === 'string' ? value.trim() : String(value);
		if (decimalStringPattern.test(decimalText)) {
			return decimalStringToCents(decimalText);
		}
		return Math.round(numericValue * 100 + (numericValue >= 0 ? Number.EPSILON : -Number.EPSILON));
	};
	const requireMoney = (row: unknown, fieldPath: string): number => {
		const result = getPathValue(row, fieldPath);
		if (!result.found) {
			throw new Error('Missing expected field ' + fieldPath + '. Available fields: ' + result.availableFields);
		}
		requireNumber(row, fieldPath);
		return toCents(result.value);
	};
	const sumMoney = (rows: unknown[], fieldPath: string): number => {
		if (!Array.isArray(rows)) {
			throw new Error('lexware.sumMoney expects an array of rows');
		}
		return rows.reduce((sum: number, row) => sum + requireMoney(row, fieldPath), 0);
	};
	const formatMoney = (cents: number, currency = 'EUR'): string => {
		const numericCents = Number(cents);
		if (!Number.isFinite(numericCents) || !Number.isInteger(numericCents)) {
			throw new Error('lexware.formatMoney expects integer cents, got ' + JSON.stringify(cents));
		}
		const sign = numericCents < 0 ? '-' : '';
		const absoluteCents = Math.abs(numericCents);
		const whole = Math.floor(absoluteCents / 100);
		const fraction = String(absoluteCents % 100).padStart(2, '0');
		return String(currency) + ' ' + sign + whole + '.' + fraction;
	};
	const paginate = async (input: Record<string, unknown>, options: { maxPages?: number } = {}): Promise<unknown[]> => {
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			throw new Error('lexware.paginate expects an object: { path, query?, method? }');
		}
		const method = String(input.method || 'GET').toUpperCase();
		if (method !== 'GET') {
			throw new Error('lexware.paginate only supports GET list endpoints');
		}
		if (options == null || typeof options !== 'object' || Array.isArray(options)) {
			throw new Error('lexware.paginate options must be an object when provided');
		}
		const maxPages = options.maxPages === undefined ? Infinity : Number(options.maxPages);
		if (!(maxPages === Infinity || (Number.isInteger(maxPages) && maxPages >= 1))) {
			throw new Error('lexware.paginate options.maxPages must be a positive integer');
		}
		const originalQuery = input.query == null ? {} : input.query;
		if (typeof originalQuery !== 'object' || Array.isArray(originalQuery)) {
			throw new Error('lexware.paginate input.query must be an object when provided');
		}
		const baseQuery: Record<string, unknown> = { ...originalQuery };
		let page = baseQuery.page === undefined || baseQuery.page === null ? 0 : Number(baseQuery.page);
		if (!Number.isInteger(page) || page < 0) {
			throw new Error('lexware.paginate query.page must be a zero-based non-negative integer');
		}
		const size = baseQuery.size === undefined || baseQuery.size === null ? 250 : baseQuery.size;
		const items: unknown[] = [];
		let pagesFetched = 0;
		while (pagesFetched < maxPages) {
			const response = await request({ ...input, method: 'GET', query: { ...baseQuery, page, size } });
			const data = assertOkJsonResponse(response, 'lexware.paginate') as { content?: unknown; last?: unknown; totalPages?: unknown } | null;
			if (!data || typeof data !== 'object' || !Array.isArray(data.content)) {
				throw new Error('lexware.paginate expected response.data.content to be an array. Use lexware.request/json for non-paged endpoints.');
			}
			items.push(...data.content);
			pagesFetched += 1;
			if (data.last === true) break;
			if (typeof data.totalPages === 'number' && page + 1 >= data.totalPages) break;
			if (data.content.length === 0) break;
			page += 1;
		}
		return items;
	};
	const fileIdsOf = (voucher: unknown): string[] => {
		const files = isObjectLike(voucher) ? voucher.files : undefined;
		return Array.isArray(files) ? files.map((file) => String(file)) : [];
	};
	// GET, merge, PUT with the current version, GET again: 3 requests. Throws instead of writing when the
	// merged body would drop a current file id, because Lexware deletes omitted files permanently.
	const updateVoucher = async (
		id: string,
		patch: Record<string, unknown>,
		options: { expectedVersion?: number; allowFileRemoval?: boolean } = {},
	): Promise<{ before: unknown; after: unknown; changed: string[] }> => {
		if (typeof id !== 'string' || id.length === 0) {
			throw new Error('lexware.updateVoucher expects a non-empty voucher id string');
		}
		if (!isObjectLike(patch) || Array.isArray(patch)) {
			throw new Error('lexware.updateVoucher patch must be an object');
		}
		if (options == null || typeof options !== 'object' || Array.isArray(options)) {
			throw new Error('lexware.updateVoucher options must be an object when provided');
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'version')) {
			throw new Error('lexware.updateVoucher sends the current version itself; use options.expectedVersion instead of patch.version');
		}
		if (patch.files !== undefined && !Array.isArray(patch.files)) {
			throw new Error('lexware.updateVoucher patch.files must be an array of file ids when provided');
		}
		const path = '/v1/vouchers/' + encodeURIComponent(id);
		const before = assertOkJsonResponse(await request({ path }), 'lexware.updateVoucher');
		if (!isObjectLike(before)) {
			throw new Error('lexware.updateVoucher expected GET ' + path + ' to return a voucher object');
		}
		if (options.expectedVersion !== undefined && before.version !== options.expectedVersion) {
			throw new Error('lexware.updateVoucher: voucher ' + id + ' is at version ' + JSON.stringify(before.version) + ', expected ' + JSON.stringify(options.expectedVersion) + '. Nothing was written; re-read the voucher before updating.');
		}
		const body: Record<string, unknown> = { ...before };
		for (const field of ['id', 'organizationId', 'voucherStatus', 'contactName', 'createdDate', 'updatedDate']) {
			delete body[field];
		}
		Object.assign(body, patch);
		// Lexware ignores contactId while useCollectiveContact is true, so switching either way drops the other.
		if (patch.useCollectiveContact === true) {
			delete body.contactId;
		} else if (patch.contactId !== undefined && patch.useCollectiveContact === undefined) {
			delete body.useCollectiveContact;
		}
		body.version = before.version;
		const previousFileIds = fileIdsOf(before);
		if (!Array.isArray(body.files)) {
			body.files = [];
		}
		const keptFileIds = fileIdsOf(body);
		const droppedFileIds = previousFileIds.filter((fileId) => !keptFileIds.includes(fileId));
		if (droppedFileIds.length > 0 && options.allowFileRemoval !== true) {
			throw new Error('lexware.updateVoucher: the update would permanently delete file(s) ' + droppedFileIds.join(', ') + ' from voucher ' + id + '. Nothing was written; keep them in patch.files or pass { allowFileRemoval: true }.');
		}
		const putResponse = await request({ method: 'PUT', path, body });
		if (!putResponse || putResponse.ok !== true) {
			// Throws with status, category and the normalized Lexware issues.
			assertOkJsonResponse(putResponse, 'lexware.updateVoucher');
		}
		let after: unknown;
		try {
			after = assertOkJsonResponse(await request({ path }), 'lexware.updateVoucher');
		} catch (error) {
			throw new Error('lexware.updateVoucher: the PUT succeeded, but re-reading voucher ' + id + ' failed, so the files were not verified. Do not repeat the update; GET the voucher to check it. Cause: ' + (error instanceof Error ? error.message : String(error)));
		}
		const afterFileIds = fileIdsOf(after);
		const lostFileIds = keptFileIds.filter((fileId) => !afterFileIds.includes(fileId));
		if (lostFileIds.length > 0) {
			throw new Error('lexware.updateVoucher: the PUT succeeded but voucher ' + id + ' no longer lists file(s) ' + lostFileIds.join(', ') + '. Check the voucher and re-attach the files via POST /v1/vouchers/{id}/files.');
		}
		const afterRecord = isObjectLike(after) ? after : {};
		const changed = Object.keys({ ...before, ...afterRecord })
			.filter((key) => key !== 'version' && key !== 'updatedDate' && JSON.stringify(before[key]) !== JSON.stringify(afterRecord[key]));
		return { before, after, changed };
	};
	const uploadContentTypes: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', xml: 'application/xml' };
	type FileInput = { contentPath?: string; contentBase64?: string; filename?: string; contentType?: string };
	const filePart = (input: FileInput, helperName: string): Record<string, unknown> => {
		if (!isObjectLike(input) || Array.isArray(input)) {
			throw new Error(helperName + ' expects an object: { contentPath | contentBase64, filename?, contentType? }');
		}
		if ((input.contentPath === undefined) === (input.contentBase64 === undefined)) {
			throw new Error(helperName + ' expects exactly one of contentPath or contentBase64');
		}
		if (input.contentBase64 !== undefined && input.filename === undefined) {
			throw new Error(helperName + ' needs a filename with contentBase64, e.g. receipt.pdf');
		}
		let contentType = input.contentType;
		if (contentType === undefined) {
			const name = String(input.filename !== undefined ? input.filename : input.contentPath);
			const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
			contentType = uploadContentTypes[extension];
			if (contentType === undefined) {
				throw new Error(helperName + ' cannot infer contentType from ' + JSON.stringify(name) + '; pass contentType (Lexware accepts pdf, jpg, png and xml)');
			}
		}
		const part: Record<string, unknown> = { name: 'file', contentType };
		for (const field of ['contentPath', 'contentBase64', 'filename'] as const) {
			if (input[field] !== undefined) part[field] = input[field];
		}
		return part;
	};
	// POST /v1/files, then poll the created voucher after 2, 4 and 8 s (capped by timeoutMs) until text recognition has
	// replaced status blank: 1 + up to 4 requests. Never re-uploads; a timeout returns extraction 'pending'.
	const uploadVoucherFile = async (input: FileInput & { waitForExtraction?: boolean | { timeoutMs?: number } }): Promise<{
		fileId: string;
		voucherId: string;
		sent: unknown;
		voucher?: unknown;
		extraction: 'done' | 'pending' | 'skipped';
	}> => {
		const part = filePart(input, 'lexware.uploadVoucherFile');
		const wait = input.waitForExtraction === undefined ? true : input.waitForExtraction;
		if (typeof wait !== 'boolean' && !(isObjectLike(wait) && !Array.isArray(wait))) {
			throw new Error('lexware.uploadVoucherFile waitForExtraction must be a boolean or { timeoutMs }');
		}
		const timeoutMs = typeof wait === 'object' && wait.timeoutMs !== undefined ? Number(wait.timeoutMs) : 15_000;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error('lexware.uploadVoucherFile waitForExtraction.timeoutMs must be a non-negative number');
		}
		const response = await request({ method: 'POST', path: '/v1/files', multipart: [part, { name: 'type', value: 'voucher' }] });
		const data = assertOkJsonResponse(response, 'lexware.uploadVoucherFile');
		if (!isObjectLike(data) || typeof data.id !== 'string' || typeof data.voucherId !== 'string') {
			throw new Error('lexware.uploadVoucherFile expected POST /v1/files to return { id, voucherId }, got status ' + response.status + ': ' + JSON.stringify(data));
		}
		const uploaded = { fileId: data.id, voucherId: data.voucherId, sent: response.sent };
		if (wait === false) {
			return { ...uploaded, extraction: 'skipped' };
		}
		let voucher: unknown;
		let waited = 0;
		for (const delayMs of [2_000, 4_000, 8_000, Infinity]) {
			const stepMs = Math.min(delayMs, timeoutMs - waited);
			if (stepMs <= 0) break;
			await sleep(stepMs);
			waited += stepMs;
			try {
				voucher = assertOkJsonResponse(await request({ path: '/v1/vouchers/' + encodeURIComponent(data.voucherId) }), 'lexware.uploadVoucherFile');
			} catch (error) {
				throw new Error('lexware.uploadVoucherFile: the upload succeeded (fileId ' + data.id + ', voucherId ' + data.voucherId + '), but polling the voucher failed. Do not upload again; GET /v1/vouchers/' + data.voucherId + ' later. Cause: ' + (error instanceof Error ? error.message : String(error)));
			}
			if (isObjectLike(voucher) && voucher.voucherStatus !== 'blank') {
				return { ...uploaded, voucher, extraction: 'done' };
			}
		}
		return { ...uploaded, ...(voucher !== undefined && { voucher }), extraction: 'pending' };
	};
	// POST /v1/vouchers/{id}/files: 1 request. Later voucher PUTs must keep the returned fileId.
	const attachFileToVoucher = async (voucherId: string, input: FileInput): Promise<{ fileId: string; sent: unknown }> => {
		if (typeof voucherId !== 'string' || voucherId.length === 0) {
			throw new Error('lexware.attachFileToVoucher expects a non-empty voucher id string');
		}
		const part = filePart(input, 'lexware.attachFileToVoucher');
		const response = await request({ method: 'POST', path: '/v1/vouchers/' + encodeURIComponent(voucherId) + '/files', multipart: [part] });
		const data = assertOkJsonResponse(response, 'lexware.attachFileToVoucher');
		if (!isObjectLike(data) || typeof data.id !== 'string') {
			throw new Error('lexware.attachFileToVoucher expected POST /v1/vouchers/{id}/files to return { id }, got status ' + response.status + ': ' + JSON.stringify(data));
		}
		return { fileId: data.id, sent: response.sent };
	};
	return Object.freeze({
		request,
		json,
		paginate,
		requireNumber,
		requireMoney,
		sumMoney,
		formatMoney,
		updateVoucher,
		uploadVoucherFile,
		attachFileToVoucher,
		sleep,
	});
}

// Shown to the model in the execute tool description; keep in sync with createLexwareSdk
// and the client's LexwareRequestInput / MultipartPart / LexwareResponse.
export const lexwareSdkDeclaration = `declare const lexware: {
  request<T = unknown>(input: LexwareRequest): Promise<LexwareResponse<T>>;
  json(input: LexwareRequest): Promise<unknown>;
  paginate<T = unknown>(input: LexwareRequest, options?: { maxPages?: number }): Promise<T[]>;
  requireNumber(row: unknown, fieldPath: string): number;
  requireMoney(row: unknown, fieldPath: string): number;
  sumMoney(rows: unknown[], fieldPath: string): number;
  formatMoney(cents: number, currency?: string): string;
  // GET, shallow-merge patch (read-only fields dropped, files and version kept), PUT, GET to verify: 3 requests. Throws
  // without writing on an expectedVersion mismatch or if files would lose an id (unless allowFileRemoval). Details: spec PUT /v1/vouchers/{id} notes.
  updateVoucher(id: string, patch: Record<string, unknown>, options?: { expectedVersion?: number; allowFileRemoval?: boolean }): Promise<{ before: unknown; after: unknown; changed: string[] }>;
  // POST /v1/files (type=voucher), then polls the voucher after 2, 4, 8 s until it is no longer blank (timeoutMs default 15000):
  // up to 5 requests. Never re-uploads; extraction 'pending' on timeout means GET /v1/vouchers/{voucherId} later.
  uploadVoucherFile(input: FileInput & { waitForExtraction?: boolean | { timeoutMs?: number } }): Promise<{ fileId: string; voucherId: string; sent: UploadSent; voucher?: unknown; extraction: 'done' | 'pending' | 'skipped' }>;
  attachFileToVoucher(voucherId: string, input: FileInput): Promise<{ fileId: string; sent: UploadSent }>; // POST /v1/vouchers/{id}/files, 1 request
  sleep(ms: number): Promise<void>; // 0-10000 ms per call; the 30 s execute timeout bounds the total
};

type LexwareRequest = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // relative /v1/... only; no absolute URLs or // hosts
  query?: Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;
  body?: unknown; // JSON by default; string when rawBody=true (UTF-8 encoded, NOT binary-safe)
  bodyBase64?: string; // raw binary body as base64; the host decodes it outside the sandbox
  multipart?: MultipartPart[]; // multipart/form-data uploads (e.g. POST /v1/files); host builds FormData
  contentType?: string;
  rawBody?: boolean;
  accept?: string;
  includeAllHeaders?: boolean; // return every response header instead of the default subset
};
// At most one of body, bodyBase64, or multipart per request.

type MultipartPart = {
  name: string;
  value?: string; // plain text form field
  contentBase64?: string; // binary part content as base64; host decodes it
  contentPath?: string; // absolute file path on the MCP server machine; host reads it directly (no base64 blowup). Only works if the server sets LEXWARE_OFFICE_UPLOAD_DIRS and the file is inside one of those dirs; otherwise use contentBase64
  filename?: string; // defaults to the contentPath basename
  contentType?: string;
};
// Exactly one of value, contentBase64, or contentPath per part.

type FileInput = {
  contentPath?: string; // as in MultipartPart; requires LEXWARE_OFFICE_UPLOAD_DIRS
  contentBase64?: string; // needs filename
  filename?: string;
  contentType?: string; // default from the filename/contentPath extension: pdf, jpg/jpeg, png, xml
};
// Exactly one of contentPath or contentBase64.

type UploadSent = { bytes: number; parts?: Array<{ name: string; filename?: string; bytes: number; sha256: string }> };

type LexwareResponse<T = unknown> = {
  ok: boolean;
  status: number;
  statusText: string;
  data?: T;
  text?: string;
  truncated?: boolean;
  contentType: string;
  headers: Record<string, string>; // content-type, content-length, content-disposition, location, retry-after, x-request-id, x-ratelimit-*; all with includeAllHeaders
  errorCategory?: string;
  retryAfterSeconds?: number;
  issues?: Array<{ field?: string; code?: string; message?: string; hint?: string }>; // non-OK responses: both Lexware error body shapes (IssueList[], details[]) normalized, with fix hints for known codes
  operation?: { operationId: string; method: string; pathTemplate: string; summary: string };
  request: { method: string; path: string; query: Record<string, string[]> };
  sent?: { bytes: number; sha256?: string; parts?: Array<{ name: string; filename?: string; bytes: number; sha256: string }> }; // echo of uploaded binary payloads for integrity checks
};`;
