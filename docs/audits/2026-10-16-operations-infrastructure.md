# Operations and infrastructure audit — 16 October 2026

This is a read-only production inspection plus focused workflow hardening. It
must be read alongside the current frontend/backend acceptance report. Provider
READY/SUCCESS states are deployment state, not application readiness. No billing,
provider settings, business records, secrets or deployment targets were changed
by this audit. No load/stress traffic was sent to production.

## Immediate production blocker

Direct Railway `/api/health` returns 200/`ok`, while `/api/health/ready` returns
503. The canonical `https://buildconhouse.in` and legacy Vercel alias reproduce
503 readiness; unauthenticated quotations return 401 at all three origins.
Local read-only preflight confirms Mongo connectivity and required indexes pass.
Authenticated Supabase bucket discovery returns HTTP 402 with this provider
message:

> Service for this project is restricted due to the following violations:
> exceed_storage_size_quota. The project owner must upgrade their plan or remove
> spend caps to restore service.

This is a storage quota restriction. Replacing application code, retrying requests
or weakening readiness cannot restore storage. The project owner must resolve
Supabase billing/quota, then rerun both bucket checks, media integrity and public
readiness before promotion. Existing files were not removed to free space. Current
readiness conflates Mongo and storage errors as “database unavailable”; the parallel
backend review owns a focused diagnostic correction retaining HTTP 503 on failure.

## Inspected deployment identities

- Vercel canonical domain resolves to production deployment
  `dpl_7HwRvRYyr8caMrjbdYxLCokvcJLj`, reported READY.
- Railway deployment `4d3d9f65-1f32-4fc7-8010-9228f1701886` is SUCCESS with one
  RUNNING instance. Its source message identifies
  `3e2d0901b8142f9b40455a6319624b80deeb8f05`.
- Railway actual service manifest confirms Dockerfile, `/backend` root,
  `/api/health/ready`, Singapore `asia-southeast1-eqsg3a`, one replica,
  `sleepApplication=false`, restart-on-failure/max five. There is no Railway cron.
- Only configuration presence was printed: production `REDIS_URL` and
  `SENTRY_DSN` are absent; `MFA_ENCRYPTION_KEY` is present. Mongo pool overrides
  are absent, so code defaults apply. No configuration values were recorded.
- Docker is unavailable on this host, so no local image-build claim is made.
  The latest GitHub backend job, including Docker build, passed for its own SHA.

## CI and delivery

[Latest inspected CI](https://github.com/luvop2510/buildconhouse/actions/runs/38780018885)
ran source `4710f545ccf677513721ca2b5241e93d729622d7`: backend passed;
frontend-security failed; frontend failed its audit/responsive/device browser
steps. Recorded browser counts were audit 2,155 passed/9 failed/39 skipped,
responsive 550 passed/2 failed/15 skipped, devices 609 passed/3 failed/16 skipped,
zero reported flakes. Artifact upload succeeded. Newer local commits are not
certified by this older run. The associated
[Performance run](https://github.com/luvop2510/buildconhouse/actions/runs/38780018866)
passed. Latest inspected hourly uptime run succeeded before the present storage
restriction; it does not override current 503 observations.

PR #16 remains OPEN/BLOCKED/REVIEW_REQUIRED. Live main protection requires
backend, frontend, frontend-security and performance, strict up-to-date status,
one approving review and administrator enforcement. No protection was bypassed.
A fresh `check-npm-audit.mjs` run still fails with 22 high/five moderate findings,
zero critical. This audit does not suppress findings, remove gates or change Expo
major versions. Current-source full browser/performance evidence, a green security
gate and required review remain necessary for protected-main release.

Workflow changes in this review:

- Operations and hourly uptime now target the client-facing canonical domain,
  so a broken custom-domain/DNS/TLS route cannot be concealed by a working legacy
  Vercel alias. Direct Railway probing remains.
- CI, Performance and Pre-deployment Gate explicitly request only
  `contents: read`; their checkouts no longer persist the GitHub token in Git
  configuration for later dependency/build commands.

Validation: all six workflow YAML files parse; assertions confirm the three
hardened workflows' read-only permissions and every checkout's disabled credential
persistence. `test-service-health.mjs` and `test-uptime-monitor.mjs` pass, including
false readiness, access-boundary failures, timeouts, malformed/missing evidence
and redaction checks. These focused checks do not substitute for executing the
workflows on the final pushed source.

## Requested infrastructure assessment

“Present” below describes inspected implementation, not blanket production
certification. “Not deployed” means adding a new distributed platform is not a
bug fix for the current single-service architecture. “Unverified” identifies
acceptance evidence still needed.

| Requested area | Actual scope and verification boundary |
| --- | --- |
| APIs | FastAPI/Mongo/Supabase with a same-origin Vercel BFF. Public auth boundary is 401; readiness currently fails on Supabase 402. Authenticated business acceptance is a separate release gate. |
| CI/CD | Functional/security/performance workflows and guarded promotion exist. Latest CI is failing; protected main requires review. No all-green claim. |
| Rate limiting | Atomic login reservation, per-IP/account/email limits and bounded 20,000-key fallback; multipart concurrency/body limits. Redis sharing is implemented but unconfigured in production. Restart resets local limits; horizontal scale needs shared configuration/acceptance. Not an application-wide request quota or DDoS certificate. |
| Load balancing / reverse proxies / API gateways | Vercel BFF and Railway managed ingress; one backend replica, so no multi-replica failover proof. Proxy enforces origin/CSRF/body/time boundaries. No separate Kubernetes ingress or API-gateway service was found. |
| Caching / cache invalidation | Bounded floor/session-aware frontend caches, catalog snapshot and analytics TTL/version caches; hashed web assets immutable, HTML/API no-store. Redis is absent; cross-worker invalidation is not instantaneous. Full CDN invalidation under sustained traffic is unverified. |
| Docker | Digest-pinned Python base, allowlisted runtime COPY, build-time import/assets smoke test, non-root runtime, readiness healthcheck, runtime PORT. GitHub Docker step passed on the inspected older SHA; no Docker engine locally. |
| Kubernetes / service discovery | No Kubernetes manifests/controller cluster in this deployment. Managed provider DNS/origins connect the services. Kubernetes discovery is not deployed. |
| Circuit breakers / timeouts | Explicit Mongo connect/server-selection/socket/wait-queue limits; upstream proxy aborts, HTTP client limits and catalog refresh failure cooldown. No general circuit-breaker state machine was found; do not claim one is configured. |
| Retries / exponential backoff | Mongo retryable reads/writes, bounded client/session recovery and outbox attempts exist. Outbox runs at a fixed 30-second cadence and stale claims wait 120 seconds; not a universal exponential-backoff policy. External message sends intentionally avoid ambiguous retries. |
| IDAM / Auth | JWT with server-side sessions/revocation, role/profile/delegated action and floor restrictions, MFA, HttpOnly/Secure/SameSite web cookies and CSRF. No external identity federation/SCIM provider is configured. Credential encryption root is present. Penetration testing and real-device acceptance remain separate. |
| Queues / pub-sub / events / dead-letter queues | Mongo transactional outbox with atomic claims/idempotent handlers and persisted dead-letter state after eight attempts. In-process worker drains it. No Kafka/RabbitMQ/external pub-sub broker is deployed. |
| Distributed transactions / saga | Mongo sessions/transactions cover associated database writes/outbox. Workflow handlers are idempotent. This is not a cross-provider two-phase commit or a general saga orchestrator; Supabase/notification side effects are not part of Mongo's transaction. |
| Cron jobs | Hourly GitHub uptime schedule; in-process outbox/periodic share cleanup. Railway cron is absent; exact schedule delivery is not guaranteed by GitHub. |
| WebSockets / long polling / SSE | No application WebSocket/SSE/long-poll transport handlers found. Dependency presence is not a configured feature. Ordinary HTTP reads are current architecture. |
| Database indexes / query optimization / N+1 | Read-only required-index preflight passes. Bounded pooled connections, catalog snapshots/pagination, projection/batch hydration and parallel independent reads exist. Every endpoint's live explain plan/N+1 behavior has not been certified. |
| Connection pooling | Shared Motor client; default maximum 20/minimum zero, 10-second connect/server-selection/wait-queue limits, 30-second socket timeout. No runtime override present. |
| Read replicas / sharding / partitioning / replication | Mongo Atlas is managed; database topology/failover/read preference were not certified in this audit. No application read-replica router or custom shard/partition controller was found. Floor isolation is logical scope, not physical sharding. |
| Leader election / CAP / eventual consistency | Mongo/provider internals own consensus/failover. CAP is a design constraint, not a switch to test. Outbox processing/caches introduce bounded eventual behavior; a partition/failover drill was not performed. |
| Optimistic/pessimistic/distributed locks | Atomic conditional updates, unique indexes, transactional guards and outbox claim IDs; migration runner has an expiring database lease. Process-local locks protect selected caches/reconciliation. No general distributed lock service or pessimistic table-lock design. |
| Race conditions / deadlocks / thread safety | Existing targeted auth/cache/order/stock/floor/claim regressions and event-loop locks; bounded thread-safe PDF image cache/worker pool. Backend parallel review owns newly found defects. Exhaustive race/deadlock freedom is not established. |
| Memory leaks / garbage collection / back pressure | Bounded caches/list mounts/catalog snapshot limits, upload semaphore and bounded Mongo/PDF work. Python/JS own GC. No sustained production memory/GC/soak or saturation drill was performed, so leak freedom and maximum capacity remain unverified. |
| Auto/horizontal/vertical scaling | Actual backend is one no-sleep replica. Automatic scaling and multi-replica cache/revocation/worker behavior are not certified. Horizontal scale needs Redis/shared-state and load/worker acceptance first; no paid capacity changes were made. |
| CDN edge stressing / CS-CAC invalidation | Security/cache/source promotion checks exist. No production edge stress was authorized as a distinct destructive/cost exercise. “CS/CAC” is ambiguous; ordinary cache invalidation is assessed above. |
| Feature / Flex / blue-green development | “Feature” and “Flex” do not identify a testable requirement. Current delivery uses a verified Vercel candidate followed by alias promotion; Railway has a single-replica rollout, not an independently verified blue-green backend topology. |
| Logging / alerts / security | Structured/redacted operational evidence, request timing, hourly failure checks and owner-scoped operational endpoints. Sentry is absent in production. Operator notification receipt is unverified; workflow failure is not proof an owner received an alert. Current quota incident and npm gate are open security/reliability blockers. |

## Release boundary

A production update should remain blocked while storage readiness is 503. After
owner quota restoration, rerun dependency/media/predeploy gates and source-bound
four-device acceptance, push the reviewed source without bypassing the local
performance hook, await final-source CI, then use the authenticated Vercel candidate
promotion guard and verified Railway build context. Confirm post-deploy identities,
actual region/replica settings, public readiness/API/security/cache checks and
real authenticated read-only journeys. Browser emulation does not establish signed
native build or physical iOS/Android acceptance.
