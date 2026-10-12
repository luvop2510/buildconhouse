# Team contact and sign-in recovery — 12 October 2026

Team contact edits now preserve account identity, passwords, sessions and page
access. Email, phone and mobile are separate optional fields, with consistent
validation and explicit clearing. The contact grid uses three columns in wider
drawers and wraps on phones.

## Confirmed defects and repairs

- The edit form resubmitted unchanged usernames, legacy roles and delegation
  settings. It now sends only changed fields. The backend also skips access
  normalization for contact-only edits and invalidates display caches without
  revoking valid sessions. Actual role/access changes still revoke sessions.
- Email/mobile updates were ignored, and null phone updates did not clear the
  value. Writes now validate email and telephone strings, normalize email case,
  accept blank/null contact clearing, reject duplicates with 409, and retain at
  least one valid email or username. Compare-and-set identity updates prevent
  concurrent requests from removing different remaining sign-in identifiers.
- Numeric/object legacy contacts and malformed emails could break staff login
  or hydration model validation. Reads tolerate those records while writes stay
  strict. The frontend also contains unexpected contact response types before
  they reach text inputs. Structured validation errors remain readable.
- A stale session cookie made fresh credential login depend on its old CSRF
  cookie. Both web proxies now require the application's exact Origin for
  credential login, drop the old bearer and allow new credentials to replace
  stale cookies. Other authenticated writes retain double-submit CSRF. The
  browser client no longer URI-decodes CSRF cookies before sending them.
- JK's reset account has an automatically assigned email login alias. Team
  hides only that exact legacy reset alias until explicit email entry, including
  entry of the same address. Authentication retains the existing alias. Other
  legitimate legacy addresses remain visible; new contact provenance is explicit.
- Failed list refreshes preserve usable rows. Request generations reject stale
  responses after account changes or deletion. Contact-only saves remain usable
  when delegation options fail, while access edits still require a current grant
  snapshot. Team responses exclude password hashes and MFA secret material.

These defects are verified by code and reproducing tests. No retained production
stack trace establishes that every defect contributed to the originally reported
incident. The read-only current account audit found no malformed contact types.

## Performance and cleanup

Delegated sign-in now overlaps its floor-access and personal-grant reads and
publishes identity only when authorization is ready. Controlled provider tests
verify overlap, cancellation, logout and outage behavior on web/iOS/Android.
Bootstrap reuses each collection's index metadata instead of querying it again
for uniqueness checks. Shared contact validators, safe public serialization and
field-level PATCH replace duplicated or unnecessary work. All 11 web route
budgets pass; no live latency percentage improvement is claimed.

## Validation

- Final backend source: **2,187 hermetic unit tests passed**. Ten dependency or
  existing Pydantic deprecation warnings remain recorded.
- Two disposable local Mongo integrations pass: contact/login/reload/logout/
  deletion lifecycle and delegation/session enforcement. They verify migration
  idempotency, multiple username-only accounts, database-enforced email uniqueness,
  JK contact edits preserving the active session/password and invalid legacy data.
- Broad browser acceptance: **372 six-width cases and 240 four-engine cases
  passed**, without retries. Coverage includes Team, auth transitions, access,
  cold reloads and startup recovery, across 320–1440px widths and Android Chrome,
  iPhone Safari, iPad Safari and desktop Firefox browser profiles.
- Final frontend response-type/grid follow-up: **48 six-width and 32 four-engine
  contact cases passed**, without retries. Wider layouts assert all three contact
  inputs share a row; malformed responses cannot crash display or editing.
- TypeScript, zero-warning lint, contact/API/proxy/worker/auth lifecycle contracts,
  web and unsigned iOS/Android exports, route budgets and Expo Doctor 20/20 pass.
  Optional frontend drift comparison has no configured baseline and is not a pass.

Browser journeys use actual built assets and intercepted APIs. Real Mongo tests
use disposable local databases. Neither establishes physical-device or signed
native acceptance. Production probes use no real account passwords, create no
test accounts and change no account credentials.

## Migration and release

Migration `0032_optional_staff_email` builds a unique string-only partial email
index before dropping incompatible legacy email constraints. It preserves every
user document and unrelated index. Bootstrap checks the exact partial constraint.
A private BSON-preserving users/index snapshot passed byte readback before the
controlled migration. After migration, every user document was identical to the
snapshot. Read-only Mongo/index/Supabase preflight passes; no migrations remain.

Backend commit `8cb0eb7c8e1b89a416796ab6b5dffdd4b599412b` reached Railway
SUCCESS in deployment `92692934-99ef-424d-86a0-aa02ed08fabd`. Readiness is 200,
and live OpenAPI confirms optional email, mobile and update contracts. The initial
Vercel release `dpl_DTRdEs1WF48SmqpKtQNhWNYfJ6qZ` serves the repaired source;
19 read-only route/asset/header/auth probes pass. Live stale-cookie credential
requests reach backend validation (422); foreign-origin login and invalid-CSRF
logout remain 403. The final frontend follow-up and post-publish probes are
tracked in the local `output/team-contacts-2026-10-12/deployment-journal.json`.

The unchanged npm graph reports **22 high and five moderate findings**. The
independent security gate remains failing and is not suppressed. Backend
production dependency auditing reports no known vulnerabilities. Local functional
acceptance and successful deployments do not establish overall green CI.
