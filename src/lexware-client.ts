import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { type LexwareIssue, normalizeIssues } from './lexware-issues.js';
import { lexwareSpec, type HttpMethod, type LexwareOperation } from './lexware-spec.js';
import { truncateText } from './truncate.js';
import { VERSION } from './version.js';
import { describeWritePolicy, WRITE_METHODS, type WriteAllowRule, type WritePolicy, writeAllowViolation } from './write-policy.js';

export type LexwareExecuteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type QueryScalar = string | number | boolean;
type QueryValue = QueryScalar | QueryScalar[] | null | undefined;

export interface MultipartPart {
	name: string;
	value?: string;
	filename?: string;
	contentType?: string;
	contentBase64?: string;
	contentPath?: string;
}

export interface LexwareRequestInput {
	method?: LexwareExecuteMethod | Lowercase<LexwareExecuteMethod>;
	path: string;
	query?: Record<string, QueryValue>;
	body?: unknown;
	bodyBase64?: string;
	multipart?: MultipartPart[];
	contentType?: string;
	rawBody?: boolean;
	accept?: string;
	// Return every upstream response header instead of the allowlisted ones.
	includeAllHeaders?: boolean;
}

export interface LexwareClientOptions {
	apiKey?: string;
	baseUrl?: string;
	userAgent?: string;
	fetchImpl?: typeof fetch;
	maxResponseChars?: number;
	requestTimeoutMs?: number;
	rateLimitIntervalMs?: number;
	// GET requests answered with 429 are retried once if the wait (Retry-After, or a 1–2 s
	// backoff without it) is at most this long. Also caps how long a 429 holds back the queue.
	maxRetryAfterMs?: number;
	// Directories multipart contentPath may read from. Omitted or empty disables contentPath.
	uploadDirs?: string[];
	// POST/PUT/PATCH/DELETE are blocked unless true.
	writesEnabled?: boolean;
	// When writes are enabled, only these writes are allowed. Omitted allows every write.
	writeAllow?: WriteAllowRule[];
}

export interface LexwareRequestOptions {
	// Cancels the request: while queued for the rate limiter, before sending, or during fetch.
	signal?: AbortSignal;
	// Called exactly once per attempt that passed input validation, including blocked writes,
	// cancellations, and network errors (with `error`), for audit logging.
	onSettled?: (entry: RequestLogEntry) => void;
	// Called right before each attempt is handed to fetch, including 429 retries. Throwing
	// fails that attempt unsent (logged with `error`, `sent: false`), e.g. to enforce a budget.
	beforeSend?: () => void;
	// Writes are not sent: each returns a synthetic `dryRun` response and is reported to onPlanned,
	// also when the write policy would block it. Reads run normally.
	dryRun?: boolean;
	// Called synchronously when a dry run plans a write, so calls arrive in request order, with the
	// plan that settles once the body is serialized. Throwing fails that write unsent, e.g. to cap plans.
	onPlanned?: (write: Promise<PlannedWrite>) => void;
}

// A write a dry run did not send: what would have gone out, with the hashes of binary payloads.
// `blocked` is why the write policy would reject it in a real run.
export interface PlannedWrite {
	method: LexwareExecuteMethod;
	path: string;
	query: Record<string, string[]>;
	operationId?: string;
	// The Content-Type header that would be sent; multipart/form-data gets its boundary from fetch.
	contentType?: string;
	body?: unknown;
	// bodyBase64 requests: the decoded bytes.
	bytes?: number;
	sha256?: string;
	multipart?: Array<{ name: string; value?: string; filename?: string; contentType?: string; bytes?: number; sha256?: string }>;
	blocked?: string;
}

// Audit record for one request attempt. Never contains headers, bodies, query values, or the API key.
// `sent` is true once the request was handed to fetch. A write that then failed with `error`
// (cancelled, timed out, network or response read error) or was answered with 504 gets
// `outcome: 'unknown'`: Lexware may have applied it, so reconcile with a GET before retrying.
export interface RequestLogEntry {
	method: LexwareExecuteMethod;
	path: string;
	status?: number;
	ok?: boolean;
	error?: string;
	write: boolean;
	sent: boolean;
	outcome?: 'unknown';
	// A write a dry run planned instead of sending.
	dryRun?: true;
	durationMs: number;
}

export interface LexwareResponse {
	ok: boolean;
	status: number;
	statusText: string;
	operation?: {
		operationId: string;
		method: LexwareExecuteMethod;
		pathTemplate: string;
		summary: string;
	};
	request: {
		method: LexwareExecuteMethod;
		path: string;
		query: Record<string, string[]>;
	};
	contentType: string;
	headers: Record<string, string>;
	errorCategory?: 'auth' | 'permission' | 'validation' | 'not_found' | 'conflict' | 'rate_limit' | 'server' | 'network' | 'unknown';
	retryAfterSeconds?: number;
	// Non-OK responses only: both Lexware error body shapes normalized, with hints.
	issues?: LexwareIssue[];
	data?: unknown;
	text?: string;
	truncated?: boolean;
	sent?: UploadEcho;
	// Synthetic response of a write a dry run did not send (status 0, no data).
	dryRun?: true;
	planned?: PlannedWrite;
}

export interface UploadEcho {
	bytes: number;
	sha256?: string;
	parts?: Array<{ name: string; filename?: string; bytes: number; sha256: string }>;
}

interface MatchedOperation {
	pathTemplate: string;
	operation: LexwareOperation;
}

interface NormalizedRequest {
	method: LexwareExecuteMethod;
	path: string;
	query: URLSearchParams;
	body?: unknown;
	bodyBase64?: string;
	multipart?: MultipartPart[];
	contentType?: string;
	rawBody: boolean;
	accept: string;
	includeAllHeaders: boolean;
	matched?: MatchedOperation;
}

const DEFAULT_BASE_URL = 'https://api.lexware.io';
const DEFAULT_USER_AGENT = `mcp-lexware-office/${VERSION}`;
const DEFAULT_MAX_RESPONSE_CHARS = 24_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Lexware allows 2 requests/second but warns that enforcing it without a buffer gets rate limited.
const DEFAULT_RATE_LIMIT_INTERVAL_MS = 600;
const DEFAULT_MAX_RETRY_AFTER_MS = 5_000;
const RETRY_BACKOFF_MS = 1_000;
const RETRY_JITTER_MS = 1_000;
// Response headers worth the model's context; the rest (AWS gateway ids, security policies)
// cost ~1.5 KB per returned response.
const RESPONSE_HEADER_ALLOWLIST = new Set(['content-type', 'content-length', 'content-disposition', 'location', 'retry-after', 'x-request-id']);
const isAllowedResponseHeader = (name: string) => RESPONSE_HEADER_ALLOWLIST.has(name) || name.startsWith('x-ratelimit-');

/**
 * Host-side HTTP client behind the sandbox's `lexware.request`. It alone holds the API key; guest
 * code reaches the API only through the host function in lexware-sandbox-sdk.ts.
 */
export class LexwareApiClient {
	readonly writesEnabled: boolean;
	readonly writePolicy: WritePolicy;
	private readonly writeAllow?: WriteAllowRule[];
	private readonly apiKey?: string;
	private readonly baseUrl: string;
	private readonly userAgent: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxResponseChars: number;
	private readonly requestTimeoutMs: number;
	private readonly rateLimitIntervalMs: number;
	private readonly maxRetryAfterMs: number;
	private readonly uploadDirs: string[];
	private nextRequestAtMs = 0;
	private rateLimitQueue: Promise<void> = Promise.resolve();

	constructor(options: LexwareClientOptions = {}) {
		this.writesEnabled = options.writesEnabled ?? false;
		this.writeAllow = options.writeAllow;
		this.writePolicy = describeWritePolicy(this.writesEnabled, this.writeAllow);
		this.apiKey = options.apiKey;
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.maxResponseChars = options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.rateLimitIntervalMs = options.rateLimitIntervalMs ?? DEFAULT_RATE_LIMIT_INTERVAL_MS;
		this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
		this.uploadDirs = options.uploadDirs ?? [];
	}

	get hasApiKey(): boolean {
		return Boolean(this.apiKey);
	}

	async request(input: unknown, options: LexwareRequestOptions = {}): Promise<LexwareResponse> {
		const apiKey = this.apiKey;
		if (!apiKey) {
			throw new Error('LEXWARE_OFFICE_API_KEY environment variable is required for the execute tool');
		}

		const normalized = normalizeRequest(input);
		const response = await this.attempt(normalized, apiKey, options, 0);
		if (response.status !== 429) return response;
		// Lexware's docs don't promise a Retry-After header on 429 (unverified against the live
		// API), so without one back off 1–2 s with jitter, as the docs recommend.
		const waitMs = response.retryAfterSeconds !== undefined
			? response.retryAfterSeconds * 1000
			: RETRY_BACKOFF_MS + Math.random() * RETRY_JITTER_MS;
		// Hold back queued requests too instead of sending them into the block. Capped so a long
		// block surfaces as 429 to the caller rather than as stalled requests.
		this.nextRequestAtMs = Math.max(this.nextRequestAtMs, Date.now() + Math.min(waitMs, this.maxRetryAfterMs));
		// Only idempotent reads are retried; a retried write could duplicate documents.
		if (normalized.method === 'GET' && waitMs <= this.maxRetryAfterMs) {
			return this.attempt(normalized, apiKey, options, waitMs);
		}
		return response;
	}

	private async attempt(normalized: NormalizedRequest, apiKey: string, options: LexwareRequestOptions, delayMs: number): Promise<LexwareResponse> {
		const startedAt = Date.now();
		const write = WRITE_METHODS.has(normalized.method);
		const progress = { sent: false };
		const log = (result: Pick<RequestLogEntry, 'status' | 'ok' | 'error' | 'dryRun'>) => options.onSettled?.({
			method: normalized.method,
			path: normalized.path,
			...result,
			write,
			sent: progress.sent,
			...(write && progress.sent && (result.error !== undefined || result.status === 504) && { outcome: 'unknown' as const }),
			durationMs: Date.now() - startedAt,
		});
		let response: LexwareResponse;
		try {
			response = await this.send(normalized, apiKey, options, delayMs, progress);
		} catch (error) {
			// send() throws controlled messages; sanitize anyway so the log can never leak secrets.
			log({ error: sanitizeFetchErrorMessage(error, apiKey) });
			throw error;
		}
		log({ status: response.status, ok: response.ok, ...(response.dryRun && { dryRun: true as const }) });
		return response;
	}

	private async send(normalized: NormalizedRequest, apiKey: string, options: LexwareRequestOptions, delayMs: number, progress: { sent: boolean }): Promise<LexwareResponse> {
		const write = WRITE_METHODS.has(normalized.method);
		const blocked = write ? this.writeBlockedReason(normalized) : undefined;
		if (blocked !== undefined && !options.dryRun) throw new Error(blocked);

		const signal = options.signal;
		const cancelledError = () => new Error(`Lexware API request cancelled for ${normalized.method} ${normalized.path}`);
		if (signal?.aborted) throw cancelledError();

		if (write && options.dryRun) {
			const planning = planWrite(normalized, this.uploadDirs, blocked);
			// Rejections reach the caller through the await below, even if onPlanned throws first.
			planning.catch(() => {});
			options.onPlanned?.(planning);
			const planned = await planning;
			if (signal?.aborted) throw cancelledError();
			return dryRunResponse(normalized, planned);
		}

		try {
			if (delayMs > 0) await sleep(delayMs, undefined, signal !== undefined ? { signal } : undefined);
			await this.waitForRateLimitTurn(signal);
		} catch (error) {
			if (signal?.aborted) throw cancelledError();
			throw error;
		}

		const url = new URL(normalized.path, this.baseUrl);
		url.search = normalized.query.toString();

		const timeoutController = new AbortController();
		const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
		const fetchSignal = signal !== undefined ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
		const abortedError = (error: unknown): Error | undefined => {
			if (signal?.aborted) return cancelledError();
			if (timeoutController.signal.aborted || isAbortError(error)) {
				return new Error(`Lexware API request timed out after ${this.requestTimeoutMs}ms for ${normalized.method} ${normalized.path}`);
			}
			return undefined;
		};
		try {
			const headers: Record<string, string> = {
				'User-Agent': this.userAgent,
				Accept: normalized.accept,
				Authorization: `Bearer ${apiKey}`,
			};

			const { body, sent } = await serializeRequestBody(normalized, headers, this.uploadDirs);
			if (signal?.aborted) throw cancelledError();
			options.beforeSend?.();

			let response: Response;
			try {
				progress.sent = true;
				response = await this.fetchImpl(url, {
					method: normalized.method,
					headers,
					body,
					signal: fetchSignal,
				});
			} catch (error) {
				throw abortedError(error) ?? new Error(`Lexware API network error for ${normalized.method} ${normalized.path}: ${sanitizeFetchErrorMessage(error, apiKey)}`);
			}

			let parsed: LexwareResponse;
			try {
				parsed = await parseResponse(response, normalized, this.maxResponseChars);
			} catch (error) {
				throw abortedError(error) ?? new Error(`Lexware API response read error for ${normalized.method} ${normalized.path}: ${sanitizeFetchErrorMessage(error, apiKey)}`);
			}
			return sent !== undefined ? { ...parsed, sent } : parsed;
		} finally {
			clearTimeout(timeout);
		}
	}

	private writeBlockedReason(normalized: NormalizedRequest): string | undefined {
		if (!this.writesEnabled) {
			return `${normalized.method} ${normalized.path} is blocked: writes are disabled by default. Set LEXWARE_OFFICE_ALLOW_WRITES=true to enable writes (LEXWARE_OFFICE_READ_ONLY=true overrides this).`;
		}
		return this.writeAllow !== undefined
			? writeAllowViolation(this.writeAllow, { ...normalized, operationId: normalized.matched?.operation.operationId })
			: undefined;
	}

	// Serializes requests through a promise chain. A waiter cancelled mid-wait rejects
	// immediately but only releases its slot once its predecessor is done, and it never
	// claims the next send slot, so later waiters keep the configured spacing.
	private async waitForRateLimitTurn(signal: AbortSignal | undefined): Promise<void> {
		if (this.rateLimitIntervalMs <= 0) return;

		const previous = this.rateLimitQueue;
		let release!: () => void;
		this.rateLimitQueue = new Promise<void>((resolve) => { release = resolve; });
		try {
			await untilAborted(previous, signal);
			// Loops because a 429 may push nextRequestAtMs back while this waiter sleeps.
			for (let delayMs = this.nextRequestAtMs - Date.now(); delayMs > 0; delayMs = this.nextRequestAtMs - Date.now()) {
				await sleep(delayMs, undefined, signal !== undefined ? { signal } : undefined);
			}
			this.nextRequestAtMs = Date.now() + this.rateLimitIntervalMs;
		} finally {
			void previous.then(release);
		}
	}
}

// Resolves with `promise`, or rejects as soon as `signal` aborts.
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}

function normalizeRequest(input: unknown): NormalizedRequest {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('lexware.request expects an object: { method?, path, query?, body?, contentType?, rawBody?, accept?, includeAllHeaders? }');
	}

	const request = input as LexwareRequestInput;
	const method = normalizeMethod(request.method ?? 'GET');
	const rawPath = normalizePath(request.path);
	const contentType = request.contentType === undefined ? undefined : normalizeHeaderValue(request.contentType, 'contentType');
	const rawBody = normalizeBoolean(request.rawBody ?? false, 'rawBody');
	const includeAllHeaders = normalizeBoolean(request.includeAllHeaders ?? false, 'includeAllHeaders');
	const url = new URL(rawPath, DEFAULT_BASE_URL);
	if (!url.pathname.startsWith('/v1/')) {
		throw new Error('path must resolve to /v1/ and must not escape that prefix');
	}
	const matched = matchOperation(url.pathname, method);
	const accept = normalizeHeaderValue(request.accept ?? matched?.operation.defaultAccept ?? 'application/json', 'accept');

	if (method === 'GET' && request.body !== undefined) {
		throw new Error('GET requests must not include a body');
	}

	if (method === 'GET' && request.bodyBase64 !== undefined) {
		throw new Error('GET requests must not include a body');
	}

	if (method === 'GET' && request.multipart !== undefined) {
		throw new Error('GET requests must not include a body');
	}

	if (rawBody && request.body !== undefined && typeof request.body !== 'string') {
		throw new Error('rawBody=true requires body to be a string, and strings are UTF-8 encoded on the wire (not binary-safe). For file uploads use multipart: [{ name, filename, contentType, contentPath | contentBase64 }, ...] or bodyBase64 instead.');
	}

	// Mutual exclusion: bodyBase64, multipart, and body/rawBody are distinct modes.
	const bodyModesSet = [
		request.body !== undefined,
		request.bodyBase64 !== undefined,
		request.multipart !== undefined,
	].filter(Boolean).length;
	if (bodyModesSet > 1) {
		throw new Error('At most one of body, bodyBase64, or multipart may be set on a single request.');
	}

	const bodyBase64 = request.bodyBase64 === undefined ? undefined : normalizeBase64Field(request.bodyBase64, 'bodyBase64');
	const multipart = request.multipart === undefined ? undefined : normalizeMultipart(request.multipart);

	// Fail fast on multipart endpoints instead of letting the Lexware API return an opaque 500:
	// body/bodyBase64 only make sense there when the caller hand-rolls the multipart encoding
	// and says so via an explicit multipart/* contentType with boundary.
	if (
		matched?.operation.requestBody?.contentType === 'multipart/form-data'
		&& multipart === undefined
		&& (request.body !== undefined || bodyBase64 !== undefined)
		&& !(contentType?.toLowerCase().includes('multipart/'))
	) {
		throw new Error(`${method} ${url.pathname} expects multipart/form-data. Use the multipart request field, e.g. multipart: [{ name: 'file', filename: 'doc.pdf', contentType: 'application/pdf', contentPath: '/absolute/path/doc.pdf' }, { name: 'type', value: 'voucher' }]. body/bodyBase64 are only allowed here with an explicit contentType containing 'multipart/' and a boundary.`);
	}

	const query = new URLSearchParams(url.search);
	appendQueryObject(query, request.query);

	return {
		method,
		path: url.pathname,
		query,
		body: request.body,
		bodyBase64,
		multipart,
		contentType,
		rawBody,
		accept,
		includeAllHeaders,
		matched,
	};
}

function normalizeMethod(method: unknown): LexwareExecuteMethod {
	if (typeof method !== 'string') throw new Error('method must be a string');
	const normalized = method.toUpperCase();
	if (normalized !== 'GET' && normalized !== 'POST' && normalized !== 'PUT' && normalized !== 'PATCH' && normalized !== 'DELETE') {
		throw new Error(`Unsupported method: ${method}`);
	}
	return normalized;
}

function normalizePath(path: unknown): string {
	if (typeof path !== 'string' || path.length === 0) throw new Error('path must be a non-empty string');
	if (!path.startsWith('/')) throw new Error('path must start with / and must not include a host');
	if (path.startsWith('//') || path.includes('://')) throw new Error('path must be relative to the Lexware API host');
	if (!path.startsWith('/v1/')) throw new Error('path must start with /v1/');
	return path;
}

function normalizeBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean when provided`);
	return value;
}

function normalizeHeaderValue(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	if (/\r|\n/.test(value)) throw new Error(`${field} must not contain newlines`);
	if (value.length > 500) throw new Error(`${field} is too long`);
	return value.trim();
}

function normalizeBase64Field(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new Error(`${field} must be a string`);
	// Validate that it is base64 (standard or URL-safe alphabet, with optional padding).
	if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(value)) {
		throw new Error(`${field} must be a valid base64-encoded string`);
	}
	return value;
}

function normalizeMultipart(parts: unknown): MultipartPart[] {
	if (!Array.isArray(parts)) throw new Error('multipart must be an array');
	return parts.map((part, index) => {
		if (!part || typeof part !== 'object' || Array.isArray(part)) {
			throw new Error(`multipart[${index}] must be an object`);
		}
		const p = part as Record<string, unknown>;
		if (typeof p.name !== 'string' || p.name.trim().length === 0) {
			throw new Error(`multipart[${index}].name must be a non-empty string`);
		}
		if (p.value !== undefined && typeof p.value !== 'string') {
			throw new Error(`multipart[${index}].value must be a string when provided`);
		}
		if (p.filename !== undefined && typeof p.filename !== 'string') {
			throw new Error(`multipart[${index}].filename must be a string when provided`);
		}
		if (p.contentType !== undefined && typeof p.contentType !== 'string') {
			throw new Error(`multipart[${index}].contentType must be a string when provided`);
		}
		if (p.contentBase64 !== undefined) {
			normalizeBase64Field(p.contentBase64, `multipart[${index}].contentBase64`);
		}
		if (p.contentPath !== undefined) {
			if (typeof p.contentPath !== 'string' || p.contentPath.trim().length === 0) {
				throw new Error(`multipart[${index}].contentPath must be a non-empty string`);
			}
			if (!isAbsolute(p.contentPath)) {
				throw new Error(`multipart[${index}].contentPath must be an absolute path on the MCP server machine`);
			}
		}
		const contentModes = [p.value !== undefined, p.contentBase64 !== undefined, p.contentPath !== undefined].filter(Boolean).length;
		if (contentModes !== 1) {
			throw new Error(`multipart[${index}] must have exactly one of value, contentBase64, or contentPath`);
		}
		return {
			name: p.name as string,
			...(p.value !== undefined && { value: p.value as string }),
			...(p.filename !== undefined && { filename: p.filename as string }),
			...(p.contentType !== undefined && { contentType: p.contentType as string }),
			...(p.contentBase64 !== undefined && { contentBase64: p.contentBase64 as string }),
			...(p.contentPath !== undefined && { contentPath: p.contentPath as string }),
		};
	});
}

function appendQueryObject(query: URLSearchParams, queryObject: unknown): void {
	if (queryObject === undefined) return;
	if (!queryObject || typeof queryObject !== 'object' || Array.isArray(queryObject)) {
		throw new Error('query must be an object of string, number, boolean, or array values');
	}

	for (const [key, value] of Object.entries(queryObject as Record<string, QueryValue>)) {
		if (value === undefined || value === null) continue;
		const values = Array.isArray(value) ? value : [value];
		for (const item of values) {
			if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
				throw new Error(`query.${key} must be a string, number, boolean, or an array of those values`);
			}
			query.append(key, String(item));
		}
	}
}

function matchOperation(pathname: string, method: LexwareExecuteMethod): MatchedOperation | undefined {
	const methodKey = method.toLowerCase() as HttpMethod;
	for (const [pathTemplate, methods] of Object.entries(lexwareSpec.paths)) {
		const operation = methods[methodKey];
		if (!operation) continue;
		if (pathTemplateToRegex(pathTemplate).test(pathname)) {
			return { pathTemplate, operation };
		}
	}
	return undefined;
}

function pathTemplateToRegex(template: string): RegExp {
	const pattern = template
		.split('/')
		.map((segment) => (segment.startsWith('{') && segment.endsWith('}') ? '[^/]+' : escapeRegex(segment)))
		.join('/');
	return new RegExp(`^${pattern}$`);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Client-side cap, not the API limit: Lexware documents 5 MB for POST /v1/files (type=voucher) and no limit for POST /v1/vouchers/{id}/files.
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

interface SerializedBody {
	body: BodyInit | undefined;
	sent?: UploadEcho;
}

async function serializeRequestBody(request: NormalizedRequest, headers: Record<string, string>, uploadDirs: string[]): Promise<SerializedBody> {
	// Binary body: decode base64 on the host, send raw bytes.
	if (request.bodyBase64 !== undefined) {
		headers['Content-Type'] = request.contentType ?? 'application/octet-stream';
		const buffer = Buffer.from(request.bodyBase64, 'base64');
		return { body: buffer, sent: { bytes: buffer.length, sha256: sha256Hex(buffer) } };
	}

	// Multipart body: build FormData on the host with binary-safe parts.
	if (request.multipart !== undefined) {
		const formData = new FormData();
		const sentParts: NonNullable<UploadEcho['parts']> = [];
		for (const part of request.multipart) {
			let buffer: Buffer<ArrayBuffer> | undefined;
			let defaultFilename = part.name;
			if (part.contentBase64 !== undefined) {
				buffer = Buffer.from(part.contentBase64, 'base64');
			} else if (part.contentPath !== undefined) {
				buffer = await readUploadFile(part.contentPath, uploadDirs);
				defaultFilename = basename(part.contentPath);
			}
			if (buffer !== undefined) {
				const blob = new Blob([buffer], { type: part.contentType ?? 'application/octet-stream' });
				const filename = part.filename ?? defaultFilename;
				formData.append(part.name, blob, filename);
				sentParts.push({ name: part.name, filename, bytes: buffer.length, sha256: sha256Hex(buffer) });
			} else {
				formData.append(part.name, part.value ?? '');
			}
		}
		// Do NOT set Content-Type manually; the Fetch API sets it with the correct boundary.
		const sent = sentParts.length > 0
			? { bytes: sentParts.reduce((sum, part) => sum + part.bytes, 0), parts: sentParts }
			: undefined;
		return { body: formData, ...(sent !== undefined && { sent }) };
	}

	if (request.body === undefined) return { body: undefined };

	if (request.rawBody) {
		headers['Content-Type'] = request.contentType ?? 'application/octet-stream';
		return { body: request.body as string };
	}

	const contentType = request.contentType ?? 'application/json';
	headers['Content-Type'] = contentType;
	if (isJsonContentType(contentType)) {
		return { body: JSON.stringify(request.body) };
	}
	if (typeof request.body === 'string') {
		return { body: request.body };
	}
	throw new Error('Non-JSON request bodies must be strings or use rawBody=true with an explicit contentType.');
}

// Serializes the body like a real send, so a dry run applies the same validation and upload-dir
// checks and reports the exact bytes and SHA-256 that would be uploaded.
async function planWrite(request: NormalizedRequest, uploadDirs: string[], blocked: string | undefined): Promise<PlannedWrite> {
	const headers: Record<string, string> = {};
	const { sent } = await serializeRequestBody(request, headers, uploadDirs);
	const contentType = request.multipart !== undefined ? 'multipart/form-data' : headers['Content-Type'];
	const binaryParts = [...(sent?.parts ?? [])];
	return {
		method: request.method,
		path: request.path,
		query: queryToObject(request.query),
		...(request.matched !== undefined && { operationId: request.matched.operation.operationId }),
		...(contentType !== undefined && { contentType }),
		...(request.body !== undefined && { body: request.body }),
		...(request.bodyBase64 !== undefined && sent !== undefined && { bytes: sent.bytes, sha256: sent.sha256 }),
		...(request.multipart !== undefined && {
			multipart: request.multipart.map((part) => part.value !== undefined
				? { name: part.name, value: part.value }
				: { ...binaryParts.shift()!, contentType: part.contentType ?? 'application/octet-stream' }),
		}),
		...(blocked !== undefined && { blocked }),
	};
}

function dryRunResponse(request: NormalizedRequest, planned: PlannedWrite): LexwareResponse {
	return {
		ok: true,
		status: 0,
		statusText: 'DRY RUN – not sent',
		dryRun: true,
		...operationOf(request),
		request: { method: request.method, path: request.path, query: planned.query },
		contentType: '',
		headers: {},
		planned,
	};
}

export interface UploadReadHooks {
	// Test seams around the open, to simulate paths being swapped (TOCTOU).
	beforeOpen?: () => Promise<void>;
	afterOpen?: () => Promise<void>;
}

// Reads contentPath via a file descriptor and re-verifies after opening that the path still
// resolves to the opened inode inside an allowed dir, so a path swapped after validation
// (file or parent directory replaced by a symlink) cannot leak a file from outside.
export async function readUploadFile(contentPath: string, uploadDirs: string[], hooks: UploadReadHooks = {}): Promise<Buffer<ArrayBuffer>> {
	const realPath = await resolveAllowedUploadPath(contentPath, uploadDirs);
	const notFound = () => new Error(`multipart contentPath not found or not readable: ${contentPath}`);
	await hooks.beforeOpen?.();
	let handle: FileHandle;
	try {
		// O_NONBLOCK keeps a FIFO from blocking the open; it is rejected as non-regular below.
		handle = await open(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	} catch {
		throw notFound();
	}
	try {
		await hooks.afterOpen?.();
		const stats = await handle.stat();
		const pathStats = await stat(await resolveAllowedUploadPath(realPath, uploadDirs, contentPath)).catch(() => undefined);
		if (pathStats === undefined || pathStats.dev !== stats.dev || pathStats.ino !== stats.ino) {
			throw notAllowedUploadPath(contentPath);
		}
		if (!stats.isFile()) {
			throw new Error(`multipart contentPath must be a regular file: ${contentPath}`);
		}
		if (stats.size > MAX_UPLOAD_FILE_BYTES) {
			throw new Error(`multipart contentPath file is ${stats.size} bytes, exceeding the ${MAX_UPLOAD_FILE_BYTES} byte upload limit: ${contentPath}`);
		}
		try {
			return await handle.readFile() as Buffer<ArrayBuffer>;
		} catch {
			throw notFound();
		}
	} finally {
		await handle.close();
	}
}

const notAllowedUploadPath = (contentPath: string) => new Error(`multipart contentPath is outside the allowed upload directories (LEXWARE_OFFICE_UPLOAD_DIRS): ${contentPath}`);

// Returns the real path of path if it lies inside one of the upload dirs (after resolving
// symlinks on both sides). Paths outside the allowlist always get the same error, whether or
// not they exist, so the check is not a file-existence oracle. contentPath is what errors show.
async function resolveAllowedUploadPath(path: string, uploadDirs: string[], contentPath = path): Promise<string> {
	if (uploadDirs.length === 0) {
		throw new Error('multipart contentPath uploads are disabled. Set LEXWARE_OFFICE_UPLOAD_DIRS to the directories uploads may be read from, or send the file with contentBase64.');
	}

	const realDirs = (await Promise.all(uploadDirs.map((dir) => realpath(dir).catch(() => undefined))))
		.filter((dir): dir is string => dir !== undefined);
	const isAllowed = (realPath: string) => realDirs.some((dir) => isInsideDir(realPath, dir));
	const lexicalPath = resolve(path);
	let realPath: string;
	try {
		realPath = await realpath(lexicalPath);
	} catch {
		// Only report "not found" if the nearest existing entry on the path really lies inside
		// an allowed dir; a symlink (dangling or to a dir) pointing outside gets the uniform error.
		const existing = await nearestExistingPath(lexicalPath);
		const realExisting = existing !== undefined ? await realpath(existing).catch(() => undefined) : undefined;
		if (realExisting === undefined || !isAllowed(realExisting)) throw notAllowedUploadPath(contentPath);
		throw new Error(`multipart contentPath not found or not readable: ${contentPath}`);
	}
	if (!isAllowed(realPath)) throw notAllowedUploadPath(contentPath);
	return realPath;
}

// Walks up from path to the first entry that exists (lstat, so dangling symlinks count).
async function nearestExistingPath(path: string): Promise<string | undefined> {
	for (let current = path; ; current = dirname(current)) {
		if (await lstat(current).then(() => true, () => false)) return current;
		if (dirname(current) === current) return undefined;
	}
}

function isInsideDir(path: string, dir: string): boolean {
	const relativePath = relative(dir, path);
	return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function sha256Hex(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

function isJsonContentType(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return lower === 'application/json' || lower.endsWith('+json') || lower.includes('/json');
}

async function parseResponse(response: Response, request: NormalizedRequest, maxResponseChars: number): Promise<LexwareResponse> {
	const contentType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
	const headers = headersToObject(response.headers, request.includeAllHeaders);
	const base: Omit<LexwareResponse, 'data' | 'text' | 'truncated'> = {
		ok: response.ok,
		status: response.status,
		statusText: response.statusText,
		...operationOf(request),
		request: {
			method: request.method,
			path: request.path,
			query: queryToObject(request.query),
		},
		contentType,
		headers,
	};

	if (!response.ok) {
		base.errorCategory = categorizeStatus(response.status) ?? 'unknown';
		if (response.status === 429) {
			const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
			if (retryAfterSeconds !== undefined) base.retryAfterSeconds = retryAfterSeconds;
		}
	}

	if (response.status === 204) return base;

	const isTextual = isTextualResponse(contentType, request.accept);
	if (!isTextual) {
		// Avoid buffering the full binary body — use Content-Length if available.
		response.body?.cancel();
		const contentLengthHeader = response.headers.get('content-length');
		const contentLengthBytes = contentLengthHeader !== null ? Number(contentLengthHeader) : NaN;
		const binaryMeta = Number.isFinite(contentLengthBytes) && contentLengthBytes >= 0
			? { binary: true, contentType: contentType || 'application/octet-stream', bytes: contentLengthBytes, bytesSource: 'content-length' as const, omitted: true }
			: { binary: true, contentType: contentType || 'application/octet-stream', omitted: true, bytesUnknown: true };
		return { ...base, data: binaryMeta };
	}

	const rawText = await response.text();
	// Strip UTF-8 BOM (﻿) that some servers prepend; JSON.parse rejects it.
	const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;

	const withIssues = (data: unknown) => {
		const issues = response.ok ? undefined : normalizeIssues(response.status, request.method, data);
		return issues !== undefined ? { ...base, issues } : base;
	};

	if (isJsonResponse(contentType, request.accept)) {
		// Stays undefined only when parsing fails: JSON.parse never returns undefined.
		let data: unknown;
		try {
			data = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			// Fall through to compact text handling for malformed JSON responses.
		}
		if (data !== undefined) return { ...withIssues(data), data };
	}

	const truncated = text.length > maxResponseChars;
	const safeText = truncated ? truncateText(text, { maxChars: maxResponseChars }) : text;
	return { ...withIssues(undefined), text: safeText, truncated };
}

function operationOf(request: NormalizedRequest): Pick<LexwareResponse, 'operation'> {
	if (request.matched === undefined) return {};
	const { operation, pathTemplate } = request.matched;
	return { operation: { operationId: operation.operationId, method: request.method, pathTemplate, summary: operation.summary } };
}

function isTextualResponse(contentType: string, accept: string): boolean {
	const lowerContentType = contentType.toLowerCase();
	if (lowerContentType) {
		return lowerContentType.includes('json') || lowerContentType.startsWith('text/') || lowerContentType.includes('xml');
	}

	const lowerAccept = accept.toLowerCase();
	return lowerAccept.includes('json') || lowerAccept.includes('text/') || lowerAccept.includes('xml');
}

function isJsonResponse(contentType: string, accept: string): boolean {
	const lowerContentType = contentType.toLowerCase();
	if (lowerContentType) return lowerContentType.includes('json');
	return accept.toLowerCase().includes('json');
}

function categorizeStatus(status: number): LexwareResponse['errorCategory'] | undefined {
	if (status === 400 || status === 406 || status === 422) return 'validation';
	if (status === 401) return 'auth';
	// 402: action not accessible due to a Lexware contract issue.
	if (status === 402 || status === 403) return 'permission';
	if (status === 404) return 'not_found';
	if (status === 409) return 'conflict';
	if (status === 429) return 'rate_limit';
	if (status >= 500 && status <= 599) return 'server';
	if (status < 200 || status >= 300) return 'unknown';
	return undefined;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);

	const retryDateMs = Date.parse(trimmed);
	if (!Number.isFinite(retryDateMs)) return undefined;
	const seconds = Math.ceil((retryDateMs - Date.now()) / 1000);
	return seconds > 0 ? seconds : undefined;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function sanitizeFetchErrorMessage(error: unknown, apiKey: string): string {
	const rawMessage = error instanceof Error ? error.message : String(error);
	const message = rawMessage.length > 0 ? rawMessage : 'unknown error';
	return message
		.replaceAll(apiKey, '[redacted]')
		.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
		.replace(/https?:\/\/[^\s)]+/gi, '[url omitted]');
}

function headersToObject(headers: Headers, includeAll: boolean): Record<string, string> {
	const object: Record<string, string> = {};
	headers.forEach((value, key) => {
		if (includeAll || isAllowedResponseHeader(key)) object[key] = value;
	});
	return object;
}

function queryToObject(query: URLSearchParams): Record<string, string[]> {
	const object: Record<string, string[]> = {};
	query.forEach((value, key) => {
		object[key] ??= [];
		object[key].push(value);
	});
	return object;
}
