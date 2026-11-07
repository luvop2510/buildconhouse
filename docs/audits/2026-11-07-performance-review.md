# Application review and measurements, 7 November 2026

The source baseline is `6bfdbed1a57164901e4647b288725911661bd0f7`.
The review uses synthetic records and a disposable MongoDB process bound to
localhost. Catalog response hashes match between the baseline and final source.
Measurements below describe the local fixtures. Production latency requires
separate sampling after deployment.

## Catalog work and freshness

Workbook detail now expands only the selected product's placements. Grouped
search hydrates only visible families while retaining the complete matching
count and ranking. A patch during initial catalog construction advances the
refresh generation, preventing publication of a pre-edit snapshot.

Paired runs alternate baseline and final implementations in one Python process,
with two warmups and 21 samples each. The fixture contains 6,500 SKUs with two
workbook placements per SKU, and search returns 20 families.

| Operation | Baseline median | Final median | Verdict |
| --- | --- | --- | --- |
| Exact workbook product detail | 12.344 ms | 0.156 ms | Kept |
| Grouped catalog search | 116.110 ms | 77.626 ms | Kept |

Response SHA256 values and all samples are retained in
`.cache/review/backend-benchmark-verified.json`. Regression checks also count
hydrations and product projections, cover permitted floors, and verify that
caller edits to returned data cannot mutate the shared snapshot.

## Forecast aggregation and cadence batching

Forecasting resolves the brand filter once and groups the previous three full
months inside MongoDB. Empty and zero-revenue months, year boundaries, legacy
numeric strings, caller floors and entity filters retain their tested behavior.
The fixture contains 60,000 matching orders and 6,000 records on another floor.

| Measure | Baseline | Final |
| --- | --- | --- |
| Database commands | 9 | 2 |
| Rows transferred to Python | 60,003 | 4 |
| Peak Python allocations traced | 10,714,780 bytes | 13,293 bytes |
| Local median, nine paired samples | 114.939 ms | 130.994 ms |
| Median with modeled 20 ms per command, seven paired samples | 353.680 ms | 192.015 ms |

The aggregation trades additional local database computation for substantially
less transport and application memory. The modeled transport delay is explicit
simulation. Actual deployment timing remains to be measured. The change is kept
for the measured reduction in commands, transferred rows and application memory,
plus the transport fixture improvement. The existing
`quotations_analytics_revenue` index serves an IXSCAN in the real local explain
plan and examines the 60,000 matching records. This path uses that existing
index. An earlier `$bucket` prototype was discarded after a local slowdown.
The final implementation uses `$group` and the raw final evidence above.

Automation default initialization performs one category read and one bounded
bulk command for its three independent rules. A warm invocation performs one
read. The baseline used three reads plus three inserts when cold and three
reads when warm. Each rule's upsert is atomic. The legacy Selection upgrade
uses a conditional match so a concurrent customized cadence survives. Existing
custom rules and IDs are preserved. Newly seeded defaults share a deterministic
Mongo `_id` per category so simultaneous cold starts converge even without a
category-unique index. A real-Mongo regression launches 25 concurrent cold
initializations and verifies exactly one row per default category.

## Portal index and summaries

Migration `0043_portal_quotation_page` adds the nonunique index
`customer_id, created_at desc, id desc`. The companion portal summary endpoint
pages 20 rows, with a maximum of 50 and deterministic ordering. Real MongoDB
integration verifies summary array counts, missing legacy arrays, customer
isolation and repeatable migration without document rewrites.

The separate 20,000-document index fixture examined 2,000 customer rows before
returning a page of 20. The index reduces examination to 20 rows and removes the
blocking sort. Median local duration changes from 2.937 to 0.650 ms across
15 samples. The fixture index occupies 274,432 bytes, with an additional index
entry maintained for every quotation write. Explain plans and samples are in
`.cache/review/portal-index.json`. Apply through the controlled migration runner
before backend rollout and retain the index on application rollback.

## Optional image dependency admission

The existing image host circuit breaker retains its failure threshold,
30-second recovery window, single recovery probe, cache TTL and byte bounds.
Prefetch now checks cached images and open circuits before joining the executor,
limits admitted work across documents to 12 wrappers, and prevents expired
queued work from performing a later network fetch. A document using one worker
keeps the remaining pool capacity available to another document.

With all six executor workers held by the fixture, five paired samples use an
identical 150 ms caller budget.

| Operation | Baseline median | Final median | Result |
| --- | --- | --- | --- |
| Cached image snapshot | 160.099 ms | 0.038 ms | Cached photo retained in 5/5 final runs, versus 0/5 baseline runs |
| Already-open host circuit | 154.077 ms | 0.047 ms | Immediate optional-image fallback |

The final six-way healthy-host concurrency, failure recovery, late-result
generation fencing, unrelated-host capacity, drip-feed deadline and repeated
timeout queue-bound tests pass. Raw measurements are in
`.cache/review/image-admission-verified.json`.

## Security repairs and verification

Download capabilities bind the encoded path and query components independently,
preventing an encoded delimiter from removing a report filter. The recorded
floor controls redemption, including when a caller supplies a different floor
header. Minting rejects encoded variants of the reserved `dl` query key.
Dispatch-number search escapes literal input and HTTP admission bounds page
sizes and offsets.

The full hermetic backend unit run passes 4,216 tests in 39.98 seconds, with one
existing Starlette test-client deprecation warning. Three real local MongoDB
integration cases pass in 1.37 seconds. The subsequent compression, download
capability and image dependency regression run passes 84 cases, covering the
additional Office archive compression exclusions. The complete suite after those
exclusions passes 4,219 tests. Logs remain in `.cache/review/`, including
`backend-accepted-source.log`, `backend-mongo-verified.log` and
`backend-final-compression-security.log`.

## Client delivery and cache behavior

The canonical application is the repository-root Expo app. The historical
`frontend/` tree is retained. Work lives on
`codex/app-performance-security-review-2026-11-06` in the isolated `app-review`
worktree based on verified upstream main. The dirty sibling checkout was preserved.

The Tile Place Order alias now imports its shared screen asynchronously. The
product editor loads when opened through one shared lazy boundary. Separate
production builds measured the following initial HTML script/preload totals.

| Experiment | Login gzip | Largest route gzip | Verdict |
| --- | --- | --- | --- |
| Baseline | 470 KiB | 496 KiB | Baseline |
| Lazy Tile Place Order alias | 466 KiB | 493 KiB | Kept |
| Lazy product editor | 462 KiB | 488 KiB | Kept |

The final export measures 462 KiB for login and 488 KiB for its largest route,
with all 205 exported pages under the existing ceiling. The 200 KB initial bundle
target remains open. Baseline source-map profiling finds the shared React DOM,
Expo Router, React Navigation and React Native Web runtime in an entry chunk of
approximately 283 KiB gzip. Existing framework-sensitive transform experiments
were left out of this change. The existing 576 KiB regression ceiling is retained.

The browser wordmark uses a lossless WebP derivative, 65,178 to 28,988 bytes
(55.52% smaller), with decoded RGBA pixel equality. Native builds resolve the
existing PNG through a platform module. Preview servers serve the WebP MIME.
Existing product-image WebP derivatives, exact original fallback, responsive
width selection and original-source export behavior remain in place. Existing
remote images require a separately verified derivative rollout/backfill.

The purchase movement engine's process-lifetime stage-count cache was unkeyed.
It now delegates to the shared API cache for a two-second navigation window.
Floor changes, account changes and acknowledged mutations invalidate entries.
An explicit refresh uses zero TTL. Web and native runtime checks verify these
boundaries. Editable portal summaries use fresh cancellable reads, with account,
page and search identity guards. The portal home reads one summary, and the
directory reads 20 per page. An artificial 200-document payload with large line
and revision arrays changes from 53,182,290 bytes to a 2,699-byte page, with a
172-byte latest-quotation response. These fixture payloads demonstrate bounds,
not typical production record sizes.

The shared rendered sign-in shell already has a 60-second Vercel edge cache.
Public readback returned `x-vercel-cache: HIT`, and browser cache-control stayed
`no-store`. Personalized APIs remain `no-store`, and graph-stamped assets keep
immutable URLs. The app currently uses English, and its static shell contains
no account data. No personalized fragment cache was added.

## Compression

The existing backend gzip middleware negotiates responses above 500 bytes at
level 6. A synthetic 100-item JSON response measured 8,501 to 374 wire bytes
(95.60% smaller), with identical parsed JSON. The actual Node proxy transport
regression measures 3,701 to 310 bytes and verifies one client decode, preserved
Accept-Encoding negotiation and the deployed CommonJS loader. Existing encoding,
images, ZIP files, partial responses and event streams retain their passthrough
coverage. Office ZIP-based formats now explicitly bypass the additional gzip
pass as requested.

A separate Chromium check sent `Accept-Encoding: gzip, deflate, br, zstd` to a
loopback server using the configured application middleware. The response used
gzip, 7,701 identity bytes fell to 368 transfer bytes (95.22% smaller), and all
100 items parsed with exact value equality. The raw receipt is
`.cache/review/compression-browser.json`.

An Office experiment before the exclusions reduced a synthetic 98,242-byte XLSX
to 44,042 bytes at about 1.75 ms median additional local processing. The exclusion
deliberately avoids that second compression pass and its CPU cost. No new
compressor or Brotli dependency was introduced. Current public API health responds
successfully. The attempted public OpenAPI probes returned 404 and provide no
new evidence of production compression for a large authenticated response.

## Optimistic interaction coverage

Ordinary edits render immediately, reconcile acknowledged server values, and
restore their prior display on failure while retaining retry drafts where relevant.
Synchronous admission prevents repeated taps from issuing duplicate writes.
Account, floor, record and request-generation boundaries prevent late results
from changing another workspace.

- Follow-ups cover completion, preset/custom snooze, due-date changes, dismissal,
  bulk completion/snooze, saved-view removal and follow-up deletion. Bulk failures
  restore only the failed rows, and stale reads cannot undo confirmed changes.
- Walk-ins cover the existing immediate Selection scheduling, list deletion,
  status changes and salesperson reassignment. Pending labels and failure notices
  expose the request state.
- Shared product editing previews ordinary text metadata. Color-variant naming
  updates immediately, preserves normalization and restores the prior label with
  the attempted text ready to retry. Closing or switching identity fences results.
- Today completion and document line additions, quantity edits, reordering and
  draft typing already update locally. Their existing recovery mechanisms remain.
- Session revocation immediately shows pending progress, prevents duplicate
  commands, retains the device after a failure and removes it after confirmation.

New records that need server IDs, private uploads, invitations, permissions,
stock movements, order placement, payments, approvals and customer graph deletion
use immediate busy/pending feedback and publish confirmed business state after
acknowledgement. Controlled company, lead-source and team forms show local edits
immediately and retain failed drafts. Notifications is a retired route with
read-only channel settings. These choices preserve each endpoint's consistency
and recovery contract. No transport-wide automatic write replay was added.

## Verification and remaining work

Frontend checks cover retained-data error/retry, empty states, pagination past the
old 200-record cutoff, search debounce, rollback, concurrent edits, unmount,
account/floor changes, stale reads and normalized responses. The real-Mongo
integration checks join the existing isolated CI job, and new client checks join
existing CI test commands.

The combined source passes 83 affected checks, including TypeScript and the full
backend suite. Zero-warning lint and the 205-page bundle gate pass. Focused
browser checks pass 21 cases on desktop Chrome, mobile Chrome and WebKit. They
exercise immediate changes, rollback, session revocation, product editor upload,
portal search and bounded paging with retry.

The first complete stability run on the final application build records 1,108
passing cases and four failures in the same follow-up scenario. The test expected
the older error copy. Its updated fixture holds the write, verifies immediate
removal before failure, and requires rollback and successful retry. Focused
browser checks pass the updated scenario. The full rerun and separate performance
timing results are pending. The first timing pass records 56 passing cases and
four Kitchen fixture failures caused by the old filename-specific button label.
The corrected test finds the last document by its exact row, checks its filename,
and verifies the current Download PDF action. All timing thresholds are preserved.
A supplemental timing run overlapped the stability suite and exceeded the Kitchen
2.5-second budget on three profiles. An isolated full timing rerun is scheduled
after stability. Earlier logs are retained under `.cache/review/`.

The dependency scan reports zero Python advisories. npm reports 19 moderate and
one low advisory, with zero high or critical findings. A dry-run remediation kept
those counts and proposed incompatible framework changes. It was not applied.
The low deepmerge advisory has no newer published release in the current registry.
The separate security gate remains enabled.

Deployment, production migration 0043, product-media backfill, authenticated
production compression/latency measurements, field Web Vitals and physical-device
acceptance remain outstanding. The 200 KB target and any claim of being the
fastest available application are unverified. This report records local source
improvements and their measured limits. The legacy walk-in API still returns up
to 2,000 filtered records, with the browser mounting 40 at a time. Server paging
there remains separate from the verified portal summary rollout.
