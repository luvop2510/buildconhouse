# Mobile sign-in, font readiness and navigation

The owner reported changing fonts/icons, slow startup and unusable navigation on
iPhone Safari. This repair builds on `aa7edce9` in `kitchen-audit`.

## Confirmed defects

- Expo's web font loader treats an existing CSS font-face rule as loaded. Its
  Safari font observer is disabled. Static HTML and hydrated login could therefore
  paint before Inter had decoded. Feather was loaded lazily rather than with the
  interface fonts. A WebKit reproduction holds all font responses and observes
  the old login form already visible; deployed cold-cache samples also show
  interactive controls while Feather is still loading.
- Phone navigation waited for the legacy role matrix even for owners and members
  whose delegated grants already determine visibility. Delayed-matrix login tests
  reproduce inert bottom navigation after the content and floor controls load.
  The unnecessary wait is removed only for those identities. Floor hydration,
  legacy role restrictions, API authorization and granted destinations remain.

## Repair

All platforms preload the installed, bundled Feather font alongside Inter. Web
static output shows a loading indicator rather than a fallback-font form. The
browser explicitly loads and verifies all five font faces before mounting the
navigator. Session restoration starts concurrently. A failed or stalled font
request reaches visible recovery within twelve seconds; late completion cannot
silently replace that recovery screen. Successfully decoded fonts remain the
readiness authority, so a late Expo observer error cannot unmount a live form.

Safari can cache a failed font URL across a reload. An explicit recovery action
sets a one-use retry nonce. On the next mount only the known application font
faces' same-origin source URLs receive that nonce. Ordinary loads retain their
immutable asset URLs. No automatic reload discards an active form or session.

## Verification and limits

The delayed-font and delayed-matrix regressions fail against the baseline. The
new four-device browser cases cover first paint, same-context reload, HTTP font
failure/retry, stalled requests/late completion, actual login, content scrolling,
floor switching, active-page replacement and legacy role restrictions. They are
mandatory in the stability gate and its evidence inventory, with zero retries or
skips. Focused checks and the complete current-source audit must pass before
publication; historical results do not qualify these changes.

Anonymous production evidence is retained in
`output/mobile-startup-2026-10-23/README.md`. One health request took 7,248 ms,
including 2,802 ms of backend processing and 6,539 ms of proxy upstream time;
other health samples completed in hundreds of milliseconds. One cold browser
sample spent most of thirteen seconds waiting for HTML/scripts. These delays
are additional to the confirmed font/navigation defects. They do not establish
provider sleep or justify an unverified authentication rewrite. The currently
serving upstream configuration and actual authenticated production latency
remain to be qualified.

The reported multiple-pages-in-one-viewport symptom was not independently
reproduced. A single blank Android reload is retained in the evidence, but did
not recur in subsequent normal-cache and cold-cache samples; no causal claim is
made for it. Browser emulation does not certify a physical iPhone.

## Publication

The public deployment references different entry assets from the starting local
export. A fresh export and guarded deployment are required before these fixes
can benefit existing production sessions. The existing required checks and
publication protections remain in force. No provider plan/billing change,
production account modification or customer-data write is part of this repair.
