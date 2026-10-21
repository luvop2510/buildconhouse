# Kitchen: nine connected stage pages

The Kitchen Floor contains exactly Lead, Visit, CAD File, Design, Quotation, Order, Production, Installation and Completed. These are the primary pages at `/kitchen/stages/{stage}`. Old Overview, Projects and Workflow routes redirect to Lead; old Completed redirects to Completed. The old New/Settings routes open their controls within Lead. Other floors keep their existing pages. Shared business-page bookmarks redirect before mounting their Kitchen business reads. Personal account security remains in the account menu outside the floor pages.

Each page lists its stage's projects with server-side search, status/assignee/date filtering and pagination. Stage-specific fields appear in desktop tables and phone cards; Completed includes the confirmed amount, completion date, revision total and actual site-visit total. The embedded workflow board uses the same project records across all nine columns, with a compact stage selector on phones. It does not allow unrestricted dragging or skipping.

Selecting a project opens its current stage immediately. Documents, history, assignments/dates and owner changes are panels. Previous stages are read-only, and future-stage history entries cannot be used to skip work. Customer/project identity and drafts are retained; exits ask before discarding unsaved work.

## PDF field and workflow coverage

- Lead: identity, customer/name/phone, site, source, kitchen type, budget, notes, manual assignment, date and New/Contacted/Qualified/Lost. New customer intake happens here and reuses a matching floor-local phone without overwriting shared customer details. Possible duplicates require review.
- Visit: showroom date, manual assignment, display/model, requirements, budget discussion, notes, Scheduled/Visited/Follow-up Required and next action. Showroom visits do not increment installation visits.
- CAD File: received Yes/No, design progress 0–100, Not Started/In Progress/Completed and notes. No actual CAD upload, attachment selector or company-quotation handoff exists here.
- Design: presentation, customer approval, automatic customer-requested revision count, approved-version handoff/date and notes. Internal corrections do not inflate the counter; superseded approval is not shown as current during a pending revision.
- Quotation: receipt, amount, document, sharing/date, response and notes. Revised versions preserve earlier quotation records.
- Order: approved quotation linkage, confirmation/date, agreed amount/document, advance receipt/amount, status and notes. Commercial changes preserve earlier terms and require fresh approval.
- Production: status, start/completion dates and notes only.
- Installation: status, start/completion dates, actual recorded site visits and notes. Duplicate submissions cannot inflate the counter.
- Completed: automatically populated after completed installation and configured closure; search, completion-date filter, export and complete history.

Existing documented owner decisions remain in force for the configured manager approval steps and required order conditions. Assignments remain explicit and backend-enforced; no employee is automatically tied to a stage.

## CAD clarification (21 October)

The owner's latest instruction supersedes the earlier CAD attachment allowance. DWG/DXF and their MIME aliases are no longer accepted by Kitchen, including generic/spoofed types. CAD-stage ordinary and multipart-transfer writes are rejected on the backend. Previously stored historical metadata/files remain readable; no existing business attachment was deleted. Design/quotation/order documents retain private access and immutable version history. Transfer correctness fixtures now use PDF files.

## Verification at implementation checkpoint

- Full hermetic backend unit suite: 3,073 passed, no failures/skips; three existing deprecation warnings.
- Focused CAD/inline intake/persistence: 109 passed, including 46 real-Mongo integration cases in a disposable loopback database.
- Actual exported UI/API/Mongo workflow: 52 passed across desktop Chrome, Android Chrome, iPhone Safari and iPad Safari. Includes the full cycle, approvals/revisions, exact counters, stale saves, assignments, exit protection, secure PDF upload and interrupted 25 MB transfer.
- Independent route/interaction subset: 8 passed; shared-floor navigation subset: 46 passed at desktop/320 px.
- All existing frontend CI contract commands passed; TypeScript, zero-warning lint, native-file contracts and read-only publication boundaries passed.
- Follow-ups release blocker fixed: optional asynchronous mission content no longer moves summary controls mid-press; 16 focused checks across eight profiles passed.

The last CAD-panel feedback, empty-board rendering and active-stage navigation corrections are included in source. Fresh full mandatory stability/performance audit and final route matrix must certify the publication head; earlier subset results do not replace them. Signed native devices, hosted behavior and owner acceptance are separate.

Publication is requested to the existing GitHub/Vercel/Railway targets. A trusted earlier user response in chat `01a15b3b-d46b-7d00-8f07-0eb1100c142c`, turn `01a15dff-7167-73b0-a171-d76fbd4933bd`, explicitly authorized the same Kitchen release despite the failing dependency-security gate and missing independent review. GitHub protections remain intact; no false green or merge approval is created. Backup/private-object recovery, rollback preparation, mandatory push audit and actual hosted verification remain required. Deployment evidence is recorded separately; this document does not claim publication.
