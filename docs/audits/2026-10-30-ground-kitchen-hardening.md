# Ground and Kitchen hardening — 30 October 2026

Scope: existing Ground/Tiles and Kitchen behavior, shared keyboard/forms and
private downloads. No new business features. Starting source was
`8562bfa1988fd04be3e0b83d2990c7386ba22f4a`, matching the canonical production
alias and `origin/main` at investigation time. Unrelated `tmp/sales-analytics/`
work is preserved.

## Reproduced defects and repairs

| Defect | Root cause and repair | Regression evidence |
| --- | --- | --- |
| Focused nested form stays behind keyboard | Reveal intersected descendant scrollport bounds while moving an ancestor, producing an empty visible intersection. Resolve local inner clipping and then ancestor movement without panning the document. | Two geometry cases failed before the fix and passed afterward; required four-device keyboard suite includes a real DOM case with a deeply offscreen field, stable node/focus and draft checks. |
| PDF/download control remains busy indefinitely | Credential hydration, fetch and binary/error readers had no deadline and could ignore cancellation. Bound preparation to the existing 30-second request limit, abort transport, settle its caller, observe late failures and retain retry guidance. The fresh-tap save/share dialog has no preparation deadline. | Eight stalled credential/response/body/error-body scenarios cover timeout and identity cancellation; already-aborted and synchronous credential failures cannot produce unhandled rejections or late downloads. |
| Kitchen selected file continues across account changes | Upload preparation and transfer acknowledgements lacked the identity generation guard used by downloads. Bind the complete upload lifetime to its initiating identity and stop before further writes/publication after invalidation. | Actual native/web client identity lifecycle with A→B→A across byte/hash/begin/part/finish gaps; original bytes/hash and retry receipts remain checked. |
| Reloading reopened Installation erases unsaved entries | A Completed→In Progress saved-state effect replaced the entire draft. Rebase untouched saved fields while preserving locally edited notes/dates/status. | Actual form regression failed before repair; real API/browser scenario reloads externally reopened work and retains unsaved notes and dates. |
| Ground stock commits without permanent movement history | Release, move-to-godown, both dispatch sources and Delivered wrote register rows after the stock transaction. Move register writes into that same session. Optional activity remains best effort. | Ten unit cases and ten real-Mongo success/failure cases; injected failure after the actual register insert rolls back all related records and counters. |
| Ground brand queue grows with every page | Load more appended each page inside the page scroll owner. Retain one 30-row page, acknowledge page changes after success, coalesce requests and cancel obsolete scopes. Failed pages retain the acknowledged rows and retry their intended page. | Hook tests exercise coalescing, stale completions, failure/retry and effect replay; required four-device populated browser case verifies 30-row bounds and Previous/Next behavior. |
| Kitchen Add lead is clipped on narrow phones | The nested toolbar kept its intrinsic width despite its parent's wrapping policy. Constrain the nested action group to the available width so complete buttons wrap instead of clipping. | Visual review found clipping at 320px while the document-overflow assertion still passed. A new full-tap-target bounds assertion failed on the original export and checks phone/tablet/landscape/desktop widths. |
| Ground API accepts infinite labour charges | Positive infinity passed the two dispatch request models and could enter quotation/payment/customer totals. Require finite nonnegative labour costs at request validation, preserving normal decimal input. | Six real HTTP regressions reject string `Infinity` and numeric overflow `1e309` with sanitized 422 before any transaction starts; six finite zero/decimal compatibility cases remain accepted. |

The implementation changes shared primitives or the failing workflow boundary.
It preserves current floor/role restrictions, original document/version links,
idempotency receipts, drafts, existing workflow decisions and performance budgets.
Cleanup is limited to the affected paths; no bulk rewrite of working screens was
used as a proxy for hardening.

## Verification record

The starting backend unit suite passed 4,005 tests. The repaired source passed
4,015 backend unit tests, zero-warning lint, TypeScript and Expo Doctor 20/20.
After the finite labour-cost follow-up, the full backend unit suite passed
4,027 tests.
All 55 frontend commands in the existing CI contract step passed; changed
contracts were rerun after the final edits. The isolated Ground/Kitchen Mongo
suite passed 76 cases, and the expanded Ground lifecycle suite then passed
11 cases including the ten new movement transaction checks. Test databases and
their run-owned local replicas were removed afterward.

The dependency gate reported zero high/critical/moderate and eight low findings;
none were suppressed. Existing FastAPI/HTTPX and pytest-asyncio deprecation
warnings remain dependency/tooling observations.

Final browser/performance and publication outcomes are recorded in the release
receipt and follow-up verification below. The first browser gate attempt could
not bind an already occupied local port 8099. The full unchanged gate was
restarted with `FORGE_STABILITY_PORT=8129 FORGE_PERFORMANCE_PORT=8128`; no existing
process was stopped and no budget, retry or error-reporting policy was changed.
The standalone run was subsequently replaced by the identical mandatory pre-push
gate. That partial pre-push attempt was stopped when visual review discovered the
narrow-phone toolbar defect. Partial/interrupted runs are diagnostic evidence,
not release acceptance; the final pre-push gate and Kitchen suite use the repaired
export and must complete without retries or skips.
The API admission follow-up changes only Ground backend request fields; Kitchen
and frontend source bytes remain identical to the `440f7c00` export used by its
full persistence suite. The final backend unit suite and complete pre-push gate
are rerun after that follow-up.

Independent reviews covered shared keyboard/download handling and cross-reviewed
the Kitchen and Ground fixes. Their reported issues were reproduced and resolved
before final acceptance.

## Acceptance limits

Browser engines emulate Android Chrome, iPhone/iPad Safari and desktop layouts;
they do not open a physical operating-system keyboard. Physical phone/tablet
keyboard, predictive typing, external keyboard, signed-native builds and customer
networks remain separate acceptance surfaces. Fixture timing isolates application
work and cannot certify production transit or every future data shape.

This audit establishes the outcomes of the executed checks on this revision.
It does not establish a permanent zero-defect guarantee or eliminate ongoing
dependency maintenance and operational verification.
