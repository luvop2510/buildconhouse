# Application stability goal — working record

Started 13 October 2026 (Asia/Kolkata). Baseline commit `f8b0af5eae357cc1004a05a65c9dc9f07a2f8eab`; working tree initially clean.

## Context and boundaries

Canonical root Expo 55 / React 19 / React Native Web app (`app/`, `src/`); legacy `frontend/` excluded. FastAPI with MongoDB Atlas, Supabase media, floor-scoped staff/customer authentication. Production web uses same-origin HttpOnly session/CSRF worker; native uses secure bearer storage. Railway backend and existing web hosting are separate deployments. See README, AGENTS and STABILITY_VERIFICATION for current architecture and checks.

The objective file requires implemented fixes and validation, including quotation multi-select removal and every first-floor brand/subcategory. Catalog production inspection is read-only. Unit and browser tests use synthetic/disposable data. No production mutation/deployment or native physical-device acceptance is implied.

## Confirmed observations

- Recent source already includes 30-second request timeouts, account/floor invalidation, shared GET transports, catalog pagination and independent detail loading. Fresh tests will establish current behavior rather than attribute older resolved bugs to this revision.
- Quotation multi-select is the AreaGrouping panel's per-line checkboxes and batch room/area assignment; individual row area fields and categorical filter choices are independent.
- Browser/native response caches retain expired entries until the exact URL is read again or a write/floor/account change clears all entries. Distinct catalog queries/pages in a long browsing session accumulate without a limit. A behavioral controlled-clock regression will quantify retention before changing the clients.

## Work streams

- Catalog: authoritative Mongo eligibility vs service product/family pagination, exact IDs and all first-floor brand/category/subcategory rows; missing source information reported explicitly.
- Quotation: remove batch selection and obsolete action, preserve line model/calculation/persistence/export; browser regression.
- Backend: noncatalog stability/security and hermetic suite.
- Integration: response cache retention, release export, route/viewport/device/performance/failure regressions and required checks.

## Verification record

Final browser acceptance complete. Raw browser evidence stays in `output/playwright` and task log files in `output`. Final report will separate observations, assumptions, failed gates and untested production/physical-device behavior.

## Confirmed fixes and evidence (in progress)

| Issue / reproduction | Confirmed root cause | Fix / evidence |
| --- | --- | --- |
| Read 1,000 distinct catalog pages, advance beyond TTL, read another resource | Cache evicts expired entries only on the same key, with no entry limit | Both actual API clients now expire entries on insertion and retain 64 recent entries. Synthetic 60-product payload retention 65,174,000 → 4,171,136 bytes; expired retention 1,001 → 1 entry. Cache/isolation/timeout/retry regressions pass. |
| Select General / Uncategorised under brands with null metadata | Display fallback labels do not match exact stored null filters | Warm/Mongo filter semantics aligned; authoritative matrix and integration coverage in catalog report. |
| Inspect Grohe SKU 1049819990 across three source sections | Product/category dedupe drops same-category source placements before hierarchy/facet derivation | Preserve distinct placements then dedupe each relevant count. No product duplication or source mutations. |
| Quotation area batch panel remains; edit parent area | Batch controls violate removal requirement; individual area updates did not follow linked included parts | Remove selected-state/actions/panel; inherited areas follow parent, individual line model retained. |
| Render many quotation rows | Every row recalculates the entire quote despite shared memoized breakdown | Reuse existing pricing map; controlled 500-line benchmark 28.726 → 0.132 ms median. |
| Enter discount immediately after opening dialog | Passive initialization can alter selected input during typing | Initialize with layout effect before dialog interaction; first failed browser run/trace preserved, final focused verification: 57 passed / seven intentional skips / zero failures. |
| Invalidate/revoke sessions during a held read/write | Earlier reads can repopulate principal cache after revocation | Cache generation plus post-write invalidation; eight deterministic red→green cases. Existing cross-process ≤10-second cache grace remains documented. |

Fresh local baseline: performance suite 16/16 passed. Catalog fixture (200 ms API delay) readiness Android 1,621.5 ms, iPhone 2,115.2 ms, iPad 1,664.0 ms, desktop 1,558.9 ms. Target preserves existing 2,500 ms startup budget and bounded 60-card first page; before/after use the same fixture/host.

42 required frontend commands pass; type/lint/build pass. Runtime pip scan resolves 48 dependencies with no known vulnerabilities. Fresh npm gate fails with 22 high / five moderate, no critical. Compatible patched releases are unavailable according to rechecked registry/official advisory evidence. No suppressions or risky dependency graph replacement performed.

Read-only production checks: datastore/index/Supabase gate passes; migration dry-run has no pending changes. Deployed backend contract fails: live 0.1.0 vs source 0.1.1 and four password schemas differ. No release promoted.

Final backend after all edge/security regressions: 2,283 passed / ten warnings. Focused catalog: 16 cases (nine unit / seven disposable Mongo) passed; all 146 captured-data scopes rechecked against final code. Final source-only projection/deduplication microbenchmark: 6.988 → 9.159 ms median, ten samples; correctness cost, excludes full hierarchy and DB/network.

Full route audit: 1,635 passed / 32 intentional skips / zero failures or flakes. Seven-width responsive: 412 passed / 15 intentional skips / zero failures or flakes. Device profiles: 420 passed / eight intentional skips / zero failures or flakes. First extended performance run: 27 passed / one failure during initial Android Customers readiness. Trace and macOS power logs show a matching 403-second idle-sleep suspension after the successful HTTP200 fixture; screenshot after wake shows the empty state. All first-run evidence preserved. Complete unchanged suite passed 28/28 under a temporary process-scoped idle-sleep assertion; no deadline increases, retries or code changes. Final combined browser acceptance: 2,495 passed / 55 intentional skips / zero failures or flakes.

Docker CLI unavailable locally. Cached Railway CLI located after the explicit user request to push to GitHub, Vercel and Railway. Runtime Docker allowlist ASGI/assets smoke passes in a clean temporary directory with synthetic configuration; actual container build and live application logs remain unverified.

The user explicitly authorized publication and deployment after local acceptance. Push the review branch and deploy its exact tested source to the existing platform projects. Preserve GitHub branch protection and report the failed npm gate; record final deployment IDs, readiness and rollback references in a separate release ledger.
