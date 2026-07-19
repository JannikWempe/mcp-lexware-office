# Lexware Office MCP Server

An MCP server for [Lexware Office](https://www.lexware.de/lexware-office/) (formerly Lexoffice). It lets MCP-capable assistants query and manage contacts, sales documents, vouchers, files, payments, webhooks, and reference data through the Lexware Office public API.

The server uses **Code Mode**: instead of one MCP tool per API endpoint, it exposes two tools — `search` to explore a curated Lexware API catalog and `execute` to run constrained, sandboxed API workflows. This keeps the tool surface small while covering the whole API, including pagination, aggregation, and multi-step reporting in a single call.

> Upgrading from 1.x? The legacy tool-per-endpoint server was removed in 2.0.0. See [docs/guide.md#migrating-from-1x](docs/guide.md#migrating-from-1x).

## Features

- **Broad Lexware Office API coverage** for read and write workflows
- **Sales documents**: invoices, quotations, order confirmations, credit notes, delivery notes, dunning notices, and down-payment invoices
- **Contact management**: create, read, and update customers and vendors
- **Bookkeeping**: vouchers, posting categories, payments, and file uploads
- **Reference data**: profile, countries, print layouts, payment conditions, recurring templates
- **Webhooks**: create, list, inspect, and delete event subscriptions
- **Read-only by default**: writes require explicit opt-in via environment variable

## How it works

The server exposes two MCP tools:

- `search` — runs a sandboxed JavaScript async arrow function against a curated OpenAPI-lite Lexware catalog.
- `execute` — runs a sandboxed JavaScript async arrow function with one host capability, `lexware.request`, for relative `/v1/...` Lexware API calls.

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

### Binary-safe file uploads

Uploads are binary-safe via `multipart` parts with `contentPath` (host reads a local file from disk), `contentBase64` (binary FormData parts), or `bodyBase64` (raw binary body). The host reads/decodes and builds `Buffer` / `Blob` bodies outside the QuickJS sandbox.

Preferred: `contentPath` — pass the file's absolute path instead of inlining bytes. Requires `LEXWARE_OFFICE_ALLOW_WRITES=true` (uploads are writes) and works only when the MCP server runs on the machine that has the file:

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

Create an API key at <https://app.lexoffice.de/addons/public-api>.

### Prerequisites

- Node.js 22 or higher
- `LEXWARE_OFFICE_API_KEY` environment variable

### Claude Desktop / MCP config with NPX

#### Recommended: consume the packaged server

Run the packaged binary from the latest GitHub release (`#semver:^2` resolves to the newest `v2.x` tag and picks up future releases automatically). The package builds itself during GitHub installs via `prepare`, so users do **not** need to clone the repository or commit `build/` artifacts.

```json
{
  "mcpServers": {
    "lexware-office": {
      "command": "npx",
      "args": ["-y", "--package=github:JannikWempe/mcp-lexware-office#semver:^2", "lexware-office"],
      "env": {
        "LEXWARE_OFFICE_API_KEY": "YOUR_API_KEY_HERE",
        "LEXWARE_OFFICE_READ_ONLY": "true"
      }
    }
  }
}
```

**Troubleshooting:** If the `npx` command above fails during git-dependency preparation with an error mentioning `--before`, your npm user config may contain `minimum-release-age`, which conflicts with npm's internal `--before` flag. Two fixes:

```bash
# Option 1: bypass your user config for this invocation
NPM_CONFIG_USERCONFIG=/dev/null \
  npx -y --package=github:JannikWempe/mcp-lexware-office#semver:^2 lexware-office

# Option 2: remove the conflicting setting permanently
npm config delete minimum-release-age --location=user
```

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

`LEXWARE_OFFICE_READ_ONLY=true` is a hard block that wins over `ALLOW_WRITES=true`:

```json
{
  "LEXWARE_OFFICE_READ_ONLY": "true"
}
```

See [docs/guide.md#permissions](docs/guide.md#permissions) for the detailed permission model.

## Docker

Build the image:

```bash
docker build -t mcp-lexware-office:latest -f src/Dockerfile .
```

Run it:

```bash
docker run -i --rm \
  -e LEXWARE_OFFICE_API_KEY \
  -e LEXWARE_OFFICE_READ_ONLY=true \
  mcp-lexware-office:latest
```

## Build and test

```bash
npm run build
npm test
```

## Documentation

- [Guide and migration notes](docs/guide.md)
- [Lexware Office API key setup](https://app.lexoffice.de/addons/public-api)

## License

MIT. See [LICENSE](LICENSE).
