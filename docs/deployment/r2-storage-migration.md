# Supabase files to Cloudflare R2

Keep the existing FastAPI backend, Expo dashboard and MongoDB Atlas database.
R2 replaces object storage only. D1 is SQLite and would require a separate
database-layer redesign; this storage incident does not require that work.

## Verified state on 16 October 2026

- Cloudflare R2 is activated in the existing account. `forge-products` and
  `forge-private` exist with Standard storage and public bucket access disabled.
- The approved object credential is scoped to those two buckets. A separate
  approved R2 read-only administration token verifies bucket visibility.
  Credentials are in the gitignored, mode-0600 `backend/.env`; never copy them
  into Expo variables, commits, screenshots, logs or public artifacts.
- Authenticated R2 bucket access and private-domain visibility checks pass.
- Supabase responds with HTTP 402 to authenticated bucket access. Its dashboard
  confirms Storage Size Exceeded, 2.128 GB average against 1 GB, billing period
  4 October–4 November 2026. Dashboard storage listing does not load.
- Supabase Postgres is approximately 51 MB and has no application business-data
  migration requirement. MongoDB remains the application's business datastore.
- A fresh configured-source logical backup is at
  `backend/backups/r2-migration-logical-20261016`: 46 collections, 36,622 records.
  This is a verified logical export, excludes sessions, and is not a consistent
  point-in-time snapshot while other writers run. Railway production source
  variables were independently compared with the configured source before cutover;
  MongoDB URL/database, Supabase URL and JWT root matched.
- The fresh logical archive was also uploaded to `forge-private` under
  `recovery/r2-migration-logical-20261016/`. Every chunk and the completion
  manifest passed authenticated download/readback verification. This is a
  logical database backup; it does not include all current media bytes.
- MongoDB dbStats reports 232,954,767 data bytes and 24,428,544 index bytes for
  this database. The free Atlas cluster limit applies across databases; these
  measurements are not proof that every database on the cluster fits its limit.
- A follow-up read of all three authorized business databases totals
  408,054,408 bytes of data plus indexes. This is appreciably higher than the
  active application's 257 MB alone. Verify the Atlas dashboard's actual plan
  and full quota accounting before claiming sufficient free-cluster headroom.
- The prior local media snapshot `backend/backups/storage-20261006-goal` contains
  13,060 objects / 1,635,197,254 bytes. Verify it and compare current reference
  checksums before reuse. Its historical reference coverage is incomplete.
- Current local verification confirms exact SHA-1 matches for 8,484/8,497
  catalog media records, and exact archived SHA-256 matches for 7/271 warehouse
  media records (warehouse records do not carry SHA-1). The remaining 13 catalog
  and 264 warehouse records are listed privately in
  `output/r2-migration/missing-photo-records.csv`. These are record counts, not
  proof of unique missing files or complete coverage of private attachments.
- `forge-media.yashvardhansinh2510.workers.dev` now serves the approved public
  product photos through `PUBLIC_MEDIA -> forge-products`. Real image GET/HEAD
  and ETag/304 checks pass. The private bucket has no Worker binding.
- Railway production now uses the R2 driver and this public origin. Existing
  recovered references are being changed in conditional, journaled batches.
  Unrecovered references remain unchanged. No source objects have been deleted.
- The existing dashboard and MongoDB remain in service. This is a storage
  recovery deployment, not a dashboard or business database migration.
- Detailed deployment and verification evidence is recorded in
  `docs/audits/2026-10-16-r2-live-recovery.md`.

## Destination configuration

Retain `SUPABASE_PUBLIC_BUCKET=forge-products` and
`SUPABASE_PRIVATE_BUCKET=forge-private` as logical bucket identities. They are
used in stored metadata and private recovery receipts. R2 mode does not require
Supabase credentials. Set `PDF_IMAGE_ALLOWED_HOSTS` to the R2 public hostname
(without scheme/path) so quotation PDFs can load recovered images.

Set backend-only `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_API_TOKEN` and `R2_PUBLIC_URL`. The management token must be able to read
managed/custom R2 domain settings. The object-scoped token cannot do this (403).

Use a bucket custom domain, or deploy the read-only Worker under
`cloudflare/media/` with only `PUBLIC_MEDIA -> forge-products`. Its workers.dev
URL avoids buying a domain. Never bind the private bucket to that Worker.
The Worker accepts GET/HEAD, refuses writes and listings, and streams the
original bytes without paid image transformations. Verify real public delivery
before setting `R2_PUBLIC_URL`. The r2.dev development endpoint is rate limited
and is not the production delivery configuration.

Keep Workers on its free plan. R2's Standard free allowances include 10 GB-month,
1 million Class A and 10 million Class B operations monthly. Workers Free has
100,000 requests/day. These are account-wide allowances, not per-bucket grants.
R2 bills excess usage: alerts do not implement a hard zero-dollar cap. Check
actual usage, limit upload sizes, avoid uncontrolled backup accumulation and
do not activate paid image features or upgrade Workers.

## Copy and verify when source access is restored

Do not upgrade Supabase or disable spend caps to recover access under the user's
zero-spending constraint. Request free temporary export access from Supabase
support (sending a request requires user authorization), or use a confirmed
provider recovery/reset window. Waiting until 4 November does not remove the
underlying excess files; export/cleanup is still required when access returns.

Run from `backend/`. Before copying, verify the intended production/source
identity, freeze media/business edits for the final cut, verify a fresh logical
backup, check account-wide R2 usage and remaining Supabase egress. On inspection,
Supabase uncached egress was 2.446/5 GB, leaving approximately 2.55 GB before
concurrent usage. Do not repeatedly redownload the complete source.

```sh
.venv/bin/python scripts/migrate_storage_to_r2.py inventory --directory backups/r2-copy-RUN_ID
.venv/bin/python scripts/migrate_storage_to_r2.py copy --directory backups/r2-copy-RUN_ID --source-budget-bytes REMAINING_BYTES_MINUS_HEADROOM
.venv/bin/python scripts/migrate_storage_to_r2.py plan-references --directory backups/r2-copy-RUN_ID
```

Inventory is read-only; copy writes only R2 and a private local archive. It
includes private backups as well as public media, preserves paths/MIME, uses
conditional creates, verifies every target object by downloading it, checks
public file delivery, and refuses changed source inventories or existing
different bytes. Durable receipts let interrupted copies reuse verified local
downloads. The 8 GB conservative target budget is additional protection, not
an account-wide billing cap. A completed-copy record appears only on success.

Review the private `references.json` journal. It scans nested document values,
including quotation image snapshots, and replaces exact public object URLs
only when that key has a verified copy. Missing objects block the plan. Private
signed URLs and unrelated external URLs are never converted into public links.
Historical backup bytes stay unchanged; applying an old backup later requires
reapplying/reviewing its provider URL changes.

```sh
.venv/bin/python scripts/migrate_storage_to_r2.py apply-references --directory backups/r2-copy-RUN_ID --confirm-database EXACT_DB_NAME
```

Immediately before link writes the CLI rechecks source stability, destination
privacy and bytes. Updates compare original values and preserve unrelated fields;
concurrent changes halt instead of being overwritten. The private journal stores
before/after values before any database update. To reverse those exact changes:

```sh
.venv/bin/python scripts/migrate_storage_to_r2.py rollback-references --directory backups/r2-copy-RUN_ID --confirm-database EXACT_DB_NAME
```

Rollback preserves unrelated fields and refuses conflicting edits. It does not
delete the target files or revert newly uploaded application data.

## Original-file recovery alternative

Original workbooks, PDFs and photo archives can recover images without reading
Supabase. First reuse byte-verified local files that match current media
checksums. Extract only remaining photos with a defensible product/SKU/stock-lot
association; record ambiguous or absent associations rather than guessing.
Preserve product IDs, floors, media roles and ordering. Original supplier files
do not necessarily include user uploads, private attachments or newer photos.
Treat this as a partial recovery until current references are accounted for.

## Cutover and acceptance

Set `MEDIA_STORAGE_DRIVER=r2` in the existing backend deployment only after
verified coverage and URL migration. Preserve MongoDB, JWT and MFA secrets.
Update operations/backup deployment variables to use the same R2 configuration.
Use the provider-neutral verified `recovery_snapshot.py` and
`media_object_snapshot.py` tools. Historical scripts with direct Supabase REST
calls are not proof of an R2 backup/restore path.

Required release checks remain unchanged: hermetic backend tests,
`node scripts/test-r2-media-worker.mjs`, and
`npm run test:performance:audit` before publication, followed by configured-source
read-only readiness and authenticated deployed acceptance. Cover catalog photos,
custom uploads, stock photos, private documents, quotation/PDF snapshots, fresh
signed downloads and a verified private backup/pull. Do not weaken gates or
promote an unrelated editor's work as part of this migration.

Only after verified coverage, live acceptance and a retained recovery copy may
old Supabase files be considered for cleanup. The migration CLI never deletes
them. Do not delete the Supabase project as an outage-recovery shortcut.

## Live recovery validation

The recovered public object copy and application link updates are complete.
8,484 of 8,497 catalog media records now use R2. Unavailable files remain listed
privately for later recovery. The full Supabase export, including inaccessible
private historical attachments, is still blocked by the source's HTTP 402.
No Supabase objects were deleted.

Focused storage/readiness/recovery checks passed 83 tests. The isolated deployed
backend runtime passed 2,893 tests plus three fixture-dependent tests supplied
with their original fixture. Two failures in another editor's untracked password
tests belong to the separate working-tree run and were excluded from deployment.
The public Worker contract, full required performance audit and 32 deployed
floor/mobile acceptance checks pass. Detailed live journey outcomes, timings,
source provenance and remaining limitations are in
`docs/audits/2026-10-16-r2-live-recovery.md`.
