# Sales Data — supplied Stitch layout

The supplied Stitch HTML is now the visual implementation source. It follows the
user's IMG_4104 sales-dashboard direction and supersedes earlier generated
layouts, segmented square bars, and green treatments. The app uses its existing
blue/neutral palette, system text, Feather icons and responsive shell.

## Layout and source mapping

| Stitch section | Existing data used | Meaning retained in the app |
| --- | --- | --- |
| Large arc and revenue | Confirmed sales, collected, outstanding | Arc is explicitly collected / (collected + outstanding), current balances on selected orders. No recorded sales targets exist, so no goal/pace claim is invented. |
| Four visual metrics | Orders, purchasing customers, average order value, Furniture RNB | Bucket bars/sparklines use the same selected trend. Repeat share requires complete customer identities. Furniture stays separate from INR; a floor view shows its outstanding balance instead. |
| Department donut and legend | Currency-compatible floor totals; top company totals on a floor | Complete nonnegative distributions only. Missing values suppress the circle. Single-company floor views use rows, without a meaningless self-comparison circle. |
| Activity matrix | Existing trend orders_inr/orders_rnb counts | Dated order counts, never fabricated dispatch counts. Cells open their exact date/currency records. Unknown counts are unavailable. |
| Paired time comparison | Selected and previous period sales buckets | Plain continuous columns, or the existing line option. Real previous values only, signed values and gaps retained. |
| Recent transactions | Existing source records read | Customer identity, order, department, status, full money and India date. Desktop table; phone cards. Refresh updates both dashboard and records. |

The prototype's sample dates, amounts, targets, allocation percentages and years
are not production data. Its external Tailwind/font runtime, dead notifications,
new navigation destinations and disabled-zoom setting are not imported. Existing
search/filter/export/navigation actions retain their working app implementations.

```
Phone (one vertical scroll owner)
[navigation / title / period, filters, export, refresh]
[sales & collection arc / full amount / balances]
[orders | customers]
[average | Furniture RNB]  -> full-width money cards when needed
[distribution + attributed values]
[order activity matrix]
[paired time comparison / data alternative / supporting records]
[recent transaction cards]
[source basis and limitations]

Regular width
[compact title and controls]
[sales & collection arc       ][visual metric grid                ]
[order activity              ][department/company distribution   ]
[paired time comparison      ][separate Furniture ledger          ]
[full-width transaction table]
[source basis and limitations]
```

Panels use 16px radii, measured monetary cards and consistent 12/16px spacing.
Ordinary monetary values remain fully visible on one line; the hero balance
rows also measure crore-sized values and stack when needed. Exceptionally long
values retain their full text in a bounded horizontal region. Charts have keyboard
exploration and readable tables; matrix cells have 44px targets. A matrix may
scroll horizontally inside its frame, never at page level. The latest Sales Data
header exception is scoped to Sales only: header/navigation scroll away while the
existing bottom navigation remains. Other floor/workflow headers are untouched.

Directories, profiles, records, report creation/history and existing owner data
quality/reference screens remain reachable, using the same rounded panels and
financial text treatment. No permissions, canonical identities, business records
or filter/date/currency semantics are changed by the visual redesign.

## PDF

The PDF uses blue vector charts, real collection-share arcs, rounded neutral
summary panels, labelled ranking bars and compact attributed source rows. Small
aggregate sections pair; long lists continue across pages. It excludes UI chrome,
buttons, navigation, pagination query metadata and duplicate transport columns.
Current-tab and records-only exports include only the selected report sections.
INR and RNB have separate summaries/scales. Excel preserves detailed data.

Representative fixture renders: overall report two portrait A4 pages; Orders tab
and records-only each one page. These are examples, not universal page limits.
Full selected data, missing-value explanations and meaningful source attribution
are preserved. Large lists and long/untrusted text have continuation tests.

## Verification

Focused data-calculation, export and browser checks cover currency isolation,
missing data, source links, payment labels, refresh, owner access, scroll-away
navigation and financial layout at 320/375/768/1024/1440. Rendered screenshots use
synthetic records. Final integrated performance/release checks remain pending;
this design document is not a production-deployment claim.
