# Changelog

## [3.1.0](https://github.com/JannikWempe/mcp-lexware-office/compare/v3.0.2...v3.1.0) (2026-11-05)


### Features

* cache reference-data GETs across execute calls, cleared by every write sent ([#35](https://github.com/JannikWempe/mcp-lexware-office/issues/35)) ([97985b8](https://github.com/JannikWempe/mcp-lexware-office/commit/97985b850241ab27f7c39335606ec40aaf7d44f0))
* cache reference-data GETs across execute calls, cleared by every write sent ([#35](https://github.com/JannikWempe/mcp-lexware-office/issues/35)) ([3f6bf44](https://github.com/JannikWempe/mcp-lexware-office/commit/3f6bf4434fcf81644b52b3fa6c365cd9718092d2))
* dryRun mode for execute previews planned writes without sending them ([#46](https://github.com/JannikWempe/mcp-lexware-office/issues/46)) ([b7a5dac](https://github.com/JannikWempe/mcp-lexware-office/commit/b7a5dac7df20dd9f7d10d3d4fd2b9f838b19c460))
* dryRun mode for execute previews planned writes without sending them ([#46](https://github.com/JannikWempe/mcp-lexware-office/issues/46)) ([ee1f226](https://github.com/JannikWempe/mcp-lexware-office/commit/ee1f226e63906ddafeab443331c953a8578f87e9))
* expose the connected organization as spec.info.account ([988bd73](https://github.com/JannikWempe/mcp-lexware-office/commit/988bd73fe5933136c10307c462dd695e486e667b))
* expose the connected organization as spec.info.account ([#37](https://github.com/JannikWempe/mcp-lexware-office/issues/37)) ([a5b8224](https://github.com/JannikWempe/mcp-lexware-office/commit/a5b8224dd4d08b694842e8bce084e073eb2fd013))
* fine-grained write allowlist via LEXWARE_OFFICE_WRITE_ALLOW ([3fb3a2a](https://github.com/JannikWempe/mcp-lexware-office/commit/3fb3a2a6a73e60da3a0c9bc4e7f0721b5ba139c3))
* fine-grained write allowlist via LEXWARE_OFFICE_WRITE_ALLOW ([#45](https://github.com/JannikWempe/mcp-lexware-office/issues/45)) ([7d6163d](https://github.com/JannikWempe/mcp-lexware-office/commit/7d6163d7201427d20f0293861a83522d27f8f2c7))
* lexware.findVouchers with normalized voucher-number matching ([#40](https://github.com/JannikWempe/mcp-lexware-office/issues/40)) ([8c9399f](https://github.com/JannikWempe/mcp-lexware-office/commit/8c9399f61b94a24f494a9e55ccb1163ad9510243))
* lexware.updateVoucher safe-merge helper that never drops files ([#39](https://github.com/JannikWempe/mcp-lexware-office/issues/39)) ([b37df1e](https://github.com/JannikWempe/mcp-lexware-office/commit/b37df1e0aab70b0a91495bf3a5f386e3c384dce0))
* lexware.updateVoucher safe-merge helper that never drops files ([#39](https://github.com/JannikWempe/mcp-lexware-office/issues/39)) ([fad359e](https://github.com/JannikWempe/mcp-lexware-office/commit/fad359e91d25a09e57b960f873300addf9cf866d))
* lexware.uploadVoucherFile waits for text recognition, plus attachFileToVoucher and lexware.sleep ([#38](https://github.com/JannikWempe/mcp-lexware-office/issues/38)) ([5d03deb](https://github.com/JannikWempe/mcp-lexware-office/commit/5d03debcba831ad787c93f1fb09d34746464e2ea))
* normalize Lexware error bodies into issues[] with actionable hints ([#42](https://github.com/JannikWempe/mcp-lexware-office/issues/42)) ([48495f5](https://github.com/JannikWempe/mcp-lexware-office/commit/48495f5b5bc4133a08dbe810ea72e21318bff8e8))
* normalize Lexware error bodies into issues[] with actionable hints ([#42](https://github.com/JannikWempe/mcp-lexware-office/issues/42)) ([f4f798d](https://github.com/JannikWempe/mcp-lexware-office/commit/f4f798d84fdb3a46915970f6bb127c3a259d5cf7))
* ranked find() and compact describe() catalog lookup for search and execute ([#41](https://github.com/JannikWempe/mcp-lexware-office/issues/41)) ([f266112](https://github.com/JannikWempe/mcp-lexware-office/commit/f266112a690100ef0fcb31fb31e6ecbe31f7ae01))
* ranked find() and compact describe() catalog lookup in search and execute ([#41](https://github.com/JannikWempe/mcp-lexware-office/issues/41)) ([8aacf57](https://github.com/JannikWempe/mcp-lexware-office/commit/8aacf5760bc251265a646769eff475fe29e5693c))
* SDK helpers uploadVoucherFile, attachFileToVoucher, sleep and findVouchers ([#38](https://github.com/JannikWempe/mcp-lexware-office/issues/38), [#40](https://github.com/JannikWempe/mcp-lexware-office/issues/40)) ([b346250](https://github.com/JannikWempe/mcp-lexware-office/commit/b346250ca2510fd5f4927ae3ed0cfdd827796b16))
* serve the workflow prompts as MCP Skills ([#44](https://github.com/JannikWempe/mcp-lexware-office/issues/44)) ([39c5d7d](https://github.com/JannikWempe/mcp-lexware-office/commit/39c5d7de396a2d485cae8025b8a22d3fc96de48a))
* serve the workflow prompts as MCP Skills (io.modelcontextprotocol/skills) at skill://lexware-office/&lt;name&gt;/SKILL.md; bump @modelcontextprotocol/server to 2.4.0 ([#44](https://github.com/JannikWempe/mcp-lexware-office/issues/44)) ([59c10f5](https://github.com/JannikWempe/mcp-lexware-office/commit/59c10f59a13e0200fb8b357dc931d1103aa6babf))
* ship upload-receipts, revenue-report, profit-report and create-invoice as MCP prompts rendered from spec.workflows ([#44](https://github.com/JannikWempe/mcp-lexware-office/issues/44)) ([73fb662](https://github.com/JannikWempe/mcp-lexware-office/commit/73fb662abc52ed3520ab8cb91afd6c91f21477bd))
* ship upload-receipts, revenue-report, profit-report and create-invoice as MCP prompts rendered from spec.workflows ([#44](https://github.com/JannikWempe/mcp-lexware-office/issues/44)) ([54b506b](https://github.com/JannikWempe/mcp-lexware-office/commit/54b506b668a242a7d2743a14695625c525eb8260))
* shrink oversized results structurally and slim execute results ([#33](https://github.com/JannikWempe/mcp-lexware-office/issues/33), [#34](https://github.com/JannikWempe/mcp-lexware-office/issues/34)) ([733648b](https://github.com/JannikWempe/mcp-lexware-office/commit/733648ba8b160ac52a57df42a1d6573810f24142))
* state.get/set keeps JSON values across execute calls for batched workflows ([#36](https://github.com/JannikWempe/mcp-lexware-office/issues/36)) ([25ac202](https://github.com/JannikWempe/mcp-lexware-office/commit/25ac2021764bbc3d7516156d762865c81aa4d2f4))
* state.get/set keeps JSON values across execute calls for batched workflows ([#36](https://github.com/JannikWempe/mcp-lexware-office/issues/36)) ([af547d1](https://github.com/JannikWempe/mcp-lexware-office/commit/af547d19396427c59c14c68190a4a7deb69146c7))
* structurally truncate oversized results and slim execute results ([765f46f](https://github.com/JannikWempe/mcp-lexware-office/commit/765f46fa1d2ddb68fb1d408d24bf807498548218))


### Bug Fixes

* address review — blank enum arguments count as omitted too, the stream-cancel test sits with the client error tests, README says how an empty or invalid base URL behaves ([d178148](https://github.com/JannikWempe/mcp-lexware-office/commit/d178148218135666e08d8be1c3abcac49b34d64e))
* address review — clear the cache when a write is sent, drop the old entry on an oversized refresh, no per-request headers on hits, describe the cache only when on ([8040f78](https://github.com/JannikWempe/mcp-lexware-office/commit/8040f783a325e4c3e222e9f1bac0ec8293300b94))
* address review — no optimistic-locking 409 on creates, unitPrice optional on delivery notes, only docs-sourced claims, sturdier docs baseline ([89bc4e6](https://github.com/JannikWempe/mcp-lexware-office/commit/89bc4e6d5bec3fffd9fab3649c43bad42570f630))
* address review — out of memory after an await no longer throws from execute, execute gets 256 MB so 25 MB base64 uploads fit, a semicolon followed by a comment parses, host results into a full heap report out of memory, invalid memory limits are rejected ([5e4e835](https://github.com/JannikWempe/mcp-lexware-office/commit/5e4e83560ff5143ff2ee39e6db4d2c530c258c7e))
* address review — READ_ONLY in the read-only notice, dry-run uploads stop after planning, typed prompt args without a cast, non-vacuous contract checks, request timeouts in the stdio tests ([e0827e9](https://github.com/JannikWempe/mcp-lexware-office/commit/e0827e984767dbc13a7e229252c78397404b9950))
* address review — skill descriptions say when to use them and name Lexware Office, write and basis lines read right without prompt arguments, SKILL_PREFIX private, duplicated write-mode test dropped, resources/directory/read documented ([f114a54](https://github.com/JannikWempe/mcp-lexware-office/commit/f114a545d3560803c3e34abcb250122cbd3405d2))
* address review — umlaut tests pin the order-confirmation ranking and exercise the löschen synonym, executor comment says what a statement after the function does ([18a4b7e](https://github.com/JannikWempe/mcp-lexware-office/commit/18a4b7e7988758e50fda544be417b8d0bacfc5fc))
* admit planned writes before serializing, reject plans of cancelled writes, flag rawBody; address review ([bbdf467](https://github.com/JannikWempe/mcp-lexware-office/commit/bbdf46791226bd7f7a7f3e01fbe45a2c47275498))
* an explicit method in a path query ranks that operation first; tidy synonyms and limit clamp ([5ceb641](https://github.com/JannikWempe/mcp-lexware-office/commit/5ceb641b1a324f8c8aaeee8647ff02fd61279ab6))
* block host calls after an engine failure; address review findings ([bcf956c](https://github.com/JannikWempe/mcp-lexware-office/commit/bcf956cdf149d1f7957590886bb3faea4ad01e29))
* bound truncation for audit-heavy, non-serializable and deeply nested results ([5591e50](https://github.com/JannikWempe/mcp-lexware-office/commit/5591e50e8972b0f4756bb3d2c13ad7155c754231))
* cap the sandbox WASM heap at the memory limit, share one deadline for interrupt and timer, accept a trailing comment or semicolon, make READ_ONLY fail closed ([#64](https://github.com/JannikWempe/mcp-lexware-office/issues/64), [#65](https://github.com/JannikWempe/mcp-lexware-office/issues/65), [#66](https://github.com/JannikWempe/mcp-lexware-office/issues/66), [#68](https://github.com/JannikWempe/mcp-lexware-office/issues/68)) ([6068dca](https://github.com/JannikWempe/mcp-lexware-office/commit/6068dcaa27863f1a11db6c646da553c5237730ce))
* cap upload waits at 15 s, treat a missing last flag as more pages, reword the exact-miss error ([9866f84](https://github.com/JannikWempe/mcp-lexware-office/commit/9866f840cb25ed66f50739bf5169b39f83e0a9af))
* cap upload waits within the sleep limit and execute timeout, refuse partial findVouchers scans; address review ([9b457b4](https://github.com/JannikWempe/mcp-lexware-office/commit/9b457b41e743b0dd82e9c757b085857d7c1995fb))
* catalog sales-document rules, contact/webhook/payment details and docs section hashes ([#31](https://github.com/JannikWempe/mcp-lexware-office/issues/31), [#32](https://github.com/JannikWempe/mcp-lexware-office/issues/32)) ([d401aa9](https://github.com/JannikWempe/mcp-lexware-office/commit/d401aa9f21b869b8b05fe6437bb183c1c9354186))
* contain host stack overflows in the sandbox instead of aborting the process ([#51](https://github.com/JannikWempe/mcp-lexware-office/issues/51)) ([b3c98e9](https://github.com/JannikWempe/mcp-lexware-office/commit/b3c98e99ac2293ebf6977a9f821962b93cc12d42))
* contain host stack overflows in the sandbox instead of aborting the process ([#51](https://github.com/JannikWempe/mcp-lexware-office/issues/51)) ([599cd73](https://github.com/JannikWempe/mcp-lexware-office/commit/599cd73e8dc5decdc4bc45ba450f125d91727777))
* dry runs discard state changes, the host validates stored JSON, and the batch example saves progress per item; address review ([589dcfa](https://github.com/JannikWempe/mcp-lexware-office/commit/589dcfaa3cb9a5f47537f6db0c2b856ea2873c3d))
* enforce the sandbox memory limit, one deadline for the execute timeout, trailing ;/comments, READ_ONLY fails closed ([60d558d](https://github.com/JannikWempe/mcp-lexware-office/commit/60d558d731d89de44c1793f79402d78ec15a6e4c))
* execute reports error lines relative to the submitted code, find folds umlauts, docs match the 429 retry and workflows ([#67](https://github.com/JannikWempe/mcp-lexware-office/issues/67), [#69](https://github.com/JannikWempe/mcp-lexware-office/issues/69), [#71](https://github.com/JannikWempe/mcp-lexware-office/issues/71)) ([b8951eb](https://github.com/JannikWempe/mcp-lexware-office/commit/b8951eb95ac3f12647e64461949a4324da201c13))
* find folds umlauts and knows buchungskategorien, execute reports error lines relative to the submitted code, README 429 retry wording and search description match the code ([#67](https://github.com/JannikWempe/mcp-lexware-office/issues/67), [#69](https://github.com/JannikWempe/mcp-lexware-office/issues/69), [#71](https://github.com/JannikWempe/mcp-lexware-office/issues/71)) ([77ce631](https://github.com/JannikWempe/mcp-lexware-office/commit/77ce631550126bbd3b4f0d249b0c2fd2c4c280d5))
* harden write allowlist against finalize key variants and encoded separators; share write-method set ([0015210](https://github.com/JannikWempe/mcp-lexware-office/commit/001521076f350a17a5b8bc5690ed19f4fd61083b))
* honour Retry-After for a rate-limited profile lookup ([e2e77e8](https://github.com/JannikWempe/mcp-lexware-office/commit/e2e77e8b459e0f44f2cece1cff28a2cc41d4bd13))
* keep search fast on a slow profile lookup and retry transient profile failures; address review ([c8e6d7c](https://github.com/JannikWempe/mcp-lexware-office/commit/c8e6d7c9878959ed06a638922c8ba266a7ae4530))
* keep the audit log whole when truncating, bound truncation cost, address review findings ([2818238](https://github.com/JannikWempe/mcp-lexware-office/commit/281823806d6fa81cc2d2e6351dae85c6cafe5979))
* measure fit iteratively and keep kept-only results before shrinking everything ([917bcae](https://github.com/JannikWempe/mcp-lexware-office/commit/917bcae09960504df9d47e3657650764455eaf56))
* measure undefined, symbols and holes like JSON.stringify; drop the compact-size probe ([e5f10c9](https://github.com/JannikWempe/mcp-lexware-office/commit/e5f10c90bb64551a58dc68794a24107092b36428))
* own-property catalog lookups, validated find options, German verb synonyms, shared declaration in execute; address review ([fe560dd](https://github.com/JannikWempe/mcp-lexware-office/commit/fe560ddfa63584bd3704cd31687708808515883e))
* per-type sales document required fields, pursue rules and enums; contact update restriction, event types, 201 creates and docs section hashes ([#31](https://github.com/JannikWempe/mcp-lexware-office/issues/31), [#32](https://github.com/JannikWempe/mcp-lexware-office/issues/32)) ([4a50762](https://github.com/JannikWempe/mcp-lexware-office/commit/4a5076243d458ebb74e42e4e53b80ebd5e24cc54))
* prompts treat empty arguments as omitted and keep a single given date, write allowlist rejects ';', empty API base URL falls back to the default and a path prefix is kept, binary body cancel can't reject unhandled ([#70](https://github.com/JannikWempe/mcp-lexware-office/issues/70), [#72](https://github.com/JannikWempe/mcp-lexware-office/issues/72)) ([39c5e4d](https://github.com/JannikWempe/mcp-lexware-office/commit/39c5e4da00ae9f4d61f7102fa50432b060de8de4))
* prompts treat empty arguments as omitted and keep a single given date; write allowlist rejects ';', empty API base URL falls back to the default ([#70](https://github.com/JannikWempe/mcp-lexware-office/issues/70), [#72](https://github.com/JannikWempe/mcp-lexware-office/issues/72)) ([ca83ff4](https://github.com/JannikWempe/mcp-lexware-office/commit/ca83ff4db1acb496fb0afb0717d53b1be65403b7))
* reject malformed patch.files, handle switching off the collective contact, flag a verified-read failure after PUT; address review ([ebe71bc](https://github.com/JannikWempe/mcp-lexware-office/commit/ebe71bccbb7e01848567999085776c17ff73aa1b))
* report explicitly added files in a dry-run updateVoucher; address review ([de51421](https://github.com/JannikWempe/mcp-lexware-office/commit/de51421dc36c1edd0d8da4412baaa30aad33c800))
* scope the 409 locking hint to PUT and treat non-validation legacy sources as messages ([6ddd073](https://github.com/JannikWempe/mcp-lexware-office/commit/6ddd0732ceaf57a063c16f671d34470f939c05af))
* serve and store nothing from the cache while a write is in flight ([9a00238](https://github.com/JannikWempe/mcp-lexware-office/commit/9a002389071ae7411c073e33390acc9b5a86ef17))
* show body encoding in plans, keep concurrent plans in request order, cap planned writes; address review ([cee5a56](https://github.com/JannikWempe/mcp-lexware-office/commit/cee5a565d205b7ee83bf3b91b095c0bc2a3749ec))
* stop spinning guests on cancellation and keep promise throws as guest errors ([bde2177](https://github.com/JannikWempe/mcp-lexware-office/commit/bde2177549f80dd0962e61c37a6f99db1de394c8))
* updateVoucher, uploadVoucherFile and attachFileToVoucher return the plan in a dry run instead of failing or polling ([5ee35e0](https://github.com/JannikWempe/mcp-lexware-office/commit/5ee35e03a1a1c4caf102ed73e1bc185c69320329))
* xRechnung shape as an object, scope deliveryTerms and the photovoltaicEquipment caveat, quieter docs check ([33aa0a9](https://github.com/JannikWempe/mcp-lexware-office/commit/33aa0a9450aeebfd4924c04a07ee6995328f97b6))

## [3.0.2](https://github.com/JannikWempe/mcp-lexware-office/compare/v3.0.1...v3.0.2) (2026-11-04)


### Bug Fixes

* address review findings on merged bug fixes ([80d97bc](https://github.com/JannikWempe/mcp-lexware-office/commit/80d97bc8dc8e4a3e2134659384c0eb14edf691f1))
* catalog, Accept, rate-limit and error-classification bugs ([#27](https://github.com/JannikWempe/mcp-lexware-office/issues/27)–[#30](https://github.com/JannikWempe/mcp-lexware-office/issues/30)) ([fbb3fe8](https://github.com/JannikWempe/mcp-lexware-office/commit/fbb3fe8aa1a5b2ac25befe8d227501206bedc6b5))
* **client:** add rate-limit buffer, back off on 429 without Retry-After ([d928778](https://github.com/JannikWempe/mcp-lexware-office/commit/d9287781ff83b878fce311ffef43eade0654c2d9))
* **client:** classify 406 as validation and 402 as permission ([7fbe0df](https://github.com/JannikWempe/mcp-lexware-office/commit/7fbe0dfd2cfdb5fa2b9f059f4f31490cd89aefa3))
* **client:** default Accept to */* for file downloads ([aa03c94](https://github.com/JannikWempe/mcp-lexware-office/commit/aa03c9471db99a8eb64fd6cffd8168b7bdf33a65))
* **client:** mark writes answered with 504 as outcome unknown ([072a595](https://github.com/JannikWempe/mcp-lexware-office/commit/072a59546ac578534d01f61eb129314cf5567848))
* **spec:** align voucher and file upload entries with Lexware docs ([1f1d10e](https://github.com/JannikWempe/mcp-lexware-office/commit/1f1d10e496257727367963d0677b80ff655c7cc2))

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
