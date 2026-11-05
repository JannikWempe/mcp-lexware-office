import type { SandboxHostFunction } from './executor.js';
import type { LexwareApiClient, LexwareRequestOptions, LexwareResponse } from './lexware-client.js';
import { DEFAULT_STATE_LIMITS, type SandboxState } from './sandbox-state.js';

// The guest-facing `lexware` and `state` objects of the execute sandbox: their implementations
// (createLexwareSdk, createStateSdk, serialized into the guest prelude), the host bindings they call,
// and the declarations the execute tool description shows to the model. Tests guard drift.

// Globals the executor installs; the guest SDK sends JSON-encoded LexwareRequestInput through the
// first, and a delay in milliseconds through the second.
const HOST_FUNCTION = '__lexwareRequestJson';
const SLEEP_HOST_FUNCTION = '__lexwareSleep';
// Backs the guest `state` object with a SandboxState that outlives the execution.
const STATE_HOST_FUNCTION = '__stateJson';
// lexware.sleep rejects longer waits; the execute timeout (which aborts the signal) bounds the total.
export const MAX_SLEEP_MS = 10_000;

export interface SandboxBinding {
	prelude: string;
	hostFunctions: Record<string, SandboxHostFunction>;
}

// Executor options exposing `lexware` to guest code. Each sandbox request goes through
// client.request with the per-call options plus the executor's abort signal.
export function lexwareSandbox(client: Pick<LexwareApiClient, 'request'>, options: Omit<LexwareRequestOptions, 'signal'> = {}): SandboxBinding {
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

// Executor options exposing `state` to guest code (execute only, not search). The guest serializes
// values itself, so the host only ever stores and returns JSON text.
export function stateSandbox(store: SandboxState): SandboxBinding {
	return {
		prelude: `const state = (${createStateSdk.toString()})(globalThis.${STATE_HOST_FUNCTION});`,
		hostFunctions: {
			[STATE_HOST_FUNCTION]: async (payload) => {
				const { op, key, json } = JSON.parse(payload) as { op: StateOperation; key: string; json: string };
				switch (op) {
					case 'get': return store.get(key) ?? '';
					case 'set': store.set(key, json); return '';
					case 'delete': store.delete(key); return '';
					case 'keys': return JSON.stringify(store.keys());
					default: throw new Error(`Unknown state operation: ${op}`);
				}
			},
		},
	};
}

type StateOperation = 'get' | 'set' | 'delete' | 'keys';

// Builds the guest `state` object. Runs inside QuickJS via Function.prototype.toString(), so it
// must stay self-contained, like createLexwareSdk. A missing key comes back as '', never valid JSON.
export function createStateSdk(stateJson: (payload: string) => Promise<string>) {
	const call = (op: StateOperation, key?: unknown, json?: string) => stateJson(JSON.stringify({ op, key, json }));
	return Object.freeze({
		get: async (key: string): Promise<unknown> => {
			const json = await call('get', key);
			return json === '' ? undefined : JSON.parse(json);
		},
		set: async (key: string, value: unknown): Promise<void> => {
			let json: string | undefined;
			try {
				json = JSON.stringify(value);
			} catch (error) {
				throw new Error('state.set: the value for ' + JSON.stringify(key) + ' is not JSON-serializable: ' + (error instanceof Error ? error.message : String(error)));
			}
			if (json === undefined) {
				throw new Error('state.set: the value for ' + JSON.stringify(key) + ' is not JSON-serializable (' + typeof value + '). Use state.delete to remove a key.');
			}
			await call('set', key, json);
		},
		delete: async (key: string): Promise<void> => {
			await call('delete', key);
		},
		keys: async (): Promise<string[]> => JSON.parse(await call('keys')),
	});
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
		if (sleepHost === undefined) {
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
		// A write a dry run did not send has no data; scripts check response.dryRun to branch.
		if (response.dryRun === true) {
			return undefined;
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
	const isNumeric = (value: unknown): boolean => typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && decimalStringPattern.test(value.trim());
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
	// Bookkeeping voucher fields Lexware echoes as a timestamp when sent as yyyy-MM-dd.
	const voucherDateFields = ['voucherDate', 'dueDate'];
	// Compares a sent value with what Lexware holds, the way Lexware echoes it: a yyyy-MM-dd date in a date field matches its
	// timestamp, a number its numeric string, and null, '' and false a missing value. `partial` lets objects hold keys that were not sent.
	const sameValue = (sent: unknown, actual: unknown, partial: boolean, isDate = false): boolean => {
		const isEmpty = (value: unknown) => value === undefined || value === null || value === '' || value === false;
		if (isEmpty(sent) || isEmpty(actual)) {
			return isEmpty(sent) && isEmpty(actual);
		}
		if (Array.isArray(sent) || Array.isArray(actual)) {
			return Array.isArray(sent) && Array.isArray(actual) && sent.length === actual.length && sent.every((item, index) => sameValue(item, actual[index], partial));
		}
		if (isObjectLike(sent) || isObjectLike(actual)) {
			return isObjectLike(sent) && isObjectLike(actual)
				&& Object.keys(sent).every((key) => sameValue(sent[key], actual[key], partial))
				&& (partial || Object.keys(actual).every((key) => Object.prototype.hasOwnProperty.call(sent, key) || isEmpty(actual[key])));
		}
		if (isDate && typeof sent === 'string' && typeof actual === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sent)) {
			return actual === sent || actual.startsWith(sent + 'T');
		}
		if ((typeof sent === 'number' || typeof actual === 'number') && isNumeric(sent) && isNumeric(actual)) {
			return Number(sent) === Number(actual);
		}
		return sent === actual;
	};
	// GET, merge, PUT with the current version, GET again: 3 requests. Throws instead of writing when the
	// merged body would drop a current file id, because Lexware deletes omitted files permanently.
	// In a dry run the PUT is only planned, so it skips the re-read and returns the plan instead of `after`.
	const updateVoucher = async (
		id: string,
		patch: Record<string, unknown>,
		options: { expectedVersion?: number; allowFileRemoval?: boolean } = {},
	): Promise<
		| { before: unknown; after: unknown; changed: string[]; requested: string[]; notApplied: string[]; sideEffects: string[] }
		| { before: unknown; dryRun: true; planned: unknown; changed: string[]; requested: string[] }
	> => {
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
		// Patch keys the PUT sends: contactId is not sent while useCollectiveContact is true.
		const sentKeys = Object.keys(patch).filter((key) => Object.prototype.hasOwnProperty.call(body, key));
		const requested = sentKeys.filter((key) => !sameValue(body[key], before[key], false, voucherDateFields.includes(key)));
		const putResponse = await request({ method: 'PUT', path, body });
		if (!putResponse || putResponse.ok !== true) {
			// Throws with status, category and the normalized Lexware issues.
			assertOkJsonResponse(putResponse, 'lexware.updateVoucher');
		}
		if (putResponse.dryRun === true) {
			const changed = Object.keys(body)
				.filter((key) => key !== 'version' && JSON.stringify(before[key]) !== JSON.stringify(body[key]) && !(key === 'files' && before.files === undefined && keptFileIds.length === 0));
			for (const key of ['contactId', 'useCollectiveContact']) {
				if (before[key] !== undefined && !Object.prototype.hasOwnProperty.call(body, key)) changed.push(key);
			}
			return { before, dryRun: true, planned: putResponse.planned, changed, requested };
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
		// Lexware can answer 200 without keeping a field (e.g. on unchecked vouchers) and derives others, such as contactName.
		const notApplied = sentKeys.filter((key) => !sameValue(body[key], afterRecord[key], true, voucherDateFields.includes(key)));
		const sideEffects = changed.filter((key) => !Object.prototype.hasOwnProperty.call(patch, key));
		return { before, after, changed, requested, notApplied, sideEffects };
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
	// Signs that text recognition misread a receipt, from the voucher alone (no requests). Hints, not a complete check.
	// A blank voucher gets one warning instead: recognition is still running, so its fields mean nothing yet.
	const voucherWarnings = (voucher: unknown): string[] => {
		if (!isObjectLike(voucher) || Array.isArray(voucher)) {
			throw new Error('lexware.voucherWarnings expects a voucher object, e.g. the data of GET /v1/vouchers/{id}');
		}
		if (voucher.voucherStatus === 'blank') {
			return ['voucherStatus is blank: text recognition is still running; GET the voucher again in a later call'];
		}
		const warnings: string[] = [];
		if (voucher.type === 'salesinvoice' || voucher.type === 'salescreditnote') {
			warnings.push('type is ' + voucher.type + ': receipts are usually purchaseinvoice or purchasecreditnote; also check the contact and the categories');
		}
		const items = Array.isArray(voucher.voucherItems) ? voucher.voucherItems : [];
		if (items.length === 0) {
			warnings.push('voucherItems is empty: no amount or category was recognized');
		}
		items.forEach((item, index) => {
			const fields = isObjectLike(item) ? item : {};
			if (!isNumeric(fields.amount)) warnings.push('voucherItems[' + index + '].amount is missing');
			if (typeof fields.categoryId !== 'string' || fields.categoryId.length === 0) warnings.push('voucherItems[' + index + '].categoryId is missing');
		});
		if (!isNumeric(voucher.totalGrossAmount)) {
			warnings.push('totalGrossAmount is missing, e.g. for a document in a foreign currency');
		}
		if (typeof voucher.voucherNumber !== 'string' || voucher.voucherNumber.trim().length === 0) {
			warnings.push('voucherNumber is missing');
		}
		if (typeof voucher.voucherDate !== 'string' || voucher.voucherDate.length === 0) {
			warnings.push('voucherDate is missing');
		}
		if (!(typeof voucher.contactId === 'string' && voucher.contactId.length > 0) && voucher.useCollectiveContact !== true) {
			warnings.push('no contact: neither contactId nor useCollectiveContact is set');
		}
		return warnings;
	};
	// POST /v1/files, then poll the created voucher after 2, 4 and 8 s (capped by timeoutMs) until text recognition has
	// replaced status blank: 1 + up to 4 requests. Never re-uploads; a timeout or a failed poll returns extraction 'pending'.
	// In a dry run nothing is uploaded, so it returns the plan without polling.
	const uploadVoucherFile = async (input: FileInput & { waitForExtraction?: boolean | { timeoutMs?: number } }): Promise<{
		fileId: string;
		voucherId: string;
		sent: unknown;
		voucher?: unknown;
		extraction: 'done' | 'pending' | 'skipped';
		warnings?: string[];
		waitError?: string;
	} | { dryRun: true; planned: unknown; extraction: 'skipped' }> => {
		const part = filePart(input, 'lexware.uploadVoucherFile');
		const waitForExtraction = input.waitForExtraction !== undefined ? input.waitForExtraction : true;
		if (typeof waitForExtraction !== 'boolean' && !(isObjectLike(waitForExtraction) && !Array.isArray(waitForExtraction))) {
			throw new Error('lexware.uploadVoucherFile input.waitForExtraction must be a boolean or { timeoutMs }');
		}
		const timeoutMs = typeof waitForExtraction === 'object' && waitForExtraction.timeoutMs !== undefined ? Number(waitForExtraction.timeoutMs) : 15_000;
		// Capped so that one waiting upload fits into the 30 s execute timeout together with its requests.
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 15_000) {
			throw new Error('lexware.uploadVoucherFile input.waitForExtraction.timeoutMs must be 0 to 15000 ms');
		}
		const response = await request({ method: 'POST', path: '/v1/files', multipart: [part, { name: 'type', value: 'voucher' }] });
		const data = assertOkJsonResponse(response, 'lexware.uploadVoucherFile');
		if (response.dryRun === true) {
			return { dryRun: true, planned: response.planned, extraction: 'skipped' };
		}
		if (!isObjectLike(data) || typeof data.id !== 'string' || typeof data.voucherId !== 'string') {
			throw new Error('lexware.uploadVoucherFile expected POST /v1/files to return { id, voucherId }, got status ' + response.status + ': ' + JSON.stringify(data));
		}
		const uploaded = { fileId: data.id, voucherId: data.voucherId, sent: response.sent };
		if (waitForExtraction === false) {
			return { ...uploaded, extraction: 'skipped' };
		}
		let voucher: unknown;
		let waited = 0;
		for (const delayMs of [2_000, 4_000, 8_000, Infinity]) {
			const stepMs = Math.min(delayMs, timeoutMs - waited);
			if (stepMs <= 0) break;
			try {
				await sleep(stepMs);
				waited += stepMs;
				voucher = assertOkJsonResponse(await request({ path: '/v1/vouchers/' + encodeURIComponent(data.voucherId) }), 'lexware.uploadVoucherFile');
			} catch (error) {
				// The upload went through, so return its ids and hashes instead of throwing; an aborted execute discards the result anyway.
				const waitError = error instanceof Error ? error.message : String(error);
				return { ...uploaded, ...(voucher !== undefined && { voucher }), extraction: 'pending', waitError };
			}
			if (isObjectLike(voucher) && voucher.voucherStatus !== 'blank') {
				return { ...uploaded, voucher, extraction: 'done', warnings: voucherWarnings(voucher) };
			}
		}
		return { ...uploaded, ...(voucher !== undefined && { voucher }), extraction: 'pending' };
	};
	// POST /v1/vouchers/{id}/files: 1 request. Later voucher PUTs must keep the returned fileId.
	const attachFileToVoucher = async (voucherId: string, input: FileInput): Promise<{ fileId: string; sent: unknown } | { dryRun: true; planned: unknown }> => {
		if (typeof voucherId !== 'string' || voucherId.length === 0) {
			throw new Error('lexware.attachFileToVoucher expects a non-empty voucher id string');
		}
		const part = filePart(input, 'lexware.attachFileToVoucher');
		const response = await request({ method: 'POST', path: '/v1/vouchers/' + encodeURIComponent(voucherId) + '/files', multipart: [part] });
		const data = assertOkJsonResponse(response, 'lexware.attachFileToVoucher');
		if (response.dryRun === true) {
			return { dryRun: true, planned: response.planned };
		}
		if (!isObjectLike(data) || typeof data.id !== 'string') {
			throw new Error('lexware.attachFileToVoucher expected POST /v1/vouchers/{id}/files to return { id }, got status ' + response.status + ': ' + JSON.stringify(data));
		}
		return { fileId: data.id, sent: response.sent };
	};
	// Ignores case, spaces, dashes, dots and the leading zeros of the first digit group: 'RE-0042' and 're 42' compare equal.
	const normalizeVoucherNumber = (value: unknown): string => typeof value === 'string'
		? value.toLowerCase().replace(/[\s.\-–—]/g, '').replace(/^([a-z]*)0+(?=\d)/, '$1')
		: '';
	const allowedCriteria = ['voucherNumber', 'contactName', 'amount', 'currency', 'dateFrom', 'dateTo', 'voucherType', 'voucherStatus'];
	// Duplicate check before an upload: an exact voucherNumber query (1 request); if that finds nothing, pages /v1/voucherlist
	// within dateFrom..dateTo (1 + pages requests) and ranks the rows locally. Returns candidates; never decides a duplicate.
	const findVouchers = async (
		criteria: { voucherNumber?: string; contactName?: string | RegExp; amount?: number; currency?: string; dateFrom?: string; dateTo?: string; voucherType?: string; voucherStatus?: string },
		options: { maxPages?: number } = {},
	): Promise<Array<{ row: unknown; score: number; matched: string[] }>> => {
		if (!isObjectLike(criteria) || Array.isArray(criteria)) {
			throw new Error('lexware.findVouchers criteria must be an object');
		}
		const unknownKeys = Object.keys(criteria).filter((key) => !allowedCriteria.includes(key));
		if (unknownKeys.length > 0) {
			throw new Error('lexware.findVouchers criteria has unknown keys ' + unknownKeys.join(', ') + '. Allowed: ' + allowedCriteria.join(', '));
		}
		if (options == null || typeof options !== 'object' || Array.isArray(options)) {
			throw new Error('lexware.findVouchers options must be an object when provided');
		}
		const maxPages = options.maxPages !== undefined ? options.maxPages : 4;
		if (!(Number.isInteger(maxPages) && maxPages >= 1)) {
			throw new Error('lexware.findVouchers options.maxPages must be a positive integer');
		}
		const { voucherNumber, contactName, amount, currency, dateFrom, dateTo } = criteria;
		if (voucherNumber === undefined && contactName === undefined && amount === undefined) {
			throw new Error('lexware.findVouchers needs at least one of criteria.voucherNumber, contactName or amount');
		}
		const wantedNumber = normalizeVoucherNumber(voucherNumber);
		if (voucherNumber !== undefined && wantedNumber.length === 0) {
			throw new Error('lexware.findVouchers criteria.voucherNumber must be a string with letters or digits');
		}
		if (contactName !== undefined && !(contactName instanceof RegExp) && !(typeof contactName === 'string' && contactName.length > 0)) {
			throw new Error('lexware.findVouchers criteria.contactName must be a non-empty string or a RegExp');
		}
		if (amount !== undefined && !(typeof amount === 'number' && Number.isFinite(amount))) {
			throw new Error('lexware.findVouchers criteria.amount must be a finite number');
		}
		if (currency !== undefined && typeof currency !== 'string') {
			throw new Error('lexware.findVouchers criteria.currency must be a string');
		}
		for (const [name, date] of [['dateFrom', dateFrom], ['dateTo', dateTo]]) {
			if (date !== undefined && !(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))) {
				throw new Error('lexware.findVouchers criteria.' + name + ' must be a yyyy-MM-dd string');
			}
		}
		const hasWindow = dateFrom !== undefined && dateTo !== undefined;
		if (hasWindow && dateFrom > dateTo) {
			throw new Error('lexware.findVouchers criteria.dateFrom must not be after dateTo');
		}
		if (voucherNumber === undefined && !hasWindow) {
			throw new Error('lexware.findVouchers without criteria.voucherNumber needs criteria.dateFrom and dateTo to bound the voucherlist scan');
		}
		const contactPattern = contactName instanceof RegExp ? new RegExp(contactName.source, contactName.flags.replace(/[gyi]/g, '') + 'i') : undefined;
		const wantedContact = typeof contactName === 'string' ? contactName.toLowerCase() : undefined;
		const amountCents = amount !== undefined ? toCents(amount) : undefined;
		const baseQuery = {
			voucherType: criteria.voucherType !== undefined ? criteria.voucherType : 'purchaseinvoice,purchasecreditnote,salesinvoice,salescreditnote',
			voucherStatus: criteria.voucherStatus !== undefined ? criteria.voucherStatus : 'any',
		};
		// Weights are powers of two, so a voucherNumber match outranks any mix of the others.
		const rank = (rows: unknown[]) => rows
			.filter((row) => !(currency !== undefined && isObjectLike(row) && typeof row.currency === 'string' && row.currency.toLowerCase() !== currency.toLowerCase()))
			.map((row) => {
				const voucher = isObjectLike(row) ? row : {};
				const matched: string[] = [];
				let score = 0;
				if (voucherNumber !== undefined && normalizeVoucherNumber(voucher.voucherNumber) === wantedNumber) {
					score += 8;
					matched.push('voucherNumber');
				}
				// Unchecked vouchers can lack totalAmount; rows without a numeric one skip amount matching.
				const totalAmount = voucher.totalAmount;
				if (amountCents !== undefined && isNumeric(totalAmount) && Math.abs(toCents(totalAmount) - amountCents) <= 1) {
					score += 4;
					matched.push('amount');
				}
				const rowContact = typeof voucher.contactName === 'string' ? voucher.contactName : '';
				if (contactPattern !== undefined ? contactPattern.test(rowContact) : wantedContact !== undefined && rowContact.toLowerCase().includes(wantedContact)) {
					score += 2;
					matched.push('contactName');
				}
				const date = typeof voucher.voucherDate === 'string' ? voucher.voucherDate.slice(0, 10) : '';
				if (hasWindow && date >= dateFrom && date <= dateTo) {
					score += 1;
					matched.push('date');
				}
				return { row, score, matched };
			})
			// A date match alone is no candidate.
			.filter((candidate) => candidate.score > 1)
			.sort((a, b) => b.score - a.score);
		const path = '/v1/voucherlist';
		if (voucherNumber !== undefined) {
			const exactCandidates = rank(await paginate({ path, query: { ...baseQuery, voucherNumber: voucherNumber.trim() } }, { maxPages: 1 }));
			if (exactCandidates.length > 0) {
				return exactCandidates;
			}
			if (!hasWindow) {
				throw new Error('lexware.findVouchers: no candidate has the exact number ' + JSON.stringify(voucherNumber) + '. Pass criteria.dateFrom and dateTo to also search differently formatted numbers in that voucherDate window.');
			}
		}
		// Scanning only part of the window could miss a duplicate, so a window with more than maxPages pages throws.
		const windowQuery = { ...baseQuery, voucherDateFrom: dateFrom, voucherDateTo: dateTo };
		const firstPage = assertOkJsonResponse(await request({ path, query: { ...windowQuery, page: 0, size: 250 } }), 'lexware.findVouchers') as { content?: unknown; last?: unknown; totalPages?: unknown } | null;
		if (!firstPage || typeof firstPage !== 'object' || !Array.isArray(firstPage.content)) {
			throw new Error('lexware.findVouchers expected response.data.content to be an array');
		}
		const totalPages = typeof firstPage.totalPages === 'number' ? firstPage.totalPages : firstPage.last === true ? 1 : maxPages + 1;
		if (totalPages > maxPages) {
			throw new Error('lexware.findVouchers: the voucherDate window ' + dateFrom + '..' + dateTo + ' has ' + (typeof firstPage.totalPages === 'number' ? totalPages : 'more than ' + maxPages) + ' voucherlist pages, more than options.maxPages=' + maxPages + '. Narrow the window, or raise options.maxPages and the execute maxRequests (1 + pages requests).');
		}
		const otherRows = totalPages > 1 ? await paginate({ path, query: { ...windowQuery, page: 1 } }, { maxPages: totalPages - 1 }) : [];
		return rank([...firstPage.content, ...otherRows]);
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
		voucherWarnings,
		sleep,
		findVouchers,
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
  // changed: top-level keys that differ before/after; requested: patch keys that differ from before; notApplied: sent patch keys
  // the re-read does not hold (dates, numeric strings and extra item fields tolerated); sideEffects: changed keys not in patch, e.g. contactName.
  // Dry run: 1 request (the GET); returns the planned PUT, the fields it would change and requested; side effects are unknown before the PUT.
  updateVoucher(id: string, patch: Record<string, unknown>, options?: { expectedVersion?: number; allowFileRemoval?: boolean }): Promise<{ before: unknown; after: unknown; changed: string[]; requested: string[]; notApplied: string[]; sideEffects: string[] } | { before: unknown; dryRun: true; planned: PlannedWrite; changed: string[]; requested: string[] }>;
  // POST /v1/files (type=voucher), then polls the voucher after 2, 4, 8 s until it is no longer blank (timeoutMs default and max 15000):
  // up to 5 requests. One waiting upload per execute call (30 s timeout); for batches pass waitForExtraction: false. Never re-uploads;
  // extraction 'pending' on timeout, or with waitError when a poll failed (e.g. maxRequests used up), means GET /v1/vouchers/{voucherId} later.
  // extraction 'done' adds warnings: the voucherWarnings of the recognized voucher.
  // Dry run: no upload, no polling; returns the plan.
  uploadVoucherFile(input: FileInput & { waitForExtraction?: boolean | { timeoutMs?: number } }): Promise<{ fileId: string; voucherId: string; sent: UploadSent; voucher?: unknown; extraction: 'done' | 'pending' | 'skipped'; warnings?: string[]; waitError?: string } | { dryRun: true; planned: PlannedWrite; extraction: 'skipped' }>;
  attachFileToVoucher(voucherId: string, input: FileInput): Promise<{ fileId: string; sent: UploadSent } | { dryRun: true; planned: PlannedWrite }>; // POST /v1/vouchers/{id}/files, 1 request
  // No requests. Hints that text recognition misread a receipt, for a voucher read with GET /v1/vouchers/{id} (e.g. after batch uploads):
  // sales type, no items, item without amount or categoryId, no totalGrossAmount, voucherNumber, voucherDate or contact. A blank voucher
  // gets one warning that recognition is still running. Not exhaustive: still compare with the document.
  voucherWarnings(voucher: unknown): string[];
  sleep(ms: number): Promise<void>; // 0-${MAX_SLEEP_MS} ms per call; the 30 s execute timeout bounds the total
  // Duplicate check before uploads. A voucherNumber is queried exactly first (1 request). Without voucherNumber (contactName and/or amount
  // suffice), or if the exact query finds nothing, it pages /v1/voucherlist in dateFrom..dateTo, which is then required (else throws):
  // 1 + pages requests; throws if the window has more than maxPages (default 4) pages. Ranks rows by voucherNumber ignoring
  // case/spaces/dashes/dots/leading zeros (8), totalAmount ±0.01 (4), contactName (2), date (1). Never decides; check the candidates.
  findVouchers(criteria: { voucherNumber?: string; contactName?: string | RegExp; amount?: number; currency?: string; dateFrom?: string; dateTo?: string; voucherType?: string; voucherStatus?: string }, options?: { maxPages?: number }): Promise<Array<{ row: unknown; score: number; matched: string[] }>>;
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
  cache?: boolean; // false: skip the response cache for this GET (operations with cacheTtlSeconds, e.g. reference data)
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

type UploadSent = { bytes: number; parts: Array<{ name: string; filename?: string; bytes: number; sha256: string }> };

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
  dryRun?: true; // execute ran with dryRun: this write was NOT sent (ok: true, status: 0, no data; lexware.json returns undefined)
  planned?: PlannedWrite; // dry runs: what would have been sent
  cached?: true; // served from the server's response cache: not sent, no maxRequests used
};

type PlannedWrite = {
  method: string;
  path: string;
  query: Record<string, string[]>;
  operationId?: string;
  contentType?: string; // Content-Type header that would be sent
  body?: unknown;
  rawBody?: true; // body is sent verbatim, not JSON-encoded
  bytes?: number; // bodyBase64: decoded size
  sha256?: string;
  multipart?: Array<{ name: string; value?: string; filename?: string; contentType?: string; bytes?: number; sha256?: string }>; // file parts with the bytes and SHA-256 that would be uploaded
  blocked?: string; // why the write policy would reject this write in a real run
};`;

// Shown to the model in the execute tool description; keep in sync with createStateSdk and DEFAULT_STATE_LIMITS.
export const stateDeclaration = `// Survives across execute calls of this server process, e.g. for an id list, a cursor and partial totals of a fan-out
// split over several calls. Values are stored as JSON (as JSON.stringify would); get returns a copy, undefined if missing.
// Limits: ${DEFAULT_STATE_LIMITS.maxValueBytes / (1024 * 1024)} MB per value, ${DEFAULT_STATE_LIMITS.maxTotalBytes / (1024 * 1024)} MB and ${DEFAULT_STATE_LIMITS.maxKeys} keys in total, keys up to ${DEFAULT_STATE_LIMITS.maxKeyLength} characters; an entry expires
// ${DEFAULT_STATE_LIMITS.idleTtlMs / (60 * 1000)} min after it was last read or written. Calls cost no request budget. Not saved to disk: a server restart clears it.
// A dry run reads the stored state, but its changes are discarded when the call ends.
declare const state: {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>; // throws for values that are not JSON-serializable or exceed a limit
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
};`;
