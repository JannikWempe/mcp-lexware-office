# Changelog

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
