# Page crashes and deployment session recovery — 15 October 2026

The incident investigation uses parallel page, session and release-check review.
It separates observed faults from explanations that cannot be confirmed from the
user's original browser session. It changes no customer, stock or quotation data.

## Confirmed failures and repairs

The browser BFF issued session-only cookies. Mobile browser process dismissal
could therefore lose the HttpOnly credential even though the account-kind marker
remained in local storage. Successful login and identity restoration now persist
the session and paired CSRF cookies through the upstream JWT expiry, capped at
30 days. Existing valid cookies upgrade on identity restoration. JWT validation,
server session revocation, HttpOnly, Secure and SameSite protections remain.
An incorrect current-password proof no longer clears an unrelated valid session.

Identity hydration previously cleared credentials on all 403 responses and
published signed-out routing after transient failures. Workspace permission errors
and temporary deployment/network outages now retain credentials behind a recovery
view, with two bounded automatic retries plus explicit/foreground/network retry.
Account-wide reads omit stale workspace headers. Native and browser startup had
separate AuthGate implementations; one shared component now owns routing and
recovery, and the release gate rejects a new platform-specific copy. Both floor
access implementations omit the selected floor while reading assigned floors.
Authoritative invalid/revoked sessions still return to login.

Page render/lazy import failures could escape to the Expo root. React Navigation
screenLayout now contains page failures below the navigator and authenticated
shell. Wrapping the navigator itself initially lost its route during an injected
fault; the regression caught that implementation mistake before publication.
Ordinary page failures expose retry/home navigation. Failed same-origin Expo
modules expose explicit reload, retaining authentication. React lazy caches an
import rejection, so rendering that same rejected module again is insufficient.

The old startup helper matched webpack's "Loading chunk" but omitted the
installed Expo AsyncRequireError "Loading module" signature and request URL.
Classification now covers the actual loader while retaining same-origin and
asset-path restrictions. Mounted forms are never automatically reloaded.
An inert startup stalled without an error/DOMContentLoaded exposes manual reload
after 20 seconds; a late successful mount removes that recovery panel.

Production logs also contained invalid Mongo regular expressions and discarded
warehouse audit events. Literal user search now escapes punctuation in purchases,
payment lists/history, walk-ins and duplicate detection. Parentheses, brackets,
backslashes, plus signs and wildcard-looking text have actual query regressions.
The activity entity schema accepts godown_stock, so stock mutation events persist.
These logging/search failures are confirmed defects, not proof of the cause of
every reported page crash.

## Evidence and prevention

Fresh authenticated production probes opened the full 1,015-lot inventory,
quotation list, new builder and existing quotations in Chromium and WebKit without
captured JavaScript crashes on those successful visits. Separate document/asset
loads intermittently stalled from this machine. Backend metrics over 24 hours
showed about 0.45 GB current and 0.77 GB peak memory under a 1 GB limit; this sample
does not establish an out-of-memory cause. A missing stale module reproduces a
failure that previously had no page-level recovery. The original failing device
session was unavailable, so no universal single-cause diagnosis is claimed.

Earlier route smoke checks used mostly failing API fixtures and pageerror alone.
React-caught console errors and a visible error fallback could evade that guard.
The mandatory current-source Performance/pre-push audit now also tests every
discovered page on Android Chrome, iPhone Safari, iPad Safari and desktop Chrome,
using an immutable export. Populated warehouse/quotation navigation, render faults,
real module-download failure, session 503/403 recovery, revocation, browser history
and startup recovery are mandatory scenarios. Health guards reject browser crashes,
React errors, failed own assets and remaining error boundaries. Evidence verification
rejects absent routes/devices/scenarios, skipped/expected failures, retries, flakes,
runner errors, increased test deadlines and unsupported pass counts.

Local backend acceptance: 2,527 hermetic unit tests, including 30 new search and
activity regressions. Actual AuthProvider lifecycle acceptance: 105 cases across
web/iOS/Android. Transport, cookie/CSRF, privacy and guard-failure tests pass.
TypeScript and zero-warning Expo lint pass. Read-only Mongo/index/Supabase preflight
passes and migration dry-run reports no pending migrations. The complete release
browser/performance gate must pass before the GitHub push; provider IDs and actual
post-deployment acceptance belong in the final release ledger and PR verification.

The independent dependency-security gate still reports 22 high and five moderate
npm findings, with no critical findings. They are neither suppressed nor treated
as passing. Main retains administrator enforcement, strict required backend,
frontend, frontend-security and performance checks, plus an approving review.
Publish on the existing reviewed feature branch without bypassing that protection.
The Vercel project is on Hobby; no paid platform upgrade is made. Preserve the
existing Railway service, Singapore placement and signing/encryption secrets.
Optional Sentry is unconfigured in this production environment; no external error
alert delivery or physical-device/native signing acceptance is claimed.

## Provider runtime packaging correction

The first Vercel rollout built successfully but returned API 500s. Immediate
post-deploy verification caught it and production was rolled back to the prior
healthy frontend. Runtime logs confirmed ERR_REQUIRE_ESM: Vercel's CommonJS
function loader rejected the newly imported web-worker.mjs. Direct development
imports had not simulated that loader. The Railway backend remained healthy and
a pre-deployment session continued to authorize reads after its rollout.

Cookie generation now lives in a canonical CommonJS helper, loaded by Vercel and
inlined into the standalone browser worker at build time. Regression tests execute
the actual transpiled API with ESM require disabled and boot the actual standalone
worker without local module imports. The pre-push audit now requires these API
packaging tests too. No cookie security or expiry rule is loosened.

Frontend publication uses a production candidate with --skip-domain. The
promote-verified-vercel script verifies the exact source SHA, project and READY
state, then runs actual candidate API/asset/cache/security checks before promotion.
Its tests prove inspection, verification and source mismatch failures prevent the
promotion command. Candidate browser session checks precede invoking this guard.
A successful provider build alone is insufficient release acceptance.

## Reported customer click path and wording correction

The user clarified that every customer click was affected, and supplied the
Follow-ups screenshot: the requested correction is the name **Won orders**.
Both the tab and completed section use that wording. Its established attribution
and owner filters remain unchanged; this is not a request to expose everyone's
orders or alter won/lost classifications.

Required regressions now click both Won/Lost imported customer rows, render a
40-line document with decimal quantities, absent MRPs and collapsed rooms, then
enter its populated editor and return to the 1,015-lot warehouse. These eight
new checks pass across all four browser/device projects. The follow-up workflow
suite, including the corrected tab with preserved attribution, joins the required
stability audit. Previously, quotation route smoke fixtures were mostly empty.

The promotion guard now runs the authenticated browser verifier itself; a manual
claim that someone opened the preview cannot substitute. It blocks promotion if
real imported quotation clicks/editor restoration, warehouse search, the Won
orders wording, persistent paired cookies or an unseeded browser-context restart
fail on desktop Chromium or iPhone WebKit. All unsafe API methods are aborted;
probe reports contain counts and scenario names without customer records or
credentials. A short-lived run-owned QA session is an explicit required input.
Optional provider protection headers are restricted to the deployment origin,
never product-image hosts. Guard tests verify browser failure also stops before
the promote command. Do not turn off provider or application authentication.
