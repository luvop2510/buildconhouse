# Tablet, payments and quotation release — 2026-10-04

## Resulting behavior

- Sanitary Purchases uses contained, prominent tablet product images, including the customer workspace.
- The quotation picker shows five usable product cards across on standard tablets, with bounded imagery and reachable Add controls. Tile selection and quotation editors use bounded thumbnails and multiple field columns; their picker shows multiple rows of choices.
- Collections distinguishes the value of unpaid orders, money already received, and the exact amount due. A customer with three orders has an explicit order selector before payment actions; the selected quotation number appears on the receipt action.
- Repeated direct GoDown stock sales reuse one transfer quotation per customer and floor. Receipts remain attached, added goods append revisions and activity history, and the shared pricing engine preserves discounts, transportation and additional costs. Separate project quotations and existing customer loan semantics remain separate. Historical documents are not merged or deleted.
- Paid and zero-value orders leave the collection queue. Automated pending balance placeholders do not appear as received payments. Quotation/history and update actions return to the canonical document, and returning to Collections refreshes its balance.
- Tablet/iPad quotation PDFs have a visible download action, preserve dimension options, and mint attachment tokens for the quotation's own floor, including iPadOS desktop user agents.

## Verification

| Check | Result |
| --- | --- |
| Backend unit suite | 1,456 passed; six dependency deprecation warnings |
| TypeScript and Expo lint | Passed, zero lint warnings |
| Frontend contracts, including download floor binding and iPad attachment paths | Passed |
| Expo Doctor | 18/18 checks passed |
| Production export and mobile bundle budget | Passed; checked routes under 576 KiB gzip |
| Focused tile/Purchases tablet journeys | 9 passed at 768×1024, 834×1112 and 1024×768 |
| Focused quotation/iPad journeys | 7 passed; one intentional non-tablet skip |
| Production Python dependency audit | No known vulnerabilities |
| MongoDB, required indexes and Supabase bucket access | Read-only checks passed |
| Migration dry run | No pending migrations |
| Full responsive browser audit | 760 passed; 20 intentional skips across eight profiles |
| Full media integrity scan | Metadata repaired and rechecked; storage-byte scan in progress |
| GitHub, Vercel and Railway release | Pending final verification |

Browser journeys use the production export and intercepted synthetic API data. They cover desktop, tablet, phone, small phone, tablet boundary, tablet landscape, Firefox and WebKit profiles without changing customer orders or payments. The iPad PDF case emulates its desktop user agent and touch capability; it is browser evidence, not physical iPad certification.

## Catalog metadata repair

Corrected 789 stale product-owned media family references: 653 supplier-workbook entries and 136 source-verified Vitra entries. Each repair checked the exact product, brand and floor, kept image bytes/storage paths and product identities unchanged, saved before-images and wrote a transactional audit. Both reconciliation scripts now preserve this invariant on subsequent imports.

## Outstanding release constraints

The npm security gate currently fails on new transitive Expo/Metro/Jest findings rooted in `braces` and `node-forge`. The registry's current releases remain affected; the [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) list no patched versions. The existing audit policy is unchanged and these failures are not suppressed. Functional test success does not constitute a clean dependency audit.

Store submission remains dependent on verified operator legal/contact/retention facts in `src/config/legal.ts`, signed iOS/Android release builds and real-device testing, reviewer access, and completed store privacy/data-safety declarations. `xcrun simctl` is unavailable on this host. No store approval or exhaustive absence of bugs is claimed. See [Apple's completeness requirements](https://developer.apple.com/app-store/review/guidelines/#app-completeness) and [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469).

This release used the Agent Teams task coordination skill for separate payment, quotation and tablet-layout implementation, followed by independent pricing review and consolidated verification.
