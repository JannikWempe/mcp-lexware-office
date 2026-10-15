# Guide: Code Mode MCP server

This document explains how the `mcp-lexware-office` MCP server works and how to use it effectively.

## Distribution model

End users should consume `mcp-lexware-office` as a packaged Node MCP server, not by running TypeScript source files directly.

The package follows the standard TypeScript MCP layout:

- `bin` entries point to compiled JavaScript in `build/`.
- `files: ["build", "docs"]` keeps published tarballs small.
- `prepare` runs `npm run build` for GitHub installs, so `build/` does not need to be committed.

For GitHub installs, use an explicit GitHub package spec:

<!-- x-release-please-start-major -->
```json
"args": ["-y", "--package=github:JannikWempe/mcp-lexware-office#semver:^3", "lexware-office"]
```
<!-- x-release-please-end -->

After publishing to npm, use the npm package name instead:

```json
"args": ["-y", "--package=mcp-lexware-office", "lexware-office"]
```

For local development only, after cloning the repo and installing dependencies, it is fine to run the TypeScript source with `tsx`:

```json
"args": ["-y", "tsx", "/absolute/path/to/mcp-lexware-office/src/index.ts"]
```

## Why Code Mode

Endpoint-shaped MCP tools (one tool per API operation) are approachable, but the tool list becomes large and still cannot cover every Lexware API edge case perfectly.

This server uses a smaller tool surface:

1. `search` helps the model inspect a curated Lexware API catalog.
2. `execute` lets the model run a constrained API workflow using `lexware.request`.

This gives better coverage for:

- less common Lexware endpoints,
- multi-step reporting questions,
- pagination and aggregation,
- API behavior that needs catalog notes or examples,
- workflows that would otherwise require many narrowly shaped MCP tools.

## The two tools

### `search`

`search` runs a sandboxed JavaScript async arrow function against a curated OpenAPI-lite catalog in `src/lexware-spec.ts`.

Example:

```js
async () => {
  return Object.entries(spec.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => ({
        method,
        path,
        summary: op.summary,
        tags: op.tags
      }))
    )
    .filter(op => op.tags.includes('contacts'));
}
```

The `search` sandbox receives only the catalog. It does not receive the Lexware API key, Node globals, filesystem access, `fetch`, imports, or arbitrary network access.

### `execute`

`execute` uses the same sandbox plus one host capability: `lexware.request`.

Example:

```js
async () => {
  const response = await lexware.request({
    method: 'GET',
    path: '/v1/contacts',
    query: { name: 'Muster', page: 0, size: 10 }
  });

  if (!response.ok) {
    return { status: response.status, errorCategory: response.errorCategory, data: response.data };
  }

  return response.data;
}
```

`lexware.request`:

- calls only relative `/v1/...` Lexware API paths,
- rejects absolute URLs and external hosts,
- hides the API key from sandboxed code,
- rate-limits host requests to 2 requests/second by default,
- retries a `GET` once when Lexware answers `429` with `Retry-After` ≤ 5 s (writes are never retried; the wait counts against the 30 s `execute` timeout, the retry against `maxRequests`),
- returns JSON/text or binary metadata,
- adds operation metadata when the request matches the catalog,
- allows unknown `/v1/...` paths for API coverage gaps.

Useful helper methods are also exposed inside `execute`:

```ts
declare const lexware: {
  request<T = unknown>(input: LexwareRequest): Promise<LexwareResponse<T>>;
  json(input: LexwareRequest): Promise<unknown>;
  paginate<T = unknown>(input: LexwareRequest, options?: { maxPages?: number }): Promise<T[]>;
  requireNumber(row: unknown, fieldPath: string): number;
  requireMoney(row: unknown, fieldPath: string): number;
  sumMoney(rows: unknown[], fieldPath: string): number;
  formatMoney(cents: number, currency?: string): string;
};
```

### Tool results and metadata

Both tools return a JSON text block (`{ ok, result, logs }`, plus `requestCount` and `requests` for `execute`; `error` instead of `result` on failure, with `isError: true`). The same object is also returned as `structuredContent` unless the serialized JSON exceeds the 24,000-character truncation limit — then only the truncated text block is returned. No `outputSchema` is declared because `result` is arbitrary.

`requests` is an audit log of every HTTP attempt `execute` made, in the order the attempts finished — present on success and on failure:

```json
{ "method": "POST", "path": "/v1/invoices", "status": 201, "ok": true, "write": true, "sent": true, "durationMs": 412 }
```

Failed attempts (blocked writes, network errors, timeouts, cancellations) carry `error` instead of `status`/`ok`; a retried `429` shows up as two entries. `sent` tells whether the request reached `fetch`: `false` means Lexware never saw it (blocked, or cancelled while queued). A write with `error` and `sent: true` also carries `"outcome": "unknown"` — it may have been applied by Lexware (e.g. aborted after sending), so reconcile with a `GET` before retrying it. Entries never contain headers, query values, bodies, or the API key. Use it after a failed execution to see which writes already succeeded before retrying. `requestCount` is the number of HTTP attempts actually sent to Lexware — the entries with `sent: true`, so a retried `429` counts twice. `maxRequests` (default 10, max 50) bounds exactly that: requests rejected before sending (invalid input, blocked writes, cancelled while queued) don't count, and an attempt beyond the budget is not sent and fails with `Execution exceeded maxRequests=N` (it appears in `requests` with that `error` and `sent: false`).

Cancellation: when the client cancels a `search`/`execute` call, the execution ends with `Execution cancelled by client` and in-flight Lexware requests are aborted (they appear in `requests` with a cancelled `error`). The same happens when `execute` hits its 30 s timeout (`Execution timed out after 30000ms`). A single Lexware request times out after 25 s.

Tools carry MCP annotations and titles so clients can label and gate them:

- `search` — `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`.
- `execute` — `openWorldHint: true`, `idempotentHint: false`; `readOnlyHint`/`destructiveHint` follow the write mode at server startup (`readOnlyHint: true` when writes are blocked, `destructiveHint: true` when `LEXWARE_OFFICE_ALLOW_WRITES=true`).

The server also sends short `instructions` at initialization (search before execute, check `spec.info.writesEnabled`, aggregate inside `execute`). It is built on MCP TypeScript SDK v2 and negotiates both the 2025-era `initialize` handshake and protocol revision 2026-07-28.

## Binary-safe file uploads

Three binary-safe upload modes are supported in addition to the legacy `rawBody=true` string-based multipart. Prefer `multipart` with `contentPath` — the file's bytes never pass through the model or the sandbox.

### `multipart` with `contentPath` — host reads a local file (preferred)

For multipart uploads (e.g. `/v1/files`, `/v1/vouchers/{id}/files`), pass the file's absolute path. The host reads the file from disk outside the QuickJS sandbox and builds `FormData` with `Blob` parts:

```js
async () => {
  const response = await lexware.request({
    method: 'POST',
    path: '/v1/files',
    multipart: [
      { name: 'file', contentType: 'application/pdf', contentPath: '/absolute/path/to/receipt.pdf' },
      { name: 'type', value: 'voucher' },
    ],
  });
  // response.sent echoes what was uploaded for integrity checks:
  // { bytes, parts: [{ name, filename, bytes, sha256 }] }
  return { id: response.data?.id, sent: response.sent };
}
```

- `contentPath` is disabled unless the server sets `LEXWARE_OFFICE_UPLOAD_DIRS` (see [Upload directories](#upload-directories)); the file must lie inside one of those directories. Without it, use `contentBase64`.
- `contentPath` must be an absolute path to a regular file on the machine running the MCP server (25 MB cap).
- In Docker, `contentPath` refers to the container's filesystem: mount the directory and set `LEXWARE_OFFICE_UPLOAD_DIRS` to the container path (e.g. `-v /host/dir:/data:ro -e LEXWARE_OFFICE_UPLOAD_DIRS=/data`), then pass `/data/...` paths.
- `filename` defaults to the `contentPath` basename.
- Uploads are writes: they require `LEXWARE_OFFICE_ALLOW_WRITES=true`. Check `spec.info.writesEnabled` to branch early.

### `multipart` with `contentBase64` — binary FormData parts

When the bytes are only available as base64 (e.g. fetched externally), use `contentBase64` instead of `contentPath`. The host decodes the base64 outside the sandbox:

```js
{ name: 'file', filename: 'receipt.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0x...' }
```

### `bodyBase64` — raw binary body

Send a raw (non-multipart) binary request body by base64-encoding it and setting `bodyBase64`. The host decodes the base64 and sends the raw bytes. `contentType` defaults to `application/octet-stream`. Not usable on multipart endpoints like `/v1/files` — those reject non-multipart bodies before sending (see below).

Key constraints:
- `body`, `bodyBase64`, and `multipart` are mutually exclusive — set at most one per request.
- `value`, `contentBase64`, and `contentPath` are mutually exclusive within a single multipart part — set exactly one.
- GET requests may not include any body mode.
- Invalid base64 and unreadable or non-allowlisted `contentPath` files are rejected before the request is sent.
- Endpoints cataloged as `multipart/form-data` reject `body`/`bodyBase64` up front (instead of an opaque Lexware 500) unless an explicit `contentType` containing `multipart/` and a boundary marks a deliberately hand-rolled body.
- Requests with binary payloads echo `response.sent` (`bytes`, `sha256` per part) so callers can verify what was uploaded.

### Upload directories

`LEXWARE_OFFICE_UPLOAD_DIRS` is the allowlist of directories `contentPath` may read from, separated by the platform path delimiter (`:` on macOS/Linux, `;` on Windows):

```json
{
  "LEXWARE_OFFICE_ALLOW_WRITES": "true",
  "LEXWARE_OFFICE_UPLOAD_DIRS": "/Users/me/Documents/Belege:/Users/me/Downloads"
}
```

- Unset or empty → `contentPath` is disabled; `contentBase64` and `bodyBase64` still work.
- Both the directories and the file are resolved with `realpath`, so symlinks cannot escape the allowlist. Subdirectories are allowed.
- Paths outside the allowlist get one uniform error, whether or not the file exists.
- The write gate runs first: with writes disabled, uploads are blocked before any file is touched.

### Legacy `rawBody=true`

The original `rawBody=true` mode is preserved for backward compatibility. It sends a string body verbatim (UTF-8 encoded) and is adequate for text-based multipart (e.g. manually constructed ASCII boundaries). It is **not** binary-safe for arbitrary byte sequences — use `multipart` with `contentPath`/`contentBase64` or `bodyBase64` for true binary payloads.

## Permissions

**The server is read-only by default.** Because `execute` is a single powerful tool (not separate per-operation MCP tools), writes are blocked unless explicitly opted in.

To enable writes, set:

```json
{
  "LEXWARE_OFFICE_ALLOW_WRITES": "true"
}
```

`LEXWARE_OFFICE_READ_ONLY=true` is a hard block that overrides `ALLOW_WRITES=true`:

```json
{
  "LEXWARE_OFFICE_READ_ONLY": "true"
}
```

Priority order (highest wins):

1. `LEXWARE_OFFICE_READ_ONLY=true` → writes always blocked
2. `LEXWARE_OFFICE_ALLOW_WRITES=true` → writes allowed
3. Default (neither set) → writes blocked

When writes are blocked, `POST`, `PUT`, `PATCH`, and `DELETE` requests are rejected with a clear error message.

Important behavior:

- Default read-only mirrors how Cloudflare's OAuth scope template defaults to read-only; Lexware API keys have no equivalent OAuth scopes, so the MCP server provides the safety boundary.
- Writes should only be enabled when the user explicitly needs a write operation.
- The API key remains in the host process and is never exposed to sandboxed code.

## Migrating: `contentPath` requires `LEXWARE_OFFICE_UPLOAD_DIRS`

This change ships in 3.0.0; installs pinned to `#semver:^2` do not receive it. Use the package spec from [Distribution model](#distribution-model).

`multipart` `contentPath` uploads used to read any absolute path on the server machine. They now only read files inside the directories listed in `LEXWARE_OFFICE_UPLOAD_DIRS`, and are disabled when it is unset. If you upload local files via `contentPath`, add the directories holding them (see [Upload directories](#upload-directories)); in Docker, set it to the mounted container path. `contentBase64` uploads are unaffected.

## Migrating from 1.x

Version 1.x shipped a second, legacy server with one MCP tool per Lexware operation (`get-contacts`, `create-invoice`, `upload-file`, ...). Version 2.0.0 removed it; Code Mode is the only server.

To migrate a 1.x config:

1. Use the package spec from [Distribution model](#distribution-model) (or the npm package once published).
2. Use the `lexware-office` binary. (`lexware-office-v2` still works as a deprecated alias and prints a deprecation warning on startup.)
3. Remove any `disabledTools` lists — permissioning is now env-based (see [Permissions](#permissions)).
4. Writes are now blocked by default. Set `LEXWARE_OFFICE_ALLOW_WRITES=true` if you need create/update/finalize/upload operations.

Interaction pattern changes for the model:

Read operations — instead of `get-contacts` with filters:

```js
async () => {
  return await lexware.json({
    path: '/v1/contacts',
    query: { name: 'Muster', page: 0, size: 10 }
  });
}
```

Detail operations — instead of `get-contact-details` with an id:

```js
async () => {
  const contactId = '00000000-0000-0000-0000-000000000000';
  return await lexware.json({ path: `/v1/contacts/${contactId}` });
}
```

Create/update operations — instead of `create-contact`/`update-contact`:

```js
async () => {
  const response = await lexware.request({
    method: 'POST',
    path: '/v1/contacts',
    body: {
      version: 0,
      roles: { customer: {} },
      company: { name: 'Muster GmbH' },
      addresses: {
        billing: [{ street: 'Musterstraße 1', zip: '12345', city: 'Musterstadt', countryCode: 'DE' }]
      }
    }
  });

  return { status: response.status, ok: response.ok, data: response.data };
}
```

Reporting and aggregation — pagination and aggregation now happen inside one sandboxed execution instead of several tool calls:

```js
async () => {
  const rows = await lexware.paginate({
    path: '/v1/voucherlist',
    query: { voucherType: 'invoice', voucherStatus: 'paid', size: 100 }
  }, { maxPages: 5 });

  return {
    count: rows.length,
    totalAmount: lexware.formatMoney(lexware.sumMoney(rows, 'totalAmount'))
  };
}
```

Users who still need the legacy tool-per-endpoint server can pin the final 1.x release: `github:JannikWempe/mcp-lexware-office#semver:^1`.
