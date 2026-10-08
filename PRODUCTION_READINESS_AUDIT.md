# Forge 2.0 — Production Readiness & Deployment Audit

Audit scope: repository contents under `forge2.0/`, reviewed 2026-07-16. The report is based on code and configuration evidence only. Runtime infrastructure, deployment secrets, Atlas/Supabase settings, CI credentials, and store-console metadata were not available; those items are marked **Cannot Verify**, not assumed present.

## Executive summary

Forge is a substantial FastAPI + Expo application with JWT authentication, role checks, MongoDB persistence, Supabase media storage, audit events, and some transactional/idempotent workflows. It is not production-ready for thousands of customers or a public mobile-store release.

The most important blockers are:

1. A fresh database can receive a known demo owner account and password during startup (`backend/seed.py`), and the same credential is repeated throughout test tooling.
2. There is no repository-level Dockerfile, CI/CD workflow, EAS configuration, or native iOS/Android project. A reproducible backend deploy and App Store/Play Store release cannot be established from this repository.
3. Payment recording performs a read/check followed by a separate insert without a transaction or uniqueness/idempotency key; concurrent requests can over-collect.
4. The outbox is durable but has no continuously running worker, retry schedule, lease/claim mechanism, or dead-letter process. Runtime events can remain pending until a restart/manual action.
5. Backup/restore is a collection-level JSON script, not a scheduled, encrypted, retention-managed, verified disaster-recovery system.

## Status legend

- **Implemented** — evidence exists in the code/configuration.
- **Partially Implemented** — a mechanism exists but is not sufficient for the stated production requirement.
- **Missing** — no implementation/configuration was found.
- **Cannot Verify** — requires external infrastructure, secrets, or store-console access.

## Scores

Scores are risk-weighted engineering-readiness estimates, not test pass rates.

| Area | Score | Assessment |
|---|---:|---|
| Overall production readiness | 38/100 | Not ready; critical launch blockers remain |
| Backend | 58/100 | Implemented core domain, but concurrency, worker, and boundary concerns remain |
| Database | 45/100 | Index/bootstrap work exists; migrations, integrity, and recovery are incomplete |
| Security | 42/100 | JWT/RBAC/rate limiting exist; predictable credentials and upload/token exposure are blockers |
| Infrastructure | 20/100 | No reproducible deployment artifacts or CI/CD found |
| Performance | 48/100 | Catalog caching exists, but many capped full-collection reads remain |
| Reliability | 35/100 | Some outbox/idempotency exists; runtime processing and recovery are incomplete |
| Mobile deployment | 25/100 | Expo config exists; store-build/release evidence is absent |
| App Store readiness | 20/100 | Cannot verify required metadata/compliance; current identifiers/config are not release-grade |
| Google Play readiness | 25/100 | Expo Android config exists; production signing/store evidence is absent |
| DevOps | 15/100 | No CI/CD, container, IaC, or release automation found |
| Scalability | 40/100 | Fixed limits and in-memory controls will constrain growth |

## Findings

### P0 / Critical launch blockers

| Category | Component | Location | State | Problem / evidence | Risk | Recommendation | Effort |
|---|---|---|---|---|---|---|---|
| Authentication & security | Initial account provisioning | `backend/seed.py:20-33`; repeated in `backend_test*.py` | Implemented, unsafe | Startup seed defines `owner@forge.app` with `[legacy password removed; use injected test credentials]`; tests and reports repeat the same credential. A fresh production DB can therefore have a publicly discoverable owner password unless seed is prevented or the password is rotated before exposure. | Full administrative account takeover | Remove production demo seeding; require a one-time bootstrap flow with a random, expiring credential or an externally provisioned owner; rotate any exposed account and scrub test fixtures. | 1–2 days |
| Business integrity | Payments | `backend/routes/payment_routes.py:272-304` | Partially implemented | The overpayment check aggregates existing payments, then inserts a new payment separately. Two concurrent requests can both observe the same outstanding balance and both insert. There is no transaction, unique request key, or atomic balance guard. | Incorrect financial records and over-collection | Add an idempotency key and unique index; perform balance validation and insert in a transaction or use an atomic ledger/balance model; add concurrent integration tests. | 3–5 days |
| Delivery / infrastructure | Backend deployment | Repository-wide inventory | Missing | No `Dockerfile`, compose/deployment manifest, CI workflow, release script, or infrastructure-as-code was found. `.emergent/emergent.yml` contains only platform metadata. | Deployments are not reproducible, auditable, or safely rollbackable | Define a pinned production image, process command, health/readiness probes, environment contract, migration step, and CI build/test/security pipeline. | 3–7 days |
| Mobile release | iOS/Android production build | `frontend/app.json`; repository-wide inventory | Partially implemented | Expo app metadata exists, but there is no `eas.json`, native `ios/` or `android/` project, signing configuration, build profile, store metadata, privacy manifest, or release workflow. Current app name is `frontend` and identifiers are `com.emergent.forgesanitaryware.x4kuaf`. | App Store/Play release cannot be proven or repeated; review may reject the binary or branding | Establish the production Expo project/owner, final bundle/package IDs, EAS profiles and secrets, signing, privacy disclosures, store metadata, staged rollout, and release checklist. | 5–10 days |

### P1 / High priority

| Category | Component | Location | State | Problem / evidence | Risk | Recommendation | Effort |
|---|---|---|---|---|---|---|---|
| Reliability | Outbox processing | `backend/server.py:105-109`; `backend/services/domain_outbox.py:257-265`; `backend/routes/quotation_routes.py:691` | Partially implemented | Events are dispatched at startup/manual call, while request paths also use fire-and-forget `asyncio.create_task`. There is no long-running worker, lease/claim, exponential backoff, retry ceiling, or dead-letter queue. | Order automation, payments, notifications, or follow-ups can remain pending or be lost on process termination | Run a durable worker/queue with atomic claiming, retry policy, dead-letter alerts, and an outbox backlog metric; avoid untracked request-scoped tasks. | 4–7 days |
| Database | Schema evolution | `backend/bootstrap.py`; `backend/scripts/ensure_indexes.py`; `backend/scripts/*reimport*.py` | Missing | Bootstrap validates collections/indexes, and one-off scripts mutate data, but there is no versioned migration framework or migration history. | Deploying code against an older database can silently fail or corrupt data; rollback compatibility is undefined | Add numbered, reviewed, idempotent migrations with preflight, locking, rollback/forward-compatibility rules, and CI execution against a clean database. | 4–8 days |
| Database | Uniqueness and numbering | `backend/routes/quotation_routes.py:34-38`; `backend/services/domain_outbox.py:106-110`; `backend/bootstrap.py:70-75` | Partially implemented | Quotation/PO numbers use `count + 1`; concurrent creates can collide. The product SKU uniqueness index is explicitly deferred because an existing duplicate remains. | Failed writes, duplicate business identifiers, or inconsistent catalog data under concurrency | Use atomic counters or retry-on-duplicate allocation; resolve existing SKU duplicates and enforce the intended compound uniqueness at the database layer. | 2–4 days |
| Security | Upload validation | `backend/routes/media_routes.py:29-40,75-83`; `backend/routes/purchase_routes.py:408-451` | Partially implemented | Uploads are read fully into memory before size validation. SVG is allowed without sanitization, and media is routed to storage based on MIME supplied by the client. | Memory exhaustion, active-content/XSS risk, and unsafe files in shared storage | Stream with hard request limits, inspect magic bytes, rasterize or reject SVG, scan PDFs/images, store untrusted files privately, and generate safe derivative URLs. | 3–5 days |
| Security | Token in URL | `frontend/src/api/client.ts:62-68`; `backend/auth.py:181-207` | Implemented, unsafe | Browser downloads append JWTs as `_t` query parameters. URLs can enter browser history, proxy logs, analytics, referrers, and screenshots. | Session theft | Replace with an authenticated streaming endpoint or short-lived, single-use download token; redact query strings from all edge/access logs during migration. | 2–3 days |
| Security / operations | Rate limiting | `backend/services/rate_limit.py:1-24` | Partially implemented | Login limiting is explicitly process-local and resets on restart; it does not coordinate across replicas. | Brute-force protection is bypassable through replicas/restarts | Move counters to Redis/managed shared storage and add edge/WAF limits; retain per-account and per-IP limits. | 2–4 days |
| Reliability | Health semantics | `backend/server.py:41-54`; `backend/routes/misc_routes.py:38-123` | Partially implemented | `/api/health` returns HTTP 200 even when Mongo ping fails. `/api/health/system` performs live DB/storage/count checks but also returns detailed counts/errors publicly and does not use a distinct readiness status. | Load balancers can route traffic to an unhealthy instance; public endpoint leaks operational/data-volume information | Make liveness cheap and always 200; make readiness return 503 when dependencies fail; protect detailed diagnostics behind admin/internal auth. | 1–2 days |
| Disaster recovery | Backup and restore | `backend/scripts/backup_db.py`; `backend/scripts/restore_db.py`; `backend/routes/settings_routes.py:71-76` | Partially implemented | Manual JSON snapshots and a pull/restore script exist, but no scheduled job, retention policy, encryption/key management, immutable copy, checksum, RPO/RTO target, or automated restore drill is present. The catalog endpoint is download-only and explicitly says restore is not implemented. | Recovery may fail or expose sensitive business data; backup age is unknown | Use managed Mongo backups/PITR plus encrypted object snapshots, retention and deletion policy, scheduled verification, restore-to-isolated-cluster drills, and documented RPO/RTO. | 5–8 days |
| Observability | Monitoring and alerting | `backend/services/monitoring.py`; `frontend/src/lib/monitoring.ts:27-42` | Partially implemented | Sentry/PostHog are no-ops until credentials are supplied. Frontend monitoring has no session replay/autocapture, and no dashboards, alert rules, SLOs, or on-call routing were found. | Incidents and client crashes can go undetected | Configure production Sentry with source maps, structured logs, correlation IDs, metrics/traces, dashboards, alert thresholds, and ownership/on-call procedures; define privacy-safe analytics events. | 3–6 days |
| Cross-platform release | iOS permissions | `frontend/app.json:11-16,45-49` | Partially implemented | The config uses `NSPhotoLibraryUsageInfo`; Apple expects the usage-description key. Camera permission/configuration is not present, and actual native permission behavior cannot be verified without a build/device. | App rejection or runtime permission failure | Validate generated Info.plist and Android manifest in a release build; use the correct usage-description keys and only request permissions at point of need. | 1–2 days |
| Mobile release | Notifications/deep links/offline | `frontend/package.json`; `frontend/app.json:8`; `frontend/src/state/auth.tsx:54-195` | Partially implemented / Cannot Verify | No push-notification package or device-token backend was found. The deep-link scheme is the generic `frontend`; no offline queue, network reachability, or mutation retry strategy was found. | Broken auth return paths, no operational notifications, poor behavior in mobile network conditions | Define production deep-link ownership/verification, implement push only if required, add reachability/offline UX and safe retry/idempotency for mutations, then test real iOS/Android builds. | 4–8 days |

### P2 / Medium and low findings

| Category | Component | Location | State | Problem / evidence | Risk | Recommendation | Effort |
|---|---|---|---|---|---|---|---|
| Performance / scalability | Full-collection reads | `backend/services/catalog_service.py:121-125`; `backend/routes/customer_routes.py:20`; `backend/routes/payment_routes.py:346-348`; `backend/routes/quotation_routes.py:55-58` | Implemented, risky | Several endpoints load hundreds/thousands of documents with hard-coded caps (`500`, `1,000`, `10,000`, `20,000`, `50,000`) and sort in application memory. | Latency, memory spikes, incomplete results, and rising database cost | Use cursor pagination, projections, server-side aggregation, bounded exports, and load tests at target cardinalities. | 3–6 days |
| Database | Query indexes | `backend/scripts/ensure_indexes.py:36-117`; `backend/bootstrap.py:33-75` | Partially implemented | Core catalog/user/order indexes exist, but the reviewed index set does not demonstrate a complete strategy for frequent `customer_id`, `created_at`, payment, activity, and portal queries. | Collection scans and latency at customer scale | Capture representative query plans, add compound indexes based on measured access paths, and enforce index checks in CI/preflight. | 2–4 days |
| API design | Versioning and contracts | `backend/server.py:44-79` | Missing | All routes are under `/api` with no version prefix, generated contract governance, or compatibility policy. | Breaking changes become difficult to roll out safely | Add `/api/v1`, OpenAPI review in CI, deprecation policy, and contract tests for web/mobile clients. | 2–4 days |
| Error handling | Boundary leakage | `backend/routes/quotation_routes.py:512-516,686-689`; `backend/routes/catalog_import_routes.py:134-135` | Partially implemented | Some 5xx responses include raw exception text. | Internal implementation details, URLs, or provider data may leak to clients | Return stable public error codes/messages, log full exceptions server-side with request IDs, and add centralized exception handling. | 1–3 days |
| Security / test hygiene | External test fixtures | `backend_test*.py`, `backend/tests/test_forge_backend.py`, `test_reports/*.json` | Implemented, unsafe | Tests contain fixed preview URLs and reusable owner/customer credentials. | Accidental production/preview access and credential reuse | Use environment-provided test secrets, isolated seeded test databases, secret scanning, and remove credentials from historical reports. | 1–2 days |
| Operations | Version/release identity | `backend/routes/misc_routes.py:20-22`; `backend/server.py:44` | Partially implemented | Version strings are manually hardcoded (`1.0.0`, `0.1.0`) and comments acknowledge no build pipeline derives them. | Rollback/debugging ambiguity | Stamp builds with commit/version metadata and expose it only in authenticated diagnostics/health headers. | 1 day |

## Missing production systems

- **Missing:** reproducible backend container/deployment manifest.
- **Missing:** CI/CD workflow with tests, type/lint checks, dependency/security scan, artifact promotion, and rollback.
- **Missing:** versioned database migration system.
- **Missing:** continuously running outbox/background-job worker with retry and dead-letter handling.
- **Missing:** shared rate-limit/session-cache strategy for multiple replicas.
- **Missing:** scheduled backup, retention, encryption, restore verification, and disaster-recovery drill automation.
- **Missing:** production dashboards, alert rules, SLOs, and on-call ownership.
- **Missing:** complete App Store/Play Store release metadata and signing workflow.
- **Missing:** push notification/device-token system (if notifications are a product requirement).
- **Missing:** offline mutation queue and network-aware UX.
- **Missing:** formal API versioning and compatibility policy.
- **Cannot Verify:** production secrets, Mongo Atlas configuration/backups, Supabase bucket policies, WAF/edge limits, TLS/HSTS/CSP headers, store-console compliance, privacy policy/terms, real-device behavior, load-test results, and deployment rollback behavior.

## Critical launch blockers

1. Remove/disable predictable production seed credentials and rotate any exposed account.
2. Make payment recording atomic and idempotent; add concurrent-write tests.
3. Establish a reproducible deployment and release pipeline for backend and mobile.
4. Add a durable background worker and operational retry/alerting for outbox events.
5. Implement versioned migrations and a verified backup/restore/DR process.
6. Complete mobile permission, deep-link, privacy, signing, and store metadata review on real release builds.

## 30-day stabilization plan

### Days 1–7: stop catastrophic failure modes

- Remove demo seeding from production and rotate credentials.
- Ship atomic/idempotent payment recording and atomic document-number allocation.
- Replace URL JWT downloads with short-lived download authorization.
- Correct readiness/liveness status codes and protect diagnostic details.
- Add upload streaming/magic-byte validation and reject or sanitize SVG.

### Days 8–14: make operations repeatable

- Add Docker/build artifacts, CI checks, dependency scanning, environment validation, and version stamping.
- Add migration runner and pre-deploy compatibility checks.
- Deploy a worker for outbox processing with retries, leases, dead-letter state, and alerts.
- Configure Sentry, structured logs, correlation IDs, dashboards, and alert routing.

### Days 15–21: data and scale hardening

- Move rate limiting to shared infrastructure.
- Measure query plans and add pagination/projections/indexes.
- Resolve duplicate SKUs and enforce database uniqueness.
- Add payment/order concurrency tests, failure-injection tests, and load tests.
- Establish managed backups, retention, checksums, restore drills, and RPO/RTO documentation.

### Days 22–30: mobile and launch certification

- Create production Expo/EAS profiles, final identifiers, signing, privacy metadata, and store assets.
- Validate iOS/Android permission prompts, deep links, safe areas, keyboard/landscape/tablet layouts, offline behavior, and crash reporting on release builds.
- Run staging-to-production promotion, smoke tests, rollback rehearsal, and a final go/no-go review.

## Production launch checklist

- [ ] No predictable seeded credentials or shared test credentials in deployed data/source.
- [ ] Production secrets injected by secret manager; rotation procedure tested.
- [ ] CI passes lint, type checks, unit/integration/security tests and dependency scan.
- [ ] Versioned migrations reviewed, rehearsed, and backward-compatible with rollback plan.
- [ ] Payment/order mutations are atomic and idempotent under concurrency.
- [ ] Outbox worker, retry, dead-letter, and alert paths verified.
- [ ] Liveness/readiness probes return correct HTTP statuses.
- [ ] Backups are scheduled, encrypted, retained, and restored in an isolated environment.
- [ ] Sentry/logs/metrics/dashboards/alerts and on-call ownership are active.
- [ ] Pagination and representative load tests meet latency/error budgets.
- [ ] Upload security, storage visibility, and file cleanup verified.
- [ ] iOS/Android release builds tested on supported devices and OS versions.
- [ ] Store IDs, signing, privacy disclosures, permissions, deep links, and support URLs are final.
- [ ] Privacy policy, terms, data export/deletion process, and audit-log retention are approved.
- [ ] Staging smoke tests pass for staff login, customer portal, quotation, order, payment, PDF, media, and recovery flows.
- [ ] Rollback and incident-response rehearsal completed.

## Final verdict

**Not Ready for Production.**

The application has meaningful implemented domain functionality, but predictable credentials, payment concurrency, missing delivery automation, incomplete durable processing, and unverified mobile/DR requirements make a paying-customer launch unsafe. Reassess after the P0 blockers and the first two stabilization phases are complete.
