# Go-down stock refresh recovery

## Problem and change

Every stock reload returned a full-screen spinner, unmounting the inventory subtree. Completing a customer transfer invoked that reload before closing its sheet. This discarded other lot-card price/photo drafts, and a failed read replaced the workspace with a full-screen error despite the transfer having completed.

The screen now retains its mounted subtree whenever its loaded inventory belongs to the selected floor. Refresh progress and failure appear inline, with a read-only retry control and explicit wording that displayed quantities may be out of date. Initial load/error behavior remains full-screen. Switching floors hides previous-floor rows even before the reset effect runs. Existing request-generation and retained-callback checks remain.

This changes frontend refresh behavior only. It does not establish that all reported API failures have been fixed. Write idempotency, quantity correction, current-source/live-stock reconciliation, image verification and broader reload performance remain open.

## Verification

- Nine actual-screen hook tests pass, including retained same-floor data during refresh/failure, successful retry, destination-floor loading, stale callbacks and match lookup races.
- Three purchase floor-race tests pass.
- All 18 stock editor browser journeys pass across desktop, tablet and phone, using two workers, zero retries and unchanged timeouts. They cover price/image changes, upload, large-stock search, unknown quantities, warehouse quotation handoff and refresh recovery.
- The new recovery browser case retains the exact price-input DOM node and its unsaved value across a delayed post-transfer read, failed response and retry, and asserts exactly one transfer write.
- TypeScript and focused ESLint pass. Fresh Expo web export succeeds. All 187 generated pages pass the unchanged 576 KiB gzip bundle budget; stock is 472 KiB and the largest page is 480 KiB. This is a bundle-size check, not hosted latency acceptance or the full publication performance audit.
- Eighteen backend workbook replacement tests pass using the existing `forge2.0/backend/.venv/bin/python` interpreter, current `kitchen-audit` test/source files and explicit hermetic CI settings. The `kitchen-audit/backend/.venv` symlink itself remains broken; no runtime dependency changes were made.

The browser server has no API proxy and rejects unintercepted API calls. The fresh local web package uses `https://audit.invalid` as its worker upstream for fixture testing and must not be published. No production writes, stock import or deployment were performed.

## Visual review

The existing BuildCon palette, typography and component structure were retained for this behavioral repair. No direction redraw or sample business data was introduced into application source. Browser screenshots use explicitly synthetic basin fixtures. Screenshots show the retained price editor at all three widths. Existing issues outside this patch include overly stretched card actions when an adjacent editor expands, heavy accent use and overly tall page framing. Those remain part of the broader inventory redesign.

The inline error must clearly state stale quantities and keep a visible retry control at desktop, tablet and phone widths. The browser recovery case captures that status after scrolling it into view. A full Design Taste inspector run and broad UI score are not claimed for this targeted repair.

## Source reconciliation

The offline supplied-workbook summary and source-cell exception list are saved outside the repository under `outputs/godown-review-2026-10-24/`. They contain 1,015 retained lots, 4,393 recorded units and 360 unresolved balances. Matching historic totals do not prove agreement with today's database. Stock date and pieces/boxes/sets definitions were requested before reconciling current balances. No unknown quantity is inferred as one unit.
