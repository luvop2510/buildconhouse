# Private backup source binding and predeploy diagnostics

The private backup workflow used older protected environment secrets without a
check that they identify the current Railway source. It now requires a source
fingerprint derived from independently verified production configuration before
export. Missing, malformed, mismatched or parser-discarded whitespace/control
inputs fail closed. Fingerprints identify Mongo hosts/database and Supabase
origin while excluding credentials. Snapshot prefixes include the GitHub run ID
and attempt, and the private job has a 30-minute cap.

The read-only predeploy gate previously printed provider exception messages and
returned bootstrap error strings. Hermetic reproducers exposed a synthetic
private marker while preserving exit status 1. The repaired JSON boundary emits
only exception type, phase, numeric provider code/status or bootstrap error count.
Configuration/import failures now enter that boundary. Healthy output, index
enforcement, authenticated bucket checks and failure exit status remain intact.
The separate critical demo-account alert is unchanged; this repair does not
claim to sanitize every backend log path or resolve upstream npm advisories.

Validation: **1,612 backend unit cases passed**, six existing deprecation warnings,
29.25 seconds, exit 0. Mongo used unreachable localhost port 1; Supabase and JWT
configuration used explicit test placeholders. The suite includes 25 source
binding and 14 gate cases. Pyflakes, compile checks and diff checks pass. YAML
parsing verifies that the identity guard precedes export. Independent review
reproduced and then verified the fix for the literal database-name edge case.

The earlier [CI run at 69aa337](https://github.com/yashvardhansinh2510-max/forge2.0/actions/runs/37689407085)
passed 990 browser cases with 30 conditional skips and 1,573 backend cases;
its failures were the unchanged npm findings and required artifact storage.
The [independent hosted probe](https://github.com/yashvardhansinh2510-max/forge2.0/actions/runs/37689670443)
passed 62 cases with ten conditional skips and zero failures/flakes, then failed
its required upload on the same quota. These are dated evidence for that commit,
not an attestation that the operational-safety commit's CI completed.

Protected production secrets exist. Current Railway OAuth supplies names only,
so a trusted current-source fingerprint is still unavailable. No private backup
was dispatched from GitHub, and no new remote completion, cloud restore,
independent off-site backup, rollback or alert-delivery acceptance is claimed.
See [the operator procedure](../deployment/verified-private-backup.md).

The managed `2026-10-08-predeploy-diagnostic-redaction-fix.json` report retains
the original leakage reproducers, focused controls and final hermetic suite log.
Exact promotion/run identifiers are retained under the ignored operational
evidence directory after push. Signing, physical devices, original images,
legal/reviewer facts and recovery/region prerequisites remain outstanding.
App Store submission requires the user's approval after the remaining gates pass.
