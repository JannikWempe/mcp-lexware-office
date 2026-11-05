#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { AccountProfile } from './account.js';
import { catalogLookupDeclaration } from './catalog-lookup.js';
import { CodeMode, LEXWARE_REQUEST_TIMEOUT_MS } from './code-mode.js';
import { loadConfig, type ServerConfig } from './config.js';
import { LexwareApiClient } from './lexware-client.js';
import { lexwareSdkDeclaration } from './lexware-sandbox-sdk.js';
import { VERSION } from './version.js';

let config: ServerConfig;
try {
	config = loadConfig();
} catch (error) {
	// Misconfiguration (e.g. an unknown LEXWARE_OFFICE_WRITE_ALLOW entry) stops the server with a readable message.
	console.error(`Lexware Office MCP server: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
const client = new LexwareApiClient({
	apiKey: config.apiKey,
	baseUrl: config.baseUrl,
	uploadDirs: config.uploadDirs,
	writesEnabled: config.writesEnabled,
	writeAllow: config.writeAllow,
	requestTimeoutMs: LEXWARE_REQUEST_TIMEOUT_MS,
});
const codeMode = new CodeMode({ client, account: new AccountProfile(client, { label: config.accountLabel }) });

/**
 * One McpServer per connection; serveStdio picks the protocol era (2025-era initialize or 2026-07-28 server/discover).
 * Instructions, tool descriptions and schemas are model-facing: server-stdio.test.ts pins them in
 * tools-list.snapshot.json; preview with `pnpm -s run smoke [--writes]`.
 */
function createServer(): McpServer {
	const server = new McpServer(
		{
			name: 'lexware-office',
			version: VERSION,
		},
		{
			instructions: `Lexware Office API via Code Mode: \`search\` explores a curated API catalog, \`execute\` runs a sandboxed JS workflow against the live API.
Always call \`search\` to discover endpoints, parameters, and workflows before \`execute\`; do not guess /v1 paths from memory. Start with find('…') and describe(method, path), and return only what you need — avoid returning whole spec sections such as spec.workflows.
Check spec.info.account to confirm which Lexware organization you are connected to (companyName, taxType, smallBusiness) before reading or writing.
The server is read-only unless started with LEXWARE_OFFICE_ALLOW_WRITES=true; check spec.info.writesEnabled before planning writes, and spec.info.writePolicy.allow for which writes are permitted.
Summarize, filter, and aggregate inside \`execute\` and return only what is needed — large results are truncated.`,
		},
	);

	server.registerTool(
		'search',
		{
			title: 'Search Lexware API catalog',
			description: `Search the curated Lexware Office API catalog by running a JavaScript async arrow function.

Use this before execute to discover endpoints, request shapes, response notes, workflows, and domain-specific caveats.

Available globals:

declare const spec: LexwareApiCatalog;
${catalogLookupDeclaration}

Start with find('…'): it ranks operations, workflows and spec.info semantics by your words (English or German, e.g. 'upload beleg', 'umsatz') and returns compact matches with a hint where to read more. Then read only the entries you need with describe(method, path) or the hint path. Return only what you need: avoid returning whole sections such as spec.workflows, spec.paths entries with all their tags, or several spec.info semantics at once — large results are truncated.

Useful starting points:
- spec.info.domainIndex: compact map from business domains to endpoint lists
- spec.info.account: the connected organization — { label?, organizationId, companyName, taxType, smallBusiness, distanceSalesPrinciple?, businessFeatures } or { label?, error } — check it to confirm which organization you are connected to; no need to call /v1/profile
- spec.info.writesEnabled: whether this server currently allows POST/PUT/PATCH/DELETE — check before planning writes
- spec.info.writePolicy: { enabled, allow } — allow is 'all' or the only permitted writes, e.g. ['POST /v1/files', 'PUT /v1/vouchers/{id}']
- spec.paths: path -> method -> operation catalog with params, requestBody, responses, examples, capabilities, docsUrl
- spec.workflows: curated recipes for reporting, sales documents, files/uploads, webhooks, and API quirks
- spec.info.voucherStatusSemantics and financeReportingSemantics: finance/status guidance for revenue/Umsatz/profit questions

Sandbox: no network, filesystem, process, fetch, imports, or API key. Return JSON-serializable data; console logs are captured.

Examples:

async () => find('upload beleg')

async () => describe('GET', '/v1/voucherlist')

async () => spec.workflows.fileHandling.steps

async () => Object.entries(spec.info.domainIndex)
  .filter(([name, domain]) => [name, ...domain.tags].some(value => value.toLowerCase().includes('contact')))
  .map(([name, domain]) => ({ name, ...domain }))`,
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
${catalogLookupDeclaration}
${lexwareSdkDeclaration}

lexware.request returns all HTTP responses, including non-OK, as LexwareResponse. Check response.ok/status for recovery logic, or use lexware.json(...) / lexware.paginate(...) when you want non-OK or non-JSON responses to throw. A GET answered with 429 is retried once automatically after Retry-After (if <= 5s) or, without that header, a 1-2s backoff; writes are never retried.

The tool result includes requests: one { method, path, status?, ok?, error?, write, sent, outcome?, durationMs } entry per HTTP attempt, also when execution failed — check it to see which writes already succeeded before retrying. Every write and every non-OK, errored, or unsent attempt is always listed; when there are more than 5 successful reads, those reads are replaced by readsSummary: { count, byStatus, totalDurationMs }. A write with outcome: 'unknown' (sent=true, with error or status 504) may have been applied by Lexware; reconcile via a GET before retrying it.

maxRequests bounds the HTTP attempts actually sent to Lexware, including automatic 429 retries; requestCount counts every sent attempt, including reads collapsed into readsSummary. Requests rejected before sending (invalid input, blocked writes) do not count. An attempt beyond the budget is not sent and fails with "Execution exceeded maxRequests=N".

dryRun: true previews writes without sending them. Reads run normally, so the script can still make data-dependent decisions. Each POST, PUT, PATCH, or DELETE is not sent and returns a synthetic { ok: true, status: 0, dryRun: true, planned } response without data (lexware.json returns undefined). This also happens when writes are disabled or not allowlisted; planned.blocked then says why a real run would reject it. contentPath files are still read and hashed, so planned.multipart shows the exact bytes and sha256. The tool result adds dryRun: true and plannedWrites: every planned write in order, with method, path, query, and body (large bodies are shrunk). A script that needs a write's response, e.g. a new id, should branch with if (response.dryRun) …. Planned writes don't count against maxRequests; a dry run plans at most 100.

This server is read-only by default. POST, PUT, PATCH, and DELETE are blocked unless the server is started with LEXWARE_OFFICE_ALLOW_WRITES=true. Setting LEXWARE_OFFICE_READ_ONLY=true is a hard block that overrides ALLOW_WRITES. Check spec.info.writesEnabled to branch before attempting a write. LEXWARE_OFFICE_WRITE_ALLOW can further restrict writes to a list: spec.info.writePolicy.allow is then the only writes permitted ('METHOD /v1/template'; a '?finalize' suffix also allows finalize=true, otherwise sales documents can only be created as drafts). Writes outside it are rejected before sending.

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
				dryRun: z
					.boolean()
					.optional()
					.default(false)
					.describe('Preview writes: run reads normally, but plan writes instead of sending them and list them in plannedWrites.'),
			}),
			annotations: { readOnlyHint: !writes, destructiveHint: writes, idempotentHint: false, openWorldHint: true },
		},
		async ({ code, maxRequests, dryRun }, ctx) => codeMode.execute(code, { maxRequests, dryRun, signal: ctx.mcpReq.signal }),
	);

	return server;
}

serveStdio(createServer, {
	onerror: (error) => console.error('Lexware Office MCP server error:', error),
});
