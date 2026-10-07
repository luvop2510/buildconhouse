The dispatch-only **Hosted startup readiness** workflow runs the existing command
palette and quotation history fixtures against
`https://buildcon-house-nine.vercel.app` from a GitHub-hosted Ubuntu runner.
It checks out the dispatch's exact `github.sha`; it does not establish that the
public deployment serves that SHA. Verify deployment identity separately before
interpreting the results as acceptance of a particular release.

The dedicated Playwright config imports the audit profiles and selects only
`redesign-command-palette.spec.ts` and `redesign-history.spec.ts`: 72 cases across
eight browser/viewport profiles. Every API request is intercepted by the existing
fixtures before navigation. The workflow uses no production credentials and makes
no tenant writes. Public HTML, scripts, fonts and other static files remain real
hosted requests, providing an independent client observation of startup delivery.

Criteria stay at 30 seconds per test, 5 seconds per assertion, two workers and zero
retries. PASS requires 62 expected passes, exactly 10 existing conditional skips,
72 observed cases, no unexpected failures and no flaky cases; additional skips
cannot produce a passing summary. No server or application build runs. An always-run step prints numeric
counts and writes them to the job summary; missing reports explicitly leave
acceptance unverified. Traces, failure screenshots and JSON evidence have a required
one-day artifact upload. Upload failures, including exhausted storage quota, keep
the job failing and remain distinct from browser acceptance counts.

Configuration listing and workflow parsing are local validation only. Dispatch
results, deployed-SHA identity and runner geography must be recorded separately;
this probe does not certify signed native builds, physical devices or a regional
latency SLO.

Local validation listed 72 cases in the two selected files and parsed the workflow
YAML. The embedded summary accepted the expected 62-pass/10-skip report and failed
for missing or invalid reports, two unexpected failures, all 72 cases skipped,
and one additional skip. These checks executed with synthetic local reports and
made no hosted requests.
