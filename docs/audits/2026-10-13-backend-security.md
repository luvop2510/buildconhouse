# Backend stability and security verification — 13 October 2026

The backend unit suite was run with CI's isolated localhost Mongo URL,
`forge_ci_unit_tests` database, placeholder Supabase credentials and production
configuration safeguards. Tests mock their dependencies; the application
lifespan was not started and no production data was mutated. Runtime remains
FastAPI/Motor with MongoDB, bearer JWT sessions, server-side floor/role/profile
and delegated-action restrictions, and Supabase media storage.

## Confirmed session cache race and repair

Two deterministic interleavings could preserve revoked authentication state in
the same process:

1. A session/principal read captures a valid session, pauses, cache invalidation
   occurs, and the read resumes and refills the cache with its earlier snapshot.
2. Revocation clears the cache before awaiting Mongo. While that write is
   pending, another request reads the still-valid session and refills the cache.
   Revocation then returns successfully without clearing that entry.

Eight new regression cases all failed before the repair. They cover account-wide
and single-session invalidation during reads, owner/reset helper revocation,
logout, logout-all, device revocation, password-change other-session revocation,
and MFA session changes.

`auth.py` now records a bounded cache generation before reading and only stores
the result when no invalidation occurred during that read. Revocation paths in
`auth.py` and `routes/auth_routes.py` invalidate again after their database write,
clearing entries created while the write was pending and invalidating overlapping
reads. This runs in `finally`: a network acknowledgement failure can occur after
Mongo has committed a revocation. Six additional deterministic committed-write /
failed-acknowledgement cases failed against the first repair and pass after this
follow-up. Database errors still propagate to callers; clearing a cache does not
pretend the write succeeded. Existing cached entries for unrelated users are preserved. Unrelated
invalidations can cause an overlapping read to skip one cache fill, with no
additional database reads or retained per-account generation tombstones.

This repair preserves the existing 2,048-entry / ten-second principal cache.
`HEAD:backend/auth.py` already documented that TTL and its revocation grace
before this change. Other processes can therefore still hold a previously
validated principal for the remaining ten-second window. This patch does not
claim cross-worker instantaneous revocation or cancel an operation whose
authentication read began before revocation. Subsequent same-worker requests
cannot use cache entries refilled by the repaired races.

## Validation

| Check | Result |
| --- | --- |
| Baseline full unit suite | 2,248 passed, 10 warnings, 31.93 s |
| New race tests against baseline | 8 failed, 0.53 s |
| Focused auth/owner/MFA/delegation/portal/download suite after final security repair | 260 passed, 2.74 s |
| Full unit suite after security and concurrent catalog fixes at this snapshot | 2,280 passed, 10 warnings, 27.95 s |
| CI compile scope | Passed |
| CI pyflakes scope after its documented unused-name filtering | No substantive findings |
| Changed Python files unfiltered pyflakes | Passed |
| Diff whitespace validation | Passed |

The full suite includes authorization, floor isolation, owner-only account
management, cross-customer records, delegated pages/actions, mutation scoping,
password/reset and quotation/payment regressions. It is hermetic coverage, not
a penetration-test certificate or proof of every live query plan. The times
above describe test execution, not before/after endpoint performance.

Twelve focused HTTP regressions also exercise customer portal list/detail
ownership on the same floor (both customers, foreign ID, identical missing-ID
404, own records and empty list), invalid JWT signatures and unsigned/unsupported
algorithms rejected before principal lookup, and Mongo operator-object staff /
customer login inputs rejected with 422 before login logic. Combined focused
authorization/session/portal/download/MFA coverage passes 260 cases in 2.74 s.

Additional read-only review inspected delegated-action and current-profile
checks, owner-management HTTP dependency cases, cross-floor record lookup,
customer PDF download ownership, atomic login throttling, spreadsheet formula
escaping, remote-image host/public-IP and size checks, and monitoring/private
import failure redaction. API proxy, web worker and actual-client contracts
were rerun and passed, including same-origin login, cookie/header CSRF checks,
HttpOnly session handling, cookie isolation, mutation/read races and timeouts.
An AST survey found 320 declared route handlers with direct dependency signatures
except the two logins, logout and two provider webhook handlers; those manual
JWT/provider HMAC boundaries were inspected. This is a structural inventory,
not proof that every dependency implements correct authorization. The existing
mutation floor gate also explicitly checks helper presence, not correctness.
Domain isolation is by floor; no separate multi-organization tenant system or
exhaustive penetration testing is claimed.

Existing Mongo driver protections were checked: bounded 20-connection pool,
10-second connection/server-selection/wait-queue timeouts and 30-second socket
timeout. Existing analytics cache keys distinguish unrestricted/empty scopes
and include floor/filter/version inputs; shared cache misses and concurrent
independent reads are already implemented. No new noncatalog query bottleneck
was established in this review.

## Fresh dependency evidence and remaining gate

`pip-audit 2.10.1 -r backend/requirements-prod.txt` resolved 48 runtime
dependencies and found no known vulnerabilities (exit 0). This audits the
production requirements used by Docker/CI, not the legacy preview freeze.
The exact resolved versions are retained in
`2026-10-13-backend-pip-audit.json`.

A fresh root `npm audit --json` and required `check-npm-audit.mjs` reproduce
22 high / five moderate findings, zero critical, and gate exit 1. The exact
report is retained in `2026-10-13-backend-npm-audit.json`.

| Advisory root | Installed / fresh npm latest | Installed path | Patched release |
| --- | --- | --- | --- |
| braces | 3.0.3 / 3.0.3 | Expo 55.0.31 → @expo/metro 55.1.2 → metro-file-map 0.83.8 → micromatch 4.0.8 | None |
| node-forge | 1.4.0 / 1.4.0 | Expo → @expo/cli 55.0.36 and @expo/code-signing-certificates 0.0.6 | None |
| sprintf-js | 1.0.3 / 1.1.3 | React Native 0.83.10 → babel-jest 29.7.0 → babel-plugin-istanbul 6.1.1 → @istanbuljs/load-nyc-config 1.1.0 → js-yaml 3.15.2 → argparse 1.0.10 | None |

The official GitHub advisories were fetched again on 13 October. All three
list no patched version: [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
[node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and
[sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
Updating sprintf-js to its latest release would still fall in the affected
range. Installed Expo 55.0.31 and React Native 0.83.10 equal the latest releases
on their respective compatible lines, checked via fresh npm registry queries.

The fresh report suggests React Native 0.87.1 for braces/sprintf-js and an
Expo 44.0.6 downgrade for node-forge; both are marked major changes. Those are
dependency graph replacement suggestions, not compatible published fixes for
these advisory roots. Fresh registry metadata also shows latest Expo 57.0.28
uses @expo/cli ^57.0.29, whose latest release still requires node-forge ^1.3.3.
An SDK upgrade alone therefore does not demonstrate removal of that root.
No compatibility-safe published remediation was found for the three roots.
No manifest/lockfile mutation, advisory suppression or gate weakening was made.
The required npm security gate remains a release blocker.

Summary evidence is in `2026-10-13-backend-security.json`. No production
deployment, backend restart, migration, real email/message, or destructive
security test was performed.
