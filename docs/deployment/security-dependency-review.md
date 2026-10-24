# Dependency security review

Latest full audit: **16 October 2026 — 27 package findings (22 high, five
moderate), three distinct advisories; security gate remains failing.** See the
dated review below. Earlier counts and SDK experiments are historical.

Initial review 2026-10-05 against the committed npm manifests, a clean installation, the current npm registry, and the GitHub advisory database.

## Remediation and verification

- Updated ESLint from 9.25.0 to 9.39.5 within the Expo ESLint configuration's supported major, removing the `@eslint/plugin-kit` low-severity advisory and its ESLint parent finding.
- Applied the existing UUID security pin to npm using a scoped `xcode` override (`uuid@11.1.1`). The previous `resolutions` entry only affected Yarn and left npm on UUID 7.0.3. Xcode's actual use is `uuid.v4()`, which remains supported; 1,000 generated native project IDs passed uniqueness and format checks.
- Removed unused `@expo-google-fonts/fraunces` after the interface adopted Inter throughout.
- `npm audit --json` findings decreased from 38 (23 high, 13 moderate, two low) to 27 (23 high, four moderate, zero low/critical). This count includes transitive parent findings; it is not a count of distinct vulnerabilities.
- A clean `npm ci` in an isolated copy of the manifests and install scripts passed, including the preinstall guard and React 19 compatibility postinstall.
- `npm ls --depth=0`, `npx expo install --check`, TypeScript, Expo lint with zero warnings, Expo Doctor (18/18), and all 16 existing non-browser frontend contracts passed.
- The audit gate now rejects malformed/error reports and inconsistent advisory counts. High and critical findings block without package-name allowlists. Regression tests cover registry errors, invalid JSON, abnormal npm exit status, and high-severity Expo build dependencies.

The frontend functional CI job now runs independently of the blocking `frontend-security` job. Security failure no longer prevents type, compatibility, contract, production-build, budget and browser checks from producing evidence. **Overall CI remains failing while the security job fails.** There is no `continue-on-error` on the security job and no suppressed high/critical advisory.

## Current residual frontend findings

The remaining high-severity root findings are:

| Package | Installed version | Advisory | Published fix |
| --- | --- | --- | --- |
| braces | 3.0.3 | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | None; current npm latest remains 3.0.3 |
| node-forge | 1.4.0 | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | None; current npm latest remains 1.4.0 |
| image-size | 1.2.1 | [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | 2.0.3+; requires Metro API migration |

Metro in the supported Expo 54 graph calls the default `image-size` export as a function. Version 2 changes that export to an object with `imageSize`, so forcing a transitive version override would break asset builds. The four remaining moderate findings are rooted in `decode-uri-component@0.2.2` through `query-string` and Expo Router/React Navigation. The fixed decoder 0.5.0 is ESM-only; `query-string@7.1.3` requires a callable CommonJS decoder. Query-string 8/9 also moves its functions to a default object while this Router/Navigation generation uses namespace functions. Direct overrides were rejected after inspecting these actual call sites.

This is not a clean dependency audit and does not certify builds processing untrusted files or input. No local cryptographic patch or unmerged upstream fork was represented as a published fix.

## Verified SDK upgrade experiment

The prior August review suggested a breaking Expo 57 upgrade as the only npm remediation. That is insufficient for the advisories published since then. An isolated manifest-only experiment used `expo@57.0.26`, its official `bundledNativeModules.json` compatibility versions, and the app's other dependencies and current security overrides. It resolved successfully but still reported 23 findings (20 high, three moderate), including high findings rooted in the same unpatched `braces` and `node-forge` packages. No native SDK upgrade was applied to the production app based on that experiment, and no native compatibility certification is claimed.

[Expo's supported SDK table](https://docs.expo.dev/versions/latest/) ties SDK 57 to React Native 0.86 and React 19.2.3; npm audit's suggested React Native 0.87 upgrade is outside that family. [Expo's upgrade procedure](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/) also requires matching dependencies and rebuilding development/native builds. A supported SDK migration can remove legacy image tooling, but cannot make this security gate pass while the other root advisories remain unpatched.

Re-run the registry/advisory check when upstream releases change, then update only supported versions, repeat clean install/type/lint/contract/build/browser/native checks, and require the independent security job to pass before declaring CI fully unblocked.

## Backend scope and historical preview freeze

This frontend review does not replace the current backend production dependency audit. Production uses `backend/requirements-prod.txt`; `backend/requirements.txt` is an Emergent preview-environment freeze. The historical preview freeze was not a CI production installation target because its preview-only Google/protobuf requirements conflicted on Python 3.14. Use the current backend release evidence for backend dependency and operational status.

## Fresh registry review — 6 October 2026

Newly indexed advisories increased the unchanged graph to 34 findings (25
high, nine moderate). Compatible lockfile updates installed compression
1.8.2 and source-map-js 1.2.2 from their existing dependency ranges, removing
two high root findings. A clean npm ci and the production web export passed;
TypeScript, lint, Expo compatibility and route budgets also passed. Current
npm audit reports **32 findings: 23 high, nine moderate, zero critical/low**.
The earlier 27 count and SDK57 experiment above are dated evidence.

The additional moderate root is sprintf-js through1.1.3, pulled through the
React Native/Babel test-tooling graph. [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
was reviewed/updated5October and lists no patched version. It concerns
unbounded precision format strings causing uncaught RangeError. The high
braces/node-forge and incompatible image-size migration blockers remain.
No finding is suppressed, and the independent security gate still fails.

## Backend advisory refresh — 6 October

The fresh CI/production requirements audit found four PyMongo4.17.0
advisories after the earlier clean scan. Both production and preview pins
now use4.18.2, within Motor3.7.1’s declared pymongo>=4.9,<5 range. The
[MongoDB4.18.2 release](https://github.com/mongodb/mongo-python-driver/releases/tag/4.18.2)
patches the GridFS exact-ID issue, KMS socket endpoint issue, BSON encoding
overflow and URI host decoding issue. The full1,552-case suite passed in an
isolated patched runtime; BSON roundtrip/Motor construction and live
read-only Mongo/index/Supabase readiness checks passed. Migration dry-run
reported none pending. Fresh pip-audit on production requirements reports
no known vulnerabilities. Earlier CI failure is retained as dated evidence;
no advisory was ignored.

## Supported application and registry review — 7 October 2026

The deployed application now uses Expo 55.0.31 with React Native 0.83.10.
The compatible shell-quote 1.12.0 update removed the critical
[GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)
finding, and the supported SDK55 migration removed the legacy image-size
findings. The fresh application audit reports **30 findings: 22 high,
eight moderate, zero critical/low**. This supersedes the earlier graph counts
above; the security job still fails.

Fresh official registry and GitHub advisory checks find no patched release
of braces (latest 3.0.3), node-forge (1.4.0), or sprintf-js (1.1.3).
The published decode-uri-component 0.5.0 fix falls outside the installed
query-string 7.1.3 dependency range. No query-string 7 patch accepts it.
Router 58.0.16, suggested by npm audit, belongs to the `next` release channel,
with Expo 58 peers. React Native 0.87.1 also falls outside Expo SDK57's
supported React Native 0.86 family. Neither suggestion is a supported patch
to the deployed SDK55 application.

An isolated SDK57 application candidate improves the audit to 22 findings
(19 high, three moderate). Its fresh full lint scan initially found 151 errors.
A 7 October cleanup reduced the full scan to 120 errors with zero warnings;
then targeted fixes removed the remaining two memoization findings. Merging
those targeted results with the full scan leaves 118 state-effect errors.
Candidate typecheck and actual-source lifecycle/history/API fixtures pass.
The earlier 136 focused browser checks preceded this latest cleanup and do
not certify the final candidate, a signed native build or physical devices.
SDK57 remains held. No advisory gate was weakened and no
transitive package was replaced with a renamed or locally patched substitute.

## Required CI and dependency refresh — 7 October 2026

A fresh npm audit still reports **30 findings: 22 high, eight moderate,
zero critical/low**. Official registry and advisory checks still find no
published patch for braces 3.0.3, node-forge 1.4.0 or sprintf-js 1.1.3.
The decoder and framework compatibility limits above remain. No dependency
override, advisory exclusion or local substitute was added. A fresh production
requirements pip-audit resolved 44 packages with zero known vulnerabilities.

[Main CI run 37635145278](https://github.com/yashvardhansinh2510-max/forge2.0/actions/runs/37635145278)
tested exact commit `cada5df882a59f8eac257e2fb5ff3eb405cff206`: backend and
frontend functional jobs passed, while `frontend-security` failed on the
22 high findings. This is evidence for that commit, not for the pending
release changes. Required frontend CI now also invokes
`test:native-release-config` and `test:history-lifecycle`; these use hermetic
transport and lifecycle fixtures and do not certify physical devices.

The run's browser evidence upload also failed because the GitHub Actions
artifact storage quota was exhausted; the previous workflow suppressed that
failure. The pending CI change removes that suppression, requires artifact
files, and publishes browser result counts in the job summary before upload.
Required artifact uploads must pass alongside tests and the security job
before declaring CI green. Storage quota remains an operator blocker; no
stored artifacts were deleted and no account settings were changed.

The release-readiness ledger references the managed
`2026-10-07-security-ci-refresh.json` report and its exact retained npm,
pip-audit, registry and GitHub CI outputs. Codex Security's artifact-storage
policy places that evidence in its managed local collection; this source
review does not claim a repository audit report was written.

## Supported-remediation delta check — 8 October 2026

Fresh official registry and advisory metadata still list braces 3.0.3,
node-forge 1.4.0 and sprintf-js 1.1.3 as latest, with no patched version.
Expo SDK55 remains at 55.0.31 with React Native 0.83.10. The newest SDK57
release is 57.0.27 with React Native 0.86.3; its compatible CLI 57.0.28
still requires node-forge, and Metro's file-map/micromatch graph still
requires braces 3.0.3. Both supported Router families retain query-string 7.
SDK57 promotion therefore cannot clear the current high-severity gate.

This was a metadata-only delta check; the last full application audit count
remains the dated 30 findings above. No full audit, application tests or
manifest/lockfile changes were repeated. The managed
`2026-10-08-supported-remediation-check.json` report retains the official
package, advisory and SDK compatibility evidence for the release ledger.
No supported dependency change that clears these blockers is available.

## Full dependency remediation review — 16 October 2026

Reviewed checkout `4710f545ccf677513721ca2b5241e93d729622d7` on
`codex/stability-review-2026-10-12`. The initial tree had only an unrelated,
untracked `backend/node_modules` symlink; it was preserved. The active root
application remains Expo **55.0.31**, React Native **0.83.10**, React **19.2.0**.
The historical `frontend/` manifests are a separate inactive checkout.

Fresh full `npm audit --json` before and after clean `npm ci` reported exactly
**27 findings: 22 high, five moderate, zero critical/low**. All 27 package/path
records are unchanged; none were resolved, reduced, or introduced. These are
package and parent dependency findings, not 27 distinct advisories. This matches
the October 12–15 baseline and supersedes the October 7 full audit's eight
moderates; the existing URI decoder remediation predates this review.

### Minimal local change

Corrected the root `packageManager` declaration from Yarn to `npm@11.17.0`,
matching the active npm lockfile, README and every frontend installation in CI.
That npm release supports Node 22.9+; CI selects Node 22. Local validation used
Node 26.5.1/npm 11.17.0. Existing resolutions, scoped overrides, postinstall
repairs and all gates were retained. No dependency versions changed, and the
root lockfile remained byte-identical through `npm ci`. This declaration repair
is **not a vulnerability fix**.

### Residual advisories and recommended action

Primary GitHub advisory records, npm metadata, maintainer discussions/releases
and official framework guidance were checked on **16 October 2026 IST**.

| Advisory | Severity / installed version | Complete representative dependency path | Current patched status and action |
| --- | --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | High; braces 3.0.3 | expo → @expo/metro → metro-file-map → micromatch → braces; also React Native's Metro/Jest branches | Affects <=3.0.3; npm latest 3.0.3, no published patch. [Maintainer issue 84](https://github.com/micromatch/braces/issues/84) disputes the finding. Keep visible; await an upstream release or advisory correction and re-audit. |
| [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | High; node-forge 1.4.0 | expo → @expo/cli → node-forge; expo → @expo/cli → @expo/code-signing-certificates → node-forge | Affects <=1.4.0; npm latest 1.4.0, no published patch. [Upstream PR 1152](https://github.com/digitalbazaar/forge/pull/1152) remains unmerged. Await a maintained release; do not represent proposed 1.4.1 as published. |
| [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) | Moderate; sprintf-js 1.0.3 | react-native → babel-jest → babel-plugin-istanbul → @istanbuljs/load-nyc-config → js-yaml → argparse → sprintf-js; another branch passes through @jest/transform | GitHub/npm still list <=1.1.3 with no patch; latest 1.1.3 remains in range and exceeds argparse's ~1.0.2. The [official CVE record](https://cveawg.mitre.org/api/cve/CVE-2026-97058) was rejected October 12, but GitHub has not withdrawn its advisory. Await propagation or a supported upstream fix; preserve the finding. |

All three are transitive tooling dependencies beneath runtime-declared framework
packages. No direct app/API import was found. This is exposure context, not a
finding waiver or exhaustive proof of absence from every native bundle.

The sampled Metro watcher uses `micromatch.some`, which delegates to picomatch;
the affected braces parser is invoked by other micromatch APIs such as `parse`
and `braceExpand`. Other Jest/tooling paths remain. Avoid feeding untrusted glob
patterns or repositories into privileged builds. Expo CLI concretely reaches
forge certificate parsing and signing helpers; exploitation of the reported
signature issue additionally requires attacker-controlled verification inputs
and applicable RSA keys. Ordinary business API inputs were not found reaching
that path. Restrict signing inputs and build-worker privileges; these measures
do not patch forge. The sprintf path is in js-yaml's CLI help/argument formatter;
ordinary Istanbul YAML library loading does not import argparse. Keep format
strings controlled and handle invalid input where that CLI is used.

The older [node-forge GHSA-2328-f5f3-gj25](https://github.com/advisories/GHSA-2328-f5f3-gj25)
affects <=1.3.3 and **is patched by installed 1.4.0**. It is distinct from the
remaining September signature advisory. All 16 current node-forge advisory
ranges were checked individually; the older patched records do not clear the
newer finding.

### Compatibility decision

Registry metadata still places SDK 55 at Expo 55.0.31/CLI 55.0.36/Router
55.0.18; the installed official `bundledNativeModules.json` pins RN 0.83.10.
[Expo's SDK 55 guidance](https://docs.expo.dev/versions/v55.0.0/) requires its
matching React Native family. Latest stable Expo 57.0.30 bundles RN 0.86.3 and
React 19.2.3, but CLI 57.0.31 still requires forge and its Metro graph still
requires micromatch/braces. React Native 0.88.0 and Expo/Router 58's `next`
channel are not supported patch updates for this app. A framework migration
requires the [official upgrade process](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)
and new native builds; it cannot currently clear these high-severity roots.

Latest `@istanbuljs/load-nyc-config` 1.1.0 still requires js-yaml 3, and the
current supported js-yaml 3/argparse 1 ranges retain sprintf. No compatible
patch/minor parent update or unnecessary direct dependency removal resolves
these roots. No new overrides, forks, local security patches, suppressions,
exceptions or gate changes were added. The safest current action is to keep
the findings visible and revisit upstream status, with any parent replacement
or framework migration treated as separately validated work.

### Verification

Clean npm install, full before/after audits and `npm ls --all --json` completed.
TypeScript, zero-warning lint, `expo install --check`, Expo Doctor **20/20**,
all **45** frontend/API/security/audit-runner contract commands, current-source
production web build and bundle budgets for **159** exported routes passed.
The largest initial route was **450 KiB gzip** against the unchanged **576 KiB**
budget. The existing security gate still exits **1** on the 22 high findings.

The complete `npm run test:performance:audit` exited **0**: **26** focused
hermetic backend tests, **564** stability cases covering all **77** discovered
routes on four devices, and **52** performance browser cases passed. Browser
acceptance had zero skips, retries, flakes or failures. Detailed command/path
inventory and measured evidence are retained in the local report. Native exports/signing,
physical devices, remote CI and production acceptance are not certified by this
review. No native/framework versions changed. Validation disabled dotenv loading
and used an inert HTTPS backend build URL plus hermetic browser/API fixtures;
no production service, data or credentials were used. No commit, push,
deployment or publication was performed.

Machine-readable before/after reports, dependency inventories, source evidence,
primary-source snapshots and command logs are stored outside committed source
under the dated Codex Security artifact collection and the local
`/tmp/forge-dependency-remediation-2026-10-16` workspace. **The dependency audit
is not clean and release remains blocked by the unchanged security gate.**
