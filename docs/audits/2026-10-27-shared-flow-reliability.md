# Shared flow reliability — 27 October 2026

Branch `codex/shared-flow-reliability-2026-10-27`, based on the latest sanitary
release `33efbd32`. Work is isolated from the other dirty checkouts.

## Causes and changes

The additional-cost endpoint inserted the same dictionary it later returned.
MongoDB injects an internal BSON ObjectId into that dictionary. The transaction
committed, then FastAPI failed serializing the HTTP response. A second request
read the saved entry with `_id` excluded and succeeded. Insert a copy so the
public response stays serializable. Keep transaction, idempotency, floor and
money validation unchanged. The prior test fake did not model Mongo's mutation;
it now does and checks the actual first/replayed HTTP responses, identical totals
and one ledger row. Both affected regressions fail without the fix.

Read-only Railway logs directly confirm two PATCH 500s on
`/api/payments/orders/:id/manual-extra` at 02:25 IST on 27 October, with
`ObjectId object is not iterable` and `vars() argument must have __dict__`.
Raw logs remain private and untracked, with no customer identifiers here.
The available 24-hour HTTP sample has no GET taking at least 2,500 ms; this is
sample evidence, not proof against intermittent client/network delays.

Kitchen create and command routes also awaited analytics invalidation after a
successful durable save. A cache failure could falsely report the save as failed.
They now log that secondary failure while returning the saved result. Existing
bounded analytics TTL provides eventual refresh. Authorization/transaction errors
still fail normally; session/security caches are unchanged. Fault injection
reproduces this mechanism and validates durable retry. The available production
logs do not prove that it caused the reported Kitchen incident.

Walk-in lists previously awaited optional dashboard completion before publishing
rows. Walk-in detail awaited timeline history before showing the record, and
payment balance refresh awaited optional statistics. Each now publishes primary
content independently, retaining floor/request generations and explicit optional
failure feedback. This removes slow-secondary-request blocking without extending
request deadlines, hiding errors or adding automatic mutation retries.

Sanitary PO Final replaced the quotation cover with a simplified payment cover.
It now uses the same quotation cover and product layout; payment history remains
on a supplementary page. Final remaining quantities/rates and balances are
preserved, including MRP/offer columns and a correction for double-applying a
discount when an original offer rate is absent. Tiles retain their PDF behavior.
The synthetic rendered cover is `output/shared-flow-reliability/po-final-cover.png`.

Walk-in list cards received the Ground Floor Schedule Selection action on every
floor. Both the caller and card now restrict it to Ground. Sanitary detail already
excluded it. Walk-in sections/cards now have consistent padding, section gaps and
comfortable action spacing.

Shared filters were collapsible on phones only; desktop/tablet forcibly showed
them. Sanitary follow-ups bypassed the shared disclosure. Disclosures now work at
every width with expanded/controlled-region accessibility and retain mounted
values/drafts while hidden. Search joins the existing filter group on walk-ins,
follow-ups, payments/history/fully-paid, customers/customer purchases, quotations,
Tiles, Godown and the shared purchases/table toolbar. Page actions remain usable.
Kitchen retains its established unified filter drawer.

## Validation and publication

Focused backend verification: 199 payment/Kitchen/cache/version/navigation tests
and 101 PDF/Excel/media/tiles tests pass. Frontend loading regressions: 30 pass,
including held/failed history and obsolete-route responses. TypeScript,
changed-file zero-warning lint and mobile/release contracts pass. The synthetic
PO PDF was rendered and visually inspected. Independent focused review found no
blocking correctness issues. Fifteen additional browser cases passed across
desktop Chrome, phone Chrome and phone WebKit, covering floor-specific scheduling,
salesperson overflow and Ground document deletion under the grouped filters.

The first push gate completed all 712 stability checks but rejected one of 60
timing cases: Safari's first repeated Catalog visit was measured at 3,156 ms
against the unchanged 2,500 ms bound. Its screenshot shows the complete card at
about 2,079 ms, followed by roughly 950 ms of test protocol/observation delay.
Tiny fixture responses also showed delayed protocol completion. A single original
Safari diagnostic per frozen artifact measured baseline first/cached-max visits
at 874.9/45.7 ms and candidate at 877.0/41.2 ms, with identical bounded reads and
no errors. This supports transient host/IPC contention rather than an observed
candidate regression. The rejected run is preserved in
`output/shared-flow-reliability/first-push-rejected/`; diagnostic evidence is in
`output/shared-flow-reliability/diagnostics/comparison.json`. Diagnostics do not
replace acceptance: the full fresh push gate must still pass unchanged.

The required local pre-push hook runs the full, freshly rebuilt browser/stability
and performance audit. Its evidence is kept in
`output/shared-flow-reliability/push.log` and `output/playwright/`
(`stability-summary.json`, `performance-summary.json`, `bundle-budget.json`).
Independent CI gates remain enabled; no budgets, retries or skips are relaxed.
No production business writes, data repair or database migration is part of this
change. Pushing source does not certify that both frontend and backend have been
promoted; physical-device and production-mutation acceptance remain unverified.
