# App repairs and GitHub migration — 12 October 2026

## Scope and preserved work

The destination is `luvop2510/buildconhouse`. The user clarified that only this
app should be pushed; other repositories and the unidentified “Warsaw” service
are outside the migration. GitHub CLI device authorization completed as
`luvop2510`, with ADMIN access to the initially empty destination repository.

The checkout began on `codex/owner-password-rnb-responsive`, commit `d8098bcb`,
with substantial legitimate local work from the preceding catalog/filter and
walk-in session. That work is retained: multi-choice filters, supplier family
catalog cards and variant labels, quotation product ordering, confirmed customer
visibility, showroom transfers, exports, migration 0031 and their tests. The
release commit explicitly identifies preservation of this pre-existing work.

Before migration, an ignored local Git bundle was created and verified, recording
65 refs and complete history. The uncommitted patch and untracked source archive
are separately retained under `output/goal-2026-10-12/`. Existing remote
repositories are neither deleted nor force-pushed.

## Confirmed defects and changes

- Regular Walk-ins is the canonical register on every floor. Navigation no
  longer replaces it with Kitchen/Furniture notebook screens. Legacy notebooks
  retain separate labels and records. Owners and delegated workers share the
  same register, cards, detail and intake workflow.
- Delegated intake loads eligible salespeople through a Walk-ins API rather
  than a Follow-ups permission dependency. Assignment respects explicit floor
  and Walk-ins capabilities, including delegated workers. Customer lookup,
  creation, assignee loading and saved detail use the chosen floor. Stale detail
  responses cannot replace the current record. View-only users do not receive
  editing controls; showroom transfer remains usable without Follow-ups access.
- A failed Walk-in price save previously escaped as an unhandled rejected
  promise. It now keeps the notified error contained and releases saving state.
- The live sanitary catalog failed with Mongo error 292:
  `QueryExceededMemoryLimitNoDiskUseAllowed`, a 32 MiB sort ceiling. Database
  listing queries now sort compact identities and occurrence fields, then fetch
  and restore full page metadata, source cells, gallery images and category-aware
  family relationships. A delayed floor/filter response is invalidated before
  the catalog debounce can display it in the next workspace.
- One shared aggregation computes fulfillment from every positive, noncancelled
  purchase quantity. Every active line must be dispatched; supplier receipt alone
  is insufficient. Cancelled orders/items and fully returned quantities do not
  establish fulfillment. Item transfers use the current item customer.
- Customers, Purchases and standard/Tile Quotations separate active buyers from
  the `100% Customers` view and display `100% completed`. New unfinished orders
  return buyers to active views immediately. PO-only buyers qualify without a
  linked quotation. Detail statuses use the authorized record's floor, and Tile
  reads use Ground Floor. Purchases refreshes customer lists after dispatch,
  transfer, cancellation, bulk moves and shortage changes.
- Quotation approval and order delivery remain separate facts. Independent
  notebook follow-ups and the Furniture RNB ledger have no order/customer linkage
  sufficient to infer delivery completion, so their payment/confirmation states
  are not mislabeled as delivered.
- VIP/Trade/Retail tier badges, summary tiles, selectors and Tier export columns
  are removed from visible business pages. Stored legacy fields remain compatible.
- Password buttons now read `Save entered password` and
  `Generate and save random password`. Helper text explains that the first saves
  the entered/confirmed value, while the second replaces it immediately with a
  random value and ignores those fields. Both are account-specific, owner-managed
  permanent staff credentials and revoke that member's sessions.
- Phone navigation keeps regular Walk-ins discoverable, long account/More-sheet
  labels wrap, full viewport bounds and touch targets are audited, completed
  Purchases remains accessible on Kitchen/Furniture, and layered dialog focus is
  restored after native Modal cleanup. Floor-pinned bookmarks are preserved while
  their own floor-access hook synchronizes the workspace.

## Identity and production evidence

A read-only query of the configured live Atlas database found the matching
identity `login_id=JK PATEL`, `full_name=JK PATEL`, role owner, active. No matching
RO/Kapoor account was found; app source contains no hardcoded RO/Kapoor portal
identity. Existing auth hydration and race protections are preserved and tested.
No speculative account rename or deletion was performed.

The production Railway service returned readiness 200, but its published OpenAPI
still lacks the Walk-ins assignee API, Customer completion parameter and specific
member-password schema. Source migration alone does not update that deployed
backend. Railway CLI currently reports Unauthorized. Vercel credentials are
available, but the ambiguous “Warsaw” request does not identify an additional
service to change.

Read-only infrastructure preflight passes Mongo connectivity, required indexes
and Supabase bucket access. The repaired sanitary query returns 1,597 families
and a three-item page in 4.06 seconds, compared with the confirmed sort failure
before repair. There are 3,792 active sanitary products. These checks make no
business-data changes.

## Verification

- Combined final hermetic backend run: **2,145 passed** in 62.12 seconds:
  2,124 unit tests and 21 disposable local Mongo integration cases. Ten existing
  Pydantic/third-party deprecation warnings are retained in the log.
- Catalog tests include a 1 MiB nonspilling sort regression, exact source-cell
  preservation, full galleries, occurrence-category siblings and floor isolation.
- Completion integration tests cover older pending orders, partial quantities,
  receipt versus delivery, cancellation, returns, reassignment, PO-only buyers,
  all-page agreement, new-order reopening and authorized cross-floor details.
- TypeScript and zero-warning frontend lint pass. Expo Doctor passes 20/20.
  All 11 web route budgets pass. Required frontend contracts pass after repairing
  the deterministic overlay harness; overlay/history lifecycle has 17 passes.
- Optional route drift comparison has no configured baseline and is not claimed
  as a pass. Required dependency audit still fails on existing **27 findings:
  22 high and five moderate**. No advisory suppression is introduced.
- Frozen-source priority browser matrix: **140 passed, 16 intentional skips**,
  zero failures/flakes/retries across six widths. These cases cover all four-floor
  delegated Walk-ins, delayed sanitary catalog requests, customer/quotation/tile
  completion, Purchases rail refresh, cross-floor bookmarks, full phone bounds,
  44px navigation targets, long account names and layered palette focus.
- Web, iOS and Android release exports pass. The remaining 1,602-case six-width
  audit and four-browser/touch-profile outcomes will be recorded after completion.
  Interrupted earlier runs remain local evidence and are not counted as final
  acceptance.

No signed-native, physical-device or production-deployment acceptance is claimed.

## Migration safety

The release history was scanned across 5,601 text blobs for credential patterns.
The only matches were synthetic Mongo credentials in tests; no non-template
environment file or JWT credential appeared in the release history. The current
tracked source scan also matched only these test fixtures. Environment files,
dependencies, deployment credentials, database backups and generated evidence stay
ignored. The destination is public, like the repository supplied by the user.

GitHub push and final remote/default-branch verification are recorded in the
completion update. Production configuration and secrets are not embedded in Git.

## Continuation update — GitHub and deployment

Commit `64f5ed7ff8a912c1f85793cc0433367bc94b4e08` is verified on the new
repository's `main` and default branch. GitHub CLI is signed into `luvop2510`.
The local `origin` now targets the new repository; the old app remote is retained
as `previous-origin`, the older forge remote remains `legacy-origin`, and the
current branch tracks `origin/main`.

The user explicitly requested production deployment in the follow-up. Railway
project `BuildCon House Backend`, service `forge2.0`, production environment was
inspected through the Railway connector. The current service is online with no
recent failures. Only its repository and pinned commit were staged; environment
variables, domain, root directory and resources are preserved. The controlled
migration dry-run reports no pending migrations, and read-only infrastructure
preflight passes again. Railway accept-deploy returned “Cancelled — the user did
not approve this action. No changes were made.” Its pending patch is still staged;
the earlier deployment remains online. User confirmation is pending.

Vercel's existing project `yug19/buildcon-house` was verified by CLI inspection.
Connecting `luvop2510/buildconhouse` failed because the Vercel GitHub integration
lacks repository access. A CLI preview was created at
`https://buildcon-house-d7m1n8pc4-yug19.vercel.app`, but the platform blocked it
before build: the real commit author is not permitted to deploy to this project.
No source authorship was rewritten and no protection was bypassed. The user was
asked to authorize repository access and the commit author. The existing live
frontend remains unchanged.

The broad matrix exposed stale assertions for removed tiers, icon-bearing
password buttons and the canonical floor-switch destination. Corrected assertions
retain the requested behavior; all 18 focused cases pass across six widths.
A concealed-product immediate reload failed in the broad run but passed in
isolation; it remains a recorded diagnostic, not a blanket accepted pass. One
artifact ENOENT arose from an overlapping runner sharing its output directory;
subsequent focused/device runs use isolated artifact paths. The remaining broad
and four-engine device runs are still active and final acceptance is pending.

### Additional cold-reload investigation

The fresh-builder immediate-reload case is reproducibly intermittent: six repeats
on the published source produced two passes and four failures, with the browser
on `/access` despite the authenticated owner. Experimental route retention
improved a separate six-repeat run to five passes but left one failure, so those
experimental app changes were restored rather than published as a verified fix.
The investigation patch remains local under
`output/goal-2026-10-12/deeplink-investigation.patch`. This cold hydration/reload
race remains an open functional issue. The source tree matches the pushed runtime.
The broader viewport and device runs remain live; their later final results must
be read before declaring complete responsive acceptance.
