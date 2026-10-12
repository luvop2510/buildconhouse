# Quotation individual editing — 13 October 2026

Canonical implementation: root Expo SDK 55 app, `src/components/quotation/`. The nested `frontend/` tree is historical and was not changed.

## Confirmed baseline and scope

The quotation's multi-select controlled presentation-area assignment: `AreaGrouping` held a selected line-ID array, rendered checkboxes, and applied one area to all selected parents and included components through `assignAreaToLines`. Catalog brand/category/finish/color/size multi-choice filters are separate browsing controls and remain available. Tile document builders have individual additions and variant choices; no line multi-select was found there.

Before changes, two release-browser regression cases failed on desktop Chromium with mocked APIs:

1. Open an existing quotation, show the quotation tab when needed. `quotation-area-grouping` is present, violating the requested removal.
2. Add two products individually; change the existing parent quantity and presentation area; set its item discount. The parent area changes, but its included mounting part keeps its previous area even though its quantity correctly follows the parent. This would split related items into different PPT areas.

Captured baseline: `2026-10-13-quotation-baseline/browser-results.json`, `batch-panel.png`, and `individual-area-mismatch.md`. All identities/products in these artifacts are synthetic fixtures. No live writes were performed.

## Changes

- Deleted the batch-area component, its rendering/import, selected-ID state, selection controls, and context batch action.
- Retained per-product quick-add, line editing, single-line actions, room management, discount calculation, draft/save payloads, media, and export behavior. Saved quotation schemas and area fields are unchanged.
- Individual parent area edits now propagate to its catalog-controlled included parts, as quantity edits already did. Included-part area inputs show the inherited value and are read-only.
- Each `LineRow` now reads the existing memoized `lineBreakdownById` instead of recomputing every line's pricing for each mounted row. The shared calculation still governs row, room, and footer totals.
- Added `test:quotation-individual` to the mandatory frontend CI contract sequence. Added release-browser regressions matching the existing `redesign-*` audit inventory.
- The first focused browser run found a further discount editor race on narrow/mobile layouts. A newly interactive input was still empty when `fill('20')` selected its contents; passive initialization inserted the existing `10` before the typing event, resulting in `1020`, clamped to 100%. Trace records show the initial empty input and the persisted 100% value. Discount fields now initialize in a layout effect before interaction; the regression verifies the typed value before applying. This preserves the existing discount rules and does not introduce a delay/retry into the test.

## Performance evidence

`node scripts/test-quotation-individual.mjs --benchmark` compares the old per-row full calculation/find pattern with the indexed calculation used by the updated rows, on the same 500 synthetic lines, four rooms, category discounts and flat room discounts, nine samples per approach after warmup. It checks identical net totals before measuring.

Recorded median: **28.726 ms before, 0.132 ms after (217.5×)**. Full timing range and dataset are in `2026-10-13-quotation-pricing-benchmark.txt`. This measures pricing calculations on the development Mac, not browser paint, navigation time or physical-device response. It establishes the removed quadratic calculation pattern without attributing unrelated application freezes to quotations.

## Verification

TypeScript and focused zero-warning ESLint pass. Existing quotation media (46 assertions), concealed-part, totals/autosave, and ordering contract scripts pass. New contract checks product/category/project discount precedence, flat-room allocation and caps, row/footer consistency, and removal of the repeated row calculation and batch API.

The first focused release-browser run produced 54 passes, seven intentional skips and three failures (the newly discovered discount initialization race on phone, small phone and tablet landscape). Existing ordering and export cases passed. Evidence: `2026-10-13-quotation-browser-first.json`, and `2026-10-13-quotation-discount-race/trace.zip` / `error-context.md` / compact `events.json`. Snapshots confirm the intermediate input value was exactly `1020`.

After the discount fix and a fresh production web export, the same focused inventory passes **57 cases with seven intentional skips, zero failures/flakes**, two workers, unchanged deadlines, no retries. All **16 new individual-editing cases pass** across eight projects:

| Browser | Viewport | New individual-edit cases |
| --- | --- | --- |
| Chromium | 320×740 | 2 passed |
| Chromium | 390×844 | 2 passed |
| Chromium | 768×1024 | 2 passed |
| Chromium | 834×1112 | 2 passed |
| Chromium | 1024×768 | 2 passed |
| Chromium | 1440×1000 | 2 passed |
| Firefox | 1440×1000 | 2 passed |
| WebKit | 390×844 | 2 passed |

Coverage includes removal of selection/batch controls, reopening previously saved areas, individual product additions, quantity and item discount edits, included-part synchronization/read-only fields, actual autosave payloads and reload, correct live totals and page-overflow checks. Surrounding cases preserve category/room drag ordering, hidden/collapsed records, touch ordering/Escape cancellation, keyboard/tap movement, tablet picker capacity, and floor-scoped PDF/PPTX downloads. The seven existing skips are five tablet-only picker tests outside tablet widths and two Chromium-CDP touch tests in Firefox/WebKit; those engines retain mouse ordering and download coverage.

Final results: `2026-10-13-quotation-browser-final.json`; raw reporter output: `2026-10-13-quotation-browser-final.log`.

Browser APIs are intercepted, including autosave; no production quotation is modified. Physical devices, signing and production deployment are outside this local verification.
