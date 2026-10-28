# BuildCon House project documentation

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
