# Sales and owner overview design contract

Supersedes the former sales layout. The app-wide visual rules are [src/design/README.md](../src/design/README.md); the data source and export contract remain [sales-analytics-design.md](sales-analytics-design.md).

The page answers: how is Buildcon House performing, and where does work need attention? The company’s four actual floors supply its organizing structure. Its signature is a single coherent sales view with a large explorable trend, direct comparison bars and a separately labeled furniture ledger.

Phone order: title and refresh → compact filters/export → four equal metrics in two columns → sales trend with Trend/Bars control and exact selected value → business contribution → floor comparisons and collections → dedicated Furniture (overall only) → owner team workload/contact effort → companies/products/architects/customer mix and source notes. On regular widths related panels share aligned rows. Every chart has text values and supporting-record navigation. Do not add decorative icons or numbers to fill space.

The overall and floor dashboard routes, homepage and report preview use shared dashboard content. Directory/detail pages share panels, neutral rows and system type. Explore data replaces the long navigation hierarchy; detail pages have one Back control.

Owner work is current floor-scoped workload plus recorded contacts over the trailing 30 days. It does not inherit the selected historic sales period. Actor contacts and current assigned workload are labeled separately, and missing source data produces an explicit recovery state.

Acceptance: no blue underlined analytics labels; RNB only explicit Furniture/dedicated Furniture overview; exact currencies and India bounds; phone-first single-column layout without page overflow; one system text family; consistent Feather icons/spacing/targets; accurate labeled charts from the same response as KPIs; all existing role/floor/export checks; focused backend/browser tests and unchanged release stability gate.
