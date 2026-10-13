# Team passwords, customer workflows and mobile quotations — 13 October 2026

Owners provide initial team passwords. Staff can subsequently change their own
password with current/new/confirmation fields, including delegated and department
profiles. Team creation, reset, role management, deletion and credential viewing
remain owner-only. Login retains bcrypt; an owner-only, explicitly invoked,
no-store, audited endpoint reveals a recoverable encrypted copy. Encryption is
bound to the staff identity and derives a separate key from the existing configured
MFA encryption root (JWT-secret fallback). Initial, changed, reset and controlled
owner-reset credentials all stay synchronized. Existing hashes cannot be recovered:
legacy members show Reset required until a reset or self-change. Keep the existing
root stable; no credentials or environment files are published. Ordinary account,
login and Team responses exclude ciphertext and hashes. Authentication rate limits,
64 KiB credential-request bounds, stale-write guards and session revocation remain.

Routine walk-in, Follow-ups, dashboard and department-notebook actions no longer
ask for a note or accept note writes. Only explicit Lost requires a reason;
Rejected normalizes to Lost. Cannot-afford/unworkable reasons are recorded through
that action. Existing historical notes remain readable. Quotation optional note
editors are also removed; product descriptions and commercial terms remain.

Visit Showroom persists a stable follow-up identity and transfer timestamp. The
walk-in register, counts and analytics exclude transferred records permanently,
and their former register edits are rejected. Retry-safe transitions preserve the
existing follow-up's completion and avoid duplicate/reopened reminders. The
background walk-in producer also excludes transferred customers.

The user confirmed that an interested transferred lead belongs to the receiving
member, while only actual placed orders count as won. Interest preserves recipient
ownership and schedules a recipient follow-up. Own orders replaces Won orders and
uses the current member's assignment by default, including the fallback UI read.
The committed order transition attributes won sales to the quotation creator and
links same-floor/customer unlinked showroom/walk-in sales to that placed quotation.
Payment, purchase and operations reminders remain actionable. Migration 0033
repairs existing confirmed-sale attribution, retaining notes and completion dates;
unlinked historical sales require exactly one matching placed order and ambiguous
history is preserved.

Purchases and completed-customer reads explicitly carry their selected floor.
Callbacks check the current floor before starting and publishing work; stale
successes, failures and retained callbacks cannot replace another workspace.
The backend purchase dependency resolves a missing floor header to one concrete
assigned floor instead of combining all assignments. All four department scopes
are tested, with existing grants and deny-all behavior retained.

Phone quotation browsing opens in full screen. Brand/category/size/sort controls
move into a filter sheet; brand and category retain single-choice behavior and
category error/retry. Search, product addition, variant choice, inline editing,
rooms, totals/discounts, reorder, custom products and quotation review remain
available. The custom-product action exists in both the browser and picker, with
inline or catalog-save choices, larger inputs, protected submission, finite price
and MRP validation, and preserved descriptions. The explorer remains mounted
across focus/review changes. Product/footer spacing and shared phone header/dialog
padding are improved without changing desktop layouts or pagination budgets.

## Verification and release record

Verification results and deployed provider identities are appended after the final
checks. Tests use hermetic backend settings and fixture-only browser servers;
production smoke checks are read-only. The optional route-drift check has no
configured baseline. The unchanged independent npm gate reports 22 high and five
moderate findings. Protected-main review/check requirements remain enforced;
publication uses the existing review branch and PR 16. Direct deployment of the
tested source to the linked Vercel and Railway production services is explicitly
authorized by the user and does not waive GitHub's merge gate.

Early runs are diagnostic, not acceptance. The first performance run overlapped
with focused browser suites and had four budget failures (36 passes). A standalone
run had one iPhone full-catalog content sample of 2,596 ms against the unchanged
2,500 ms ceiling (39 passes); all builder cases passed. These reports and the
second run's traces are preserved locally under output/playwright/team-performance-*
for comparison. Subsequent required pre-push verification rebuilds the final
committed source; no retries, larger budgets or suppressed runtime errors are used.
Early focused browser output-directory collisions were corrected by isolating
artifact paths; definitive suites run against the final web export.

Final functional acceptance: 2,326 backend unit tests, all 42 required frontend
commands, TypeScript and zero-warning full lint pass. The focused desktop/phone
workflow, role and floor suite passes 195 cases; the remaining Team contact
end-to-end case passes unchanged in a standalone run (6.1 seconds). Its first
30-second deadline expiration included 6.6 seconds creating a browser page and
11 seconds in teardown, with all product assertions already satisfied; the trace
is retained. New purchase fixtures intentionally select Stock before expecting
item rows, and Own orders uses its actual tab role. An earlier interrupted run
had 110 passes/five fixture failures/two interrupted cases and is not acceptance.

Mobile builder acceptance: 70 cases pass across desktop, tablet, phone, small
phone and WebKit projects, with seven intentional viewport skips. The one
load-related supplier-switch deadline passes unchanged in a standalone pair
(2/2); the focused concealed-parts/mobile-shell regressions pass 14 cases with
two desktop-only skips. Phone authentication passes 26 cases and mobile WebKit
passes the three new credential cases. All nine builder viewport skips are
expected layout exclusions, not acceptance of unavailable physical devices.

Controlled migration 0033 is applied to the configured production database;
the subsequent dry-run reports no pending migrations. Fresh read-only Mongo,
required-index and Supabase bucket gates pass. No passwords or business records
were changed by smoke tests. No signed native/physical-device acceptance is
claimed.
