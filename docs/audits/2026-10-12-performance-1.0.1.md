# Performance and password minimum — version 1.0.1

The release source fixes catalog cold-start database round trips, analytics request waterfalls and duplicate cold computation, and full-page loading barriers on customer and quotation details. App/package versions move from 1.0.0 to 1.0.1; API version moves from 0.1.0 to 0.1.1. Publication is to a GitHub review branch; production deployment is not claimed.

## Causes and fixes

- Catalog warmup used 32-document cursor batches. At 6,565 products that means approximately 206 product cursor trips. Batches now hold up to 512 documents, approximately 13 trips, while the existing 16 MiB snapshot limit, collection row limits and indexed database fallback remain enforced. Cursors close on success, errors and limit fallback. Concurrent cold callers reuse the first completed snapshot; explicit write refreshes still reload data.
- Independent analytics source reads, KPI aggregates, brief aggregates and Redis version reads previously ran sequentially. They now overlap. Revenue by floor needs one revenue query per floor instead of current/prior/payment queries, with at most four floors loading concurrently. Identical version/floor/filter cache misses share one loader, and one canceled caller cannot cancel other consumers. Failure and concurrent mutation tests preserve retry and invalidation behavior.
- Customer and quotation detail pages waited for every history/pricing request before showing their main record. Primary content now publishes independently. Pending sections explicitly show loading states and failed reads expose retry. Route, workspace, unmount and retained callback guards prevent obsolete responses from replacing the current document. Quotation line pricing waits for its breakdown; line lookup uses a memoized map.
- Customer history used a floor-wide quotation download followed by client filtering. The API now accepts an exact customer_id filter while retaining existing floor scope and pagination.
- Catalog startup and categorical filters paid a 250 ms search debounce. Only typed searches debounce now; opening a page, changing mode/filter/floor and clearing search start promptly. Held initial-request/type-clear races have deterministic regression coverage.
- Staff creation, owner/member resets, customer portal passwords and owner operational reset validation now require at least six Unicode characters. Frontend and API agree; existing maximum 72 UTF-8 bytes and historical demo-password rejection remain. Generated passwords retain their existing policy.

## Evidence

The [backend benchmark](2026-10-12-backend-performance-benchmark.json) compares previous committed source with changed source using fake cursors and 30 ms per simulated network trip, without production access. Catalog warmup changes from 6,606 ms / 210 trips to 547 ms / 17 trips; an empty three-floor executive overview changes from 1,069 ms to 126 ms. These are controlled regression measurements, not live latency promises.

The [browser measurements](2026-10-12-browser-performance.json) use the actual production web export with every API intercepted and delayed 200 ms. Baseline catalog startup held its first family request 250–271 ms after reference requests. The final export starts it within 0.3 ms. Final catalog readiness ranges from 1.08 to 1.61 seconds across Android Chrome, iPhone Safari, iPad Safari and desktop Chrome. Total timings include browser/test scheduling; desktop total timing is slightly higher than baseline despite removal of the fixed delay.

Both primary-detail guards failed the previous export while optional requests were held indefinitely. They pass the final export across all four device profiles. Each cold catalog loads exactly one 60-family page, makes no duplicate identity/reference reads, has no page errors, and stays inside its viewport.

## Verification

- Final hermetic backend unit suite: 2,246 passed, 10 existing dependency/deprecation warnings.
- TypeScript and zero-warning Expo lint pass.
- Actual-screen hook regressions: 20 passed, including mobile/tablet/desktop publication, floor/route races, unmount, initial debounce, clear search and mode changes.
- Final performance browser suite: 16 passed, no retries, failures, flakes or skips across four device profiles.
- Six-character creation/member reset/owner change/customer first-change browser checks: 16 passed across Android Chrome, iPhone Safari, iPad Safari and desktop Firefox.
- API client cancellation/invalidation, 96 auth lifecycle cases, mobile UX, native release routing, Team contacts, quotation contracts, release recovery and web worker contracts pass.
- Unsigned Hermes iOS and Android exports pass.
- Production web export and all 11 route JavaScript budgets pass (424–449 KiB gzip against the existing 576 KiB cap).
- Read-only datastore/index/Supabase predeploy checks pass. Migration dry-run reports no pending migrations. No production database writes were performed for this task.

The wider six-width regression run initially passed 121 cases with four tablet-only skips and one filter-observer timing failure. Immediate categorical requests could finish before the test installed its response listener. The listener now starts before filter selection; no timeout increase or retry was used. The final complete family/filter suite passes all 48 cases across six widths, zero failures/skips/flakes/retries. The unchanged customer/quotation regression cases passed in the wider run.

## Release limitations

The existing required npm security gate remains failed: 22 high and five moderate findings. No security policy or advisory suppression was changed. The source can be reviewed on GitHub; production promotion remains blocked by that gate. Browser emulation and unsigned native exports do not establish physical-device acceptance or production page-load latency.
