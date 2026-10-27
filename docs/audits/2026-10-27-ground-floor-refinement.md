# Ground Floor refinement and payment performance — 27 October 2026

## Requested behavior

Ground walk-ins now use the floor team assignment, as Sanitary does. Owners are
excluded from the assignee API and rejected by create/reassignment validation;
legacy owner-only records display Unassigned. No creator is substituted for a
missing worker. Floor-team edits update the canonical salesperson fields.

Ground Customers keeps only Overview, Quotations and Timeline. Both Tile Orders
and PO Final are removed from its profile; standalone Tile Orders stays in the sidebar. PO Final remains
Sanitary-only, including when the customer workspace switches floors.
Ground Follow-ups shares the compact Sanitary layout: no priority/type/owner
controls, Today/due summaries, ranking or mission. Salesperson filtering and
actual due dates on reminders remain. New Follow-up also hides Type.
Tile Orders increases table cell vertical padding and mobile card/list spacing.
The supplied screenshot exposed an intrinsic-width product row painting long
names/SKUs over quantity columns. Both customer and PO product identities now
stay inside their cells. The action column is 260px instead of 524px, with one
Move / Dispatch menu retaining all three exact labels, disabled states and stock
hints. Disabled menu entries cannot activate operations. Regression geometry
reproduced the old overflow before the repair.

## Request and caching repairs

Payment detail now starts its six independent reads together after the authorized
quotation lookup. History count/page reads overlap, as do its quotation, payment
and floor-name enrichment reads. Both batch collection/statistics totals and history enrichment bind balances
to the exact quotation/floor pair, preventing unrelated-floor payments or stock
credits from contaminating a visible ledger or marking an order fully paid.
Batch grouping stays constant at three aggregates; no per-order query loop was
introduced. Sanitary customer workspace totals also retain their exact floor.

Ground list navigation reuses responses for at most two seconds, with at most 64
retained entries. Mutations clear before and after the request; floor/account
changes clear all data. Editable details remain uncached. Explicit cacheMs: 0
forces a fresh read. In-flight reads from before a write cannot refill its cache.
This reduces duplicate/repeated navigation requests without long-lived financial
snapshots. Other floors retain their prior caching policy.

Redis operations in analytics have a 250 ms budget. Cache/version failures use
an authoritative database read. A failed invalidation is fenced and retried before
shared entries can be used again; older acknowledgements cannot clear a newer
failed write. The fence is process-local, matching the existing single-worker,
single-replica runtime. Logging/notifications following a committed payment have
one-second individual budgets and cannot turn a durable payment into a failed
business response. Transaction and authorization errors still propagate.

Migration 0038 adds only non-unique compound read indexes for payment history,
floor/quotation/status ledger reads and current order sorting. It changes no
customer or financial data. A disposable real-Mongo benchmark with 6,000 payments
reduced examined documents from 6,000 to 50 for history and from 6,000 to 60 for
a quotation ledger. Those are query-plan results, not hosted latency promises.

## Dispatch labor audit

Both dispatch paths already record the editing staff ID/name with the labor
charge in the dispatch transaction. Payment detail now admits these charges while
still excluding pending order-placement placeholders. Detail and global history
say “Labor cost has been added … by …”. The charge remains pending and increases
the balance without counting as received cash. Existing dispatch replay guards
remain intact. Actual FastAPI HTTP regressions test writer → detail/history and
floor-isolated balances, including deliberately reused quotation/payment IDs.

## Acceptance and publication

Evidence is recorded under output/ground-refinement. The initial focused browser
run passed 28 desktop/iPhone Safari cases. TypeScript and changed frontend lint
passed. The final full backend run passed 3,395 tests, with six dependency deprecation
warnings. An additional real-clock HTTP regression hangs both optional
post-payment side effects: the committed response succeeds within 2.8 seconds;
replay returns within 0.3 seconds with exactly one receipt and transaction.
All 52 CI frontend contract commands pass. The screenshot/menu correction passes
18 desktop/phone/Safari browser cases plus two tablet cases, including disabled
menu activation protection. Final every-page stability/timing acceptance remains
a separate gate on the frozen release commit. Two pre-existing structural detectors were
updated for the already-shipped transaction callback and guarded receipt helper;
no runtime authorization or transaction safeguards were removed.

Before release, 30 authenticated read-only samples returned HTTP 200. Ground
median HTTP times from this client were 207 ms Walk-ins, 223 ms Customers,
354 ms Follow-ups, 309 ms Payments orders, 457 ms Payment History and 259 ms
Tile Orders. These include network/proxy time. Server-Timing is saved separately.
They do not reproduce a timeout under this read-only workload, and cannot prove
that future requests never time out. Saved edits, real transaction replay and
cache outages are covered separately by the hermetic/HTTP regressions.

Existing dependency security auditing reports six high findings in node-forge,
zod and transitive Expo consumers. There is no all-green CI/security claim.
GitHub source push, Vercel candidate readiness, production alias promotion,
controlled migration and Railway runtime verification remain separate release
outcomes; none is claimed until provider/runtime evidence confirms it.
