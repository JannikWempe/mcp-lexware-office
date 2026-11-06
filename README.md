# Lexware Office MCP Server

An MCP server for [Lexware Office](https://www.lexware.de/lexware-office/) (formerly Lexoffice). It lets MCP-capable assistants query and manage contacts, sales documents, vouchers, files, payments, webhooks, and reference data through the Lexware Office public API.

The server uses **Code Mode**: instead of one MCP tool per API endpoint, it exposes two tools — `search` to explore a curated Lexware API catalog and `execute` to run constrained, sandboxed API workflows. This keeps the tool surface small while covering the whole API, including pagination, aggregation, and multi-step reporting in a single call.

> Upgrading from 1.x? The legacy tool-per-endpoint server was removed in 2.0.0. See [docs/guide.md#migrating-from-1x](docs/guide.md#migrating-from-1x).
>
> Using `contentPath` uploads? They now require `LEXWARE_OFFICE_UPLOAD_DIRS`. See [docs/guide.md#migrating-contentpath-requires-lexware_office_upload_dirs](docs/guide.md#migrating-contentpath-requires-lexware_office_upload_dirs).

## Features

- **Broad Lexware Office API coverage** for read and write workflows
- **Sales documents**: invoices, quotations, order confirmations, credit notes, delivery notes, dunning notices, and down-payment invoices
- **Contact management**: create, read, and update customers and vendors
- **Bookkeeping**: vouchers, posting categories, payments, and file uploads
- **Reference data**: profile, countries, print layouts, payment conditions, recurring templates
- **Webhooks**: create, list, inspect, and delete event subscriptions
- **Read-only by default**: writes require explicit opt-in via environment variable
- **Workflow prompts and skills**: receipt uploads, revenue and profit reports, and invoices as MCP prompts and MCP Skills generated from the catalog
- **Dry runs**: preview the exact writes a workflow would send, including upload hashes, without sending them

## How it works

The server exposes two MCP tools:

- `search` — runs a sandboxed JavaScript async arrow function against a curated OpenAPI-lite Lexware catalog, with `find`/`describe` helpers for a ranked, compact lookup.
- `execute` — runs a sandboxed JavaScript async arrow function with the `lexware` SDK: `lexware.request` for relative `/v1/...` Lexware API calls, plus helpers for pagination, money, voucher updates, uploads and waiting (`lexware.sleep`).

Both tools declare MCP annotations (`search` is read-only; `execute` is marked destructive only when writes are enabled) and return `structuredContent` alongside the JSON text block. Built on the MCP TypeScript SDK v2 (protocol revision 2026-07-28 and 2025-era clients). See [docs/guide.md](docs/guide.md#tool-results-and-metadata).

Example `execute` call:

```js
async () => {
  const response = await lexware.request({
    method: 'GET',
    path: '/v1/contacts',
    query: { name: 'Muster', page: 0, size: 10 }
  });

  return response.data;
}
```

The sandbox does **not** receive the Lexware API key, Node globals, filesystem access, imports, `fetch`, or arbitrary network access. `lexware.request` only accepts relative `/v1/...` paths and sends the API key from the host process.

`execute` results include `requests`, an audit log with one `{ method, path, status, ok, error, write, sent, cached, outcome, durationMs }` entry per HTTP attempt — also when the execution failed, so you can see which writes already went through. A write with `outcome: "unknown"` was sent but its result is unknown (aborted, timed out, network error, or answered with `504`) — Lexware may have applied it, so check with a `GET` before retrying. A `GET` answered with `429` is retried once automatically (after `Retry-After` if it is ≤ 5 s, or after a 1–2 s backoff if the header is missing; a longer `Retry-After` is not retried) if the 30 s execution budget allows. Cancelling the tool call (or the 30 s execution timeout) aborts in-flight Lexware requests.

Pass `dryRun: true` to `execute` to preview writes before they happen: reads run normally, while every `POST`/`PUT`/`PATCH`/`DELETE` returns a synthetic `{ dryRun: true, status: 0, planned }` response instead of being sent, and the result lists them in `plannedWrites`, including the SHA-256 of every file that would be uploaded. Dry runs also work on a read-only server; writes the policy would reject are flagged with `blocked`. See [docs/guide.md#dry-runs](docs/guide.md#dry-runs).

Work too large for one `execute` call (2 requests/s, 30 s, at most 50 requests) can be split into batches: `state.get`/`state.set` keep JSON values such as an id list, a cursor and partial totals in server memory between calls. See [docs/guide.md#state-between-execute-calls](docs/guide.md#state-between-execute-calls).

Reference data (posting categories, profile, countries, payment conditions, print layouts) is cached in server memory for an hour, so later `execute` calls get it without a request. Every write the server sends clears the cache. See [docs/guide.md#response-cache](docs/guide.md#response-cache).

The server also ships prompts for recurring workflows: `upload-receipts`, `revenue-report`, `profit-report` and `create-invoice`. They are generated from the catalog's workflows and follow the server's write mode. Clients that support the MCP Skills extension (`io.modelcontextprotocol/skills`) get the same workflows as skills at `skill://lexware-office/<name>/SKILL.md`. See [docs/guide.md#prompts](docs/guide.md#prompts) and [docs/guide.md#skills](docs/guide.md#skills).

### Binary-safe file uploads

Uploads are binary-safe via `multipart` parts with `contentPath` (host reads a local file from disk), `contentBase64` (binary FormData parts), or `bodyBase64` (raw binary body). The host reads/decodes and builds `Buffer` / `Blob` bodies outside the QuickJS sandbox.

Preferred: `contentPath` — pass the file's absolute path instead of inlining bytes. Requires `LEXWARE_OFFICE_ALLOW_WRITES=true` (uploads are writes) and `LEXWARE_OFFICE_UPLOAD_DIRS` (see [Upload directories](#upload-directories)); the file must be on the machine running the MCP server. `lexware.uploadVoucherFile` uploads a Beleg and waits for Lexware's text recognition in the same call:

```js
async () => {
  const { voucherId, extraction, voucher } = await lexware.uploadVoucherFile({ contentPath: '/absolute/path/to/receipt.pdf' });
  return { voucherId, extraction, voucherNumber: voucher?.voucherNumber };
}
```

The raw request it sends:

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
  // response.sent echoes { bytes, parts: [{ name, filename, bytes, sha256 }] } for integrity checks
  return { id: response.data?.id, sent: response.sent };
}
```

See [docs/guide.md](docs/guide.md#binary-safe-file-uploads) for details and all supported modes.

## Configuration

### Get a Lexware Office API key

Create an API key at <https://app.lexware.de/addons/public-api>.

### Prerequisites

- Node.js 22 or higher
- `LEXWARE_OFFICE_API_KEY` environment variable

### Claude Desktop / MCP config with NPX

#### Recommended: consume the packaged server

Run the packaged binary from the latest GitHub release (`#semver:^3` resolves to the newest tag of this major version and picks up future releases automatically). <!-- x-release-please-major --> The package builds itself during GitHub installs via `prepare`, so users do **not** need to clone the repository or commit `build/` artifacts.

<!-- x-release-please-start-major -->
```json
{
  "mcpServers": {
    "lexware-office": {
      "command": "npx",
      "args": ["-y", "--package=github:JannikWempe/mcp-lexware-office#semver:^3", "lexware-office"],
      "env": {
        "LEXWARE_OFFICE_API_KEY": "YOUR_API_KEY_HERE",
        "LEXWARE_OFFICE_READ_ONLY": "true"
      }
    }
  }
}
```
<!-- x-release-please-end -->

**Troubleshooting:** If the `npx` command above fails during git-dependency preparation with an error mentioning `--before`, your npm user config may contain `minimum-release-age`, which conflicts with npm's internal `--before` flag. Two fixes:

<!-- x-release-please-start-major -->
```bash
# Either bypass your user config for this invocation
NPM_CONFIG_USERCONFIG=/dev/null \
  npx -y --package=github:JannikWempe/mcp-lexware-office#semver:^3 lexware-office

# or remove the conflicting setting permanently
npm config delete minimum-release-age --location=user
```
<!-- x-release-please-end -->

When this package is published to npm, replace the GitHub package spec with the npm package name:

```json
"args": ["-y", "--package=mcp-lexware-office", "lexware-office"]
```

#### Local development from TypeScript source

For local development, you can run the TypeScript source directly with `tsx` after cloning the repo and installing dependencies:

```json
{
  "mcpServers": {
    "lexware-office-local": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/mcp-lexware-office/src/index.ts"],
      "env": {
        "LEXWARE_OFFICE_API_KEY": "YOUR_API_KEY_HERE",
        "LEXWARE_OFFICE_READ_ONLY": "true"
      }
    }
  }
}
```

Use this source-based setup only for development. End users should prefer the packaged binary above.

### Write safety

**The server is read-only by default.** `POST`, `PUT`, `PATCH`, and `DELETE` requests are blocked unless you explicitly opt in:

```json
{
  "LEXWARE_OFFICE_ALLOW_WRITES": "true"
}
```

`LEXWARE_OFFICE_READ_ONLY=true` is a hard block that wins over `ALLOW_WRITES=true` (any value other than empty or `false` counts):

```json
{
  "LEXWARE_OFFICE_READ_ONLY": "true"
}
```

To allow only specific writes, list them in `LEXWARE_OFFICE_WRITE_ALLOW` (comma-separated `METHOD /v1/path` entries or operationIds from the catalog). Every other write is rejected before it is sent:

```json
{
  "LEXWARE_OFFICE_ALLOW_WRITES": "true",
  "LEXWARE_OFFICE_WRITE_ALLOW": "POST /v1/files, POST /v1/vouchers/{id}/files, PUT /v1/vouchers/{id}"
}
```

Finalizing needs a `?finalize` suffix on the entry: `POST /v1/invoices?finalize` allows `finalize=true` on invoices, `PUT /v1/vouchers/{id}?finalize` allows setting a voucher's `voucherStatus` to `open`, and `POST /v1/vouchers?finalize` allows creating open vouchers (without it, only `voucherStatus: 'unchecked'` vouchers can be created).

See [docs/guide.md#permissions](docs/guide.md#permissions) for the detailed permission model.

### Upload directories

`multipart` `contentPath` uploads are disabled unless `LEXWARE_OFFICE_UPLOAD_DIRS` lists the directories the server may read files from (separated by `:` on macOS/Linux, `;` on Windows):

```json
{
  "LEXWARE_OFFICE_ALLOW_WRITES": "true",
  "LEXWARE_OFFICE_UPLOAD_DIRS": "/Users/me/Documents/Belege:/Users/me/Downloads"
}
```

Files must resolve (after following symlinks) to a path inside one of these directories, including subdirectories. Anything else is rejected. `contentBase64` uploads work without this setting.

### Multiple organizations

Run one server instance per Lexware organization, each with its own API key. The model sees the connected organization (company name, tax type, Kleinunternehmer status) in `spec.info.account`. Set `LEXWARE_OFFICE_ACCOUNT_LABEL` to add your own label to it:

```json
{
  "LEXWARE_OFFICE_API_KEY": "KEY_FOR_FIRMA_A",
  "LEXWARE_OFFICE_ACCOUNT_LABEL": "Firma A"
}
```

See [docs/guide.md#connected-account-specinfoaccount](docs/guide.md#connected-account-specinfoaccount) for details.

### Response cache

Reference data `GET`s are cached in server memory (see [docs/guide.md#response-cache](docs/guide.md#response-cache)). Changes made outside this server, e.g. a new posting category in the Lexware web app, show up after at most an hour. To turn the cache off:

```json
{
  "LEXWARE_OFFICE_CACHE": "off"
}
```

### API base URL

Requests go to `https://api.lexware.io`. To route them through a proxy, set `LEXWARE_OFFICE_API_BASE_URL`; a path prefix is kept, so this sends `GET /v1/contacts` to `https://proxy.example/lexware/v1/contacts`. An empty value uses the default; a value that isn't an `http(s)` URL stops the server at startup:

```json
{
  "LEXWARE_OFFICE_API_BASE_URL": "https://proxy.example/lexware"
}
```

## Docker

Build the image:

```bash
docker build -t mcp-lexware-office:latest .
```

Run it:

```bash
docker run -i --rm \
  -e LEXWARE_OFFICE_API_KEY \
  -e LEXWARE_OFFICE_READ_ONLY=true \
  mcp-lexware-office:latest
```

`contentPath` uploads read from the container's filesystem: mount a volume and set `LEXWARE_OFFICE_UPLOAD_DIRS` to the container path, then pass `contentPath: '/data/receipt.pdf'`:

```bash
docker run -i --rm \
  -e LEXWARE_OFFICE_API_KEY \
  -e LEXWARE_OFFICE_ALLOW_WRITES=true \
  -e LEXWARE_OFFICE_UPLOAD_DIRS=/data \
  -v /host/dir:/data:ro \
  mcp-lexware-office:latest
```

## Build and test

Requires Node.js 22+ and pnpm (the version pinned in `package.json#packageManager`; `corepack enable` installs it; on Node 25+, run `npm i -g corepack` first).

```bash
pnpm install
pnpm typecheck
pnpm test                       # builds, then runs build/*.test.js
pnpm -s run smoke [--writes]    # prints what a client sees: instructions, tools, prompts, skills
pnpm run check:docs             # compares the catalog with the live Lexware docs (network)
```

`pnpm test` fails when model-facing text (instructions, tool descriptions, prompts, skills) changes; if the change is intended, run `UPDATE_SNAPSHOTS=1 pnpm test` and commit `src/tools-list.snapshot.json`.

## Documentation

- [Guide and migration notes](docs/guide.md)
- [Lexware Office API key setup](https://app.lexware.de/addons/public-api)

## License

MIT. See [LICENSE](LICENSE).
