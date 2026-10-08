# Phase 0 — Trustworthy Baseline · Release Report

**Date:** 2026-08-02
**Spec:** `docs/superpowers/specs/2026-08-02-production-stabilization-sprint-design.md`
**Plan:** `docs/superpowers/plans/2026-08-02-phase-0-trustworthy-baseline.md`
**Evidence:** `docs/superpowers/verification/2026-08-02-phase-0-results.md`
**Range:** `06d5027..7c4d9a3` — 15 commits, local on `main`, **not pushed**

---

## Verdict

**GO for Phase 1.** The baseline is committed and trustworthy. It is *not* a
statement that the product is release-ready — Phase 6 blockers remain open and
are listed below.

---

## What Phase 0 was for

26 files had sat uncommitted since a previous session, claiming six
floor-isolation fixes. The mandate was to distrust those claims, re-verify from
first principles against the live system, fix what failed, and only then commit.

**That distrust was justified.** Of six claims, two were wrong. Four further
defects of the same class were found by looking past the file each claim named.

---

## Claim-by-claim outcome

| Claim | Verdict | Evidence strength |
|---|---|---|
| C-1 follow-up reconciler | **PASS** | Live — 86 closed rows hold a `source_key`; real pass returned 200, no E11000 |
| C-2 activity/notification isolation | **FAILED → fixed** | Live — two bypass paths wrote null floors |
| C-3 walk-in duplicate PII | **PASS**, then **reopened elsewhere → fixed** | Unit test only; zero cross-unit phone collisions exist live |
| H-1 shortage cross-floor mutation | **PASS** | Code; fix existed only in the working tree until `a481b17` |
| H-2 download token floor binding | **PASS** | Live E2E — 200 / `%PDF-` / 74,213 bytes, replay 401 |
| H-3 Ground Floor Quotations nav | **PARTIAL FAIL → fixed** | Live — FAB flipped the active business unit |

### The two failed claims

**C-2 was true about the code it named and false about the system.** `log_event()`
and `notify()` did stamp `floor_id`. But `domain_outbox.py::_upsert_activity` and
`transfer_workflow.py::_upsert_activity` bypassed them entirely and wrote
`floor_id: None`, silently dropping order-placement, PDF-generation,
supplier-assignment and transfer events from *every* unit's activity feed.
Migration `0014`'s backfill had masked it completely by repairing those same rows
from `quotation_id`/`purchase_id`.

> **Lesson worth carrying:** a backfill proves history was repaired, never that
> the forward write path stamps. Always inspect the newest rows, not the
> migration's counts.

**H-3 missed the button its own claim named.** The four nav surfaces were
correctly restricted, but the phone "New Quotation" FAB was ungated and
hard-pushed `/quotations/new`. Pressing it on Ground Floor flipped
`forge.active-floor` to `first-floor` — the exact behaviour the claim said was
fixed.

---

## Defects found beyond the claims

| # | Defect | Severity | Commit |
|---|---|---|---|
| 1 | `transfer_item` resolved its destination customer unscoped → cross-unit **write** via `POST /api/purchases/legacy/items/{id}/transfer` (confirmed live in OpenAPI — "legacy" is naming, not dead code) | High | `2d817b9` |
| 2 | `POST /api/walkins` trusted a **caller-supplied** `floor_id`, validating existence but not access. Cross-unit write, **and** it reopened C-3's PII leak: the 409 response returned name/company/phone/email/city/address for up to 5 other-unit customers | **Critical** | `03a6c0c` |
| 3 | `GET /payments/orders/{id}/whatsapp-reminder` bound the user to `_` and discarded it — leaked customer name, phone, order total, amount paid and outstanding balance across units | High | `680a8c8` |
| 4 | The FAB fix had a hydration race: `selectedFloorId` initialises to `""`, and `"" !== TILES_FLOOR_ID` fell into the Sanitary branch. Multi-floor users tapping before hydration were still flipped | High | `20fc703` |
| 5 | `customer.updated` events were filed under the actor's ambient floor, not the record's — a *positive mis-file* into the wrong unit, worse than a null floor | High | `7c4d9a3` |

Defect 4 is notable: it was a blind spot in this phase's own fix, and per-unit
live testing could not have caught it, because the vulnerable branch is
unreachable for single-floor accounts. It took whole-branch review to find.

---

## Verification

- Backend unit suite: **735 passed, 0 failed, 0 skipped** (713 at phase start; 22 tests added). Every new test confirmed to fail pre-fix.
- `npx tsc --noEmit`: **clean**.
- Floor-isolation probe: **10/10 endpoints isolated**, counts matching the prior report exactly.
- Browser smoke: 12 routes × 2 business units, zero console errors, zero React warnings, zero unhandled rejections, at 375/768/1280px.

### New durable asset

`backend/scripts/probe_floor_isolation.py` — the probe now lives in the repo
rather than a session scratchpad (the previous one was lost, which is why its
results could not be trusted). It mints a real session, hits every scoped
endpoint three ways (no header / Sanitary / Ground), and exits non-zero on leak.

Two false-pass paths were closed in it during review: row counts were printed but
never gated the verdict, and the pinned Tile Orders endpoint checked only one of
three fetched responses. The gate was then **proven to fire** by deliberately
breaking it (9/10, exit 1) before reverting.

Run: `cd backend && FORGE_PROBE_PASSWORD='…' ./.venv/bin/python -m scripts.probe_floor_isolation`

---

## Risks and known limitations

**Open release blockers (unchanged, owner-deferred):**
- `owner@forge.app` still accepts the git-tracked demo password `[legacy password removed; use injected test credentials]`; `/api/health` reports `degraded`. Hard blocker for any real-customer deployment. QA currently depends on it.
- The live database contains test fixtures — all 6 Ground Floor tile orders (`Task18`/`Task19`/`TEST_LC4_*`), 7 more on Sanitary, 118 synthetic activity events referencing ids that resolve to nothing, and a `ZZTEST TILES E2E` follow-up ranked #1 on the Ground Floor dashboard. No delete endpoints exist for these collections.

**Accepted, logged, not fixed:**
- 653 `activity_events` and 1 `notification` have `floor_id` entirely absent rather than explicitly null. Behaviourally identical in Mongo (matches no floor filter, so invisible to all units — not a leak), but it deviates from `0014`'s stated design and would matter to any future `$exists` query.
- Rows written between `0014`'s backfill and `6bb5315` are permanently null-floored. Not backfilled — deliberately a forward-path fix only.
- **Status-code inconsistency, for Phase 1.** `get_floor_scoped_or_404` fetches unscoped, 404s only when a record is genuinely missing, then 403s when it belongs to another unit — an existence oracle. Low practical risk (ids are uuid4, not enumerable), but the transfer fix (`2d817b9`) deliberately returns 404 for the same situation, so the codebase is now internally inconsistent. Resolving it touches every id-addressed endpoint, so it belongs in Phase 1's reviewed pass rather than here.
- `_ENTITY_COLLECTIONS` omits `"tile_customer_order"` in both `domain_outbox.py` and migration `0014`. Harmless today only because that call also passes `quotation_id`, which resolves first.
- Team-administration events (`user.created`, `user.role_changed`, …) now inherit the admin's active floor, while `0014` states they are floor-less by design. Benign, but the live path and the migration no longer agree.
- Ground Floor `/tiles` overflows a 375px viewport — a header button row doesn't wrap, pushing effective layout width to 561px. Phase 5.
- `.superpowers/` was untracked but **not** gitignored; any `git add -A` would have committed scratch. Fixed in `609e175`.

**Carried dependency:** the role × business-unit permission matrix needs staff
credentials for manager / sales / warehouse / worker, or authorisation to create
`ZZTEST`-prefixed accounts. Not yet available.

---

## Phase 3 pre-condition confirmed

The **Purchases** nav item still has no `floors` restriction and is visible on
Ground Floor, at `frontend/app/(admin)/_layout.tsx` in both the sidebar and the
More sheet. Expected and deliberate — Phase 3's work, not a Phase 0 failure.

---

## State

Working tree clean. 15 commits local on `main`, **nothing pushed** — that remains
an owner decision.
