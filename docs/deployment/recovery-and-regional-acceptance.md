# Recovery, rollback, alerting and regional acceptance

Implementation reviewed 5–6 October 2026. Owners, retention and service objectives
need operator sign-off; proposals below are not claims that those settings exist.

## Database and media backup

Use Atlas scheduled snapshots plus continuous/PITR backups when supported by
the actual cluster tier. Record the configured tier, backup retention, recovery
window and restore permissions. [Atlas backup guidance](https://www.mongodb.com/docs/atlas/architecture/current/backups/)
explains why logical exports and platform high availability do not replace PITR.

`backend/scripts/recovery_snapshot.py` is the tested logical-export fallback.
It discovers all regular business collections, including tile orders, counters,
floor assignments, migrations and the durable outbox. It excludes ephemeral
login sessions, views and system collections. It streams records without a
document-count cap and preserves BSON IDs/dates, collection options and indexes.
The completion manifest includes per-collection counts and SHA-256 checksums.
Directory/files use 0700/0600 permissions. Local snapshots are gitignored.

From `backend/`, with production secrets already configured:

```sh
.venv/bin/python scripts/recovery_snapshot.py backup --output backups/recovery-YYYYMMDDTHHMMSSZ --upload-private
.venv/bin/python scripts/recovery_snapshot.py verify backups/recovery-YYYYMMDDTHHMMSSZ
```

Every uploaded object is downloaded and compared before the remote completion
manifest is published. Upload/verification errors fail the command. The export
is **not a cross-collection point-in-time snapshot**: freeze writes for a
consistent cutoff, or use Atlas PITR. Remote transfer uses verified 8 MiB chunks
to bound memory and stay below storage upload limits. Snapshots contain customer
data and password hashes: never attach them to chats, public buckets or Actions
artifacts. Private storage is not a second independent provider or immutable
off-site backup; record access controls, encryption and deletion protection.

Retries verify existing chunk bytes and never overwrite them. The provider's
authenticated bucket metadata must explicitly report `public=false` before
upload/download. A failed manifest readback removes only the newly created
completion marker; a create followed by an ambiguous timeout is resolved by
exact-byte readback, otherwise the command fails and quarantines that snapshot
identity for operator verification. No ambiguous upload is called successful.
Always run full snapshot verification after download, even when a remote
manifest exists. Abandoned chunks are not complete snapshots; assign private
storage retention/cleanup ownership instead of deleting objects unattended.

Database snapshots contain media metadata, not Supabase object bytes. Back up
both public product objects and private attachments separately, preserving keys,
MIME types and hashes. Verify the media integrity gate after restore. Restoring
metadata alone cannot recover a deleted image.

`backend/scripts/media_object_snapshot.py` implements the separate byte archive.
It enumerates both configured buckets through Supabase's flat cursor-paginated
API, including unregistered objects and nested private source files. Unsupported
list APIs, repeated cursors, duplicate keys and malformed metadata fail closed.
The private `recovery/` prefix is excluded because the logical database snapshots
there are verified separately; other retained private files remain in scope.

```sh
.venv/bin/python scripts/media_object_snapshot.py backup --output backups/storage-YYYYMMDDTHHMMSSZ --logical-snapshot backups/recovery-YYYYMMDDTHHMMSSZ
.venv/bin/python scripts/media_object_snapshot.py verify backups/storage-YYYYMMDDTHHMMSSZ
```

The tool uses a bounded worker pool, checks catalog SHA-1 references when present,
writes raw bytes and per-object SHA-256 hashes to 0700/0600 local storage, and
rechecks the complete source inventory before publishing its completion manifest.
A failed attempt retains its private partial directory for investigation; use a
new output directory for another attempt. It does not overwrite a prior archive.
Objects above the explicit 128 MiB limit fail the command instead of disappearing
from the archive. Provider failures print only an exception type, never a response
body, customer filename or credential.

`archive_complete` certifies the available object inventory; it does **not** mean
all catalog references exist. `reference_coverage_complete` stays false when a
reference is missing, and the private manifest lists those gaps. The current
catalog still has five missing storage objects. Deleted versions and a frozen
point-in-time cut are outside this tool's guarantees. Copy a verified archive to
separately controlled encrypted off-site storage and verify it again after
retrieval before treating the local copy as a disaster-recovery backup.

Restore byte archives only into a fresh, explicitly confirmed private drill
prefix. The command validates every local file before any upload, verifies bucket
privacy and destination emptiness, reserves the prefix with a create-only marker,
uploads without overwriting, reads back every byte, and checks the final key/MIME/
size inventory. Failed destinations remain quarantined; use a new prefix rather
than retrying over partial contents.

```sh
.venv/bin/python scripts/media_object_snapshot.py restore-drill backups/storage-YYYYMMDDTHHMMSSZ --target-prefix restore-drills/storage-YYYYMMDDTHHMMSSZ/ --confirm-prefix restore-drills/storage-YYYYMMDDTHHMMSSZ/ --report backups/storage-YYYYMMDDTHHMMSSZ/restore-drill.json
```

The [6 October local byte archive](../audits/2026-10-06-storage-object-backup.json)
completed all 13,060 available objects, totaling 1,635,197,254 bytes. Final source
inventory comparison and a fresh complete local checksum verification passed.
Five missing media references remain listed; active products without a selected
photo are a separate coverage gap. A [three-file cloud restore](../audits/2026-10-06-storage-sampled-restore-drill.json)
verified 1,812,971 bytes in a newly created private bucket, including JPEGs and a
supplier workbook. The full cloud bucket restore and encrypted independent
copy still need operator capacity, ownership and acceptance.

Drill keys preserve the original bucket/key beneath that private prefix. This
never changes product references or publishes images. Promoting restored media
requires an isolated application validation and an explicit production cutover
plan; a sampled drill must not be described as a full bucket restore. Check
available destination capacity before a full cloud drill.

The manual **Operations evidence** workflow optionally uploads a verified
private snapshot using protected `production` secrets; it never uploads data as
an artifact or automatically restores production. Run it after assigning an
owner and configuring the protected environment. Proposed daily logical export
and weekly restore drill remain operator scheduling decisions.

## Isolated restore drill

Download from private storage, validate every file, then restore into a new empty
database. The tool refuses the original source database, a nonempty target or a
confirmation that does not exactly match the target name.

```sh
.venv/bin/python scripts/recovery_snapshot.py pull recovery-YYYYMMDDTHHMMSSZ --output backups/downloaded-drill
.venv/bin/python scripts/recovery_snapshot.py verify backups/downloaded-drill
.venv/bin/python scripts/recovery_snapshot.py restore backups/downloaded-drill --target-db buildcon_restore_drill --confirm-database buildcon_restore_drill
```

Validate collection counts, exact IDs/types, unique indexes, floor boundaries,
quotation/payment totals and media byte integrity. Use an isolated application
environment with messaging/email and outbox workers disabled: replaying a
restored outbox against live integrations can duplicate external actions. A
failed restore leaves only the isolated target partially populated; inspect it,
then use a new empty target for the next attempt. Never promote a partial target.
Old `restore_db.py` is an additive repair tool, not this controlled DR restore.

### Actual drill evidence — 6 October 2026

The verified `recovery-20261005-goal-02` logical snapshot contains 41 collections,
40,245 BSON records and 176 indexes. It was created at 12:43 UTC on 5 October
and predates subsequent Hansgrohe/Vitra media recovery; restoring it does not
restore the newest catalog edits or lost Supabase object bytes.

The [isolated cloud drill](../audits/2026-10-06-cloud-restore-drill.json) used a
fresh namespace `buildcon_restore_drill_20261005_goal02`, proven absent before
the attempt. No app, outbox worker or notification integration connected to it.
The restore failed after 158.760 seconds, with 11 complete collections and
1,718 of 1,858 archived image-blob records in the twelfth collection: 16,401
records total. The initial error was `OperationFailure`; its code was not
retained by the original error sanitizer. A subsequent guaranteed duplicate-ID
insert against an existing owned target record was rejected by the storage
gateway with code `8000` and a shared-space-quota category; no diagnostic data
was inserted. Full cloud restore, remote recovery readiness and cloud RTO
therefore remain unverified.

The failed target consumed 153,145,344 bytes of storage and 3,465,216 bytes of
indexes alongside production. After recording counts, the exact newly created
failed namespace was rolled back to preserve shared-cluster headroom; the
verified backup remains intact. Target absence and production MongoDB ping
were verified. All 42 source collection counts, index contracts and collection
options matched the initial baseline. The drill made zero source writes; the
full source content fingerprint was captured before the drill but was not
repeated after cleanup. Cluster aggregate storage fell from 589,303,808 to
432,693,248 bytes. No cloud drill database remains for later human cleanup.

The [local standalone retry](../audits/2026-10-06-local-restore-drill.json)
restored all 41 collections and verified all 40,245 document identities and
canonical BSON contents, collection options, and all 176 index key/option
contracts. Restore took 7.426 seconds and verification 3.913 seconds, totaling
11.339 seconds. The first local attempt ended with `AutoReconnect` after 11
collections; the exact transient cause was not established and was not
reproduced on a fresh retry. Both attempts used a private local standalone
MongoDB bound to loopback, with no live database, application or workers.
The agent-owned MongoDB process was stopped afterward. This verifies the
logical restore implementation; it does not verify Atlas privileges, PITR,
failover, remote backup retrieval or a production RTO.

Before another cloud drill, provision an isolated destination with enough
storage for the complete logical snapshot, indexes and verification headroom.
Check capacity and restore privileges before writes. Do not repeat this full
copy alongside production on the currently constrained shared cluster. A
quota-failed partial drill must be recorded and safely rolled back only when
the namespace is proven newly created and owned by that drill; never delete a
human-created or original database. A separate adequately sized cloud restore
and operational acceptance still need an owner and measured evidence.

Measure backup cutoff, restore start, ready time and verified business checks.
Proposed RPO 24 hours/RTO 4 hours need business approval and a timed drill. A
successful logical-export smoke test alone does not certify either objective.

## Application rollback

1. Record Git SHA, Vercel immutable URL/deployment ID, Railway deployment ID,
   migration state and a verified recovery reference before promotion.
2. If readiness, asset delivery or critical workflows regress, stop promotion.
   Select the preceding successful Vercel immutable deployment and Railway
   rollback-capable deployment through the authenticated platform controls.
3. Confirm database schema compatibility before rolling backend code back.
   Numbered migrations are forward-only; do not delete applied migration rows
   or reverse indexes against production. Use a forward repair where required.
4. Verify `/api/health`, `/api/health/ready`, unauthorized quotations (401), HTML
   no-store, fingerprinted JS MIME/cache headers and missing assets (404):
   `node scripts/verify-production-release.mjs https://buildcon-house-nine.vercel.app`.
5. Run Payments → quotation edit, sanitary/Ground Floor isolation, zero-stock
   visibility, exact images and document exports in an isolated acceptance
   environment. Confirm both aliases point at the intended versions. Record
   actual recovery time and follow-up cause; avoid overlapping manual and Git
   deployments, which previously caused alias/chunk version rollover.

## Alerting and performance evidence

`node scripts/check-service-health.mjs https://buildcon-house-nine.vercel.app output/operations/web.json india-probe 3000`
checks availability, ready payload and access boundary with 10 samples per
endpoint. It reports first-sample timing separately, warm p50/p95 and upstream
`Server-Timing`, and exits nonzero on status/readiness/timeout or warm p95 failure.
The default 3-second threshold is a proposed diagnostic threshold, not an
approved SLO. The region label is operator supplied and explicitly unverified.
It stores no credentials, raw response bodies or business identifiers.

The manual workflow preserves only these non-sensitive reports and fails on
an alert condition. `Public uptime monitor` now checks the canonical Vercel and
Railway origins hourly, at minute 17 UTC, and supports manual dispatch. It needs
no application secrets or installed npm dependencies. Checkout, Node setup and
artifact actions are pinned to reviewed official v7 commit SHAs; the runner is
Ubuntu 24.04, token permissions are read-only, and credentials are not persisted.

The scheduled monitor records ten samples per endpoint. Three consecutive
availability/readiness failures trigger a failing run; any unauthenticated 2xx
quotation response triggers an immediate failure. Recovered isolated failures
remain in evidence but do not trigger an availability alert. Latency percentiles
are recorded without enforcing an unapproved SLO. Only the two fixed technical
JSON reports become Actions artifacts; bodies, customer records, secrets and
backup payloads are excluded. Local negative checks cover failure recovery,
false readiness, auth exposure, malformed reports and response/credential redaction.

GitHub scheduling can be delayed or dropped under load, so an hourly check is
not a guaranteed continuous monitor. Configure Actions failure notifications for
the actual owner and confirm a controlled test notification before accepting
alert delivery. Scheduled-run notifications depend on the schedule actor and
notification settings. [GitHub schedule guidance](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
explains the scheduling and actor constraints. A dedicated production uptime/APM
monitor and escalation receiver still need operational acceptance.
Suggested alerts: three consecutive readiness failures; 5xx above 1% over five
minutes with a meaningful minimum request count; p95 above the approved SLO;
last verified backup older than 26 hours; media integrity failures. Record
receiver, escalation path and a controlled outage/recovery test. Do not claim
alert delivery until the owner has observed the test notification.

Backend monitoring now disables default PII, local variables and breadcrumbs
and allowlists technical error/timing fields before sending either errors or
transactions to Sentry. It excludes raw request/user/log/exception content and
database spans. Keep DSNs/secrets in platform settings, assign retention and
review real sampled events before completing privacy declarations.

Railway currently reports region `iad` and one replica. Do not move services or
add replicas based on local RTT alone. From a verified India runner/mobile ISP
and a second region, collect at least 100 representative authenticated reads
in staging, p50/p95/p99, error rate, first/warm timing and server processing.
Use synthetic staging data for concurrency and write tests; never replay writes
or load-test shared production. Compare database geography, connection reuse,
query plans, CDN derivatives and payload sizes before changing infrastructure.
After any region change, repeat the same fixture/load and record cost and
latency evidence. Browser viewport emulation does not establish regional or
physical-device performance acceptance.
