# BuildCon House — mobile showroom redesign

Local implementation, September 2026. The canonical root Expo application was changed; nested legacy checkouts, backend contracts, databases and production deployments were excluded.

## Original problems

The audit found competing component systems and sheet implementations, clipped phone headers, compressed tablet titles, summary cards preceding the actual work, excessively tall mobile table records, ambiguous navigation, and requests represented as empty data or indefinite loading. Shared controls lacked consistent labels, keyboard behavior, focus handling and recovery feedback. The original 231 browser checks passed despite visible layout defects and mostly exercised unavailable data.

## Design system and architecture

The application retains BuildCon imagery and identity, Feather icons, #0066CC actions, system web fonts and packaged Inter on native. The common system uses a porcelain canvas, white surfaces, graphite text, restrained semantic colors, a 4px spacing scale, 16/24/32px gutters, 8px controls, 12px grouped surfaces and 16px overlays. Page titles use 24/32px on phones and 28/36px on larger screens. Currency precision and tabular numerals remain intact.

`src/design` now owns focused typography, controls, forms, surfaces, navigation, feedback, overlays and page headers. The previous component monolith is a barrel; existing UI, DS, bottom-sheet and tile APIs adapt to it. This avoids changing page business contracts. The system retains the existing 768/1024/1366 viewport breakpoints and the quotation builder's separate measured-container calculations.

Common buttons have predictable variants, wrapping labels and minimum 44px targets. Fields associate labels and helper/errors, use 16px inputs, and expose invalid states. Tabs support arrows and Home/End with selected semantics; menus support keyboard selection and focus restoration. Overlay boundaries support mobile sheets/fullscreen editors, bounded child scrolling, safe areas, Escape, focus containment/restoration and nested background isolation. Reduced-motion preferences govern the migrated animations. Connection feedback never replays a write.

## Navigation and flows

The route registry supplies consistent labels and destinations to the sidebar, tablet rail, phone navigation and command search. Existing access restrictions remain in the permission helpers. Desktop destinations are grouped into daily work, records/operations and management. Phones expose Today, Catalog, department-appropriate Quotations, Follow-ups and More; kitchen/furniture retain Walk-ins and Quotation follow-up. The ambiguous central Action control is removed. Department context remains visible. Fully paid orders is deliberately distinct from payment history.

Optional summaries and secondary intake details are collapsed while their parent-owned values remain intact. Failed requests expose recovery rather than inventing empty results or zero metrics. Quotation draft recovery is now reachable: a salesperson explicitly restores or discards the account-and-department-scoped local draft. Newer server versions recover as a separate draft, and verification failures preserve the local copy. Order confirmation failures retain supplier choices and notes. Failed payments retain exact amounts. Failed tile movement and release forms retain quantities and transport details. PDF failures report download failure separately from successful business mutations.

## Route families

| Routes | Implemented improvements |
| --- | --- |
| `/`, `/login`, `/set-new-password`, `/privacy`, `/terms` | Existing entry redirects retained; staff/customer semantic forms, keyboard tabs, password controls, persistent validation, calm authentication layout, readable semantic legal content. |
| `/dashboard`, `/notifications`, `/followup-assignments` | Shared adaptive hierarchy; actionable queues first, compact partial-failure feedback, unavailable metrics distinguished from zero; notifications link to their source record; assignments retain ownership/status behavior. |
| `/followups` | Queue/search precede optional summary; clear Today/Overdue controls, consolidated filters, explicit unavailable state, preserved bounded paging and partial bulk retry behavior. |
| `/walkins`, `/walkins/new`, `/walkins/[id]` | Optional summary, separate summary/list failures, intake essentials before optional details, duplicate resolution retained, options and save failures recover visibly, record loading exits into retry. |
| `/customers`, `/customers/new`, `/customers/[id]`, `/customers/[id]/edit` | Reused headers/forms/tabs, optional summary and intake details, prominent save, persistent save failures, related-record availability feedback; existing customer/portal business fields retained. |
| `/catalog`, `/catalog/[id]`, `/catalog/import` | Shared navigation, controls and overlays; existing image-led product content, family/variant search and import extraction/review stages retained; catalogue picker failures have retry, promotional implementation copy removed from import. |
| `/quotations`, `/quotations/new`, `/quotations/[id]`, `/quotations/[id]/place-order` | Document hierarchy and adaptive headers; reference/product recovery, nested selection overlays, explicit local-draft recovery, complete order-review loading/error states and persistent multi-brand confirmation recovery. Existing totals/autosave contracts retained. |
| `/purchases`, `/purchase-orders/[id]` | Phone width/clipping fix, shared controls/menus, honest unavailable state, unsupported Returned metric removed; operational data and actions retained. |
| `/tiles`, `/tiles/selection`, `/tiles/quotation` | Consistent list header and customer/document search; compact mobile document metadata, product entry earlier with no blank image frame before selection, transport fee beside totals; failed saves have explicit retry; product selection uses common overlays. Desktop paper editing/PDF content and unit calculations remain intact. |
| `/tiles/orders`, `/tiles/orders/[id]`, `/tiles/orders/brands/[brandId]`, `/tiles/orders/po/[poId]` | Common operational headers/tabs/tables, concise two-column mobile metadata, keyboard table rows, preserved pagination; accessible quantity/availability fields and persistent release/move/dispatch recovery with retained split quantities. |
| `/payments`, `/payments-list` | Collections before optional summary, clearer master/detail selection, independent request failures, persistent payment errors, labelled inputs, fully-paid/empty-search distinction and bounded pagination. Removed a nonfunctional placeholder export control; the working history export remains. |
| `/notebook/[floor]`, quotation follow-up and legacy view routes | Consistent Walk-ins navigation and shared entry sheets, persistent errors for edits/conversion/outcomes, explicit loading failure and retry. Stable floor IDs and concurrency tokens retained. |
| Every `/sales-data` route | Shared section navigation and mobile selector, responsive period/department controls, preserved working sections on partial failure. Brand and person drilldowns retain period/floor context and recover explicitly. Existing report-specific calculations and content retained. |
| `/team`, `/settings`, all `/settings-*` | Grouped organization/security/access/system destinations, consistent reading-width pages and breadcrumbs, saved/dirty/discard feedback, unavailable team/access/options states and safe empty permission modules; existing sessions and destructive confirmations retained. |
| `/home`, `/quotes`, `/quotes/[id]` | Calm customer workspace, searchable shared documents, readable totals/items/revisions/brands; PDF download failures become visible and retryable for latest/revision/brand actions. Portal stays read-only. |
| `/reports`, `/purchase-orders`, notebook compatibility URLs | Existing destinations retained and browser-tested; no URL migrations. |

Some routes receive the redesign through shared foundations and retain their existing page-specific layouts. This is an incremental consolidation, not a claim that every legacy style or overlay has been eliminated.

## Verification interpretation

The route/state report and preserved browser reporter logs distinguish route smoke coverage from stateful workflows. All browser APIs are intercepted with isolated synthetic fixtures; the local server never proxies requests to a real backend. Route screenshots cover service-unavailable/static states plus selected populated workflows. Passing fixtures demonstrate frontend contracts, not production data correctness or device certification.

Tests cover restricted profiles, entry/deep-link redirects, forced password change and expiry; customer intake recovery and walk-in duplicates; quotation selection and draft restoration; multi-brand order retry; follow-up partial bulk failures; tile paging, split releases, moves and dispatch validation; payment precision; notebook conversion tokens; report drilldowns; settings recovery; and all customer PDF variants. Shared tests exercise keyboard tabs/menus, nested overlay isolation, Escape/focus restoration, reduced motion and offline feedback without mutation replay.

The final validation commands and results are recorded in `validation.md`; every canonical route is enumerated in `route-coverage.md`. Screenshots and the comparison gallery are under `output/playwright/redesign-after` and `output/playwright/redesign-gallery.html`.

## Remaining limits and follow-up

- No live backend, production deployment, financial/order mutation, or real customer-data verification was performed. Real authentication/session integration, supplier import processing and external messaging require an isolated integration environment.
- Native simulator verification was unavailable (`xcrun simctl` could not run). Physical iOS/Android keyboards, safe areas, native file sharing and screen-reader behavior require device review. Browser WebKit is not an iOS-device test.
- Core semantic text color pairs pass AA, and keyboard/focus paths are tested. A complete WCAG 2.2 AA certification, screen-reader audit, every local color pair, browser zoom configuration and localization scenario is not established by these checks.
- Every route has browser smoke coverage; not every data state, permission combination, import stage, purchase-transfer branch or dispatch completion has a stateful end-to-end fixture. Those remaining branches retain existing code and contracts and need broader backend-integrated acceptance tests.
- Legacy compatibility exports and some page-local styles remain intentionally. No new large dependency was added. Full elimination of legacy styling would need further call-site and native review.
