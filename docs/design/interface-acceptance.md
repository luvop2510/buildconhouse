# Buildcon House interface acceptance

This is the reusable checklist for every floor, page and account viewpoint. It is a design contract, not a claim that every item has passed. A release report must identify the actual revision, changed surfaces, executed checks and remaining limits. [The canonical interface system](../../src/design/README.md) and `src/design/tokens.ts` own visual decisions; this document owns acceptance questions. [Performance policy](../deployment/performance-policy.md) owns enforced timing and release gates.

## Product thesis and priorities

Buildcon House helps a showroom team move a customer's work from selection to completion without losing responsibility, documents or money. Today answers “What needs attention on this floor now?” A department employee needs a work queue; a floor-wide account needs that queue and the floor's operational/financial position; the owner additionally needs company sales analysis. Different jobs share controls and visual language, not identical content.

The signature is the floor's working handoff: recognizable customer, next action, responsible person and recorded progress together. Use showroom terms such as quotation, selection, PO Final, In Box, dispatch and installation. Do not replace useful context with ornamental KPI cards, greetings, slogans or generic “performance” scores.

## Viewpoint matrix

| Viewpoint | First useful content | Money / analytics | Boundary to verify |
| --- | --- | --- | --- |
| Department-limited employee | Permitted task list, schedule and recorded progress | No Today financial summary or Sales Data | Server reads and direct URLs honor departments and floor |
| All departments on one floor | Floor work, schedule, progress and floor summary | That floor's payments and balances; no owner Sales Data | Counts, details, exports and links stay on that floor |
| Several explicitly assigned floors | Selected authorized floor's work | Selected floor's permitted payments | Switching clears previous scope before replacement data appears |
| Owner, floor Today | Selected floor work and next actions | Selected floor financial context; explicit Sales Data navigation | Today retains its operational purpose |
| Owner, company Sales Data | Confirmed sales, date basis, primary trend and supporting records | Company INR; Furniture RNB in its own ledger | Drafts and supplier POs excluded; totals reconcile to source |
| Owner, floor Sales Data | Floor trend and meaningful entities | Selected floor and currency | No 100% self-contribution donut or cross-floor comparison |
| Revoked / unavailable access | Clear access explanation and usable permitted navigation | No previous privileged values | No protected background reads, retained cache or stale responses |

Treat hidden navigation as presentation. API authorization is the security boundary. Empty results never broaden permissions. A list, total, chart, export and drilldown referring to one scope must apply the same scope.

## Page family matrix

These are acceptance surfaces, not a request to add removed pages or controls. New routes must adopt the relevant family and enter route discovery automatically.

| Family / current surfaces | Primary job | Composition and states |
| --- | --- | --- |
| Today, `app/(admin)/dashboard.tsx` | Find and open due work | Work first; optional floor summary beside it on wide screens; no mandatory sales chart |
| Sales Data, `src/components/salesAnalytics/` | Explain confirmed sales and inspect evidence | Compact KPI group, one primary trend, relevant comparisons, source rows; owner-only |
| Sanitary quotations / walk-ins | Prepare accurate customer selection and next contact | Customer identity, editable items/task, one primary action; preserve local and saved drafts |
| Ground selection / quotation / orders | Select, quote, place and dispatch | Measured editor width; details near decisions; bounded order table; no unrelated supplier reads |
| Kitchen hub / stages / project detail | Locate project and finish current stage | Nine hub totals; compact stage form; one project identity; version-bound documents and explicit decisions |
| Furniture notebook / quotations | Track work and its currency ledger | Shared controls and type; explicit RNB/INR context; never combine currencies |
| Purchases / godown / dispatch | Find blocked or available material and perform next action | Bounded lists with status text, quantities and source/history; honest unknown quantity/price |
| Payments / payment history | Understand balances and record a deliberate payment | Complete amount, currency, customer and evidence; success/error remains attached to operation |
| Customers / references / catalog | Find a specific person or product | Search early, bounded page, stable identity, meaningful empty result and exact detail link |
| Team / access / settings | Assign responsibility or change a policy | Grouped labelled controls; visible scope; retain validation and permission boundaries |
| Dialog / sheet / export / PDF | Complete one secondary task | Obvious dismissal, focus restoration, progress and explicit retry; usable source page remains |

## Shared visual checklist

- [ ] Import canonical type/color/spacing roles; no new palette, font download or page-local visual system.
- [ ] Use the platform system font throughout, with tabular numbers for amounts/counts. Apple uses its system face through `System` / `-apple-system`.
- [ ] Use the established 12/14/16/18–20/24/28 scale by role. Essential values wrap or switch to one column rather than shrinking to fit.
- [ ] Use regular body, medium labels and semibold headings. Do not use a bold eyebrow above every panel or thin small labels.
- [ ] Use Feather outline icons at consistent 16/18/20 sizes. Decorative icons are hidden from accessibility; icon controls have names and selected/expanded state.
- [ ] Keep blue actions, selected navigation and data/focus accents with white surfaces, black/graphite text and a cool neutral canvas. Status color always has a word or meaningful icon.
- [ ] Keep 4/8px spacing, 16px phone gutters and shared regular gutters. Related controls align; equal metrics have equal padding.
- [ ] Use 12px panel / 8px control radii from the contract. Quiet borders separate resting panels; shadows belong to floating overlays.
- [ ] Remove accessory surfaces: no tinted icon squares, glow, gradient chart decoration, nested card around every row or fabricated delta.
- [ ] Labels describe the next action. Dates use India calendar boundaries; money uses Indian grouping and an explicit currency where ambiguous.

Measured foreground contrast against white: primary `#1D1D1F` 16.83:1; secondary `#545458` 7.54:1; supporting `#626267` 6.07:1; blue `#0066CC` 5.57:1. Canonical success/warning/risk text colors are 5.69:1 / 5.88:1 / 5.46:1 on white. These are calculated token pairs, not screenshot estimates. Measure text on tinted fills, disabled controls and composed overlays separately. The current application theme is light; do not advertise dark mode until all semantic pairs and rendered states are verified.

## Layout, boxes and navigation

- [ ] The first screen shows the title, scope and primary task/answer. Work does not sit below unrelated charts.
- [ ] At regular widths, use a bento grid only when different panel spans express importance. A large work queue may sit beside a smaller operational summary; the grid is not a requirement to add more cards.
- [ ] Align panel edges and gaps. Avoid making a flat/empty chart consume the entire viewport or filling a grid with duplicated information.
- [ ] On phones, stack in task reading order. Two-up compact counts are allowed while complete labels and values fit; no fixed minimum card width causes overflow.
- [ ] `responsive.ts` remains the breakpoint authority (768 / 1024 / 1366). The actual content width decides editor columns and overflow.
- [ ] One page owns vertical scrolling. Only a table with meaningful columns gets its own bounded horizontal region.
- [ ] Sidebar displays the product/floor scope, stable destination labels and a clear blue selected state. Keep no more than two visible hierarchy levels; preserve labelled mobile navigation.
- [ ] Sidebar icons use the same family and optical alignment. Primary page actions belong with the task, not hidden at the sidebar bottom.
- [ ] Existing route/deep-link/back behavior remains valid, including legacy redirects. A floor change cannot leave a detail link aimed at the previous floor.
- [ ] Compact/tablet/desktop navigation offers the same permitted functions without repeated navigation structures.

Suggested Today composition, adapted to available space:

```text
Regular                               Compact
[Today · selected floor     Refresh]   [Today · selected floor   Refresh]
[work/schedule summary             ]   [task counts that fit            ]
[primary task queue   ][floor      ]   [schedule and primary task queue ]
[customer / next step ][summary*   ]   [progress and source links       ]
[progress / open task ][payments*  ]   [floor summary and payments*     ]
* only when the account can view every department on this floor
```

This structure is specific to showroom handoffs. It avoids the generic KPI/trend/donut template on a screen whose job is completing work. Sales analysis keeps its own composition.

## Charts, KPIs and honest progress

- [ ] Every chart answers a named question. A short labelled list is preferable when no visual relationship needs explanation.
- [ ] KPI value, chart, filter caption and supporting rows derive from the same response model. Comparable growth names its baseline and remains unavailable when historical inputs are absent.
- [ ] A bar chart comparing magnitude starts at zero, shares a scale for comparable values and shows exact readable labels/units. Never draw RNB and INR amounts on one scale.
- [ ] Omit a one-floor contribution donut or business-unit comparison. A zero dataset retains its honest zero state, not an artificial visible bar.
- [ ] Trends preserve missing-value gaps and display the real selected period/granularity. Current/previous periods use consistent marks and labels.
- [ ] Use one main data hue with neutral comparisons; color is never the only series identifier. Faint gridlines stay subordinate to data.
- [ ] Provide tap/keyboard exploration and readable chart data/source rows. A hover-only tooltip is insufficient.
- [ ] Legend is near the chart when needed. A single directly named series does not need a duplicate legend.
- [ ] Progress uses a recorded numerator and denominator for the same population/time basis. Historical completed contacts are not a completion percentage of today's open work.
- [ ] Task rows expose the customer, due time/date, next action, responsibility and actual state where recorded. Unassigned or undated stays explicit.
- [ ] Chart animation never delays the values. Reduced motion presents the final state immediately.

Preserve useful existing `SalesTrend` behavior: missing-data gaps, common zero baseline, previous-period marks, previous/next date controls, source links and the chart data alternative. Improve hierarchy without replacing these with a static illustration.

## Loading, reliability and a snappy feel

- [ ] Shell, page title and usable controls appear immediately. Reserve the main content's space with a matching placeholder; never show fabricated zero while loading.
- [ ] Primary work publishes as soon as available. Optional history, reference metadata, analytics or payment summaries cannot hold the work queue behind `Promise.all`.
- [ ] Each independent section has loading, empty, error/retry and successful populated states. One section failure leaves successful sections usable.
- [ ] Refresh preserves valid current-scope content with a visible updating state. A floor/account change immediately removes old-scope values.
- [ ] Cancel or reject obsolete responses by floor, actor, filters and request generation. Include these identities in any read cache key.
- [ ] Use existing bounded read coalescing; invalidate affected reads after writes. Do not cache permissions, balances or mutable stock to conceal a slow request.
- [ ] Bound list rendering and API pages. Do not load a whole catalog or history for each visible card; profile before adding memoization or virtualization machinery.
- [ ] Buttons give immediate press feedback and prevent duplicate writes. Explicit retry preserves submitted identity and in-flight drafts.
- [ ] Saving, uploading, verifying and failed states describe the actual operation; “Saved” requires acknowledged displayed values.
- [ ] Rotation, keyboard open/close, navigation and retry preserve edits and focused node where required. No layout-changing hover or repeated screen remount.

Use existing enforced ceilings, rather than declaring unmeasured gains: first useful content under 2.5s with a 200ms API fixture; search under 1.5s; repeated cached catalog visits under 750ms; initial JavaScript at most 576KiB gzip per exported route; no blocking task of 500ms or longer in the stress scenario. See the performance policy for exact scenarios. Press feedback within 100ms is a design target to measure, not a result claimed by this checklist. Production p50/p95 and `Server-Timing` are separate evidence from fixture rendering.

## Accessibility and responsive acceptance

- [ ] Verify 320px/375px compact, tablet and desktop widths, plus landscape and enlarged text. No page-level overflow, hidden action, clipped currency or essential truncation.
- [ ] Keep 44–48px comfortable interactive regions and at least 8px adjacent gaps. Visible glyph size is not the hit area.
- [ ] Text meets 4.5:1; large text and meaningful graphics meet applicable 3:1 requirements. Measure actual foreground/background pairs.
- [ ] Keyboard can reach and operate task rows, filters, chart controls, menus, table columns and dialogs. Focus is visible and unobscured.
- [ ] Screen-reader order follows visual order. Headings, field labels, selected/expanded/disabled states and errors are meaningful.
- [ ] Fields keep visible labels; related validation remains inline. Error recovery retains entered values and names the corrective action.
- [ ] Sheets restore focus and provide a visible close/back route. Pointer hover is supplemental, never the only disclosure.
- [ ] Reduced motion and zoom/text scaling work. Existing web/mobile primitives implement the principles; macOS menu bars and SwiftUI materials are not requirements for the web app.

## Verification without repeated unrelated work

1. Read this contract and the changed page family; state which role/floor and data shape changed. Reuse existing source knowledge instead of rediscovering unrelated workflows.
2. Run `node scripts/check-affected.mjs` to inspect the selected contracts, then `node scripts/check-affected.mjs --run` for focused development feedback. Add `--base origin/main` when including committed changes. Successful local input-digest reuse is an iteration aid; `--force` reruns selected checks.
3. Verify changed populated/empty/error/race paths. A shared token, navigation or authorization change expands the affected viewpoints. A copy-only change does not justify rebuilding unrelated workflow fixtures on every iteration.
4. Inspect the changed rendered surface at compact, tablet and desktop sizes. Record exact revision, viewport, role/floor and state; never use a screenshot from an older source as proof.
5. Run the unchanged full `npm run test:performance:audit` once the integrated source is final. Fix a failure and rerun the affected failing checks while iterating; required final release coverage must still pass. Do not remove tests, loosen budgets, add retries or reuse old release evidence to save tokens.
6. Before production promotion, verify current remote-main ancestry and actual deployed frontend/backend revision. Run authorized hosted journeys and public/direct API health timing. Report provider or access blockers explicitly.

Each completion report should state: changed behavior, root cause, passed evidence, measured performance result (or an explicit absence of production measurement), deployment identities, and remaining limitations. No checklist can certify “perfect forever”; shared contracts plus focused development checks and a final release gate prevent known drift from silently recurring.

## Reference review and decisions

The user's [Salesly Framer reference](https://salesly.framer.website/) is a marketing template. Its saved capture is `outputs/redesign-investigation/reference/salesly.html` in the parent workspace, titled “Salesly – Modern Sales & CRM Framer Template”; the accompanying `salesly-main.mjs` contains its generated site runtime. The useful ideas are coherent alignment, restrained white surfaces, compact text hierarchy and grouping. Reuse these principles through existing primitives. Do not ship its marketing runtime, font payloads, demo statistics or ornamental sections into the ERP. The latest user direction restores the original blue accent while retaining the current system-font/neutral foundation. Live web extraction was unavailable during this audit, so no claim of inspecting its latest published revision is made.

The requested Taste app-screen draw selected **achromatic ledger** for long operational sessions and money clarity, retaining the neutral surfaces/type. The latest user direction restores blue actions and accents. The generated no-sidebar shell was rejected because this ERP has many established destinations and floor navigation. The existing labelled adaptive shell remains. This is an explicit product constraint, not a reason to add another navigation variant. The first UI/UX Pro Max design-system match returned a marketing hero and an unrelated green/red palette; focused product searches returned no verified ERP match, so those suggestions were not persisted. Its React Native loading/list guidance and the supplied accessibility checklist apply where they fit the current stack.

Apple references read for this audit: accessibility, layout, typography, color, designing for iOS, sidebars, charting data, loading, icons and the skill's cross-platform translation. Native principles are translated to Expo / React Native Web; the result is not Apple certification. Selected foundations:

- `layout.md › Visual hierarchy`: “Order content by relative importance.” This puts work before analytics on Today. [Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- `typography.md › Conveying hierarchy`: “Minimize the number of typefaces you use.” This preserves one system face. [Apple Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- `icons.md › Best practices`: “Maintain visual consistency across all interface icons in your app.” This preserves Feather across floors. [Apple Icons](https://developer.apple.com/design/human-interface-guidelines/icons)
- `charting-data.md › Best practices`: “Keep a chart simple, letting people choose when they want additional details.” This favors meaningful charts and source drilldowns. [Apple Charting data](https://developer.apple.com/design/human-interface-guidelines/charting-data)
- `loading.md › Best practices`: “Show something as soon as possible.” This supports independently published sections. [Apple Loading](https://developer.apple.com/design/human-interface-guidelines/loading)

The specific bento spans, white/graphite foundation with blue accents and showroom handoff signature are product design judgments. Their acceptance depends on rendered evidence and usefulness, not a template name.
