# Kitchen workflow and usability — 26 October 2026

Kitchen lead intake now selects or creates a floor-scoped architect/interior reference, keeps its server-resolved identity, and records the customer's address/contact/site details. Existing-customer selection displays the recorded details. Sales Data reference pages link Kitchen projects and include current authorized order value and recorded advances. Archived attribution survives unrelated lead edits. Inactive, invalidated, rejected and prior-cycle commercial records do not contribute open pending sales.

All nine progress segments display stage names. Future-stage navigation previews disabled forms without advancing the project. Showroom models are GI, SS, Other and Wardrobe; requirements and budget discussion are recorded in Design. Retired visit-interest and presentation-document policy requirements no longer block progression. New form dates start with the current India date and remain editable.

Design presentation no longer requires its own file/link. General private Documents remain available at every stage, including CAD and Completed. Device MIME omissions are normalized only for approved extensions, with existing byte/size/type, floor, permission and optimistic-concurrency validation retained. Design dates, sharing, response, handoff, requirements, budget, notes and revision totals can be corrected with a reason and before/after audit history. Approved designs retain owner-only correction. Stale editor drafts remain visible and cannot overwrite a newer saved design; explicitly replacing them resets their dirty baseline.

Kitchen panels/rows have responsive gutters. The shared keyboard viewport handler avoids scroll-event feedback and redundant CSS writes; the unsaved notice reserves its space before typing. Deferred dialog setup retains an input the user has already focused.

## Verification

- 3,166 hermetic backend unit tests passed again on the clean committed checkout; the 449 focused Kitchen/reference/analytics tests also passed.
- 49 real Mongo acceptance cases passed, including the archived-reference regression, all-stage private PDFs, approved commerce, floor isolation, referral acquisition, pending payment and invalidated-order reporting.
- 50 desktop Chrome/iPhone Safari Kitchen browser cases passed through all nine stages, completion/reopening, persistence, document transport, responsive layouts, permissions and navigation.
- Additional desktop/phone regressions verify reference creation/contact details and retained stale design correction drafts. A fresh-install four-device run verifies the complete nine-stage journey, PDFs and corrections; reference creation also passes on desktop, Android, iPhone and iPad after using the real click-and-type sequence.
- TypeScript and zero-warning lint passed. Mobile keyboard/input contracts passed.
- Full local performance audit passed with 676 stability and 60 timing cases, zero retries/skips/flakes; all 187 exported pages meet the 576 KiB initial-JavaScript budget. Publication requires a fresh run on the final committed source.
- Read-only live infrastructure preflight passed: Mongo/indexes/storage ready, no pending migrations. No migration or existing business-record rewrite is required.
- Independent workflow and reference reviews accepted the fixes after the stale-baseline and archived-reference findings were corrected.

## Publication boundary

Source, preview and production deployment identities and hosted acceptance must be recorded separately. A branch push is not production publication. The fresh npm security scan reports six high advisories through Expo tooling, node-forge and Zod; no suppression or protected-main bypass is included. At this report's creation the Kitchen changes have not been promoted live. Physical-device keyboard acceptance is not certified by browser emulation.
