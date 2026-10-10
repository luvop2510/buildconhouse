# Purchases dispatch completion audit — 10 October 2026

The final stages are PO Final, Order in Company, Company Billing, Inbox and
Dispatched. The user clarified that dispatched means delivered. Legacy supplier
receipt events which incorrectly said delivered remain warehouse Inbox; explicit
legacy delivery/transit stages normalize to Dispatched without deleting history.

Completion groups every positive active line across all scoped purchase orders
before pagination. Cancelled orders/lines and quantities already returned to
godown or to a lending customer are excluded. A pending older line or a residual
partial-dispatch line prevents 100% completion. Cumulative dispatched Chalan
quantities count only when they cover the item's full active quantity. Delivery
timestamps come from the product's covering Chalans, never another product's
later dispatch. Customer IDs group historical names into the same account.

The completed page reuses the Purchases customer navigator and product panel.
Its product list pages in Mongo and displays delivery dates, product quantity,
unit cost, brand, PO reference and movement history. Active Purchases customers
exclude completed accounts; the Stock customer filter retains them for tracing.
Floor/customer request guards prevent obsolete requests replacing current data.

## Atomic stock movement and race guards

Partial movement previously reduced a source line and appended its child in two
writes. An interrupted second write could lose active stock, and a concurrent
completion read could see the source disappear before its child existed. The
source transformation and child append now occur in one Mongo document update
using map/concatenation expressions. User strings and copied child records are
wrapped as literals, including dollar-prefixed notes and identifiers.

Returned quantities stay on the historical source; the new child clears those
counters. This conserves active stock instead of subtracting old returns from
both lines. Both partial and full moves compare the source floor, active parent
status, cancellation state, stage, raw quantity, return counters, loaned quantity
promised replacement quantity, and Chalan snapshot. A competing cancellation, return, split, loan or dispatch
cannot silently overwrite the state used to compute a move. Cancellation also
compares the Chalan snapshot to detect a concurrently committed delivery.

The stock UI consumes active quantity from paged/flattened tracker responses:
MovementEngine initializes quantity from item.qty and validates its maximum
against that same value. The canonical purchase-order detail also subtracts
godown and loan-return counters before opening the shared movement sheet. The
backend now also defaults an omitted move quantity to active quantity, while
retaining consumed quantities on the original audit line.

## Verification

Disposable local Mongo processes use temporary database directories and localhost
ports; every process is stopped after its test. No live database or WhatsApp
provider is used. The purchase integration file covers floor isolation, cancelled
and zero quantities, an older pending order among 1,100 dispatched orders,
customer renames, partial/full Chalan delivery, historical migration idempotency,
active/stock customer visibility, atomic return-aware splits and seven concurrent
mutations injected between a read and its compare-and-set write.

The WhatsApp integration file covers repeatable migrations, real unique request
and sparse provider-ID constraints, incompatible index options failing closed,
callbacks before send responses, duplicate-send suppression, same-second receipt
ordering and terminal receipt replay protection. HTTP responses are test doubles.

The targeted acceptance covers purchase unit tests and 16 Mongo integration
cases: 12 Purchases and four WhatsApp. Responsive browser acceptance is tracked
in the release audit rather than inferred from backend tests.

Customer-directory names retain the existing full-floor list behavior; the
tracker product pages and completed customer lists are server paged. The directory
lookup/renderer should gain its own paging if customer-directory sizes grow large.
