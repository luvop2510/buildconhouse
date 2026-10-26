# Kitchen versions and internal notes — 26 October 2026

## Scope and confirmed rules

The owner approved compatible API/model changes without a data migration, confirmed
that “company end of” means Sent to company / Date sent to company, and selected
Not recorded / Yes / No for customer confirmation and Confirmed / On Hold /
Cancelled for order status. Existing owner authority for hold/cancel remains.
Version changes after production starts require owner-authorized Return to Design.
All notes are internal. No company message, document generation or external notes
export was added. Existing uploaded files and historical note fields remain.

Work was isolated from unrelated dirty checkouts. The implementation was rebased
onto `1460ef5b6d40735ed1c3b147a377ebb2fb8ee7bb`, preserving its bordered saved-detail
displays, stable save-status area and existing-reference selection repairs.

## Behavior and contracts

Design and quotation views expose compact selectors. Design version numbers and
quotation revision numbers are distinct; every quotation retains its explicit
`design_version_id`. Viewing a selector changes local view state only. Design edits,
sharing, responses and handoff name the selected record ID; project membership,
workflow cycle, permissions, optimistic concurrency and approval immutability
remain enforced. Corrections retain before/after audit history. The price-rejected
v3 → revised v4 journey preserves the v3 quotation.

Design’s separate response-notes, correction-reason and customer-changes inputs
are consolidated into Internal notes below the company-handoff controls. Existing
response notes remain visible as historical internal content, with corrections and
revision reasons available in History. Requirements and Budget discussion use the
same compact multiline control. A revision request uses the internal note as its
reason and clears only the saved note’s dirty baseline, preserving other edits.

`design_response` and `design_update` accept optional `approval_date`. Handoff must
follow customer approval and its date may be later. Historical approval-event dates
are explicitly described as recorded dates, not silently entered as actual dates.
Repeated approved corrections do not shift that recorded approval day. Unknown or
inconsistent historical dates remain unchanged and flagged for review.

`quotation_receive.amount` is optional; omitted, null and blank values become null.
Zero remains an explicit zero. The quotation and order document inputs are removed;
old files/references remain readable, and the compatible API still accepts valid
existing references. A missing quotation amount requires an explicit final order
amount before financial order confirmation; it is never treated as zero.

`order_confirmation` accepts `{value: "Not recorded" | "Yes" | "No"}` and persists
`customer_order_confirmation`. Before an order exists this creates no financial
order. Existing order booleans remain compatible. Confirming an order writes Yes;
changing confirmation updates the existing order’s confirmation and approval
identity without deleting its terms/history. The UI distinguishes drafts, pending
persistence and saved values, and reload shows the persisted choice.

`order_update` accepts optional `quotation_version_id` and
`amount_customer_approved`. It validates the chosen quote/design chain, retains
final terms and requires existing owner/customer authorization for changed terms.
Only eligible shared, approved current-cycle quotations can be selected for an
order. Historical viewing is separate from this explicit save.

Production/Installation detail and queue contexts resolve
`order.quotation_version_id → quotation.design_version_id`, including older valid
versions. Bounded server list projections and active-order metrics use that chain.
Once production starts, the monotonic order flag, current work, current-cycle work
history and audit evidence prevent a manual move back to Order from bypassing the
version-change restriction. Return to Design preserves old commerce/work history.

Kitchen multiline fields start at one readable line, grow with wraps/newlines and
shrink when text is removed or the viewport widens. Text, money, date and selector
controls retain their distinct behavior. Labels, focus and Enter behavior remain.

## Evidence and performance

`backend/scripts/benchmark_kitchen_commands.py` compares the pinned baseline
`a689feda06a28366f0da8a60c89a48c4a693ed61` with the revised service. Ten adjacent
owner stage moves, in-memory persistence with 20 ms injected latency per operation:
median **148.655 ms → 106.185 ms**, **7 → 5 serialized database calls** (28.57%).
The change removes a duplicate configuration insert and redundant policy read,
reusing the policy pinned by command admission. Exact admission-token cleanup,
policy races, CAS and idempotent replay are still tested. No frontend full reload
or redundant post-save project refetch was found. These figures exclude HTTP,
authentication, live MongoDB and production network latency; they are not deployed
performance claims.

Regression coverage is in `test_kitchen_version_relationships.py`,
`test_kitchen_command_performance.py`, `test_kitchen_version_summaries_mongo.py`,
`kitchen-version-workflow.spec.ts`, `kitchen-note-fields.spec.ts` and the updated
existing commercial/lifecycle suites. Browser acceptance uses the actual exported
UI, FastAPI router, synthetic authentication and run-owned disposable MongoDB.
Existing API/security/performance gates are retained. Exact final results and
release identities belong in the delivery report; intermediate runs must not be
used to certify later source changes.

## Release boundaries

No data migration, secret change, replacement project or live business-data rewrite
is part of this implementation. Source push, candidate deployment, production
promotion and hosted acceptance are distinct states. The local security gate found
six high advisory entries (node-forge and Zod, including Expo/Sentry dependency
chains). It remains blocking; an old one-release exception is not reusable.
The existing GitHub main branch requires independent review and backend, frontend,
frontend-security and performance checks. No protection, deadline or advisory
suppression was changed. A read-only check of current production passed 18
route/asset/API/security checks; that checks the existing deployment, not this code.
