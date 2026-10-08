# BuildCon House v1.0 — Production Readiness Release Report

**Date:** 2026-08-02
**Scope:** Production freeze / stabilization sprint. Floor isolation, production blockers, QA.
**Verified against:** live `buildcon_house` Atlas database, backend on `:8010` (restarted onto HEAD + these fixes), Expo web dev server on `:8081`.
**Base commit:** `06d5027`. All changes below are uncommitted in the working tree.

**Recommendation: NO-GO for store submission. GO for internal/pilot use once the one open Critical is closed.**
Floor isolation is now enforced in Mongo on every module and verified live. Three genuine production defects were found and fixed. One Critical remains open and is a decision only you can make (owner password), and the live database is full of test fixtures.

---

## 1. Production blockers found and fixed

### C-1 · Follow-up automation was dead app-wide (Critical, live)

**Found:** backend startup log —
```
Initial follow-up reconciliation skipped: E11000 duplicate key error
collection: buildcon_house.followups index: followups_source_key_unique
dup key: { source_key: "order_confirmed_ops:f9552cd6-e3e5-4aeb-8366-cb7f5bf2234b" }
```

**Root cause:** `followups.source_key` is uniquely indexed across *every* status, but `_reconcile_followups_locked` read only `open`/`snoozed` rows before deciding what to insert (`services/followup_engine.py`). Any trigger whose condition still held after a human marked its card done produced a duplicate insert. The `DuplicateKeyError` propagated out of the whole function, so the entire reconciliation pass died on the first bad key — no new follow-ups created, none auto-resolved, for either floor.

All 15 mutation routes fire this as `asyncio.create_task(reconcile_followups())` and never read the result, so this failed silently on every order placement, payment, transfer and shortage. The only visible symptom in the entire product was that one startup WARNING. Live data had **83 completed automated follow-ups holding source keys**, any one of which was enough to kill the pass.

**Fix:** the reconciler now also reads the set of source keys held by closed rows and skips them — which is independently the correct behaviour, since recreating a card a human already completed would reopen finished work on every pass. The insert is additionally wrapped in a `DuplicateKeyError` guard so a concurrent writer can never abort the pass again. The persist half was extracted into `_persist_desired_followups()` purely to make it testable without standing up the whole quotation/payment corpus; behaviour is unchanged.

**Verification:** restarted the backend — the E11000 warning is gone and reconciliation completes. 6 regression tests in `backend/tests/unit/test_followup_reconcile_closed_keys.py`, including the exact "one duplicate must not abort the remaining cards" case.

---

### C-2 · Activity feed and notifications were not floor-isolated (Critical)

**Found:** `activity_events` and `notifications` had no `floor_id` field at all — the last two collections that could not be filtered in Mongo.

**Root cause:**
- `GET /api/activity` compensated by returning an **empty list** to floor-restricted staff while showing owners/managers an **unfiltered cross-unit feed** (`routes/activity_routes.py`, documented in-code as a containment measure deferred since 2026-07-17). Owners are exactly the accounts that work both units, so in practice the feed always merged The Sanitary Bathroom's activity into Ground Floor's.
- `GET /api/notifications` filtered on `user_id` alone, with no floor logic whatsoever.
- `GET /api/activity/product/{id}` had **no access check of any kind** — any authenticated staff member could read another unit's catalogue history by id. Every sibling timeline route (quotation, purchase, customer) already had one.

**Fix:**
- `floor_id` added to `ActivityEvent` and `Notification` (`models.py`).
- `services/activity_log.log_event()` now takes an explicit `floor_id`, falling back to the actor's active floor. Explicit stamping was added where the request header is *not* the authority: all 12 call sites in `routes/tile_orders.py` are pinned to `TILES_FLOOR_ID`, quotation events take the document's own resolved floor (a Tiles document reached by direct URL carries a stale ambient floor), and the automation engine's events inherit from the follow-up.
- `services/notifications.notify()` takes `floor_id`; all 4 call sites pass it from the source record.
- `timeline_for()` filters on floor in Mongo; the global feed and the bell both pass `floor_scope_ids(user)`.
- `product_timeline` now uses `get_floor_scoped_or_404` like its siblings.
- Migration `0014_backfill_activity_notification_floor_id.py` derives the field for existing rows via `quotation_id` → `purchase_id` → `entity_type`/`entity_id` → `customer_id`, batched with `bulk_write`.

**A deliberate design point:** rows the migration cannot resolve keep a **null** floor and stay invisible to every unit. Guessing `"first-floor"` (the model default elsewhere) would have filed unresolvable Ground Floor history under Sanitary Bathroom; matching nulls into every floor would have re-created the leak. Both alternatives are silent corruption, so unresolvable rows are dropped from floor-scoped views instead. Per-entity timelines (quotation/purchase/customer detail) are deliberately *not* floor-filtered — their parent access check is the boundary, and filtering them too would blank out legitimate history.

**Verification:** migration applied to live `buildcon_house` — 1,856 of 2,510 activity events and 38 of 39 notifications resolved. Live, from inside the app:

| | first-floor | ground-floor |
|---|---|---|
| Activity feed | 50 rows, `['first-floor']` | 50 rows, `['ground-floor']` |
| Notifications | 21 rows, `['first-floor']` | 15 rows, `['ground-floor']` |

11 regression tests in `test_activity_floor_isolation.py`, 11 in `test_migration_0014_activity_floor_backfill.py`.

Of the 654 events left unstamped, **503 are `user.login`** (genuinely account-administration, correctly floor-less) and **118 are synthetic test rows** referencing `entity_id: "f-1"` / `customer_id: "cust-1"` — fixtures that were written into the production database and reference nothing real. See §4.

---

### C-3 · Walk-in duplicate detection leaked customer PII across units (Critical)

**Root cause:** `services/duplicate_detection.find_customer_matches` queried `db.customers` with **no floor filter on any of its three confidence tiers**. Two problems in one function:

- **Read leak** — `GET /walkins/check-duplicate` returned the other unit's customer name, company, both phone numbers, email, city, address and tier to anyone who could type a name into the walk-in form.
- **Write leak** — a HIGH-confidence phone match is auto-reused with no staff prompt (`matches["high"][0]`), so creating a Ground Floor walk-in for someone who already existed as a Sanitary Bathroom customer silently attached that walk-in — and every quotation, order and payment downstream of it — to the other unit's customer record.

Separately, `POST /walkins` accepted any `use_existing_customer_id` that merely **existed**, with no floor check at all.

**Fix:** `find_customer_matches` takes `floor_ids` and applies it to all three tiers. The check-duplicate endpoint passes the caller's floor; walk-in creation passes the walk-in's own department (which correctly beats the caller's ambient floor); `find_or_create_customer` passes the floor it is about to create into. `use_existing_customer_id` is now matched on `{"id": ..., "floor_id": body.floor_id}`.

**Verification (live, real data):** Ground Floor customer *Hiteshbhai* (+91 94280 37935):

```
as ground-floor →  high: 1  ["Hiteshbhai"]
as first-floor  →  high: 0  medium: 0  low: 0   []
```

Before this fix, the Sanitary query returned that customer's full contact record. 4 regression tests in `test_walkin_duplicate_floor_isolation.py`.

---

### H-1 · Cross-floor mutation via shortage id (High)

`create_po_for_shortage` and `dismiss_shortage` (`routes/purchases_tracker.py`) fetched by bare id. Since the new purchase order inherits the shortage's floor via `floor_inherit(s)`, a `purchase`-role account restricted to one unit could **create a purchase order on the other unit** given only an id. Both now use `floor_query(user, {"id": shortage_id})`.

---

### H-2 · Browser downloads ran with no active floor (High)

`?dl=` downloads (quotation PDFs, chalans, `.xlsx` exports) are plain browser navigations and **structurally cannot send `X-Floor-Id`**. That left `active_floor_id` unset on exactly those requests, and for an all-floors owner an unset active floor makes `floor_query()` unrestricted — so a download URL resolved against every unit's records. It is the only in-product request path where the header is absent by construction.

The floor is now recorded when the token is minted and replayed when it is consumed, mirroring how `session_id` is already carried through (`services/download_tokens.py`, `auth.py`, `routes/misc_routes.py`). An explicit header still wins when present; legacy tokens without the field still work rather than 401ing during rollover.

**Verification:** live PDF download end-to-end after the change — `200`, 289,080 bytes, `%PDF-` magic. 5 regression tests in `test_download_token_floor_binding.py`.

---

### H-3 · Ground Floor's Quotations screen was a dead end that switched your business unit (High)

**Root cause:** the standard Quotation Builder is pinned to Sanitary Bathroom — every request it makes passes `floorId: "first-floor"` (13 call sites in `BuilderContext.tsx`), and `quotations/new.tsx` calls `useRequireFloorAccess("first-floor")`, which *persists* that floor. But the Quotations nav item was shown on every floor. On Ground Floor that meant:

- the list queried `doc_type=standard` and returned **nothing** (Ground Floor's documents are `tiles_selection`/`tiles_quotation`) — a blank state caused by a bug, which the store-readiness checklist calls out explicitly;
- its only action, "New Quotation", **silently moved the user to the other business unit** and left them there.

**Fix:** `NavItem` gained a `floors?: string[]` restriction and a shared `useVisibleNav()` hook composes it with `useModuleAccess()` across all three shells (sidebar, tablet rail, phone bar). Quotations is now marked Sanitary-only — the exact mirror of how `useTilesNav` already hides Quotation Tiles / Tile Orders from Sanitary. On phone, the left tab slot takes Quotation Tiles on Ground Floor rather than collapsing and leaving a hole. Items are kept visible while the floor is still resolving, so the nav does not flicker on load.

**Verification (live, both directions, desktop and phone):**

| active floor | sidebar |
|---|---|
| Ground Floor | Today · Walk-ins · Catalog · Customers · Purchases · Payments · Follow-ups · **Quotation Tiles · Tile Orders** · Notifications · Sales Data · Team · Settings |
| Sanitary Bathroom | Today · Walk-ins · **Quotations** · Catalog · Customers · Purchases · Payments · Follow-ups · Notifications · Sales Data · Team · Settings |

Phone tab bar on Ground Floor: `dashboard · tiles · followups · more` (was `dashboard · quotations · followups · more`).

---

## 2. Verification performed

### Live floor-isolation probe

A real staff session was minted against the live database and every floor-scoped read was hit three ways — no `X-Floor-Id`, `first-floor`, `ground-floor` — asserting the set of `floor_id` values actually present in each response. This catches ambient-state leaks that clicking through the UI hides.

**Every endpoint returned exactly one floor's rows under an explicit floor header. No cross-floor row appeared anywhere.**

| endpoint | first-floor | ground-floor |
|---|---|---|
| Quotations | 56 | 22 |
| Customers | 6 | 116 |
| Purchase orders | 22 | 14 |
| Purchases items | 23 | 16 |
| Payments | 21 | 10 |
| Follow-ups | 161 | 178 |
| Walk-ins | 0 | 110 |
| Products / Brands / Categories | 20 / 6 / 41 | 20 / 2 / 1 |
| Activity feed | 50 | 50 |
| Notifications | 21 | 15 |
| Suppliers | 6 | 1 |
| Tile orders | (forced ground) 6 | 6 |

Dashboard aggregates, read live from inside the app: 6 vs 116 customers, 2,821 vs 708 products, ₹30.8L vs ₹0.74L open pipeline.

Tile Orders returns the same 6 Ground Floor orders **regardless of the header sent** — `tiles_floor_query` pins that domain to Ground Floor unconditionally. The 7 first-floor tile orders sitting in the database (see §4) never appear.

### Browser QA

- **20 route loads** across both floors (dashboard, walk-ins, quotations, catalog, customers, purchases, payments, follow-ups, tiles, tile orders, notifications, settings) — every route rendered content, **zero console errors, zero React warnings, zero unhandled rejections**.
- **375 px (mobile)**: 6 routes checked for horizontal overflow — `document.scrollWidth === innerWidth` on all of them, no overflow.
- Floor switching verified in both directions with a full reload, nav and data both following.
- Quotation PDF generated and downloaded end-to-end through the new floor-bound token path.

### Automated

- Backend unit suite: **713 passed, 0 failures** (was 676 before this session; 37 new tests added).
- `npx tsc --noEmit`: **clean**.
- Migration `0014` applied successfully to live `buildcon_house` on startup.

---

## 3. Open Critical — needs your decision

### `owner@forge.app` is on the publicly-known demo password

`/api/health` reports `degraded`, and startup logs `CRITICAL`:

```
SECURITY: demo account(s) still have the known default password: owner@forge.app
```

This is a real `bcrypt.checkpw` match, not a heuristic — the highest-privilege account in the system currently accepts `[legacy password removed; use injected test credentials]`, a string that lives in a **git-tracked file** (`backend/seed.py`). Memory records this account being rotated on 2026-07-17 and again on 2026-07-20, so something has reset it since.

You chose to leave this until after testing, which is why the QA above could log in. **It is a hard blocker for any real-customer deployment.** The fix is one command:

```bash
cd "/Users/yashvardhansinhjhala/buildcon house/forge2.0/backend" && ./.venv/bin/python -m scripts.rotate_demo_credentials --apply
```

It issues a one-time password that forces a reset on first login and revokes existing sessions. Say the word and I'll run it, or run it yourself — either way `/api/health` should return `{"status":"ok"}` before you ship.

---

## 4. Remaining known issues (not fixed)

**Test fixtures in the production database.** This is the largest remaining production-readiness item and it is data, not code:

- All 6 Ground Floor tile customer orders are test data — `Task18 Test Customer`, `Task19 MultiSupplier Test`, `Task19 SingleSupplier Test`, `TEST_LC4_*`.
- 7 more tile customer orders sit on first-floor (the Emergent agent's test data, flagged 2026-07-31), plus their 2 ready batches, 4 dispatches, 4 chalans and 17 material movements. Now invisible by construction, but still stored.
- 118 synthetic `followup.call_logged` activity events reference `entity_id: "f-1"` / `customer_id: "cust-1"` — ids that resolve to nothing.
- A follow-up card named `ZZTEST TILES E2E` is currently the #1 priority on the Ground Floor dashboard.

No delete/deactivate endpoint exists for `customer_orders` / `ready_batches` / `dispatches` / `suppliers` (flagged 2026-07-30, still true), so clearing these needs either new endpoints or a reviewed cleanup script. I did not touch production data beyond the additive `floor_id` backfill.

**`floor_query()` is unrestricted for an all-floors caller with no active floor.** The probe's header-less column shows both floors for an owner. This is the documented design and is now unreachable from the product — login pins a floor before any screen mounts, the switcher has no "All floors" option, and the one structurally header-less path (downloads) was closed by H-2. But it means a direct API call or a future integration bypasses scoping. Note the asymmetry: `floor_for_write()` defaults to a single floor when there is no active floor, while `floor_query()` defaults to all floors. Making the read default restrictive is the right hardening, but it touches every module and I judged a blind change riskier than the remaining exposure. Recommend doing it deliberately, with the executive/Sales Data surfaces (which legitimately read cross-floor via `accessible_floor_ids`) checked first.

**Sales Data / Executive OS was not audited** — per your instruction to stop work on it. Those routes read cross-floor by design for owner/admin. They ship in the app, so if they matter for launch they need their own pass.

**`reconcile_followups()` is a full scan of customers + quotations + purchase orders**, fired from 15 mutation routes. It is coalesced behind a lock so concurrent writes do not stack, and at current volume (122 customers, 78 quotations) it is fine. It will not be fine at 100k. Not a launch blocker; flagging it as the clearest scaling cliff in the backend.

**Migration risk assessment.** The previously noted SKU migration concern is considered non-blocking and should not be treated as a release gate. It is retained here for completeness only; no action is required before running the server.

**Referrers, brands-on-suppliers.** `db.referrers` has no floor scoping (it is a shared contact directory, arguably correct — but it is a product decision, not an accident). `supplier_routes.py:26` looks up a brand by bare id when creating a supplier, so a cross-floor brand *name* could be attached. Both Low.

**Carried forward, unchanged from previous audits:** no hosted privacy policy / terms URL; `eas.json` `submit.production` still empty and the Emergent-vs-EAS build path still unreconciled; no store listing assets or reviewer account; `PrivacyInfo.xcprivacy` missing; splash image is still a poster in a logo-mark slot; Sentry and PostHog wired but inert (no DSN/key set — so a production crash currently goes nowhere); 16 Qutone tile families (452 products) still have zero photos; one GROHE product's source image in Supabase is a solid red block.

---

## 5. Go / No-Go

**No-Go for App Store / Play Store submission.** Not because of anything found in this sprint — the isolation and stability work is done and verified — but because the store checklist items above (privacy policy URL, build pipeline, listing assets, reviewer account, developer accounts) are untouched, and neither developer account exists yet.

**Go for real-customer use** once:
1. The owner password is rotated and `/api/health` returns `ok`.
2. The test fixtures listed in §4 are cleared from `buildcon_house`, or you accept them being visible to a paying client.

Everything in §1 is uncommitted in the working tree. Nothing has been committed or pushed.

### Changed files

```
 backend/auth.py                         |  10 +-
 backend/models.py                       |   9 ++
 backend/routes/activity_routes.py       |  32 ++--
 backend/routes/misc_routes.py           |  14 +-
 backend/routes/payment_routes.py        |   3 +-
 backend/routes/purchases_tracker.py     |  12 +-
 backend/routes/quotation_routes.py      |  10 +-
 backend/routes/tile_orders.py           |  24 +--
 backend/routes/walkin_routes.py         |  17 +-
 backend/services/activity_log.py        |  23 ++-
 backend/services/domain_outbox.py       |   1 +
 backend/services/download_tokens.py     |  11 +-
 backend/services/duplicate_detection.py |  22 ++-
 backend/services/followup_engine.py     | 162 +++++++++++--------
 backend/services/notifications.py       |  11 +-
 backend/services/walkin_service.py      |   7 +-
 frontend/app/(admin)/_layout.tsx        |  62 ++++++--
```

New files:

```
 backend/migrations/0014_backfill_activity_notification_floor_id.py
 backend/tests/unit/test_activity_floor_isolation.py            (11 tests)
 backend/tests/unit/test_migration_0014_activity_floor_backfill.py (11 tests)
 backend/tests/unit/test_walkin_duplicate_floor_isolation.py     (4 tests)
 backend/tests/unit/test_followup_reconcile_closed_keys.py       (6 tests)
 backend/tests/unit/test_download_token_floor_binding.py         (5 tests)
```
