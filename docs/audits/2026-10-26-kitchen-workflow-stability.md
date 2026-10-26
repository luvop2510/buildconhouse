# Kitchen workflow stability and compact stages — 26 October 2026

## Scope and findings

Work starts from `182a8dcabb335bc611606eab36fbe9fabb63a516` in the isolated
`codex/kitchen-workflow-stability-2026-10-26` worktree. Other dirty checkouts are
untouched. This change has no backend, schema, migration, dependency or production
business-data changes.

The reproduced keyboard failure was clipping inside the page scroll area, rather
than a remount or crash: after a 390×844 → 390×450 resize, a three-line focused
field extended below the scroll viewport while its original DOM node, focus and
value remained intact. The previous reveal check only considered visualViewport.
An oversized textarea also exposed Chromium's nearest-scroll alignment: its bottom
caret remained clipped even after short notes were fixed. Reveal now intersects
clipping ancestors; short notes grow/shrink, and long notes scroll internally within
a viewport-aware maximum height. Viewport scrolling does not initiate corrective
scrolling, pinch zoom remains unchanged and phone chrome retains its geometry.

Save-response reconciliation previously replaced drafts or acknowledged the latest
local value, including keystrokes typed after a request started. Commands now
capture request snapshots, preserve newer typing, rebase their own acknowledged
source and reject obsolete responses. Explicit reload of a newer external source
retains the draft and stops autosave until the user reviews it. Admission is
synchronous and duplicate command attempts cannot race.

## Final interface and save rules

All nine stage pages open with a compact row containing Back, the stage name and
Details. Project ID, customer identity, secondary tools and Previous/Next navigation
are hidden in expandable Details. Changing stages closes it. Expanding/collapsing
details retains the form. The removed summary grid, assignment card, stage preview
box, repeated headings and saved summaries do not appear above editable forms.
Unique historical records and authorized operations remain available.

Order has one approved amount, compact confirmation/status disclosures, one open
date/notes form, and secondary original terms and quotation change. Advance and amendment
controls are removed from the main Order task, including their collapsed buttons.
Advance is under Details → Actions → Advance details; amendments remain under
owner project changes. Site visits are removed from the Installation task and
available only under Details → Actions → Site visits. Original quotations, documents, before/after history, permissions,
chronology, customer approval and manager approval remain distinct.

Supported routine lead/visit details, CAD notes, order date/notes and target date
save after 700 ms with Saving/Saved/Failed and retry. Saved requires the displayed
value to match the accepted saved record. Changes to reference/status/progress,
financial terms/payments, approvals, design/quotation version operations and work
status retain explicit actions. Those APIs bundle consequential fields, so this
change does not silently autosubmit them. Navigation within the project retains
memory drafts; exit/refresh warns about unsaved changes. Forced browser close or
refresh after choosing discard does not provide durable draft recovery.

Every editable blank Kitchen date selects India today automatically when the
control mounts. Both start and completion dates are selected on Production and
Installation without focusing or clicking either field. Functional sibling field
updates prevent one default from overwriting the other. Work calendars display
proposed defaults; saves retain the API rule that Not Started has no actual dates
and In Progress has no completion date. Only explicit Completed records both. Reopening a cleared
calendar can choose today again. Saved dates,
disabled historical dates and timestamps remain unchanged. Proposed quotation
dates record no receipt/sharing unless the user explicitly selects Yes; default
advance dates record no receipt unless explicitly confirmed. Defaults remain editable;
opening a date never records payment, approval, work completion or a site visit.
WebKit's date control emitted native focus without focusin on reopening a cleared
field, bypassing React's delegated onFocus. An actual event trace reproduced this;
the web control now binds native focus and retains the picker-click handler.
The handler reads the live control value, preserving saved dates while initializing
an explicitly opened blank. Native inputs retain their existing focus handler.

## Reproducible regression checks

Use the actual exported application → FastAPI router → run-owned disposable Mongo
harness, not mocked business persistence. It uses synthetic identities and refuses
non-loopback test databases. Build with dotenv disabled.

```sh
EXPO_NO_DOTENV=1 BACKEND_URL=https://kitchen-acceptance.invalid npm run build
npm run test:kitchen-autosave
npm run test:kitchen-commercial
npm run test:kitchen-dates
npm run test:mobile-ux
npx tsc --noEmit
npm run lint -- --max-warnings=0
FORGE_AUDIT_PYTHON=/absolute/path/to/existing/python node scripts/test-kitchen-e2e.mjs --reuse-export
FORGE_AUDIT_PYTHON=/absolute/path/to/existing/python npm run test:performance:audit
```

New tests exercise actual provider request snapshots and source conflicts, autosave
debounce/failure/retry/scope/unmount, slow response/newer typing, offline failure,
invalid chronology, persisted reload, explicit consequential decisions, all date
entry points, collapsed headers, long-note end/start/middle caret and every editable
stage. Widths include 360, 390, 768, 1024, 1440 and landscape; the route matrix adds
320, 430, 820, 1920, 2560 and Firefox. Negative controls reproduce the baseline
provider/keyboard failures. Browser emulation is not physical-device verification.

Final acceptance results and screenshot measurements are recorded below only after
the current source completes validation. Intermediate or interrupted runs do not
certify this implementation.

## Physical-device verification checklist

Still required on real Android Chrome and iOS Safari, using synthetic test data:

1. Open each of Lead, Visit, CAD, Design, Quotation, Order, Production and
   Installation. The main form must appear immediately; expand Details to find
   ID/customer, stage history, documents, assignment and stage navigation.
2. Focus a field near the bottom; open the software keyboard, type three lines,
   switch to the neighboring input, scroll up/down and close the keyboard.
   Focus/value must persist, the active field must stay above the keyboard and
   scrolling must remain usable.
3. Enter 35 lines in notes; edit at end, start and middle. Check internal caret
   scrolling, shrink/delete, portrait/landscape, enlarged text and pinch zoom.
4. Type during a slow save, then verify the newest text after reload. Go offline,
   retain failed entries, reconnect and Retry. Review conflicts from another edit
   before replacing a retained draft. Confirm refresh/leave warns on unsaved work.
5. Open blank dates in each form, including amendment/advance and filters; check
   India today, edit the date and reopen. Preserve existing/historical dates.
6. Verify customer confirmation, order status, amendments, payments, manager
   approvals and work/stage changes still require their explicit authorized actions.

## Release gates and rollback

Verified remote: `https://github.com/luvop2510/buildconhouse.git`. Main requires
backend, frontend, frontend-security and performance, strict current checks, one
independent approval and administrator enforcement. Its tip predates the existing
Kitchen feature history; do not blindly rebase this change onto that old baseline.
The installed pre-push hook requires the full current performance audit; no bypass.

Actual providers are Vercel (`buildcon-house`, team `yug19`) and Railway (BuildCon
House Backend / `forge2.0`), not Render. Read-only runtime inspection identified
Railway deployment `c536eac0-1822-4325-9a9b-b9a7fba5ce08`, verified 302 runtime files,
Mongo connectivity/index readiness, private storage and no pending migrations.
These observations describe the existing production runtime, not this candidate.

Production publication awaits physical-device acceptance, the existing six high
npm advisory entries (node-forge/Zod through Expo/Sentry chains), required checks,
independent review and the user's deployment approval. No advisory suppression or
historical one-release exception is reused. No production deployment is claimed.

Rollback is a source revert of this focused frontend commit, followed by the same
build/acceptance and verified Vercel candidate/promotion procedure. No database
rollback is needed. The prior accepted frontend deployment must be recorded before
any promotion; keep the verified Railway runtime unchanged for this frontend-only
change unless a separately reviewed compatible backend release is required.
