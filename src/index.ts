#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { CodeMode, LEXWARE_REQUEST_TIMEOUT_MS } from './code-mode.js';
import { loadConfig } from './config.js';
import { LexwareApiClient } from './lexware-client.js';
import { VERSION } from './version.js';

const config = loadConfig();
const codeMode = new CodeMode({
	client: new LexwareApiClient({
		apiKey: config.apiKey,
		baseUrl: config.baseUrl,
		uploadDirs: config.uploadDirs,
		writesEnabled: config.writesEnabled,
		requestTimeoutMs: LEXWARE_REQUEST_TIMEOUT_MS,
	}),
});

// One McpServer per connection; serveStdio picks the protocol era (2025-era initialize or 2026-07-28 server/discover).
function createServer(): McpServer {
	const server = new McpServer(
		{
			name: 'lexware-office',
			version: VERSION,
		},
		{
			instructions: `Lexware Office API via Code Mode: \`search\` explores a curated API catalog, \`execute\` runs a sandboxed JS workflow against the live API.
Always call \`search\` to discover endpoints, parameters, and workflows before \`execute\`; do not guess /v1 paths from memory.
The server is read-only unless started with LEXWARE_OFFICE_ALLOW_WRITES=true; check spec.info.writesEnabled before planning writes.
Summarize, filter, and aggregate inside \`execute\` and return only what is needed — large results are truncated.`,
		},
	);

	server.registerTool(
		'search',
		{
			title: 'Search Lexware API catalog',
			description: `Search the curated Lexware Office API catalog by running a JavaScript async arrow function.

Use this before execute to discover endpoints, request shapes, response notes, workflows, and domain-specific caveats.

Available global:

declare const spec: LexwareApiCatalog;

Useful starting points:
- spec.info.domainIndex: compact map from business domains to endpoint lists
- spec.info.writesEnabled: whether this server currently allows POST/PUT/PATCH/DELETE — check before planning writes
- spec.paths: path -> method -> operation catalog with params, requestBody, responses, examples, capabilities, docsUrl
- spec.workflows: curated recipes for reporting, sales documents, files/uploads, webhooks, and API quirks
- spec.info.voucherStatusSemantics and financeReportingSemantics: finance/status guidance for revenue/Umsatz/profit questions

Sandbox: no network, filesystem, process, fetch, imports, or API key. Return JSON-serializable data; console logs are captured.

Examples:

async () => Object.entries(spec.info.domainIndex)
  .filter(([name, domain]) => [name, ...domain.tags].some(value => value.toLowerCase().includes('contact')))
  .map(([name, domain]) => ({ name, ...domain }))

async () => {
  const op = spec.paths['/v1/voucherlist']?.get;
  return { summary: op?.summary, parameters: op?.parameters, notes: op?.notes, examples: op?.examples };
}`,
			inputSchema: z.object({
				code: z.string().describe('JavaScript async arrow function to search the Lexware API catalog'),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ code }, ctx) => codeMode.search(code, { signal: ctx.mcpReq.signal }),
	);

	const writes = config.writesEnabled;

	server.registerTool(
		'execute',
		{
			title: 'Execute Lexware API workflow',
			description: `Execute a constrained Lexware Office API workflow by running a JavaScript async arrow function.

Use search first when you need endpoint/domain guidance; do not guess Lexware paths from memory. The sandbox exposes no API key, filesystem, process, imports, fetch, or arbitrary network access.

Available globals:

declare const spec: LexwareApiCatalog;
declare const lexware: {
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
};

lexware.request returns all HTTP responses, including non-OK, as LexwareResponse. Check response.ok/status for recovery logic, or use lexware.json(...) / lexware.paginate(...) when you want non-OK or non-JSON responses to throw. A GET answered with 429 and Retry-After <= 5s is retried once automatically.

The tool result includes requests: one { method, path, status?, ok?, error?, write, sent, outcome?, durationMs } entry per HTTP attempt, also when execution failed — check it to see which writes already succeeded before retrying. A write with error and outcome: 'unknown' (sent=true) may have been applied by Lexware; reconcile via a GET before retrying it.

maxRequests bounds the HTTP attempts actually sent to Lexware, including automatic 429 retries; requestCount equals the number of requests entries with sent=true. Requests rejected before sending (invalid input, blocked writes) do not count. An attempt beyond the budget is not sent and fails with "Execution exceeded maxRequests=N".

This server is read-only by default. POST, PUT, PATCH, and DELETE are blocked unless the server is started with LEXWARE_OFFICE_ALLOW_WRITES=true. Setting LEXWARE_OFFICE_READ_ONLY=true is a hard block that overrides ALLOW_WRITES. Check spec.info.writesEnabled to branch before attempting a write.

Example:

async () => {
  const response = await lexware.request({ path: '/v1/contacts', query: { page: 0, size: 5 } });
  return { status: response.status, request: response.request, data: response.data };
}

File upload example (bookkeeping Beleg). Never inline file bytes in code — pass the file's absolute path via contentPath (requires LEXWARE_OFFICE_UPLOAD_DIRS, see MultipartPart) and the host reads it from disk:

async () => {
  const response = await lexware.request({
    method: 'POST',
    path: '/v1/files',
    multipart: [
      { name: 'file', contentType: 'application/pdf', contentPath: '/absolute/path/to/receipt.pdf' },
      { name: 'type', value: 'voucher' },
    ],
  });
  return { status: response.status, id: response.data?.id, sent: response.sent };
}`,
			inputSchema: z.object({
				code: z.string().describe('JavaScript async arrow function to execute a constrained Lexware API workflow'),
				maxRequests: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.default(10)
					.describe('Maximum number of HTTP attempts this execution may send to Lexware, including automatic 429 retries.'),
			}),
			annotations: { readOnlyHint: !writes, destructiveHint: writes, idempotentHint: false, openWorldHint: true },
		},
		async ({ code, maxRequests }, ctx) => codeMode.execute(code, { maxRequests, signal: ctx.mcpReq.signal }),
	);

	return server;
}

serveStdio(createServer, {
	onerror: (error) => console.error('Lexware Office MCP server error:', error),
});
