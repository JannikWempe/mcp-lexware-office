# Lexware Office MCP Server

Lexware Office API docs: https://developers.lexware.io/docs/ (one page; each catalog operation in `src/lexware-spec.ts` links its section via `docsUrl`).

Before writing or reviewing code, read `CODING_STANDARDS.md`.

## Architecture (Code Mode)

- Single MCP server in `src/index.ts` exposing two tools: `search` and `execute`
- `src/config.ts` — `loadConfig()`, the only place reading env (API key, base URL, upload dirs, write policy)
- `src/code-mode.ts` — `CodeMode` runs one `search`/`execute` call: request budget, audit log, sandbox spec, result truncation
- `src/lexware-spec.ts` — curated OpenAPI-lite catalog the `search` sandbox queries
- `src/executor.ts` — generic QuickJS sandbox runner: model-supplied JS + capabilities, host functions, optional guest prelude; no Lexware knowledge
- `src/lexware-sandbox-sdk.ts` — guest `lexware` object (`createLexwareSdk`, serialized into the prelude, must stay self-contained), its host binding to `LexwareApiClient.request`, and the declarations shown in the `execute` description
- `src/lexware-client.ts` — host-side HTTP client behind `lexware.request` (API key stays here, never in the sandbox)

## Workflow

- `pnpm test` builds first, then runs the compiled `build/*.test.js`
- `docs/guide.md` is user-facing and checked in; `src/docs-contract.test.ts` asserts parts of it
- `pnpm -s run smoke [--writes]` prints the built server's `initialize` + `tools/list`; `src/tools-list.snapshot.json` pins what models see (`UPDATE_SNAPSHOTS=1 pnpm test` after intended changes)
