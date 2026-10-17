# Follow-up catalog, loading and recent-source review — 13 October 2026

The follow-up fixes repeated full-catalog hydration scans and repeats the live
Sanitary Bathroom catalog matrix without modifying business records. This is
the catalog/performance agent's review; the parent agent owns UI integration,
walk-in visibility, complete application checks and publication.

## Recent push review scope

Reviewed the ten-commit source range
`27f3464f67f3c7deb58be5d3add7df9aa8ff0f68..a8e106e4744dfb29a72ac096eceea56141aa3308`:

- `652448ba`: business deep links and floor hydration.
- `69b86d82`: saved quotation customer fulfillment.
- `8cb0eb7c` / `5a379773`: Team contacts and cookie recovery.
- `a9a2a97f`: page loading, analytics concurrency, password minimum.
- `828f86b3`: fixture/touch bounds.
- `8e83418c`: family pagination and login hydration.
- `9498c789`: deployed backend contract drift verification.
- `f8b0af5e`: supplier source occurrences.
- `a8e106e4`: catalog placements, quotation workflows, session/cache stability.

Inspected full current catalog read paths in
`backend/services/catalog_service.py`, `catalog_database.py` and
`backend/routes/catalog_routes.py`, and their changes in this range. Reviewed
the range's changes to analytics cache/gather/executive overview, the
customer-specific quotation query, both API client caches, shared catalog
pagination/cache service, and login's parallel account reads. Used the existing
12–13 October audit records to distinguish already-fixed behavior from remaining
problems. This scoped review does not certify every changed line in UI, Team,
release scripts, auth or unrelated business modules; those belong to the parent
and other agents' integration checks.

The existing placement/fallback/category fixes preserve distinct source sections,
category totals and floor/brand namespaces. API caches remain bounded at 64
entries and invalidate across writes/account/floor changes. Analytics shared
misses are keyed by source versions, floor and filters, with cancellation shielding
and bounded memory fallback. The focused existing regression suites found no new
failure in these inspected contracts. The new concrete finding is below.

## Remaining bottleneck fixed

WC configuration options and legacy SKU-only concealed parts scanned every
snapshot product each time a family variant was summarized. One 60-card Vitra
page repeats that scan for many variants. The captured bathroom data has 92
configuration products and 240 SKU-only concealed associations among 3,792
stored products.

The read model now builds one lazy SKU/configuration candidate index per
snapshot. Entries contain references to existing products, not cloned product
payloads. The original floor, brand, category, finish, active/selected-ID and
ambiguous-SKU checks remain at the consumer. Immediate product edits invalidate
the indexes before returning; usage-only snapshot updates retain them using
`dataclasses.replace`. No Mongo query, schema, price, media or stored business
record changes are required.

Two regressions prove one complete index scan across ten repeated hydrations,
exclude wrong-floor/brand/finish candidates, preserve the correct rough-in,
rebuild after SKU/configuration edits, and retain indexes after usage updates.
The surrounding catalog/analytics/page-performance run passes **166 tests** in
1.21 seconds. Changed service/script/test pyflakes passes.

## Controlled CPU evidence

The final reproducible benchmark uses baseline `a8e106e4` and the same captured
3,792-product first-floor source, 60-card first family page and ten sequential
samples per brand. Exact complete output equality passes. Media is omitted
identically from both snapshots. The first indexed sample includes index build.

| Brand | Baseline median | Updated median |
| --- | ---: | ---: |
| Vitra | 329.738 ms | 12.372 ms |
| Grohe | 57.409 ms | 16.960 ms |
| Hansgrohe | 16.211 ms | 15.784 ms |

Raw samples are in
`2026-10-13-followup-hydration-performance.json`. Reproduce from `backend/`
with the full hermetic CI environment in `.github/workflows/ci.yml`:

```sh
.venv/bin/python scripts/benchmark_catalog_hydration.py \
  --baseline-ref a8e106e4 \
  --source ../output/catalog/first-floor-source.json \
  --output ../output/catalog-hydration-recheck.json
```

The input is an existing local read-only catalog capture, excluded from Git;
the script performs no Mongo reads/writes. These timings measure Python service
CPU only. They exclude DB, HTTP, proxy transit, JSON serialization, browser
rendering and media transfer. They do not establish a production page-load speedup.
Hansgrohe has no material measured improvement in this test.

## Fresh live category verification

Ran `.venv/bin/python scripts/audit_catalog_relationships.py --output
../docs/audits/2026-10-13-followup-catalog-matrix.json` against the configured live
read-only source after the index change. It completed in 16.167 seconds with
**146 scopes, zero matrix discrepancies, zero relationship issues**, and 3,090
eligible products: Geberit 500, Grohe 581, Hansgrohe 1,514, Oyster 220 and Vitra
275. All 104 bathroom categories are accounted for; 41 are populated and 63
have no eligible source products. No legacy empty category was populated with
invented products. The audit includes family-card pagination, source-derived
SKU counts, hierarchy/facet consistency and exact source placements.

## Limits and remaining performance evidence

The parent measured three unauthenticated readiness calls from this India host:
Vercel proxy 852/1,212/809 ms and direct Railway 900/728/707 ms. Readiness includes
Mongo access, so this is diagnostic request latency, not isolated transport
latency or authenticated business-page loading. Current Vercel proxy region is
`iad1`; Railway is `sfo` with sleep disabled. The CPU fix above does not remove
that infrastructure/remote-database cost. No region migration is made here.

The prior 13 October browser performance audit already covered 28 synthetic
fixture cases with 200 ms intercepted API delays and bounded first-page loading.
The parent will record fresh whole-application checks and deployed evidence.
The focused suite covers floor/brand/category isolation and database fallback;
the fresh live matrix is Sanitary Bathroom only, not a fresh authoritative
supplier inventory for every other business floor. No production mutation,
deployment, native signing or physical-device acceptance is claimed by this
subtask. The existing dependency/security gate findings remain separately
reported and are not waived by this review.
