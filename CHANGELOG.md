# Changelog

## [3.0.1](https://github.com/JannikWempe/mcp-lexware-office/compare/v3.0.0...v3.0.1) (2026-10-15)


### Bug Fixes

* **spec:** sync catalog with current Lexware docs ([8c8f0d7](https://github.com/JannikWempe/mcp-lexware-office/commit/8c8f0d75929bf2efb99a5bbcc42cb6a9fee48988))
* **spec:** sync catalog with current Lexware docs (anchors, deprecations, dunning finalize) ([5b4c8bc](https://github.com/JannikWempe/mcp-lexware-office/commit/5b4c8bc0dc53b7f442e74d24cd8234a7bf1df7e8))

## [3.0.0](https://github.com/JannikWempe/mcp-lexware-office/compare/v2.0.0...v3.0.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* multipart contentPath is disabled unless LEXWARE_OFFICE_UPLOAD_DIRS (or uploadDirs) is set. contentBase64 unaffected.

### Features

* mark sent writes with unknown outcome in request log; sanitize response read errors ([ba62a10](https://github.com/JannikWempe/mcp-lexware-office/commit/ba62a10217489a0d6835a1846d5734917c8cb277))
* migrate to MCP TypeScript SDK v2 ([587568f](https://github.com/JannikWempe/mcp-lexware-office/commit/587568f9cb879b6a89556b0b5ed45d2971df397d))
* per-attempt request log via onSettled request option ([e64e058](https://github.com/JannikWempe/mcp-lexware-office/commit/e64e05875941ebd9a1b6f70c3648730207fbf85e))
* report per-request audit log and propagate cancellation in execute ([1b213ee](https://github.com/JannikWempe/mcp-lexware-office/commit/1b213ee134386394974dfd4df75dd388e61db32f))
* restrict multipart contentPath to LEXWARE_OFFICE_UPLOAD_DIRS ([9b7e013](https://github.com/JannikWempe/mcp-lexware-office/commit/9b7e01343bffa81bca85ea5d3749c5fcbee9a002))
* retry GET once on 429 with short Retry-After ([c4211b3](https://github.com/JannikWempe/mcp-lexware-office/commit/c4211b397a6aa9af167a623e8bccd98df780ff75))


### Bug Fixes

* abort in-flight Lexware requests on timeout or client cancel ([6c087a8](https://github.com/JannikWempe/mcp-lexware-office/commit/6c087a8f62184d39f3fde030d3b67e540aa0d2fc))
* **executor:** recheck cancellation after QuickJS init so aborted runs never start guest code ([357de81](https://github.com/JannikWempe/mcp-lexware-office/commit/357de81bda12e066d502ca9c15dda07f885ab8d5))
* **upload:** read contentPath via O_NOFOLLOW fd with post-open identity check; close dir-symlink existence oracle ([b8429db](https://github.com/JannikWempe/mcp-lexware-office/commit/b8429db397244b1eb167290eac6b5ad685f37a06))

## [2.0.0](https://github.com/JannikWempe/mcp-lexware-office/compare/v1.8.0...v2.0.0) (2026-07-19)


### ⚠ BREAKING CHANGES

* legacy v1 endpoint tools removed. The lexware-office binary now runs the Code Mode server (search/execute, read-only by default). Pin #semver:^1 to keep the legacy server.

### Features

* print deprecation warning when started via lexware-office-v2 alias ([4b873c2](https://github.com/JannikWempe/mcp-lexware-office/commit/4b873c25975e17e5ad04c718f2b66524e0eddf94))
* remove legacy v1 server, Code Mode is the only MCP ([84da911](https://github.com/JannikWempe/mcp-lexware-office/commit/84da9114bb82a82aaf961dd6f3caa4a556b33603))

## [1.8.0](https://github.com/JannikWempe/mcp-lexware-office/compare/v1.7.0...v1.8.0) (2026-07-09)


### Features

* contentPath uploads, discoverable multipart docs, upload hardening in v2 ([86d8260](https://github.com/JannikWempe/mcp-lexware-office/commit/86d826002529494f44c7afc2b3ccefe5c7981ce3))


### Bug Fixes

* correct v2 catalog against official Lexware docs ([50ea11e](https://github.com/JannikWempe/mcp-lexware-office/commit/50ea11e2d2afa9b724d863ceea7e8e294c45172e))

## [1.7.0](https://github.com/JannikWempe/mcp-lexware-office/compare/v1.6.0...v1.7.0) (2026-07-09)


### Features

* add duplicateVoucher workflow to v2 spec ([66004e0](https://github.com/JannikWempe/mcp-lexware-office/commit/66004e0d53a92b9e2ee7fb32145e205294462c34))


### Bug Fixes

* support deviated address, language and title on sales document schemas ([119dadb](https://github.com/JannikWempe/mcp-lexware-office/commit/119dadbfa9dff57676fe747223aade0a1773d642))
