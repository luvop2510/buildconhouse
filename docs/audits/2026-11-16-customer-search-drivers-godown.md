# Customer search, dispatch reuse, Godown quantities and customer permissions

Implemented in the existing Expo/FastAPI/Mongo application from remote-main
`f2ebe526da0edd36fed82e6a943fe51501c95c78`. The canonical production frontend
was read-only verified to use this same source before implementation. Work is
isolated from the other checkouts' unfinished edits. No production records,
permissions, infrastructure or deployments were changed by this task.

The later direct request for owner-controlled employee/role deletion permission
supersedes the attached document's earlier owner-only wording.

## Root causes and changes

1. **Universal search:** The profile endpoint hydrated every associated record
   and follow-up/history array, and the interface recursively rendered these
   records and internal IDs. It now returns small current-workflow cards. Kitchen
   uses its persisted project stage and version ledger; catalog floors use actual
   document type, explicit order links and the existing fulfillment rules.
   Cancelled/terminal workflows do not become active because of an edit date.
   Exact customer/import associations are preserved; phone numbers never merge
   identities. Each permitted department has its own compact card and direct
   record action. Saved history remains in Mongo.
2. **Drivers:** Dispatch forms only stored trip snapshots and had no reusable
   driver lookup. A compact searchable driver directory now uses normalized mobile
   identity under the existing dispatch floor boundary. Profile writes commit in
   the dispatch transaction. The order, dispatch-board and transport-correction
   forms reuse the same fields. Each chalan retains its recorded name/mobile/
   vehicle snapshot; changing a profile does not rewrite earlier dispatches.
   Receiver, destination, reference and labour remain trip-specific. A mobile is
   required to save a reusable profile; legacy dispatches without one remain
   compatible. No separate management screen or data migration was added.
3. **Godown quantities:** Release and move already saved selected quantities in
   item counters and FIFO batches. The inventory endpoint filtered those balances
   but omitted quantity/unit from both its aggregation and fallback response; the
   table also omitted them. Both now expose the actual balance, exact variant,
   size and unit. Optional actor/PO/action-bound request keys protect releases and
   moves from duplicate retries. Receipts, quantities, batches and permanent
   movement evidence commit together; changed-body reuse rejects with 409 and
   transaction conflicts permit an explicit retry. The forms retain the key
   after an uncertain save. Customer graph cleanup also removes that customer's
   deleted-PO release receipts.
4. **Department Progress:** Stage marks previously cycled through a generic
   blue/grey palette. One stage-keyed map now serves Today segments/legend and
   owner workflow bars. The eight requested hex values are exact. The existing
   ninth CAD File stage retains its place and uses distinct pink `#DB2777`.
   Labels/counts keep the readable text palette; calculations are unchanged.
5. **Customer deletion:** Kitchen already had transactional recoverable deletion,
   but its separate Kitchen-only permission and UI guards did not match the new
   reusable Team & Roles requirement. `customer_delete` is now the per-account,
   per-department capability named **Delete Customers**. The existing role matrix
   has an explicit `delete-customers` setting. Both default off for non-owners;
   role rank or ordinary page editing/deletion cannot confer the capability.
   Account state, floor access and permission are re-read on preview and delete,
   including retries, so revoked permission cannot survive a cached session.
   Kitchen additionally checks every affected project's current-stage access.
   Its customer/project tombstones, versions and actor/time audit commit together;
   private files and workflow history remain for controlled recovery. Other
   departments retain their existing graph-deletion integrity contract, constrained
   to the selected department; cross-department linked graphs are refused for
   separate review. Generic customer list/detail deletion now always opens a
   named preview and explicit confirmation. Bulk floor reset remains owner-only.

## Requirement coverage

| Requirement | Verification sources |
| --- | --- |
| Name/mobile search, current stage, no UUID/history dump | `test_home_customer_search.py`, `test_customer_search_mongo.py`, `home-customer-search.spec.ts` |
| Multiple departments, same-phone identities, cancelled/completed orders and current Kitchen versions | `test_home_customer_search.py`, `test_customer_search_mongo.py` |
| Reusable/editable drivers, normalized deduplication, all dispatch paths, separate trip fields and historical snapshots | `test_dispatch_drivers.py`, `test_dispatch_drivers_mongo.py`, `redesign-dispatch-drivers.spec.ts` |
| Full/partial/multiple release, variant/unit mapping, refresh persistence, remaining balances, duplicate retries and transactional rollback | `test_tile_orders_inventory.py`, `test_tile_release_godown_mongo.py`, `redesign-dispatch-drivers.spec.ts`, `redesign-tile-movement-feedback.spec.ts` |
| Stable Kitchen colours, matching segment/legend, changed/zero counts and refresh | `test-kitchen-stage-colours.mjs`, `redesign-kitchen-stage-colours.spec.ts` |
| Default-deny, owner, employee and role grants, department boundaries and immediate revocation | `test_customer_delete_access.py`, `test_customer_delete_permissions_mongo.py`, `redesign-customer-deletion.spec.ts` |
| Kitchen confirmation, soft deletion, hidden active records, audit, retained evidence and unrelated-floor preservation | `test_kitchen_customer_soft_deletion_mongo.py`, `kitchen-customer-updates.spec.ts` |
| Mobile layout and reachable actions | Desktop/Android/iPhone/iPad browser runs plus 320px/WebKit feature fixtures and screenshots |

## Verification results

The user explicitly requested stopping the remaining tests and publishing immediately.
The unfinished full audit was stopped. Focused results already retained:

- 104 focused Python unit/integration checks passed, including real disposable
  replica transactions; four additional generic deletion integration cases passed.
- 52 dispatch/Godown/confirmation/movement browser cases passed across desktop,
  phone, 320px and WebKit; eight employee-permission visibility cases passed.
- Eight real-API/Mongo Home-search and Kitchen-confirmation browser cases passed
  across desktop, Android, iPhone Safari and iPad Safari.
- Four Kitchen colour browser profiles passed, including dynamic/zero counts.
- A full backend unit run passed 4,359 tests; final unchanged-source gates are
  recorded below when finished.
- npm security gate passed with no high/critical findings; the report retains
  nine low and one moderate existing advisory. URI decoder compatibility and
  malformed-URL CPU regression passed after normal dependency preparation.

Earlier runs are retained as failed/interrupted evidence, not acceptance. The
first broad browser run had 1,115 passes and one ENOSPC failure. Later export/test
startup attempts were affected by local disk/swap pressure and a shared install
missing the repository's required compatibility preparation. Dependencies were
prepared with the existing scripts; only reproducible package caches were pruned.
No deadlines, budgets, security gates or browser error checks were weakened.

## Rollout and remaining limits

No database migration or historical data rewrite is required. New driver and
movement-receipt identities use Mongo's built-in `_id` uniqueness. Existing
permissions/history are preserved. The CI job now runs the new real-Mongo
workflow checks against its existing disposable replica.

Production publication is authorized by the user and being performed. Deployment
identities and live read-only verification will be recorded after publication.
Synthetic verification does not establish physical-device keyboard acceptance.
The selected-department protection intentionally refuses a cross-department
customer graph rather than removing records outside that department. Kitchen
recovery uses the existing controlled recovery process; this change adds no
self-service restore interface.

## Files modified

- `.github/workflows/ci.yml`
- `AGENTS.md`
- `app/(admin)/customers/[id].tsx`
- `app/(admin)/customers/index.tsx`
- `app/(admin)/followups.tsx`
- `app/(admin)/notebook/furniture-quotations.tsx`
- `app/(admin)/tiles/orders/index.tsx`
- `app/(admin)/tiles/orders/po/[poId].tsx`
- `backend/access_profiles.py`
- `backend/auth.py`
- `backend/models_tile_orders.py`
- `backend/routes/customer_routes.py`
- `backend/routes/permissions_routes.py`
- `backend/routes/tile_orders.py`
- `backend/services/access_grants.py`
- `backend/services/customer_delete_access.py`
- `backend/services/customer_deletion.py`
- `backend/services/customer_search.py`
- `backend/services/dispatch_drivers.py`
- `backend/services/kitchen_customer_deletion.py`
- `backend/tests/integration/test_customer_delete_permissions_mongo.py`
- `backend/tests/integration/test_customer_search_mongo.py`
- `backend/tests/integration/test_dispatch_drivers_mongo.py`
- `backend/tests/integration/test_kitchen_customer_soft_deletion_mongo.py`
- `backend/tests/integration/test_tile_release_godown_mongo.py`
- `backend/tests/unit/test_customer_cleanup.py`
- `backend/tests/unit/test_customer_delete_access.py`
- `backend/tests/unit/test_delegation_catalog.py`
- `backend/tests/unit/test_dispatch_drivers.py`
- `backend/tests/unit/test_home_customer_search.py`
- `backend/tests/unit/test_tile_orders_inventory.py`
- `e2e/home-customer-search.spec.ts`
- `e2e/redesign-customer-deletion.spec.ts`
- `e2e/redesign-dispatch-drivers.spec.ts`
- `e2e/redesign-kitchen-stage-colours.spec.ts`
- `e2e/redesign-tile-movement-feedback.spec.ts`
- `scripts/test-kitchen-stage-colours.mjs`
- `scripts/test-page-loading-performance.mjs`
- `src/api/tileOrders.ts`
- `src/components/HomeCustomerSearch.tsx`
- `src/components/customer/CustomerDataDeletionDialog.tsx`
- `src/components/kitchen/KitchenProjectDetail.tsx`
- `src/components/salesAnalytics/OwnerOperations.tsx`
- `src/components/tiles/CreateDispatchSheet.tsx`
- `src/components/tiles/DispatchRecordSheet.tsx`
- `src/components/tiles/DriverFields.tsx`
- `src/components/tiles/TileMovementSheets.tsx`
- `src/components/today/TodayGraphics.tsx`
- `src/design/kitchenStageColors.ts`
- `src/hooks/use-customer-delete-access.ts`
- `src/team-delegation.ts`
