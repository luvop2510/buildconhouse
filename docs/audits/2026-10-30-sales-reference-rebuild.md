# Sales Data Stitch reconstruction — 30 October 2026

## Result and scope

The supplied HTML from Stitch replaces the previous generated layout. Existing
Sales Data reads and actions now fill its arc/revenue, visual metric grid,
distribution, activity, comparison and transaction composition. Rounded panels
also apply to existing directories, profiles and report creation/history. No new
framework, dependency, API, business record, permission or database migration is
introduced. The latest mobile header exception is scoped to Sales Data only.

Prototype goal pace, targets, allocation rates, multi-year totals and dispatch
counts have no recorded source and are not presented as business facts. The arc
shows collected / (collected + outstanding), explicitly current balances on the
selected orders. Dated activity uses real currency-specific order counts.
Previous comparisons render only when provided. Missing values remain unknown.

The existing blue/neutral theme, system text and Feather icons remain. Ordinary
money stays fully visible on one line; measured monetary tiles span the width
when needed. Exceptionally long amounts remain available in local horizontal
regions. Phone transaction status sits with identity, freeing room for names;
amount/date can wrap into separate layout rows without splitting an amount.
Keyboard interaction opens exact source/filter/date/currency records.

## Requirement evidence

| Requirement | Implementation and verification |
| --- | --- |
| Follow supplied design | `SalesVisuals.tsx`, `AnalyticsDashboard.tsx`, `analytics-bento.tsx`; rendered phone/tablet/desktop fixture review and explicit source mapping in the design document. |
| Remove mobile sticky header | Sales layout injects navigation into `AdminPage` scroll content; shared admin header is omitted for Sales only; browser navigation scroll-away regression. |
| Clear attribution | Real dates/period/basis, labelled current balances, currency-separated distribution, record IDs/customer/department/status/date, chart data and exact supporting-record links. |
| Mobile then regular layout | 320/375/768/1024/1440 browser suite; ordinary and extreme money/enlarged-text review; source/profile/report/floor navigation tests. |
| Highly visual compact PDF | Rounded summary/collection arc, vector trend and comparison bars; attributed transactions; representative overall two A4 pages, current Orders and records-only one each. |
| Clean selected export | Current-tab/records scopes, complete long-list continuation, XML-safe user text, explicit row ceilings; XLSX detailed data remains. |
| Protect existing data/access | Owner gate, floor/request generations, exact India date bounds, separate INR/RNB, no targets/drafts/supplier POs fabricated into confirmed sales. |

## Executed checks

- `npm run check:affected`: 80 passed, zero reused/failed, including TypeScript
  and 4,043 hermetic backend unit tests. One existing Starlette deprecation
  warning and the pytest-asyncio fixture-scope warning remain.
- Focused export/currency tests: 28 passed; Python pyflakes clean.
- Zero-warning ESLint and `git diff --check` passed.
- `npm run test:npm-audit`: passed.
- The initial 120-case Sales Data suite passed. After the enlarged-transaction
  and crore-balance
  correction, all 130 final cases passed on an immutable export, zero skips,
  flakes or retries (`sales-stitch-money-final-browser.log`).
- The mandatory pre-push hook runs the final performance/stability gate before
  publication; the resulting receipt is authoritative. An earlier run was
  rejected: two tests expected deleted overview ranking cards and other cases
  encountered long machine timing interruptions. Those source-evidence checks
  now visit Companies/Products; scenarios, deadlines and budgets are retained.
  No interrupted/partial report is counted as a release pass.

Logs and screenshots are in the parent workspace `outputs/` directory:
`sales-stitch-*` and `sales-layout-refinement-2026-10-30/`. The selected reference
hash and changed-source hashes are in `outputs/sales-stitch-source.json`.
PDF samples and inspected page renders are in
`main/output/pdf/stitch-review/`. Browser measurements use synthetic records,
not production financial proof or physical-device certification.

## Publication status

At the prepublication source freeze, remote main and canonical Vercel source
were both verified at `be6ac113c2490c54bc76ea86e5965a3bf84ea270` before release.
Canonical deployment: `dpl_A6Zs3enKm78jv7qejDmDTsZUhjKL`. Current main protection
is enabled with administrator enforcement; its API returned no required review
or status-check objects. This task does not change protections or bypass hooks.
Final release identities/check outcomes are recorded separately in the parent
workspace `outputs/sales-stitch-release-2026-10-30/release-receipt.json` after
publication succeeds. This source document alone is not publication evidence.

Physical phone/tablet devices, native screen readers, signed native builds and
hosted production performance have not been established by local browser checks.
