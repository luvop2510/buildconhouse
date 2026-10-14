# Performance is a release constraint

Every push and pull request runs the independent **Performance / performance**
workflow. It rebuilds the current production export before measuring it, so
cached output cannot conceal source changes. Each browser run serves an immutable copy of that export; concurrent editor rebuilds cannot invalidate its assets. A failed timing, crash, loading,
request, CPU or bundle constraint fails the job. No retries, skipped cases,
exclusive tests or unavailable evidence count as acceptance. This check is
configured on main alongside backend/frontend/frontend-security, with strict
up-to-date checks, review and enforcement for administrators (verified 13 October
2026). Preserve it; workflow files alone do not create branch protection.

Run the identical audit locally before publishing:

```sh
npm run test:performance:audit
```

Backend/frontend dependencies and Chromium/WebKit must already be installed. The audit selects `backend/.venv/bin/python` when available, otherwise `python3` (override with `FORGE_AUDIT_PYTHON`). The focused backend suite always receives hermetic MongoDB/storage/auth settings, including the production-sized catalog snapshot threshold fixture. Install the browser
engines once with `npx playwright install chromium webkit`. To require the audit
before every push from this checkout, run
`node scripts/install-performance-hook.mjs`. The installer refuses to replace an
existing hook, including one managed through `core.hooksPath`; incorporate the
command into that hook manually if needed. This hook is local to the checkout.
CI remains the shared release gate.

## Every-page crash and update gate

The same audit now runs `test:e2e:stability` before performance measurements.
This independently exercises **every discovered app page** with unavailable API
data on Android Chrome, iPhone Safari, iPad Safari and desktop Chrome. New route
files inherit these checks automatically. Each run freezes the freshly built
export in its own directory; an editor rebuilding `dist` cannot change the
assets being tested. `verify-release-stability.mjs` recomputes route discovery
and rejects missing routes, projects, suites, failed/expected-failure cases,
skips, retries, flakes, runner errors and pass counts without executed evidence.
The manual predeployment workflow enforces the same browser suite.

The unavailable-data matrix is supplemented by populated-response journeys:
new quotation, 1,015 warehouse lots including null prices and unknown quantity,
full-payload stock search with bounded card mounting, repeated SPA navigation,
hard reload and retained authentication. Deliberately injected React render
failures must stay inside the page boundary, retain the navigation shell and
session, and recover through both retry and navigation. Update asset recovery
also runs on all four devices. The shared runtime health guard catches browser
errors/crashes **and React-caught render errors** reported on the console, and
rejects a remaining error boundary. Its own browser regression proves that a
page with visible text can still fail runtime acceptance.

Earlier route smoke fixtures primarily exercised failed requests and watched
`pageerror`; they could miss populated-data rendering faults caught by React.
Bundle size and compilation alone also cannot certify navigation, a mounted
auth-provider lifetime or preserved browser credentials. Keep successful-content,
failure/retry, repeated-navigation and update-session scenarios for changed
screens. Match API nullability and response envelopes, and include realistic
list sizes. A generic page title, navigation shell or error fallback is never
successful-content evidence. Intentional injected failures must name the exact
expected error and prove recovery; never suppress a class of runtime errors.

Required release evidence now also includes `stability-results.json` and
`stability-summary.json` alongside failure screenshots and traces. For a focused
development rerun, use the stability config directly; release acceptance requires
the full unfiltered command and its coverage verifier. The existing required
Performance check and local pre-push hook execute it automatically. A passing
small subset or an older report cannot satisfy the verifier.

## Enforced budgets

| Measure | Constraint |
| --- | --- |
| Initial JavaScript | Every exported HTML route, including newly added pages: at most 576 KiB gzip |
| Cold catalog, customer/quotation primary content, builder and Ground Floor | Under 2.5 seconds with a 200 ms API fixture on each device |
| Search | Under 1.5 seconds including debounce and fixture response; Chromium interactions use 4× CPU slowdown |
| Builder line addition | Under 750 ms to updated quantity, with no backend mutation |
| Team assign (50 leads) | Primary content under 2.5 seconds; activity expansion under 750 ms; floor selection through completed response under 1.5 seconds with a 200 ms API fixture |
| Repeated cached catalog visits | First visit under 2.5 seconds; later visits under 750 ms |
| Reference reads | One session/floor identity, brand/category/hierarchy/facets read during repeated visits |
| Catalog page | One bounded initial request, limit 60; realistic page contains 60 families × 10 finishes, total 6,500 |
| Ground Floor document reads | Two floor-scoped requests start within 100 ms of each other |
| Blocking CPU | No task at least 500 ms; aggregate blocking time below 1.5 seconds in stress scenario when Long Task API is supported |
| Runtime health | Zero crashes, uncaught errors or unexpected console/network failures in realistic scenarios |

The browser suite runs Android Chrome, iPhone Safari, iPad Safari and desktop
Chrome emulation, one worker and zero retries. It also checks held metadata and
secondary-history responses, obsolete search results, repeated navigation and
rotation on a slower CPU. Functional browser audits cover surrounding routes;
all exported pages inherit the bundle guard. The stress data is synthetic and
contains no production records or external images. These measurements isolate
application rendering/request behavior; image quality, physical devices and
production transit require separate deployment sampling.

The budget is a regression ceiling, not permission to consume the entire
ceiling. Keep first useful content independent of optional metadata/history.
Bound list renders and backend pages; advance cursors by records consumed rather
than unique records displayed. Coalesce duplicate reads and expire bounded
caches. Include floor, identity and filters in cache keys and invalidate affected
reads after writes. Avoid full-catalog loading, serial startup waterfalls,
unbounded retries, and per-card scans of full quotations.

## Changing a page or adding a feature

Extend a relevant scenario before changing these limits. Use production-scale
fixtures and test the actual user interaction, with CPU/latency pressure where
appropriate. New screens inherit the JavaScript check automatically. Add their
primary-content and interaction case when they introduce heavy rendering or
network dependencies. For backend changes, retain hermetic page-performance,
cache-invalidation, hydration and authorization tests in the backend CI suite.
Do not loosen budgets, add retries or suppress crashes to obtain a passing run.
Investigate a failing sample using its trace, request timestamps, long tasks and
bundle assets; compare under the same runner/load conditions.

## Deployment verification

Keep `output/playwright/bundle-budget.json`, `performance-results.json` and
`performance-summary.json` with the release evidence. The dedicated workflow
retains results and failure traces, even when another CI job fails. After deploy,
sample the public health endpoint through Vercel and directly through Railway
from the intended customer region, record cold/warm p50/p95 and compare
`Server-Timing` to total duration. Verify an authorized catalog and builder
session on the actual deployed revision, with both Sanitary and Ground Floor
contexts. A fixture pass cannot certify MongoDB, Vercel, Railway or customer
network latency; see `performance-observability.md` for server timing semantics.

Inspect provider metadata before promotion: Vercel function region `bom1` and
one always-running Railway replica in `asia-southeast1-eqsg3a`. The production
Railway service did not read the nested `backend/railway.json`; setting a new
Config-as-Code file was rejected by the provider's deprecation policy. The
Singapore/no-sleep settings are persisted directly in the existing service.
Do not treat a configuration-file edit as proof that the provider applied it.
Future Infrastructure-as-Code migration must preview a plan that preserves the
existing service, database/storage, variables and source; do not blindly apply
an imported historical source-commit pin. Current runtime updates use the
existing explicit project/service/environment and verify the resulting region.

## Vercel candidate promotion

Build a production candidate using `vercel deploy --prod --skip-domain`, with the
complete reviewed source SHA in `releaseSha` deployment metadata. Check the actual
candidate's authenticated page/session journeys before moving production aliases.
Then run `node scripts/promote-verified-vercel.mjs <candidate-https-url> <full-sha>
<report.json>` with the authenticated Vercel CLI on PATH (or FORGE_VERCEL_CLI).
The guard checks project/source/readiness and runs the real public API, missing
asset, security-header and cache verifier before promotion. Follow with the same
checks on the public domains. A provider READY state or successful web build
cannot certify that a serverless API function starts.

The Vercel API is transpiled to CommonJS. Keep shared runtime helpers compatible
with that loader; direct Node ESM imports can conceal ERR_REQUIRE_ESM. Required
API tests execute the actual CommonJS artifact with ESM require disabled and boot
the emitted standalone worker. Cookie generation has one canonical helper, inlined
where a single-file worker upload cannot resolve local imports.
