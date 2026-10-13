# Application performance incident — 13 October 2026

The principal catalog regression is confirmed against the live source data:
6,565 active products and 8,489 media records retain 19,688,845 bytes of BSON
after Mongo `_id` exclusion. A recent 16 MiB snapshot ceiling silently selected
remote database aggregation for every normal catalog request. Production logs
show family requests taking 2–7 seconds and hierarchy requests taking 12–20
seconds. Low API CPU usage and a 1 GiB memory allowance distinguish this from
CPU saturation or exhausted process memory. The API was in California and its
proxy in Virginia while Atlas reports AWS Mumbai (`AP_SOUTH_1`), adding remote
round trips to these queries and workspace startup.

## Repairs

The snapshot stays finite at 32 MiB and unchanged collection row limits, with
512-document batches. Independent sources load concurrently; model construction
runs off the event loop; product/family photos share one validated object.
Cold callers share warmup/failure, cancelled consumers preserve other callers,
failed refreshes retain warm data with 15-second backoff, and generations stop
an in-flight rebuild from overwriting completed product edits. Background work
and cursors close during shutdown. Fallback and near-limit diagnostics now emit
warnings and appear on administrator-only system health.

Workspace floor GETs no longer repeat four default-floor upserts before their
read. Startup still ensures defaults before readiness, and creation safeguards
and authorized floor visibility remain.

Catalog, Quotation Builder and Tiles grids use row-aware render budgets.
Catalog cards are memoized, facets share the floor/identity-scoped bounded
reference cache, raw server rows advance pagination even when displayed rows
are deduplicated or dropped, and empty pages terminate it. Synchronous in-flight
guards prevent duplicate scroll requests. Both request starts and publication
check current query/floor/mount, including a floor change before passive effects
run. Search invalidates obsolete requests immediately.

The expanded browser audit exposed an iPad `NotSupportedError`: Expo Audio's web
player discarded the Promise returned by media playback. Browser feedback now
reuses one audio element and handles asynchronous failures; native seek failures
are also handled. Unsupported optional audio cannot escape as an app error.

The Vercel proxy's existing deadline covers headers **and** the body, resolving
an indefinite stall after upstream headers. It preserves auth/CSRF/download/floor
contracts and reports upstream duration alongside backend `Server-Timing`.
Deployment configuration targets Vercel Mumbai and one always-running Railway
Singapore replica, retaining the existing domains, database and storage.

## Measured evidence and acceptance

The final read-only actual-data service audit passes the 200 ms warmed ceiling
on all four floors for families, hierarchy, brands and categories. Bathroom
hierarchy is 32.564 ms median versus the previous 6,619.65 ms; the first family
page is 41.393 ms versus 2,447.55 ms. Ground Floor hierarchy/families are
27.046/37.141 ms. Exact first-page identities, family totals and hierarchy counts
match memory and database modes on both populated floors. Cold preload is a
startup cost before readiness and is recorded separately; these are local
service calls, excluding auth/HTTP/browser. See the [backend report](2026-10-13-catalog-performance-repair.md)
and [actual-data budget](2026-10-13-catalog-service-budget.json).

The fresh production export passes all 157 HTML-route bundle budgets; largest
initial JavaScript is 449 KiB gzip. The full expanded performance suite passes
40 cases across Android Chrome, iPhone/iPad Safari and desktop Chrome emulation,
with zero failures/flakes/skips and no retries. A full 60-family × 10-finish page
with a 6,500-family total becomes usable in 1.455–1.521 seconds under a 200 ms API
fixture; builder 1.086–1.663 seconds; Ground Floor 1.437–1.618 seconds; product
addition 76–239 ms; warm catalog visits 26–59 ms. Held secondary reads, obsolete
queries, rotation, repeated navigation, request counts, uncaught errors and
Chromium blocking CPU are enforced. These synthetic browser figures do not
certify customer networks, physical devices or production image decoding.
See the [final browser evidence](2026-10-13-performance-expanded-final.json).

The initial expanded run is preserved: one real iPad audio error and two
desktop failures caused by a concurrent export clearing assets. The audio is
repaired and each performance run now serves an immutable export. No retries,
larger deadlines or suppressed runtime failures were used to obtain acceptance.
See the [initial evidence](2026-10-13-performance-expanded-initial.json).

Final full backend acceptance: **2,305 passed**, ten existing warnings. The
all-page startup/error/layout audit and surrounding catalog/floor/quotation
workflows passed **434 browser cases** across eight projects, with zero
failures/flakes/skips/retries. Publication outcomes are appended after promotion.
TypeScript, zero-warning lint, all existing
frontend contract commands, new audio/proxy/runner regressions and read-only
Mongo/index/Supabase predeploy checks pass; no migrations are pending.
The independent npm security gate still reports 22 high/five moderate findings.
It remains blocking for protected-main merge and is not suppressed by this work.

## Future changes

`npm run test:performance:audit` runs hermetic backend regressions, rebuilds the
current export without local dotenv files, checks every generated route, and
runs loading/cache/pagination/audio/browser constraints. The local pre-push hook
is installed. An independent Performance workflow runs on every push/PR; main
now requires strict backend/frontend/frontend-security/performance checks plus
review, including administrators. Current live inspection found no protection
on this repository before this change, contrary to historical audit notes.
No force pushes, protected-main merges or security-gate bypasses are used.
Vercel builds also fail on the all-route JavaScript budget.

Read the [performance policy](../deployment/performance-policy.md) before
changes. Extend realistic scenarios for new heavy pages. Run the read-only
actual-data backend probe before promotions/imports to detect growth beyond the
snapshot ceiling. Verify deployed source/regions/readiness and compare backend,
upstream and end-to-end distributions after release. Existing provider logs
remain available; durable Sentry/RUM aggregation requires separately configured
provider credentials. Public-health timing is infrastructure evidence, not a
substitute for authenticated catalog interaction.
