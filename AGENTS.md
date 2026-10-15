# Lexware Office MCP Server

Lexware Office API docs: https://developers.lexware.io/docs/ (one page; each catalog operation in `src/lexware-spec.ts` links its section via `docsUrl`).

## Architecture (Code Mode)

- Single MCP server in `src/index.ts` exposing two tools: `search` and `execute`
- `src/config.ts` — `loadConfig()`, the only place reading env (API key, base URL, upload dirs, write policy)
- `src/code-mode.ts` — `CodeMode` runs one `search`/`execute` call: request budget, audit log, sandbox spec, result truncation
- `src/lexware-spec.ts` — curated OpenAPI-lite catalog the `search` sandbox queries
- `src/executor.ts` — generic QuickJS sandbox runner: model-supplied JS + capabilities, host functions, optional guest prelude; no Lexware knowledge
- `src/lexware-sandbox-sdk.ts` — guest `lexware` object (`createLexwareSdk`, serialized into the prelude, must stay self-contained), its host binding to `LexwareApiClient.request`, and the declarations shown in the `execute` description
- `src/lexware-client.ts` — host-side HTTP client behind `lexware.request` (API key stays here, never in the sandbox)
- `src/truncate.ts` — response truncation for MCP payloads

## Conventions

- Catalog entries in `lexware-spec.ts` must match official Lexware docs (docsUrl per operation); `pnpm run check:docs` (network) verifies anchors and flags changelog entries newer than `scripts/lexware-docs-baseline.json`
- Optional fields use `!== undefined` guards, not falsy checks
- Tests are `src/*.test.ts` (node:test); `pnpm test` builds then runs them; `pnpm run typecheck` for tsc only
- `docs/guide.md` is user-facing and checked in; `src/docs-contract.test.ts` asserts parts of it
