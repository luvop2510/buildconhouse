# Go-down stock pagination and image response consistency — 24 October 2026

Status: local implementation; not published. Functional and performance evidence
are separate. This does not close the all-floor performance investigation or the
stock reconciliation goal.

## Behavior

The stock screen now requests 60 lots with server-side literal search and brand
filtering. Floor totals and brand totals cover the whole active inventory;
available/unknown/zero counts describe the filtered result. Loading another page
appends rows without discarding an existing card draft. Same-query refresh reloads
the already-open window in bounded groups of three page reads. Floor and query
generation checks reject obsolete responses.

Initial stock responses exclude allocation and customer-transfer arrays. Opening
history requests the exact lot on the selected floor, with independent loading,
retry and continuation. An unavailable history read does not disable stock
transfer. Each continuation returns up to 60 allocations and 60 transfers.

Inventory and movement exports fetch the complete filtered selection explicitly,
instead of exporting just the visible page. Existing no-limit callers remain
compatible. The complete export path rejects results above 2,000 lots or 2,000
customer transfers rather than silently truncating them. Inventory-only exports
skip customer-transfer reads. Opening quantities are labeled received / counted
opening balance, preserving their distinction from supplier receipts.

Quantity and price updates apply deltas to the whole-floor summary; they must not
recalculate that summary from the first 60 rows. The new-stock route can resolve
its exact lot outside the initial page.

Detail, price/details update and quantity-count responses now resolve missing
images through the same exact-product catalog fallback as list responses. Before
this change an edit could replace a displayed fallback with the stored empty
image. Fallback resolution does not write a guessed photo into the lot, does not
borrow another floor's media and preserves explicit lot overrides.

## Evidence

The hermetic backend suite passed 107 tests, including disposable-Mongo tests of
1,230 active lots, complete page traversal, literal punctuation, filtered counts,
whole-floor totals, archived/foreign-floor exclusion, history continuation and
exact-image response consistency after edits/counts.

The synthetic legacy response measured 2,973,132 JSON bytes; its first 60-lot page
measured 24,524 bytes. This demonstrates a bounded payload, not production latency.
The local sample was 131.75 ms; it is not a hosted or load-test result.

Nine new browser cases passed across desktop, tablet and phone. They check
60-row transport, pagination through the last row, retained price drafts,
server-side search, whole-floor count updates, a complete 150-lot export and
independent history error/retry/continuation. Stock hook tests passed 10 cases,
including duplicate pagination admission and obsolete floor responses.

The first focused four-device performance run passed Android Chrome and failed
iPhone Safari, iPad Safari and desktop Chrome. iPhone was still checking floor
access; measured initial render was 7,342 ms on iPad and 3,835 ms on desktop,
above the unchanged 2,500 ms budget. Other browser/build audits were active on
the host. This is a possible confounder, not proof that the failures are harmless.
Original failure evidence is retained in the review output directory. No deadlines,
retry counts or acceptance criteria were relaxed.

A subsequent single-worker diagnostic, after this run's functional/static jobs
finished, still failed Android (4,025 ms), iPhone (3,408 ms) and iPad (3,883 ms)
first render. Desktop passed at 2,296 ms with a 742 ms server-search interaction.
The same 200 ms fixture latency and 2,500/1,500 ms deadlines applied. Another
chat's stability audit remained active, so this was not a fully isolated host.
The repeated failures make performance an open investigation; do not attribute
them solely to concurrency or claim pagination meets the four-device budget.

A later focused run with no competing audit passed all four profiles against
the frozen photo/pagination export: first render 1,599 / 1,884 / 1,679 / 1,573 ms
and search 880 / 930 / 904 / 839 ms (Android/iPhone/iPad/desktop). Earlier failures
remain evidence; a quiet-host fixture pass does not prove live all-floor latency
or substitute for full release acceptance. See the 25 October transfer report.

The surrounding stock-editor, quantity-count and runtime-stability run passed
50/51 browser cases. Its desktop imported-Won-customer navigation case exceeded
the existing 30-second test deadline; the captured page had reached stock and
displayed its first page. The failure remains part of the acceptance record.
An isolated, single-worker diagnostic of that exact navigation case subsequently
passed in 8.3 seconds with the same deadline and no code change. This explains
why timing interference is being investigated; it does not erase the failed run
or replace complete stability acceptance.

TypeScript and focused ESLint passed. The fresh export completed. The first
bundle check collided with another chat rebuilding shared `dist/client` and
found no exported pages. Running the unchanged budget checker against this
run's frozen export then passed all 187 pages: largest 483 KiB gzip versus the
576 KiB budget; stock 478 KiB. `git diff --check` passed. Desktop, tablet and phone
stock screenshots were inspected; this is existing card-layout verification,
not acceptance of the remaining compact-list redesign or real photo coverage.

## Limits and remaining acceptance

Offset pages do not promise a frozen snapshot while other users insert/move lots.
Complete exports retain their explicit existing size ceiling. Aggregate summary
reads still scan the selected floor's active stock; production query plans and
latency remain to be measured. Lazy history bounds transport, while embedded
allocation history remains stored on its lot.

Publication requires the full unfiltered performance/stability audit, source
review and the existing hosted acceptance gates. Focused checks alone are not
publication acceptance. No deployment, production data change or workbook import
was performed. Missing photo ownership, 360 unresolved source quantities, stock
units, current-balance reconciliation, general stock adjustments and other write
paths remain separate work.

Evidence is under `outputs/godown-review-2026-10-24/` in the parent workspace:
`paging-backend.log`, `paging-new-browser.log`, `paging-regression.log`,
`paging-performance-results.json`, `paging-performance-diagnostic-results.json`,
their browser screenshots/traces, and `paging-budget-check/output/playwright/`.
