# Repeatable stability verification

The canonical frontend is the repository root (`app/`, `src/`, root npm manifests). `frontend/` is a legacy checkout. Backend source is `backend/`. Use current `origin` and deployment configuration rather than historical repository names in old audit notes.

## Before feature work

Record the starting commit and working tree. Preserve unrelated changes. Reproduce the reported bug with a failing behavioral test before fixing it. Shared contracts need boundary cases: family identity is floor + brand + category + supplier family, supplier listing occurrences remain separate, and previews use exact-product media selection. Authentication, selected floor and async response generation are independent state boundaries; delayed results must not publish into a newer route, account or floor.

## Local acceptance

Use Node 22+ and `npm ci`. Run `npx tsc --noEmit`, `npm run lint -- --max-warnings 0`, the required contract scripts listed in `.github/workflows/ci.yml`, and `node scripts/check-npm-audit.mjs`. A contract passing does not waive an actual dependency audit failure.

Run backend tests with the complete hermetic environment from CI, including `MONGO_URL=mongodb://localhost:27017`, a disposable test `DB_NAME`, and synthetic JWT/Supabase configuration. Never use production settings for unit tests. Run `backend/.venv/bin/python -m pytest backend/tests/unit -q` and the production requirements audit. Database integration tests require an isolated disposable database.

Build the actual release export with `EXPO_NO_DOTENV=1 BACKEND_URL=https://forge20-production-a8b0.up.railway.app npm run build`, then `npm run test:mobile-budget`. Run these browser suites sequentially against this export; all APIs use deterministic intercepted fixtures and the audit server rejects unmatched API calls:

```sh
npm run test:e2e:audit
npx playwright test --config playwright.responsive.config.ts responsive-
npx playwright test --config playwright.devices.config.ts
npm run test:e2e:performance
```

The responsive matrix includes 320, 360, 390, 768, 1024, 1280 and 1440px. Device profiles cover Chromium touch phones, WebKit iPhone/iPad and Firefox desktop. New navigation tests preserve the actual saved session through back/forward and hard reloads. Existing layout checks assert viewport bounds and named keyboard/touch controls; route audit screenshots preserve evidence. Fixture browser checks do not certify production APIs, physical devices or signed native builds.

Keep pass/fail/skip counts, browser report JSON and failing screenshots/traces. Diagnose failures from their traces; an isolated repeat is additional evidence, not a replacement for a failed full run. Do not add retries, arbitrary delays, wider deadlines or weaker assertions to manufacture a pass. Every independent CI browser suite runs once its build/browser prerequisites succeed, even if a preceding suite fails. All failures remain blocking.

## Promotion and rollback

Main requires a PR and strict `backend`, `frontend` and `frontend-security` checks, enforced for administrators. Do not bypass them. Check that all required CI jobs pass on the exact source commit before promotion. Dependabot monitors the root npm graph and backend pip graph.

Verify the existing Railway project/service before changing it. As inspected on 12 October 2026: project `BuildCon House Backend` (`4d4a8d55-2e5e-43dc-b3a2-298e4455f210`), service `forge2.0` (`9683fa61-7c70-4fce-ba6d-210b0cff5267`), production environment `3ee5a85e-c436-4010-8103-8e8a49186dd1`, source `luvop2510/buildconhouse`, root `/backend`, readiness `/api/health/ready`. The web frontend is hosted separately; Railway backend success alone does not publish changed web assets.

Run `backend/scripts/predeploy_backend_gate.py` and `backend/scripts/run_migrations.py --dry-run` using authorized production configuration. These are read-only checks. Record the currently successful Railway deployment before promotion; verify the new deployment's commit metadata, successful readiness, and deployed browser/API smoke results. A configuration commit pin can differ from actual deployment metadata; inspect both.

For this review the previous successful deployment is `92692934-99ef-424d-86a0-aa02ed08fabd`, commit `8cb0eb7c8e1b89a416796ab6b5dffdd4b599412b`, reported rollback-capable by Railway. Preserve that reference until a replacement is verified. Roll back the known successful build for code-only failures; data restoration is a separate, explicitly reviewed operation.
