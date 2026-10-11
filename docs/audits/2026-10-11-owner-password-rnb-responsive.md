# Owner-managed staff passwords, RNB and responsive acceptance

Staff previously received temporary credentials with a mandatory password change
and expiry. This produced the reported first-login prompt, including legacy staff
accounts using the JK portal. Staff credentials now remain valid until the owner
changes them. Authentication normalizes the old flags without a production data
rewrite. Customer onboarding retains its existing temporary-password policy.

Only owners can read or manage Team accounts, set a specific member's password,
generate a credential, delete members, or allocate access. The API enforces this
even when a non-owner has custom page grants. A reset writes only the target
account, hashes the credential and revokes that member's sessions. Staff cannot
call the self-service password endpoint; owners change their own password through
Settings using their current password. Optional usernames are normalized and
uniqueness conflicts return 409.

Deletion disables access, clears delegation and revokes sessions while preserving
historical attribution. Deleted account identities remain reserved and cannot be
reactivated through Team. Active owners cannot be deleted, disabled or demoted
through Team, avoiding concurrent removal of every owner. Atomic updates reject
stale role/status changes. Owner accounts always receive full access, including
accounts with obsolete restricted profiles.

Furniture now displays RNB in navigation, ledgers, deposits, PDFs, validation and
sharing text. Existing `RMB` stored values and `amount_rmb` API fields remain
compatible; amounts and conversion calculations are unchanged. Horizontal scroll
guidance follows the actual ledger width. Team cards fit long names at 320px.

Safari acceptance exposed a hard-navigation race: a cancelled identity request
could erase saved credentials and drafts. Hydration now clears storage only for
authoritative 401/403 responses, allowing reload recovery after network failures.
Owners changing their password through a direct Settings URL now return to
Settings even when no navigation history exists.

## Verification

All tests used isolated API fixtures or hermetic unit-test settings. Browser
acceptance did not create production accounts, change real passwords or send
messages. Production readiness checks were read-only.

| Check | Result |
| --- | --- |
| Backend unit suite | 2,072 passed; six existing deprecation warnings |
| Python compile / pyflakes | Passed |
| TypeScript / Expo lint | Passed; zero lint warnings |
| Frontend contract scripts | 34 passed, including 84 authentication lifecycle cases |
| Expo Doctor | 20/20 |
| Production web export | Passed |
| Web route gzip budgets | All 11 passed; largest approximately 437 KiB, limit 576 KiB |
| Unsigned iOS / Android Hermes exports | Both passed |
| Six-width browser acceptance | 636 passed, six intentional skips, no failures or flakes |
| Android Chrome (Pixel 7 profile) | 58 passed |
| iPhone Safari (iPhone 13 profile) | 58 passed |
| iPad Safari (iPad Pro 11 profile) | 58 passed |
| Desktop Firefox | All 58 passed in an isolated one-worker run |
| Read-only predeploy | Mongo access, required indexes and Supabase buckets passed |
| Migration dry-run | No pending migrations |

Six-width acceptance covers 320, 390, 768, 1024, 1280 and 1440px. The six skips
are intentional: phone-only More navigation on larger viewports and desktop/tablet
sidebar cases on phones. The four browser profiles use Chromium, WebKit and
Firefox with touch/viewport emulation where applicable. They do not certify every
OS version or real hardware. Native exports are unsigned; signed builds and
physical devices remain unverified.

The first device run had 230 passes and two Firefox failures while the six-width
suite was running concurrently. One failed inside Playwright's page creation
before app code; the other hung during its identity request. The entire Firefox
project subsequently passed in isolation with unchanged deadlines and no retries.
Both reports are retained locally. No failure was hidden by raising timeouts.
The earlier concealed-parts test was corrected to await both customer and product
draft persistence before reload; the application was unchanged for that fix.

The optional `test:frontend-drift` check is unconfigured because no
`FORGE_ROUTE_BASELINE` exists. It is not a required CI contract and is not counted
as passing. The separate npm audit gate remains failing: 22 high and eight
moderate findings, zero critical. A prior CI run on the base branch failed all
three jobs before any steps because GitHub reported account billing/spending
restrictions. Those external gates have not been waived. No live deployment or
production password changes were performed.

Structured results and local log locations are recorded in
`2026-10-11-owner-password-rnb-responsive.json`. Private logs and generated
artifacts stay in the ignored `output/` directory.

The implementation is committed as `f259f8f6` in draft
[PR #16](https://github.com/yashvardhansinh2510-max/buildconhouse/pull/16), based on
the existing team/floor/performance work in PR #15. Review and merge that
dependency before promoting the combined result. PR #16's
[CI run](https://github.com/yashvardhansinh2510-max/buildconhouse/actions/runs/38140636826)
also failed all three jobs before any steps started. Its check annotation confirms
the GitHub billing/spending restriction; remote source tests did not execute.

The initial automatic Vercel preview failed before Expo export because its preview
environment lacked a valid `BACKEND_URL`. The branch-specific preview variable
was configured to the established Railway HTTPS endpoint; production environment
variables were unchanged. A later source push retriggers the automatic preview.
That preview uses the currently deployed backend, so it does not demonstrate the
new backend password policy until a separately gated backend release occurs.

Preview deployment `dpl_7BfTZF5atWwcyfJGawbwyehEhv2J` reached **Ready** for
documentation commit `12fa6ed9` with the same runtime implementation as `f259f8f6`.
Read-only HTTP checks at
`https://buildcon-house-hj800j8qj-yug19.vercel.app` verified `/login` 200 with CSP,
`/api/health/ready` 200 and unauthenticated `/api/auth/me` 401. This is a branch
preview, not a production promotion or signed-native release.

## Additional verification and URI security repair

The current `09b406d6` branch preview also reached Ready as
`dpl_8RrjEgKtrhznaTKwmfmFEty6xAev`, at
`https://buildcon-house-d3x4ktz8k-yug19.vercel.app`. Hosted acceptance intercepted
every API request and completed with 227 passes and five failures. Four failures
occurred in `page.goto` while loading pages; the furniture compatibility redirect
did not reach its destination within its assertion deadline. Traces include
unfinished asset requests and one entry bundle taking approximately 11 seconds.
All ten focused cases across Android and iPhone passed in an isolated one-worker
run, with unchanged deadlines and no retries. This does not erase the original
hosted failures or establish a production latency guarantee.

The published [URI decoder advisory](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)
identifies 0.5.0 as the patched version. The project now pins that release through
npm overrides and Yarn resolutions. Expo Router 55 consumes query-string 7's
CommonJS API, while the patched decoder exports an ES module default. The
postinstall compatibility repair unwraps that default without copying the decoder
or changing the router/framework version. A bounded subprocess tests four large
malformed inputs through query-string, alongside username, Unicode and repeated
query-parameter round trips. The regression is required by frontend CI.

After a clean `npm ci`, the patched web build, unsigned iOS/Android Hermes exports,
TypeScript, zero-warning lint, all 35 frontend contract scripts, all 11 route
budgets (largest 439 KiB) and Expo Doctor20/20 pass. The entire device suite passes
**236 cases**, 59 each in Android Chrome, iPhone Safari, iPad Safari and desktop
Firefox, using two workers and no retries. A new controlled pending-floor
regression verifies no notebook requests run before authorized floor access is
known, then checks the furniture redirect, heading and active floor. It passes
all four browser profiles and all six viewport sizes. Backend source is unchanged
from the implementation commit covered by the 2,072 passing unit tests.

The fresh audit falls from 30 to **27 findings: 22 high/five moderate**, zero
critical. Remaining blockers include the [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
and [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv), both
still reporting no patched releases. Registry checks confirm braces 3.0.3 and
node-forge 1.4.0 remain the latest published versions. The independent security
gate remains enforced.

The current PR CI run `38141249427` again stopped all three jobs before any
source-check steps; its annotation confirms the same GitHub billing/spending
restriction. A read-only production `/openapi.json` check confirms that Team
deletion and `TeamPasswordResetPayload` are absent, and reset-password has no
request body: the new backend policy has not been released. The local environment
has neither `simctl` nor Android adb/emulator tooling. Physical devices, signed
native builds and actual Windows/Linux client acceptance remain unverified.

## Goal completion audit

| Requirement | Current evidence | Completion limit |
| --- | --- | --- |
| Permanent, intended-member credentials without first-login changes | Login/session normalization; username binding, target-only bcrypt write and legacy JK expiry tests; browser sign-in flows | Implemented and tested; live backend remains unchanged |
| Only owner creates/deletes members and changes their passwords | HTTP and direct-call denial for every non-owner role/custom grants; owner create/reset/delete flows; session revocation tests | Implemented and tested; live backend remains unchanged |
| Owner manages all functions | Owner normalization overrides stale profiles/grants; all-floor and module access tests | Source and browser behavior verified |
| Furniture displays RNB | Ledger/deposit/PDF/share label tests and legacy payload arithmetic compatibility | Branch preview and local artifacts verified; production release pending |
| Smooth use across devices/viewports/OS | Six viewport audit, 236 final browser-profile passes, six pending-floor cases and unsigned native exports | Hosted timing failures retained; hardware, signing and Windows/Linux clients unverified |
| Address discovered problems and report completion | Password/auth/UI fixes; URI security patch; recorded original and rerun results | Full goal remains incomplete while release and platform acceptance gates are open |

The goal is not complete. Repeated external release blockers require GitHub
billing restoration, resolution of the remaining dependency gate and access to
the outstanding platform/device acceptance environment. No real staff passwords
or accounts were changed by this verification work.
