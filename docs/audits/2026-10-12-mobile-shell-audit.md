# Mobile and responsive shell audit — 12 October 2026

The regular Walk-ins workspace is retained across floor changes and appears in Kitchen/Furniture navigation alongside their distinctly named legacy lead notebooks. Completed Purchases customers remain on their page when the active floor is Kitchen/Furniture, with Purchases highlighted in navigation.

## Repairs verified

- The owner's department default redirect now applies only to a settled dashboard route. A saved Kitchen workspace previously replaced a bookmarked Furniture notebook with `/walkins` before the destination could synchronize its floor. The regression now retains the bookmark and verifies every notebook read uses Furniture's floor header.
- Shared pages remain mounted when selecting another compatible floor. The canonical Walk-ins page is available to delegated workers on all four floors; the phone navigation retains a direct regular Walk-ins destination in Kitchen/Furniture.
- Phone navigation has bounded flexible columns and 44-pixel minimum targets. Long account names and More-sheet labels wrap within their rows instead of relying on a fixed row height.
- The command palette keeps focus isolation for its actual visible lifetime, including exit animation. Its previous `open` lifetime restored focus while React Native Web's Modal trap was still active, intermittently focusing the underlying backdrop. Shared overlay restoration runs after native cleanup, restores the underlying panel when necessary, and avoids detached triggers or a different overlay stack.
- Stale browser fixtures now accept the Customers filter query. The payment selection journey verifies the selected customer, scrolls to its Record Payment action, and reaches its history within the actual scroll owner.

## Verification

Builds use `EXPO_NO_DOTENV=1`, placeholder HTTPS backend URLs, and the static audit server with no API proxy. Browser journeys intercept APIs and use synthetic accounts/records. Two workers, unchanged deadlines, and zero retries are retained.

The final priority matrix passes **140 tests**, with **16 intentional viewport skips**, across Chromium widths 320, 390, 768, 1024, 1280, and 1440. It includes:

- Delegated regular Walk-ins intake and flows on each floor.
- Sanitary catalog recovery after a cancelled delayed floor response.
- Customer, Quotation, and Ground Tile active/100% completion views, including immediate Purchases customer-rail refresh after dispatch or transfer.
- Cross-floor notebook bookmarks and completed Purchases navigation.
- Phone frame dimensions, bottom navigation placement, 44-pixel navigation targets, a shorter usable viewport, long account-name wrapping, and focus restoration.
- Nested palette/quotation sheets, keyboard selection, cancellation, and rapid reopening.

TypeScript and changed-file zero-warning lint pass. All **17** deterministic history/overlay lifecycle checks pass, including restoration after native Modal cleanup and preserving destination focus when the original trigger has been removed. The mobile-UX source contract passes.

The remaining **1,602-case** matrix excludes the six priority files to avoid repeating their unchanged passes. Its final outcome and the Android Chrome/iPhone Safari/iPad Safari/desktop Firefox matrix will be recorded after completion.

## Diagnostic evidence and limits

Initial and intermediate runs were intentionally stopped when source edits or confirmed regressions required a new export. Their logs/results remain in `output/mobile-audit-*.log` and `output/playwright/mobile-audit-*-results.json`; these interrupted runs are not final acceptance. The initial baseline found the layered-focus issue, completed Purchases route redirection, and stale fixture/viewport expectations. A focused run caught the remaining palette visible-lifetime race, and the new bookmark regression proved the department-route race before both repairs were retested.

The viewport and device projects are browser emulation, not physical-device or signed-native acceptance. Shortening a browser viewport checks available-space reflow; it does not establish behavior of a real operating-system keyboard. Hermetic journeys verify application behavior and layout, not production API availability or deployment.

## Final results and production acceptance

The broader matrix finished with 1,571 passes, 19 skips and 12 failures. Eight
stale expectations were corrected, three artifact collisions were rerun in
isolated output directories, and the remaining genuine cold floor-hydration
reload race was repaired by the early startup bootstrap. Focused corrections and
artifact reruns each pass 18 cases. Startup acceptance passes 90 six-width cases,
20 device/engine cases, six repeated phone reloads and the dedicated delayed-floor
reload on all six widths and four engines. The earlier independent four-device
matrix passed 340 cases with eight intentional skips and no failures/retries.

The promoted production domain passes an independent 64-case phone/desktop
matrix. The first run had one loading-element timeout; three focused repeats and
the complete rerun pass. In the user's private authenticated session, mobile
acceptance additionally verifies the sanitary catalog, owner identity, all-floor
canonical Walk-ins, 100% Customer views and Team access/password explanations.
No real orders, passwords or permissions were changed by these UI checks.
The separately authorized cleanup removed two obsolete orphan assignment labels.

The final editor completion indicator follow-up passes all 54 completion journeys
at widths 320, 390, 768, 1024, 1280 and 1440, along with TypeScript, changed-file
lint and route budgets. Browser emulation remains distinct from physical-device
or signed native acceptance.
