# Shared request performance — 27 October 2026

This branch starts from actual production source `2d009a33`, independently verified
in Vercel deployment `dpl_GLRtphzv6nHqr8uMEvbpkWhup8uS` and Railway deployment
`ab2375de-8613-473b-92b8-3b050b12f57a`. Newer Kitchen work remains separate;
no branch merge or unrelated working-tree edit is included.

## Baseline and causes

The actual request path is Expo/React Native Web → same-origin Vercel cookie/CSRF
proxy in Mumbai (`bom1`) → one always-running Railway FastAPI worker/replica in
Singapore → shared Motor/MongoDB Atlas pool. Provider metadata confirms project
`buildcon-house`, root frontend, backend root `/backend`, Docker startup and
readiness. The running datastore region still needs a provider-level observation.
The application already reuses Mongo connections and bounds catalog snapshots;
backup folders are excluded from upload/build/watch contexts. No index or hosting
change is justified by this investigation.

Thirty current live Ground read samples (five per endpoint, same QA session) all
returned 200. Median/max client HTTP milliseconds: Walk-ins 276/778, Customers
220/305, Follow-ups 360/463, Payments orders 279/371, Payment History 497/595,
Tile Orders 330/524. These include proxy/network time, and do not reproduce a
production timeout. A bounded 24-hour provider log retrieval returned 202 requests:
179 HTTP 200, 23 HTTP 401, zero HTTP 5xx and no request above ten seconds. The
slowest was readiness at 2,520 ms. Logs are a bounded sample, not an outage census.
Reports retain numeric timings, timestamps and correlation IDs without records,
credentials or full log payloads.

Three controlled experiments isolate remaining shared defects:

* Twelve concurrent cold same-session auth calls cause 24 Mongo reads and 12
  last-seen writes. Five samples with 40 ms synthetic reads and a 20-slot pool
  have median 82.72 ms. Coalescing reduces this to two reads/one write and
  41.52 ms median under identical conditions. The existing ten-second cache
  lifetime, session/MFA validation and revocation behavior remain unchanged.
* Eight distinct superseded search GETs reject their callers but keep all eight
  transports alive. Native/web transports now abort after the last consumer
  releases. The same actual-client test leaves zero active obsolete transports.
  A surviving or unsignaled consumer keeps its request; mutations are not retried.
  Browser abort is not proof that a remote database query was canceled.
* A real ASGI customer PATCH commits its update and then stalls indefinitely
  inside the documented best-effort activity insert. Before the fix the 1.8-second
  HTTP regression deadline expires despite the saved record. Activity insertion
  now has a one-second consumer budget. Transactional financial/outbox audit
  writes are separate and unchanged. An uncertain Mongo insert may still finish
  later; no replay is introduced. Timeline delivery was already best-effort.

## Changes and checks

`backend/auth.py` shares only in-flight validated reads, keyed by kind, subject,
session, collection and revocation generation; the map is bounded and each caller
gets its own mapping. `backend/services/activity_log.py` bounds optional insertion
and logs only failure type/event, avoiding arbitrary driver messages.
`src/api/client.ts` and `client.web.ts` track consumers and evict abandoned reads
before cancellation. Both preserve mutation invalidation and workspace/account
generations. Focused tests cover surviving consumers, cancellation, replacement,
revocation races, inactive/MFA sessions, failure cleanup, capacity and HTTP save.
Test-server ports can be assigned per checkout while defaults, deadlines,
coverage, zero retries and immutable exports remain unchanged.

Focused backend acceptance: 206 passed. Full hermetic backend suite: 3,411 passed
(six existing dependency deprecation warnings). Actual native/web API contract
checks pass, including 16 mutation/read races and eight canceled searches per
client. Initial typecheck passed. Independent backend and frontend review found
no actionable issue; review limitations are recorded above. There are 94 source
pages (102 TSX files including layouts), all inherited by the four-profile route
stability verifier. Final complete stability/timing/source qualification is still
pending; local evidence is under `output/shared-timeout-performance`.

The first export attempt failed because Metro could not resolve a dependency
symlink outside this new worktree. A local clone of the existing dependencies
fixed that without changing dependencies. The first browser audit could not bind
an occupied port; the run now has a separate port. Interrupted/failed runs are
retained and do not count as passing evidence.

## Release boundaries

No production deployment is claimed here. Rollback references are the two
verified production deployments above and source `2d009a33`. No schema/data
migration or production business mutation is included. Any candidate must retain
the current backend target and configured secrets; no access controls or payment
semantics change. Live cold/reload readings, post-release comparison, safe mutation
acceptance and provider runtime verification remain separate release checks.

Current npm audit has six high dependency findings (Expo/Sentry/node-forge/Zod).
Protected main requires backend/frontend/frontend-security/performance and one
independent approval, with administrator enforcement. Existing promotion guards
also require their complete reviewed release package. This task does not waive
those requirements or reuse an old release exception. Physical Android/iOS and
software-keyboard behavior remain unverified.
