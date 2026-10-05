# Production image and migration checklist

## Before a production restart

1. Run `./.venv/bin/python scripts/run_migrations.py --dry-run` against the target database. For the SKU index migration, resolve every reported `(floor_id, brand_id, sku)` duplicate before attempting the migration. Never delete or merge catalog records automatically; record the chosen product-data correction.
2. Apply migrations once as a controlled job: `./.venv/bin/python scripts/run_migrations.py`. A failed migration is not recorded, so inspect the original error, correct the data or index conflict, and re-run the command. Do not repeatedly restart application replicas as a migration retry mechanism.
3. Production startup does not auto-apply pending migrations unless `FORGE_RUN_STARTUP_MIGRATIONS=true` is deliberately set for a controlled one-replica rollout. Pending migrations make readiness return 503, while preserving a running process for diagnostics.
4. Build from `backend/` and inspect the final image before promotion: `docker build -t buildcon-backend .` then `docker run --rm --entrypoint sh buildcon-backend -c 'test ! -e /app/.env && test ! -d /app/tests && test ! -d /app/.venv && test ! -d /app/backups'`. `.dockerignore` excludes local backups before a remote builder receives the context.

## Recovery and operational acceptance

Use the verified, BSON-preserving recovery procedure in
[`docs/deployment/recovery-and-regional-acceptance.md`](../docs/deployment/recovery-and-regional-acceptance.md).
Backups require a provider-verified private bucket and byte readback. Restore
only to an empty isolated database; never run an unattended production restore.
Record the actual backup owner, retention, timed restore drill, alert delivery
and verified regional measurements before claiming operational acceptance.

## Credential rotation required after this change

Treat existing images and any previously shared build contexts as potentially exposed. Rotate MongoDB credentials, `JWT_SECRET`, Supabase service-role key, Supabase anon key, storage/CDN signing keys, Sentry DSN, and every deployment-platform secret. Update the deployment secret store, revoke superseded values, then verify `/api/health/ready` after rollout. Do not paste replacement secrets into source control, logs, issue trackers, or shell history.
