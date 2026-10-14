# Floor workspaces and mobile Payments — 15 October 2026

Payments opens with a compact title on phones and a 48-pixel overview toggle.
The existing summary remains independently collapsible. Customer identity,
quotation actions and Record payment remain available. Expanding the header or
rotating the device preserves entered amounts, payment mode and reference.
Browser acceptance covers decimal validation, failed-save retries, idempotency,
successful balance refresh and history navigation as well as the new collapse.

Purchases, purchase-order details and supplier APIs now require Sanitary scope,
including owner requests and direct record links. Catalog navigation is limited
to Ground and Sanitary. Related customer, dashboard and product panels avoid
requesting the retired purchasing service in other floors; Ground retains its
independent Tile Orders flow.

Kitchen/Furniture use shared Walk-ins and the existing Follow-ups design.
Legacy department and quotation-follow-up bookmarks redirect without switching
the current floor. Follow-up details and deletion now check the selected floor;
existing actions already use floor-scoped queries. The frontend resets the inbox,
selection, forms and filters on floor changes, pins every mutation/export to its
origin floor, and rejects late results/contact callbacks after leaving it.
Won order wording preserves current-member attribution. The duplicate quotation
100% view is removed on Ground/Sanitary; legacy fulfilled bookmarks use Completed
and Completed includes delivered documents rather than excluding them.

Migration 0035 adds shared Follow-ups only for active custom staff with both
same-floor notebook views and existing Customer view. Updates require both old
stage updates; creates also require regular Walk-ins creation. It never adds
delete/export, extends an existing allocation, or crosses floors. Derived grants
use the earliest contributing expiry. Inline user snapshots use compare-and-set;
legacy separate-collection grants remain audit-only. Preflight identifies three
eligible Kitchen allocations (one view-only, two view/create/update), with no
single-stage or legacy-collection allocations requiring manual changes. Global
automation/reconcile mutations cannot be authorized by these floor grants.

Retired pages are hidden from new Team assignments; existing grants survive
unrelated edits and remain revocable. Accounts with only retired/unsupported
pages land on the stable account access screen rather than a redirect loop.

## Verification and publication

Hermetic backend acceptance passes 2,877 tests. TypeScript and zero-warning lint
pass. Focused mobile/access acceptance includes 72 desktop/phone workflow cases,
77 seven-width retired-page/RNB cases and 42 additional payment cases completing
all eight payment browser profiles. A separate 40-case surrounding regression
run passes after updating stale session-recovery and mobile quotation controls;
portable screenshots replace machine-specific artifact paths.

The current-source release audit passes 524 stability cases (77 routes on four
profiles), plus 52 performance scenarios, without skips, failures, retries or
flakes. All 159 exported pages meet the 576 KiB initial-JavaScript budget;
the largest is 449 KiB gzip. All 43 configured functional contract commands
pass; the optional route-drift baseline remains unconfigured.

The required current-source performance audit also executes every discovered
route and populated runtime/session recovery cases on four browser profiles.
Payment entry/rotation and floor navigation/direct-link/switching regressions
are now mandatory in its evidence verifier. Deployment acceptance additionally
uses scripts/verify-floor-mobile-release.mjs for real floor-specific API reads,
cross-floor follow-up denial, navigation and compact payment layout, with no
business writes. Final audit counts, deployment identities and timings must be
recorded in the release ledger after these runs complete. Migration 0035 was
applied through the controlled job; verification confirms exactly three derived
Kitchen grants, no remaining planned grant changes and no pending migrations.
The staged candidate passed 19 API/asset/security checks and 32 real floor/mobile
read-only checks before promotion. The full pre-push audit remains required.
The final frozen-export supplemental run passes 120 floor/completion/Team cases.
One new Team assertion now checks the removed legacy row after revocation,
rather than waiting for the detached checkbox to remain unchecked. A hosted
Safari probe exposed a pending-read cancellation in the verifier itself: it
now waits for its own API reads before hard navigation and reload, resetting
tracking across contexts. No runtime-error filter or deadline is relaxed.

The independent npm audit still reports 22 high and five moderate findings,
with no critical findings. No dependency finding, hook, performance budget,
deadline or protected-main requirement is suppressed. Fixture/browser checks
do not certify physical devices or every customer network condition.
