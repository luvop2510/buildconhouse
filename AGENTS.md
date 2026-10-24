# AGENTS.md — BuildCon House ERP (forge2.0)

Guidance for any AI agent (Emergent, Claude Code, or otherwise) picking up work in this repo. Read this before re-deriving context from scratch — it's meant to save tokens, not replace judgment.

## Backend wake recovery — 2026-10-24

Web startup uses one shared anonymous readiness attempt, up to 60 seconds total,
with four-second browser probes and 3.5-second proxy attempts. Continue as soon
as ready; never turn that budget into a fixed delay or extend every API request.
Ordinary request limits and write semantics stay intact. Preserve initial-route
storage, identity/floor generation guards and the root navigator; the startup
leaf screen layouts hold initial effects while their navigators remain mounted,
and never remove already-open forms. Metadata reads wait for restored identity.
Render-specific waiting/awake copy must reflect readiness, not elapsed time.
Native startup retains its existing transport and account-check wording.
See docs/audits/2026-10-24-backend-startup.md for the release evidence. Frontend-only
publication may use scripts/promote-verified-frontend.mjs with an unchanged,
verified running backend and current review/performance/hosted evidence; backend,
data, storage and Kitchen workflow releases retain their stronger existing gate.

## Web bundle consistency — 2026-10-24

The reported “app could not start” failure was reproduced in the existing browser:
stale layout chunks and Metro module IDs failed before account startup. A hard
refresh restored the signed-in workspace. Every export now gives all Expo web
JavaScript files one graph-wide filename suffix and rewrites HTML/preload/lazy
references together. Preserve this physical namespace; per-file URLs alone must
not mix cached module graphs. Keep missing chunks as explicit failures and never
auto-reload mounted forms. The recovery bootstrap observes the web root mount
signal; a slow, unmounted bootstrap gets a waiting status rather than a false
release-failure claim. Font errors retain their existing deadline and retry.

## PDF sharing, assigned follow-ups and references — 2026-10-17

Quotation/selection sharing creates no public PDF capability. Share actual PDF
files through the device/browser file sheet; optional configured WhatsApp
Business delivery uploads PDF bytes and retains revision/idempotency/status
guards. Existing expiring capability reads remain compatible. Never restore a
wa.me document-link draft. Furniture retains its separate PDF ledger workflow.

Human-created follow-ups require explicitly selected eligible workers on every
interested floor, including legacy notebook/customer entry and callback/pending
successors without an existing valid assignment. Validate before writes and
retain destination stage/grant checks. Sales is retired as a new/manual type;
historical sales records remain readable. Owner filter overflow is bounded and
scrollable. Do not silently substitute the creator for a missing assignment.

Structured architect/interior UUIDs produce stable ARC-/INT- display codes.
Customer, quotation/PDF, furniture and follow-up views retain name/code/company
where available; floor-scoped acquisition counts deduplicate phone identity across
sources. Exact-ID count lookup is distinct from the analytics top-100 leaderboard.
Legacy NTS/free-text names are recovered without guessing a directory identity.
No migration is required; preserve existing IDs and floor isolation.

See `docs/audits/2026-10-17-pdf-followup-reference-release.md` for verification
and the direct-WhatsApp provider configuration limitation.

## Quotation recovery and R2 source integration — 2026-10-16

Version 1.0.4 gates both quotation builders on synchronized floor access with
explicit retry. Ground selection/quotation lists publish independently; an empty
primary result must not wait for optional document reads. Saved tile restoration
must succeed before editing/save/PDF actions. Persistence captures the document
ID before awaits and retains mount/scope/generation checks after every write,
including A → B → A. The first autosave's own new route ID must preserve edits
made while creation was pending. Sanitary browsing hides stale search cards,
offers filter reset/retry and lets phone users select the destination room.

R2 recovery source is now part of the reviewed changes; preserve the configured
R2 driver, exact public/private buckets and private visibility checks. Migration
plans bind the Mongo cluster/database and storage identities, accept only explicit
application collections and validate every journal entry before any write. Never
rewrite audit/import history or replay an old unbound reference plan. Password
proof runs off-thread; issued login sessions must be followed by current hash,
account/portal/MFA revalidation so a completed reset cannot mint an old-password
session. Preserve exact outbox claim ownership on failures.

The release investigation found unpushed commits and successful previews serving
older production source. Verify actual deployment identities rather than equating
a branch push, preview READY or stale Railway Git metadata with production. See
`docs/audits/2026-10-16-quotation-recovery-release.md` and the companion CI diagnosis.

## Mobile workspace controls — 2026-10-15

Version 1.0.3 keeps the compact app header outside the phone content scroll;
page titles, page actions, filters and rows scroll together on phone layouts. Do
not render a phone `PageHeader` as a sibling above its `ScrollView`, `FlatList` or
`SectionList`. Phone table
headers/columns are not sticky. Editing/search focus hides navigation
and workflow footers; restore chrome after the blur-triggering tap, including
focus moving to a button, to avoid moving its click target. Scroll containers
with filter actions use keyboardShouldPersistTaps="handled". Shared
MobileFilterSection retains mounted controls/drafts while hidden. Spending and
Completed Today summary controls were explicitly removed at the user's request;
do not reintroduce them. Exact expiring follow-up drilldown includes open,
undated quotation-expiring rules under existing floor/grant checks. See
`docs/audits/2026-10-15-mobile-workspace-1.0.2.md` and release evidence.

## Mobile Payments and floor workspaces — 2026-10-15

Payments defaults to a compact, collapsible overview on phones; toggling or
rotation must preserve the payment sheet and its draft. Purchases and all its
document APIs are Sanitary-only. Catalog navigation is Ground/Sanitary only.
Kitchen/Furniture use shared Walk-ins and Follow-ups; old notebook bookmarks
redirect without changing the current floor. Follow-up detail/actions and
in-flight UI callbacks retain that concrete floor. Never reintroduce the duplicate
100% quotation view: legacy fulfilled links normalize to Completed, including
delivered orders. Keep Won order(s) wording and current-member attribution.

Migration 0035 derives limited shared Follow-ups grants for eligible existing
department staff; preserve its stage/action/floor/expiry guards. Retired grants
remain revocable/history, cannot be newly assigned, and must not cause a redirect
loop for accounts without a current page. The access screen is their stable
landing. Required stability acceptance includes payment entry/rotation and
all-floor navigation/direct-link/switching checks. Real deployed read-only
acceptance also uses scripts/verify-floor-mobile-release.mjs with a short-lived
run-owned QA session; never record customer rows or tokens in release reports.
The authenticated verifier waits for its own API reads to settle before hard
navigation/reload and resets tracking across browser contexts. Safari reports
canceled document reads as access-control console errors; never suppress those
errors or weaken the runtime guard to compensate for premature probe navigation.

## Runtime and session stability — 2026-10-15

Web/native roots share `src/components/AuthGate.tsx`; do not fork routing again.
Transient hydration and workspace 403 retain credentials behind recovery; only
authoritative invalid/revoked identity clears them. Identity/assignment reads omit
stale floors. BFF cookies persist only through JWT expiry (cap 30 days), and
successful existing-session restoration upgrades them. Keep revocation and CSRF.

Route failures use React Navigation screenLayout, retaining the navigator and
session. A boundary around Slot itself unmounted the navigator during faults.
Actual Expo AsyncRequireError says "Loading module" and carries request; retain
strict same-origin module classification and explicit reload for mounted pages.
Never auto-reload live forms. Literal search punctuation must remain escaped.

Vercel API loaders reject require(ESM), even when local Node accepts it. Shared
cookies use the canonical CommonJS helper; standalone workers inline it. Required
API tests execute compiled CommonJS and the actual emitted worker. Deploy a
--skip-domain candidate, verify its authenticated journeys, then use
scripts/promote-verified-vercel.mjs to verify source/API/assets before promotion.
That guard also requires live authenticated desktop Chrome/iPhone Safari checks
via scripts/verify-authenticated-release.mjs and FORGE_RELEASE_SESSION_FILE.
Use a short-lived run-owned QA session, block business writes and revoke only
that session after acceptance. Never weaken preview protection to test a build.
The follow-up label is Won orders; the user confirmed a wording-only correction,
preserving its existing current-member attribution/filtering behavior.

The required Performance/pre-push audit includes immutable four-device every-page
stability, populated stock/new quotation navigation, render/module failure and
session recovery. New route files inherit coverage. The evidence verifier rejects
missing scenarios, retries, skips and flakes. Preserve budgets/security/main
protection. See docs/audits/2026-10-15-runtime-session-stability.md for findings,
verification boundaries and the unresolved intermittent hosted-network observation.

## Sanitary warehouse replacement and photo editing — 2026-10-14

Seven stock workbooks now back 1,015 active lots / 4,393 recorded units. Eight
old lots are archived with purchase/allocation history intact. Keep archived and
quantity_missing lots out of every new allocation/transfer path, including
quotation matching; unknown quantity uses a flagged zero technical placeholder.
Warehouse-only quotation identities require their exact backing lot and floor.
Duravit has eleven new catalog products; unknown prices carry explicit
price_status=unspecified and specs.price_status, while stock prices stay null.

Lot price/HTTPS image overrides and multipart uploads use floor-scoped update
permissions. godown_stock_media stores immutable lot photos separately from
catalog product_media. Preserve original picker File, shared authenticated
transport, cancellation and exact photo envelope limits. Stock reads exclude
bulky private provenance, fail explicitly above 2,000 lots and render 60 cards
initially while searching the complete bounded payload. Reviewed imports use
source hashes, private backups, stock fingerprints, atomic archive/insert and
durable replay receipts; never delete historical lots or silently reset edits.
See docs/audits/2026-10-14-godown-stock-replacement.md for live evidence and
explicit unresolved source fields.

## Historical Won/Lost customers — 2026-10-14

Historical workbook outcomes use `quotation.customer_outcome`, independently
of draft/ordered status, and closed manual follow-ups grouped by customer. Do
not convert those outcomes into new financial orders. The quotation list and
builder use floor-scoped `view=won|lost` queries; pending, sales automation and
PDF follow-up producers exclude outcome-marked historical records. Ordinary
edits preserve classification; Duplicate creates a fresh draft; Place Order
requires a fresh quotation. Import receipts include follow-up fingerprints,
fixed outcome timestamps and explicit shared-phone identity decisions. Read
`docs/audits/2026-10-14-customer-outcomes.md` for acceptance and publication.

## Custom products, media and drag ordering — 2026-10-14

Custom quotation items now always have a backend product id, including inactive
quotation-only records. Do not restore synthetic ids: quotation create/autosave
requires real floor-scoped products. `custom-with-media` validates and binds a
request to member/floor/content; deterministic product/media Mongo `_id`s dedupe
concurrent retries. Photos are Supabase objects with Mongo `product_media` metadata
and quotation URL snapshots. Only the exact custom creation endpoints accept
quotation-create grants; normal catalog/media edits retain their own permissions.

All multipart uploads use the shared API transport and photo preparation helper.
Web image-picker assets must retain their original `File`, including gallery
preview state. Use that file directly: production `connect-src` blocks fetching
picker blob URLs. Keep the production CSP unchanged; the audit server now serves
the same headers so browser upload journeys cover this constraint.
The browser preserves small originals and prepares larger photos below 3 MiB;
Vercel admits 4 MiB envelopes only for photo routes, retaining ordinary 1 MiB
bounds. Exact detail/media hydration reflects new/deleted photos before background
catalog refresh. Do not reintroduce manual fetch uploads missing the floor header,
CSRF, cancellation or cache invalidation.

Product/room dragging preserves included parts and collapsed-room data. Recalculate
on changed pointer/scroll using paired DOM order/geometry, apply the final drop,
and use elapsed-time edge scrolling. Idle preview reorders previously overshot
into another room. Keep the admin route subtree stable across viewport breakpoints:
phone rotation previously destroyed custom form/photo state. Read
`docs/audits/2026-10-14-custom-products-ordering.md` for exact verification and
publication evidence. Physical devices/signing and existing npm security findings
remain separate from browser/unsigned-export acceptance.

## iPad forms and multi-floor pre-order leads — 2026-10-13

Follow-ups cover pre-order sales only. Operational/payment/purchase/dispatch/
delivery reminders are retired; committed orders consolidate related floor leads
while retaining historical worker assignments and quotation-creator attribution.
Multi-floor interested/assignment edits preserve floor-local records and require
the actual destination notebook stage's view/update grants. Typed-phone intake
resolves existing destination stages too. Manual creation retries use a member/
floor-bound request key and persisted fingerprint. Call outcomes consume only
their own pending attempt. Team assign is owner-only with full aggregate counts,
paged details and explicit activity truncation. Interior reporting counts acquired
people before an order and deduplicates their phone identity across floors.

Web roots and overlay portals track Safari's visual viewport; do not restore
closing-modal focus before its portal is removed or apply keyboard resizing to
pinch zoom. Team shows one Phone field and preserves distinct legacy contact data.
Migration 0034 was applied through the controlled production job; the post-apply
dry run has no pending migrations. Runtime b9a06838 is live on both Vercel and
Railway. The user clarified a
total HTTP response requirement under 2 ms; current hosted baseline samples fail
it. The user subsequently accepted that measured gap and explicitly requested
GitHub push/live migration/Vercel/Railway publication. Preserve the existing
performance budgets and verify deployment readiness and actual source. Read docs/audits/2026-10-13-ipad-multifloor-leads.md and its
companion verification JSON for local checks, actual deployment identities,
post-deploy timings and retained hosted cold-load limitations. Protected main
remains unmerged; existing dependency security findings are not suppressed.

## Passwords, lost reasons and mobile workflow update — 2026-10-13

Current policy supersedes the older owner-managed-only password notes below:
staff may change their own password with current/new/confirmation; Team and role
management remain owner-only. Owner credential reveal is explicit/audited/no-store,
with bcrypt login and identity-bound encrypted recovery copies. Legacy hashes
need reset before reveal. Preserve the existing MFA encryption root (JWT fallback)
across deployments and synchronize every credential-write path, including controlled
Team reset. Do not expose ciphertext/hash in ordinary responses or diagnostics.

Routine customer/follow-up/notebook actions accept no notes; only Lost requires a
reason. Visit Showroom permanently excludes the source walk-in from registers/counts
and keeps one retry-safe follow-up. Interested transferred leads keep recipient
ownership; only committed orders count won. Own orders defaults to current member,
and actual won sales belong to the quotation creator, including unlinked same-floor
showroom leads. Migration 0033 repairs confirmed historical attribution while
preserving ambiguous/unrelated history. Purchases explicitly request one selected
floor and reject stale callbacks. Phone quotation browsing defaults full screen,
filters use a sheet, custom products and description/edit/review parity remain.
See docs/audits/2026-10-13-team-mobile-workflows.md for evidence and release outcome.

## Performance constraints — 2026-10-13 incident repair

Performance is a release requirement for every feature/change. Read
`docs/deployment/performance-policy.md` and run `npm run test:performance:audit`
against current source before publication. The installed local pre-push hook
and independent push/PR Performance workflow enforce this audit; do not bypass
them, increase deadlines, suppress page errors, or reuse an old export.
All exported routes inherit bundle budgets; extend interaction/loading fixtures
for new heavy pages. Backend unit tests always use hermetic CI settings.

Verified incident: production source BSON grew to ~19.7 MB, exceeding the old
16 MiB snapshot cap and silently forcing catalog hierarchy/family reads through
remote Mongo aggregation. The cache remains bounded at 32 MiB with unchanged
row caps; diagnostics/warnings reveal fallback. Parallel source reads, shared
refresh/failure/backoff, off-loop construction and generation invalidation retain
safe floor/media/write behavior. Do not introduce per-page full-catalog reads.
`backend/scripts/benchmark_catalog_performance.py` is a read-only, configured
dataset service audit: no bootstrap/migrations/sessions/business writes; mode,
counts and numeric timings only. Its warmed computation budgets exclude HTTP,
authentication/browser/network. Verify live serving regions and latency after
deployment; historical SFO/IAD evidence no longer describes the target setup.

Catalog/Builder/Tiles cursors consume raw server rows even when displayed rows
are deduplicated/dropped; empty pages terminate pagination. Guard both starting
and publishing async work against current query/floor/mount; gate simultaneous
scroll callbacks synchronously. Multi-column FlatList budgets count rows, not
cards. Optional sound playback must observe asynchronous browser rejections.
See `docs/audits/2026-10-13-performance-incident.md` for release evidence.

Release verified: runtime `f06017d3`, Vercel Mumbai deployment
`dpl_Hs5yLbZbgPZe1rXciuho3WhDotdp`, Railway Singapore deployment
`0fbd1855-ceed-4e95-9e78-ba65e17b2792`; catalog memory mode confirmed live.
The nested Railway JSON was ignored and its new legacy registration rejected;
provider settings now persist one Singapore replica/no sleep. Inspect actual
provider metadata on future releases. Full local acceptance: 2,305 backend,
434 route/workflow browser and 40 performance browser passes. Performance CI
passes on the runtime commit. Main now requires performance alongside the
three functional/security checks with administrator enforcement and review.
The 22 high/five moderate npm findings still fail the independent security gate.
Authenticated hosted content works without captured runtime errors, but fixture
timings are not a universal 2.5-second production/physical-device certificate.

## Quotation filters and walk-in visibility — 2026-10-13 follow-up

Quotation brand/category filters are now single-choice; finish/color filter rows
and their hidden saved state are removed. Legacy mixed scopes normalize safely,
and failed category reads offer retry in both compact picker and desktop rail.
Vercel preserves repeated query values for other catalog screens. Purchases uses
actual-order customer eligibility, excluding unconfirmed walk-in profiles while
preserving legacy/transferred buyers. Eligibility/completion reads are parallel.
Catalog hydration uses lazy candidate indexes with edit invalidation and unchanged
scope/finish/ambiguity checks. The review also fixes Team contact initialization
before interaction; the unchanged rapid-clear browser case and actual hook
regression verify it. Final functional acceptance: 2,288 backend passes, 42
frontend commands, 2,527 browser passes / 55 intentional skips / zero failures or
flakes; all 157 generated pages fit the bundle budget. Fresh bathroom matrix:
146 scopes, zero discrepancies. Npm remains 22 high/five moderate; protected main
is not bypassed. Publication/deployment evidence belongs in
`docs/audits/2026-10-13-quotation-walkins-release.md`.

## Stability, quotation and catalog — 2026-10-13

Response caches now release expired entries and retain 64 recent responses;
quotation line multi-select is removed, individual workflows remain, and rows
reuse memoized pricing. Catalog occurrence/fallback counting is repaired in warm
and Mongo paths with 146 authoritative scopes verified. Session-cache generations
and post-write invalidation close revocation refill races. Final local checks:
2,283 backend passes, 42 frontend commands, 2,495 browser passes / 55 intentional
skips / zero failures, production web export and all route budgets pass.
Npm audit still fails (22 high / five moderate); no suppression or protected-main
bypass. The user subsequently explicitly requested GitHub/Vercel/Railway
publication. See `docs/audits/2026-10-13-goal-report.md` and the release ledger
for deployment outcomes. Physical-device acceptance remains unverified.

## Performance and password minimum — 2026-10-12

Version 1.0.1 fixes bounded catalog batching/shared cold warmup, parallel analytics
reads and shared cache misses, independent customer/quotation primary loading,
customer-scoped quotation history, and catalog startup debounce. Newly assigned
passwords require six Unicode characters in both UI and API. Existing byte limits,
floor isolation and write invalidation remain. Final backend suite: 2,246 passed;
20 screen loading/race tests and 16 four-device performance tests pass. Six-character
password boundaries pass 16 browser cases. TypeScript, zero-warning lint, web and
unsigned iOS/Android exports and all 11 route budgets pass. Read-only readiness
passes with no pending migrations. Required npm audit still fails with 22 high/five
moderate findings; GitHub source review does not constitute production promotion or
physical-device acceptance. See `docs/audits/2026-10-12-performance-1.0.1.md`.

## Walk-in/catalog/filter verification — 2026-10-11

Local changes add multi-choice categorical filters, confirmed-only Customers,
immediate Visit Showroom follow-ups, one catalog card per family with editable
variant labels, and persistent mouse/touch quotation product ordering. Migration
`0031` is applied to the configured live Atlas database: `second-floor` is named
`Kitchen Floor` and the two exact test lead-source choices are removed. Floor IDs
and historical records remain stable. The local preview on 8090 proxies to the
local backend on 8010 using `scripts/serve-local.mjs`.

Acceptance: 2,102 hermetic backend unit tests, four disposable Mongo catalog
integration tests, 86 feature browser passes across eight browser/viewport
projects (two touch-harness skips), and 55 surrounding regression passes (two
tablet-only skips). TypeScript, zero-warning lint, web/iOS/Android exports, frontend
contracts and all 11 route budgets pass. Six controlled live route checks pass
and their temporary records are removed. Infrastructure preflight and local API
readiness pass; migration dry-run has no pending changes. These are local
changes, without a production deployment or physical-device acceptance.
See `docs/audits/2026-10-11-walkins-families-multi-filters.md`.

## Current verification update — 2026-10-11

Staff credentials are permanent and owner-managed. Team account reads, creation,
editing, deletion, password resets and delegation management are owner-only at
the API and UI; staff cannot change their own password. Legacy staff temporary
flags are normalized at login/hydration, including the JK owner account. Customer
temporary credentials retain their independent policy. Owners have full access;
active owners cannot be demoted, disabled or deleted through Team. Deleted staff
lose sessions and remain tombstones for historical attribution and identity safety.

Furniture displays RNB in the UI, PDF and sharing text, retaining legacy RMB wire
fields and stored values. Hard-navigation hydration failures no longer erase
persisted credentials unless the server returns an authoritative 401/403.

Local acceptance: 2,072 hermetic backend tests; 636 browser passes across six
widths with six intentional navigation skips, plus six delayed-floor startup
checks. The final device run passes all 236 cases (59 each for Android Chrome,
iPhone Safari, iPad Safari and desktop Firefox), two workers, unchanged deadlines
and no retries. Earlier runner failures remain documented. Hosted preview checks
had 227 passes/five navigation or loading failures; all ten focused cases passed
in isolation. TypeScript, zero-warning lint, 35 frontend contract scripts,
web/native exports, all 11 route budgets and Expo Doctor20/20 pass.
The published decode-uri-component 0.5.0 fix is pinned, with a CommonJS import
compatibility repair for Expo Router's query-string 7. Malformed URL regressions
run in CI. Optional route drift checking has no configured baseline.
Read-only predeploy passes and migration dry-run finds no pending migrations.
Remaining 22 high/five moderate npm findings and GitHub billing preventing CI
job startup still block release. The live backend schema lacks the new member
deletion/specific-password contracts. No production deployment, signing or
physical-device acceptance is claimed. This Mac lacks simctl and Android tooling.
See
`docs/audits/2026-10-11-owner-password-rnb-responsive.md` and its JSON evidence.

## Earlier verification update — 2026-10-10

Company CSV/XLSX updates are deterministic and preserve product IDs and verified
media. Catalog reads keep the existing warm cache at normal sizes and switch to
indexed, bounded Mongo paging beyond its row/byte budgets. Furniture adds the
unbranded exact RMB ledger/PDF, with direct WhatsApp sends gated on configured
Business sender credentials. Kitchen/Furniture share floor-scoped business pages;
RMB is Furniture only. Purchases uses five stages, dispatched means delivered,
and completion requires every active quantity. Atomic split/move guards protect
that invariant. See `docs/audits/2026-10-10-furniture-catalog-purchases-release.md`.

Final acceptance: 1,874 hermetic unit tests, 20 disposable Mongo integration cases,
78 six-size browser cases, TypeScript, zero-warning lint, frontend contracts,
route budgets and Expo Doctor20/20 pass. Controlled migrations0027–0029 are
applied; production predeploy gate passes with no pending migrations. No real
WhatsApp messages were sent; production Business sender configuration remains
missing. Existing npm findings (22high/eight moderate) still fail the independent
security job. No overall green CI or physical-device acceptance is claimed.

## Earlier verification update — 2026-10-07

The latest App Store readiness repair preserves and releases the prior workspace
search fixes, adds atomic undo/redo history and committed overlay callback refs,
fixes nested reduced-motion Escape dismissal and labels mobile quotation actions.
Final rebuilt local browser acceptance: **990 passed, 30 intentional skips**,
zero failures/flakes, two workers, unchanged deadlines and no retries. Backend
unit suite: **1573 passed**. All 28 required frontend contracts, TypeScript,
zero-warning lint, Expo Doctor 20/20 and route budgets pass. Native EAS production
now targets `https://forge20-production-a8b0.up.railway.app`; unsigned Hermes
exports are verified, but signing and physical devices remain unverified.

Current npm audit remains 30 findings (22 high/eight moderate). Required GitHub
artifact uploads also fail storage quota; browser artifact suppression was
removed. Current media acceptance still has 119 missing heroes plus five absent
objects. New local recovery verifies 41 collections/40319 records/176 indexes in
18.184 seconds; all private-upload attempts for this new snapshot failed and no
remote completion is claimed. Do not repeat the constrained cloud drill or
substitute ambiguous product photos. See
`docs/audits/2026-10-07-release-readiness.md` and its final deployment ledger before
reusing older host evidence; the new Railway production service runs in `sfo`.
Legal/operator facts, reviewer tenant, real devices/signing, off-site capacity,
regional runners and observed alert receipt were requested together once.
App Store submission requires user approval after the remaining gates pass.

The session repair preserves only exact account identity GETs across floor
changes; business reads and all mutations still cancel. Login/logout still
invalidate every old identity request. AuthProvider guards obsolete hydration
and serializes credential writes within one provider instance. The full local
browser suite passes 928 tests with 20 intentional skips; stronger account-name
assertions pass all 16 sign-in cases, and 40 provider race/lifecycle cases pass.
See `docs/audits/2026-10-07-identity-floor-hydration-race.json`. These browser and
hook checks do not constitute physical-device or signed-native acceptance.

Follow-up: the compatible lockfile update to `shell-quote` 1.12.0 addresses
newly indexed critical advisory GHSA-pqg4-j6r4-53mv; its attack regression
test is required in frontend CI. This does not waive other npm findings.
SDK 55 is aligned to Expo 55.0.31 / React Native 0.83.10 after application
checks; SDK 56/57 remain held for compatibility failures. See the precise
browser test correction and upgrade evidence in
`docs/audits/2026-10-06-expo55-application-upgrade.json`. Historical media ownership review found nine candidates: eight have
wrong finishes/product forms and one lacks verified import-row provenance.
See `docs/audits/2026-10-06-historical-media-ownership-review.json`; no photo
was assigned from those unsafe associations.

The July notes below are historical. The current active catalog has 6,565
products across Sanitary Bathroom and Ground Floor; Ground Floor is no longer
an empty future-data workspace. The read-only backend predeploy gate now
passes Mongo access, required indexes and Supabase access, and the migration
dry-run reports no pending migrations. The historical migration `0006`
restart blocker below was resolved; repeat the current read-only gates before
future backend promotion rather than treating the old warning as current.

The latest repair pass uses shared Inter Text/TextInput defaults and Feather
icons, synchronizes Payments document floors before navigation, preserves
zero-stock history and rejects stale floor callbacks. Its full backend unit
suite passes 1,573 tests. Frontend functional CI and security auditing are
independent jobs; the fresh 6 October scan has 30 npm findings (22 high/eight moderate) still block the
security job. Do not suppress those findings or claim overall CI is green.
Physical devices, signed builds and legal/operator acceptance remain open.

See `docs/audits/2026-10-05-goal-release.md` for current evidence, image recovery
manifests, deployment results and operational acceptance limits. Backup data
and credentials must stay excluded from Git, public artifacts and Docker
contexts. Run unit tests with hermetic CI environment variables, never live
production settings; restore drills must use an isolated empty database with
no application or workers connected.

## What this project is

FastAPI + MongoDB Atlas (cloud, not local) + Supabase (file storage) backend, Expo/React Native Web frontend (Expo Router). A multi-floor ERP for a bathroom-fittings + tiles distributor: `first-floor` (display name "The Sanitary Bathroom") holds the existing ~2,600-product sanitaryware catalog and all real business data today; `ground-floor` is the new tile section (schema/isolation work in progress, no real tile data yet); `second-floor` also exists as a floor entity but is otherwise unused so far.

- Live Atlas DB: `buildcon_house` (not `buildcon`, a stale demo DB on the same cluster).
- Supabase buckets: `forge-products` (public), `forge-private`.
- Local dev: `backend/.venv` (Python 3.14), `backend/.env` / `frontend/.env` hold real credentials (gitignored, not committed — verified clean).
- Backend commonly runs on port 8010 (`uvicorn server:app --port 8010`) since something else occupies 8000 on the primary dev Mac.

## Important — this repo has concurrent editors

**This repo is being worked on by more than one agent/process at once.** As of 2026-07-18 there were ~99–106 files sitting uncommitted in the working tree from a separate, non-Claude-Code process (git log shows a long history of `auto-commit for <uuid>` entries — almost certainly an Emergent-platform agent working the same codebase in parallel). That work is legitimate and already includes real, wanted fixes (e.g. a session-security hardening pass in `auth.py`, an optimistic-concurrency rewrite of `_apply_stage_change` in `purchases_tracker.py`, and a role-permission fix lowering `move_item`/`bulk_move`/`transfer_item*` from `require_min_role("sales")` to `"warehouse"`).

**If you are about to commit and a file you're touching has other unrelated uncommitted changes in it: do not sweep them into your commit.** `git add <file>` stages the whole file, not just your diff — use `git add -p` and select only your own hunks, so each commit accurately describes its own contents and the other process's in-progress work isn't silently relabeled or buried under an unrelated commit message. This was a real mistake made and then corrected during the floor-isolation-fix work below — see that section for the concrete example.

**Update (2026-07-18):** all ~99 files of that backlog have now been committed as `96ffda2` ("chore: commit accumulated prior-session work..."), since Task 1's isolated commit turned out to depend on foundational `auth.py` helpers (`floor_query`/`floor_for_write`/`accessible_floor_ids`) that were themselves part of that uncommitted backlog — every prior session's work had been sitting uncommitted, at real risk of loss, this whole time. Going forward, the working tree should stay much closer to git history; if you find a large uncommitted backlog again, treat it the same way (commit it honestly labeled as pre-existing work, don't silently absorb it into an unrelated task commit).

## Current effort: floor-isolation fix + tile-ready catalog schema

**Root cause (confirmed 2026-07-17 by direct query against the live Atlas DB, not assumption):** every real record in the database — all 2,601 products, 69 follow-ups, 13 purchase orders, 12 payments, 5 customers, 41 quotations, 5 suppliers — was tagged `floor_id="first-floor"`, and switching the UI to Ground floor showed that same first-floor data instead of an empty state, because a specific, mechanically-identifiable set of backend read *and* write paths never applied floor scoping at all. Full root-cause writeup, the complete list of every affected code site, and exact before/after code for every fix are in:

**`docs/superpowers/specs/2026-07-17-floor-isolation-and-tile-catalog-design.md`** (design/spec — read this for *why*)
**`docs/superpowers/plans/2026-07-17-floor-isolation-fix.md`** (implementation plan — read this for *exact code*, task-by-task, TDD-style)

Do not re-derive the root cause or re-scan the codebase for affected endpoints — both are already fully enumerated in those two files. If you need to know "is X in scope," check the plan's 20 task headers first.

**Status as of 2026-07-18: all 20 planned tasks complete, plus a final holistic review (see below), plus 2 additional gaps that review found — everything reviewed (spec compliance + code quality, two-stage per task) and pushed to `origin/main` at commit `f86a43e`.** One live operational blocker remains before the app can be safely restarted against production — see "⚠️ Migration `0006`" below — and two small follow-up tasks were spawned separately (not blocking, not started; see "Spawned follow-ups" at the end of this file).

**Final holistic review** (after all 20 tasks landed): traced 3 end-to-end user scenarios through the actual HEAD code (floor switch → Purchases Tracker; quotation → auto-PO → customer transfer; follow-ups tab), confirmed `floor_id` is correctly read/written/scoped at every hop with no gap in any detailed-record path. Did an independent fresh sweep of all `count_documents`/`aggregate` calls across `routes/`/`services/` (not just trusting the plan's own enumeration) and found 2 real gaps of the same bug class — both count/badge-level leaks, not detailed-record leaks: `dashboard_routes.py`'s product-count KPI and `followup_routes.py`'s per-rule badge counts were still global (the first had a stale "not scoped yet" comment left over from before Catalog was floor-scoped; the second predated the `user`-threading convention). Both fixed, tested, reviewed, and pushed (`f86a43e`). A second, independent sweep after that fix confirmed no third gap of the same shape remains on any staff-facing endpoint. Full backend test suite: 90 passed.

### Established pattern (use this, don't invent a new one)

- `floor_query(user, base)` — Mongo filter dict, for queries that take a filter (`db.collection.find(floor_query(user, {...}))`).
- `floor_for_write(user)` — single floor_id string, for **human-initiated** creates (`Quotation(..., floor_id=floor_for_write(user))`).
- `floor_scope_ids(user)` — plain `Optional[list[str]]`, for code that builds its own aggregation pipeline or in-memory filter instead of taking a Mongo filter dict (added in Task 1 of the plan above).
- **Automation/event-handler-created records** (background workflows with no live user, e.g. `domain_outbox.py`, `transfer_workflow.py`, `followup_engine.py`) inherit `floor_id` from their immediate **source document** instead — never `floor_for_write()` — since these handlers often only have an actor id/name string, and a record derived from a ground-floor source must stay ground-floor regardless of which floor the triggering user happens to have selected. Use `floor_inherit(source)` from `auth.py` for this (added alongside `floor_query`/`floor_for_write`/`floor_scope_ids` — this consolidates what used to be four duplicated per-file helpers; don't reintroduce a fifth local copy).

All four live in `backend/auth.py` (the first three) or as small local helpers next to their one caller (the fourth kind) — don't scatter re-implementations of the same logic across files.

### Task status (20 tasks total, 3 milestones)

Update this table as work lands. Commit SHAs below are on `main` (this repo commits directly to main — no feature-branch convention here).

| # | Task | Status | Commit(s) |
|---|------|--------|-----------|
| 1 | Purchases Tracker main board (`_iter_items` + `GET /items`) + `floor_scope_ids` in `auth.py` | **Done** (spec + code-quality review both passed) | `4ffad24` |
| 2 | Purchases Tracker facet endpoints (`/stages`, `/brands`, `/customers`) | **Done** (spec + code-quality review both passed) | `a1d0174` |
| 3 | Purchases Tracker remaining read endpoints (`customer_workspace`, `dispatch_record`, `list_shortages`, `export_xlsx`, `get_item`, `item_transfer_history`) | **Done** (spec + code-quality review both passed; 2 minor style-consistency notes left as optional follow-up, see review) | `bfdeb65` |
| 4 | Follow-ups `/insights` | **Done** (spec + code-quality review both passed) | `781a65b` |
| 5 | Reports overview | **Done** (spec + code-quality review both passed) | `da9e240` |
| 6 | Dashboard `followups_due` counter | **Done** (spec + code-quality review both passed) — **Milestone A (read-path scoping) fully complete** | `00b70fd` |
| 7 | `domain_outbox.py::_handle_order_placed` (PO + Payment floor inheritance) | **Done** (spec + code-quality review both passed) | `bfff087` |
| 8 | `domain_outbox.py::_upsert_followup` | **Done** (spec + code-quality review both passed) | `5e69494` |
| 9 | `followup_engine.py` rule-based auto-follow-up engine | **Done** (spec + code-quality review both passed) | `981d13d` |
| 10 | `transfer_workflow.py::execute_transfer` | **Done** (spec + code-quality review both passed) | `379a8ff` |
| 11 | `transfer_workflow.py::handle_purchase_transferred` | **Done** (spec passed; code-quality found a real issue — first test was a no-op, fixed by reusing `_transfer_floor_id`, re-reviewed and approved) | `c07be25`, `3dbca7b` |
| 12 | Legacy inline transfer/reorder code in `purchases_tracker.py` | **Done** (spec + code-quality review both passed; reviewer flagged cross-file helper duplication as a non-blocking follow-up — see below) | `5c25ca5` |
| 13 | Follow-up call-back rescheduling (`POST /{id}/log-call`) | **Done** (spec + code-quality review both passed) — **Milestone B (write-path floor inheritance) fully complete** | `24c87af` |

**Bonus cleanup (not one of the 20 plan tasks):** Task 12's reviewer flagged that `_transfer_floor_id` (transfer_workflow.py), `_source_floor_id` (purchases_tracker.py), `_followup_floor_id` (followup_engine.py), and three inline copies in `domain_outbox.py` were all near-identical reimplementations of "inherit floor_id from source, default to first-floor." A separate session consolidated these into one `auth.floor_inherit(source)` helper alongside `floor_query`/`floor_for_write`/`floor_scope_ids`. Pure refactor, no behavior change, full suite passes (74/74). Commit `b5ecee4`.
| 14 | `Brand`/`Category` gain `floor_id` + backfill migration `0004` | **Done** (spec + code-quality review both passed) | `b4a0f79` |
| 15 | Floor-scope the in-memory catalog engine (`catalog_service.py`) | **Done** (spec passed; code-quality found brand/category product-counts could leak across floors if the "no brand spans two floors" invariant were ever violated — fixed by scoping the Counter too, re-reviewed and approved) | `1a1a787`, `7fab437` |
| 16 | Thread floor scope through Catalog routes; fix product-creation floor default | **Done** (spec + code-quality review both passed) | `febe99f` |
| 17 | `POST /brands`, `POST /categories` | **Done** (spec passed; code-quality found `categories.slug` had no unique index — unlike `brands.slug` — leaving a real check-then-act race, and no test existed for `create_category`; both fixed, re-reviewed and approved) | `1042ed4`, `ab225ca` |
| 18 | `size` field on `Product` + search/facets | **Done** (spec passed; code-quality found `size` wasn't wired into `search_catalog`'s scoring or `hydrate_variants_batch`'s sibling-variant hydration — the second one would have silently broken Task 20 — both fixed, re-reviewed and approved) | `a2662ab`, `047694e` |
| 19 | SKU uniqueness migration `0006` (per floor+brand, **renumbered from 0005** — Task 17's categories.slug index fix took `0005` first) | **Code written, tested, spec + code-quality reviewed and approved. Pushed to origin (CI has no deploy step and uses an isolated test DB, so this is safe) — but the migration itself must not reach a real deployment/restart until the live duplicate SKU is resolved.** See "⚠️ Task 19 is holding" below. | `4ab1b5a`, `658a92f` |
| 20 | Frontend `variantDescriptor()` helper + `PickerCard`/`VariantChip`/`SwapSheet`/`ProductModal` display fix | **Done** (spec + code-quality review both passed; reviewer hand-traced all edge cases by hand since this repo has no frontend test runner) — **all 20 tasks complete** | `e889686` |

### ⚠️ Migration `0006` is a live landmine until the duplicate SKU is resolved — read this before restarting any backend process against the real database

**Current verification — 2026-10-05:** A read-only audit of live Atlas `buildcon_house` found zero duplicate `(floor_id, brand_id, sku)` groups, no pending numbered migrations, and the unique `products_floor_brand_sku_unique` index present. The historical blocker below is resolved. Current production startup does not auto-apply migrations by default; pending migrations fail readiness and require the controlled job in `backend/OPERATOR_CHECKLIST.md`. This verification made no database changes. The historical account below is retained for context; always repeat the read-only preflight before a new deployment.

Directly queried the live Atlas database (2026-07-18) and confirmed the known duplicate SKU is still real and unresolved: SKU `26456000` under brand `9b72519c-bfb4-4576-9e79-e85072ab4216` (Hansgrohe), two product documents (`639c8d2e-95e6-406b-a117-f18155b9519d` and `811a1b0f-1b20-401b-9f36-e8134b63bbf2`), both `floor_id="first-floor"`.

A code-quality reviewer traced what actually happens if migration `0006` (`backend/migrations/0006_products_sku_unique_per_floor_brand.py`) reaches a deployment before that duplicate is resolved: `backend/migrations/runner.py` auto-applies every pending migration at **every backend startup** (`server.py`'s startup event calls `run_migrations(db)` with no surrounding `try/except`, unlike the reconciliation call right below it), and there is no per-migration error handling in the runner either. So this isn't "don't run `scripts/run_migrations.py` manually" — merely having this file present in `backend/migrations/` on a process pointed at the live DB means the **next process restart** hits an uncaught `DuplicateKeyError`, which aborts FastAPI startup entirely. Since the migration never gets recorded as applied on failure, this repeats on every subsequent restart — a boot crash loop, not a one-time error.

**The migration code itself is correct, fully tested (unit tests use only a fake in-memory db, no live connection), and both reviews passed — it has been committed AND pushed to `origin/main`** (commits `4ab1b5a`, `658a92f`). This is safe: CI (`.github/workflows/ci.yml`) has no deploy step and runs unit tests against an isolated `MONGO_URL=mongodb://localhost:27017` / `DB_NAME=forge_ci_unit_tests`, never the real Atlas cluster — confirmed by reading the workflow file directly. The risk is NOT "this is on GitHub" — it's specifically **restarting any real backend process (local dev `uvicorn`, or an actual deployed instance) that connects to the live `buildcon_house` database** while this duplicate still exists. Do not restart the backend against the live database until:
1. The live duplicate is resolved: rename one of the two SKUs, or merge the two Hansgrohe products (`639c8d2e...` / `811a1b0f...`). This is a data decision for a human — the migration deliberately does not attempt to auto-resolve it.
2. Re-run the read-only check below to confirm zero duplicates remain:
   ```bash
   cd backend && .venv/bin/python -c "
   import asyncio
   from db import db
   async def main():
       dupes = await db.products.aggregate([
           {'\$group': {'_id': {'brand_id': '\$brand_id', 'sku': '\$sku'}, 'ids': {'\$push': '\$id'}, 'n': {'\$sum': 1}}},
           {'\$match': {'n': {'\$gt': 1}}},
       ]).to_list(50)
       print(dupes)
   asyncio.run(main())
   "
   ```
3. Only then restart/deploy the backend against the live database — the code is already committed and pushed, there's nothing further to push at that point.

See "Spawned follow-ups" near the end of this file for the two related background tasks (not blocking, not started).

**Explicitly out of scope for this plan** (decided with the user, don't re-litigate): no new MongoDB/Supabase infrastructure (already cloud-hosted, confirmed via `backend/.env`'s real Atlas `mongodb+srv://` URL); no tile product data import (schema/isolation only — data entry is separate, later work); no Cmd+K quick-search brand-scoping (confirmed not needed — Catalog page + Quotation Builder search, both fixed here, are what matter); no `LineRow`/`Line`-type/`QuotationLineItem` changes for `size` (LineRow only shows a colour swatch, not a text fallback chain — not affected by the bug this plan fixes).

### Spawned follow-ups (not blocking, not started as of 2026-07-18)

Both were flagged during code review of Task 17/19 as real gaps of the same shape as this whole plan, but explicitly out of each task's own scope — background task chips exist for a human to start with one click:

1. **`bootstrap.py` doesn't verify `brands`/`categories` indexes at startup.** `REQUIRED_INDEXES` checks `products`/`users`/`quotations`/`purchase_orders`/`customers`/`payments`/`suppliers`/`activity_events` but not `brands.slug`/`categories.slug` — so there's no automated guarantee those unique indexes (created by migrations `0004`... actually by `scripts/ensure_indexes.py` for brands, and migration `0005` for categories) actually exist in a live deployment.
2. **`catalog_routes.py`'s SKU duplicate-checks are still global.** `create_product`/`create_custom_product`/`update_product` all do `db.products.find_one({"sku": sku})` with no `floor_id`/`brand_id` scoping — so even once migration `0006` is safely deployed (relaxing the DB-level constraint to per-floor-per-brand), the API's own pre-check would still reject a legitimate cross-floor SKU reuse before it ever reaches the database. This is the one that actually matters for the tile catalog to work as intended once real data arrives — prioritize this one if only starting one of the two.

### If more floor-isolation work comes up later

1. Follow the same TDD pattern used throughout this plan (see any task in `docs/superpowers/plans/2026-07-17-floor-isolation-fix.md` for the shape: failing test → minimal `floor_query`/`floor_scope_ids`/`floor_inherit` fix → passing test → isolated commit).
2. Run backend tests from `backend/` using `.venv/bin/pytest tests/unit -q` (existing venv, don't create a new one). Current baseline as of 2026-07-18 is **90 passed, 0 failed** — any new failures are yours to explain, not pre-existing.
3. Before committing, run `git status --short` on the specific files you touched. If any of them show unrelated pre-existing changes beyond your own diff, use `git add -p` and select only your hunks (see "Important — this repo has concurrent editors" above). Don't skip this — it's the difference between a reviewable commit and a misleading one.
4. This repo pushes to `origin` (`https://github.com/yashvardhansinh2510-max/forge2.0.git`) on branch `main`. Confirm with the user before pushing if you're unsure whether local commits are ready — and see the migration `0006` warning above before ever restarting a backend process against the live database.

### Known gotchas (don't rediscover these the hard way)

- **Migration idempotency:** `backend/migrations/` migrations must be forward-only and safe to run twice, but MongoDB's `create_index` throws `OperationFailure` code 85 (`IndexOptionsConflict`) if a same-key index already exists under a different name — this has happened twice already (see `migrations/0002` and `0003`'s docstrings). Always wrap `create_index` calls the way `migrations/0003`'s `_create_index_tolerant` helper does.
- **Catalog is an in-memory snapshot, not per-request Mongo queries:** `backend/services/catalog_service.py` loads the whole product catalog into memory at startup (Atlas is ~228ms round-trip away; the full catalog is a few MB) and refreshes on writes. Don't add per-request Mongo queries to catalog read paths — thread new filters through the existing `_matches_filters`/snapshot functions instead.
- **Floor `first-floor`'s display name is "The Sanitary Bathroom"** in the live `db.floors` collection, but its `id`/`slug` is still literally `"first-floor"` — don't rename the slug, only ever the `name` field, or every `floor_id` reference throughout the codebase breaks.

## Customer graph deletion and recovery — 2026-10-24

Customer-wide removal is owner-only from Customers, with exact preview/HMAC and
transactional graph cleanup. Ordinary quotation deletion remains document-scoped.
Preserve shared PO chalan evidence and actual dispatched quantities: raw legacy
stage labels cannot establish a stock return. Old unlinked Furniture matches
require explicit owner selection; new ledgers may bind a real floor-scoped ID.

The mutation-admission middleware and background follow-up/outbox admission prevent
in-flight child writes after graph deletion. Never expire writer tokens or clear
an exclusive token while old writers may still execute. See the operational
recovery procedure in docs/audits/2026-10-24-workspace-repair.md. No new migration.
