# AGENTS.md — BuildCon House ERP (forge2.0)

Guidance for any AI agent (Emergent, Claude Code, or otherwise) picking up work in this repo. Read this before re-deriving context from scratch — it's meant to save tokens, not replace judgment.

## Current verification update — 2026-10-06

Follow-up: the compatible lockfile update to `shell-quote` 1.12.0 addresses
newly indexed critical advisory GHSA-pqg4-j6r4-53mv; its attack regression
test is required in frontend CI. This does not waive other npm findings.
SDK 55/56/57 experiments remain isolated until their full application checks
pass. Historical media ownership review found nine candidates: eight have
wrong finishes/product forms and one lacks verified import-row provenance.
See `docs/audits/2026-10-06-historical-media-ownership-review.json`; no photo
was assigned from those unsafe associations.

The July notes below are historical. The current active catalog has 6,565
products across Sanitary Bathroom and Ground Floor; Ground Floor is no longer
an empty future-data workspace. The read-only backend predeploy gate now
passes Mongo access, required indexes and Supabase access, and the migration
dry-run reports no pending migrations. The historical migration `0006`
restart blocker below was resolved; repeat the current read-only gates before
future backend promotion rather than treating the old warning as current.

The latest repair pass uses shared Inter Text/TextInput defaults and Feather
icons, synchronizes Payments document floors before navigation, preserves
zero-stock history and rejects stale floor callbacks. Its full backend unit
suite passes 1,573 tests. Frontend functional CI and security auditing are
independent jobs; the fresh 6 October scan has 32 npm findings (23 high/nine moderate) still block the
security job. Do not suppress those findings or claim overall CI is green.
Physical devices, signed builds and legal/operator acceptance remain open.

See `docs/audits/2026-10-05-goal-release.md` for current evidence, image recovery
manifests, deployment results and operational acceptance limits. Backup data
and credentials must stay excluded from Git, public artifacts and Docker
contexts. Run unit tests with hermetic CI environment variables, never live
production settings; restore drills must use an isolated empty database with
no application or workers connected.

## What this project is

FastAPI + MongoDB Atlas (cloud, not local) + Supabase (file storage) backend, Expo/React Native Web frontend (Expo Router). A multi-floor ERP for a bathroom-fittings + tiles distributor: `first-floor` (display name "The Sanitary Bathroom") holds the existing ~2,600-product sanitaryware catalog and all real business data today; `ground-floor` is the new tile section (schema/isolation work in progress, no real tile data yet); `second-floor` also exists as a floor entity but is otherwise unused so far.

- Live Atlas DB: `buildcon_house` (not `buildcon`, a stale demo DB on the same cluster).
- Supabase buckets: `forge-products` (public), `forge-private`.
- Local dev: `backend/.venv` (Python 3.14), `backend/.env` / `frontend/.env` hold real credentials (gitignored, not committed — verified clean).
- Backend commonly runs on port 8010 (`uvicorn server:app --port 8010`) since something else occupies 8000 on the primary dev Mac.

## Important — this repo has concurrent editors

**This repo is being worked on by more than one agent/process at once.** As of 2026-07-18 there were ~99–106 files sitting uncommitted in the working tree from a separate, non-Claude-Code process (git log shows a long history of `auto-commit for <uuid>` entries — almost certainly an Emergent-platform agent working the same codebase in parallel). That work is legitimate and already includes real, wanted fixes (e.g. a session-security hardening pass in `auth.py`, an optimistic-concurrency rewrite of `_apply_stage_change` in `purchases_tracker.py`, and a role-permission fix lowering `move_item`/`bulk_move`/`transfer_item*` from `require_min_role("sales")` to `"warehouse"`).

**If you are about to commit and a file you're touching has other unrelated uncommitted changes in it: do not sweep them into your commit.** `git add <file>` stages the whole file, not just your diff — use `git add -p` and select only your own hunks, so each commit accurately describes its own contents and the other process's in-progress work isn't silently relabeled or buried under an unrelated commit message. This was a real mistake made and then corrected during the floor-isolation-fix work below — see that section for the concrete example.

**Update (2026-07-18):** all ~99 files of that backlog have now been committed as `96ffda2` ("chore: commit accumulated prior-session work..."), since Task 1's isolated commit turned out to depend on foundational `auth.py` helpers (`floor_query`/`floor_for_write`/`accessible_floor_ids`) that were themselves part of that uncommitted backlog — every prior session's work had been sitting uncommitted, at real risk of loss, this whole time. Going forward, the working tree should stay much closer to git history; if you find a large uncommitted backlog again, treat it the same way (commit it honestly labeled as pre-existing work, don't silently absorb it into an unrelated task commit).

## Current effort: floor-isolation fix + tile-ready catalog schema

**Root cause (confirmed 2026-07-17 by direct query against the live Atlas DB, not assumption):** every real record in the database — all 2,601 products, 69 follow-ups, 13 purchase orders, 12 payments, 5 customers, 41 quotations, 5 suppliers — was tagged `floor_id="first-floor"`, and switching the UI to Ground floor showed that same first-floor data instead of an empty state, because a specific, mechanically-identifiable set of backend read *and* write paths never applied floor scoping at all. Full root-cause writeup, the complete list of every affected code site, and exact before/after code for every fix are in:

**`docs/superpowers/specs/2026-07-17-floor-isolation-and-tile-catalog-design.md`** (design/spec — read this for *why*)
**`docs/superpowers/plans/2026-07-17-floor-isolation-fix.md`** (implementation plan — read this for *exact code*, task-by-task, TDD-style)

Do not re-derive the root cause or re-scan the codebase for affected endpoints — both are already fully enumerated in those two files. If you need to know "is X in scope," check the plan's 20 task headers first.

**Status as of 2026-07-18: all 20 planned tasks complete, plus a final holistic review (see below), plus 2 additional gaps that review found — everything reviewed (spec compliance + code quality, two-stage per task) and pushed to `origin/main` at commit `f86a43e`.** One live operational blocker remains before the app can be safely restarted against production — see "⚠️ Migration `0006`" below — and two small follow-up tasks were spawned separately (not blocking, not started; see "Spawned follow-ups" at the end of this file).

**Final holistic review** (after all 20 tasks landed): traced 3 end-to-end user scenarios through the actual HEAD code (floor switch → Purchases Tracker; quotation → auto-PO → customer transfer; follow-ups tab), confirmed `floor_id` is correctly read/written/scoped at every hop with no gap in any detailed-record path. Did an independent fresh sweep of all `count_documents`/`aggregate` calls across `routes/`/`services/` (not just trusting the plan's own enumeration) and found 2 real gaps of the same bug class — both count/badge-level leaks, not detailed-record leaks: `dashboard_routes.py`'s product-count KPI and `followup_routes.py`'s per-rule badge counts were still global (the first had a stale "not scoped yet" comment left over from before Catalog was floor-scoped; the second predated the `user`-threading convention). Both fixed, tested, reviewed, and pushed (`f86a43e`). A second, independent sweep after that fix confirmed no third gap of the same shape remains on any staff-facing endpoint. Full backend test suite: 90 passed.

### Established pattern (use this, don't invent a new one)

- `floor_query(user, base)` — Mongo filter dict, for queries that take a filter (`db.collection.find(floor_query(user, {...}))`).
- `floor_for_write(user)` — single floor_id string, for **human-initiated** creates (`Quotation(..., floor_id=floor_for_write(user))`).
- `floor_scope_ids(user)` — plain `Optional[list[str]]`, for code that builds its own aggregation pipeline or in-memory filter instead of taking a Mongo filter dict (added in Task 1 of the plan above).
- **Automation/event-handler-created records** (background workflows with no live user, e.g. `domain_outbox.py`, `transfer_workflow.py`, `followup_engine.py`) inherit `floor_id` from their immediate **source document** instead — never `floor_for_write()` — since these handlers often only have an actor id/name string, and a record derived from a ground-floor source must stay ground-floor regardless of which floor the triggering user happens to have selected. Use `floor_inherit(source)` from `auth.py` for this (added alongside `floor_query`/`floor_for_write`/`floor_scope_ids` — this consolidates what used to be four duplicated per-file helpers; don't reintroduce a fifth local copy).

All four live in `backend/auth.py` (the first three) or as small local helpers next to their one caller (the fourth kind) — don't scatter re-implementations of the same logic across files.

### Task status (20 tasks total, 3 milestones)

Update this table as work lands. Commit SHAs below are on `main` (this repo commits directly to main — no feature-branch convention here).

| # | Task | Status | Commit(s) |
|---|------|--------|-----------|
| 1 | Purchases Tracker main board (`_iter_items` + `GET /items`) + `floor_scope_ids` in `auth.py` | **Done** (spec + code-quality review both passed) | `4ffad24` |
| 2 | Purchases Tracker facet endpoints (`/stages`, `/brands`, `/customers`) | **Done** (spec + code-quality review both passed) | `a1d0174` |
| 3 | Purchases Tracker remaining read endpoints (`customer_workspace`, `dispatch_record`, `list_shortages`, `export_xlsx`, `get_item`, `item_transfer_history`) | **Done** (spec + code-quality review both passed; 2 minor style-consistency notes left as optional follow-up, see review) | `bfdeb65` |
| 4 | Follow-ups `/insights` | **Done** (spec + code-quality review both passed) | `781a65b` |
| 5 | Reports overview | **Done** (spec + code-quality review both passed) | `da9e240` |
| 6 | Dashboard `followups_due` counter | **Done** (spec + code-quality review both passed) — **Milestone A (read-path scoping) fully complete** | `00b70fd` |
| 7 | `domain_outbox.py::_handle_order_placed` (PO + Payment floor inheritance) | **Done** (spec + code-quality review both passed) | `bfff087` |
| 8 | `domain_outbox.py::_upsert_followup` | **Done** (spec + code-quality review both passed) | `5e69494` |
| 9 | `followup_engine.py` rule-based auto-follow-up engine | **Done** (spec + code-quality review both passed) | `981d13d` |
| 10 | `transfer_workflow.py::execute_transfer` | **Done** (spec + code-quality review both passed) | `379a8ff` |
| 11 | `transfer_workflow.py::handle_purchase_transferred` | **Done** (spec passed; code-quality found a real issue — first test was a no-op, fixed by reusing `_transfer_floor_id`, re-reviewed and approved) | `c07be25`, `3dbca7b` |
| 12 | Legacy inline transfer/reorder code in `purchases_tracker.py` | **Done** (spec + code-quality review both passed; reviewer flagged cross-file helper duplication as a non-blocking follow-up — see below) | `5c25ca5` |
| 13 | Follow-up call-back rescheduling (`POST /{id}/log-call`) | **Done** (spec + code-quality review both passed) — **Milestone B (write-path floor inheritance) fully complete** | `24c87af` |

**Bonus cleanup (not one of the 20 plan tasks):** Task 12's reviewer flagged that `_transfer_floor_id` (transfer_workflow.py), `_source_floor_id` (purchases_tracker.py), `_followup_floor_id` (followup_engine.py), and three inline copies in `domain_outbox.py` were all near-identical reimplementations of "inherit floor_id from source, default to first-floor." A separate session consolidated these into one `auth.floor_inherit(source)` helper alongside `floor_query`/`floor_for_write`/`floor_scope_ids`. Pure refactor, no behavior change, full suite passes (74/74). Commit `b5ecee4`.
| 14 | `Brand`/`Category` gain `floor_id` + backfill migration `0004` | **Done** (spec + code-quality review both passed) | `b4a0f79` |
| 15 | Floor-scope the in-memory catalog engine (`catalog_service.py`) | **Done** (spec passed; code-quality found brand/category product-counts could leak across floors if the "no brand spans two floors" invariant were ever violated — fixed by scoping the Counter too, re-reviewed and approved) | `1a1a787`, `7fab437` |
| 16 | Thread floor scope through Catalog routes; fix product-creation floor default | **Done** (spec + code-quality review both passed) | `febe99f` |
| 17 | `POST /brands`, `POST /categories` | **Done** (spec passed; code-quality found `categories.slug` had no unique index — unlike `brands.slug` — leaving a real check-then-act race, and no test existed for `create_category`; both fixed, re-reviewed and approved) | `1042ed4`, `ab225ca` |
| 18 | `size` field on `Product` + search/facets | **Done** (spec passed; code-quality found `size` wasn't wired into `search_catalog`'s scoring or `hydrate_variants_batch`'s sibling-variant hydration — the second one would have silently broken Task 20 — both fixed, re-reviewed and approved) | `a2662ab`, `047694e` |
| 19 | SKU uniqueness migration `0006` (per floor+brand, **renumbered from 0005** — Task 17's categories.slug index fix took `0005` first) | **Code written, tested, spec + code-quality reviewed and approved. Pushed to origin (CI has no deploy step and uses an isolated test DB, so this is safe) — but the migration itself must not reach a real deployment/restart until the live duplicate SKU is resolved.** See "⚠️ Task 19 is holding" below. | `4ab1b5a`, `658a92f` |
| 20 | Frontend `variantDescriptor()` helper + `PickerCard`/`VariantChip`/`SwapSheet`/`ProductModal` display fix | **Done** (spec + code-quality review both passed; reviewer hand-traced all edge cases by hand since this repo has no frontend test runner) — **all 20 tasks complete** | `e889686` |

### ⚠️ Migration `0006` is a live landmine until the duplicate SKU is resolved — read this before restarting any backend process against the real database

**Current verification — 2026-10-05:** A read-only audit of live Atlas `buildcon_house` found zero duplicate `(floor_id, brand_id, sku)` groups, no pending numbered migrations, and the unique `products_floor_brand_sku_unique` index present. The historical blocker below is resolved. Current production startup does not auto-apply migrations by default; pending migrations fail readiness and require the controlled job in `backend/OPERATOR_CHECKLIST.md`. This verification made no database changes. The historical account below is retained for context; always repeat the read-only preflight before a new deployment.

Directly queried the live Atlas database (2026-07-18) and confirmed the known duplicate SKU is still real and unresolved: SKU `26456000` under brand `9b72519c-bfb4-4576-9e79-e85072ab4216` (Hansgrohe), two product documents (`639c8d2e-95e6-406b-a117-f18155b9519d` and `811a1b0f-1b20-401b-9f36-e8134b63bbf2`), both `floor_id="first-floor"`.

A code-quality reviewer traced what actually happens if migration `0006` (`backend/migrations/0006_products_sku_unique_per_floor_brand.py`) reaches a deployment before that duplicate is resolved: `backend/migrations/runner.py` auto-applies every pending migration at **every backend startup** (`server.py`'s startup event calls `run_migrations(db)` with no surrounding `try/except`, unlike the reconciliation call right below it), and there is no per-migration error handling in the runner either. So this isn't "don't run `scripts/run_migrations.py` manually" — merely having this file present in `backend/migrations/` on a process pointed at the live DB means the **next process restart** hits an uncaught `DuplicateKeyError`, which aborts FastAPI startup entirely. Since the migration never gets recorded as applied on failure, this repeats on every subsequent restart — a boot crash loop, not a one-time error.

**The migration code itself is correct, fully tested (unit tests use only a fake in-memory db, no live connection), and both reviews passed — it has been committed AND pushed to `origin/main`** (commits `4ab1b5a`, `658a92f`). This is safe: CI (`.github/workflows/ci.yml`) has no deploy step and runs unit tests against an isolated `MONGO_URL=mongodb://localhost:27017` / `DB_NAME=forge_ci_unit_tests`, never the real Atlas cluster — confirmed by reading the workflow file directly. The risk is NOT "this is on GitHub" — it's specifically **restarting any real backend process (local dev `uvicorn`, or an actual deployed instance) that connects to the live `buildcon_house` database** while this duplicate still exists. Do not restart the backend against the live database until:
1. The live duplicate is resolved: rename one of the two SKUs, or merge the two Hansgrohe products (`639c8d2e...` / `811a1b0f...`). This is a data decision for a human — the migration deliberately does not attempt to auto-resolve it.
2. Re-run the read-only check below to confirm zero duplicates remain:
   ```bash
   cd backend && .venv/bin/python -c "
   import asyncio
   from db import db
   async def main():
       dupes = await db.products.aggregate([
           {'\$group': {'_id': {'brand_id': '\$brand_id', 'sku': '\$sku'}, 'ids': {'\$push': '\$id'}, 'n': {'\$sum': 1}}},
           {'\$match': {'n': {'\$gt': 1}}},
       ]).to_list(50)
       print(dupes)
   asyncio.run(main())
   "
   ```
3. Only then restart/deploy the backend against the live database — the code is already committed and pushed, there's nothing further to push at that point.

See "Spawned follow-ups" near the end of this file for the two related background tasks (not blocking, not started).

**Explicitly out of scope for this plan** (decided with the user, don't re-litigate): no new MongoDB/Supabase infrastructure (already cloud-hosted, confirmed via `backend/.env`'s real Atlas `mongodb+srv://` URL); no tile product data import (schema/isolation only — data entry is separate, later work); no Cmd+K quick-search brand-scoping (confirmed not needed — Catalog page + Quotation Builder search, both fixed here, are what matter); no `LineRow`/`Line`-type/`QuotationLineItem` changes for `size` (LineRow only shows a colour swatch, not a text fallback chain — not affected by the bug this plan fixes).

### Spawned follow-ups (not blocking, not started as of 2026-07-18)

Both were flagged during code review of Task 17/19 as real gaps of the same shape as this whole plan, but explicitly out of each task's own scope — background task chips exist for a human to start with one click:

1. **`bootstrap.py` doesn't verify `brands`/`categories` indexes at startup.** `REQUIRED_INDEXES` checks `products`/`users`/`quotations`/`purchase_orders`/`customers`/`payments`/`suppliers`/`activity_events` but not `brands.slug`/`categories.slug` — so there's no automated guarantee those unique indexes (created by migrations `0004`... actually by `scripts/ensure_indexes.py` for brands, and migration `0005` for categories) actually exist in a live deployment.
2. **`catalog_routes.py`'s SKU duplicate-checks are still global.** `create_product`/`create_custom_product`/`update_product` all do `db.products.find_one({"sku": sku})` with no `floor_id`/`brand_id` scoping — so even once migration `0006` is safely deployed (relaxing the DB-level constraint to per-floor-per-brand), the API's own pre-check would still reject a legitimate cross-floor SKU reuse before it ever reaches the database. This is the one that actually matters for the tile catalog to work as intended once real data arrives — prioritize this one if only starting one of the two.

### If more floor-isolation work comes up later

1. Follow the same TDD pattern used throughout this plan (see any task in `docs/superpowers/plans/2026-07-17-floor-isolation-fix.md` for the shape: failing test → minimal `floor_query`/`floor_scope_ids`/`floor_inherit` fix → passing test → isolated commit).
2. Run backend tests from `backend/` using `.venv/bin/pytest tests/unit -q` (existing venv, don't create a new one). Current baseline as of 2026-07-18 is **90 passed, 0 failed** — any new failures are yours to explain, not pre-existing.
3. Before committing, run `git status --short` on the specific files you touched. If any of them show unrelated pre-existing changes beyond your own diff, use `git add -p` and select only your hunks (see "Important — this repo has concurrent editors" above). Don't skip this — it's the difference between a reviewable commit and a misleading one.
4. This repo pushes to `origin` (`https://github.com/yashvardhansinh2510-max/forge2.0.git`) on branch `main`. Confirm with the user before pushing if you're unsure whether local commits are ready — and see the migration `0006` warning above before ever restarting a backend process against the live database.

### Known gotchas (don't rediscover these the hard way)

- **Migration idempotency:** `backend/migrations/` migrations must be forward-only and safe to run twice, but MongoDB's `create_index` throws `OperationFailure` code 85 (`IndexOptionsConflict`) if a same-key index already exists under a different name — this has happened twice already (see `migrations/0002` and `0003`'s docstrings). Always wrap `create_index` calls the way `migrations/0003`'s `_create_index_tolerant` helper does.
- **Catalog is an in-memory snapshot, not per-request Mongo queries:** `backend/services/catalog_service.py` loads the whole product catalog into memory at startup (Atlas is ~228ms round-trip away; the full catalog is a few MB) and refreshes on writes. Don't add per-request Mongo queries to catalog read paths — thread new filters through the existing `_matches_filters`/snapshot functions instead.
- **Floor `first-floor`'s display name is "The Sanitary Bathroom"** in the live `db.floors` collection, but its `id`/`slug` is still literally `"first-floor"` — don't rename the slug, only ever the `name` field, or every `floor_id` reference throughout the codebase breaks.
