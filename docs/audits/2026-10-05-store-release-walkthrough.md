# BuildCon House release walkthrough — 5 October 2026

## Release assessment

This pass fixes confirmed performance, image-selection, order-status and export bugs. The web/backend changes are deployed and have passed focused hosted verification. Store submission remains a separate acceptance step. Signed binaries, physical-device certification and operator legal/store facts are not available from this workspace; they remain explicit release requirements.

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
| Web deployment and startup | A page must load JavaScript from a coherent build; static pages need their configured security headers. | Live checks found Vercel's compiled routing put high-level headers after filesystem/catch-all routes. Header rules now run first; HTML is no-store, fingerprinted assets immutable and missing assets return 404 instead of successful HTML. A small synchronous recovery script retries failed startup once per entry/path and provides an accessible reload action when retry fails. It preserves mounted/interactive UI and excludes API or external script errors. A read-only release verifier checks actual headers, referenced JavaScript MIME, missing assets and API health/auth. |
| Collections, access, operations and public pages | Review existing payment, shortage, transfer, permission, retry, form and responsive paths. | Covered by the consolidated existing regression suite. Additional findings are recorded below if present. |

## Measured performance evidence

The controlled 2,600-product/500-line quantity fixture preserves exact output parity: approximately 15–34 ms for repeated scanning versus 1–2 ms for indexed lookup on this host (11–19× across representative runs). This is a CPU hot-path measurement, not an end-to-end tablet speed claim.

The canonical app uses Feather icons, but barrel imports included all 19 icon font families. Replaced 75 imports with the public Feather entry point; Expo Go loads only that icon font. Inter/Fraunces typography remains unchanged. Actual final production-export measurements:

| Initial web route JavaScript (gzip KB) | Before import cleanup | After | Reduction |
| --- | ---: | ---: | ---: |
| Login | 521 | 388 | 26% |
| Dashboard | 532 | 399 | 25% |
| Purchases | 545 | 412 | 24% |
| Follow-ups | 546 | 412 | 25% |
| Tile Orders | 538 | 404 | 25% |

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

- Browser audit: **840 passed, 20 intentionally skipped, zero failures/flakes**, 8.4 minutes. Eight profiles cover 320/390 px phones, 768/834 px tablets, 1024 px tablet landscape, 1440 px desktop, Firefox and WebKit. Skips apply only to tablet-specific checks outside their target viewport. New tile-image, long-notebook, confirmed-order and PDF/PPT download journeys pass across all eight profiles.
- Backend unit suite: **1,504 passed**, six dependency deprecation warnings. Unused legacy Chalan notification mocks were removed while outbox notification assertions remain.
- All 15 original required frontend contract commands passed, plus the new startup-recovery event/injection contract, Tile Orders route contract and palette contrast checks.
- Startup recovery: VM/event/injection contract and 16 controlled missing-entry/repeated-failure browser cases passed. Recovery is limited to an untouched loading shell; interactive or mounted screens are preserved.
- TypeScript, zero-warning lint and Expo Doctor **18/18** passed.
- Production web export and all eight initial JavaScript budgets passed; iOS and Android Hermes exports passed.
- Changed backend runtime-module lint, compilation and diff whitespace checks passed; production Python dependencies have no reported audit vulnerabilities.
- GitHub backend job after installing Poppler: **1,504 passed**, no raster-test skips; production dependency audit, compilation and Docker build passed. The earlier runner omitted Poppler and skipped seven PDF visual regressions, which are now enabled in both CI and predeploy.

An overnight browser run was interrupted by macOS sleep/dark-wake cycles and was discarded as invalid timing evidence. The consolidated rerun keeps the host awake for the test command; its results above supersede that interrupted run.

The optional frontend drift script is unconfigured: no operator-reviewed external route baseline is supplied. It was reported as unavailable rather than initialized from the changed code to manufacture a pass. The existing npm security gate remains failing for the disclosed upstream advisories.

Browser tests run the production export with intercepted synthetic API data and do not modify real business data. Generated document fixtures exercise the real rendering engines. These checks do not prove absence of all bugs, production load capacity or native-device behavior.

The first focused hosted audit passed 64 cases, skipped five tablet-specific cases and failed three startup/download cases. Traces establish deployment version rollover: a page navigation began 157 ms before an automatic Git deployment replaced the canonical alias; requests for old chunks then received successful HTML from the SPA fallback. The old chunks remained valid on their immutable deployment. The corrected header/asset routing passed live read-only verification on its immutable deployment (15 page/asset/API probes). After the startup recovery and routing fixes, focused hosted acceptance on the settled immutable deployment passed **83 cases, five intentional tablet-only skips, zero failures/flakes** in 2.4 minutes across all eight profiles. These checks include the one-room PPT/PDF downloads, removed Won actions, tile images, long notebook virtualization and recovery from a missing entry script. All API requests in those browser tests are intercepted. The final read-only production verifier passed **16 page/asset/API probes**, including the recovery script’s no-store caching.

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

Runtime changes were pushed to remote `main` in commit `dfebcac4f41b411c959e7846bd9c239e9e7e3384`. Railway deployment `c8d3942d-defe-4082-8208-cd82e1b5bd8b` is SUCCESS and pins that backend source. Public health/readiness return 200/ok, protected quotations return 401 without credentials. The backend runtime is unchanged by subsequent CI, web-hosting and audit-document changes.

Vercel's Git integration is active: source pushes deploy automatically. The first manual production deployment and simultaneous Git deployments caused the observed alias rollover; subsequent web-hosting changes deploy through Git only. Header fix commit `6095086060c24ad1e28046ea1d1ae63ecf0f1c93` reached READY in deployment `dpl_5w71Nd1VFUSspSqkCJmBzswgqETQ` and passed the read-only checks above. Startup-recovery commit `cc610f2034ebf551390e8f0bd136a392bda567c2` reached READY in deployment `dpl_Ac53a2HMAGbT4RbEac3e7q3f4Ev9`. Its immutable URL is `https://buildcon-house-19nr0r14c-yug19.vercel.app`, and it owns the canonical `https://buildcon-house-nine.vercel.app` alias at verification. The final audit-document push may produce another Git deployment with the same runtime source; the release chat records that final deployment verification.

Eight readiness samples per host all returned 200. Warm median from this host was 1,401 ms direct Railway / 1,113 ms through Vercel, versus 823 / 908 ms earlier; these variable samples do not establish a backend latency improvement or an India-region SLO. Upstream `Server-Timing` is now present through Vercel. Geographic/database latency and real load remain operational acceptance items.

GitHub frontend CI fails at the unchanged npm advisory gate; later frontend steps are consequently skipped in that remote job. Their local final verification is listed above. The gate was not disabled or expanded to hide the new blocking advisories.

The Agent Teams team-composition skill coordinated independent export, frontend-performance and backend/Purchases work, followed by consolidated review and testing. Relevant UI Design responsive guidance was applied; unavailable plugin labels were treated as work areas using existing repository tools.
