# Forge Recovery Procedure

## Why local `.env` files disappear

Emergent preview runs in an ephemeral Kubernetes container. Workspace files excluded from the persisted project snapshot by `.gitignore`—including populated `.env` files—are not restored when that container is recreated. This is persistence-by-design in preview, not Forge deleting the files. Supervisor injects only platform runtime values and cannot recover MongoDB/Supabase secrets that were stored solely in the old container.

Deployed applications support persistent environment variables through deployment settings. Agents cannot configure platform-level persistent secrets for preview. Therefore application code can eliminate silent/crash-loop failure and prefer persistent process secrets, but it cannot make a preview-only secret persist across container recreation.

## Production recovery

1. Open the deployment environment settings.
2. Configure every variable listed in `STARTUP_CHECK.md` from the approved password manager.
3. Restart/redeploy using the Emergent Publish workflow.
4. Run `python backend/bootstrap.py` in the runtime environment.
5. Confirm the post-start check:

```bash
cd /app/backend
python bootstrap.py --health-url http://127.0.0.1:8001/api/health
```

6. Confirm `GET /api/health/system` reports MongoDB and Supabase connected and the expected catalog count.
7. If data counts are wrong, stop. Do not seed over production. Use the documented Supabase backup restore flow.

## Migration failure recovery

Do not restart a production-connected service just to retry a failed migration. The runner records a migration only after its `up()` function succeeds, and stops before later migrations run. Preserve the original exception and inspect the affected documents/indexes with read-only queries first.

1. Put deployment/restart work on hold and record the failed migration name from the logs.
2. Run `cd backend && .venv/bin/python scripts/run_migrations.py --dry-run` against the same environment to confirm the pending sequence; this command makes no writes.
3. For a unique-index failure, use the migration's reported duplicate document ids to make an approved data correction or merge. Never delete rows automatically to satisfy an index.
4. For an index-options conflict, inspect `db.<collection>.index_information()` and create the compatible replacement before removing any old constraint. Do not drop an index merely to make startup pass.
5. After the data/index condition is resolved and reviewed, run the migration once in a controlled maintenance window, confirm it is recorded in `schema_migrations`, then perform the normal deployment health checks.

Every index migration must include a duplicate-data preflight and use create-before-remove ordering when replacing an existing constraint.

## Preview/local recovery

Preview cannot persist custom secrets. Supply them to the current runtime and generate the ignored fallback file through the existing guarded script:

```bash
cd /app
MONGO_URL='...' DB_NAME='...' JWT_SECRET='...' \
SUPABASE_URL='...' SUPABASE_SERVICE_ROLE_KEY='...' SUPABASE_ANON_KEY='...' \
SUPABASE_PUBLIC_BUCKET='...' SUPABASE_PRIVATE_BUCKET='...' \
scripts/setup-env --from-env
sudo supervisorctl restart backend expo
```

Then run both bootstrap commands above. Never commit the populated `.env` file.

## Frontend recovery

Restore the repository root `.env` with the current preview URL.

```
EXPO_PUBLIC_BACKEND_URL=<this session's public preview URL>
```

Find the current URL via `environment=APP_URL="..."` in
`/etc/supervisor/conf.d/supervisord.conf` (under `[program:backend]`), or ask the
user for the URL shown in their browser. Leaving this blank (relative/same-origin
fetch) is the more portable long-term design and is what `src/api/client.ts`
assumes, but empirically failed in this preview's browser-automation testing
context in the 2026-08 session (requests fell through to the Metro dev server's
HTML instead of being proxied to :8001) — set it explicitly to the live preview
URL until that's re-investigated. Restart with `sudo supervisorctl restart expo`
after changing it. This value WILL go stale on the next container recreation
(new preview URL) — re-check it any time the app is inaccessible after a fork.

## Failure interpretation

- `Missing or placeholder configuration`: deployment secret absent or local fallback incomplete.
- `MongoDB connection failed`: URI, Atlas network access, DNS, or credentials issue.
- `missing required collections`: likely wrong `DB_NAME` or incomplete restore. Do not create production collections blindly.
- `missing required indexes`: review the reported signatures before applying an index migration.
- `Supabase connection failed`: project URL/key invalid or network unavailable.
- `missing required buckets`: create/restore the named buckets before starting Forge.
- Health endpoint failure: inspect backend startup logs; do not route traffic until preflight is green.
