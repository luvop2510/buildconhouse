# UI and floor workflow corrections — 2026-10-05

## Scope

Reviewed the prior multi-floor workflow audit (2026-09-02), the current
quotation stabilization implementation, and existing route/device acceptance
fixtures. This audit covers frontend behavior; backend media recovery and
production release operations are tracked separately.

## Confirmed defects and corrections

- **Payments document floor:** Collections can include Ground Floor orders
  while Sanitary is active. Opening or updating a document now selects its
  own floor before navigation and resolves its canonical tile/sanitary route.
  The all-floor payment history also resolves document type under the row's
  recorded floor instead of opening every document as a sanitary quotation.
- **Delayed floor access state:** A mounted screen could receive an older
  saved floor from its asynchronous initialization after another route had
  already selected the correct document floor. Both web/native hooks now use
  the latest published selection. Sanitary's quotation provider mounts only
  when floor access and the request floor are synchronized. The new browser
  regression reproduced this loading/error race before the correction.
- **Zero stock:** Inventory keeps `include_history=true` records, displays
  explicit zero-stock status, and disables transfers/quotation additions when
  transferable stock is zero. Deep links also check transferable quantity,
  preventing a fully loaned lot from seeding an unavailable line. Floor-scoped
  inventory loads now ignore stale responses and clear old-floor selections.
- **Typography:** Inter is the only text family. Removed the Fraunces loader,
  native monospace aliases and tile editor's Times/Georgia family. Browser
  interface text and native controls use shared defaults. The former native
  `Text.defaultProps` approach was replaced by typed, ref-preserving shared
  Text/TextInput wrappers; 133 import blocks were migrated. Explicit styles
  continue to win; unstyled controls choose the bundled Inter weight from
  their requested font weight. Feather remains the single icon family.
- **Image columns:** Shared product frames default to no extra inner inset;
  quotation/Purchases views use the same complete-image `contain` fit. Removed
  a remaining cropped Purchases thumbnail and tile editor's width cap so the
  image uses its designated column. Images preserve aspect ratio and use the
  existing responsive source derivatives/cache/fallback handling.

## Verification

- TypeScript and lint pass; comprehensive icon/font/import guard passes.
- Native text helper: 18 font family/weight cases pass, including preservation
  of explicit font tokens and icon families.
- Existing quotation totals/autosave (3), quotation media/layout (46),
  Purchases and mobile UX contracts pass.
- iOS, Android and web production exports succeed with bundled fonts/native
  wrappers. Native bundles are in `/tmp/buildcon-native-acceptance`.
- Full core browser audit: **880 passed, 20 intentional viewport skips, zero
  failures/flaky tests** (8.7 minutes). All 900 cases were scheduled across
  Chromium desktop, phone (390px/320px), tablet (834px/768px/1024px), Firefox
  desktop and WebKit phone profiles. Preserved report:
  `output/playwright/ui-workflows-full-results.json`. This run preceded the
  final web typography specificity correction and optional legal publication
  component added during the audit.
- Final canonical release artifact focused audit: **113 passed, 15 intentional
  tablet-specific viewport skips, zero failures/flaky tests** (1.3 minutes).
  Verified floor/image regressions, Payments forms and keyboard/error/retry
  flows, quotation/tablet control layout and full image element/frame bounds
  across all eight profiles. The new font assertion confirms actual rendered
  `Inter-SemiBold` text while Feather icons retain their own family. Report:
  `output/playwright/ui-workflows-final-focused-results.json`; screenshots and
  traces: `output/playwright/ui-final-focused`.

Subsequent stock review closed two additional asynchronous paths: callbacks
from an earlier floor cannot start a new old-floor reload, and delayed PO
matches cannot reopen a dialog or show an error in the next workspace. The
screen tracks which floor owns its loaded data, including the render before
floor-change effects clear that data. Direct-intake completion uses the same
guards. Seven deferred actual-screen hook cases pass; a negative control
without the guards fails four of them. A fresh canonical release build and
**64 browser cases across all eight profiles** pass with zero skips/failures or
flakes (`output/playwright/stock-floor-races-final-results.json`). TypeScript
and zero-warning lint pass. These checks supplement the earlier broad audit.

The final shared Text/TextInput wrapper applies Inter defaults on web/native
while explicit font tokens override them. Raw HTML body/controls retain an
Inter fallback; a broad CSS selector no longer overrides the app's explicit
Medium/SemiBold/Bold families.

## Limits

Browser device profiles and native production bundles do not prove acceptance
on physical iPhone, iPad, Android phone/tablet devices. VoiceOver/TalkBack,
physical keyboard and OS file-picker/share-sheet behavior require hardware
sessions. No live order/stock/payment data was mutated by these browser tests;
all API responses and mutations used deterministic intercepted fixtures.
