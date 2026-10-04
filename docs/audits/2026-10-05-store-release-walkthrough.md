# BuildCon House release walkthrough — 5 October 2026

## Release assessment

This pass fixes confirmed performance, image-selection, order-status and export bugs. The web/backend release is being verified separately from store submission. Signed binaries, physical-device certification and operator legal/store facts are not available from this workspace; they remain explicit release requirements.

## Walkthrough and changes

| Area | Expected workflow and findings | Changes in this release |
| --- | --- | --- |
| Sign-in and floor access | Staff/customer identity, roles and selected business floor must stay consistent while storage and requests finish. | Delayed storage reads no longer restore an old token, account kind or floor after login/logout/floor selection. Cancelled GET consumers cannot start a request or receive cached data. |
| Sanitary quotation builder | Select exact variants; assign rooms/areas; include concealed parts; preserve quantities, pricing, discounts and autosave; confirm through Place Order. | Quantity lookup indexes the active room once instead of scanning every line for every product card; stable card handlers and smaller render batches avoid repeated work. |
| Quotation PDF | Generate with/without dimensions; preserve totals, exact images and supplemental seat/diagram media; save via a user gesture on tablet/mobile. | Exact SKU/floor product images are a fallback when legacy concealed products lack media rows. Dimension prompt covers all supported brands. |
| Product PPT | A cover followed by one slide per nonempty bathroom/room. | Adaptive area/product grids replace six-product pagination. Seat-cover/hidden-product media are retained. Each unique image is converted once and bounded to 1600 px for slide viewing. |
| Sanitary Purchases | Filter stages/brands/customers; update quantities/stages; transfer, replace and dispatch material; retain histories and floor isolation. | Both list query paths preserve floor identity and hydrate current exact product previews. Memoized phone/tablet cards, lazy action sheets and deferred customer reads reduce work. Floor switching clears stale selections/dialogs and ignores outdated secondary responses. |
| Tile Purchases | Supplier/customer detail items must display exact tile previews; paging and stage quantities must remain correct. | Shared catalog-preview resolution supplies product identity/image fields to tile detail responses. Both detail screens use the same 96 × 60 contained image frame and SKU fallback. Supplier/brand lists fetch a bounded page and aggregate KPIs in one Mongo facet instead of loading thousands of documents or issuing three sequential queries. Search is literal, avoiding accidental regex patterns. |
| Kitchen/Furniture notebooks | Record walk-ins, contact notes, quotation qualification and lost outcomes. | Lists virtualize customer cards. Manual Won is removed. Moving to a quotation is qualification and does not place an order. A complete notebook-specific order-entry workflow remains a product gap. |
| Follow-ups and quotation statuses | A customer becomes Won through a placed order. | Manual Won and legacy Converted success choices are removed. APIs reject unsupported success transitions without proof of a same-floor placed order; generic quotation PATCH cannot bypass Place Order. Confirmation automatically closes matching active notebook leads in the order transaction, preserving other floors, lost/closed rows and leads linked to a different quote. Historic statuses remain readable. |
| Product rendering | Exact product images must fit consistent frames without continuous tablet JS work. | Web placeholders no longer run per-image animation loops; derivative requests change only when the display crosses a cache-size bucket. |
| Monitoring and native configuration | Optional monitoring must not crash startup; native release API calls require HTTPS. | Monitoring initialization failures are handled without exposing error details. EAS production profile explicitly supplies the existing HTTPS backend URL. |
| Collections, access, operations and public pages | Review existing payment, shortage, transfer, permission, retry, form and responsive paths. | Covered by the consolidated existing regression suite. Additional findings are recorded below if present. |

## Measured performance evidence

The controlled 2,600-product/500-line quantity fixture preserves exact output parity: approximately 15–34 ms for repeated scanning versus 1–2 ms for indexed lookup on this host (11–19× across representative runs). This is a CPU hot-path measurement, not an end-to-end tablet speed claim.

The canonical app uses Feather icons, but barrel imports included all 19 icon font families. Replaced 75 imports with the public Feather entry point; Expo Go loads only that icon font. Inter/Fraunces typography remains unchanged. Actual final production-export measurements:

| Initial web route JavaScript (gzip KB) | Before import cleanup | After | Reduction |
| --- | ---: | ---: | ---: |
| Login | 521 | 385 | 26% |
| Dashboard | 532 | 396 | 26% |
| Purchases | 545 | 409 | 25% |
| Follow-ups | 546 | 410 | 25% |
| Tile Orders | 538 | 402 | 25% |

The fresh combined iOS/Android export falls from 21,844,725 to 17,076,510 bytes (21.8%). Android Hermes bytecode falls from 7,996,491 to 7,624,152 bytes; iOS from 8,000,585 to 7,628,221. These are export assets, not installed app or signed IPA/AAB sizes.

New browser fixtures contain 120 Kitchen/Furniture customer cards and attach the number mounted by the virtualized list at each viewport. The old ScrollView mounted all 120. Real-device scroll/frame timing remains required.

Generated export fixture: cover + Master Bathroom + Powder Room; Master Bathroom contains 17 selected products plus a seat-cover image. The fixture generated in approximately 299 ms at 297 KB. LibreOffice-rendered slides were visually checked; generated PDF/PPT geometry tests cover dense 7/17/36/60-product rooms, custom areas and hidden parts.

For a repeated 2000 × 1200 image across 24 products in one room, the old PPT path took 12,441 ms, produced seven slides and 4,355,518 bytes; the new path took 228 ms, produced two slides including the cover and 2,529,272 bytes. This synthetic comparison isolates image normalization/layout, not network-fetch latency. See [the export audit](2026-10-05-quotation-exports.md).

## Datastore and image evidence

Read-only Atlas checks on 5 October: `buildcon_house`, no duplicate `(floor_id, brand_id, sku)` combinations, no pending migrations, unique `products_floor_brand_sku_unique` present. Mongo ping, required indexes and Supabase bucket access passed. No migrations or customer orders/payments were changed during testing.

Media metadata audit: 6,565 products and 8,475 media rows, zero identity/orphan metadata issues. Rechecked all 18 media objects associated with the 11 previously unresolved Vitra SKUs; 11 objects remain missing. This is a targeted byte recheck plus a full metadata scan, not a fresh full byte scan of every object. Missing files cannot be repaired by substituting a different finish/family product image.

Unresolved Vitra SKUs: `5885B401H0101`, `5885B401H0559`, `7082B401H0075`, `7082B401H0090`, `7041B401H0075`, `7041B401H0090`, `7810B401H0016`, `7812B401H0016`, `5991B401H0016`, `5993B403H0016`, `5995B403H0016`. Source discovery and constraints remain in [the recovery manifest](2026-10-04-vitra-recovery-discovery.json).

## Verification

Final consolidated verification completed against the final runtime source:

- Browser audit: **824 passed, 20 intentionally skipped, zero failures/flakes**, 8.3 minutes. Eight profiles cover 320/390 px phones, 768/834 px tablets, 1024 px tablet landscape, 1440 px desktop, Firefox and WebKit. Skips apply only to tablet-specific checks outside their target viewport. New tile-image, long-notebook, confirmed-order and PDF/PPT download journeys pass across all eight profiles.
- Backend unit suite: **1,504 passed**, six dependency deprecation warnings. Unused legacy Chalan notification mocks were removed while outbox notification assertions remain.
- All 15 required frontend contract commands passed, plus the Tile Orders route contract and palette contrast checks.
- TypeScript, zero-warning lint and Expo Doctor **18/18** passed.
- Production web export and all eight initial JavaScript budgets passed; iOS and Android Hermes exports passed.
- Changed backend runtime-module lint, compilation and diff whitespace checks passed; production Python dependencies have no reported audit vulnerabilities.

The optional frontend drift script is unconfigured: no operator-reviewed external route baseline is supplied. It was reported as unavailable rather than initialized from the changed code to manufacture a pass. The existing npm security gate remains failing for the disclosed upstream advisories.

Browser tests run the production export with intercepted synthetic API data and do not modify real business data. Generated document fixtures exercise the real rendering engines. These checks do not prove absence of all bugs, production load capacity or native-device behavior.

## Items still required before App Store / Play Store submission

1. **Operator-owned build and store accounts.** Expo CLI currently reports Not logged in, and app configuration has no linked EAS project. Link the correct EAS project and use the operator Apple/Google accounts for signed iOS/Android release builds, TestFlight and Play internal testing.
2. **Legal and support facts.** Replace the publication TODO with verified legal entity/address, privacy/support contacts, retention schedule, effective date and applicable grievance/jurisdiction facts. Public Privacy/Terms pages still contain incomplete publication text.
3. **Store forms and review access.** Complete privacy/Data safety declarations for actual enabled telemetry/storage/permissions, screenshots/listing/support URLs, age/content ratings, reviewer credentials and instructions. Accounts are administrator-provisioned; validate the deletion/support process and declare it accurately. [Apple review requirements](https://developer.apple.com/app-store/review/guidelines/#app-completeness), [Google Data safety](https://support.google.com/googleplay/android-developer/answer/10787469).
4. **Native-device acceptance.** Test signed binaries on physical iPhone, iPad and Android phone/tablet for startup, orientation/safe areas, keyboard, slow network, scroll responsiveness, image selection, PDF/PPT save/share, floor isolation, logout/relogin and accessibility text sizes. WebKit/touch emulation and Hermes export are not this certification. Android config targets API 36; inspect the final signed manifest against [current Google target SDK requirements](https://developer.android.com/google/play/requirements/target-sdk).
5. **Exact missing image sources.** Restore/recover the 11 verified Vitra objects without changing SKU/finish identity. Current missing originals prevent claiming complete catalog imagery.
6. **Frontend dependency security gate.** Current npm audit reports 38 findings (23 high, 13 moderate, 2 low, 0 critical), and the existing gate fails. `braces` and `node-forge` advisories list no patched versions. Do not suppress the gate or accept an untested cross-SDK React Native upgrade. [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv). Production Python audit is clean.
7. **Operational acceptance.** Confirm backup/restore owner, rollback procedure, telemetry/alerting configuration, and representative India-region latency/load targets. The app already provides bounded privacy-safe request timing; optional SDKs need operator configuration.
8. **Kitchen/Furniture order semantics.** Notebook quotation qualification has no independent order-placement workflow. Removing Won prevents falsely recording sales, but real orders must pass through an actual supported quotation/order flow before those floors can claim complete order-entry coverage.

## Deployment

GitHub, Vercel and Railway deployment results are recorded after exact-source verification.

The Agent Teams team-composition skill coordinated independent export, frontend-performance and backend/Purchases work, followed by consolidated review and testing. Relevant UI Design responsive guidance was applied; unavailable plugin labels were treated as work areas using existing repository tools.
