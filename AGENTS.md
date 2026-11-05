# Lexware Office MCP Server

## Commands

- `pnpm install`, then `pnpm typecheck` and `pnpm test` (builds to `build/`, runs `build/*.test.js` with `node:test`).
- One test file: `pnpm run build && node --test build/<name>.test.js`.
- Model-facing text (instructions, tool descriptions, prompts, skills) is pinned in `src/tools-list.snapshot.json`; after an intended change run `UPDATE_SNAPSHOTS=1 pnpm test` and commit it. Preview with `pnpm -s run smoke [--writes]`.
- `pnpm run check:docs` checks the catalog against the live Lexware docs (network; not part of `pnpm test`).

## Coding Standards

- **Environment**: read it only in `loadConfig()` (`src/config.ts`); inject the values everywhere else.
- **Optional fields**: guard with `!== undefined`, so falsy values like `0`, `''` and `false` pass through.
- **`docs/`** ships in the npm package: user-facing content only. Agent-facing docs live at the repo root.
