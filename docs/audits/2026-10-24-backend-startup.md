# Backend startup recovery — 24 October 2026

The website now starts a shared anonymous readiness check in parallel with font
and local-storage initialization. It gives a sleeping backend up to 60 seconds
to become ready, continuing immediately on the first successful response. This
is a recovery budget, not a forced delay or a one-minute API timeout. A ready
result is reused for one minute; overlapping startup callers share one attempt.

Each readiness request has a four-second browser deadline and a 3.5-second
upstream proxy deadline, including its response body. Failed probes are spaced
one second apart. Ordinary API calls retain their existing 30-second browser
and 28-second upstream limits. No writes are retried. Production uses the
same-origin proxy; direct local Expo development retains its configured API base.

The startup screen says “Waiting for backend server”, “Starting backend server”
and “Backend server is awake”, according to the readiness result. Once the
minute expires it provides an explicit retry and retains the session and saved
destination. Automatic session recovery cannot start consecutive minute-long
attempts. Public pages and the anonymous login form remain usable during a
background wake; credential submission waits for readiness before sending once.

The root and child navigators remain mounted. Leaf screen effects and workspace
metadata reads wait for authoritative identity restoration, so route hooks do not send data requests
while the server is asleep. After first admission, screens retain their mounted
forms and drafts during session recovery. Expo may temporarily normalize a
pending nested route to `/access`; the existing initial-route storage retains
the requested path and restores it after account/floor checks finish.

This change updates the website and its API proxies. It does not change the
Render plan, database, storage, backend source or access policy. A separate
frontend-only publication guard verifies the unchanged running backend revision,
candidate source, independent review, complete performance evidence and
authenticated desktop/tablet/mobile behavior before promoting the existing site.

## Verification

The focused browser regressions exercise wake-up, awake feedback, request
ordering, retained destination/credentials, the full minute using virtual time,
terminal recovery and explicit retry. Controller and real-proxy tests cover
immediate warm completion, a wake around 50 seconds, bounded attempts, anonymous
uncached probes, cancellation, shared callers and unchanged ordinary timeouts.
Final release results and deployment identities are recorded after publication.

Focused acceptance before the release audit: eight startup/proxy unit cases,
105 existing authentication race cases, TypeScript and focused ESLint pass.
The 54-case desktop/tablet/phone startup, sign-in and floor workflow run had
51 passes and three stale static-sign-in fixture assumptions. The export has
deliberately shown a static font-readiness indicator since the prior startup
repair; those three checks now require the explicit waiting indicator and no
interactive form before runtime initialization, then a real successful sign-in.
All three corrected cases pass without retries or increased deadlines. Both
new wake/recovery cases pass on all three viewport profiles.

The first full audit caught a Back/Forward regression caused by deferring a
nested navigator at the root screen layout. The corrected gate wraps leaf
content inside the existing group navigators. The web-specific floor hook and
permission/chrome reads also wait for identity. The failed audit is retained;
only a complete new audit may qualify the corrected source for publication.

After this correction, all 12 wake/recovery and browser Back/Forward/reload
cases pass on Android Chrome, iPhone Safari, iPad Safari and desktop Chrome.
Eight unit cases include a response body that stalls after successful headers;
it is aborted within the same four-second probe budget. TypeScript, focused
ESLint and authentication race cases pass. Full publication acceptance follows.
