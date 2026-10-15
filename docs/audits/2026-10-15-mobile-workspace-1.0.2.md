# Mobile workspace update — version 1.0.2

The user confirmed the compact app header must stay fixed while content below
scrolls, with no sticky content/table headers on phones. Search/edit focus hides
phone navigation and workflow footers. Navigation restoration waits for the
blur-triggering tap to complete so the returning header cannot move its target.
Native input focus includes hardware keyboards; software keyboard events cover
other native entry controls. Viewport rotation retains mounted route/form state.

Mobile filter groups now have Hide filters/Show filters controls and keep their
selections and unfinished date ranges. This covers Payments, Payment History,
fully paid orders, Walk-ins, Follow-ups, Customers, customer purchasing, Sales
Data, quotations, warehouse stock, team assignments, and tile lists/toolbars.
Catalog and Purchases retain their existing filter sheets. Extra bottom padding
was removed where AppScaffold already reserves navigation space.

Walk-in summary metrics select exact dashboard statuses and UTC visit windows.
Follow-up summary selections clear unrelated search/filter state; Expiring Soon
uses the exact open quotation-expiring rule, including undated records, with
floor/grant checks retained. Customer summary values open matching profile tabs
and product views. Payments earnings/refunds can include fully paid orders;
partial receipts exclude noncash stock credits. Due-now restores outstanding
orders and all summary scopes are clearable.

The subsequent user correction removes Spending and Completed Today from the
summaries, along with the proposed Spending tab/endpoint. No spending endpoint,
financial mutation, migration or customer-data change is part of this release.
Redundant summary wording was also trimmed. Existing historical completion
records, Won/Lost views and payment history remain available.

Version is aligned at 1.0.2 in package.json, package-lock.json and app.json.

## Verification

- TypeScript and zero-warning lint passed.
- Mobile shell/keyboard/floor-race contracts, input focus lifecycle, Walk-in UTC
  and status predicates, multi-filter and Sales Data period checks passed.
- Full hermetic backend unit suite: 2,879 passed.
- Publication requires the unchanged full current-source performance/pre-push
  audit. Final stability, performance and bundle evidence belongs with the GitHub
  release artifacts.

Browser API responses are synthetic and business writes are intercepted. No
production/physical-device or signed native acceptance is claimed. Current npm
audit still reports 22 high and five moderate dependency findings; no audit
suppression or protected-main bypass is included. This is a GitHub source release,
not a claim of Vercel/Railway production promotion.
