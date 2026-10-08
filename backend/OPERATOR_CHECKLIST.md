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


## Authenticator encryption key

Before the first MFA enrollment, provision `MFA_ENCRYPTION_KEY` in the deployment
secret store using a randomly generated Fernet key (URL-safe base64 encoding of
32 random bytes). Keep the same key on every backend replica and retain it in the
private recovery secret store. The startup validator rejects malformed keys
without disclosing their contents. Never put the key in Git, logs, artifacts or
shell history.

Treat this encryption key as stable across JWT signing-secret rotation: enrolled
authenticator secrets and pending setup secrets depend on it. Replacing it needs
a controlled re-encryption migration with both old and new keys available, or
verified account re-enrollment; simply changing the environment key cannot
preserve existing factors. Recovery codes do not decrypt authenticator secrets.

When `MFA_ENCRYPTION_KEY` is absent, compatibility mode derives the encryption key
from `JWT_SECRET`. If any accounts were enrolled in compatibility mode, switching
to a dedicated key also requires migration of existing and pending factors before
rollout. Do not rotate the fallback `JWT_SECRET` until that migration is complete.
A first rollout with no enrolled factors may set the dedicated key directly.

## Security request and import limits

Requests are bounded before JSON parsing or multipart spooling: authentication
bodies64KiB, other JSON bodies4MiB, multipart envelopes81MiB. Four concurrent
multipart requests are admitted; additional uploads receive429 and may be
retried. The supplier file itself remains limited to80MiB, and extraction admits
two disposable workers with a240-second deadline. Large supplier jobs that cannot
fit the reviewed rows and immutable approval snapshot in MongoDB return413;
split the source workbook before retrying. Legacy interrupted jobs without a
review snapshot require manager reapproval. Custom catalog permissions do not
replace the independent manager approval tier.

Operational smoke scripts require an injected `FORGE_TEST_OWNER_PASSWORD`;
the published historical default is rejected by staff and customer login.
Startup revokes sessions for any account still using that default without
changing its password. Use the controlled credential-reset process to recover
an affected account. Never print login responses or credentials into diagnostics.
