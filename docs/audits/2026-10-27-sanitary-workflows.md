# Sanitary workflow repairs — 27 October 2026

Worktree: `outputs/sanitary-workflow-fixes`, branch `codex/sanitary-workflow-fixes-2026-10-27`, based on `6e4016a2` (the latest sanitary Excel and dispatched-register work). Production has not been changed by this work.

## Behavior and causes

| Reported issue | Root cause and final behavior |
| --- | --- |
| Walk-in owner shown as salesperson | Intake defaulted to its owner creator, independently of floor team assignments. Sanitary intake and reads now use the selected floor worker. Existing canonical assignments override stale fields; owner-only legacy records display Unassigned until assigned. |
| Unwanted walk-in actions | Sanitary details keep Call, Visit Showroom, WhatsApp and Mark Lost. Mark Contacted and Mark Converted are removed. Other floors retain their existing controls. |
| Lending four blocks the other eighty | The old transfer promised the entire recipient purchase line and stage movement rejected any promised line. New loans isolate their exact reserved quantity, require a matching recipient product in PO Final and leave unreserved units movable. Existing mixed lines retain a path to separate the free quantity. |
| Replacement return is unclear/unavailable | Replacement units carry a specific return obligation. Once in In Box, the reserved line offers Return to the original customer. The transactional, repeatable return restores the source reservation and marks the matching loan history returned; the borrowed quantity remains operational for its recipient. |
| Order value and outstanding disagree | The customer card used outstanding material value, rather than the unpaid commercial balance. It now reads outstanding_balance, preserving actual payments and credits. These amounts match when unpaid; received payments legitimately reduce outstanding. |
| Excel cover logos | Original drawings depended on differing crops, legacy image metadata and inconsistent dimensions. The template now uses explicit PNG logo pixels and fixed one-cell anchors with preserved aspect ratio, aligned in two rows above the quotation text. |
| Mixed number systems | Shared money helpers and customer notifications use Indian digit grouping. Compact values use lakh/crore; smaller amounts keep grouped rupees. Quotation Excel currency cells pin the Indian locale and grouping while preserving numeric values and formulas. |
| Pending and Sent quotation tabs | Removed from the pre-order quotation list; existing pending/sent documents appear under Draft without changing their saved lifecycle data. |
| Uneven godown transfer buttons | Removed vertical stretching from the action area so cards use consistent button heights. |
| Bank transfer shown beside payments | Payment history rows show the recorded amount without a method prefix or method column. Payment entry still records its actual method. |
| Draft follow-ups missing | The existing reconciler discarded quotations without product rows. Customer-linked sanitary drafts, including empty drafts, now receive the existing seven-day reminder. Unplaced approved quotations are covered too. The source is labelled Quotation draft, and ordering retires the reminder. Existing automation evaluates at its normal five-minute interval. |
| Follow-up clutter | Sanitary removes summaries, mission, KPI/priority scores and priority/type/owner filters. It retains customer search, actionable reminders, contact timing and one Salesperson filter/assignment label. Removed filters cannot return through saved views. Other floors keep their existing summary functionality. |

## Verification

Completed checks: 3,349 backend unit tests; 28 disposable-Mongo purchase register/completion cases; seven real-replica loan cases; 15 focused sanitary browser cases across desktop Chrome, phone Chrome and phone WebKit. TypeScript, changed-file zero-warning lint and the money/purchase/stock/mobile/quotation/export contracts pass. The full unit suite includes the Excel/money route and formatting regressions.

The real-replica loan suite is also wired into the existing CI integration job, using its isolated replica before cleanup. Both local subprocess and explicit externally supplied replica modes passed seven cases without skips; invalid or missing configured CI infrastructure fails rather than skipping.

Final command results and rendered artifacts are recorded in `output/sanitary-workflow/` and `output/playwright/`. Tests use hermetic CI configuration and disposable local Mongo processes, never the business database.

The workbook was opened and converted through LibreOffice, then its first page was visually inspected. Its logos fit without overlap and a numeric value of 12345678.9 renders as ₹1,23,45,678.90. `Sample Quotation.xlsx`, `Sample Quotation.pdf` and `quotation-cover.png` contain synthetic sample data only.

Browser regression cases cover worker intake, simplified quotation tabs, sanitary follow-up content/filtering, payment history, free stock dispatch and return retry. Existing summary interaction tests now exercise Ground, where those features remain. The new sanitary follow-up scenario is mandatory in the stability registry.

Additional focused UI acceptance: six presentation cases pass across desktop Chrome, phone Chrome and phone WebKit. Transfer buttons remain exactly 48 px tall on cards with different content heights. The customer Purchases screen shows ₹7.82 L for both Order Value and Outstanding on an unpaid order even when material cost is ₹7.43 L; recording ₹39,000 changes Outstanding to ₹7.43 L and preserves Order Value at ₹7.82 L. See `output/sanitary-workflow/presentation-browser-final.json`.

Final full performance audit passed: **708 stability checks** across Android Chrome, iPhone Safari, iPad Safari and desktop Chrome; **60 performance cases**; zero failures, skips or flakes. The verifier confirms all 91 discovered routes and every mandatory scenario. All **187 exported pages** pass the JavaScript budget; the largest is **491 KiB gzip**, below the unchanged 576 KiB limit. Evidence: `output/playwright/stability-summary.json`, `performance-results.json`, `performance-summary.json`, `bundle-budget.json`, and `output/sanitary-workflow/performance-audit.log`.

The implementation is saved in local commit `ba49926f`. The initial audit was intentionally interrupted after subsequent stock request-scope corrections and replaced by this complete audit of the final source. Earlier logs are explicitly marked superseded. No retry or budget relaxation was used to obtain this acceptance.

## Publication boundary

This is a local implementation and verification record. It does not certify a production release or physical-device behavior. No business-data repair, migration, customer communication, stock reset or production publication has been performed. The release must include both frontend and backend changes so the new return action and corrected balance field agree.
