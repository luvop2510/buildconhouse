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
