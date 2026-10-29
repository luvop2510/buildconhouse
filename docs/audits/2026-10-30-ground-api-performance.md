# Ground Floor API and performance audit — 30 October 2026

## Measured list bottleneck and change

Ground selections/quotations and Sanitary quotations fetched the default first
100 documents with every product line and revision, then searched that incomplete
window on the device. The list route also resolved catalog/media snapshots for
those lines before any list row could render. Tile Orders already uses bounded
database pages and full-result metrics; it does not need another cache layer.

`GET /quotations` now accepts `summary=true` and literal `q` search alongside its
existing `skip`/`limit`, lifecycle/type/status and floor filters. Summary responses
select list fields plus `item_count` in Mongo, and skip product/media hydration.
Both list modes order by `created_at DESC, id DESC` for deterministic page ties.
The default response retains complete documents and the existing image-ownership
checks; detail/export behavior is unchanged. Search composes the original scope
with an escaped, case-insensitive literal match over number, document number,
customer and project; it cannot replace a lifecycle or floor predicate.

The frontend pages 30 records using a bounded 31st-record sentinel, and searches
on the server so older matching documents remain reachable. No new shared cache
was added. Offset pages use deterministic ordering; concurrent
creates/edits can shift offset boundaries and refresh is authoritative.

Fixture comparison uses the **same 31 quotations, each with 30 product lines**,
with identical visible IDs, totals, statuses, dates and line counts. Compact JSON
falls from **155,457 to 8,393 bytes (94.6% less)**; gzip falls from **2,145 to 542
bytes (74.7% less)**. The unusually compressible synthetic fixture intentionally
repeats products; these are payload measurements, not a live latency claim.
The route regression proves one bounded list read with no catalog/media call in
summary mode; default-mode media regressions continue to pass.

An isolated loopback MongoDB 7 process with 6,000 synthetic quotations compared
the identical Ground/type/pending query, summary projection and 31-row limit
under existing indexes and the proposed stable-order index. The existing index
plan examines **2,400 documents / 2,401 keys** and performs blocking `SORT`.
Adding `(floor_id, status, created_at DESC, id DESC)` examines **62 documents /
64 keys**, returning the identical rows with `SORT_MERGE`. Observed execution
time was 16 ms versus 1 ms on this local fixture; this single query-plan sample
is not a production p95 or a network-latency measurement.

Migration **0042** adds only that nonunique read index. It keeps every business
record and existing index intact. Equivalent legacy names are accepted only
after verifying the same complete, visible, nonunique key pattern; unrelated
index/provider failures still fail migration. Apply it through the controlled
runner before backend rollout. It adds one maintained read index to future
quotation writes; no data backfill or destructive rollback is required. A
rollback to the preceding application can retain this additive index.

Reproduce under the hermetic CI environment:

```sh
cd backend
.venv/bin/python -m pytest tests/unit/test_quotation_list_summary.py -q -s
```

The normal CI/test runner must supply the isolated Mongo/auth/storage settings;
never load production configuration for unit tests.

## Cache and API checks

Native/web API-client contracts pass: shared-list cache expiry and explicit
refresh, bounded 64-entry retention, identity/floor isolation, mutation
invalidation, stale read/write races, cancellation and bounded deadlines. The
retention stress fixture submits 1,000 60-row pages and retains 64 entries
(4,171,136 fixture payload bytes), then one entry after TTL expiry. Editable
detail and authorization reads stay fresh; writes are not automatically replayed.
No transport/cache change was justified by these checks.

The proxy's security, cookie/CSRF and compiled CommonJS execution contracts pass.
Its synthetic JSON response compresses from 3,701 to 310 upstream bytes and the
client parses it once. Source inspection found no backend Mongo/JWT/R2/service
credentials referenced by browser source. Configuration tests cover fail-fast
validation, safe diagnostic serialization, public/private storage separation,
request limits and security headers; no secret values were emitted.

Focused hermetic backend audit: **133 passed** across Ground read fanout,
catalog/page performance, follow-up coalescing, authentication cache/singleflight
and revocation, analytics cache/invalidation, configuration/security, bounded Tile
Orders pages and quotation filters. New summary/search plus existing quotation
filter/product/floor tests: **30 passed**. These are focused checks; they do not
replace the full final-source performance/stability and backend release gates.
Migration/summary/filter checks: **29 passed**, including idempotency and rejected
sparse, partial, hidden, unique or differently collated equivalent indexes.

## Configuration, dependency and release boundaries

The initial dependency audit found **3 high and 8 low** advisories. The new
`GHSA-qr28-fpjm-wq7f` covers the already-pinned `decode-uri-component <=0.5.0`;
`query-string` and `expo-router` inherit the finding. The existing ESM default
compatibility patch does not address that advisory. The decoder override is now
0.5.1, retaining the reviewed CommonJS/ESM adapter. The malicious malformed-URI
regression and ordinary Router query compatibility checks pass; current npm
audit reports **8 low, zero moderate/high/critical**.

The unauthenticated local-shell predeploy/dry-run initially stopped at
configuration validation. Repeating them with Railway's existing production
variables, exact project/service/environment and `--no-local` succeeds:
**MongoDB ping, required indexes and R2 bucket access pass**. Runtime settings
validate without exposing secret values; source keeps service/Mongo/JWT/R2
credentials server-side. The read-only migration dry-run showed **no pending
migrations before adding 0042**. The new index is pending controlled application,
not claimed applied here. Vercel, GitHub and the existing Railway CLI sessions
are available. No production business record was created or changed by this
audit; read-only storage/index checks do not establish credential rotation age
or full operational recovery acceptance.

Before publication retain the complete unchanged performance/stability gate,
current GitHub main protections, controlled read-only migration preflight and
actual provider/runtime source verification. An authenticated provider account,
Git push, preview READY and production publication are distinct facts. Keep
the previous Vercel/Railway deployment as the rollback target. Physical iOS and
Android software-keyboard behavior remains a separate device check.
