# Quotation recovery and pending reliability fixes — 16 October 2026

Version 1.0.4 repairs the reported Sanitary Bathroom and Ground Floor quotation
flows and integrates the reviewed, previously uncommitted storage and reliability
work. Investigation of the existing release gap preceded application edits.

## Why previous pushes were absent from production

The latest remote branch was `4710f545`; local commits `38efdd4e` and `501b5622`
had not been pushed. PR #16 remained open and blocked by frontend/security checks
and required review. Vercel production used `3e2d0901`, while newer branch pushes
created preview deployments because the configured production branch is `main`.
The healthy Railway R2 recovery was a separate committed-base/storage-overlay
deployment, not a complete deployment of this checkout. A successful preview or
an old provider Git source field therefore did not establish current production
source. See the companion CI diagnosis and R2 recovery reports for identities.

## Application repairs

- Ground Floor builders and the document list wait for floor synchronization.
  Access failures offer retry. Selection and quotation reads publish independently;
  an optional failed/held selection read cannot hide loaded or empty quotations.
- Saved tile documents retain a loading/retry screen until restoration succeeds.
  No blank editable document or save/PDF action is exposed on failed restoration.
  Customer corrections carry the Ground Floor header and failed writes stop save.
- Tile persistence captures its document ID and checks mount, scope and generation
  after each asynchronous write. Navigation, including A → B → A, cannot redirect
  a delayed save into a different document. The first autosave's new route ID
  retains edits made while creation was pending instead of restoring older data.
- Sanitary search hides previous-query product cards while loading or after failure.
  Empty results offer a search/filter reset; an empty catalog offers retry. Phone
  browsing has a direct room selector and retains room-specific lines in review.
  Failed Sanitary workspace access also offers recovery.
- Pending customer referrer and password-copy fixes preserve newer selections,
  acknowledge clipboard failures, and discard obsolete asynchronous feedback.

## Reliability and storage integration

Pending R2 runtime, private-bucket checks, public Worker and controlled migration
source are now included in reviewable Git source. Existing recovered photos and
business records are not remigrated by this release. Migration tooling restricts
reference changes to explicit application collections, preserves audit/import
history, validates the complete journal before writing and binds plans to the
Mongo cluster/database and configured storage identities. Old unbound plans fail
closed. Tests use synthetic storage; no live migration was run here.

Password hashing/comparison runs outside the API event loop. A completed password
reset during asynchronous login proof cannot mint a fresh valid old-password
session: the newly created session is followed by a current-credential/account/MFA
check, and stale proof revokes that session. Current identity determines returned
permissions. Customer password changes use conditional credential writes. Outbox
failure updates retain exact claim ownership.

Production workflow checks select the configured storage driver rather than
hardcoding Supabase. Hermetic tests still use inert Supabase configuration.
Protected production credentials are not copied into the public repository or
GitHub environment. Manual live CI jobs require their protected configuration.

## Verification and publication

Final integrated verification and deployment receipts are recorded in the release
PR and local `output/goal-release/` evidence. Only completed commands and actual
provider/application checks count as acceptance; preview readiness alone does not.
The deployment uses a committed-source-only Railway context and a Vercel production
candidate with source metadata, authenticated read-only acceptance and the existing
promotion guard. The temporary QA session is run-owned and revoked afterward.

Known limits remain explicit: npm audit currently reports 22 high/five moderate
findings and prevents a green protected-main merge. No security gate, branch review,
performance budget, deadline or pre-push hook is bypassed. Explicitly requested
branch publication and guarded direct deployment do not imply merging main.
Historical missing photo originals and physical-device/signed-native acceptance
are outside these browser and runtime checks.
