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

### Connected account: `spec.info.account`

Both sandboxes see which Lexware organization the server is connected to in `spec.info.account`, so the model can confirm the account before reading or writing, and answer tax questions without calling `/v1/profile`:

```json
{
  "label": "Firma A",
  "organizationId": "aa93e8a8-2aa3-470b-b914-caad8a255dd8",
  "companyName": "Testfirma GmbH",
  "taxType": "net",
  "smallBusiness": false,
  "distanceSalesPrinciple": "DESTINATION",
  "businessFeatures": ["INVOICING", "BOOKKEEPING"]
}
```

- The server fetches `GET /v1/profile` on the first `search` or `execute` call and caches it for the process lifetime. The request doesn't count against `maxRequests` and doesn't appear in `requests`.
- The name and email of the user who created the API key (`profile.created`) are left out.
- On failure the profile fields are replaced by `error`, e.g. `"profile unavailable: auth (HTTP 401)"`. The lookup is retried after a minute, or on the next call after a timeout or 429. Without `LEXWARE_OFFICE_API_KEY`, `search` still works and no request is made.
- `search` waits at most a second for the lookup. If it takes longer, `error` is `"profile still loading; check again in a later call"` while it continues in the background; `execute` waits for it (up to 5 s).
- `label` is `LEXWARE_OFFICE_ACCOUNT_LABEL`, if set. Use it to tell several server instances apart, e.g. one per company.

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
- rate-limits host requests to one every 600 ms by default (a buffer below Lexware's 2 requests/second),
- retries a `GET` once when Lexware answers `429`, after `Retry-After` if it is ≤ 5 s or after a 1–2 s backoff if the header is missing, and holds back queued requests for that wait (writes are never retried; the wait counts against the 30 s `execute` timeout, the retry against `maxRequests`),
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
  updateVoucher(id: string, patch: Record<string, unknown>, options?: { expectedVersion?: number; allowFileRemoval?: boolean }): Promise<{ before: unknown; after: unknown; changed: string[] }>;
  uploadVoucherFile(input: FileInput & { waitForExtraction?: boolean | { timeoutMs?: number } }): Promise<{ fileId: string; voucherId: string; sent: UploadSent; voucher?: unknown; extraction: 'done' | 'pending' | 'skipped' }>;
  attachFileToVoucher(voucherId: string, input: FileInput): Promise<{ fileId: string; sent: UploadSent }>;
  sleep(ms: number): Promise<void>;
  findVouchers(criteria: { voucherNumber?: string; contactName?: string | RegExp; amount?: number; currency?: string; dateFrom?: string; dateTo?: string; voucherType?: string; voucherStatus?: string }, options?: { maxPages?: number }): Promise<Array<{ row: unknown; score: number; matched: string[] }>>;
};

type FileInput = { contentPath?: string; contentBase64?: string; filename?: string; contentType?: string }; // one of contentPath or contentBase64
type UploadSent = { bytes: number; parts: Array<{ name: string; filename?: string; bytes: number; sha256: string }> };
```

`lexware.sleep(ms)` waits inside the sandbox, e.g. between polls. One call waits at most 10,000 ms; the 30 s `execute` timeout bounds the total, and cancelling the call ends the wait. `uploadVoucherFile` and `attachFileToVoucher` are described in [Upload helpers](#upload-helpers-uploadvoucherfile-and-attachfiletovoucher).

`lexware.updateVoucher` updates a bookkeeping voucher without the usual `PUT /v1/vouchers/{id}` pitfalls, in 3 requests (`GET`, `PUT`, `GET`) against `maxRequests`:

- It starts from the current voucher, drops the read-only fields (`id`, `organizationId`, `voucherStatus`, `contactName`, `createdDate`, `updatedDate`) and applies `patch` shallowly: arrays such as `voucherItems` are replaced as a whole. Set `voucherStatus: 'open'` in `patch` to finalize an `unchecked` voucher.
- `useCollectiveContact: true` in `patch` also drops `contactId`; a `contactId` in `patch` without `useCollectiveContact` drops a current `useCollectiveContact`.
- It sends the current `version`; `patch.version` is rejected. With `expectedVersion` set, a voucher at a different version throws without writing.
- Lexware permanently deletes files left out of a PUT. The helper keeps `files` and throws without writing if the merged `files` would drop a current file id, unless `allowFileRemoval: true`.
- A non-OK PUT throws with the normalized Lexware `issues`. If the re-read after a successful PUT fails (e.g. `maxRequests` is used up), the error says the PUT went through; don't repeat it. After a successful PUT it re-reads the voucher, throws if a kept file is gone, and returns `before`, `after` and the top-level keys that `changed` (ignoring `version` and `updatedDate`).

```js
async () => {
  const { changed } = await lexware.updateVoucher('VOUCHER_ID', { remark: 'Checked' }, { expectedVersion: 3 });
  return changed;
}
```

`lexware.findVouchers` checks whether a document is already in Lexware before you upload it. The `voucherNumber` filter of `GET /v1/voucherlist` matches exactly, so differently formatted numbers slip through; the helper also finds those:

- It first queries the exact `voucherNumber` (1 request). If that finds no candidate, it pages `/v1/voucherlist` within `dateFrom`..`dateTo` (`voucherDateFrom`/`voucherDateTo`, `yyyy-MM-dd`) and scores the rows locally: 1 + pages requests against `maxRequests`. A window with more than `maxPages` pages (default 4, i.e. 1,000 vouchers) throws after its first page instead of checking only part of it: narrow the window, or raise `maxPages` and `maxRequests`.
- The window bounds that scan: without `dateFrom` and `dateTo`, an exact-number miss throws instead of scanning, and criteria without `voucherNumber` throw before any request.
- `voucherNumber` is compared ignoring case, spaces, dashes, dots and the leading zeros of the first digit group (`123 456 7890` = `1234567890`, `RE-0042` = `RE-42`). `contactName` is a case-insensitive substring or `RegExp`, `amount` matches `totalAmount` within ±0.01, and rows in another `currency` are dropped.
- Voucherlist rows of `unchecked` vouchers can lack `totalAmount`; amount matching skips those rows instead of failing.
- `voucherType` defaults to the bookkeeping types `purchaseinvoice,purchasecreditnote,salesinvoice,salescreditnote` (pass `'any'` to include sales documents such as `invoice` and `creditnote`), `voucherStatus` to `any`.
- It returns candidates sorted by `score` with the criteria that `matched`: `voucherNumber` 8, `amount` 4, `contactName` 2, `date` (inside the window) 1, so a number match always ranks first. Rows matching only the date are left out. It never decides whether a candidate is a duplicate; check them yourself.

```js
async () => {
  const candidates = await lexware.findVouchers({ voucherNumber: '123 456 7890', amount: 119, contactName: 'Muster', dateFrom: '2026-02-01', dateTo: '2026-04-30' });
  return candidates.slice(0, 5).map(({ row, score, matched }) => ({ id: row.id, voucherNumber: row.voucherNumber, score, matched }));
}
```

### Tool results and metadata

Both tools return a JSON text block (`{ ok, result, logs }`, plus `requestCount`, `requests` and possibly `readsSummary` for `execute`; `error` instead of `result` on failure, with `isError: true`). The same object is also returned as `structuredContent`. No `outputSchema` is declared because `result` is arbitrary.

Results whose JSON exceeds 24,000 characters are shrunk structurally, so the text block stays valid JSON: arrays keep their leading items followed by a `"[truncated: N more items]"` element, the largest object values are shrunk first (down to a `"[truncated: N chars]"` marker), objects with too many keys keep their leading keys plus a `"[truncated]"` entry naming the dropped ones, and long strings are clipped. `ok`, `requestCount`, `requests` and `readsSummary` are kept whole unless they alone come close to the limit. A top-level `truncated: { originalChars, note }` field then signals that the result is incomplete. Summarize or filter inside `execute` to avoid it.

`lexware.request` responses include only the headers useful for follow-up logic: `content-type`, `content-length`, `content-disposition`, `location`, `retry-after`, `x-request-id` and `x-ratelimit-*`. Pass `includeAllHeaders: true` to get every upstream header.

`requests` is an audit log of the HTTP attempts `execute` made, in the order the attempts finished — present on success and on failure. Every write and every non-OK, errored or unsent attempt is always listed. Successful reads are listed too, unless there are more than 5 of them; then they are left out of `requests` and counted in `readsSummary` instead, e.g. `{ "count": 18, "byStatus": { "200": 18 }, "totalDurationMs": 6120 }`.

```json
{ "method": "POST", "path": "/v1/invoices", "status": 201, "ok": true, "write": true, "sent": true, "durationMs": 412 }
```

Failed attempts (blocked writes, network errors, timeouts, cancellations) carry `error` instead of `status`/`ok`; a retried `429` shows up as two entries. `sent` tells whether the request reached `fetch`: `false` means Lexware never saw it (blocked, or cancelled while queued). A write with `error` and `sent: true`, or answered with `504`, also carries `"outcome": "unknown"` — it may have been applied by Lexware (e.g. aborted after sending, or the gateway timed out while Lexware kept processing), so reconcile with a `GET` before retrying it. Entries never contain headers, query values, bodies, or the API key. Use it after a failed execution to see which writes already succeeded before retrying. `requestCount` is the number of HTTP attempts actually sent to Lexware — the `requests` entries with `sent: true` plus the reads counted in `readsSummary`, so a retried `429` counts twice. `maxRequests` (default 10, max 50) bounds exactly that: requests rejected before sending (invalid input, blocked writes, cancelled while queued) don't count, and an attempt beyond the budget is not sent and fails with `Execution exceeded maxRequests=N` (it appears in `requests` with that `error` and `sent: false`).

Cancellation: when the client cancels a `search`/`execute` call, the execution ends with `Execution cancelled by client` and in-flight Lexware requests are aborted (they appear in `requests` with a cancelled `error`). The same happens when `execute` hits its 30 s timeout (`Execution timed out after 30000ms`). A single Lexware request times out after 25 s.

Tools carry MCP annotations and titles so clients can label and gate them:

- `search` — `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`.
- `execute` — `openWorldHint: true`, `idempotentHint: false`; `readOnlyHint`/`destructiveHint` follow the write mode at server startup (`readOnlyHint: true` when writes are blocked, `destructiveHint: true` when `LEXWARE_OFFICE_ALLOW_WRITES=true`, also with a write allowlist).

The server also sends short `instructions` at initialization (search before execute, check `spec.info.account`, `spec.info.writesEnabled` and `spec.info.writePolicy`, aggregate inside `execute`). It is built on MCP TypeScript SDK v2 and negotiates both the 2025-era `initialize` handshake and protocol revision 2026-07-28.

## Binary-safe file uploads

### Upload helpers: `uploadVoucherFile` and `attachFileToVoucher`

Uploading a Beleg creates a bookkeeping voucher that starts in status `blank` until Lexware's text recognition fills in number, date, contact and amounts (observed: a few seconds, up to about 15 s). `lexware.uploadVoucherFile` uploads and waits for that within one `execute` call:

```js
async () => {
  const { fileId, voucherId, extraction, voucher, sent } = await lexware.uploadVoucherFile({ contentPath: '/absolute/path/to/receipt.pdf' });
  return { fileId, voucherId, extraction, status: voucher?.voucherStatus, sent };
}
```

- Pass `contentPath`, or `contentBase64` with a `filename`. `contentType` defaults from the extension: `pdf`, `jpg`/`jpeg`, `png`, `xml`.
- It `POST`s `/v1/files` with `type=voucher` and throws if the upload fails or returns no `voucherId`.
- It then polls `GET /v1/vouchers/{voucherId}` after 2, 4 and 8 s and once more at the timeout (`waitForExtraction: { timeoutMs }`, default 15,000, at most 20,000) until the status is no longer `blank`. That's up to 5 requests and about 15 s, so one waiting upload fills most of an `execute` call (30 s timeout). For several files, upload them with `waitForExtraction: false` and read the vouchers in a later call.
- `extraction` is `done` (`voucher` holds the recognized voucher), `pending` (still `blank` at the timeout: `GET` the voucher in a later call) or `skipped` (`waitForExtraction: false`). It never uploads again. If waiting fails (a poll error or `maxRequests` used up), the error names the `fileId` and `voucherId`, because the upload itself went through.

`lexware.attachFileToVoucher(voucherId, { contentPath })` attaches a file to an existing voucher via `POST /v1/vouchers/{id}/files` (1 request) and returns `{ fileId, sent }`. Later voucher updates must keep that file id; `lexware.updateVoucher` does that for you.

Both helpers are writes and follow the same rules as the raw request modes below.

### Request modes

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
- `contentPath` must be an absolute path to a regular file on the machine running the MCP server (25 MB cap; Lexware itself accepts voucher files up to 5 MB).
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

### Write allowlist

With writes enabled, `LEXWARE_OFFICE_WRITE_ALLOW` narrows them down to a list. Unset allows every write; set, only the listed writes are allowed:

```json
{
  "LEXWARE_OFFICE_ALLOW_WRITES": "true",
  "LEXWARE_OFFICE_WRITE_ALLOW": "POST /v1/files, POST /v1/vouchers/{id}/files, PUT /v1/vouchers/{id}"
}
```

- Entries are separated by commas or newlines. Each is either `METHOD /v1/path` using the catalog's path template, or an operationId (`uploadFile, uploadFileToVoucher, updateVoucher` is equivalent to the example above). Path parameter names don't matter: `{id}` matches `{subscriptionId}`.
- Sales document endpoints with a `finalize` parameter (invoices, quotations, order confirmations, credit notes, delivery notes) only allow drafts unless the entry ends in `?finalize`: `POST /v1/invoices` creates drafts only, `POST /v1/invoices?finalize` also allows `finalize=true`. Any `finalize` value other than `false` counts as finalizing.
- Entries that don't name a cataloged write (typos, read endpoints, `?finalize` on an endpoint without it) and an empty value stop the server at startup with an error.
- Writes to paths not in the catalog, and write paths containing an encoded `/` or `\` (`%2F`, `%5C`), are always blocked while an allowlist is set.
- Blocked writes are rejected before sending (`sent: false` in `requests`), don't count against `maxRequests`, and the error lists the allowed writes.
- `spec.info.writePolicy` shows the policy to the model: `{ enabled, allow }`, where `allow` is `'all'` or the list of allowed writes in `METHOD /v1/template` form.
- `LEXWARE_OFFICE_READ_ONLY=true` and a missing `ALLOW_WRITES=true` still block every write; the allowlist only narrows enabled writes.

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
