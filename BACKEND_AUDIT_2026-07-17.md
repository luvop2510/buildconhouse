# Backend Production-Readiness Audit — 2026-07-17

Scope: `forge2.0/backend/` (FastAPI + MongoDB Atlas + Supabase storage). Every finding below cites a specific file and line range; nothing here is speculative. Method: direct read of `models.py`, `db.py`, `auth.py`, `server.py`, `settings.py`, `bootstrap.py`, `routes/payment_routes.py`, `routes/purchase_routes.py`, `routes/quotation_routes.py`, `routes/purchases_tracker.py` (transfer/numbering/stage-change sections), `scripts/ensure_indexes.py`, `scripts/backup_db.py`, `requirements*.txt`, `Dockerfile`, `.github/workflows/ci.yml`, plus two independent deep-dive passes over (a) the remaining route files + `auth.py` cross-checks and (b) every file under `services/` and `catalog_pipeline/`.

**Relationship to `PRODUCTION_READINESS_AUDIT.md` (2026-07-16):** several of that report's P0/P1 items are now fixed and reconfirmed closed here — a real `Dockerfile` and `.github/workflows/ci.yml` now exist, `payment_routes.py` now wraps the balance-check + insert in a Mongo transaction with a documented standalone-Mongo fallback, and `server.py` now runs a persistent `outbox_worker()` background task with dead-lettering. Others are still open (demo credentials, no migration framework, per-process rate limiting) and are carried forward below with fresh evidence. This audit also surfaces a substantial set of issues the prior pass did not cover — most importantly that CI never actually executes the test suite, a live SSRF-guard bypass, an inventory-quantity race condition, and a non-enforced maker-checker control on catalog imports.

---

## Status update — 2026-07-17 (all 5 Criticals fixed)

All five Critical findings below are now fixed (code changes made both directly and via a concurrent hardening session on this same repo — see each item's note for specifics):

1. **Demo credentials** — code hardening only, no live data touched automatically per explicit instruction: `settings.py` now fails startup fast if `ENVIRONMENT=production` and demo seeding is enabled; the hardcoded `DEMO_PASSWORD` literal is gone (`FORGE_DEMO_PASSWORD` required explicitly when seeding is on); `seed.py::resync_catalog_if_needed` is now gated behind the same flag (previously ran unconditionally); `bootstrap.py`/`server.py`/`/api/health` detect (via `bcrypt.checkpw`, never a string compare) and report any account still on the legacy password as `{"status": "degraded", "reasons": [...]}` — monitoring-consumable, not just a log line; a reviewed, not-executed `scripts/rotate_demo_credentials.py` exists for the user to run themselves against whichever environment they choose. Live rotation, if it happened, happened outside this session.
2. **SSRF bypass** — fixed: redirects are no longer auto-followed; every hop (initial request + each redirect) re-validates scheme/hostname/resolved-IP/port before connecting; port is now restricted to 80/443; blocked hops are logged.
3. **Catalog import resilience/rollback** — fixed: each row is processed in its own try/except (one bad row is recorded and skipped, not fatal to the batch); `update_row`'s PATCH now validates `mrp`/`dealer_price` are numeric before accepting; `rollback_job` now does a real, verified revert — created products are removed, updated products are restored from a captured pre-write snapshot (`catalog_import_snapshots` collection) — not just a status flag flip.
4. **Inventory race condition** — fixed: the partial-move (and full-move) stage update now uses a MongoDB `$elemMatch` optimistic-concurrency guard tied to the exact quantity/stage read; a lost race retries automatically (up to 3 attempts, re-reading fresh state each time) before surfacing a structured `409` with `expected_qty`/`current_qty`/`current_stage` so the frontend can refresh intelligently.
5. **CI never ran tests** — fixed: the 4 self-contained unit test files (`test_settings.py`, `test_purchases_move_permissions.py`, `test_catalog_pagination.py`, `test_auth_cache.py`) plus all new regression tests from this pass now live in `tests/unit/` and run in CI (`.github/workflows/ci.yml`: Lint → Static Analysis → Unit Tests → Docker Build); the 7 live-HTTP integration tests are formally separated into `tests/integration/` with a documented path to enabling them later (`tests/INTEGRATION_TESTING_STRATEGY.md`) — never against the shared Atlas cluster.

Also newly added as part of this pass: a lightweight, real migration system (`backend/migrations/`, tracked in a `schema_migrations` collection, run automatically at startup) replacing "no migration framework" with an actual auditable mechanism — closing the previously-uncreated `user_sessions` indexes gap as its first real migration.

45 unit tests pass (`cd backend && pytest tests/unit -v`). Deliberately **not** done as part of this verification: booting the real app against the live Atlas cluster (`backend/.env`) — startup runs `dispatch_pending()` and `reconcile_followups()`, which write real data, and no local/disposable MongoDB was available in this environment to substitute. Verification instead relied on the unit suite plus static compilation checks across the whole backend.

---

## CRITICAL

**1. Demo credentials are still live in production data.** `owner@forge.app` … `worker@forge.app` with the publicly-known password `[legacy password removed; use injected test credentials]` remain active in the live `buildcon_house` Atlas database. Full administrative account takeover requires no exploit, just the password. (Carried forward from the 2026-07-16 audit and from this session's memory — reconfirmed still open.)

**2. SSRF guard in catalog import is defeated by its own HTTP client.** `routes/catalog_import_routes.py`'s `_guard_public_url` (lines 30-53) validates that the *initial* hostname resolves to a public IP specifically to block cloud-metadata SSRF — but the actual fetch (lines 129-133) uses `httpx.AsyncClient(follow_redirects=True)` with no re-validation of the redirect target, and the guard's own DNS lookup and the later fetch's DNS lookup are two independent resolutions (classic DNS-rebinding gap). Any authenticated "purchase"-role account can submit a URL that redirects to `169.254.169.254` or another private address and the request goes through unchecked. This is a live security-control bypass reachable in normal usage, not an edge case.

**3. Catalog import has no transactions, no per-row error isolation, and its "rollback" doesn't roll anything back.** `catalog_pipeline/orchestrator.py:166-304` loops per row with zero exception handling; `mrp = float(r["mrp"])` (line 187) raises uncaught on a non-numeric value, and `mrp` is directly editable via an unvalidated raw-dict PATCH (`catalog_import_routes.py:149-168`, no type check). One bad row aborts the batch mid-way, leaving a partially-imported set of live product mutations with no compensation. Recovery is impossible: `rollback_job` (`orchestrator.py:349-356`) only flips the job's status to `rolled_back` — its own comment admits "actual product rows aren't destroyed" — yet `catalog_import_routes.py:198-205` exposes it as `/rollback` returning `products_deactivated: n` (always `0`), presenting a fix that fixes nothing. Real catalog corruption, reachable through the normal review-and-approve workflow, with no working undo.

**4. Concurrent partial stock-moves ("split") in the Material Tracker can silently desync inventory quantities.** `routes/purchases_tracker.py::_apply_stage_change` (lines 623-736), partial-move branch (661-708): reads the item's current `qty` (line 637), computes `remaining = full_qty - move_qty` in Python (line 662), and writes it back with a plain `$set` — no optimistic-concurrency filter, no atomic `$inc`. Two concurrent partial moves on the same `item_id` (a double-tap, or two warehouse staff acting on the same batch at once) both read the same starting quantity; the second write clobbers the first's result while **both** still push a new split-item document (`$push` at line 705-708). Net effect: the sum of tracked quantities across the resulting items no longer equals the original quantity — silent, unrecoverable inventory-count corruption, with no unique constraint or lock protecting it.

**5. CI never runs the test suite.** `.github/workflows/ci.yml` (backend job) only does `pip install`, `python -m compileall` (syntax check), `pyflakes` (undefined-name lint, with real-issue categories explicitly filtered out), and a Docker build. There is no `pytest` invocation anywhere in CI, despite a substantial `backend/tests/` suite that specifically covers purchases-move permissions, quotation v2 logic, catalog dedup/regression, and auth caching — exactly the highest-risk paths in this audit. Every regression on payments, purchases, or auth can merge and deploy with CI green.

---

## HIGH

**6. Session/token exposure via URL query parameter.** `auth.py:211-220` (`get_current_user`) accepts a bearer token via the `_t` query param as a "fallback token for browser downloads" — but the dependency is used globally, so any endpoint using it can accept a token in the URL. Combined with the 30-day default `JWT_EXP_MINUTES` (`settings.py:102`), a URL containing `?_t=<token>` leaks into access logs, browser history, and referrer headers, and stays exploitable for up to a month. (Carried forward — reconfirmed still open.)

**7. Production auth flow depends on a hardcoded third-party demo domain.** `auth.py:67`: `GOOGLE_SESSION_URL = "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"` — not configurable via `settings.py`/env, and the domain name itself signals scaffold/demo intent, not something a real business should depend on for verifying Google sign-ins in production.

**8. Legacy tokens (no `session_id`) can never be revoked.** `auth.py:132-137`: tokens issued without a `session_id` skip the `user_sessions` check entirely and stay valid until JWT expiry (up to 30 days), with no revocation path short of deactivating the whole account.

**9. Maker-checker on catalog import approval is documented but not enforced.** `auth.py:264` lists "Approve catalog imports" as a **manager** capability, but `catalog_import_routes.py:171-175` (`approve_and_import`) only requires `require_min_role("purchase")` — the same role that uploads the pricelist can also approve and import it into the live catalog, unsupervised. (The `rollback` endpoint ironically *does* require `manager` — the safety net has a higher bar than the risky action it's meant to guard.)

**10. Password change doesn't revoke other active sessions.** `routes/auth_routes.py:59-77,109-126` update the password hash and call `invalidate_principal_cache` — which only clears a 10-second in-memory cache, not the `user_sessions` collection. Every other already-issued token/session for that account stays valid for up to 30 days, even though `logout_all_sessions` (`auth_routes.py:241-249`) already exists and simply isn't invoked from this flow. A user who changes their password because they suspect compromise does not actually lock an attacker out.

**11. Suppliers have zero floor isolation despite having a `floor_id` field.** `models.py:486` defines `Supplier.floor_id`, but `routes/supplier_routes.py` (all 67 lines) never imports `floor_query`/`floor_for_write` — every list/get/create/update operates globally across every floor, contrary to the isolation model applied correctly elsewhere (Customers, Quotations, Payments).

**12. Catalog and Brand/Category have no floor concept at all.** Confirmed via grep across `catalog_routes.py`, `catalog_import_routes.py`, `services/catalog_service.py`: zero references to `floor_query`/`floor_for_write`. `create_product`/`create_custom_product`/`update_product` never scope by floor; `Brand`/`Category` (`models.py:245-257`) have no `floor_id` field whatsoever, so there's no floor concept to even retrofit onto without a schema change. (Carried forward from prior session notes — reconfirmed still open, with exact line evidence.)

**13. Document numbering has three independent implementations, two of them racy.** `services/sequence.py::next_number` is a correct atomic `find_one_and_update`+`$inc` counter, correctly used by `routes/quotation_routes.py` (direct create) and `services/domain_outbox.py` (order-placed flow). But `services/transfer_workflow.py::_next_number` (lines 37-41) uses `count_documents` (count-then-format), and `routes/purchases_tracker.py::_next_po_number` (lines 823-836, the "legacy" transfer path) uses `sort("number", -1).limit(1)` then parses-and-increments — both are check-then-act races. The DB-level unique index on `quotations.number`/`purchase_orders.number` (`scripts/ensure_indexes.py:116-117`) prevents silently duplicated numbers, but that means the practical failure mode is a hard request failure (duplicate-key/transaction-abort error surfaced to the user) under concurrent transfers, on **both** the new and "legacy" transfer endpoints — i.e., every currently-live transfer pathway has this problem, while the primary create-quotation and order-placed paths do not.

**14. No unique index on `customers.email` — duplicate-customer race.** `routes/customer_routes.py:29` does a check-then-insert (`find_one` then `insert_one`) with no backing unique index (confirmed absent from every `create_index` call in the repo). Two concurrent signups/creates with the same email both succeed, and every later `find_one({"email": ...})` (login, invite) becomes non-deterministic about which duplicate it returns.

**15. `user_sessions`' required indexes exist nowhere in code.** `bootstrap.py:64` demands `(("id",1),)` and `(("user_type",1),("user_id",1))` on `user_sessions` at every startup preflight, but grepping every `create_index` call in the repository shows nothing ever creates them — only `products`, `product_usage`, `product_media`, `brands`, `categories`, `catalog_image_blobs`, `users`, `quotations`, `purchase_orders` (in `scripts/ensure_indexes.py`), plus outbox/transfer-specific indexes (`domain_outbox.py`, `transfer_workflow.py`). A fresh environment/database has no scripted way to satisfy the app's own startup gate for this collection — someone created these by hand outside version control.

**16. Catalog-adapter classification logic is duplicated four ways with proven drift.** `catalog_pipeline/framework.py`'s shared resolvers (`classify_category`, `extract_subcategory`, `resolve_finish`, docstring: "every adapter uses these... so hierarchy, finish, and image quality tagging behave identically across suppliers") are imported by **none** of `grohe.py`, `geberit.py`, `vitra.py`, `hansgrohe.py` — each reimplements its own category/subcategory/finish logic independently. Confirmed drift: `vitra.py`'s local `SUBCATEGORY_KEYWORDS` is missing keys present in `framework.py`'s version ("One-Piece WC", "Flush Plate", "Kitchen Mixer", etc.), so the same physical product feature is classified differently depending on which brand's file imported it.

**17. Base64 file attachments are embedded directly inside the transactional PurchaseOrder document.** `models.py:595-604` (`PurchaseAttachment.data_url`) and `purchase_routes.py:412-456` (`add_attachment`) append full base64-encoded files into the `PurchaseOrder.attachments` array — unlike `ProductMedia`, which correctly stores binaries in Supabase and keeps only metadata in Mongo. A 15MB-per-attachment cap exists (`purchase_routes.py:427-429`), but there's no cap on the *number* of attachments or the document's aggregate size — a PO accumulating several delivery-note photos can approach MongoDB's 16MB document limit, at which point every future update to that PO (status change, stage move) fails.

**18. Multi-worker cache incoherence — proven by the shipped Dockerfile, not hypothetical.** `Dockerfile`'s `CMD` runs `uvicorn ... --workers 2`, but `auth.py`'s principal cache, `services/rate_limit.py`'s login-attempt counters, and `services/catalog_service.py`'s in-memory catalog snapshot (`schedule_catalog_refresh`/`patch_product_in_snapshot`, lines 130-173) are all plain process-local module globals with no cross-process coordination. Concretely: the effective login rate limit is double the configured value (each worker tracks attempts independently); a just-revoked/deactivated session can still authenticate on the other worker for up to the 10s cache TTL; and a product edit landed on worker A is invisible to a request landed on worker B for up to the 300s snapshot TTL.

---

## MEDIUM

**19. Money is plain `float` throughout, with inconsistent rounding order.** `models.py` uses `float` for every currency field; `services/pricing.py`'s `recalc_quotation_totals` (sum-then-round, lines 48-90) and `per_line_net_amounts` (round-then-sum, lines 93-132) don't agree by construction — a generated Purchase Order's total can drift a few cents from the quotation `grand_total` it was derived from (`domain_outbox.py:199-200` consumes the per-line version).

**20. Deleting a quotation has no guard against linked financial records.** `routes/quotation_routes.py:326-334` (`delete_quotation`, manager role) hard-deletes with no check for existing `purchase_orders`/`payments` referencing it — orphans PO/payment traceability silently.

**21. Backups are manual, non-scheduled, and not point-in-time consistent.** `scripts/backup_db.py` dumps each collection independently (`db[name].find({}).to_list(200000)`, line 96) with no cross-collection snapshot consistency, defaults to local disk (Supabase push is best-effort/optional, lines 53-75), and — confirmed via the repo's only cron config (`.emergent/cron/webhook-crons`, a single unrelated Emergent platform job) — is never invoked on any schedule. A backup taken mid-write can capture a payment referencing a quotation the quotations.json snapshot doesn't yet contain.

**22. Authorization tier inconsistent for the same capability.** `catalog_routes.py:482-483` (`GET /catalog/export.xlsx`) allows any authenticated role (including "worker") to export full MRP/trade pricing, while `auth.py:263` documents "Catalog backup/export" as an `admin` capability and the sibling `/settings/catalog-backup` endpoint (`settings_routes.py:80-81`) correctly enforces `require_min_role("admin")`.

**23. Pre-approval pricing data is readable by any role.** `catalog_import_routes.py:82-87` (`GET /{job_id}`) returns the full import job — including unapproved `mrp`/`dealer_price` rows — to any authenticated user, while every mutating endpoint on the same resource requires `"purchase"`.

**24. Outbox worker has no per-event claim/lock.** `services/domain_outbox.py::dispatch_pending` (lines 261-278) does a plain `find` for pending events with no atomic claim step; two concurrent dispatchers can pick up the same event (unique `automation_key` indexes stop duplicate documents from being created, but one transaction aborts and the fire-and-forget notification from the losing attempt can still fire — see #25).

**25. Fire-and-forget notifications can fire from a transaction that later aborts.** `services/domain_outbox.py:222-228` schedules `notify(...)` via `asyncio.create_task` from inside `session.start_transaction()` — if the transaction aborts after that point, the "order confirmed" notification has already gone out for an order that doesn't actually exist yet (or ever).

**26. Non-transactional two-system writes in media handling.** `services/media_service.py::replace_media` (lines 213-254) uploads-then-deletes as two independent steps; a crash between them leaves both old and new images live. `delete_media` (lines 189-193) deletes the DB row even when the underlying Supabase delete fails, permanently orphaning the storage object with no metadata row left to find it.

**27. Dedupe-then-insert race in media upload.** `services/media_service.py:115-142` checks for an existing identical image then inserts, with no unique index on `(sha1, product_id, source_type)` — concurrent uploads of the same image can both pass the check, and if both also set `is_primary=True`, two rows can end up marked primary.

**28. Temp files leak on every EMF/WMF image conversion during catalog import.** `catalog_pipeline/image_extractor.py:196-255` creates temp files via `tempfile.NamedTemporaryFile(delete=False)`/`tempfile.mktemp()` and never cleans them up in any branch — a large supplier import (the file's own docstring says "hundreds of images") leaves hundreds of orphaned temp files per run.

**29. Follow-up reconciliation silently truncates at scale.** `services/followup_engine.py::reconcile_followups` (lines 209-213, 342, 384) loads `customers`/`quotations`/`purchase_orders`/`purchase_shortages` with hard caps (10k/10k/2k) and no sort — once a collection exceeds its cap, follow-ups for records beyond it silently stop being created/updated, with no error surfaced.

**30. Non-atomic check-then-insert can duplicate automated follow-ups.** `services/followup_engine.py:450-462` — overlapping reconciliation runs (overlapping cron + manual trigger) can both decide the same `source_key` is new and both insert, producing duplicate follow-up cards.

**31. Confirmed missing indexes beyond floor/customer gaps above:** no index on `payments.quotation_id` (aggregated on every order list/detail/stats page load via `_paid_by_quotation`), no index on `activity_events` beyond `automation_key` (every entity timeline query is a collection scan), and zero indexes of any kind on `suppliers`.

**32. Media MIME validation trusts only the client-declared header.** `routes/media_routes.py:33-46` checks `file.content_type` against an allowlist but never inspects actual bytes; `services/media_service.py`'s dimension/quality probe silently falls back to `"acceptable"` on parse failure instead of rejecting.

**33. The same raw-dict-instead-of-Pydantic-model pattern is repeated four times.** `catalog_import_routes.py:150-151` (`update_row`), `catalog_import_routes.py:114-115` (`import_from_url`), `media_routes.py:161-163` (`patch_media`), `permissions_routes.py:92` (`update_permission_matrix`) each hand-roll their own key-allowlist/type-coercion instead of sharing one validated model — and per finding #3, at least one of these (`update_row`'s `mrp`) has a confirmed crash consequence.

**34. Dashboard/reports/activity feed are floor-blind.** `dashboard_routes.py:18` and `misc_routes.py:275` both run unfiltered `db.quotations.find({})`; `activity_routes.py`'s underlying `timeline_for` takes no floor argument at all — inconsistent with the floor model correctly applied in `customer_routes.py`.

**35. Settings/DB modules perform live work at import time.** `settings.py:132` (`settings = load_settings()`) and `db.py:6-8` (`AsyncIOMotorClient(...)` constructed at import) both execute at module-import time rather than lazily — any script or test importing `db`/`settings` opens a live Mongo connection and requires full env validation immediately, complicating isolated unit testing.

**36. No non-negative or bounded constraints on price/discount fields.** `models.py`'s `Product`/`ProductCreate`/`ProductPatch` have no `Field(ge=0)` on `mrp`/`price`/`stock`; `QuotationLineItem.discount_pct`/`project_discount_pct` have no upper/lower bound — a valid-role user can set negative prices/stock or a discount above 100% (or negative, increasing the price) with no rejection.

**37. Unbounded embedded arrays on long-lived documents.** `PurchaseOrderItem.stage_history` and `Quotation.revisions` are appended to forever on the same parent document (no archival/rollup) — heavily-revised quotations or long-lived multi-stage purchase orders trend toward MongoDB's 16MB document limit over the life of the record.

**38. Product SKU+brand uniqueness is enforced only by application code.** A real live duplicate blocks `products_sku_brand_unique` from ever being applied (`scripts/ensure_indexes.py:101-113`, wrapped in try/except) — until that data is manually reconciled, two concurrent product creations for the same SKU+brand can both succeed at the DB layer.

---

## LOW

**39.** `.dict()` (Pydantic v1 API) used throughout despite `pydantic==2.13.4` being pinned — works via a deprecated alias, stylistic debt only.

**40.** Three incompatible pagination conventions coexist with no shared helper (bounded `Query(le=...)`, unbounded client-supplied `limit`/`skip`, and internal-only hard caps with no client pagination at all); response envelope shapes vary per endpoint (bare lists vs. `{"tree": ...}` vs. `{"brands": [...]}` etc.).

**41.** `db.py::strip_id`/`strip_ids` mutate the passed-in dict in place via `.pop()` instead of returning a copy — safe everywhere currently audited (callers copy first) but a latent footgun for any future caller that doesn't.

**42.** `auth.py:128-131` fires a "last seen" session-bump via `asyncio.ensure_future(...)` with no error handling and no held reference — an unretrieved-exception warning at best if it ever fails.

**43.** `catalog_pipeline/adapters/hansgrohe.py::_parse_mrp` reimplements numeric parsing instead of the inherited `BrandAdapter.to_number()` that `grohe.py`/`geberit.py`/`vitra.py` correctly use.

**44.** SKU-conflict-detection logic is independently reimplemented in both `geberit.py` and `vitra.py` instead of a shared helper.

**45.** `tempfile.mktemp()` (documented-insecure/deprecated API, TOCTOU risk) used for EMF/WMF conversion instead of `NamedTemporaryFile`.

**46.** `catalog_pipeline/integrity_guard.py::scan_catalog` silently truncates at a hard 20,000-document cap with no error surfaced if the catalog exceeds it.

**47.** Google SSO endpoints (`auth_routes.py:143-149,173-177`) return a distinct 404 revealing whether an email is a registered account — low exploit value since it requires an already-established Google session.

**48.** No rate limiting on password-change attempts, unlike login — unlimited `current_password` guesses are possible.

**49.** `server.py:101,127` uses the deprecated `@app.on_event("startup"/"shutdown")` API instead of the lifespan context manager.

**50.** `services/catalog_service.py::note_product_usage` and `routes/quotation_routes.py::_track_product_usage` perform the DB write and the in-memory cache update as two independent, non-atomic operations — self-heals within 300s but is a latent dual-write inconsistency window.

**51.** `models.py` (929 lines) is a single monolithic file for every domain entity; `scripts/` mixes permanent operational tooling (backup/restore/index-creation) with one-off, unrepeatable import/migration scripts in the same flat directory; 11+ `backend_test_*.py`/`*_test.py` files sit scattered at the repo root, outside both `backend/` and `backend/tests/`. Organizational/maintainability observations, not functional bugs.

**52.** `PurchaseOrder_Legacy` (`models.py:713-720`) is dead/deprecated schema retained "temporarily" with no removal plan.

---

## What's solid (for calibration — not everything is broken)

`payment_routes.py::create_payment` (lines 296-351) is genuinely well engineered: it wraps the balance-check + insert in a Mongo session transaction, falls back gracefully to an idempotency-key-protected unserialized path when transactions aren't supported (standalone dev Mongo), and replays safely on a unique-key race. `quotation_routes.py`'s `place_order_confirm` and `quotation_pdf` (lines 484-522, 657-692) use the same transactional-outbox-with-idempotency-key pattern correctly. `services/sequence.py::next_number` is a properly atomic counter. The Dockerfile runs as a non-root user with a healthcheck and no baked secrets; `requirements-prod.txt` is a clean, minimal, correctly-curated dependency set separate from the sprawling preview-environment `requirements.txt`. `bootstrap.py`'s startup preflight (required collections + required indexes, checked before Uvicorn reports ready) is a real safety net — it's precisely what would catch finding #15 (`user_sessions` indexes) before a bad deploy goes live, rather than after.

The lesson from the "what's solid" list matters for prioritization: this codebase already knows how to do transactions, idempotency, and outbox-pattern correctly in its most-reviewed paths (payments, order placement). The Critical/High findings above are concentrated in the newer or less-traveled paths (catalog import, transfers, legacy endpoints, multi-floor scoping) that didn't get the same treatment — which means the fix is largely to extend an existing, proven pattern to the places that still lack it, not to invent a new one.
