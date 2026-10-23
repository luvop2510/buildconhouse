# Shared follow-up routing and PDF floor repair

The owner reported missing Visit Showroom transfers, delayed quotation follow-ups and failed PDF downloads. The requested commit identity is `yashvardhanjhala <yashvardhanjhala@gmail.com>`. The owner explicitly chose to preserve existing quotation reminder delays.

## Root causes and changes

- Assigned/multi-floor walk-ins already have a canonical follow-up with `origin=walkin`. The transfer's insert-only upsert reused that record without updating its origin, then hid the walk-in. The showroom filter consequently excluded it. Transfer now promotes routing metadata on the exact same-floor identity, preserving assignments, status, due dates and history. Repeated requests remain idempotent and do not duplicate activity events.
- A mounted Follow-ups screen only read its workspace URL parameter during initial state creation. Tabs now use URL state. Incoming transfer identity clears old search, Won, owner, category, priority and bucket filters, cancels obsolete detail reads and opens the showroom workspace. Detail transfers use the loaded record's actual floor.
- A concurrent reconciliation request was skipped on the assumption its change was in the active snapshot. That assumption was false after the snapshot had already been read. Concurrent calls now request a fresh coalesced pass. Ground/Sanitary and configurable Tile reminder delays remain unchanged.
- PDF fetch/preview helpers omitted the selected floor when callers did not supply one. They now capture the floor before awaiting token hydration, retaining explicit-floor precedence and cookie/Bearer behavior. Tile Chalan callers pin their known Ground floor. This addresses a concrete scope failure; it does not establish the cause of every reported live quotation PDF failure.

## Verification

- 3,084 hermetic backend unit tests passed; three existing Pydantic deprecation warnings.
- Nine disposable-Mongo integration checks passed: actual HTTP transfer/list origin filtering across all four floors, legacy recovery, repeat requests, other-floor isolation, history preservation, dry-run/idempotent recovery and ambiguous-customer rejection. These explicitly isolated cases join the existing CI Mongo acceptance job.
- 30 showroom browser cases passed on desktop/tablet/phone Chromium and iPhone WebKit, including failed-transfer retry, durable workspace routes and actual-record floor context.
- Download/mobile/native regressions, selected-floor/token race checks, TypeScript and zero-warning lint passed. Seventy-four focused hermetic backend PDF/token checks also passed.
- Fresh complete pre-push and remote gates are required for the final commit. Previous commit `de25bde3` passed the complete local 624 stability/60 timing gate; its results do not certify these subsequent changes.

## Existing hidden records

`backend/scripts/repair_showroom_followup_origins.py --floor first-floor` is read-only by default and emits counts without customer details. Review each floor's counts, then add `--apply` using the same authenticated backend environment. The tool only changes `origin` on an existing manual walk-in follow-up with a matching customer, walk-in, floor and confirmed transfer. It creates/deletes nothing and leaves ambiguous/missing identities as conflicts. Run it again to verify no remaining candidates. Production repair has not been performed.

## Render evidence and remaining release work

The authenticated Render dashboard showed service `srv-dbcrsmvb9u1s73cmq8t0` in Singapore, Free compute, Dockerfile `backend/Dockerfile`, build context `backend`, no command override and health path `/api/health/ready`. It was serving source `154c1e816dd4204c69e61c10a58ef5f6c4861c98` from `codex/stability-review-2026-10-12`, not this repair branch. The dashboard warns of idle startup delays of 50 seconds or more. Read-only probes timed out at 30 seconds and a later readiness probe returned 200 in 1.71 seconds. This establishes intermittent availability, not its sole cause.

Observed live health checks call Cloudflare domain checks and take roughly 1.2–1.6 seconds. No credentials, bucket visibility, service plan, security protection or environment values were changed. The current Docker image includes ReportLab, image libraries, bundled fonts and its runtime assets; actual provider logs and authenticated synthetic document downloads must still qualify the deployed version. No production PDF generation was attempted because those GET endpoints journal generation events.

Production publication remains unverified. The dependency gate still reports 22 high upstream findings, protected-main review remains required, and the expired October 21–22 exception has not been reused. The owner authorized deployment; that does not supply passing release evidence or remove repository protections.
