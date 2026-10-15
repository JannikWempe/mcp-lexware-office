# Coding Standards

## Boundaries

- Read the environment only in `loadConfig()` (`src/config.ts`); inject its values everywhere else.
- Keep `src/executor.ts` generic; Lexware specifics belong in `lexware-sandbox-sdk.ts` and `code-mode.ts`.
- Keep the API key host-side in `src/lexware-client.ts`; the sandbox reaches the API only through the `lexware.request` host function.
- Keep `createLexwareSdk` self-contained: it runs in QuickJS via `toString()`, so it references only its parameters (type-only imports are fine).

## Catalog

- Entries in `src/lexware-spec.ts` mirror the official Lexware docs (https://developers.lexware.io/docs/, one page); each operation links its section via `docsUrl`.
- Verify with `pnpm run check:docs` (needs network): it checks every anchor and flags changelog entries newer than `scripts/lexware-docs-baseline.json`.

## Optional fields

- Guard with `!== undefined`, so falsy values like `0`, `''` and `false` pass through.

## Model-facing output

- Tool descriptions, server instructions and the `lexware` declarations are model-facing. Inspect them with `pnpm -s run smoke [--writes]`, which prints the built server's `initialize` + `tools/list`.

## Docs

- `docs/` ships in the npm package (`package.json` `files`): user-facing content only. Agent-facing docs live at the repo root.
