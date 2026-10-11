# CI follow-up — 2026-10-11

The active origin is `https://github.com/yashvardhansinh2510-max/buildconhouse.git`.
The reviewed application changes are in draft PR #15. They have not been
released to production.

The latest CI run, 38134853814, completed with failed checks before any steps
ran. Its frontend annotation states that recent account payments failed or
the spending limit needs to be increased. The repository owner must resolve
the account restriction in GitHub billing settings, then rerun the workflow.
If billing and budgets are healthy, contact GitHub Support with that run URL.

The workflow previously started both push and pull-request runs for every
feature commit. It now runs for PR revisions, pushes to main, and manual
dispatches. Feature branches without a PR can be tested through manual
dispatch. Concurrency cancels superseded runs for the same PR or branch.
Backend, frontend, and frontend-security remain separate required jobs;
no security finding or failed check is suppressed. YAML parsing, trigger
assertions, and `git diff --check` passed locally. Remote execution remains
unverified until the account restriction is resolved.

A fresh npm audit still reports 22 high and eight moderate findings. The
registry still lists braces 3.0.3 and node-forge 1.4.0 as latest, both affected
by the previously recorded advisories. Billing repair alone does not resolve
the dependency security release gate.

An updated frontend preview is running at `http://localhost:8107/login`.
It uses the existing production browser authentication worker to proxy the
live Railway backend; it is not an isolated database or an updated backend.
Login rendered in Chromium without runtime errors, and proxied readiness
returned HTTP 200 with status `ok`. Manual changes after login affect real
business data. The adapter lives in ignored output and is not a deploy artifact.
