# Workspace recovery, quotations and customer deletion

## Scope and design contract

The job is to recover a failed signed-in page, build a priced room selection from
warehouse/catalog products, and manage that customer's records across floors.
This web ERP retains its Expo/React Native stack and existing business workflows.
Apple's foundations apply; native macOS menu-bar conventions do not.

The applied direction is **Framed sheet**, seed **713640828**, keeping the brand's
palette and bundled Inter family. No redraws. The showroom's quotation becomes
a commercial ledger: the customer and amount lead, with room/stock identity kept
in the working builder. The live interaction is stock → recorded price → quotation,
with explicit stock details and repeat quantity entry. No invented business data
or third-party imagery is added. Screenshots use clearly synthetic QA records.

Compact: `16px | title/actions → search/filters → customer / amount → next record | 16px`.
Regular: `sidebar | 24–32px | customer/quotation | date | amount | status | action`.
Existing surface roles are porcelain canvas `#F7F8FA`, white sheet `#FFFFFF`,
content `#101828`, secondary `#475467`, action `#0066CC`, danger `#AE4A3D`.
Inter titles use 24/32, row identity/body 16/24, secondary metadata 13/20.
44px actions remain separate from the open-record target. Motion communicates
press/success only; no new decorative entrances, glass, gradients or resting shadows.

Apple reference basis: `layout.md › Visual hierarchy` asks to group related items
and align content, and `Adaptability` retains functionality across sizes;
`buttons.md › Best practices` requires comfortable hit regions and press feedback;
`loading.md › Best practices` says to show something immediately and allow other
work; `entering-data.md › Best practices` supports choices and dynamic validation.
Accessibility, typography, color, iOS/macOS foundations and cross-platform
translation were also read. UI/UX Pro's flat inventory UI and React Native
responsive/list guidance was checked; its marketing hero recommendation was
rejected as inapplicable to a working ERP.

## Confirmed repairs

- React.lazy retains rejected imports across SPA navigation. Open home now loads
  fresh HTML/modules explicitly, preserving the browser's authentication cookie.
  Repeated render retries offer a real reload. Module failures no longer assert
  that an update exists when the download may have failed for another reason.
  There is no automatic reload of mounted forms.
- The phone quotation header started at x=0 outside the scrolling padded list.
  It now shares the list's 16px gutter and scroll. Regular widths use aligned
  ledger rows, complete customer names, tabular amounts and separate row actions.
  Shared page headers use a restrained type hierarchy; resting primary-button
  shadows are removed. Shared Screen taps persist through keyboard dismissal.
- Warehouse-only details work. Unpriced lots offer Set price & add, focus the
  price editor, persist a valid price, then open the selected quotation source.
  Direct unpriced seeds no longer silently become zero-price lines. Stock edits
  preserve actual received/allocated history. Disabled availability explains why.
- Quick add no longer blocks deliberate additional quantities during its 900ms
  success feedback. Immediate duplicate taps retain their 200ms guard.
  Room actions respond to their actual panel width and retain 44px hit regions.
- Customers is the only full-customer deletion location, owner-only. A read-only
  preview returns actual affected counts and an actor-bound HMAC of the exact
  graph. Changes require a fresh review. The confirmed graph deletes atomically;
  failed transactions leave the original graph intact. Imports use explicit ID
  edges, never name/phone guesses. Other customers/products/supplier stock remain.
- Shared supplier purchases retain/reprice surviving lines and dispatch evidence.
  Transferred inventory retains physical history with the deleted identity
  removed. Only unconsumed reservations return to available stock.
  Private object keys are retained in a durable cleanup receipt until deletion
  succeeds; the outbox worker retries cleanup. Receipts retain counts/actor only.
- Older Furniture ledgers lack a customer ID. Same-phone candidates are shown for
  explicit selection, never automatically deleted. New Furniture ledgers can link
  a concrete authorized Furniture customer. Finalized identity remains locked.
- Ordinary quotation deletion is exact and floor-scoped; it releases reservations
  and pending dependent records. Paid/ordered documents point owners to Customers
  rather than silently deleting financial history from a quotation action.

## Concurrent writes and operational recovery

The HTTP middleware admits ordinary mutations concurrently using durable unique
writer tokens in one Mongo settings document. Customer/quotation deletion is
exclusive and starts only with zero writers. A transaction snapshot therefore
cannot miss a creator already between its parent read and child insert. Background
outbox and scheduled/periodic follow-up passes participate too; notification writes
finish before their admitted operation exits. Reads stay available. Admission adds
two Mongo writes per mutation, plus idempotent initialization. This is an explicit
safety/latency tradeoff; remote write timings need hosted qualification.

Tokens do not expire: a stalled writer cannot resume after an expired lease and
resurrect data. A process crash can leave a token requiring operator reconciliation.
Do not clear admission while any old process/request/worker may still be alive.
Stop writers, verify termination, inspect the gate `_id` value
`customer-graph-mutation-admission:v1`, then clear only abandoned tokens before
restarting. This is an operational recovery action, never automatic TTL behavior.

## Evidence and limits

Focused original/fixed evidence lives in `output/workspace-repair/` and unique
Playwright output folders. The first phone gutter regression failed at x=0.
The original Home/reopen regression reproduces the retained rejected import;
16 repaired boundary scenarios pass on four device profiles. The quotation
workspace passes six sizes including 320px and iPhone Safari. Earlier focused stock
acceptance passed 25 scenarios; final-source verification is recorded separately.
3,128 backend unit cases pass; actual loopback-replica HTTP/transaction acceptance
proves in-flight writer rejection, stale-confirmation rejection, successful cleanup
and unrelated-customer preservation. Production preflight is read-only and reports
healthy Mongo/indexes/storage and zero pending migrations.

Final focused browser acceptance: 48 passed with four viewport-specific skips;
the four initial customer-dialog failures exposed missing web `aria-checked`,
which was corrected and verified in a separate four-profile passing run. New
Furniture customer selection, save payload and reopen pass on desktop and phone.
TypeScript, lint and 17 frontend contract commands pass. These are local results;
the full performance audit and authenticated hosted checks remain separate gates.

Inspector checks run on the real export with synthetic local API responses.
The only explicit allowance is `font-count`: Expo registers Inter's weight files
as separate families and Feather is an icon font; these are one text family and
one existing icon system, not four typographic voices. The below-fold warning is
expected for a complete 24-record list, rather than an overview capped at six rows.
Source lint reports zero banned patterns. Final screenshots and critique are in
the local evidence. No physical-device, exhaustive screen-reader or full dark-mode
certification is claimed.

The existing Render service is Free; its dashboard explicitly warns that idle
wakeup can delay requests by 50 seconds or more. No paid-plan change is authorized.
Anonymous/static assets and synthetic desktop/tablet journeys do not prove the
original real-account outage eliminated. Hosted acceptance must inspect real
session restoration, actual source identities and document reads before claiming
publication success. A new non-sensitive health `source_revision` matches Render's
validated 40-character `RENDER_GIT_COMMIT` without exposing arbitrary environment data.

Fresh npm audit retains five high findings through node-forge/Expo/Sentry. The
upstream signature-verification advisory lists no patched version; an SDK downgrade
is not a compatible incidental fix. No suppression or branch-protection change is
part of this work. Deployment and full final audit results remain pending until
recorded from their authoritative processes.
