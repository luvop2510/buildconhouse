# BuildCon House release readiness — 7 October 2026

The application repair passed local acceptance and is prepared for the authorized
Git/deployment release. Full App Store readiness
remains blocked on the external and upstream requirements below; no store
submission, signed build or physical-device acceptance is claimed.

## Preserved work and application repair

The existing uncommitted workspace-search source/spec and audit files were
preserved and reviewed. The saved `palette-acceptance-full` run had no active
process or complete JSON report; its log stopped at case 668 and was retained.
Current main and both initial deployments were verified as
`cada5df882a59f8eac257e2fb5ff3eb405cff206`. GitHub's newer `71b87ae` CI runs
belong to a Dependabot branch, not a concurrent main update.

The repaired search uses fresh opening/floor sessions, guards cancelled query
consumers, and scopes keyboard navigation to the focused search. Independent
review reproduced a reduced-motion nested Escape defect: closing the palette
on keydown let the same keyup close the underlying quotation dialog. The repair
uses the shared captured keyup handler; separate Escapes close one dialog each.
Mobile quotation action rows now expose exact accessible labels without icon
glyphs. Tests choose controls by rendered layout, including the narrow builder
inside the tablet sidebar.

Undo/redo now keeps present/past/future/coalescing metadata in one state.
Replay cannot duplicate hook-owned stack entries, and queued undo sees the
latest document. Overlay dismissal callbacks/policy change only after commit;
an abandoned render cannot redirect the active listener. Fifteen actual-source
hermetic checks pass; the pre-fix source fails six of those checks. Caller
mutators must still be pure; this does not certify every application callback.

The native production profile now uses the new verified Railway origin,
`https://forge20-production-a8b0.up.railway.app`. A required hermetic check
executes the production native API client and detects divergence from web CI.
No signing identity, EAS project or operator/legal fact was invented.

## Validation ledger

- Backend: 1573 hermetic unit tests passed, six existing deprecation warnings.
  Fake MongoDB/placeholder Supabase settings were used; no live test writes.
- All 28 required frontend contract commands passed, including 15 history/
  lifecycle cases and the native production-client routing check.
- TypeScript, full lint with zero warnings, tile route contract and diff checks
  passed. Expo dependencies match and Expo Doctor passed 20/20.
- Rebuilt web release route gzip budgets pass under 576 KiB. Final focused
  browser acceptance passed 62 cases, ten conditional skips, zero failures/flakes.
  Unsigned final-source iOS/Android Hermes exports passed; original four Inter
  TTF hashes and Hermes magic verified. These are not signed binaries.
- Read-only backend Mongo/index/Supabase predeploy checks passed; migration
  dry-run found none pending. Initial canonical web verification passed all
  16 route/asset/header/cache/health/auth checks on the new backend.

The first parent full run was stopped for the independently reproduced Escape
finding: 325 passed and six skips, with unfinished/interrupted cases retained;
it is not complete acceptance. The first focused run found four new-test
locator/layout mistakes before history actions (58 passed/10 conditional skips).
The next focused run found two keyboard tests issuing Escape before overlay
focus was established (60 passed/10 skips). These reports are retained instead
of being replaced with pass claims; observable focus assertions repair the
fixture synchronization. Final acceptance uses rebuilt actual source and
synthetic intercepted APIs; browser profiles do not constitute hardware.

## Measurable remaining release criteria

| Priority | Current evidence | Required exit criterion |
| --- | --- | --- |
| Pending fixes/lifecycle/history | Reviewed repairs and hermetic regression controls above | Complete rebuilt full browser suite with no unexpected failures/flakes; exact hosted source verified |
| Security and required CI | npm 30 findings: 22 high/eight moderate; pip-audit production resolution clean | Supported dependency remediation; every required job passes with retained evidence and no suppression |
| Product images | 119 missing heroes plus five unavailable Vitra objects; 124 exact-row input manifest | Zero missing/unavailable displays; verified exact SKU/finish ownership, accepted source quality and post-write bytes/hero checks |
| Signed/native/devices | Unsigned export checks only; no EAS project/signing access or connected devices | Signed version/build/commit and passing iPhone, iPad, Android phone/tablet records, including save/share and interrupted-network behavior |
| Legal/privacy/listings/review | Source worksheet prepared; no production legal variables or isolated reviewer tenant | Operator-verified facts, functional contacts/deletion fulfillment, exact-binary disclosures, signed screenshots and minimally privileged reviewer access |
| Performance/accessibility/regions | Fixed spoken action labels; route budgets pass; new Railway region sfo, one replica | Physical accessibility acceptance and at least 100 representative staging reads from verified India and second-region runners, approved latency/error limits |
| Recovery/off-site/rollback/alerts | Fresh local logical restore and complete available-media checksum pass | Full adequately sized isolated cloud restore, independent encrypted off-site retrieval, timed isolated rollback and observed owner alert delivery; approved RPO/RTO/retention |
| Push/deployed commits | Initial hosts served exact cada5df8; final verification pending | GitHub main, canonical Vercel alias and Railway SUCCESS all match the final released commit |

Fresh media review scanned 6565 active products/8489 media rows and found zero
metadata identity issues. It rechecked bytes for the five known unavailable
objects, not every healthy object. 6441 products have a hero without a known
byte failure (98.1112%); this is not full ownership/byte certification. Three
additional official Hansgrohe SKU/finish sources were verified but remain below
the fresh-image 4K gate; no ambiguous or undersized photo was assigned.
1816 selected heroes remain poor quality. See
[the exact image input manifest](2026-10-07-media-recovery-refresh.json), including
six Nexion finish/size conflicts requiring supplier confirmation.

Security evidence: main CI
[37635145278](https://github.com/yashvardhansinh2510-max/forge2.0/actions/runs/37635145278)
passed application/backend checks while npm security failed. The unchanged
supported dependency graph still has unpatched braces/node-forge/sprintf-js
roots and an incompatible decoder migration. No SDK57 scratch application or
unsupported override was promoted. GitHub uptime run 37635419230 additionally
failed required artifact upload on exhausted storage quota. Browser artifact
suppression was removed; all uploads remain required. Safe numeric job summaries
retain readable technical outcomes before upload, with three-day retention;
existing user artifacts were not deleted. See
[the source dependency review](../deployment/security-dependency-review.md) and
[managed Codex Security evidence](</Users/yashvardhansinhjhala/.codex/state/plugins/codex-security/scans/forge2.0/artifacts-a4f404914519d513552b7f970655b6ab97b0305adea8ad4fa2a0c25848a329d3/artifacts/security-ci-refresh-2026-10-07/2026-10-07-security-ci-refresh.json>).

## Recovery and live operational limits

The fresh private local logical snapshot has 41 collections and 40319 records.
Its first upload and resumable retry failed with redacted WriteTimeout; neither
is a completed remote backup. A separately bounded operation timeout retry is
recorded when settled. The local standalone restore verified every canonical
BSON record/identity, collection option and all 176 index contracts in 18.184
seconds; the owned process was stopped. No app/worker or production write
connected to the drill. The export is not a cross-collection point-in-time cut.

A fresh complete checksum verification of the available media archive passed
13060 objects/1635197254 bytes; the five absent catalog references remain absent.
Local storage and the same Supabase provider are not independent off-site
backup. The earlier full cloud restore failed shared capacity; another full
copy was not run alongside production. Sampled storage restores remain sampled.

Initial 30 health/readiness/auth probes passed. Warm p95 was 2052/2798/1258 ms;
runner geography is unverified. Railway's one-hour window showed zero 5xx of
286 requests and a slowest proxy bucket p95 of 10788 ms, a different population
from the probes. No authenticated regional/load acceptance follows from those
numbers. Tracing is disabled, no Sentry DSN variable is defined and Railway has
no webhooks. Platform rollback candidates exist; actual rollback timing and
observed alert receipt remain unverified. See
[operational procedures](../deployment/recovery-and-regional-acceptance.md).

Missing signing/store access, real devices/testers, exact original images,
verified legal/operator facts, reviewer tenant and recovery/alert/regional inputs
were requested together once. Until supplied, these gates remain open. Policy
mail links are not proof of Apple's applicable in-app account deletion path;
current official sources and worksheet limits are in
[store/device acceptance](../deployment/store-submission-and-device-acceptance.md).
App Store submission requires explicit user approval after readiness is complete.

A complete-suite attempt was interrupted after unrelated workflow timeouts
during a host load spike above 150 on this eight-core Mac. Its reports/logs are
retained as `readiness-release-full-under-load`; exact timeout cause is not
established. The final run uses two browser workers, identical 30-second test
timeouts and zero retries, with native exports completed first. No failed
assertion was suppressed. An optional route-drift command also requires an
existing baseline that is absent; it is not certified or a required CI command.

Read-only progress inspection of the new private snapshot found 25 uploaded
objects and no completion manifest at that point. Partial chunks are retained
privately for safe resumption; their presence is not complete remote acceptance.
No cleanup or overwrite of unknown-owned snapshot objects was performed.

The separately bounded private-upload attempt also failed, with redacted
ReadError after 818.933 seconds using a 120-second per-request storage timeout.
The production driver timeout was not changed. A remote completion manifest was
not verified, so this new snapshot is local-only acceptance. Partial private
chunks remain quarantined for future safe resumption. A reliable private
remote transfer and independent encrypted off-site retrieval remain required.

## Final local acceptance and promotion record

The final rebuilt complete browser run passed **990 cases**, with **30
intentional skips**, **zero unexpected failures** and **zero flakes**, in
14.4 minutes across eight profiles. It used two workers, unchanged 30-second
deadlines and zero retries. The 62-case focused final run also passed, with ten
conditional layout skips. The full suite includes actual quotation toolbar
undo/redo/branch clearing and nested reduced-motion Escape/focus behavior.
Earlier interrupted/failed attempts remain in the private technical evidence.

Final-source iOS and Android unsigned Hermes exports passed. Their bundles are
7956487 and 8044780 bytes; Hermes magic and all four original Inter TTF hashes
were verified. These are JS/native export checks, not signed installable builds.
The eight web route bundles measure 404–428 KiB gzip against a 576 KiB limit.

Promotion is authorized for this application repair. Overall CI/store readiness
remains blocked on the explicit gates above. The exact final Git SHA, immutable
Vercel ID/URL, canonical alias, Railway deployment/source SHA, CI results and
post-deploy read-only evidence are recorded after push in ignored
`output/operations/readiness-deployment-final-20261007.json`. No App Store
submission is authorized by the web/backend promotion.
