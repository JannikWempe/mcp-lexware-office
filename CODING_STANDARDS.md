# Coding Standards

- **Environment**: read it only in `loadConfig()` (`src/config.ts`); inject the values everywhere else.
- **Optional fields**: guard with `!== undefined`, so falsy values like `0`, `''` and `false` pass through.
- **`docs/`** ships in the npm package: user-facing content only. Agent-facing docs live at the repo root.
