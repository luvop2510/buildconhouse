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
| Backend unit suite | 1,461 passed; six dependency deprecation warnings |
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
| Full media integrity scan | 789 metadata references repaired; zero metadata issues across 7,013 products and 8,925 current media rows; full byte scan complete: 8,902 objects passed; one transient failure passed on retry; 19 missing historical references remain |
| GitHub, Vercel and Railway release | Commit `a1735479` pushed to main; Railway deployment succeeded; Vercel production CLI deployment READY |
| Hosted targeted browser audit | 68 passed; 20 intentional skips across eight profiles |
| iOS and Android production bundle exports | Passed, alongside web export; no signed builds or device certification |

Browser journeys use the production export and intercepted synthetic API data. They cover desktop, tablet, phone, small phone, tablet boundary, tablet landscape, Firefox and WebKit profiles without changing customer orders or payments. The iPad PDF case emulates its desktop user agent and touch capability; it is browser evidence, not physical iPad certification.

## Catalog metadata repair

Corrected 789 stale product-owned media family references: 653 supplier-workbook entries and 136 source-verified Vitra entries. Each repair checked the exact product, brand and floor, kept image bytes/storage paths and product identities unchanged, saved before-images and wrote a transactional audit. Both reconciliation scripts now preserve this invariant on subsequent imports.

Recovered three missing Geberit displayed heroes using exact-SKU official EPS masters, rendered and verified at 5,786×4,672 pixels. Source pages, asset hashes, prior records and before-images were retained; the normal media pipeline created manufacturer primaries and the stored bytes and displayed selection were verified. SKU `115.085.JQ.1` remains unresolved: the local description names white/gold while the current official catalog names chrome/matt, so a replacement would require resolving that identity mismatch. See the [official Omega20 article table](https://catalog.international.geberit.com/en-XB/product/PRO_145241).

Shared-file deletion is now guarded: deleting/replacing a media row or compensating a failed upload keeps its storage object while another row references the same bucket/key. Five regression cases cover shared and unshared deletion, provider failure preservation and failed registration cleanup.

The full scan started before metadata repairs and image recovery. Its initial 789 family findings are resolved by the final metadata audit. Of its 20 download failures, one passed on retry and 19 are confirmed missing objects. Three recovered products now display verified manufacturer heroes; older missing records remain for audit. Fifteen active products still select missing images, so catalog recovery is not complete. Twelve Vitra source routes returned HTTP 404; three Geberit entries need identity review (the local descriptions disagree with current manufacturer variant/function details). Approved exact-SKU source assets or catalog identity decisions are required to finish these entries.

| Brand | SKU needing review or source recovery |
| --- | --- |
| Geberit | `115.085.JQ.1` |
| Geberit | `116.184.SN.1` |
| Geberit | `116.184.14.1` |
| Vitra | `5885B401H0101` |
| Vitra | `5885B401H0559` |
| Vitra | `7082B401H0075` |
| Vitra | `7082B401H0090` |
| Vitra | `7041B401H0075` |
| Vitra | `7041B401H0090` |
| Vitra | `7810B401H0016` |
| Vitra | `7812B401H0016` |
| Vitra | `5991B401H0016` |
| Vitra | `5993B403H0016` |
| Vitra | `5995B403H0016` |
| Vitra | `7425B401H0016` |

## Production verification

GitHub source release: [`a1735479`](https://github.com/yashvardhansinh2510-max/forge2.0/commit/a1735479). The Git-triggered Vercel deployment was blocked; the authenticated CLI deployment succeeded as `dpl_DDgLSLaXeo7hgSeKSkBUEsWubNXH` and is aliased to [BuildCon House](https://buildcon-house-nine.vercel.app). [Railway deployment](https://railway.com/project/29cdd543-efb5-4b41-a6d6-cd23ed2c37ee?environmentId=4b9581e2-cf69-4d0c-864e-26c8f6a7fffe) succeeded for the exact source commit. Both direct backend readiness and the deployed frontend API proxy returned HTTP 200. The hosted tablet/Payments checks passed against the canonical production URL with synthetic API interception.

[GitHub CI](https://github.com/yashvardhansinh2510-max/forge2.0/actions/runs/37201654784) passed its backend job (unit tests, security audit, static checks and Docker build); its frontend job failed at the dependency audit described below. The frontend functional evidence here was run locally and against production.

## Outstanding release constraints

Fifteen active catalog images remain unresolved as listed above. They prevent claiming a completely error-free catalog. The [official Geberit Piave article table](https://catalog.geberit.in/en-IN/product/PRO_292161) distinguishes `116.184` mixers from `116.188` thermostatic mixers; the existing local entries require review before substituting assets.

The npm security gate currently fails on new transitive Expo/Metro/Jest findings rooted in `braces` and `node-forge`. The registry's current releases remain affected; the [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) list no patched versions. The existing audit policy is unchanged and these failures are not suppressed. Functional test success does not constitute a clean dependency audit.

Store submission remains dependent on verified operator legal/contact/retention facts in `src/config/legal.ts`, signed iOS/Android release builds and real-device testing, reviewer access, and completed store privacy/data-safety declarations. `xcrun simctl` is unavailable on this host. No store approval or exhaustive absence of bugs is claimed. See [Apple's completeness requirements](https://developer.apple.com/app-store/review/guidelines/#app-completeness) and [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469).

This release used the Agent Teams task coordination skill for separate payment, quotation and tablet-layout implementation, followed by independent pricing review and consolidated verification.
