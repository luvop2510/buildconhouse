# Verify the source before a private backup

The Operations evidence workflow can export business data using the protected
`production` environment. Its secrets were last updated on 28 September 2026;
their presence alone does not prove that they identify the current Railway
database and storage project.

Generate the source fingerprint with `python scripts/verify_backup_source.py
--print-fingerprint` in the independently verified current production service
environment. Confirm the service identity against the exact deployment ledger:
project `4d4a8d55-2e5e-43dc-b3a2-298e4455f210`, service
`9683fa61-7c70-4fce-ba6d-210b0cff5267`, environment
`3ee5a85e-c436-4010-8103-8e8a49186dd1`. The generator uses Mongo hosts,
database name and Supabase origin; it excludes usernames, passwords and keys.
The expected identity needs evidence independent of the backup job's own secrets.

Dispatch Operations evidence with `private_backup=true` and the verified
64-character `expected_source_fingerprint`. A missing, malformed or mismatched
fingerprint fails before export. Read the source-binding step before interpreting
any backup output. The private job has a 30-minute cap and exports to a unique
`recovery/<timestamp>-<run-id>-<attempt>` prefix; it never restores into a business database.

The existing upload verifies each chunk by downloading it, then publishes and
verifies the completion manifest. A successful manifest and local checksum
verification prove a logical snapshot, subject to concurrent business writes.
They do not prove an Atlas point-in-time cut, independent encrypted off-site
recovery, physical-media completeness, timed rollback or alert delivery.

Snapshot documents and manifests stay in the private bucket and private runner
directory. They are excluded from Actions artifacts. Provider failures print
allowlisted diagnostics; credentials and document contents must remain absent.
Download and verify the completed snapshot privately before performing an
isolated restore with adequately sized capacity and approved recovery limits.

Current blocker: Railway OAuth exposes variable names only, so no current-source
fingerprint has been verified in this session. The private job has not been
dispatched. The operator's source-binding evidence remains part of the requested
access/facts; no production-source equivalence is inferred from old secret names.
