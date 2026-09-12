# Canonical route coverage

Browser fixtures only. Route smoke checks use unavailable services or existing static content, check runtime errors and viewport overflow, and capture settled screens. Stateful coverage is listed separately; passing a route does not establish every business branch.

| Route file | URL exercised | Desktop 1440 | Tablet 834 | Phone 390 |
| --- | --- | --- | --- | --- |
| `app/(admin)/catalog/[id].tsx` | `/catalog/audit-record` | passed | passed | passed |
| `app/(admin)/catalog/import.tsx` | `/catalog/import` | passed | passed | passed |
| `app/(admin)/catalog/index.tsx` | `/catalog` | passed | passed | passed |
| `app/(admin)/customers/[id]/edit.tsx` | `/customers/audit-record/edit` | passed | passed | passed |
| `app/(admin)/customers/[id].tsx` | `/customers/audit-record` | passed | passed | passed |
| `app/(admin)/customers/index.tsx` | `/customers` | passed | passed | passed |
| `app/(admin)/customers/new.tsx` | `/customers/new` | passed | passed | passed |
| `app/(admin)/dashboard.tsx` | `/dashboard` | passed | passed | passed |
| `app/(admin)/followup-assignments.tsx` | `/followup-assignments` | passed | passed | passed |
| `app/(admin)/followups.tsx` | `/followups` | passed | passed | passed |
| `app/(admin)/notebook/[floor]/[view].tsx` | `/notebook/kitchen/followups` | passed | passed | passed |
| `app/(admin)/notebook/[floor]/quotation-follow-up.tsx` | `/notebook/kitchen/quotation-follow-up` | passed | passed | passed |
| `app/(admin)/notebook/[floor].tsx` | `/notebook/kitchen` | passed | passed | passed |
| `app/(admin)/notifications.tsx` | `/notifications` | passed | passed | passed |
| `app/(admin)/payments-list.tsx` | `/payments-list` | passed | passed | passed |
| `app/(admin)/payments.tsx` | `/payments` | passed | passed | passed |
| `app/(admin)/purchase-orders/[id].tsx` | `/purchase-orders/audit-record` | passed | passed | passed |
| `app/(admin)/purchase-orders/index.tsx` | `/purchase-orders` | passed | passed | passed |
| `app/(admin)/purchases.tsx` | `/purchases` | passed | passed | passed |
| `app/(admin)/quotations/[id]/index.tsx` | `/quotations/audit-record` | passed | passed | passed |
| `app/(admin)/quotations/[id]/place-order.tsx` | `/quotations/audit-record/place-order` | passed | passed | passed |
| `app/(admin)/quotations/index.tsx` | `/quotations` | passed | passed | passed |
| `app/(admin)/quotations/new.tsx` | `/quotations/new` | passed | passed | passed |
| `app/(admin)/reports.tsx` | `/reports` | passed | passed | passed |
| `app/(admin)/sales-data/brand/[id].tsx` | `/sales-data/brand/audit-record` | passed | passed | passed |
| `app/(admin)/sales-data/brands/[id].tsx` | `/sales-data/brands/audit-record` | passed | passed | passed |
| `app/(admin)/sales-data/brands.tsx` | `/sales-data/brands` | passed | passed | passed |
| `app/(admin)/sales-data/collections.tsx` | `/sales-data/collections` | passed | passed | passed |
| `app/(admin)/sales-data/customers.tsx` | `/sales-data/customers` | passed | passed | passed |
| `app/(admin)/sales-data/executive.tsx` | `/sales-data/executive` | passed | passed | passed |
| `app/(admin)/sales-data/forecasting.tsx` | `/sales-data/forecasting` | passed | passed | passed |
| `app/(admin)/sales-data/index.tsx` | `/sales-data` | passed | passed | passed |
| `app/(admin)/sales-data/operations.tsx` | `/sales-data/operations` | passed | passed | passed |
| `app/(admin)/sales-data/people/[kind]/[id].tsx` | `/sales-data/people/salespeople/audit-record` | passed | passed | passed |
| `app/(admin)/sales-data/products.tsx` | `/sales-data/products` | passed | passed | passed |
| `app/(admin)/sales-data/referrals/architects.tsx` | `/sales-data/referrals/architects` | passed | passed | passed |
| `app/(admin)/sales-data/referrals/interior-designers.tsx` | `/sales-data/referrals/interior-designers` | passed | passed | passed |
| `app/(admin)/sales-data/referrer/[id].tsx` | `/sales-data/referrer/audit-record` | passed | passed | passed |
| `app/(admin)/sales-data/relationships.tsx` | `/sales-data/relationships` | passed | passed | passed |
| `app/(admin)/sales-data/sales.tsx` | `/sales-data/sales` | passed | passed | passed |
| `app/(admin)/sales-data/suppliers.tsx` | `/sales-data/suppliers` | passed | passed | passed |
| `app/(admin)/sales-data/today.tsx` | `/sales-data/today` | passed | passed | passed |
| `app/(admin)/settings-access-grants.tsx` | `/settings-access-grants` | passed | passed | passed |
| `app/(admin)/settings-catalog.tsx` | `/settings-catalog` | passed | passed | passed |
| `app/(admin)/settings-company.tsx` | `/settings-company` | passed | passed | passed |
| `app/(admin)/settings-notifications.tsx` | `/settings-notifications` | passed | passed | passed |
| `app/(admin)/settings-password.tsx` | `/settings-password` | passed | passed | passed |
| `app/(admin)/settings-pdf.tsx` | `/settings-pdf` | passed | passed | passed |
| `app/(admin)/settings-permissions.tsx` | `/settings-permissions` | passed | passed | passed |
| `app/(admin)/settings-privacy.tsx` | `/settings-privacy` | passed | passed | passed |
| `app/(admin)/settings-system.tsx` | `/settings-system` | passed | passed | passed |
| `app/(admin)/settings-terms.tsx` | `/settings-terms` | passed | passed | passed |
| `app/(admin)/settings-walkins.tsx` | `/settings-walkins` | passed | passed | passed |
| `app/(admin)/settings.tsx` | `/settings` | passed | passed | passed |
| `app/(admin)/team.tsx` | `/team` | passed | passed | passed |
| `app/(admin)/tiles/index.tsx` | `/tiles` | passed | passed | passed |
| `app/(admin)/tiles/orders/[id].tsx` | `/tiles/orders/audit-record` | passed | passed | passed |
| `app/(admin)/tiles/orders/brands/[brandId].tsx` | `/tiles/orders/brands/audit-record` | passed | passed | passed |
| `app/(admin)/tiles/orders/index.tsx` | `/tiles/orders` | passed | passed | passed |
| `app/(admin)/tiles/orders/po/[poId].tsx` | `/tiles/orders/po/audit-record` | passed | passed | passed |
| `app/(admin)/tiles/quotation.tsx` | `/tiles/quotation` | passed | passed | passed |
| `app/(admin)/tiles/selection.tsx` | `/tiles/selection` | passed | passed | passed |
| `app/(admin)/walkins/[id].tsx` | `/walkins/audit-record` | passed | passed | passed |
| `app/(admin)/walkins/index.tsx` | `/walkins` | passed | passed | passed |
| `app/(admin)/walkins/new.tsx` | `/walkins/new` | passed | passed | passed |
| `app/(auth)/login.tsx` | `/login` | passed | passed | passed |
| `app/(auth)/set-new-password.tsx` | `/set-new-password` | passed | passed | passed |
| `app/(customer)/home.tsx` | `/home` | passed | passed | passed |
| `app/(customer)/quotes/[id].tsx` | `/quotes/audit-record` | passed | passed | passed |
| `app/(customer)/quotes/index.tsx` | `/quotes` | passed | passed | passed |
| `app/index.tsx` | `/` | passed | passed | passed |
| `app/privacy.tsx` | `/privacy` | passed | passed | passed |
| `app/terms.tsx` | `/terms` | passed | passed | passed |

## Stateful and interaction scenarios

Project labels describe the configured viewport. The nested-picker, mobile-tile-editor and workspace-menu tests deliberately override the viewport to exercise their relevant presentation.

| Scenario | Results by project |
| --- | --- |
| critical compatibility URL /reports reaches its existing workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical compatibility URL /purchase-orders reaches its existing workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical compatibility URL /notebook/kitchen/followups reaches its existing workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical compatibility URL /notebook/furniture/quotation reaches its existing workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical entry route sends staff and customers to separate workspaces | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical sign-in identifies staff and customer accounts and submits a labeled form | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical company settings distinguish saved, changed, failed and discarded values | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical notification rules recover from failure without inventing an empty result | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical analytics drilldown preserves period and removes an error after retry | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical customer can find a shared document without changing its data | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical ground_tile_quotations_followups navigation retains its restricted workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical ground_payments_dispatches navigation retains its restricted workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical sanitary_quotations_followups navigation retains its restricted workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical sanitary_purchases navigation retains its restricted workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical temporary-password sessions validate before entering the staff workspace | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical expired sessions return to sign-in without rendering protected data | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical walk-in register retries a failed request into a populated customer journey | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical walk-in detail exits its loading state after recovery | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical fully paid orders distinguish service failure from an empty ledger | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical notebook retry retains its department and recovers to an honest empty register | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical order preview shows progressive loading, recovers and retains the original items | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical shared dialog contains keyboard focus, closes on Escape and restores its trigger | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical workspace menu supports arrow keys and restores focus without switching floors | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical page headings remain readable inside clipping ancestors | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical enlarged form text retains visible focus and reachable save controls | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical mobile tile editor retains document details and explicitly retries a failed save | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical notebook conversion retains price and concurrency token after failure | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical tile release keeps selected split quantities until the server accepts them | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical tile movement validates availability and dispatch failure retains transport details | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical customer PDF failures recover and all document variants download | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical walk-in duplicate resolution preserves the selected customer on retry | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical customer intake retains optional details after a failed save | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical collection failures recover and failed payment saves retain entered values | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical notifications link to existing records and offline state does not replay writes | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical payment tabs expose selection and support keyboard navigation with reduced motion | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical quotation picker keeps nested dialogs isolated and preserves selected products | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical multi-brand order review retains supplier choices after failure and confirms once | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical Follow-ups optional failure preserves queue and server search finds distant records | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical Follow-ups bulk partial failure retains failed records and retries only failures | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical Follow-ups failed queue shows recovery and page navigation bounds mounted records | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical Tile Orders bounded pages preserve quantities and search resets paging | desktop: passed, tablet: passed, phone: passed, small-phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| login validation and accessible input labels | desktop: passed, tablet: passed, small-phone: passed, phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical customer request failure retries into honest empty state | desktop: passed, tablet: passed, small-phone: passed, phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |
| critical Sales Data keeps working sections, charts and validates dates | desktop: passed, tablet: passed, small-phone: passed, phone: passed, tablet-boundary: passed, tablet-landscape: passed, firefox: passed, webkit: passed |

## Additional layout checks

`redesign-layout.spec.ts` checks inner heading clipping across ten page families and 200% form text reflow, with visible focus and reachable save actions. Those checks are included in the 592-test run. This text-size test does not replace browser zoom or native font-scaling verification.

## Evidence provenance and final checks

This table is derived from the 592 successful entries in the preserved `redesign-after/full-suite.log`. The shared default JSON report was later overwritten by a concurrent audit and is not used here. `verified-run-summary.json` records this provenance. After two isolated visual-review refinements were rebuilt, all 70 focused checks passed; see `redesign-after/final-checks.log` and validation.md. The added insights recovery scenario uses a desktop viewport in each browser.
