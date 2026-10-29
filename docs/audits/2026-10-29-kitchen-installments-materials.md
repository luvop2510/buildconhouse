# Kitchen installments, material list and production dates

Kitchen only: confirmed orders have append-only installments with payment date,
amount and actor/time. The existing advance counts once in paid/remaining totals.
Positive amounts cannot exceed the balance; dates must fall between order
confirmation and India today. Current-order identity, floor/update access, CAS,
actor-bound replay and held-project rules remain. Final installments can be
recorded after completion without reopening work or changing its completion date. Payment receipts do
not rewrite confirmed terms or invalidate manager approval. Order amendment and
advance corrections cannot reduce terms below recorded receipts or overpay.
Sales analytics and reference balances include the same installment receipts.
Material arrived is an explicit saved Yes/No choice in the installment section.

There is no fixed installment or material-photo count cap. Installation can attach multiple JPG/PNG photos to its material list using the
existing private, verified upload/download pipeline. Attachment IDs must belong
to this project and have image MIME types. List append deduplicates IDs; work
status saves retain photos. Uploaded files and earlier work cycles remain intact.

Production Completion date is calculated from Start date plus two calendar
months, in both UI and server commands: 20 October becomes 20 December. The
completion field is read-only for Production; changing start recalculates it.
Month ends clamp to the destination month's last day (31 December becomes
28/29 February). No extra end-date field is added. Completion date may be present
while In Production; status remains explicit and never auto-completes the work.
Installation keeps its existing editable actual dates and chronology checks.

All additions use the existing aggregate and command transport, no new dependency
or migration. Focused unit/contract/type/browser evidence and actual deployment
receipts are under the parent workspace outputs/kitchen-flow-2026-10-29 directory.
The user explicitly requested necessary checks and immediate GitHub/Vercel/Railway
publication; no broad all-route/performance certification is claimed.
