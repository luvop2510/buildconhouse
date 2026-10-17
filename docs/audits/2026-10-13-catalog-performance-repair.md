# Catalog performance regression: source budget overflow

The current supplier catalog crossed the previous 16 MiB warm snapshot cap.
Read-only measurements found 6,565 active products and 8,489 media records;
after excluding Mongo `_id`, the retained source BSON totals 19,688,845 bytes.
Every catalog page therefore selected database paging rather than its intended
warm model. The fallback's 32-row aggregation batches compounded network delay.
This explains why ordinary imported data produced multi-second catalog reads
even though the API had low CPU usage and sufficient memory headroom.

The snapshot now retains at most 32 MiB, with the same per-collection row caps.
Oversized catalogs still select bounded database reads without returning a
partial snapshot. Shared product/family photos reuse one validated media model.
The five independent source collections read concurrently, and snapshot model
construction runs off the event loop. A generation check reloads changes made
during an existing refresh before publishing it. Cold callers share the same
warmup or failure; cancelling one client preserves other callers. A failed
background refresh retains warm data and backs off for 15 seconds. Shutdown
cancels outstanding refreshes and closes source cursors before Mongo closes.

Database paging retains its response/query budgets and uses 512-row batches;
bounded reads close cursors on success, error and budget rejection. Startup
reports snapshot mode, bytes and source counts, warning at 80% of the byte cap
or when database mode is selected. Admin-only `/health/system` returns current
catalog diagnostics even when its external storage checks are cached.

The floor-access and floor-list GETs also repeated four sequential default-floor
upserts before every read, even though application startup creates those exact
defaults before readiness. They now perform one read, retaining owner/staff
access filtering. Default creation remains in startup and the floor-create
mutation. This removes four database round trips from workspace hydration;
no live write benchmark was used to validate a read-only endpoint improvement.

## Measured service results

These are local Python service calls against the actual live Atlas dataset,
not production HTTP or browser latency. No database records were written and
no product/customer records were exported. Cold snapshot loading is reported
separately because application startup completes it before readiness.

| Measurement | Previous database mode | Final memory mode |
| --- | ---: | ---: |
| Sanitary Bathroom hierarchy | 6,619.65 ms | 32.564 ms median |
| Sanitary Bathroom 60-family page | 2,447.55 ms | 41.393 ms median |
| Ground Floor hierarchy | Not sampled in baseline | 27.046 ms median |
| Ground Floor 60-family page | Not sampled in baseline | 37.141 ms median |

The reusable final probe passed the unchanged 200 ms warmed service budget for
all four floors and all four probes: families, hierarchy, brands and categories.
The final run's cold preload took 17,350.452 ms over this Mac's Atlas connection;
peak process RSS was 212.23 MiB. These values do not predict Railway startup or
total API worker memory. An earlier repeat under concurrent local test load is
retained in the repair JSON; its timings differ and are not substituted into
this final table. The final probe records first-call costs separately, including
274.82 ms for the first sanitary family request's lazy import/setup.

An independent memory-versus-database comparison matched the exact first-page
family product IDs, total family counts and every hierarchy group count on
both populated floors. The bathroom hierarchy's database fallback fell from
6,619.65 ms to 1,728.44 ms after batching; its warmed memory implementation
avoids those network calls entirely. Database family timings remain variable;
no universal fallback speedup is claimed.

## Repeatable acceptance

- `npm run test:performance:audit` runs the hermetic backend performance
  regressions alongside frontend budgets and contracts.
- From `backend/`, run
  `python scripts/benchmark_catalog_performance.py --output report.json` with
  the deployment's normal environment for an actual-data, read-only probe.
  It reads catalog sources without server bootstrap, migrations or sessions.
  It fails on silent database fallback and any warmed sample above 200 ms.
  `--allow-database-mode` explicitly accepts an intentionally oversized catalog
  for testing; it does not waive timing budgets.
- Treat warnings near the source cap as a capacity/planning trigger before
  imports or promotions. Verify memory headroom and actual-data timing rather
  than increasing limits without measurements.
- Production acceptance still requires region/network and authenticated browser
  measurements after deployment; this service probe excludes auth and HTTP.

Validation: 26 focused hermetic tests passed, including 20 MiB retained source,
33 MiB bounded fallback, independent source scheduling, cursor closure,
cancelled/failing shared cold calls, failure backoff, in-flight edit invalidation,
media reuse, fresh admin diagnostics, shutdown, probe mode acceptance and
read-only workspace hydration with owner/staff floor isolation.
Eight disposable real Mongo scale/occurrence/hierarchy cases also passed after
the final catalog diagnostics/shutdown additions. Static analysis and diff checks
passed. The root agent owns the final full-suite and deployment evidence.

Evidence: [final service budget JSON](2026-10-13-catalog-service-budget.json),
[before/after and parity JSON](2026-10-13-catalog-performance-repair.json).
