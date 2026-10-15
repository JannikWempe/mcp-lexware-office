import type { SandboxHostFunction } from './executor.js';
import type { LexwareApiClient, LexwareRequestOptions, LexwareResponse } from './lexware-client.js';

// The guest-facing `lexware` object of the execute sandbox: its implementation (createLexwareSdk,
// serialized into the guest prelude), the host binding it calls, and the declarations the
// execute tool description shows to the model. `src/lexware-sandbox-sdk.test.ts` guards drift.

// Global the executor installs; the guest SDK sends JSON-encoded LexwareRequestInput through it.
const HOST_FUNCTION = '__lexwareRequestJson';

export interface LexwareSandbox {
	prelude: string;
	hostFunctions: Record<string, SandboxHostFunction>;
}

// Executor options exposing `lexware` to guest code. Each sandbox request goes through
// client.request with the per-call options plus the executor's abort signal.
export function lexwareSandbox(client: Pick<LexwareApiClient, 'request'>, options: Omit<LexwareRequestOptions, 'signal'> = {}): LexwareSandbox {
	return {
		prelude: `const lexware = (${createLexwareSdk.toString()})(globalThis.${HOST_FUNCTION});`,
		hostFunctions: {
			[HOST_FUNCTION]: async (payload, { signal }) => {
				const request = JSON.parse(payload) as unknown;
				const response = await client.request(request, { ...options, signal });
				return JSON.stringify(response);
			},
		},
	};
}

// Builds the guest `lexware` object on top of a host function taking and returning JSON.
// Runs inside QuickJS via Function.prototype.toString(), so it must stay self-contained:
// no references to imports or module-scope values (type-only references are fine).
export function createLexwareSdk(requestJson: (payload: string) => Promise<string>) {
	const request = async (input?: unknown): Promise<LexwareResponse> => JSON.parse(await requestJson(JSON.stringify(input ?? {})));
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
	return Object.freeze({
		request,
		json,
		paginate,
		requireNumber,
		requireMoney,
		sumMoney,
		formatMoney,
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

type LexwareResponse<T = unknown> = {
  ok: boolean;
  status: number;
  statusText: string;
  data?: T;
  text?: string;
  truncated?: boolean;
  contentType: string;
  headers: Record<string, string>;
  errorCategory?: string;
  retryAfterSeconds?: number;
  operation?: { operationId: string; method: string; pathTemplate: string; summary: string };
  request: { method: string; path: string; query: Record<string, string[]> };
  sent?: { bytes: number; sha256?: string; parts?: Array<{ name: string; filename?: string; bytes: number; sha256: string }> }; // echo of uploaded binary payloads for integrity checks
};`;
