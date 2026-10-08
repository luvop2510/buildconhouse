# Floor Isolation + Tile Orders — Regression Report
**Date:** 2026-07-31 · **Backend:** restarted on :8010 · **Frontend:** restarted (Expo web)
**Verification account:** `owner@forge.app` (all three floors)

---

## 1. Root cause(s) of the floor leakage

The leak was not one bug. Four independent causes, all now closed:

**C1 — "All floors" sent no floor at all.**
`floor_query()` (`backend/auth.py`) scopes by `user.active_floor_id`, which comes from the
`X-Floor-Id` request header. The shell's floor switcher offered an **"All floors"** option that
stored `""`, and `src/api/client.ts` omits the header when the stored floor is empty. With no
header, `floor_query()` returned an **unfiltered** Mongo filter — so Quotations, Purchases, Tile
Orders, Payments, Follow-ups and Sales Data all returned both business units at once.

**C2 — Shared screens were hardcoded to `first-floor`.**
The 2026-07-28 fix pinned `app/(admin)/quotations/index.tsx` and `app/(admin)/purchases.tsx` to
`{ floorId: "first-floor" }`. That is precisely the reported symptom: **Ground Floor showed Sanitary
Bathroom quotations and purchases**, because those screens ignored the active floor entirely.

**C3 — Tiles navigation gated on *access*, not on the *active* floor.**
`useTilesNav()` in `app/(admin)/_layout.tsx` showed "Quotation Tiles" and "Tile Orders" whenever
ground floor was *accessible*. Owners/managers have access to every floor, so the Tiles module
appeared **while The Sanitary Bathroom was active**.

**C4 — First-paint race after login.**
`useFloorAccess` resolves the stored floor asynchronously. Between login and that resolution, every
request went out header-less → unscoped. Measured live: the dashboard's first paint read
**143 follow-ups** (48 Ground + 95 Sanitary merged) before settling.

**Data note (not a code cause):** the Vitra records appearing in Tile Orders are real rows —
7 `tiles_quotation` documents on `first-floor` (`Task19 SingleSupplier Test`, `TEST_LC4_*`),
created by the automated test harness against Sanitary products, which spawned 7 first-floor
`TileCustomerOrder`s + 7 Vitra POs + 15 movement rows. They are now invisible to every Tiles screen
by construction. **They have not been deleted — that is your call** (see §8).

### The fix

Floor is no longer inferred from request state anywhere in the Tiles domain:

- `backend/auth.py` — new `TILES_FLOOR_ID = "ground-floor"` and `tiles_floor_query(user, base)`.
  It **ignores `X-Floor-Id` entirely**, always filters `floor_id == "ground-floor"` in the database,
  and 403s a caller without ground-floor access.
- `backend/routes/tile_orders.py` — all **28** query sites converted to `tiles_floor_query`; the
  three previously unscoped reads (`item_ready_batches`, the dispatch batch lookup, the
  `_consume_released_pool` pool) now carry an explicit floor filter; every `floor_id` default on
  newly written batches/dispatches/chalans/movements changed from `"first-floor"` to `TILES_FLOOR_ID`.
- `backend/routes/quotation_routes.py` — tile `doc_type`s are pinned to Ground Floor at creation
  (`_floor_for_tiles_document`) and **rejected with 400** if they contain non-ground products;
  listing a tile `doc_type` is ground-floor-scoped regardless of header; `/quotations/recent`
  excludes tile documents.
- `backend/routes/executive_analytics_routes.py` — the Brand filter no longer offers every floor's
  brands.
- Frontend — "All floors" removed (a concrete floor is always active); login pins the floor before
  any screen mounts; Tiles nav requires ground floor to be *active*; `quotations`/`purchases`/
  `BuilderContext` follow the active floor instead of a hardcoded one; Sales Data and Executive
  Analytics default to the active floor; all Tiles API calls send `floorId: TILES_FLOOR_ID`
  (`src/constants/floors.ts`).

---

## 2. Root cause(s) of the non-functional Tile Order buttons

The endpoints and screens were all present and wired. Three defects made them read as broken:

1. **Release queue felt dead.** Ticking a line's checkbox left the quantity blank, so
   "Release Selected" stayed disabled until a number was typed by hand. Fixed: ticking a line
   pre-fills its full remaining quantity, and each row now has its own **Release** action.
2. **Movement sheets opened empty.** Move to Godown / Dispatch from Released / Dispatch from Godown
   all opened with an empty quantity field and rejected the first Confirm tap with
   "Enter at least one quantity". Fixed: each sheet pre-fills the full available quantity.
3. **Every download 401'd.** `?dl=` tokens (chalan PDF, quotation PDF, xlsx export) called
   `_load_active_principal` with **no `session_id`**, and the 2026-07-17 hardening made a
   session-less payload an outright 401 — so *every browser download in the app* failed with
   "Session expired or was signed out". Fixed by recording the minting request's session on the
   token and replaying it (downloads now also inherit that session's revocation).

Also fixed: the order timeline read `event.title`/`event.type`, which the API never returns, so
every row rendered "Workflow event"; a fully dispatched line displayed "Awaiting brand release";
purchase orders predating the redesign rendered an empty status pill.

---

## 3. Files modified

**Backend**
| File | Change |
|---|---|
| `auth.py` | `TILES_FLOOR_ID`, `tiles_floor_query()`; download-token session fix; `session_id` on the request user |
| `models.py` | `UserPublic.session_id` (request-scoped, never persisted) |
| `routes/tile_orders.py` | 28 queries forced to Ground Floor; 3 unscoped reads closed; floor defaults |
| `routes/quotation_routes.py` | tile-document floor rules; tile listing pinned; legacy `doc_type` fix; recent-quotations excludes tile docs |
| `routes/executive_analytics_routes.py` | brand filter scoped by floor |
| `routes/misc_routes.py`, `services/download_tokens.py` | session bound to download tokens |

**Frontend**
| File | Change |
|---|---|
| `src/constants/floors.ts` *(new)* | canonical floor ids |
| `app/(admin)/_layout.tsx` | "All floors" removed; Tiles nav requires active ground floor; floor switch lands on the dashboard |
| `src/hooks/use-floor-access.ts` | concrete floor always active; floor-specific screens pin their floor |
| `src/state/auth.tsx` | floor pinned at login (closes the first-paint race) |
| `src/api/tileOrders.ts` | every call pinned to Ground Floor |
| `app/(admin)/quotations/index.tsx`, `purchases.tsx`, `src/components/quotation/context/BuilderContext.tsx` | follow the active floor |
| `app/(admin)/sales-data/index.tsx`, `sales-data/executive.tsx` | default to the active floor |
| `app/(admin)/tiles/orders/po/[poId].tsx` | Finish + Action columns, checkbox pre-fill, per-row Release |
| `app/(admin)/tiles/orders/[id].tsx` | timeline fields, completed-line label, column widths |
| `src/components/tiles/TileMovementSheets.tsx` | quantity pre-fill |
| `src/components/tiles/TileOrderStatusUI.tsx` | empty status pill |
| all four Tiles tables | header/body column alignment, full-width stretch |

**Tests:** new `backend/tests/unit/test_floor_isolation_tiles.py` (5 cases) + a tile-listing and a
legacy-`doc_type` regression case; 8 existing tests updated to the stricter contract or repaired
(3 were already failing before this session).

## 4. Files removed

| File | Evidence |
|---|---|
| `frontend/src/components/tiles/TileOrderCard.tsx` | zero importers |
| `frontend/src/components/tiles/ChalanFormSheet.tsx` | zero importers; sole caller of the superseded `/purchases/{po_id}/chalans` |

---

## 5. APIs verified

Every endpoint probed three times — **no `X-Floor-Id`**, `first-floor`, `ground-floor` — asserting
the returned rows' own `floor_id`:

| Endpoint | Result |
|---|---|
| `/tile-orders/brands` | `[Dimore, Qutone]` under all three headers — **Vitra gone** |
| `/tile-orders/customer-orders` | 6 rows, ground-floor only, identical under all headers (was 13) |
| `/tile-orders/dispatches` | 18 rows, ground-floor only |
| `/tile-orders/movements` | 51 rows, ground-floor only (matches the DB's ground-floor count exactly) |
| `/quotations?doc_type=tiles_quotation` | 20 docs, all ground-floor, even with a `first-floor` header |
| `/quotations?doc_type=standard` | 49 first-floor / 0 ground-floor (**was 6** — legacy fix) |
| `/purchases/brands` | Vitra+Axor on Sanitary; Qutone+Dimore on Ground |
| `/customers`, `/walkins`, `/payments`, `/followups`, `/suppliers`, `/brands`, `/products` | cleanly partitioned, zero cross-floor rows |
| `/tile-orders/chalans/{id}/pdf` | HTTP 200, ~74 KB, `%PDF-` magic; replay of a used token still 401 |
| `/quotations/{id}/pdf`, `/purchases/export.xlsx` | HTTP 200 |

**Backend query sweep:** every `find(`/`find_one(`/`aggregate(`/`count_documents(` against a
floor-scoped collection in `routes/` was enumerated (87 candidates) and reviewed. All list/search
paths carry `floor_query`, `tiles_floor_query`, an explicit `floor_id`, or a `floor_ids` pipeline
match. The remainder are by-own-id lookups after an authorised parent fetch, or customer-portal
reads scoped by `customer_id` — correct by design. **No unscoped business query remains.**

## 6. Screens verified (live browser, both floors)

Dashboard · Walk-ins · Quotations · Purchases · Payments · Follow-ups · Sales Data ·
Tile Orders (Customer / Brands / Dispatch List / Material Movement Register) · Brand release queue ·
Product release page · Customer order workspace · Order timeline.

## 7. Test results

| Workflow | Result |
|---|---|
| Partial release (1 of 2 boxes) | Released 1→2, Remaining 1→0, rail advanced |
| Release sent with a deliberately **wrong** floor header | Still operated on the correct Ground Floor order |
| Move to Godown | Released 2→0, Godown 0→2, actions switched to Godown-only |
| Dispatch from Released | DSP-2026-0023 + CH-0026 created |
| Dispatch from Godown | DSP-2026-0024/0025 + CH-0027/0028, order → Delivered 100% |
| Chalan generation + PDF | 200, valid PDF, delivery address populated |
| Material Movement Register | all 6 events present with source/destination/chalan/user |
| Customer timeline | 13 real events with text, timestamp and actor |
| Activity log | `ready_batch.created`, `item.moved_to_godown`, `dispatch.created`, `chalan.generated`, `status.changed` |
| Dispatch list search / filter / pagination | 200 on every combination |
| Over-release (99 boxes) / dispatch from empty Godown | correctly refused with 400 |
| Tile quotation from a Ground product with a Sanitary header | saved as `ground-floor` |
| Tile quotation containing a Sanitary product | refused, 400 |
| Standard quotation with a Sanitary product | still saved as `first-floor` |
| Browser refresh + backend restart + frontend restart | data persisted (Delivered / 100%) |
| Switch to Sanitary Bathroom | no Tiles nav, no tile data, Vitra purchases only |
| Backend unit suite | **376 passed, 0 failed** (was 371 passed / 5 failed) |
| `tsc --noEmit` | clean |
| `expo lint` | 13 errors, all pre-existing `react/no-unescaped-entities` in the Privacy/Terms copy |

## 8. Production readiness — what is and is not done

**Ready:** floor isolation is enforced in the database on every business query and no longer depends
on frontend state; the Tile Orders workflow (release → godown → dispatch → chalan → PDF → register →
timeline) executes end-to-end and survives restarts; every download works again.

**Open items needing your decision — I did not act on these:**

1. **Test data in production Mongo.** 7 first-floor tile quotations + 7 `TileCustomerOrder`s +
   7 Vitra POs + 15 movement rows (`Task19 SingleSupplier Test`, `TEST_LC4_*`), plus the ground-floor
   `Task18/Task19/TEST_LC4/ZZTEST` orders. Invisible in the Tiles module now, but still real rows.
   Say the word and I'll write a scoped cleanup script.
2. **`owner@forge.app` is back on the publicly known password `[legacy password removed; use injected test credentials]`** — `/api/health` reports
   `degraded` for exactly this. The test harness appears to have reset it. Rotate before go-live.
3. **Legacy endpoints, dead from the UI but still unit-tested** — `/purchases/orders/customer-view`,
   `/orders/company-view`, `/{po_id}/order-detail`, `/{po_id}/chalans*`, `/dispatch-record`,
   `/legacy/items/{id}/transfer`. Removing them means removing their tests too, and the chalan path
   shares the `CH-` counter with the live one; I left them in place rather than guess.
4. **Sales Data keeps an explicit "Both floors" option** for owner/admin company-wide reporting. It
   is no longer the default, but it is the one deliberate way to query across floors.
5. Legacy purchase orders (`FPO-2026-0236/0238/0239/0280`) predate the box counters, so their
   release queue rows show 0 ordered/released — data, not code.
