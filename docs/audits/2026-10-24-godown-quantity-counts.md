# Recording uncounted godown quantities

## Problem and resulting workflow

Stock cards previously said “Record quantity before using this stock” but their editor only supported price and image changes. Uncounted lots therefore had no application workflow for resolving that state.

Authorized stock editors now have a “Record quantity” action on uncounted lots. It requires an explicit nonnegative quantity, count date and source/reason. Zero is accepted only as an entered number, not as the default for a blank field. New direct intake also starts with a blank quantity instead of an assumed one unit. The form tells the operator to use the same unit as this product's purchases and quotations, without converting boxes into pieces or deriving quantities from mere product presence.

Saving writes the quantity, clears the missing flag and appends a count record with actor, date, source, recorded timestamp and command receipt. These changes are one atomic stock-document update. This initializes only a previously uncounted opening balance; it does not claim a supplier delivery. Stock history labels it “Counted opening balance” and shows the count details.

The endpoint rejects archived/already-counted lots, recorded quantities, allocations, customer transfer history, stale versions and concurrent conflicting changes. Same-command replay returns the current balance without restoring units that have subsequently been consumed. Changed details using the same command are rejected. The exact POST count route maps to the existing `godown_stock.update` grant and retains warehouse-role admission. Internal command keys and hashes are omitted from public count history.

The client retains the count and retry identity during errors. “Refresh this lot” fetches only the affected lot, preserving the entered fields for explicit review and updating its version before another save. Counting and price saving share a synchronous per-card write guard. Floor changes/unmount abort the view's work. Successful counts recalculate page units, brand quantities, valuation and unpriced totals without reloading the full inventory.

## Scope and data truth

This is an application flow for a staff-confirmed count in the product's existing stock unit. It does not determine units from the workbooks, apply a physical count automatically, or provide general adjustments to stock already carrying movement history. Such stock needs a separate reconciliation workflow rather than an overwrite.

The supplied workbooks still have 360 unresolved quantities. None was filled with a guessed one or imported into production in this change. Their dates and pieces/boxes/sets definitions remain requested inputs for data reconciliation. Original workbook provenance and quantity notes are retained when a later confirmed count initializes the balance.

## Verification

- 56 backend cases pass: 16 new disposable-Mongo/input-validation cases and 40 existing stock-detail/access-grant cases. They cover zero and positive balances, atomic concurrent counts, exact replay after consumption, different-command conflict, changed payload, stale/archived/already-counted lots, allocations/transfers, foreign-floor access and invalid input. Mongo runs in isolated local processes with disposable databases and explicit hermetic settings.
- The initial foreign-floor fixture used an inconsistent account that still held the source-floor grant. The read helper correctly authorized its source record, while the count CAS refused the ambient destination floor. The fixture now represents a truly unauthorized account, with only the foreign-floor grant; it receives 404. No access rules were weakened.
- All 30 final stock browser cases pass on desktop, tablet and phone with two workers, unchanged deadlines and zero retries. New cases verify blank versus explicit zero, date/source entry, identical retry payloads/keys, updated page and brand totals, visible audit history and single-lot stale-data recovery. Existing price/image/upload, large-inventory search, quotation handoff and retained-draft journeys pass.
- An initial shared-server browser run passed 14 cases before its reused localhost server disappeared; subsequent navigations failed with `ERR_CONNECTION_REFUSED`. That failed evidence is saved under `outputs/godown-review-2026-10-24/failed-quantity-server*`. The final 30-case run used an explicitly owned audit server on port 8197 and passed completely.
- Nine stock floor/recovery hook checks, TypeScript, focused ESLint, fresh web export and all 187 route bundle budgets pass. The largest page is 483 KiB gzip against the unchanged 576 KiB limit. This is not the full publication performance audit or live all-floor latency evidence.
- Both zero/positive retry screenshots were opened at desktop, tablet and phone widths. Form labels, recovery text and actions remain readable and reachable. The existing palette/type are retained. The quantity form is a targeted workflow addition; no broad Design Taste inspector pass or complete redesign is claimed.

The audit server has no API proxy and rejects unintercepted requests. Its local package uses `https://audit.invalid` as worker upstream and must not be deployed. No live stock quantities, customers, media or deployments were changed.

## Remaining goal scope

Initial stock transport still fetches the complete bounded inventory and history. Paging/history loading and all-floor live timings remain open. Complete image coverage and source ownership checks, actual stock reconciliation, general adjustments to previously counted stock, remaining mutation paths and publication acceptance also remain open.
