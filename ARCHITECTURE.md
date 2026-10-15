# Architecture

Module map of the server. Boundary rules live in `CODING_STANDARDS.md` → Boundaries.

- `src/index.ts` — the MCP server: registers `search` and `execute`, wires config, client and `CodeMode`
- `src/config.ts` — `loadConfig()`: API key, base URL, upload dirs, write policy
- `src/code-mode.ts` — `CodeMode` runs one `search`/`execute` call: request budget, audit log, sandbox spec, result truncation
- `src/lexware-spec.ts` — curated OpenAPI-lite catalog the `search` sandbox queries
- `src/executor.ts` — generic QuickJS sandbox runner: model-supplied JS + capabilities, host functions, optional guest prelude
- `src/lexware-sandbox-sdk.ts` — guest `lexware` object (`createLexwareSdk`, serialized into the prelude), its host binding to `LexwareApiClient.request`, and the declarations shown in the `execute` description
- `src/lexware-client.ts` — host-side HTTP client behind `lexware.request`; holds the API key
