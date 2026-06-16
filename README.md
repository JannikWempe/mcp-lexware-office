# Lexware Office MCP Server

An MCP server for [Lexware Office](https://www.lexware.de/lexware-office/) (formerly Lexoffice). It lets MCP-capable assistants query and manage contacts, sales documents, vouchers, files, payments, webhooks, and reference data through the Lexware Office public API.

## Which server should I use?

This package currently ships **two MCP server entrypoints**:

| Entrypoint | Status | Tool shape | Best for |
|---|---|---|---|
| `lexware-office` | Stable legacy v1 | Many endpoint-shaped tools such as `get-contacts`, `create-invoice`, `upload-file` | Existing users and conservative production setups |
| `lexware-office-v2` | Preview / planned successor | Two Code Mode tools: `search` and `execute` | New evaluations, broad API coverage, complex workflows, and future migrations |

They are separate MCP server processes in the same npm package, not one server with internal routing. A client config chooses which entrypoint to start. You may run both side by side under different MCP server names while migrating, but long-term usage should prefer one to avoid duplicate capabilities confusing the model.

**Roadmap:** v2 is intended to replace v1. v1 remains supported in the current major release. Once v2 is declared stable, v1 will be formally deprecated, receive only critical fixes, and be removed in the next major release with a documented migration window.

For deeper details, see [docs/version-guide.md](docs/version-guide.md).

## Features

- **Broad Lexware Office API coverage** for read and write workflows exposed by this server
- **Sales documents**: invoices, quotations, order confirmations, credit notes, delivery notes, dunning notices, and down-payment invoices
- **Contact management**: create, read, and update customers and vendors
- **Bookkeeping**: vouchers, posting categories, payments, and file uploads
- **Reference data**: profile, countries, print layouts, payment conditions, recurring templates
- **Webhooks**: create, list, inspect, and delete event subscriptions
- **v2 Code Mode**: discover the API catalog with `search`, then execute constrained Lexware API workflows with `execute`

## v1 vs v2 at a glance

### v1: endpoint-shaped tools

The v1 server exposes one MCP tool per common Lexware workflow. This is easy to inspect and works well for simple tasks:

- `get-contacts`
- `get-invoice-details`
- `create-voucher`
- `finalize-invoice`
- `upload-file-to-voucher`
- `duplicate-voucher`

See the full v1 tool list in [docs/version-guide.md#v1-tool-surface](docs/version-guide.md#v1-tool-surface).

### v2: Code Mode

The v2 server exposes a smaller MCP surface:

- `search` — runs a sandboxed JavaScript async arrow function against a curated OpenAPI-lite Lexware catalog.
- `execute` — runs a sandboxed JavaScript async arrow function with one host capability, `lexware.request`, for relative `/v1/...` Lexware API calls.

The catalog (`spec.workflows`) includes curated recipes such as `duplicateVoucher` (field-only duplication; file re-attachment requires v1) and reporting helpers. Run `search` with `async () => Object.keys(spec.workflows)` to list all available workflows.

Example v2 `execute` call:

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

#### Binary-safe file uploads

v2 supports binary-safe uploads via `bodyBase64` (raw binary body) and `multipart` with `contentBase64` (binary FormData parts). The host decodes base64 and builds `Buffer` / `Blob` bodies outside the QuickJS sandbox:

```js
async () => {
  const pdfBytes = 'JVBERi0x...'; // base64-encoded PDF
  return await lexware.request({
    method: 'POST',
    path: '/v1/files',
    multipart: [
      { name: 'file', filename: 'receipt.pdf', contentType: 'application/pdf', contentBase64: pdfBytes },
      { name: 'type', value: 'voucher' },
    ],
  });
}
```

See [docs/version-guide.md](docs/version-guide.md#binary-safe-file-uploads-in-v2) for details and all supported modes.

## Configuration

### Get a Lexware Office API key

Create an API key at <https://app.lexoffice.de/addons/public-api>.

### Prerequisites

- Node.js 22 or higher
- `LEXWARE_OFFICE_API_KEY` environment variable

### Claude Desktop / MCP config with NPX

#### Recommended: consume the packaged server

For v2 preview from GitHub, run the packaged binary. The package builds itself during GitHub installs via `prepare`, so users do **not** need to clone the repository or commit `build/` artifacts.

```json
{
  "mcpServers": {
    "lexware-office-v2": {
      "command": "npx",
      "args": ["-y", "--package=github:JannikWempe/mcp-lexware-office#v2", "lexware-office-v2"],
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
  npx -y --package=github:JannikWempe/mcp-lexware-office#v2 lexware-office-v2

# Option 2: remove the conflicting setting permanently
npm config delete minimum-release-age --location=user
```

When this package is published to npm, replace the GitHub package spec with the npm package name:

```json
"args": ["-y", "--package=mcp-lexware-office", "lexware-office-v2"]
```

Stable legacy v1 config from GitHub:

```json
{
  "mcpServers": {
    "lexware-office": {
      "command": "npx",
      "args": ["-y", "--package=github:JannikWempe/mcp-lexware-office#main", "lexware-office"],
      "env": {
        "LEXWARE_OFFICE_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}
```

#### Local development from TypeScript source

For local development, you can run the TypeScript source directly with `tsx` after cloning the repo and installing dependencies:

```json
{
  "mcpServers": {
    "lexware-office-v2-local": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/mcp-lexware-office/src/v2/index.ts"],
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

v1 safety is usually managed by disabling specific write/finalize/upload tools in the MCP client.

**v2 is read-only by default.** `POST`, `PUT`, `PATCH`, and `DELETE` requests are blocked unless you explicitly opt in:

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

See [docs/version-guide.md#permission-models](docs/version-guide.md#permission-models) for the detailed permission model.

## Docker

Build the image:

```bash
docker build -t mcp-lexware-office:latest -f src/Dockerfile .
```

The current Docker image starts the v1 entrypoint by default. To run v2, override the entrypoint command in your MCP config or Docker invocation:

```bash
docker run -i --rm \
  -e LEXWARE_OFFICE_API_KEY \
  -e LEXWARE_OFFICE_READ_ONLY=true \
  --entrypoint node \
  mcp-lexware-office:latest \
  build/v2/index.js
```

## Build and test

```bash
npm run build
npm test
```

## Documentation

- [Version guide and migration notes](docs/version-guide.md)
- [Lexware Office API key setup](https://app.lexoffice.de/addons/public-api)

## License

MIT. See [LICENSE](LICENSE).
