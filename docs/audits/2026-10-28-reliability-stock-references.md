# Kitchen, Purchases, stock and reference reliability — 28 October 2026

## Evidence and causes

The implementation starts at current origin/main 923578e1, also the source of
buildconhouse.in (Vercel dpl_CzsqTw4Tn16gVAMWdPgPiYHLWTV9). Railway's successful
production deployment is 899c6bfb-4e8f-4b87-804d-9c503230996b. Read-only SSH hashes
of five relevant running backend files match main, so this sample excludes a
frontend/backend source mismatch in those paths. Older dirty checkouts remain
untouched; the working checkout is main/ on the existing main branch.

Confirmed defects:

- Kitchen already has routine auto-save, but pressing Next before the 700 ms timer
  could cancel the debounce when the active stage changed. The provider now
  acknowledges routine Lead/Visit/CAD edits before moving with the latest version.
  Failed acknowledgement retains the draft and current stage; decision/progress
  changes retain explicit Save. No-edit Next still sends only its movement.
- Purchase rows waited for catalog preview hydration, including cold full-catalog
  warmup. Stages load separately, explaining a possible stages-only screen while
  the primary request waits or fails. Exact-product preview lookup now bypasses
  cold warmup and has a one-second optional budget. Failure preserves recorded
  images and primary rows, with a diagnostic event containing no customer data.
- Mounted Purchases screens loaded only when dependencies changed. Returning to
  them could retain obsolete results. Focus now revalidates stock and cancels the
  hidden read; facet results publish independently and reject older generations.
- Manual godown intake generated warehouse-only IDs without catalog insertion;
  no receipt/adjustment action existed for empty lots. New intake registers or
  reuses floor/brand/SKU catalog identity. Receipt and outgoing adjustments use
  atomic balance/reservation guards, expected versions, finite positive quantities,
  actor-bound replay receipts and dated history. Restocking a legacy manual lot
  registers catalog_product_id without rebinding its historic product_id, retaining
  saved quotation compatibility. Unknown legacy prices remain explicitly unknown.
- Reference detail read only confirmed sales while acquisition counts included
  pre-order people. Detail now pages the same deduplicated six-source cohort,
  including unconverted walk-ins, with an exact total and custom UTC date bounds.
  Kitchen names and confirmation labels use its authoritative order basis. Sales
  dates remain distinct from acquisition dates. Floor and directory privacy stay
  enforced before output.
- Mobile report headings/ranking amounts could force a row wider than its panel.
  They now shrink within available width; large web metric values may wrap. The
  existing shared surfaces, tabs, filters and currency separation remain.

Kitchen Follow-ups and global Notifications were still explicit navigation
entries. Both are removed as requested. The broad browser run also caught a remaining
Kitchen Follow-ups shortcut inside Sales Data; that card, the combined-unit
chooser option and current Kitchen follow-up counts are now removed too. Stored
referral history is retained. Retired bookmarks redirect before business
reads, retain the selected floor and avoid grant-only landing loops.

## Live investigation limits

Twelve current authenticated production reads returned 200: identity, Purchase
items/stages/brands, Kitchen projects and dashboard, twice each. Observed total
HTTP durations were 181–662 ms; this bounded sample did not reproduce the reported
minute-long incident. The temporary synthetic QA principal was removed and only
its own session revoked; cleanup was verified. No business records were written.
Five anonymous public-health and five direct-backend samples also returned 200.
The companion JSON retains only timings, status codes, build identity and migration
results. A provider log search returned no matching purchase sample; it is not an
outage census. These observations do not prove all historical timeouts share one
cause, and routine auto-save does not repair a network outage.

## Database and regression checks

Controlled migration 0040 adds non-unique (referrer_id, floor_id, created_at) read
indexes to the six acquisition sources. Production dry-run listed only 0040;
apply succeeded, all six definitions were verified, and the following dry-run
showed no pending migration. Business records and historical attribution were not
rewritten. Repeat-safety/conflict tests and actual disposable-Mongo checks cover
these definitions.

The new stock/reference database tests run in CI against its isolated Mongo
service. The four-device stability verifier now explicitly requires immediate
Kitchen Next, empty-stock receipt retry and custom-range reference detail. No
retry, deadline, skip, bundle-budget or runtime-error policy is relaxed. Large
movement exports reject overflow rather than truncate history; inventory-only
exports omit embedded movement arrays.

Current development evidence: 3,483 backend unit and disposable-Mongo cases pass
in a clean environment with the patched driver; focused permission/validation
cases also pass. Shared-Mongo CI mode passes its stock/reference scenarios;
TypeScript, zero-warning lint, Kitchen provider/API reconciliation, native/web
transport contracts, Purchases lifecycle/floor races, stock floor/transfer races,
period boundaries and shared table geometry pass. Focused desktop/390/320 browser
journeys cover receipts, optional photos, immediate Next and reference ranges;
Sales/References/Customers additionally pass at 834 px. The final focused export
passes 99 browser journeys across desktop, 390 px and 320 px. All 187 exported
pages remain within budget (largest 499 KiB gzip, ceiling 576 KiB). Npm audit reports zero
high/critical findings and eight low findings. The backend dependency scan identified CVE-2026-106435 in PyMongo 4.18.2;
both requirement sets now pin its 4.18.3 patch. MongoDB's advisory describes the
malformed-BSON buffer issue and distinguishes it from the driver's transport;
this is a release dependency repair, not evidence of the reported timeout cause.
Source: [MongoDB advisory](https://github.com/mongodb/mongo-python-driver/security/advisories/GHSA-98qm-wvgf-w4cf). The patched production dependency audit has zero known vulnerabilities.

Development browser runs, including interrupted broad runs and the initial test
harness failures, are not full release acceptance. The authoritative fresh-source
performance/stability run is the mandatory pre-push gate; its result and the final
source/deployment identities are pending below. Physical mobile devices/signing
are not part of browser emulation evidence.

## Publication

The release is prepared for final validation and direct main push. Its
pre-push audit and provider verification produce the publication evidence. No separate branch is created and
no GitHub protection is changed. Backend publication must use the same main source;
frontend and backend readiness must be checked separately after rollout.
