# Ground Floor hardening — 30 October 2026

Release, Move to Godown, Dispatch from Released/Godown and Delivered previously
wrote permanent Material Movement Register rows after their stock transaction
committed, without its session. A failed register insert therefore returned an
error after changing stock, and a retry could repeat the physical movement. The
register model/service already required atomic evidence. These five paths now
insert the same immutable register data inside their existing stock transaction.
Failure aborts stock, batches, dispatch/chalan records, customer rollups and register
together. Activity timelines retain their existing bounded, best-effort behavior.
No schema migration or operational data change is required.

The brand release queue appended every requested page into its parent scroller.
It now presents one 30-record page through Previous/Next, retaining acknowledged
rows while a new page loads. Pending reads coalesce synchronously, navigation and
unmount cancel obsolete reads, and retained callbacks cannot publish or start old
brand requests. Failed page reads preserve the current page and retry the failed
page. A superseded effect completion cannot clear the current request's busy
state. Full authorized Excel collection remains independent of the visible page.

## Evidence

Before the backend fix, ten route/service unit regressions failed: five successful
paths lacked the transaction session, and five injected register failures retained
already-committed primary writes. After the fix all 70 relevant Tile Orders/model
unit tests pass. The hook regression first failed because page reads exposed no
pending state; its paging, retry, cancellation and effect-replay cases now pass.
TypeScript, focused zero-warning ESLint, the Tiles workflow contract and whitespace
checks pass.

The CI-selected `test_ground_sales_lifecycle_mongo.py` adds ten real Mongo cases:
each of the five paths commits successfully and each aborts after an injected
failure immediately following the actual permanent-register insert. Failed
operations preserve exact snapshots of purchase orders, customer rollups, ready
batches, dispatches, chalans, counters, register and activity. Success cases assert
quantities and linked dispatch/chalan identity. All 11 cases in that file pass,
including the existing sales lifecycle case. They ran with dotenv disabled against
a run-owned local replica at port 28176, in randomly named disposable databases;
the databases were dropped and the replica stopped afterward. No production
backend, database or provider was accessed.

A populated four-profile browser regression was added to the existing required
`redesign-tile-mobile-orders.spec.ts` suite for page bounds, pending controls,
retained rows, retry, last-page navigation, overflow and runtime health. Its final
browser results and the unchanged full performance/stability gate belong to the
parent hardening audit. This note does not claim physical-device acceptance or
publication.

Focused commands:

```sh
node scripts/test-tile-list-cancellation.mjs
node scripts/verify-tile-orders-contract.mjs
npx tsc --noEmit
npx eslint 'app/(admin)/tiles/orders/brands/[brandId].tsx' --max-warnings=0
```

With the repository's hermetic CI test environment (dummy credentials and local
Mongo URL), from `backend/`:

```sh
.venv/bin/pytest tests/unit/test_tile_orders*.py tests/unit/test_tile_movement_transactions.py tests/unit/test_models_tile_orders.py -q --tb=short
# 70 passed
PYTHON_DOTENV_DISABLED=1 TILE_DRAFT_TEST_MONGO_URL=mongodb://127.0.0.1:28176 .venv/bin/pytest tests/integration/test_ground_sales_lifecycle_mongo.py -q --tb=short
# 11 passed
```

The existing pytest-asyncio unset-default-loop-scope deprecation appears before
these runs; it is unchanged by this work.

## Dispatch labour cost admission follow-up

Both Ground dispatch request models accepted positive infinity from either the
JSON string `"Infinity"` or the valid JSON number `1e309`. The financial write
helper also accepted it, constructing infinite quotation/payment/customer-rollup
amounts; formatting the note as zero did not sanitize those writes. The two
request fields now require finite nonnegative values through their existing
Pydantic validation. No persisted-record model or serialization policy changes.

Six real HTTP regressions cover both encodings across generic dispatch, dispatch
from released and dispatch from godown. Before the fix every request reached the
mutation handler; afterward all return the production handler's sanitized 422,
`Cache-Control: no-store`, and a bounded `labor_cost` field error before any
session starts. Six additional model cases preserve zero, ordinary decimals and
finite decimal strings. The labour, dispatch and movement-transaction subset
passes 44 tests. The parent reruns its full final gate for this backend change.
