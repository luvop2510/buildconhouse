# Phase 0 Re-verification Results — 2026-08-02

Full regression and evidence record for Task 6, immediately preceding the Phase 0 baseline commit (Task 7). This document records what re-verification actually found, not what the original `RELEASE_REPORT_2026-08-02.md` claimed. Where a claim was proven only by reading code, that is stated explicitly — code inspection is weaker evidence than a live-reproduced result, and this distinction is the point of this document.

Business unit ids: Sanitary Bathroom = `first-floor`, Ground Floor (Tiles) = `ground-floor`.

---

## 1. Backend suite

```
cd backend && ./.venv/bin/python -m pytest tests/unit -q
```

**Observed: 724 passed, 0 failed, 234 warnings, 3.71s.**

The brief's originally-quoted expectation (713) is stale — three fixes landed after that number was written, each adding tests:

| Commit | Change | Tests added |
|---|---|---|
| `6bb5315` | Stamp `floor_id` on `domain_outbox`/`transfer_workflow` activity writes | +8 |
| `2d817b9` | Floor-scope destination customer in purchase item transfer | +3 |
| `47e5976` | Phone FAB no longer switches business unit (frontend only) | +0 backend |

713 + 8 + 3 = 724, matching the observed count exactly. No tests were lost, no failures, no skips.

## 2. Frontend typecheck

```
cd frontend && npx tsc --noEmit
```

**Observed: clean, exit code 0, zero output.** The previously-cited `TileOrderCard.tsx:107` error is gone. No new errors.

## 3. Floor-isolation probe (final gate)

```
cd backend && FORGE_PROBE_PASSWORD='[legacy password removed; use injected test credentials]' ./.venv/bin/python -m scripts.probe_floor_isolation
```

**Observed: 10/10 endpoints isolated correctly, exit 0.**

| endpoint | unscoped | first-floor | ground-floor | verdict |
|---|---|---|---|---|
| Quotations | first-floor,ground-floor (78) | first-floor (56) | ground-floor (22) | ok |
| Customers | first-floor,ground-floor (122) | first-floor (6) | ground-floor (116) | ok |
| Purchase orders | first-floor,ground-floor (36) | first-floor (22) | ground-floor (14) | ok |
| Payments | first-floor,ground-floor (31) | first-floor (21) | ground-floor (10) | ok |
| Follow-ups | first-floor,ground-floor (339) | first-floor (161) | ground-floor (178) | ok |
| Walk-ins | ground-floor (110) | - (0) | ground-floor (110) | ok |
| Activity feed | ground-floor (50) | first-floor (50) | ground-floor (50) | ok |
| Notifications | first-floor,ground-floor (37) | first-floor (21) | ground-floor (15) | ok |
| Suppliers | first-floor,ground-floor (7) | first-floor (6) | ground-floor (1) | ok |
| Tile orders | ground-floor (6) | ground-floor (6) | ground-floor (6) | ok |

This is a **live evidence** check — it queries the running backend and live MongoDB Atlas data, not source code.

## 4. Browser smoke pass

Metro on `:8081`, backend on `:8010`, both already running (not restarted, per constraint). Logged in as `owner@forge.app`.

**Bundle freshness check (required before trusting any UI result):** fetched the live entry bundle —
`http://localhost:8081/node_modules/expo-router/entry.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable` — and grepped for `` `Open ${tilesNav.items[0].label}` `` (the template literal introduced by `47e5976`'s FAB fix) and `bottom-fab-new-quotation`. Both present. The bundle is current, not stale.

All 12 named routes were loaded on both units (`dashboard`, `walkins`, `quotations`, `catalog`, `customers`, `purchases`, `payments`, `followups`, `tiles`, `tiles/orders`, `notifications`, `settings`), at a 375×812 viewport. For each: page text confirmed non-empty rendered content, `read_console_messages({onlyErrors:true})` confirmed zero errors, and the full console log was checked for unhandled-rejection or React-specific `Warning:` output — none appeared on any route. The only console output on any page load was two RN-Web framework boot warnings (`"shadow*" style props are deprecated`, `Animated: useNativeDriver is not supported`), identical on every load, unrelated to route content or app code — not counted as findings.

**Ground Floor (`ground-floor`):**

| Route | Content renders | Console errors | React warnings | 375px overflow |
|---|---|---|---|---|
| dashboard | pass | none | none | none (`scrollWidth`=`innerWidth`=375) |
| walkins | pass (110 walk-ins, matches probe) | none | none | none |
| quotations | N/A — gated to Sanitary only (see H-3); Ground Floor's equivalent is `tiles` | — | — | — |
| catalog | pass (297 families, Dimore/Qutone) | none | none | none |
| customers | pass (116, matches probe) | none | none | none |
| purchases | pass (16 items; confirms Phase 3 pre-condition, see §6) | none | none | none |
| payments | pass (₹6.72L outstanding) | none | none | none |
| followups | pass (151 mission items) | none | none | none |
| **tiles** | pass (content renders) | none | none | **FAIL — see below** |
| tiles/orders | pass | none | none | none |
| notifications | pass (15 unread) | none | none | none |
| settings | pass | none | none | none |

**First Floor (`first-floor`):**

| Route | Content renders | Console errors | React warnings | 375px overflow |
|---|---|---|---|---|
| dashboard | pass (98 follow-ups, different data than Ground — confirms scoping) | none | none | none |
| walkins | pass (0 — Sanitary has no walk-in records, matches probe's `-`/0) | none | none | none |
| quotations | pass (49 total, 56 shown scoped, matches probe) | none | none | none |
| catalog | pass (1,995 families, Axor/Geberit/Grohe/Hansgrohe/Oyster/Vitra — confirms scoping) | none | none | none |
| customers | pass (6, matches probe) | none | none | none |
| purchases | pass (23 items) | none | none | none |
| payments | pass (₹38.66L outstanding) | none | none | none |
| followups | pass (98 mission items) | none | none | none |
| tiles / tiles/orders | N/A — Ground Floor-only feature. Direct navigation to `/tiles` while `forge.active-floor` was `first-floor` auto-rebinds the floor to `ground-floor` (route-level floor binding, by design for a URL that unambiguously belongs to one floor — distinct from H-3's bug, where a neutral "+" tap silently switched floors with no URL indicating intent) | — | — | — |
| notifications | pass (21 unread) | none | none | none |
| settings | pass | none | none | none |

**New finding — Ground Floor Quotation Tiles page overflows at 375px (not previously tracked as C-1..H-3 or the transfer bug):**

At 375px, `window.innerWidth` and `document.documentElement.scrollWidth` both read **561**, which trivially satisfies the brief's literal `scrollWidth === innerWidth` formula. But `window.visualViewport.width` and `document.body.getBoundingClientRect().width` both read **375** (the true device width) — the two pairs disagree, which is the real signal of overflow. DOM inspection (`getBoundingClientRect()` on every element) traced it to a single element: the "Create new selection" / "Create new quotation" header button row (`<div style="flex-direction: row; gap: 8px">` wrapping `data-testid="tiles-create-selection"` and its quotation sibling), computed rect `left: 155px, width: 405px` → right edge at 560px, 185px past the 375px viewport edge. The row does not wrap on narrow screens. Verified independently in a fresh tab (not a stale-viewport artifact) and cross-checked against `dashboard` in the same tab, which showed `innerWidth = visualViewport.width = 375` with no discrepancy — confirming this is page-specific to `/tiles`, not a measurement error. Zero console errors accompanied it; this is a pure layout/CSS defect, live-reproduced, not fixed as part of this task (Task 6 is verification and recording only). Flagged here for a follow-up fix.

## 5. Per-claim verification record

| # | Claim | Check run | Observed | Evidence strength | Verdict |
|---|---|---|---|---|---|
| C-1 | Follow-up reconciler no longer throws E11000 on `source_key` collision | Live: queried closed follow-ups holding a `source_key`; triggered a real `reconcile_followups()` pass against live data | 86 closed follow-ups hold a `source_key` (the exact collision precondition); reconcile returned HTTP 200 `{"created":0,"updated":196,"auto_resolved":0,"active":198}`, no E11000 | **Live data** | PASS |
| C-2 | Activity/notification events are floor-isolated | Code inspection of `log_event`/`notify` (true) **and** live query of `activity_events`/`notifications` collections, which surfaced `domain_outbox.py::_upsert_activity` and `transfer_workflow.py::_upsert_activity` bypassing stamping entirely and writing null floors — silently dropping order-placement, PDF-generation, supplier-assignment and transfer events from every unit's feed. Migration `0014`'s backfill had masked the gap. | Original claim was true only of the two named functions, false of the system. Fixed in `6bb5315` (+8 backend tests, now part of the 724 passing) | **Live data** (found the failure); **live + test** (confirmed the fix) | **FAILED, then FIXED** |
| C-3 | Walk-in duplicate-PII check is floor-scoped | Live query for cross-unit phone collisions in `customers`; code inspection of `services/duplicate_detection.py` | **Zero cross-unit phone collisions exist in live data** — the live system cannot exercise the leak either way. The floor predicate is present in code and the unit test (`test_walkin_duplicate_floor_isolation.py`) exercises it directly. | **Code inspection + unit test only — NOT live-reproduced.** Honestly weaker evidence than C-1/C-2; the fix is unverifiable against real data because no real data triggers it. | PASS (on code/test evidence, not live proof) |
| H-1 | Shortage cross-floor mutation is blocked | Task 5: code inspection confirmed `purchases_tracker.py` shortage handlers route through `floor_query(user, ...)` | Fix confirmed present in the **uncommitted working tree**, not in git history (`git log` shows no commit touching `purchases_tracker.py`'s shortage floor-scoping) | Code inspection only | PASS, **but not yet committed** — must land in Task 7's baseline commit, not before |
| H-2 | Download token binds to the minting floor and session | Live E2E: generated a quotation PDF via the `?dl=` path as owner on Ground Floor | HTTP 200, `%PDF-` magic bytes, 74,213 bytes; replay of the same token returned 401 | **Live data (E2E)** | PASS |
| H-3 | Ground Floor nav correctly excludes Sanitary-only Quotations; no silent floor switch | Task 5: `grep floors:` on `_layout.tsx` confirmed `PRIMARY`/`PHONE_TABS`/`MORE_ITEMS` all carried `floors: [SANITARY_FLOOR_ID]` for Quotations. Live-reproduction of the phone "+" FAB found it ungated: pressing it on Ground Floor flipped `forge.active-floor` to `first-floor` with no user-visible indication. | Four of five nav surfaces were correct; the phone FAB was the fifth and was broken. Fixed in `47e5976`; this session's smoke pass confirmed the bundle contains the fix (`Open ${tilesNav.items[0].label}` literal present) and re-exercised the Ground Floor `tiles`/`dashboard` routes without triggering any floor flip. | **Live data** (found the bug); **live + bundle-freshness check** (confirmed the fix is deployed) | **PARTIAL FAIL, then FIXED** |
| new | `POST /api/purchases/legacy/items/{item_id}/transfer` resolved its destination customer unscoped, enabling a cross-unit write | Live: confirmed the endpoint reachable in the running backend's OpenAPI schema; code inspection of `transfer_item` | Fixed in `2d817b9` (+3 backend tests, now part of the 724 passing) | **Live reachability + code fix + test** | FIXED |

## 6. Phase 3 pre-condition (not a defect)

The `Purchases` nav entries in `PRIMARY`/`PHONE_TABS`/`MORE_ITEMS` carry **no** `floors` restriction and are therefore visible on Ground Floor today. Confirmed both by `grep -n "floors:" frontend/app/\(admin\)/_layout.tsx` (Purchases has no `floors:` key, unlike Quotations) and live in the browser — the Purchases route rendered correctly on Ground Floor during this session's smoke pass (16 items, ground-floor SKUs). This is expected and deliberate; scoping Purchases by unit is Phase 3's work, not a Phase 0 regression.

## 7. Logged, not fixed

653 `activity_events` and 1 `notification` have `floor_id` entirely **absent** (the key is missing) rather than explicitly `null`. Behaviourally these are identical in MongoDB — both are invisible to every floor-scoped query, so this is **not a cross-unit leak** — but it deviates from migration `0014`'s stated design of an explicit `null` sentinel. These are rows written between `0014`'s backfill and `6bb5315`'s fix; they are permanently null/absent-floored and were not touched by this phase. No live query result changes based on this distinction; recorded for completeness only.

## 8. Summary

| Check | Expected (stale brief) | Observed | Result |
|---|---|---|---|
| Backend suite | 713 passed | **724 passed, 0 failed** | PASS (matches corrected 724 expectation exactly) |
| Frontend `tsc --noEmit` | clean | clean, exit 0 | PASS |
| Floor-isolation probe | 10/10 | 10/10, exit 0 | PASS |
| Browser smoke — console errors | zero | zero across 20 route loads (12 routes × 2 units, minus 2 N/A each) | PASS |
| Browser smoke — React warnings | zero | zero app-level; 2 recurring framework boot warnings (unrelated, pre-existing) | PASS |
| Browser smoke — unhandled rejections | zero | zero | PASS |
| Browser smoke — 375px overflow | zero | **1 found**: Ground Floor `/tiles` header button row overflows to 561px effective width (visualViewport stays 375px) | **NEW FINDING, unfixed** |

**Overall gate for the Task 7 baseline commit:** backend suite, tsc, and probe are all clean with no regressions and match (or exceed, per the corrected count) every numeric expectation. The one new defect found (Tiles page 375px overflow) is a pure frontend layout issue with no console errors and no data/security implication; it does not block the commit but should be tracked as a follow-up fix. H-1's fix remains uncommitted and must be included in Task 7. C-3 rests on code/test evidence only, not live reproduction, because live data has no cross-unit phone collisions to reproduce against — this is stated here explicitly so it is not later mistaken for live-proven.
