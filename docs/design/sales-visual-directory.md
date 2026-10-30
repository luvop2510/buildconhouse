# Sales Data visual directory

The sales interface uses the canonical `src/design/README.md` system. It shows
recorded sales first, then an optional deeper explanation. The latest supplied layouts (IMG_4092, IMG_4098 and IMG_4097) lead the
composition: one large time chart, compact dated column charts, ranked bars and
a dated activity matrix. Collection-share gauges and unexplained repeat-share
rings remain removed. Amounts label their graphics rather than forming a wall
of numeric cards. Missing values remain unavailable; Furniture RNB is always a separate
ledger. No figures or customer records are created by this directory.

| Surface | First glance | Additional detail | Attribution / source |
| --- | --- | --- | --- |
| Overview and floor overview | Primary trend with a visual balance comparison, dated order/average columns and customer-history bars | One trend, department/company bars, optional dated order activity and source notes | All amounts and marks use the selected dashboard response; exact-date source orders remain linked |
| Companies | Search and ranked company sales bars with catalog/floor identity | Products, customers, architects, quotations and orders through one View selector | Existing catalog brand IDs; zero period sales do not mean a new company |
| Products | Search and ranked product sales bars | Quantity history, price/stock attributes and related records | Saved order-line identity; historical company assignment survives catalog reassignment |
| Architects | Search and ranked architect attribution bars | Customers, projects, quotations and activity | Stable referrer ID and exact source filters |
| Customers | Search and ranked customer sales bars | Order/payment/delivery history and preferences | Stable customer ID; unavailable historical attributes stay explicit |
| Reports | Title, selected scope and preview action | Saved filter history; full PDF/Excel download | Same report scope and financial model as the screen |
| Data quality | Count and matching-name groups | Explicit compare/review disclosure, revision and review note | Owner decision only; no automatic merge or source rewrite |
| Reference variety and detail | Search, contact identity, clients brought and period sales | Contact metadata, acquired people, Kitchen projects and Furniture ledgers | Acquisition dates remain separate from sales confirmation dates; includes people without orders |
| Order detail | Order identity, financial comparison bars and product-line value chart | Payments, timeline, documents and additional row fields | Canonical source order, immutable supporting records and original currency |

## Visual forms

- A financial amount labels its graph. Recorded collected/outstanding balances use named bars on a common zero-based currency scale; no target or collection percentage is inferred.
- A time series uses the existing bar/line switcher, one scale per currency,
  honest missing-value gaps, previous-period marks, keyboard/tap selection and a
  readable Chart data alternative.
- Department and company comparisons use directly labelled horizontal bars from
  zero with exact amounts. A single category does not receive a self-share chart.
- Dated order activity is an optional matrix of recorded counts. Selecting a cell
  carries its exact date, dimension and currency to supporting orders.
- Directories use directly labelled ranked bars on desktop and phone. Essential names
  and amounts wrap or expand rather than disappearing behind ellipses.
- Profiles use one section selector. Record details and secondary analysis expand
  inline; source actions remain available.
- PDF summaries use uniform financial cells, real time/ranking charts and complete
  selected tables. Money columns are measured so large amounts retain their
  decimal and currency on one rendered line.

## Immediate interaction and loading

Page shells, filters, selectors, disclosures and local search drafts respond
immediately. First reads use dashboard/list/profile/order/quality skeletons, never
fabricated zeroes. A revisit may display a memory-only preview for up to 30 seconds
while revalidating; this is not a claim of instantaneous network access. The cache
has at most 24 entries, includes account and permission inputs, and does not persist
customer data to disk. Refresh retains same-scope values with visible update
feedback. Scope changes hide obsolete values. Writes invalidate previews; account,
floor and access-denial changes also clear mounted values and late responses.
Financial totals and owner review acknowledgements remain server-confirmed.

## Evidence

`e2e/sales-redesign.spec.ts` captures overview, all seven directories and the
company/product/customer/architect/order deep pages at 320, 390, 768, 834, 1024 and 1440px.
`scripts/test-sales-analytics-instant-reads.mjs` exercises cache, permission,
revocation and response-race behavior. `e2e/sales-analytics.spec.ts` covers source
links, keyboard operation, exports, filters, exact values and retained state.
Captures use isolated display fixtures; they are layout evidence, not live figures.
The release's local comparison gallery is under
`outputs/sales-simplification-2026-10-31/visual-directory.html` in the workspace.

## Reference layout attribution

The user supplied IMG_4092 2.JPG, IMG_4098 2.JPG and IMG_4097 2.JPG. Their
chart-first hierarchy, varied panel spans, compact dated graphics and neutral
card surfaces informed the composition. Their sample figures, bank/payment
workflows, decorative targets, third-party logos and claims are not application
data. The Buildcon system palette, platform typography and real API values remain
authoritative. No stock imagery or additional third-party assets were added.
