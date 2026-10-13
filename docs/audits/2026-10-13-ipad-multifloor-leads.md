# iPad forms and pre-order multi-floor leads — 13 October 2026

The local implementation provides multiple interested floors and multiple workers
per floor on follow-ups, walk-ins and department notebooks. Each selected floor
retains its own authorized record and customer identity, connected through a
shared lead group. The Interested and assignment editors provide Select all,
floor-specific eligible members, lead source and designer/studio reference fields.
Eligibility checks active staff, floor and area permissions, including the actual
stage of an existing destination notebook, including a typed phone on new intake.
Failed saves retain the draft. Manual follow-up retries use a persisted identity
bound to the initiating member and source floor; a partial write resumes the same
group. Reusing that identity for a different payload is rejected. Kitchen and
Furniture use their canonical notebook creation routes.

Follow-ups cover pre-order sales only. Payment, purchase, dispatch, delivery,
operations and support producers and manual choices are retired. Order placement
closes the related floor records into the same committed order, preserving
unrelated project leads and historical attribution. Migration 0034 retires legacy
operational reminders, consolidates eligible historical leads and adds bounded
team/referral query indexes; it is idempotent and remains pending in production.

The owner-only Team assign page shows worker totals for assigned logical leads,
contacts, calls and completed work, plus paged lead details, latest responses and
activity history. Aggregate counts span the entire selected scope, independently
of the detail page. A contact followed by its call outcome counts once. Overlapping
workers retain separate pending attempts; consuming an attempt must not erase a
newer call. Activity detail has an explicit truncation indicator.

Interior sales reporting counts acquired people before an order, across lead
sources and selected floors. Normalized phone identity prevents the same person
from being counted again for every floor. The directory supplies the designer
name and studio/company. Revenue and orders still reflect actual committed sales;
brand-filtered acquisition uses that filtered order cohort.

Web forms use Safari's visible viewport height and offset so focused inputs and
modal actions remain reachable above the keyboard. Resizes are coalesced, clipped
inputs scroll into view and pinch zoom retains browser panning. Shared overlays
wait for closing portals before restoring focus. Team IDs show Phone only;
legacy mobile-only contacts hydrate Phone and distinct historical values survive
unrelated edits.

## Verification and publication status

Final verification is recorded in [the companion JSON](2026-10-13-ipad-multifloor-verification.json),
including the candidate code-diff fingerprint and raw latency samples.

| Check | Result |
| --- | --- |
| Full backend and four disposable MongoDB integration cases | 2,346 passed; six third-party deprecation warnings |
| Required frontend contracts | 40 commands passed |
| TypeScript and full zero-warning Expo lint | Passed |
| Focused keyboard, multi-floor and interior browser cases | 55 passed; no failures, skips or flakes |
| Broad iPad Safari workflow audit | 118 passed; no failures or flakes; four explicit phone-only skips |
| Fresh standalone performance audit | 44 passed; no failures, retries, skips or flakes |
| All generated route bundle checks | 159 routes; largest 451 KiB gzip against unchanged 576 KiB ceiling |

Team assign's 50-lead fixture, with 200 ms API responses, renders primary content
in 1,128–1,707 ms across the four devices; activity expansion takes 67–88 ms and
floor changes through the completed response take 386–483 ms. The unchanged
2,500/750/1,500 ms repository ceilings pass. These are fixture measurements,
separate from the user's total HTTP requirement below.

Tests use hermetic backend settings, disposable local MongoDB and
fixture-only browser servers; they do not mutate production business records.
The local pre-push hook and protected-main functional, security and performance
requirements remain enabled. Physical iPad keyboard acceptance requires an actual
device; Safari emulation and controlled visual-viewport changes cover the layout
and focus regressions.

The user's release requirement is **total response time under 2 ms**. Existing
production read-only health samples fail it before these changes:

| Route | Minimum | Median | p95 | Samples |
| --- | ---: | ---: | ---: | ---: |
| Vercel public domain | 188.71 ms | 200.62 ms | 1,296.49 ms | 10 |
| Railway directly | 153.61 ms | 178.20 ms | 478.31 ms | 10 |

Measured on 13 October 2026 at 12:09 UTC from the execution host. Total duration
includes response-body consumption, network, TCP/TLS and proxies; the first
sample includes cold connection setup. These are current-production baseline
measurements, not proof of candidate-production latency or a customer-region
certificate. Median averages the two middle samples; p95 uses nearest rank.
Server-Timing is recorded separately in the local evidence and is
not substituted for total duration. The repository's rendering/computation
budgets measure different quantities and cannot certify the 2 ms target.

The user subsequently explicitly authorized GitHub push, live migration, Vercel
and Railway publication despite the measured requirement gap. Publication proceeds
with unchanged repository budgets; deployed identities and health are recorded
when verified. The independent npm security gate
also retains 22 high and five moderate findings; no green security CI or protected
merge is claimed. Existing PR 16 is attached to the task for review.

Local raw evidence is retained in `output/multifloor-release/` and
`output/playwright/`. Earlier failures are diagnostic records, not acceptance.

A review of the previous remote CI run identified four phone assertions that
looked for quotation controls inside the default full-screen product browser.
Tests now enter the workspace through its existing visible button. The four-device
regression selection passes 30 cases with two explicit phone-only skips and zero
failures/flakes; delegated intake and catalog controls pass on every device.
