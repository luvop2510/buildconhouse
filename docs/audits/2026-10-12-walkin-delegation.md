# Regular Walk-ins and delegated workers — 12 October 2026

The regular `/walkins` register is the same component for owners and delegated
staff on every enabled floor. Kitchen and Furniture now land on this register;
existing notebook records and routes remain available under distinct lead
notebook names. No historical notebook data was migrated or deleted.

## Confirmed defects and repairs

- Intake fetched its salesperson picker through `/followups/config/assignees`.
  A worker granted only Walk-ins therefore received a permission failure. The
  picker now uses `/walkins/config/assignees`, returns only the display fields
  needed, and applies the same floor and assignment policy as submission.
- Salesperson assignment accepted only legacy sales roles. A delegated worker
  can now own a Walk-in when their explicit Walk-ins Create or Edit grant covers
  its floor. View-only workers, disabled accounts and unrelated custom manager
  grants do not acquire sales ownership. Validation occurs before customer
  resolution/creation.
- Choosing an Interested Department changed the request body but left duplicate
  checking and creation under the current workspace header. Both now use the
  chosen floor. Assignees reload for that floor, and the created detail route
  retains its `floor_id` query parameter.
- Visit Showroom changes an existing lead, but its POST previously consumed the
  Create capability. It now consumes Edit. A worker without a separate
  Follow-ups grant receives the successful transfer result and stays on the
  authorized register.
- The register includes only departments with Walk-ins View access for custom
  accounts. Create and workflow controls follow the corresponding capabilities;
  server authorization remains authoritative.
- Detail loading ignores obsolete responses after route changes and unmount.
  Quotation-price failure no longer escapes the card as an unhandled rejected
  promise. Legacy unknown card status values have a safe display fallback.
- Customer creation/editing, the shared customer card and Follow-ups no longer
  show VIP/Trade/Retail tier controls or badges. Existing stored tiers are
  preserved; editing other customer fields does not overwrite them. Hidden
  historical saved-view tier filters no longer constrain the Follow-ups inbox.

## Local verification

- 58 focused hermetic backend tests passed, including an actual delegated worker
  intake journey for each of the four floors; permission checks also prove that
  the new picker does not grant the Follow-ups picker.
- The full backend unit suite passed 2,120 tests before the four additional
  intake journey cases were added. The final combined suite is recorded by the
  parent release audit.
- 84 auth-provider race/lifecycle checks passed across the web, iOS and Android
  harnesses. No new authentication normalization was needed from these checks.
- TypeScript and scoped zero-warning ESLint passed. Team-delegation, notebook
  route and mobile UX contracts passed. `git diff --check` passed.
- Added `e2e/redesign-delegated-walkins.spec.ts` with four critical browser
  journeys covering the regular register, product items, showroom transfer,
  intake/save/detail, floor headers and uncaught browser error collection.
  Updated the existing showroom intake fixture and Kitchen floor landing
  assertions. Final browser evidence belongs to the combined release audit.

## Identity investigation and limits

No RO/VAP identity labels are hardcoded in the frontend. The parent agent's
read-only live user metadata investigation found the JK PATEL owner and no RO
or Kapoor matches; the demo seed contains a historical Aarav Kapoor account,
which is gated by explicit demo-seeding configuration. No real account was
renamed or deleted to hide an unconfirmed identity problem. A stale deployment
or a different backend/account remains a possible explanation, not a proven
root cause from these source checks alone.

These checks are local and hermetic; they do not establish production
promotion, physical-device acceptance, or an observed crash on a user's device.

## Independent completion review follow-up

The review found that confirmed Customer eligibility omitted buyers represented
only by historical/direct purchase orders, while completed Purchases included
them. Eligibility now also derives effective PO item owners from the same active
quantity/cancellation pipeline as completion; transferred item owners qualify,
and cancelled/zero/fully returned items do not qualify on their own.

Customer and quotation detail endpoints now derive completion from the already
authorized record's own floor using a copied request principal. Tile document
list completion is pinned to Ground Floor after the existing Tiles floor
access check. This preserves cross-floor detail authorization and prevents the
owner's ambient workspace from producing a false Active badge.

The final backend source passed all 2,124 hermetic unit tests in 34.03 seconds.
The scoped visibility/completion run passed 25 cases including two new
disposable Mongo regressions for PO-only/transferred buyers, reopening orders,
record-floor completion, tile list scoping and unauthorized detail 404s.
