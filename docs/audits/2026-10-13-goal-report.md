# Application stability and catalog goal — 13 October 2026

Local fixes and final browser acceptance are complete. The required npm gate remains failed; physical-device verification is unavailable locally. The user subsequently explicitly requested pushing all work to GitHub, Vercel and Railway; deployment outcomes will be recorded in a separate release ledger. The starting checkout was clean at `f8b0af5eae357cc1004a05a65c9dc9f07a2f8eab`. Work used the canonical root Expo 55 / React Native Web application with FastAPI, MongoDB and Supabase, following README, AGENTS.md and STABILITY_VERIFICATION. The legacy `frontend/` checkout was excluded.

## Confirmed causes and implemented behavior

- **Long-session response retention:** cached catalog URLs retained expired payloads unless the exact URL was revisited or a mutation/account/floor change cleared the cache. Both native/browser clients now release expired entries on insertion and keep 64 recent responses. Recent hits preserve their original expiration. Evicted pages can still be fetched; existing write/account/floor isolation remains. Actual-client regressions cover expiration, eviction, shared reads, cancellation, timeout and recovery.
- **Incorrect catalog choices/counts:** hierarchy and facets deduplicated supplier occurrences too early, hiding later sections of a Grohe SKU. Visible General/Uncategorised labels also failed to match blank source metadata. Warm and Mongo paths now preserve/filter occurrences before distinct counting, resolve display fallbacks consistently, and count overlapping category branches by unique SKU. Explicit blank filters and null/empty/literal fallback parity have regressions. Data is preserved; no migration or product duplication is needed.
- **Quotation multi-select:** removed the line checkboxes, selection state, batch area panel and batch context action. Products still add individually, and multiple lines, quantity/discount/area editing, room operations, autosave/reopen, ordering and PDF/PPTX exports remain. Saved schemas are unchanged. Included parts inherit parent area edits and show that inherited field as read-only. The current quotation model uses final prices (`models.py` grand-total alias); it does not add a separate tax layer. This policy and the existing monetary fields are preserved, rather than inventing tax rates or a new calculation.
- **Repeated quotation pricing:** each mounted row recomputed the entire quote. Rows now reuse the existing memoized line breakdown, preserving project/category/item discounts, flat-room allocation and footer totals.
- **Discount input race:** passive initialization could occur during an immediate edit, turning entered 20 into 1020 and clamping it to 100%. Initialization now precedes interactive rendering. Failed first-run evidence and the subsequent full focused run are preserved.
- **Revoked-session cache refill:** overlapping reads or writes could repopulate cache after invalidation. Cache generations prevent old fills; all six revocation paths invalidate after attempted writes, including interrupted acknowledgements. Tests reproduce both normal and ambiguous-write interleavings. Previously authorized in-flight operations and the existing cross-worker cache grace of at most ten seconds are not claimed to be eliminated.

No browser crash or rendering loop has been reproduced in the tested journeys so far. The retained-memory and repeated-pricing causes are confirmed by controlled regressions; attributing every reported random freeze to them would exceed the evidence. Deployed behavior, physical devices and access to production application logs remain outside the local fixture evidence.

## Catalog verification

The authoritative floor is `first-floor`, named **The Sanitary Bathroom**. Stored brand spelling is **Hansgrohe**. All 146 scopes (five brands, 41 populated categories, 100 subcategory branches) match expected eligible SKU/family counts. All 104 categories are accounted for, including 63 configured empty categories. There are no category parent links and no broken/cross-floor product/reference relationships in the captured snapshot.

| Brand | Eligible expected | Actual eligible | Family cards |
| --- | ---: | ---: | ---: |
| Geberit | 500 | 500 | 244 |
| Grohe | 581 | 581 | 324 |
| Hansgrohe | 1,514 | 1,514 | 853 |
| Oyster | 220 | 220 | 68 |
| Vitra | 275 | 275 | 108 |

Thirty bounded pagination requests (up to 60 family cards each) expose every eligible product: **3,090 SKUs**, no missing/unrelated IDs or duplicate card identities. All **3,139** unique source placements match the read-only Mongo projection. Grohe/Hansgrohe source workbook SKU sets match exactly; external completeness for Geberit/Oyster/Vitra is unverified. The 702 excluded legacy supplier records remain stored. All currently eligible products have zero stock; stock does not exclude catalog browsing.

Remaining source facts: 78 missing selected hero pointers, 160 canonical unspecified prices / 166 unspecified supplier occurrences. No images/prices/products were invented. Existing hero pointers were audited for selection/ownership, not fresh remote-object HTTP availability. Full supplier inventory and unprovided manufacturer variants cannot be inferred from the database.

See [the complete readable matrix and source limitations](2026-10-13-catalog.md) and [machine-readable IDs/counts](2026-10-13-catalog-matrix.json). The read-only audit is reproducible with `backend/scripts/audit_catalog_relationships.py`.

## Performance measurements and targets

| Same-environment controlled measurement | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Serialized payload retention, 1,000 distinct pages of 60 synthetic products | 65.174 MB | 4.171 MB | 93.6% less retained payload; target >90% met |
| Expired retained entries after another cache insertion | 1,001 | 1 | Expiry cleanup works without revisiting old URLs |
| 500-line pricing median, nine warmed samples | 28.726 ms | 0.132 ms | Target <1 ms met; identical totals, 217.5× computation improvement |
| Source placement projection/deduplication, same captured source / ten samples | 6.988 ms | 9.159 ms | Additional complete placements; correctness repair, no speedup claim |

Retention is serialized-payload accounting, not actual heap/GC measurements. The entry cap does not bound an arbitrarily large individual API response. Pricing is a computation benchmark, not end-to-end browser rendering or a physical-device promise. The source placement benchmark uses all 3,792 active captured first-floor records; it excludes full hierarchy grouping, snapshot hydration, HTTP and database work.

Same-host initial → final release-export catalog startup with 200 ms intercepted API latency: Android Chrome 1,621.5 → 1,554.2 ms; iPhone WebKit 2,115.2 → 1,772.6 ms; iPad WebKit 1,664.0 → 1,605.5 ms; desktop Chrome 1,558.9 → 1,508.1 ms. These are single descriptive samples, not causal speedup estimates. First request remains a single bounded 60-family page. The existing startup target is <2,500 ms per tested profile; cold latency gains are not attributed to cache eviction or quotation changes.

Live read-only projection measured 237 ms cursor execution / 5,455.393 ms including network/result transfer. The winning product index is `catalog_active_floor_brand_category_name` with indexed `brands_id` join; no sort/group spills. Normal catalog size uses the existing warm snapshot and bounded cold warmup. No index change was justified or applied.

## Coverage and checks

Route inventory contains 79 source routes: 71 staff, three customer and five authentication/public/landing routes. [Full inventory](2026-10-13-route-inventory.json). Browser route checks combine direct links/error states with success/empty/loading and failure/recovery workflow tests. Dedicated journeys cover Team/delegated permissions, quotations/calculations/persistence/exports, Sales Data date/partial failures, catalog/pagination/filters, purchases/stock/payment flows, customers/walk-ins/follow-ups, and navigation/back/forward/reloads. Final sequential suites passed: route audit 1,635 / 32 intentional skips; responsive 412 / 15 skips; devices 420 / eight skips; extended performance 28 / no skips. Combined: 2,495 passed, 55 intentional skips, zero failures/flakes.

Mobile-first widths: 320, 360, 390, 768, 834, 1024, 1280 and 1440 px across configured suites. Engines/profiles: Chromium/Chrome, Firefox, WebKit, Pixel 7, iPhone 13 and iPad Pro 11. Tests use keyboard/touch controls, viewport bounds and resize/orientation changes; performance adds four-times Chromium CPU slowdown and delayed/stalled API fixtures. All are desktop browser emulation, with synthetic owner/staff/customer identities and intercepted API calls. No physical devices or signed-native acceptance is claimed.

- Final backend unit suite: **2,283 passed**, ten existing warnings. Focused catalog coverage: nine unit + **seven disposable Mongo** cases. Tests use CI placeholder secrets and isolated Mongo configuration.
- Focused quotation browser rerun: **57 passed, seven intentional skips, zero failures/flakes**, two workers and no retries. All 16 new regressions pass across eight projects. The first run's three discount failures are preserved and were fixed, not waived.
- **42 required frontend commands pass**, including the new individual quotation contract. TypeScript, zero-warning lint and production web export pass. Expo Doctor: 20/20. Eleven route bundle budgets pass (576 KiB gzip cap).
- All broader browser suites passed sequentially against the final release export with unchanged deadlines and no retries. The first extended performance run had one readiness timeout aligned with a macOS 403-second idle sleep. Its evidence is preserved; the unchanged complete suite passed 28/28 under a temporary process-scoped idle-sleep assertion. See the browser summary and host-sleep evidence.

## Security and deployment considerations

Rechecked server authorization, floor scope, owner/delegated actions, customer quotation ownership, signed download ownership, rate limiting, resource/URL validation, export injection/privacy, JWT algorithms/signatures and login operator-object validation. New HTTP tests deny same-floor cross-customer list/detail access, return indistinguishable 404s for foreign/missing records, and reject forged tokens/unsupported algorithms/operator inputs before business logic. Worker/client contracts validate session-cookie/CSRF origin/header boundaries. The domain uses floors; this is not an independent organization-tenancy certificate or exhaustive penetration test of all 320 route handlers.

A final-export scan of 248 HTML/JS/JSON/CSS/map artifacts found no literal matches for the configured JWT secret, Mongo URL, Supabase service-role key or Vercel OIDC token. Credentials are not recorded in the evidence. This is an exact-literal scan, not proof of every possible encoding/leak. [Security findings and dependency evidence](2026-10-13-backend-security.md).

Production Python dependency scan: 48 resolved runtime dependencies, no known vulnerabilities. The required fresh npm gate **fails with 22 high and five moderate findings**. Official advisories/current registry releases have no compatible published patched versions for the affected roots. No suppression, authentication weakening, risky SDK migration or lockfile workaround was applied. Required security checks remain release blockers.

Read-only datastore/index/Supabase predeploy gate passes; migration dry-run has no pending changes. Before deployment, live backend was **0.1.0** versus source **0.1.1**, with four password-contract differences. Docker CLI is absent locally; the runtime file allowlist ASGI/assets import smoke passed with synthetic settings without lifespan/live connections. A cached Railway CLI was subsequently located for the user's explicit deployment request. Required GitHub security protection remains unchanged; the review branch can be pushed and directly deployed under that explicit request without merging protected main. Remote build/readiness and final URLs will be recorded in the release ledger. No production business records were modified by testing. Physical-device and source-data limits remain.
