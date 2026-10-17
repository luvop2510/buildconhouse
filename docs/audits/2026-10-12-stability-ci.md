# Stability CI diagnosis — 12 October 2026

## Exact baseline

The active repository is `luvop2510/buildconhouse`. The current main commit
reviewed here is `828f86b3d7f7f8ddd5a117a4c4f7a5a0476b57c3`.
[Its CI run 38255056242](https://github.com/luvop2510/buildconhouse/actions/runs/38255056242)
completed with backend passing and frontend/security failing. Actual job logs
were read, rather than inferring the cause from old billing/storage incidents.

- `frontend-security`: `Dependency vulnerability scan (npm audit)` failed with
  22 high and five moderate findings. No critical, low or informational findings.
- `frontend`: release browser audit had 1,601 passes, 32 skips and two failures.
  Both were WebKit cases in `e2e/redesign-auth-transitions.spec.ts:55`: owner and
  worker login with an obsolete force-change flag stayed at `/login` instead of
  reaching `/dashboard` or `/access` within the unchanged five-second assertion.
  Subsequent responsive/device/performance suites were skipped by Actions after
  that failure. Required evidence upload succeeded on this run.
- The earlier [PR run 38254173572](https://github.com/luvop2510/buildconhouse/actions/runs/38254173572)
  had 328 responsive passes, 14 skips and 12 failures: persisted quotation
  quantity missing after reload (`responsive-concealed-parts.spec.ts:100`) and
  no PATCH after adding to an existing quotation (`:182`), across six viewports.
  That run predates the current main fixture corrections; it is historical
  evidence and does not establish twelve current application failures.

Local raw evidence for this investigation is `/tmp/forge-stability-current-ci.log`,
`/tmp/forge-ci-failed.log`, `/tmp/forge-stability-ci-jobs.json`,
`/tmp/forge-ci-audit.json` and `/tmp/forge-stability-audit-gate.log`.
These temporary files are not durable release artifacts; the linked GitHub run
and this concise record preserve the findings.

## Security root causes and remediation limit

A fresh local `npm audit --json` reproduces 27 findings. The 22 high findings
include dependent packages; there are two distinct high advisory roots:

| Root | Installed/latest published | Verified dependency path | Official advisory |
| --- | --- | --- | --- |
| braces | 3.0.3 / 3.0.3 | Expo 55.0.31 → @expo/metro 55.1.2 → metro-file-map 0.83.8 → micromatch 4.0.8 → braces | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) |
| node-forge | 1.4.0 / 1.4.0 | Expo 55.0.31 → @expo/cli 55.0.36 → node-forge; also via @expo/code-signing-certificates 0.0.6 | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) |
| sprintf-js (moderate) | 1.0.3 / 1.1.3 | React Native 0.83.10 → babel-jest 29.7.0 → babel-plugin-istanbul 6.1.1 → @istanbuljs/load-nyc-config 1.1.0 → js-yaml 3.15.2 → argparse 1.0.10 | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) |

Official npm registry queries (`npm view <package> version dist-tags --json`)
and the GitHub advisory pages were checked on 12 October. All three advisories
list no patched release; the installed high roots already equal npm latest.
Updating sprintf-js to latest would still be affected.

The [node-forge proposed patch #1152](https://github.com/digitalbazaar/forge/pull/1152)
is OPEN, unmerged, at `ceba34402e329f0365134f23fe19898756527d65`.
The [braces depth-validation proposal #88](https://github.com/micromatch/braces/pull/88)
is also open/unmerged; the maintainer's [issue #85](https://github.com/micromatch/braces/issues/85)
links to disagreement about the advisory, which does not withdraw the registry
finding or satisfy the existing gate. These are not supported published fixes.

The audit's suggested Expo 44 downgrade or React Native 0.87 major change is
not a compatible patch for this SDK55 application. Earlier supported SDK57
experiments also retained the high roots; see
[dependency review](../deployment/security-dependency-review.md). No fresh SDK
migration was claimed in this investigation. Adopting and maintaining unreviewed
cryptography/glob forks would require additional provenance, compatibility and
security review; replacing names or inventing unaffected versions solely to
make npm stop reporting them is not remediation.

The audit check therefore remains blocking with its original severity policy.
No suppression, production-only audit, renamed dependency, local package
substitute, force upgrade, or `continue-on-error` was introduced. A release
requiring green CI remains blocked until these dependencies can be genuinely
remediated. Do not treat local functional passes as security approval.

## Safeguards changed

- Dependabot now monitors npm manifests at `/`, where CI and Expo build the
  canonical app. It previously targeted legacy `/frontend`, producing update
  PRs that did not repair the dependency graph actually being installed.
- `test:catalog-pagination` runs as a required frontend contract in CI.
- After successful build/check prerequisites and browser installation, all four
  independent browser suites execute even if an earlier browser suite fails.
  Their failures still fail the job. Cancelled runs stop; failed prerequisites
  do not trigger browser suites. Test assertions, deadlines, workers and retry
  policies are unchanged. This prevents one failing suite from hiding later
  failures until a subsequent push.

## Local validation

`npm run test:npm-audit` passed its high/critical, malformed report, registry
error and abnormal process-exit checks. The actual audit gate still fails as
documented above. `npm run test:catalog-pagination` passes. Both changed YAML
files parse with `js-yaml`, and `git diff --check` passes. No installation,
lockfile change or shared `node_modules` mutation was required. The final
branch/commit CI result must be recorded separately after pushing.
