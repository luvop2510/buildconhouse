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
