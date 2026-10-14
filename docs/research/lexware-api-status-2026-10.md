# Lexware Office Public API — status check 2026-10

Researched 2026-10-14 against the official docs. Catalog baseline: `src/lexware-spec.ts` as of commit `84da911` (2026-07-19).

Docs snapshot used: `https://developers.lexware.io/docs/` (HTTP `last-modified: Mon, 31 Aug 2026 13:29:55 GMT`). `https://developers.lexoffice.io/docs/` 301-redirects there and returns byte-identical content, so there is no separate "old" doc anymore.

## TL;DR

- **Changes since July 2026: two small behaviour changes and no new endpoints.** 14.07.2026: updating `unchecked` vouchers is restricted to a transition to `open`. 11.08.2026: the voucherlist `createdDateTo`/`updatedDateTo` filters are now inclusive. ([changelog](https://developers.lexware.io/docs/#change-log))
- **No new endpoints for Public API keys in the last 12 months.** The most recent endpoint addition was the `GET …/{id}/file` subresource on 13.08.2025. That same entry also deprecated the `…/{id}/document` subresource, the `files`/`documentFileId` properties, and downloading sales vouchers via `GET /v1/files/{id}`. ([changelog](https://developers.lexware.io/docs/#change-log))
- **Base URL, rate limit and auth are unchanged.** Base URL is still `https://api.lexware.io` and the limit is still 2 req/s ([docs](https://developers.lexware.io/docs/#api-rate-limits)). The docs still say the old gateway would be kept "until December 2025" and give no newer statement. `api.lexoffice.io` still answers unauthenticated requests with the gateway's `401 {"message":"Unauthorized"}` (probed 2026-10-14). Whether it still serves authenticated traffic is **unverified**.
- **The catalog's endpoint set matches the docs exactly** (55 method+path pairs). However, **16 `docsUrl` anchors are broken** (the docs renamed headings to "Render … document (pdf)" / "Download … file" / "Retrieve all …"). The deprecated endpoints (`/document`, `GET /v1/vouchers` filter, sales-voucher download via `/v1/files/{id}`) are not flagged as deprecated in the catalog.
- **There is still no official OpenAPI/Swagger spec, JSON Schema or SDK.** The only official machine-readable artifact is a Postman v2.1 collection plus environment, and it is stale. All OpenAPI files found are community-made.

## Changelog since July 2026

Source: [developers.lexware.io/docs/#change-log](https://developers.lexware.io/docs/#change-log)

| Date | Entry | Impact on catalog |
|---|---|---|
| 11.08.2026 | "Fixed filters createdDateTo and updatedDateTo in voucherlist endpoint to be inclusive." | Optional: say "inclusive" in the descriptions of `createdDateTo`/`updatedDateTo` (`src/lexware-spec.ts:586,588`). The docs' parameter table describes all date bounds as "References a full day in CET/CEST 0:00-23:59:59" ([voucherlist](https://developers.lexware.io/docs/#voucherlist-endpoint-retrieve-and-filter-voucherlist)). |
| 14.07.2026 | "Updating unchecked vouchers is restricted to status transitions to open." | Not reflected. The docs now say: "it is not possible to change that state using the API, except for the finalization of a voucher from unchecked to open. Apart from that, a voucher with state unchecked may be not updated." ([vouchers update](https://developers.lexware.io/docs/#vouchers-endpoint-update-a-voucher)). The `updateVoucher` notes only mention 409 handling. |

Nothing after 11.08.2026 as of 2026-10-14.

**Partner API (separate product, OAuth-based, not usable with Public API keys).** The [Partner API docs](https://developers.lexware.io/partner/docs/#change-log) list the same two entries plus two partner-only ones: 01.06.2026 "Removed endpoint finance (GET) to retrieve financial transfer requests" and 08.01.2026 "Removed deprecated properties bankCode and accountNumber in contacts endpoint". Neither `bankCode` nor `accountNumber` appears anywhere in the Public API docs, so the removal has no impact here.

## Full recent changelog (≈12 months, Oct 2025 – Oct 2026)

Public API ([#change-log](https://developers.lexware.io/docs/#change-log)), verbatim:

- 11.08.2026 – Fixed filters createdDateTo and updatedDateTo in voucherlist endpoint to be inclusive.
- 14.07.2026 – Updating unchecked vouchers is restricted to status transitions to open.
- 21.05.2026 – Minor documentation updates: removed outdated information, fixed broken links, updated descriptions, and added best practices for handling event subscriptions. (New section: [#event-subscriptions-endpoint-purpose-best-practices](https://developers.lexware.io/docs/#event-subscriptions-endpoint-purpose-best-practices))
- 05.05.2026 – Support text formatting in specific fields in sales vouchers and articles. See [FAQ text formatting](https://developers.lexware.io/docs/#faq-text-formatting). Markdown-style `**bold**`, `__italic__` and `- list` lines are supported in sales voucher `introduction`, line item `description` and `remark`, and in article `description` (not `title`).
- 28.04.2026 – Changed categoryId for revenues as a small business owner (Einnahmen als Kleinunternehmer) from `7a1efa0e-6283-4cbf-9583-8e88d3ba5960` to `f5c7fee8-f184-4e7a-ab04-8f7e7ad6c207`. The catalog hardcodes no categoryIds, so no impact.

There are **no Public API entries between 21.08.2025 and 28.04.2026**. The entries immediately before that window are kept here for context:

- 21.08.2025 – Added read-only property `retroactiveInvoice` to recurring-templates.
- 13.08.2025 – Deprecated and marked for removal: `files` objects, `documentFileId` properties, the `document` subresource of sales voucher endpoints, and downloading sales voucher documents via the files download endpoint.
- 13.08.2025 – Added new subresource `file` (GET) for all sales voucher endpoints.
- 27.05.2025 – Rebranding. The new resource URL is `https://api.lexware.io`.

Partner-only entries in the same window ([partner #change-log](https://developers.lexware.io/partner/docs/#change-log)): 01.06.2026 finance GET removed; 08.01.2026 contacts `bankCode`/`accountNumber` removed; 12.12.2025 finance PUT removed; 27.08.2025 error-code doc corrections; 15.08.2025 rate limiting for the OAuth2 authorization server.

**Rate limits and auth:** "A client can make up to 2 requests per second" with a token bucket across all endpoints. The authorization server has separate, undocumented limits ([#api-rate-limits](https://developers.lexware.io/docs/#api-rate-limits), [#api-rate-limits-rate-limits-for-authorization-server](https://developers.lexware.io/docs/#api-rate-limits-rate-limits-for-authorization-server)). Public API keys are still Bearer tokens generated at `https://app.lexware.de/addons/public-api` ([intro](https://developers.lexware.io/docs/#lexware-api-documentation)). Key lifetime is 24 months, renewable ([cookbook public-api](https://developers.lexware.io/cookbooks/public-api/)). No auth changes appear in the Public API changelog in the last 12 months.

**Base URL:** the [intro](https://developers.lexware.io/docs/#lexware-api-documentation) still reads: "the API gateway has been changed on 26 May 2025 … https://api.lexware.io. We keep the access to the previously used API Gateway URL available until December 2025." It contains no statement confirming the shutdown.

## Catalog diff vs `src/lexware-spec.ts`

### Endpoints (method + path)

I extracted every `METHOD {resourceurl}/v1/...` signature from the docs (55 unique) and compared them with `paths` in the catalog. The two sets are identical: **no endpoint is missing and no catalog entry is extra.** "Pursue" actions are `POST` with `?precedingSalesVoucherId=` and are already modelled as parameters.

### Broken `docsUrl` anchors (16)

Each catalog anchor below no longer exists in the docs; the right-hand column is the anchor that does exist. The other 40 unique catalog anchors (56 total, including `info.docsUrl`) resolve.

| Catalog anchor (broken) | Current docs anchor |
|---|---|
| `invoices-endpoint-retrieve-an-invoice-document` | `invoices-endpoint-render-an-invoice-document-pdf` |
| `invoices-endpoint-retrieve-an-invoice-file` | `invoices-endpoint-download-an-invoice-file` |
| `quotations-endpoint-retrieve-a-quotation-document` | `quotations-endpoint-render-a-quotation-document-pdf` |
| `quotations-endpoint-retrieve-a-quotation-file` | `quotations-endpoint-download-a-quotation-file` |
| `order-confirmations-endpoint-retrieve-an-order-confirmation-document` | `order-confirmations-endpoint-render-an-order-confirmation-document-pdf` |
| `order-confirmations-endpoint-retrieve-an-order-confirmation-file` | `order-confirmations-endpoint-download-an-order-confirmation-file` |
| `credit-notes-endpoint-retrieve-a-credit-note-document` | `credit-notes-endpoint-render-a-credit-note-document-pdf` |
| `credit-notes-endpoint-retrieve-a-credit-note-file` | `credit-notes-endpoint-download-a-credit-note-file` |
| `delivery-notes-endpoint-retrieve-a-delivery-note-document` | `delivery-notes-endpoint-render-a-delivery-note-document-pdf` |
| `delivery-notes-endpoint-retrieve-a-delivery-note-file` | `delivery-notes-endpoint-download-a-delivery-note-file` |
| `dunnings-endpoint-retrieve-a-dunning-document` | `dunnings-endpoint-render-a-dunning-document-pdf` |
| `dunnings-endpoint-retrieve-a-dunning-file` | `dunnings-endpoint-download-a-dunning-file` |
| `down-payment-invoices-endpoint-retrieve-a-down-payment-invoice-file` | `down-payment-invoices-endpoint-download-a-down-payment-invoice-file` |
| `files-endpoint-retrieve-a-file` | `files-endpoint-download-a-file` |
| `recurring-templates-endpoint-retrieve-and-filter-recurring-templates` | `recurring-templates-endpoint-retrieve-all-recurring-templates` |
| `event-subscriptions-endpoint-retrieve-event-subscriptions` | `event-subscriptions-endpoint-retrieve-all-event-subscriptions` |

### Semantic drift (catalog behind the docs)

1. **The `/document` subresources are deprecated** (13.08.2025). Each of the six sales-voucher sections says "This endpoint is deprecated and should no longer be used. Instead, use the … file subresource" (e.g. [invoices render](https://developers.lexware.io/docs/#invoices-endpoint-render-an-invoice-document-pdf)). The catalog presents `GET /v1/{invoices,quotations,order-confirmations,credit-notes,delivery-notes,dunnings}/{id}/document` without a deprecation note.
2. **`GET /v1/files/{id}` is deprecated for sales vouchers**: "should only be used to download bookkeeping voucher documents" ([files download](https://developers.lexware.io/docs/#files-endpoint-download-a-file)). The catalog's `downloadFile` has no such note.
3. **`GET /v1/vouchers` (filter) is deprecated** since 25.10.2021: "This filter endpoint is deprecated and should not be used. Please filter vouchers by accessing the voucherlist endpoint instead." ([filtering vouchers](https://developers.lexware.io/docs/#vouchers-endpoint-filtering-vouchers)). The catalog's `filterVouchers` has no note. This predates the 2026-07 catalog, so it was already missed.
4. **Unchecked-voucher updates** (14.07.2026, see above). `updateVoucher` should note that `unchecked` vouchers can only be updated to transition to `open`.
5. **`createDunning` lists `finalize`.** The docs only show `POST /v1/dunnings?precedingSalesVoucherId={id}` and state "Dunnings are always created in draft mode and do not need to be finalized" ([dunnings create](https://developers.lexware.io/docs/#dunnings-endpoint-create-a-dunning)). The catalog adds `finalizeParam` (`createDunning` params). Minor, and predates July.
6. **Base URL note** (`src/lexware-spec.ts:449`) says the old gateway "was sunset in December 2025". The docs only promise availability *until* December 2025 and never confirm the sunset. The host still returns gateway 401s. Suggested wording: "was only guaranteed until December 2025".
7. **Text formatting** (05.05.2026): the catalog could mention markdown-style formatting for `introduction`/`remark`/line item `description` and article `description`. This is optional and nice-to-have.
8. `info.notes[0]` ("Lexware does not publish a complete official OpenAPI document") is **still accurate**.

## Machine-readable spec status

**Official artifacts:**

- **Postman collection and environment** (official, linked from [#samples](https://developers.lexware.io/docs/#samples)):
  - `https://developers.lexware.io/assets/public/Lexware-API-Samples.postman_collection.json`: Postman schema v2.1.0, 41 requests, `last-modified` 31 Aug 2026.
  - `https://developers.lexware.io/assets/public/Lexware-API.postman_environment.json`
  - The collection is a set of samples and is **stale and incomplete** compared with the reference docs: it has no `/file` subresources, no `DELETE /v1/articles/{id}`, and no vouchers or voucher files endpoints. It also contains a typo'd `PUT /v1/article/{id}` (singular). It does include a `POST /v1/delivery-notes/{id}/sendmail` request that the Public API reference does not document; `sendmail` is documented only in the [Partner API docs](https://developers.lexware.io/partner/docs/).
- **No official OpenAPI/Swagger/JSON Schema.**
  - The doc pages (public, partner, cookbooks) contain no "openapi", "swagger", "yaml" or "sdk" references.
  - Probes on 2026-10-14 for `/openapi.json`, `/openapi.yaml`, `/swagger.json`, `/swagger.yaml`, `/api-docs`, `/v2/api-docs`, `/v3/api-docs`, `/swagger-ui/`, `/swagger-ui.html`, `/docs/openapi.json`, `/assets/public/openapi.{json,yaml}`, `/v1/openapi.json` and `/.well-known/openapi.json` returned:
    - `developers.lexware.io`: 404 (S3), or a 301 to a trailing slash that then 404s.
    - `developers.lexoffice.io`: 301 to `developers.lexware.io`.
    - `api.lexware.io` and `api.lexoffice.io`: `401 Unauthorized` for every path (gateway auth-first), so these hosts can't be checked without a key. **Unverified** whether a spec exists behind auth, but none is documented.
- **No official SDK and no official GitHub org with API artifacts.**
  - `github.com/lexoffice` is an org with 0 public repos.
  - `github.com/Haufe-Lexware` (Haufe Group parent) has 44 repos, none of them a Lexware Office API spec or SDK (checked via `gh api orgs/Haufe-Lexware/repos`).
  - `github.com/lexware` is an unrelated personal account.

**Community-made (not official; listed as leads only):**

- [api-evangelist/lexoffice](https://github.com/api-evangelist/lexoffice): self-described "independent third-party profile". It has hand-authored OpenAPI 3.0.3 files per resource and is also listed on apis.io.
- [sven5/Lexoffice](https://github.com/sven5/Lexoffice) ("Lexoffice OpenAPI Swagger", last updated 2021) and [maikerlab/lexoffice_api_rs](https://github.com/maikerlab/lexoffice_api_rs) (Rust client generated from OpenAPI, 2024).
- A gist by dokupendium ("Lexoffice Public API OpenAPI Spec", old `api.lexoffice.io` host). Seen only in search results, not opened (**unverified**).
- Many community clients and MCP servers (e.g. Baebeca-Solutions/lexware-php-api, benethos-hub/lexware-office-mcp). None of them is official.

## Sources

- Public API reference: https://developers.lexware.io/docs/ (anchors cited inline; changelog at `#change-log`)
- Legacy URL: https://developers.lexoffice.io/docs/ (301 to the above)
- Partner API reference: https://developers.lexware.io/partner/docs/ (`#change-log`)
- Cookbooks: https://developers.lexware.io/cookbooks/, https://developers.lexware.io/cookbooks/public-api/
- Postman collection: https://developers.lexware.io/assets/public/Lexware-API-Samples.postman_collection.json
- GitHub: https://github.com/lexoffice, https://github.com/Haufe-Lexware
- Catalog: `src/lexware-spec.ts` (commit `84da911`, 2026-07-19)
