# Kitchen draft and private-upload hardening — 30 October 2026

Two deterministic regressions were reproduced before the corresponding fixes.

## Installation draft reconciliation

When one session changes Installation from Completed to In Progress and another
session uses Reload saved project, the work form previously replaced the entire
local installation draft. Unsaved notes and dates disappeared. The reopen effect
now takes unchanged fields from the newly saved record and retains fields edited
locally against the previous saved record. An untouched status follows In Progress;
an untouched completion date follows the cleared saved value. Local edits remain
unsaved until an explicit work save.

The actual form hook regression fails against the previous unconditional
replacement. Its fixtures cover both untouched and edited notes/dates. A separate
real-API browser scenario exercises the external update and mounted reload.

## Upload identity

Kitchen chunk uploads previously guarded individual HTTP requests but did not
bind byte preparation and the gaps between requests to the initiating login.
Signing out and returning to the same account while file bytes or SHA-256 were
pending could start a transfer under the later session. A delayed transfer/part
acknowledgement could similarly continue the next write.

The full upload now owns the existing client identity operation and checks that
operation after asynchronous preparation, SHA-256, begin, each part and finish.
An identity change throws AbortError, stops later writes and suppresses stale
progress/transfer/success publication. The operation is always released. Existing
file limits, hashed-byte identity, actor-bound transfer receipts and explicit
finishing/completed retry behavior are preserved.

Regression coverage uses the real client identity generation with controlled
byte/hash/begin/part/finish gaps and an A → B → A login sequence. The byte-phase
regression reported success before the fix; all five phases reject afterward.
Native iOS/Android transport contract tests and web download-integrity tests also
remain passing. These are deterministic contract tests, not physical-device
acceptance.

## Local validation

- `npx tsc --noEmit`: passed.
- `node scripts/test-kitchen-commercial.mjs`: passed, including reopen draft cases.
- `node scripts/test-kitchen-native-files.mjs`: passed, including five identity gaps.
- `node scripts/test-kitchen-pdf-files.mjs`: passed.
- `node scripts/test-kitchen-autosave.mjs`: passed.
- `node scripts/test-kitchen-note-fields.mjs`: passed.
- `node scripts/test-kitchen-dates.mjs`: passed.
- `node scripts/test-kitchen-draft-reconciliation.mjs`: passed.

Browser persistence validation and the final unchanged full release/performance
gate are recorded by the coordinating audit. No production data or deployment
was changed by this work.
