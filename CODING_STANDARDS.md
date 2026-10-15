# Coding Standards

- Catalog entries in `src/lexware-spec.ts` match the official Lexware docs, with a `docsUrl` per operation. Verify with `pnpm run check:docs` (needs network): it checks every anchor and flags changelog entries newer than `scripts/lexware-docs-baseline.json`.
- Guard optional fields with `!== undefined`, so falsy values like `0`, `''` and `false` pass through.
