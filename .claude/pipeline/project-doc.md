# BuildCon House project documentation

## Ground Floor completion delta — 30 October 2026

Native fallback delta scan retains Expo/React Native Web, FastAPI, MongoDB and
the existing authorization/transport layers; no new framework, dependency or
authentication pattern is introduced. Mobile tile editors use bounded media and
adaptive paired fields. Ground/Sanitary lists request bounded Mongo summaries and
literal server search. Migration 0042 adds the stable-order read index without
rewriting business data. Linked Lost follow-ups close their quotation outcome and
sibling reminders transactionally. Existing order outbox/replay ownership remains.
The URI decoder override receives its published 0.5.1 security patch, retaining
the Router compatibility adapter and a full-sized malformed-input regression.
Verification and publication evidence: docs/audits/2026-10-30-ground-floor.md.
Coverage percentage is not measured. No architectural regeneration is needed.

## Kitchen saving and mobile editor follow-up — 30 October 2026

Native fallback delta scan: captured Kitchen file-finalization failures originate
in uncaught Cloudflare private-bucket visibility timeouts. Verification now runs
both domain checks concurrently within five seconds, shares only in-flight proof,
and returns retryable503 without exposing private bytes or losing staged parts.
Production entry removes only its manager approval requirement; closure approval,
financial checks and historical bindings remain. Current unbound quotation edits
follow the finalized design. Mobile tile workflow actions reclaim their space
during input. No dependency, framework, collection or database migration is added.
See docs/audits/2026-10-30-kitchen-save-reliability.md. AGENTS records the explicit
business-rule correction; architecture and authentication stay unchanged.

## Kitchen intake, Today and blue accents — 29 October 2026

Native fallback delta scan: Kitchen intake reuses its existing form and service,
with required name/phone/address; Site location is removed under the user's
latest correction, including old required-policy and draft-save gates. Customer history
and successful command replays remain. Shared Today now scopes Kitchen employee
tasks to current assignment and is reachable from Kitchen phone/sidebar navigation.
Canonical action/focus/selection roles restore the original blue palette with
white/graphite content. No new dependency, migration, framework, architectural
layer or authentication pattern; AGENTS.md needs no architectural update.
Changed files and verification: docs/audits/2026-10-29-kitchen-leads-today-blue.md.
Last scanned: 2026-10-29.

Generated: 27 October 2026. Native fallback scan for Ground Floor refinement.

## Tech stack and entry points

Expo Router/React Native Web with React 19 and TypeScript, built from root app/.
FastAPI async backend in backend/server.py, MongoDB through the shared Motor
client in backend/db.py. Runtime media storage uses the configured R2 adapter;
private files remain private. Web API entry is root api/ and the same-origin
cookie/CSRF proxy. Vercel serves web; Railway runs one FastAPI worker/replica.

## Architecture and conventions

Route screens use shared src/components and floor/auth state. Native and web
API transports are separate src/api/client modules with matching cancellation,
context isolation, bounded cache and mutation invalidation contracts.
Backend routes use services for workflow, idempotency and transactions, and
models for request/response validation. Monetary writes remain transactional and
replay-safe; optional notification/cache effects follow successful commit.

Collections include quotations, payments, customers, purchase_orders,
customer_orders, dispatches, chalans, walkins and followups. Ground and Sanitary
use distinct floor IDs. Query helpers/explicit floor pairs must scope every
business read and write. Numbered migrations are controlled and additive.

## Testing and current scope

Pytest unit/HTTP tests run with isolated CI settings; explicit disposable Mongo
checks use generated test databases. Browser fixture suites intercept writes,
with immutable every-route stability on four devices and separate performance
budgets. Coverage percentage was not measured. No new framework, architecture,
authentication pattern or dependency is introduced in this refinement, so
AGENTS.md remains unchanged.

Changed areas: walkin assignment; customer stage visibility; followup clutter;
Tile Orders spacing; Payments history, read concurrency and actor attribution;
Ground navigation caching; Redis outage/invalidation recovery; additive read
indexes and corresponding regression tests. Detailed findings and acceptance:
docs/audits/2026-10-27-ground-floor-refinement.md.

## Performance delta — 27 October 2026

Shared auth reads now coalesce within revocation generations. Native/web GETs
release transports once every consumer has canceled; surviving consumers remain
independent. Best-effort timeline insertion has a one-second budget. Transactional
financial audit paths are unchanged. No framework, dependency or architecture
change. The latest user contract is recorded in AGENTS.md. Evidence:
docs/audits/2026-10-27-kitchen-keyboard-reliability.md.

Kitchen now keeps nine-stage navigation, explicit adjacent commands, compact
Details and top Actions, with search/paging and no filter/attention UI. Mobile
web focus retains the header and reclaims hidden navigation space. Shared field
wrappers draw rounded focus rings, including a forced-colors fallback.

## Main consolidation and UI repair — 27 October 2026

Native fallback delta scan: no framework or architecture change. Main becomes
the only release source at the user's explicit request; forward-source checks
and production build admission enforce this in the existing tooling. Follow-up
docks/menus, owner salesperson filters, Kitchen queue stages/date affordances,
brief list reuse and Payments initial loading are corrected. A clean install
uses two scoped dependency overrides with actual-consumer compatibility coverage.
Current verification ledger: docs/audits/2026-10-27-followup-release-regressions.md.


## Sales simplification — 27 October 2026

Native fallback delta scan: the existing Expo/FastAPI/Mongo architecture,
transport and session boundaries remain. No dependencies or migrations added.
Sales Data now exposes Sales, References and Customers; old report bookmarks
redirect. `SalesScope` keeps report choices; `sales-summary` aggregates confirmed
quotation sales, current per-order balances and live follow-up counts. Reference
contacts load independently of ranked performance. Work remains floor-scoped;
operational drill-downs require a concrete unit. Financial reads and live
follow-ups are uncached, including Furniture deposits not analytics-versioned.
Confirmed Kitchen orders contribute to INR financial totals; finalized Furniture
ledgers retain separate RNB totals. Actual catalog products remain Tiles/Sanitary
only, without inventing project product attribution.
Meaningful verification includes the real disposable-Mongo accounting test,
unit shaping/access tests, populated five-width browser scenarios and mandatory
four-device stability/performance gates. AGENTS.md records the new three-view and
four-department contract. Detailed contract: docs/sales-design-contract.md.


## Reliability and stock/reference workflow — 28 October 2026

Native fallback delta scan against main 923578e1. No new framework, dependency,
authentication pattern or architectural layer. PyMongo receives only the 4.18.3
security patch in both existing requirement sets. Kitchen flushes routine Lead/Visit/
CAD drafts before leaving those stages; commercial decisions keep explicit save.
Notifications are retired; Kitchen Follow-ups routes redirect before data reads.
Purchases revalidates on focus and optional exact-product previews have a one-second
budget, preserving recorded images and primary rows on preview failure.
Godown manual intake registers reusable catalog identities; receipts and outgoing
adjustments use atomic lot guards and actor-bound replay receipts. Reference detail
now lists and pages the same deduplicated acquisition cohort used in counts,
including non-converted walk-ins with custom UTC date windows. Migration 0040 adds
only read indexes for these exact-reference queries. The new real-Mongo stock and
reference workflows run in CI against its isolated service. Verification and
publication evidence: docs/audits/2026-10-28-reliability-stock-references.md.

## Application performance continuation — 28 October 2026

Targeted native fallback delta scan in the isolated performance checkout. The
Expo/FastAPI/Motor architecture and authentication boundaries remain unchanged;
no framework or dependency is added. Kitchen detail and queue components use
the existing lazy/Suspense pattern. Quotation validation, usage counters and
transactional dispatch stock operations use bounded batches of 500. Existing
open follow-up refreshes also batch in order, retaining per-insert notification
and per-resolution audit ownership. Referrer directory bodies use server paging
and literal search over authorized floor unions/shared contacts; report rows
explicitly identify historical references independently of the loaded page.

Cloudflare R2 is the active image store. Public display derivatives preserve
originals and private file policies. A resumable backfill defaults to measurement;
Worker/backend/frontend publication and production backfill require the release
gate. Migration 0041 is additive, locally verified and pending production
application through the controlled job. Public entry HTML has a 60-second edge
policy; mutable authenticated reads retain no-store. Detailed measurements,
current acceptance and remaining limits belong in
docs/audits/2026-10-28-application-performance.md. No AGENTS.md architecture
change is required.

## Unified Sales Analytics — 29 October 2026

Native fallback delta scan: existing Expo/FastAPI/Mongo architecture, dependencies,
API transport and authentication are retained. The supplied PDF replaces the
three-view sales simplification with five dashboards, shared entity profiles,
source drilldowns, reports and PDF/Excel exports. New route/service files follow
existing analytics layering. Stable IDs, customer confirmations and currency
separation drive all financial views; quotation history is an independent read.
Owner-only duplicate reviews reuse settings IDs and optimistic concurrency, with
append-only decision events; canonical identities are never silently merged.
No schema migration, backfill or production data rewrite is introduced.
Verification includes hermetic unit/HTTP tests, disposable Mongo integration,
real browser fixtures at five widths and the unchanged full performance gate.
Coverage percentage is not measured. Current evidence and limits:
docs/audits/2026-10-29-sales-analytics.md.

## Floor Today, design consistency and affected checks — 29 October 2026

Native fallback delta scan of the current diff retains Expo/FastAPI/Motor and the
existing resource/floor authorization model. `services/today_dashboard.py` is a
read-only floor work projection. Department-limited payloads contain safe tasks
and recorded progress; full-floor overview reads run separately. Sales Data is
owner-only at the shared authorization boundary, and payment history no longer
unions business floors. No schema migration or business-data rewrite is needed.

The shared system font, Feather icons and graphite/neutral tokens remain.
Today uses a task-first bento layout; owner floor analytics omits self-comparison
charts. The acceptance checklist covers every page family and account viewpoint;
legacy palette instructions are reconciled. Development checks discover affected
transitive contracts, retain compact logs and reuse input-bound successes. Shared
or unknown changes fall back conservatively, while the final release gate remains.

Changed files and verification are recorded in
`docs/audits/2026-10-29-floor-today-design-performance.md`. Coverage percentage
is not measured. AGENTS.md now records the user's new Today/reporting contract so
a future change cannot restore the superseded homepage behavior. No new framework,
dependency, database, session mechanism or architectural directory is introduced.

Last scanned: 2026-10-29.

## Kitchen payment/material update — 29 October 2026

Kitchen orders embed dated installment receipts and explicit material arrival.
Analytics includes advances once plus installments. Installation material-list
photos reuse private project attachments and verified transport. Production's
existing completion date derives from its start plus two calendar months on UI
and server, with explicit work status. No dependency, migration or architectural
layer is introduced. See docs/audits/2026-10-29-kitchen-installments-materials.md.

## Android intake and portrait PDF delta — 29 October 2026

Native fallback scan of the requested changes retains Expo/React Native/FastAPI/Mongo and the shared control/transport boundaries. Android inputs prevent fullscreen IME extraction; native hidden navigation releases height and browser keyboard viewports resize. Walk-in intake has name, phone and required address with existing duplicate/floor assignment controls. Register search coalesces reads and its optional summary is independent. PDFs use portrait A4, readable cover metadata, existing logos plus supplied Verantes Living beside Vitra, product-page-only watermark and dated customer filenames. No framework, architectural directory, dependency, authentication change or migration is introduced; AGENTS.md requires no architectural update. See docs/audits/2026-10-29-android-walkins-pdfs.md for final verification and publication evidence.
Last scanned: 2026-10-29.
