# Kitchen design, quotation and stage navigation

Quotation presents its finalized design PDF once, followed by the latest
quotation. Saved quotation and Related design selectors are removed. New
quotations bind the current finalized design automatically, including after a
return to Design with an unsaved quotation. Saved quotations retain their own
design links, and Order can still select earlier approved quotations.

Design retains its version selector, PDF preview, final selection and approval
controls. Repeated headings, instructional paragraphs, existing-upload PDF
selectors and the empty “Choose a PDF to add” hint are removed. Direct private
PDF uploads, GI/SS/Mix final selection, historical documents and production locks
remain available.

Quotation's proposed date depends on durable edit permissions rather than a
temporary upload lock. Otherwise the first PDF addition could initialize a draft
with a blank date while upload controls were disabled. The actual form regression
fails before this correction and passes afterward, including approval/save.

Kitchen commands overlap their independent project read and policy admission.
Policy remains pinned before mutation; project/current-task access, expected
version, atomic CAS and actor-bound replay checks remain unchanged. Failed
admission cancels and drains the outstanding read. A project changed during
admission still returns a conflict without overwriting the newer record.

With an artificial 100 ms delay per persistence operation, three sequential
command samples were 607.70/607.45/607.59 ms and overlapped samples were
506.33/506.14/505.57 ms: median reduction 101.45 ms (16.7%). This is a controlled
local benchmark, not a hosted latency measurement. Next/Previous continue to
wait for a successful save acknowledgement. Routine edits flush before movement;
explicit commercial decisions remain manual.

Verification:

- Full hermetic backend unit suite: 3,600 passed. The focused Kitchen suite
  includes overlap, failed-admission cancellation and concurrent-edit conflicts.
- TypeScript and Expo lint pass. Kitchen commercial, note, PDF, reconciliation
  and autosave checks pass, including the temporary-upload date regression and
  preserved blank dates for held/cancelled records.
- Forty focused browser cases pass across desktop Chromium, Android Chromium,
  iPhone Safari and iPad Safari using the exported UI, actual FastAPI routes and
  disposable Mongo. The initial run exposed the date issue; the corrected run has
  zero failures, skips or retries. These cases cover the edited pages, PDF uploads,
  older order basis, stage returns, draft retention and production locks.
- Dependency audit reports eight low findings and zero moderate/high/critical
  findings. This change adds no dependencies or schema/data migrations.
- Independent review found the held/cancelled default-date case; it is corrected
  and covered by a regression. No outstanding code findings remain.

The unchanged pre-push hook runs `npm run test:performance:audit`, which rebuilds
the current source and requires the full four-device stability and timing matrix.
Local ports 18099/18098 avoid an existing idle audit server on 8099; budgets,
concurrency, retries and coverage requirements are unchanged. Reports are under
`output/playwright/`. Publication and actual hosted navigation latency are
separate from these local checks.

Before editing, canonical `buildconhouse.in` resolved to
`dpl_41ZJnBvtX6H39JXEErDGYfKQteLo`, source
`628c568319d02ebe9eaf679aaa3867386fec8ecd` on main, matching the checkout and
remote main. This is the pre-change production identity, not a publication claim.
