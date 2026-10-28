# Application performance work — 28 October 2026

Status: in progress. The full user objective is not achieved. No production
deployment or database migration has been performed for this work.

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
   was added. Public production health responses were only 69 bytes, so they
   do not prove compression of authenticated large production responses.
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

| Requirement | Current evidence / remaining work |
| --- | --- |
| N+1 reads | Quotation validation fixed. Tiles dispatch validation also batched with transactional tests; complete final route audit and production verification. |
| Indexes | Existing catalog and recent migrations already provide many indexes. Warehouse explain and local migration verification complete; production application and after-explain remain pending. |
| 20–50-row pagination | Catalog/stock now page at 50. Referrer directory fetches up to 2,000 per floor and only slices the displayed UI. Add server search/paging with complete caller and floor-race coverage. |
| WebP/AVIF images | R2 derivatives and bounded resumable backfill implemented and measured locally. Worker/backend/frontend deployment, existing-object backfill and live verification remain pending. |
| Initial JavaScript under 200 KB | Not achieved: largest initial route 464 KiB gzip, entry alone 282 KiB. Kitchen and purchase common dependencies split. Further entry/runtime work is required, with startup and recovery verified. Do not hide essential downloads from measurement or relabel the 576 KiB ceiling as success. |
| Compression in transit | Hermetic server and actual local proxy transport verified. Still need authenticated production JSON/text transfer-size comparison and browser negotiation evidence. |
| Bulk writes | Usage counters and transactional dispatch stock writes batched. Follow-up reconciliation still has sequential updates/inserts/events; requires a separate transaction/idempotency/notification review and measured fixture before changing. |
| Circuit breaker | Implemented and locally verified for optional PDF storage. Complete final regression verification and inspect other critical external dependencies for remaining cascade paths. |
| Optimistic UI | Dashboard completion implemented and verified including visible rollback and account/floor/request-generation guards; release pending. Never optimistically confirm payments or inventory commits. |
| Rendered caching | Public entry shells now have a bounded edge-cache policy; live cache HIT/latency verification is pending. Expo rendering is already performed at build time. Mutable authenticated business reads remain no-store; do not cache inventory, balances or permissions. |
| Final acceptance | Full unchanged performance/stability gate, current source integration, production measurements and required release controls remain pending. No “fastest available” comparison is substantiated. |

Local detailed evidence is in `output/performance-2026-10-28/` and
`output/playwright/`; synthetic data only. The goal remains active.
