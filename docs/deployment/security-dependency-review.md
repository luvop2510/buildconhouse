# Dependency security review

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
(19 high, three moderate), but still has 151 lint errors under its React
rules. Its 136 focused browser checks pass after application fixes; that
limited result does not justify production promotion or certify a signed
native build. SDK57 remains held. No advisory gate was weakened and no
transitive package was replaced with a renamed or locally patched substitute.
