# Sales analytics implementation and acceptance

The complete sales analytics specification supplied on 28 October 2026 replaces
the previous three-view Sales Data page. Its gallery is illustrative: none of its
example customers, rankings, growth percentages or monetary values are used as
business data. The two pasted component files are identical banner examples;
the shared native/web Banner adapts them to the existing application.

## Implemented scope and source mapping

| PDF requirement | Implementation and evidence |
| --- | --- |
| One foundation, five dashboards | `services/analytics/unified.py`; overall and concrete-floor routes share the same confirmed-order model. Home dashboard uses its compact preview. |
| Confirmed sales, orders, buyers, AOV | Unique confirmed customer orders; actual catalog `net_amount` lines; current valid Kitchen order basis; finalized Furniture ledgers. Orders count once; RNB stays separate from INR. |
| Visual analysis | Line trend, prior comparison when supported, floor donut with mapped legend, floor bars with sales/orders/customers/AOV selection, rankings, new/repeat counts, recorded category/size/finish/series breakdowns. |
| Four entity directories/profiles | Actual authorized customer/product/company/architect directories, including identities with no selected sales. Profile identity, attributes, sales and quantity trends, related tables, pagination and exports. |
| Quotations and projects | Separate authorized history includes actual draft/sent quotations and Kitchen versions/projects; these values never enter confirmed-sales KPIs. Source links open each floor's existing workspace. |
| Individual order | Stable identity, saved lines and attributes, amount/discount/tax availability, payments, current balance, recorded timeline and authenticated document open/download. |
| Persistent scope | Date basis/range, floor, entity IDs, status, attributes, search, sort, page and source discriminator carry in URLs. Back retains the prior profile context. |
| Global export | Shared server PDF/XLSX rendering with entity IDs, filter/date metadata, title, KPIs, relevant charts/tables, currency formats, formula escaping and explicit row ceilings. Profile scopes: full/current analysis/source records. |
| Reports | Filtered preview, scoped downloads and account/device-local history of report configurations. Reopening refreshes authorization and source data. |
| Duplicate review | Data quality compares stable IDs, records owner decisions and notes with CAS/replay/audit history, and links canonical source correction tools. No identities are automatically merged. |
| Permissions | Role/floor checks precede reads; explicit sales_data export capability; contact redaction for custom-access profiles; scoped private document routes remain authoritative. |
| Responsive UX | Existing app shell/breakpoints, collapsed filter drawer, wrapping controls, 44px targets, readable mobile KPI values, stacked charts, record cards, labeled keyboard drilldowns and chart-data alternatives. |

## Financial invariants and limits

Confirmation is the default date basis. Payment-date analysis measures actual
recorded receipts and labels them as collections. Credits can reduce balances
without becoming cash receipts. Receipt allocation to individual products or
companies is unavailable. Quotations select actual quotation history separately;
supplier purchase orders never become sales. Dates and chart buckets use India
business boundaries with exclusive ends. Quantities retain recorded precision
and incompatible units are never added together.

Missing source amounts, dates, stable customer identities and attribution remain
explicitly unavailable. A missing customer ID does not become zero buyers. The
existing single recorded referrer is used; no multi-architect allocation policy
is invented. Current balances are distinguished from period sales. Kitchen
collections are limited to recorded advances. Net-sales returns accounting,
margin and conversion are unavailable where source data does not support them.

The server applies floor/entity/source filters and bounded computation before
pagination. Scopes above 20,000 orders or 100,000 lines fail explicitly; exports
above 10,000 rows fail instead of truncating. Narrowing floor/entity/source
reduces the lifetime model scope. No schema migration or production backfill is
needed. Duplicate review uses the existing settings collection and its unique
`_id`; reviews retain up to 1,000 decision events with an explicit ceiling.

## Verification record

- Final backend source: 3,636 hermetic unit/HTTP tests passed, plus two actual
  disposable Mongo integration tests. The isolated databases were dropped and
  the run-owned Mongo process stopped. This includes four-floor reconciliation,
  actual Furniture charges, Kitchen commercial basis, draft quotation history,
  receipt/credit separation, India bucket boundaries, fractional quantities,
  duplicate-review concurrency/replay, direct authorization and export scoping.
- TypeScript and zero-warning Expo lint passed. Dependency audit: eight low
  findings; zero moderate, high or critical findings. No dependencies added.
- The preceding complete frontend audit passed 1,092 stability scenarios across
  Android Chromium, iPhone WebKit, iPad WebKit and desktop Chromium, and all 60
  timing scenarios. There were zero failures, retries, skips or flakes. All 203
  exported pages were budget-checked; largest initial JS was 482 KiB gzip against
  the unchanged 576 KiB ceiling.
- Fifty focused analytics browser cases passed at 320, 375, 768, 1024 and 1440px.
  Expanded source-navigation/title checks and the unchanged full gate rerun in
  the actual pre-push hook qualify the final shipping source. Current machine
  reports are `output/playwright/*-results.json` and corresponding summaries;
  they must be inspected rather than inferred from this earlier pass.
- Rendered PDF exports were visually inspected with synthetic test records.
  Unit tests check formatted monetary values, percentages, source IDs, literal
  user text, missing chart values, numeric Excel cells and partial-export rejection.
- Browser screenshots exposed and led to fixes for mobile decimal wrapping,
  excessive chart-control height, keyboard link activation, stale layout filter
  parameters and filter drafts lost on dismissal. Ground quotations use their
  actual Tiles quotation route rather than switching to Sanitary.

Local test records and screenshots are synthetic. Browser emulation does not
certify physical devices or production network latency. Backend request timing,
Server-Timing and existing monitoring middleware cover the new routes; no
customer PII or tokens are added to telemetry.

## Publication

The owner explicitly requested publication to GitHub, Vercel and Railway on
29 October 2026. Publication must use the current main source and preserve
provider protections, backups, verified runtime bindings and rollback identities.
The PDF's D11 pilot/backup/owner release conditions remain applicable; no test,
preview, push or build by itself proves a production deployment. Actual provider
IDs and post-release verification belong in the release receipt, not fabricated
in advance in this source audit.
