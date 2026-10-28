# Application performance work — 28 October 2026

Status: application source `179e56b402005b6d6ef1f3c7b9d4ac3ac2a0d675` is pushed
to GitHub main and live on Vercel and Railway. The full performance objective
remains incomplete: initial JavaScript exceeds 200 KB, and Cloudflare rejected
the media Worker deployment because the available token lacks Worker access.
Original image delivery remains intact; derivative rollout/backfill is pending.

## Final publication evidence

The unchanged full local audit passed 1,060 stability cases across four devices
and all 60 timing cases, with no failures, retries, skips or flakes. Backend:
3,569 passes. All 187 exported pages pass the existing regression ceiling;
largest static initial JavaScript in the final audit is 457 KiB gzip, still
above the requested target. Repaired supplemental frontend fixtures pass 92
cases with two existing intentional profile skips, separate from the strict gate.

Vercel's GitHub production integration published
`dpl_HybEGMoVkqGcKy2xJpErTssVc1cj` to `buildconhouse.in`. Railway deployment
`e3e69093-d3b0-4f18-af30-3d06274ccd2c` reports SUCCESS with one always-running
Singapore replica. Read-only SSH verified all 314 packaged runtime files against
the released source, unchanged Mongo/private-R2 bindings and no pending migrations.
Migration 0041 applied through the controlled runner without business-data rewrites.

Live public verification and all 20 authenticated browser checks pass. Changed
referrer/Kitchen/stock reads returned 200 with no-store; the denied Kitchen
principal returned 403. Two public login reads returned CDN HIT while browser
cache-control remained no-store. Fresh private recovery verified 50 collections,
36,814 records, 228 indexes and both current private files through cloud readback,
full download and isolated restore, followed by independent evidence review.
Temporary QA authentication principals/sessions are cleaned by exact run identity;
no business-record probe writes were performed.

GitHub backend/security checks passed when recorded; independent frontend,
Kitchen persistence and Performance jobs were still running. This is not a
claim of overall green CI. No protections or promotion verifier were weakened;
Vercel publication occurred through its existing GitHub main integration.
The documentation-only publication ledger follows the tested application commit.
Detailed local release evidence: `output/performance-2026-10-28/final-publish/`.

The implementation chronology below retains earlier pending statuses as the
historical observations they describe; this publication record supersedes them.

Source baseline: `f1fccccf`, checked out on local `main` in
`outputs/app-performance-2026-10-28`. This isolated clone avoids modifying the
other chat's active release checkout. Re-fetch and reconcile current remote main
and live source before integration; do not overwrite the Furniture changes or
the concurrent CI deadline work. Dependencies reuse the existing local runtime;
all backend tests use hermetic CI settings, with dotenv disabled.

## Verified changes, applied and tested sequentially

1. Quotation create/update product validation now fetches unique product IDs in
   batches of 500 and restores original line order. It retains fresh prices,
   missing-row rejection and floor intersection. For 100 distinct products the
   query count is 100 → 1; 1,001 distinct products use three queries. A synthetic
   50 ms database round-trip experiment, three samples each, measured
   456.99–460.82 ms before and 50.11–51.10 ms after. These are simulated network
   timings, not production latency. The old implementation allowed 12 concurrent
   queries; the comparison includes that concurrency. Full backend suite after
   this change: 3,478 passed. Four older test doubles were updated to support
   batched reads; their business assertions remain intact.
2. Kitchen project detail is loaded through one lazy entry shared by its six
   routes, following the existing quotation-builder pattern. Production export
   comparison with identical settings: login initial gzip 473 → 453 KiB;
   largest route 499 → 479 KiB; common chunk 183 → 162 KiB. The editor still
   downloads when needed. All 187 exported routes pass the existing 576 KiB
   ceiling, which was not increased. TypeScript, Kitchen draft/autosave tests,
   module graph isolation and release recovery checks pass. Both Kitchen
   performance scenarios pass on Android Chrome, iPhone Safari, iPad Safari and
   desktop Chrome: eight passes, no retries, unchanged deadlines.
3. Existing server compression is now covered at its raw ASGI wire boundary:
   large JSON/text negotiation, transfer reduction, small response threshold,
   client parsing, existing Content-Encoding, range responses, compressed image
   and archive formats, and event streams. Ten tests pass. A real loopback HTTP
   gzip response through the actual proxy/fetch path transferred 310 bytes
   instead of 3,701 upstream bytes, and the downstream JSON parsed correctly.
   The proxy forwards Accept-Encoding but does not copy the compressed length
   or encoding onto fetch-decoded bytes. CommonJS proxy execution still passes.
   Server gzip was already enabled at 500 bytes, level 6; no redundant compressor
   was added. A later public production OpenAPI comparison transferred 610,437
   bytes with identity versus 49,798 with gzip (91.84% less); decoded lengths
   and JSON SHA256 matched. Chromium negotiated gzip and parsed OpenAPI 3.1.0.
   This proves large public JSON compression, not authenticated endpoint latency.
4. Quotation Recent/Frequent product usage increments now use bounded bulk
   writes, deduplicating IDs and sending at most 500 updates per command. These
   are independent telemetry counters; per-document atomic increments are the
   required transaction boundary, not a new cross-document financial transaction.
   Cache publication follows acknowledged writes. Five new tests cover empty,
   100/501/1,001-product inputs, duplicate IDs and failure before cache publication.
   Combined batching/cache tests: 12 passed. Full-suite recheck: 3,493 passed in
   32.67 seconds; zero-warning frontend lint also passes. No claim of production
   write latency is made.
5. Optional PDF-image storage now has a per-host circuit breaker: three transport,
   429/5xx or slow outcomes open it for 30 seconds, followed by one recovery
   probe. Missing/invalid images do not count as an outage. Cached images remain
   available. Healthy hosts retain six concurrent fetches; a degraded host is
   limited to three, reserving global capacity for another host. Global slot
   acquisition waits at most 50 ms, and drip feeds are stopped by an eight-second
   stream budget checked between reads (an in-flight read retains the existing
   five-second socket timeout). Existing DNS/redirect/size validation remains.
   Nineteen focused tests pass, including stale pre-trip completion, one probe,
   recovery, healthy throughput and unrelated-host capacity. Synthetic ten-image
   outage samples with 20 ms failing storage responses: 10 → 3 network attempts,
   224.80–247.18 → 70.17–71.58 ms over three runs. No production outage was induced.
   Cold optional images can use the existing no-image fallback while capacity
   is exhausted or the host circuit is open; no payment/catalog data is cached
   or substituted by this breaker.

6. Extracted the shared customer purchase panels from the Purchases screen.
   Purchases Completed no longer imports the whole screen into common startup
   JavaScript. Login initial gzip is now 438 KiB (baseline 473); largest route
   464 KiB (baseline 499). Purchases itself increases about 1 KiB from the new
   chunk boundary. TypeScript, lint, purchase/floor-race and table contracts pass;
   32 purchase completion/floor-isolation/retry browser cases passed.
7. Catalog, quotation picker and warehouse browsing now request 50 rows per
   page. Catalog default API limits also changed to 50. Warehouse refresh
   retains only the window already opened by the user, with three page reads
   in flight at most. Raw server cursors still advance through duplicates and
   discarded display rows. Thirty-two browser performance scenarios passed on
   four devices with unchanged deadlines; 41 focused backend tests, all 55
   page-loading checks and stock race/refresh-window checks pass. Two older
   test stubs were updated for the newly shared page-size constant.
8. Read-only production explain: warehouse active page fetched 1,025 documents
   for two matches; quotation and referrer probes already used suitable indexes.
   Added migration 0041 for `(floor_id, archived, transferred_at DESC, id)`.
   A disposable 25,000-row Mongo fixture reduced documents fetched 20,000 → 50
   and keys examined 20,000 → 752, with 11–22 ms → 0–2 ms measured samples.
   The `$ne` archive predicate still requires an index-key sort. The migration
   ran twice, preserving all 750 matching rows including missing/null archive
   fields; Mongo selected it without a hint. Eleven migration/runner tests pass.
   This migration has NOT been applied to production.
9. Dashboard follow-up completion is optimistic with a visible saving status.
   Failures restore the row in place and announce the rollback; independent
   successes are retained. Requests capture floor identity; account/floor
   changes and unmount revoke callbacks. Late list/summary reads cannot undo
   confirmed changes. Eleven hook tests and eight browser tests across four
   device profiles pass. The tests are included in the ongoing release gates.
10. Cloudflare R2 is the active image store (confirmed by the user). Read-only
    metadata audit found 8,484 R2 URLs and 13 legacy Supabase URLs. Added public
    R2 WebP display derivatives at 320/640/1024/1600/2048, with original bytes,
    metadata identity, zoom and exports preserved. Private files, animation,
    high-bit-depth images and oversized raster decodes are excluded. At most
    one encoder and two derivative writes run concurrently per driver; upload
    acknowledgement does not wait for encoding. Request cancellation retains
    that capacity reservation until the blocking work actually finishes.
    Worker queries select precomputed copies and fall back to the original;
    there is no per-request image encoding or paid transformation dependency.
    The resumable backfill defaults to measurement only, processes 100 objects
    per page, checks source hashes, and creates only missing derivative keys.
    On six downloaded large public R2 samples, 640-pixel display copies saved
    96.5–99.8% (7,766–34,774 bytes versus 882,844–4,198,572 bytes).
    These are resized display comparisons, not full-resolution lossless claims.
    Lossless WebP alone saved 23.3% on the large PNG sample and enlarged two JPEG
    samples, which is why display derivatives retain original sources.
    Forty-five focused backend tests and worker/URL/media-lifecycle tests pass.
    Full backend suite after these changes: 3,533 passed, one existing warning.
    Live image objects and the worker have NOT been modified.

11. Public `/`, `/index.html`, `/login` and its HTML/slash aliases now set
    `Vercel-CDN-Cache-Control: public, max-age=60`, independently of the unchanged
    browser `Cache-Control: no-store`. Authenticated API responses, dynamic
    business pages and recovery scripts do not inherit this edge policy. These
    entry files are built once with the shared English loading shell and hydrate
    personalized data only after authentication. There is no per-request server
    rendering to cache. Public source verification, route exclusion tests, proxy
    tests and startup recovery checks pass. A pre-change production GET returned
    CDN MISS, age 0, and gzip HTML; post-deployment HIT/latency evidence is pending.
    Vercel header precedence is documented at
    https://vercel.com/docs/caching/cache-control-headers.

12. Tiles dispatch validation now batches ready-stock reads in chunks of 500,
    preserving input order, cumulative duplicate-line consumption checks and
    the caller's transaction session. Ready-stock updates and auto-created
    batches use ordered bulk writes of at most 500 operations, in that same
    transaction. Quantity/floor/deleted guards detect stale stock and abort.
    Twenty-two focused dispatch/index tests pass. A disposable Mongo replica
    verified that a duplicate-key error in the second chunk rolls back the
    first, and a quantity conflict rolls back earlier successful operations.
    The success case committed 1,001 updates and one insert. A real-Mongo
    comparison with 10 ms simulated delay per command measured 100 commands /
    1,218–1,292 ms before versus one command / 24–29 ms after (three each).
    These are synthetic network conditions, not production timings. Document
    number allocation remains unchanged and still occurs in the transaction.

13. Existing open follow-up refreshes now use ordered batches of at most 500,
    flushing before each new insert. Inserts, duplicate-key handling,
    notifications and resolution/event pairs retain their existing ordering.
    A write-time open-status guard preserves a concurrent human completion or
    snooze. Thirty-eight focused tests pass, including chunk failures and side
    effect ownership. With a simulated 5 ms per write, 100 rows used 100 → 1
    commands and 577–649 → 11–14 ms; 1,001 rows used 1,001 → 3 commands and
    5,943–6,209 → 251–418 ms (three samples, identical final snapshots/counts).
    These are synthetic network conditions, not production timings.
14. Reference directory bodies now load 25 contacts per server page (maximum
    50), with literal name/company/phone/code search and name/ID ordering.
    One authorized floor-union query includes shared contacts without duplicating
    them; inactive contacts are excluded before paging. Legacy pickers retain
    their compatible endpoint. Reports identify actual archived/missing identities
    using ID-only lookups in chunks of 500, so off-page active contacts are never
    labelled historical. Historical report entries retain bounded rendering,
    search and scoped period drilldowns. Query/floor/account/unmount guards,
    held-save search changes, duplicate append taps and exact failed-offset
    retries are covered by nine executable hook/model tests. Twenty-eight focused
    backend tests include a real disposable Mongo fixture with 4,007 authorized
    active contacts. Old capped two-floor reads returned 3,900 contact bodies /
    1,425,501 JSON bytes; the new page returns 25 / 9,170 bytes (99.36% less),
    with an accurate total and discoverability beyond offset 4,000. The command
    comparison is two finds versus one find plus one count; no latency claim.
15. Kitchen projects and stage queues now share a lazy workspace entry, following
    the existing detail pattern. A production export of the combined continuation
    measured login 438 → 430 KiB gzip and largest static route 464 → 456 KiB
    in the final clean export (the first combined export measured 431/457).
    Entry alone remains approximately 282 KiB; the 200 KB target is not achieved.
    These are initial HTML script/preload totals; Kitchen's essential lazy chunks
    are separately included in primary-content browser evidence and timing.
    New queue module-failure/reload cases retain the original budgets and session
    checks. The isolated dependency-transformer experiment measured only a small
    further gain (login 411 KiB, largest route 437 KiB), remains unpromoted and
    does not establish browser/native reliability or the requested target.

    Eight Kitchen timing cases pass on four devices with unchanged deadlines.
    Queue primary content measured 951–1,689 ms with the 200 ms API fixture.
    Complete script requests through primary readiness include the lazy modules:
    stage queue 462,258 bytes gzip, projects 461,737, and detail/history/documents
    up to 474,397 (about 463 KiB). These are gzip calculations from frozen source
    assets, not wire/cache measurements. They explicitly remain above 200 KB.

Release review corrections: All-units historical classification now uses the
same active authorized floor union as directory paging; private contacts from
inactive/missing floors remain visible as historical report rows. Public R2
delivery verifies original existence before returning derivatives, and reserved
derivative paths are not direct public URLs. Deletion waits for in-flight copies
and removes all five sizes, including after caller cancellation. Sixty-one
focused storage/reference tests pass, including actual disposable Mongo history.
The other checkout's completed CI concurrency fix was integrated as its own
commit; local workers, job deadlines, scenario deadlines and retries are unchanged.

Latest complete hermetic backend suite: 3,569 passed in 35.19 seconds, with one
existing Starlette test-client deprecation warning. TypeScript, zero-warning Expo
lint, page-loading/optimistic/referrer/lazy-entry contracts, release registry,
module-graph and sales-period checks pass. Current npm audit reports eight low
findings, zero moderate/high/critical; historical larger counts are not current.
Production compression evidence is recorded in `live-openapi-compression.json`
and `browser-live-api-compression.json` under the local evidence directory.

### Continuation gate and source check

The inherited unchanged full audit finished with 1,039 browser passes and nine
failures after 24.2 minutes. Eight failures expect stock row 59 although the
verified page size is now 50; update those boundary assertions to row 49 present
and row 50 absent. The remaining iPad unpriced-quotation case timed out during
startup and requires an unchanged rerun. The failed report and traces are retained;
this run is not acceptance and its timing phase did not execute.

After correcting the stock assertions, all 12 focused original-failure cases pass
on four device profiles, including the unchanged iPad deep-link scenario. The
updated godown-paging and catalog-families suites outside the stability registry
also pass all 56 cases across eight profiles. Final combined-source browser and
full unchanged performance/stability acceptance are still pending. Sixteen final
referrer/search/acquisition cases and eight new Kitchen module recovery cases
pass on four devices. The new Kitchen recovery fixture initially expected a
generic phone More control; its locator now checks Kitchen's actual All stages
control, with recovery/deadline assertions preserved.

Remote main and the canonical Vercel alias were checked before editing. Live
deployment `dpl_2bmseYVKZ6WS2zSfXdjFHYnB3nJH` reports Git source
`f1fccccf79cdf5b94aee3a26ddef90647904dcba` on `main`, which is an ancestor
of this checkout. The performance commits remain local at this point.

### R2 delivery rollout

Deploy the additive Worker behavior and backend after the release gate. Run
`backend/scripts/backfill_r2_image_variants.py` with the actual R2 environment
and a durable report path, first without `--apply`; inspect savings. Use `--apply`
to add copies, resume with the report's `after` cursor, and repeat for
`--collection godown_stock_media`. Copies do not replace registered originals.
Run the backfill before enabling the new frontend URLs to avoid a derivative
miss lookup on each existing image. Deploy the frontend, then verify actual
Cloudflare response MIME, byte counts, original fallback and browser decoding.
A stopped backfill can replay its previous page; existing copies are skipped.
No migration command or app startup is imported by this backfill.

## Outstanding requirements and next evidence

Publication was explicitly requested by the user for GitHub, Vercel and Railway.
Additional CI fixture repairs preserve actual current behavior: Furniture detail
GET queries, retired Kitchen controls, acknowledged Lead movement, full-screen
Back mounting and phone order identity. Heading geometry now observes hydration
within the original assertion deadline. Immediate-release dragging verifies the
starting point hits the visible handle; its original iPhone starting point was
outside the clipped canvas. All four immediate-release cases and eight heading
profiles pass. All 20 original Kitchen keyboard cases pass unchanged locally;
the earlier Linux CI native caret-scroll observation remains subject to fresh CI.
The corrected CSV scenario verifies the browser query/headers and the same
authenticated response bytes, since Chromium's download manager consumes its
attachment body. All four CSV profiles pass. No deadline or retry was increased.

| Requirement | Current evidence / remaining work |
| --- | --- |
| N+1 reads | Quotation validation fixed. Tiles dispatch validation also batched with transactional tests; complete final route audit and production verification. |
| Indexes | Existing catalog and recent migrations already provide many indexes. Warehouse explain and local migration verification complete; production application and after-explain remain pending. |
| 20–50-row pagination | Catalog/stock page at 50; referrer directory server pages at 25 with search, shared authorized unions and explicit historical identities. Backend/Mongo and request-race checks pass; final combined-source browser gate pending. |
| WebP/AVIF images | R2 derivatives and bounded resumable backfill implemented and measured locally. Worker/backend/frontend deployment, existing-object backfill and live verification remain pending. |
| Initial JavaScript under 200 KB | Not achieved: largest static initial route 456 KiB gzip, entry alone about 282 KiB; measured Kitchen primary-content scripts including lazy modules reach about 463 KiB. Kitchen editors/queues and purchase common dependencies split. Further entry/runtime work is required; the 576 KiB regression ceiling is not the user target. |
| Compression in transit | Hermetic server/proxy and large public production JSON verified: 610,437 → 49,798 bytes with identical decoded JSON; Chromium negotiated and parsed gzip. Authenticated endpoint comparison remains separate. |
| Bulk writes | Usage counters, transactional dispatch stock writes and existing open follow-up refreshes batched. Insert/notification and resolution/event pairs remain sequential to preserve ownership and failure boundaries. Synthetic fixtures and focused checks pass. |
| Circuit breaker | Implemented and locally verified for optional PDF storage. Reviewed remaining calls: R2 SDK has bounded connect/read/retries but no overall deadline; cancellation cannot stop its blocking thread. WhatsApp keeps ambiguous-send receipts and never automatically replays sends. Manual catalog URL imports retain 180-second socket reads plus size/SSRF bounds. These retain separate limits; no blanket outage-isolation claim. |
| Optimistic UI | Dashboard completion implemented and verified including visible rollback and account/floor/request-generation guards; release pending. Never optimistically confirm payments or inventory commits. |
| Rendered caching | Public entry shells now have a bounded edge-cache policy; live cache HIT/latency verification is pending. Expo rendering is already performed at build time. Mutable authenticated business reads remain no-store; do not cache inventory, balances or permissions. |
| Final acceptance | Full unchanged performance/stability gate, current source integration, production measurements and required release controls remain pending. No “fastest available” comparison is substantiated. |

Local detailed evidence is in `output/performance-2026-10-28/` and
`output/playwright/`; synthetic data only. The goal remains active.
