# Sales Data simplification — 27 October 2026

## Change

Sales Data had nested navigation across Today, Executive, Revenue, Collections,
Forecasting, Products, Brands, Customers, Relationships, Suppliers and Operations.
It now has three direct views: Sales, References and Customers. Legacy report
bookmarks redirect to the corresponding view, while brand/reference details remain.

Sales leads with confirmed revenue, distinct products and order counts, followed
by ranked brand/product rows. Box/piece quantities stay separate. References
combines architects/interior designers in one searchable directory with stable
codes, studios, referral counts and revenue. Contact reads do not wait for sales.
Customers combines all-time confirmed buyers, period buyers, current open/overdue
follow-ups, and current unpaid balances. Payment/follow-up actions choose a concrete
floor before opening their existing operational workspaces.

Phone filters start collapsed; title and Refresh share a row. The report's floor
and period remain visible even when filters are closed. Report choices survive
view changes; the floor choice is validated against accessible floors. Request
versions and cancellation prevent old floor/date responses overwriting new data.

The new read-only API uses existing analytics floor guards. Initial catalog-only
financial caching was removed when the scope expanded: Furniture deposit changes
do not bump analytics cache versions, so the full four-source report stays fresh.
Balances include append-only additional costs and completed, same-floor payments
and credits, clamped per order so an overpayment cannot erase someone else's debt.
The disposable-Mongo test caught an invalid nested facet before release; the fixed
aggregation now uses sibling facets for rows, counts and totals.

## Scope and limits

The user explicitly confirmed financial reporting for all four departments. INR
sales/balances combine catalog quotation records with current confirmed Kitchen
orders. Furniture final ledgers retain separate RNB values, without conversion or
cross-currency addition. Customer account rows carry currency and source floors.
Product/brand quantities are shown only where actual catalog lines exist; Kitchen
and Furniture still show their real revenue, customers and unpaid amounts.

Kitchen uses the order's selected quotation/design versions, including valid older
versions. Its recorded collections are advances, rather than a guessed full payment
history. Furniture uses finalized ledger values and its own deposits. Scope guards
continue to apply before each source read. No business data migration is required.

## Baseline evidence before the four-department clarification

- Full hermetic backend unit suite: 3,429 passed, six dependency warnings.
- Disposable real Mongo accounting/scope/empty-data test: passed.
- Focused browser matrix before final money/sidebar polish: 40 passed over
  320, 390, 768, 1024 and 1440 widths, including keyboard navigation, scope races,
  date validation/persistence, reference search and exact export payloads.
- TypeScript and whole-project zero-warning lint passed; production web export
  and all 187 exported route bundle budgets passed (maximum about 499 KiB gzip,
  ceiling 576 KiB). Full npm audit reports zero vulnerabilities.
- The earlier current-source four-device stability run was interrupted when the
  user expanded financial scope to all four departments; its passing subset does
  not count as final release acceptance. A full run will follow the expansion.
  Earlier interrupted runs and the run that encountered a local server port
  conflict do not count as release acceptance. Ports and immutable export copies
  now isolate design review and stability runs.
- Final release/merge/hosted acceptance is pending. Physical devices and signed
  native builds have not been verified.

## Visual review

Achromatic ledger, seed 1455220230, preserving the existing Inter and blue tokens.
Synthetic design fixtures only: example customers and studios are not production
records. No new photography, testimonials, business growth or other proof invented.

Before: at 390px the filter panel consumed about 420px and the first KPI began at
about y681. On desktop, product/brand evidence was below the initial viewport.
After: compact controls, one summary band and brand/product evidence in the first
desktop viewport. The all-department phone view shows totals and its department
breakdown first; brand/product lists follow on scroll.
An intermediate portrait-tablet screenshot exposed wrapped rupee digits; the final
layout gives the lead amount its own row at that width. A second review caught
Customers and Sales Data both active in the sidebar; Sales Data now owns its
subroutes. Customer balances retain paise instead of rounding them away.

The inspector's font-count exception is explained in docs/sales-design-contract.md:
Inter's separately loaded weight files plus the existing Feather icon font are
counted as different typefaces. No contrast or layout check is waived. Measured
text contrast on white / canvas is 17.75/16.70 primary, 7.69/7.23 secondary and
4.97/4.68 small labels. Blue on white is 5.57:1.

## Four-department verification before the protected push

- Current backend unit suite plus three disposable real-Mongo accounting cases:
  3,451 passed, six third-party deprecation warnings. Mongo databases are generated
  per test and dropped in finally blocks; no application data is used.
- Focused browser matrix: 75/75 passed, zero retries/skips/flakes, across 320, 390,
  768, 1024 and 1440px. This found and fixed Kitchen's redirects away from Sales
  Data/Follow-ups, and verifies the actual follow-up request's floor header.
- TypeScript, Expo zero-warning lint, all existing frontend CI contract commands,
  and Expo Doctor (20/20) passed. A fresh npm ci and full npm audit reported zero
  vulnerabilities. Web export and 187 route budgets passed, largest about 499 KiB
  gzip under the unchanged 576 KiB ceiling. Unsigned iOS/Android exports passed.
- Independent financial review found a catalog-only default-period probe that
  could hide current Kitchen/Furniture sales behind an old Tiles month. The new
  reports now default to This month while retaining explicit saved selections.
  The first browser scenario supplies an obsolete catalog fallback and checks
  that the actual summary request still uses this_month.
- Inspector: all three screens at 1440/768/390px report zero failures/warnings,
  with only the documented font-family measurement allowance. Evidence lives in
  `.taste-skill/current-four/`; the synthetic customer and studio names are QA
  fixtures. A stale snapshot rerun was discarded and retained separately; it is
  not passing evidence.
- The full performance/stability audit is enforced again by the pre-push hook.
  This ledger records pre-push evidence; the PR records that gate's actual result.
  Interrupted runs do not count as full acceptance. Main merge, independent
  approval, required CI and hosted acceptance remain pending at this checkpoint.
  Physical devices and signed native builds remain unverified.
- Final independent review aligned reference/brand drilldowns with report access:
  managers can open details, combined views retain assigned floors, and explicit
  forbidden floors fail before reads. Twelve actual FastAPI boundary regressions
  cover role admission, financial source scope and private directory metadata.
  The seven-width Enter/Space customer-account drilldown check also passed 14/14.

## App-screen critique

1. Sales leads with exact revenue, then products/orders; Customers leads with
   buyers, follow-ups and balances; References leads with its searchable directory.
   The titles and active tab answer what each view contains immediately.
2. Header, filters and report surfaces share their edges. Desktop ranking columns
   share one surface; compact screens stack them. Portrait tablet totals use a
   full-width money row, avoiding the previously wrapped rupee digits.
3. Blue appears on the brand contribution marks, reference filter selection and
   Add reference action. Neutral navigation and summary cells preserve the ledger
   direction rather than making every number a competing coloured card.
4. Synthetic totals reconcile: INR 6,40,000.25 equals Sanitary 2,40,000 + Tiles
   1,00,000 + Kitchen 3,00,000.25. RNB 75,000.50 is separate. Four catalog products
   exclude project-only orders. Balances and exports retain paise; duplicated
   totals agree with department/account rows. Quantities retain their own units.
5. Genuine empty results show 0 and an empty explanation. Missing reference
   performance shows a dash. Follow-ups names its open count and overdue subset;
   it does not claim a period-only queue or infer a missing collection.
6. Ranked brand bars are directly labelled; there is no detached legend to match.
   No label collisions or horizontal content overflow were observed. Currency
   prefixes remain visible beside each amount.
7. Phone keeps the three essential report tabs visible and folds the broader
   workspace into More/All stages. Filters start collapsed. The all-department
   view requires scrolling to its ranking/customer rows, an intentional tradeoff
   for displaying both currencies and all four department totals legibly.

The three largest issues found during review—phone filter height, portrait money
wrapping and Kitchen report routing—are fixed and covered. No live publication or
complete-goal claim is made by this pre-push checkpoint.
