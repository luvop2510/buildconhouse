# Integration testing strategy

`tests/unit/` and `tests/integration/` are split deliberately (BACKEND_AUDIT_2026-07-17.md
Critical #5). This doc explains the split, why the integration suite isn't
in CI yet, and what enabling it later would take.

## The split

- **`tests/unit/`** — self-contained. No live server, no live Mongo/Supabase,
  no real credentials. Each test either calls pure functions/dependency
  functions directly, or monkeypatches `db`/collections with fakes. Runs in
  CI on every push/PR (`.github/workflows/ci.yml`).
- **`tests/integration/`** — 7 files (`test_forge_backend.py` and 6
  catalog/followup/quotation regression tests) that make real HTTP requests
  against a **live deployed backend** (`BASE_URL`, defaulting to an Emergent
  preview URL) using the **real demo staff password**. These can't even be
  *collected* without that environment reachable, let alone pass.

## Why they aren't in CI yet

1. They depend on a specific already-running deployment, not something CI
   spins up itself.
2. They log in with the historical demo password — the exact credential
   BACKEND_AUDIT_2026-07-17.md Critical #1 flags for rotation. Wiring them
   into CI as-is would mean CI has a hard dependency on that credential
   staying valid, which directly fights the goal of rotating it out.
3. Pointing CI at the shared Atlas cluster (the only backend these tests
   currently know how to reach) risks mutating real data from every PR run.

## What's needed to enable them later

- A disposable backend to run them against: either a docker-composed stack
  (Mongo + a mocked/local Supabase-compatible storage backend, e.g. minio
  with a Supabase-shaped API shim) started fresh per CI run, or a real
  ephemeral staging deployment torn down after the run — **never the shared
  production Atlas cluster**.
- Seeded, disposable test fixtures (created by the CI job itself, scoped to
  that run) instead of `[legacy password removed; use injected test credentials]` / any credential that also exists in a
  real environment.
- The 7 files parameterized on `BASE_URL` already (`EXPO_PUBLIC_BACKEND_URL`
  env var) — pointing them at a CI-local stack instead of the Emergent
  preview URL is mostly a matter of setting that env var to the
  docker-composed backend's address, once one exists.

## CI shape once that exists

A second job in `.github/workflows/ci.yml`:

```yaml
integration-tests:
  runs-on: ubuntu-latest
  # Manually triggered or scheduled — NOT on every push/PR, and never
  # blocking a merge on its own. Only promote it to blocking once it's
  # proven stable against the disposable stack for a while.
  if: github.event_name == 'workflow_dispatch'
  services:
    mongo: { image: mongo:7, ports: ["27017:27017"] }
    # + whatever local Supabase-compatible storage stand-in is chosen
  steps:
    - uses: actions/checkout@v4
    - name: Seed disposable test fixtures
      run: python -m scripts.seed_ci_fixtures  # doesn't exist yet
    - name: Run integration suite
      run: pytest tests/integration -v
```

Until that stack exists, the integration suite stays exactly as useful as it
is today: a manually-run regression check against a real environment, run by
a human who has that environment's credentials — not a CI gate.
