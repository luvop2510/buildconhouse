# Stock customer-transfer recovery — 25 October 2026

Local implementation; no frontend/backend publication or business transfer was
performed by this work. The earlier exact-photo storage/link restoration is a
separate, verified live repair.

## Problem and behavior

Customer transfer errors previously appeared only in a toast behind the sheet.
The same initialization effect also reset the form and command identity when
retrying recipient metadata. Requests inherited the global floor, and React
state alone prevented repeated submissions. The sheet waited for a list refresh
before closing, leaving “Transferring” visible after a confirmed write.

The sheet now captures its actor/floor/lot context and sends that concrete floor
with customer, PO-match and transfer requests. A synchronous command guard rejects
repeated clicks. Old-floor handlers cannot start a write, and late completions
cannot refresh or dismiss another floor's sheet. Returning to the same unresolved
command reconciles its pending completion. Unmount suppresses late UI callbacks.

Metadata retry preserves the entered recipient, quantity, price and reason.
Transport errors and server timeouts show inline recovery and retain the exact
body/key while fields are locked. Closing and reopening the same lot on the
mounted stock screen restores that pending command. Definite rejections permit
correction with the same key, preventing a racing original from becoming a second
transfer. Pending writes cannot be dismissed. Confirmed writes close immediately;
the stock list independently shows refresh and retry state while preserving drafts.

New backend receipts include an actor/stock/full-request hash written inside the
existing transfer transaction. Reusing that key with changed new-customer details,
reason or other fields returns a conflict, instead of incorrectly replaying a
different transfer. Existing receipts retain their older compatibility comparison.
The hash is excluded from public list/history/transfer/return responses.

A committed request with different details returns its sanitized actual receipt.
The sheet shows the recorded quantity, recipient, receipt and date, locks the
corrected form, and requires acknowledgement before a new intent can receive a
new key. Closing/reopening preserves this review. Acknowledgement refreshes the
list and closes the sheet; it does not perform another transfer.
The review hides the unsubmitted draft form and its stale balance, so those
figures cannot be confused with the committed receipt. Its caption explicitly
states that the balance refreshes after acknowledgement.

## Verification

Eight hook/race checks pass: synchronous double submission, explicit floor,
uncertain close/reopen, preserved metadata retry, definitive rejection/correction
with the same key, obsolete-floor handlers, A → B → A pending completion,
committed-conflict acknowledgement, failed post-confirmation refresh and unmount.
These assertions run in eight test cases over the actual component hooks.

The focused backend suite passes 26 tests, including full request/actor binding,
sanitized conflict receipts, transfer replay/arithmetic and disposable-Mongo
paging/history regressions. TypeScript and focused lint pass; the fresh export
completed. The final combined transfer-recovery and stock-editor run passed 52
cases across desktop, tablet, phone and WebKit, with zero retries. All 187 frozen
export bundle checks passed (largest 483 KiB gzip, budget 576 KiB). Recovery
screenshots were inspected at desktop/tablet/phone sizes. An independent static
review identified and resolved both indefinite-rejection and committed-conflict
recovery gaps; no further issue was found in that revised path. Unmount/reload
persistence remains explicitly open.

The new transfer scenarios are required by the four-device stability config and
its coverage registry. `test:stock-floor-races` also executes the new command
recovery hook suite. The stability gate's own contract test passes without
weakening deadlines, skips, retry or coverage rules.

## Limits

The pending-command ledger is currently held by the mounted sheet. Navigating
away, reloading or restarting the app still discards unresolved commands.
Durable identity-scoped command persistence/status recovery remains required
before claiming reload-safe stock transfers. No actual customer or purchase was
created to test this change. These focused checks do not replace the full
unfiltered performance/stability audit and hosted acceptance before publication.

## Focused performance diagnostic

An independent run with no competing audit observed stock first render at
1,599 ms Android Chrome / 1,884 ms iPhone Safari / 1,679 ms iPad Safari / 1,573 ms
desktop Chrome. Server-search interaction measured 880 / 930 / 904 / 839 ms,
respectively. All four pass the unchanged 2,500/1,500 ms fixture budgets. This
run uses the earlier photo/pagination frozen export and 200 ms API fixtures.
Earlier failed samples are retained. It does not prove live all-floor latency,
all-page performance, or acceptance of this later transfer change.

The final transfer export subsequently also passed the same four-device focused
check: initial render 1,557 / 1,712 / 1,609 / 2,009 ms and search 840 / 875 / 852 /
854 ms, respectively. Its final browser acceptance remains 52/52, including the
simplified committed-receipt review, with desktop/tablet/phone screenshots
inspected. No unrelated browser/build audit was active during this timing run.
The complete unfiltered release audit and deployed acceptance remain outstanding.

Before durable client recovery, an additional deletion/replay prerequisite was
implemented: minimal non-customer completion receipts in settings commit in the
transfer transaction and survive deletion/redaction of transfer history. Retry
then returns a sanitized HTTP 410 completion for acknowledgement, preventing
customer recreation or a second stock deduction. Legacy recognized command keys
receive the marker in the deletion transaction. Corrupt/mismatched evidence
aborts deletion. No customer name, contact, submitted body or customer ID is kept
in the terminal record. New-customer email/blank-name and nonfinite numeric inputs
are rejected before the write transaction. Focused acceptance passes 52 backend
cases, including actual replica deletion/replay/rollback/race/scope cases.
The full backend unit suite subsequently passed 3,151 cases. These changes remain
subject to release acceptance; durable client persistence remains unfinished.

Evidence: `transfer-browser-accepted.log`, `transfer-backend-final.log`,
`transfer-hooks-final.log`, `transfer-accepted-bundle-budget.json` and
`transfer-accepted-performance-results.json` in the parent review output folder.
