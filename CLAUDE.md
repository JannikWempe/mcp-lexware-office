# Lexware Office MCP Server — Claude Instructions

## API Documentation

Lexware Office REST API: https://developers.lexoffice.io/docs/

Fetch specific sections on demand with WebFetch. Key sections:
- Contacts: `/docs/#contacts-endpoint`
- Invoices: `/docs/#invoices-endpoint`
- Vouchers (voucherlist): `/docs/#voucherlist-endpoint`
- Down-Payment Invoices: `/docs/#down-payment-invoices-endpoint`
- Dunnings: `/docs/#dunnings-endpoint`

## Architecture (Code Mode)

- Single MCP server in `src/index.ts` exposing two tools: `search` and `execute`
- `src/lexware-spec.ts` — curated OpenAPI-lite catalog the `search` sandbox queries
- `src/executor.ts` — QuickJS sandbox that runs model-supplied JS
- `src/lexware-client.ts` — host-side HTTP client behind `lexware.request` (API key stays here, never in the sandbox)
- `src/truncate.ts` — response truncation for MCP payloads
- Writes (POST/PUT/PATCH/DELETE) blocked by default; `LEXWARE_OFFICE_ALLOW_WRITES=true` enables them, `LEXWARE_OFFICE_READ_ONLY=true` hard-blocks

## Conventions

- Catalog entries in `lexware-spec.ts` must match official Lexware docs (docsUrl per operation)
- Optional fields use `!== undefined` guards, not falsy checks
- Tests are `src/*.test.ts` (node:test); `pnpm test` builds then runs them; `pnpm run typecheck` for tsc only
- `docs/guide.md` is user-facing and checked in; `src/docs-contract.test.ts` asserts parts of it
