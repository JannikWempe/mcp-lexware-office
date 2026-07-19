import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import { lexwareSpec, type HttpMethod, type LexwareOperation } from './lexware-spec.js';
import { truncateText } from './truncate.js';
import { VERSION } from './version.js';

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
}

export interface LexwareClientOptions {
	apiKey?: string;
	baseUrl?: string;
	userAgent?: string;
	fetchImpl?: typeof fetch;
	maxResponseChars?: number;
	requestTimeoutMs?: number;
	rateLimitIntervalMs?: number;
}

export interface LexwareRequestOptions {}

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
	data?: unknown;
	text?: string;
	truncated?: boolean;
	sent?: UploadEcho;
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
	matched?: MatchedOperation;
}

const DEFAULT_BASE_URL = 'https://api.lexware.io';
const DEFAULT_USER_AGENT = `mcp-lexware-office/${VERSION}`;
const DEFAULT_MAX_RESPONSE_CHARS = 24_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_INTERVAL_MS = 500;
const WRITE_METHODS = new Set<LexwareExecuteMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

export class LexwareApiClient {
	private readonly apiKey?: string;
	private readonly baseUrl: string;
	private readonly userAgent: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxResponseChars: number;
	private readonly requestTimeoutMs: number;
	private readonly rateLimitIntervalMs: number;
	private nextRequestAtMs = 0;
	private rateLimitQueue: Promise<void> = Promise.resolve();

	constructor(options: LexwareClientOptions = {}) {
		this.apiKey = options.apiKey ?? process.env.LEXWARE_OFFICE_API_KEY;
		this.baseUrl = options.baseUrl ?? process.env.LEXWARE_OFFICE_API_BASE_URL ?? DEFAULT_BASE_URL;
		this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.maxResponseChars = options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.rateLimitIntervalMs = options.rateLimitIntervalMs ?? DEFAULT_RATE_LIMIT_INTERVAL_MS;
	}

	async request(input: unknown, _options: LexwareRequestOptions = {}): Promise<LexwareResponse> {
		const apiKey = this.apiKey;
		if (!apiKey) {
			throw new Error('LEXWARE_OFFICE_API_KEY environment variable is required for the execute tool');
		}

		const normalized = normalizeRequest(input);
		if (WRITE_METHODS.has(normalized.method) && writesAreGloballyDisabled()) {
			throw new Error(`${normalized.method} ${normalized.path} is blocked: writes are disabled by default. Set LEXWARE_OFFICE_ALLOW_WRITES=true to enable writes (LEXWARE_OFFICE_READ_ONLY=true overrides this).`);
		}

		await this.waitForRateLimitTurn();

		const url = new URL(normalized.path, this.baseUrl);
		url.search = normalized.query.toString();

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
		try {
			const headers: Record<string, string> = {
				'User-Agent': this.userAgent,
				Accept: normalized.accept,
				Authorization: `Bearer ${apiKey}`,
			};

			const { body, sent } = await serializeRequestBody(normalized, headers);

			let response: Response;
			try {
				response = await this.fetchImpl(url, {
					method: normalized.method,
					headers,
					body,
					signal: controller.signal,
				});
			} catch (error) {
				if (controller.signal.aborted || isAbortError(error)) {
					throw new Error(`Lexware API request timed out after ${this.requestTimeoutMs}ms for ${normalized.method} ${normalized.path}`);
				}
				throw new Error(`Lexware API network error for ${normalized.method} ${normalized.path}: ${sanitizeFetchErrorMessage(error, apiKey)}`);
			}

			const parsed = await parseResponse(response, normalized, this.maxResponseChars);
			return sent !== undefined ? { ...parsed, sent } : parsed;
		} finally {
			clearTimeout(timeout);
		}
	}

	private waitForRateLimitTurn(): Promise<void> {
		if (this.rateLimitIntervalMs <= 0) return Promise.resolve();

		const wait = this.rateLimitQueue.then(async () => {
			const now = Date.now();
			const delayMs = Math.max(0, this.nextRequestAtMs - now);
			if (delayMs > 0) await delay(delayMs);
			this.nextRequestAtMs = Date.now() + this.rateLimitIntervalMs;
		});
		this.rateLimitQueue = wait.catch(() => undefined);
		return wait;
	}
}

function normalizeRequest(input: unknown): NormalizedRequest {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('lexware.request expects an object: { method?, path, query?, body?, contentType?, rawBody?, accept? }');
	}

	const request = input as LexwareRequestInput;
	const method = normalizeMethod(request.method ?? 'GET');
	const rawPath = normalizePath(request.path);
	const accept = normalizeHeaderValue(request.accept ?? 'application/json', 'accept');
	const contentType = request.contentType === undefined ? undefined : normalizeHeaderValue(request.contentType, 'contentType');
	const rawBody = normalizeRawBody(request.rawBody ?? false);
	const url = new URL(rawPath, DEFAULT_BASE_URL);
	if (!url.pathname.startsWith('/v1/')) {
		throw new Error('path must resolve to /v1/ and must not escape that prefix');
	}
	const matched = matchOperation(url.pathname, method);

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

function normalizeRawBody(rawBody: unknown): boolean {
	if (typeof rawBody !== 'boolean') throw new Error('rawBody must be a boolean when provided');
	return rawBody;
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

const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

interface SerializedBody {
	body: BodyInit | undefined;
	sent?: UploadEcho;
}

async function serializeRequestBody(request: NormalizedRequest, headers: Record<string, string>): Promise<SerializedBody> {
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
				buffer = await readUploadFile(part.contentPath);
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

async function readUploadFile(contentPath: string): Promise<Buffer<ArrayBuffer>> {
	let stats;
	try {
		stats = await stat(contentPath);
	} catch {
		throw new Error(`multipart contentPath not found or not readable: ${contentPath}`);
	}
	if (!stats.isFile()) {
		throw new Error(`multipart contentPath must be a regular file: ${contentPath}`);
	}
	if (stats.size > MAX_UPLOAD_FILE_BYTES) {
		throw new Error(`multipart contentPath file is ${stats.size} bytes, exceeding the ${MAX_UPLOAD_FILE_BYTES} byte upload limit: ${contentPath}`);
	}
	return readFile(contentPath) as Promise<Buffer<ArrayBuffer>>;
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
	const headers = headersToObject(response.headers);
	const base: Omit<LexwareResponse, 'data' | 'text' | 'truncated'> = {
		ok: response.ok,
		status: response.status,
		statusText: response.statusText,
		...(request.matched ? {
			operation: {
				operationId: request.matched.operation.operationId,
				method: request.method,
				pathTemplate: request.matched.pathTemplate,
				summary: request.matched.operation.summary,
			},
		} : {}),
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

	if (isJsonResponse(contentType, request.accept)) {
		try {
			return { ...base, data: text.length > 0 ? JSON.parse(text) : null };
		} catch {
			// Fall through to compact text handling for malformed JSON responses.
		}
	}

	const truncated = text.length > maxResponseChars;
	const safeText = truncated ? truncateText(text, { maxChars: maxResponseChars }) : text;
	return { ...base, text: safeText, truncated };
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
	if (status === 400 || status === 422) return 'validation';
	if (status === 401) return 'auth';
	if (status === 403) return 'permission';
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

export function writesEnabled(): boolean {
	return !writesAreGloballyDisabled();
}

function writesAreGloballyDisabled(): boolean {
	// Hard block: READ_ONLY wins over everything.
	if (process.env.LEXWARE_OFFICE_READ_ONLY === 'true') return true;
	// Writes are blocked by default. Writes require explicit opt-in.
	return process.env.LEXWARE_OFFICE_ALLOW_WRITES !== 'true';
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function headersToObject(headers: Headers): Record<string, string> {
	const object: Record<string, string> = {};
	headers.forEach((value, key) => {
		object[key] = value;
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
