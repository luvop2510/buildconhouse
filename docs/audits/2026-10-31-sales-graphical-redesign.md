# Sales Data graphical redesign, 31 October 2026

The user's latest three images supersede the intermediate plain-numeric summary.
Sales Data now starts with its primary trend and uses graphical balance summaries,
dated columns, customer-history bars, ranked entity/order bars, a dated activity
matrix and identity relationships. Source rows and less-used attributes remain
available through disclosures. Company, product, architect, customer, reports,
data-quality, reference and deep source pages share the existing design tokens.
Legacy brand bookmarks now resolve to the same canonical company profile.

Reference variety now uses the same selected floor and server-resolved India
calendar bounds as the unified dashboard. Acquisitions still use referral dates;
reference sales use confirmation dates, explicitly labelled. Furniture RNB never
shares an amount scale with INR. Source-line brand identities survive catalog
product reassignment and deleted products, preserving ranking/detail agreement.

The production read-only catalog audit found 32 brand records, 32 distinct stable
IDs and zero normalized-name duplicate groups. No company/customer/product record
was created, merged or deleted. Existing zero-period-sales catalog brands remain
visible and are labelled as existing catalog entries.

First visits use shaped skeletons. View controls and search drafts respond
immediately. Memory previews expire after 30 seconds and are bounded to 24 keys;
all reads revalidate. Writes, floor/session changes and access denial invalidate
previews; obsolete responses cannot restore protected values. Actual financial
figures and owner-review revisions remain server-confirmed. Nothing promises an
instant network response or fabricates a zero while loading.

Validation before publication:

- TypeScript and focused ESLint: passed.
- Sales browser journeys: 122 passed at 320, 390, 768, 834, 1024 and 1440px.
  Includes populated deep pages, skeletons, cache revisits, source/export scopes,
  keyboard operation, negative/unknown values, enlarged text and large amounts.
- Export/company attribution unit suite: 28 passed with hermetic CI settings.
- Reference directory: 9 passed; API client, instant-read/cache, currency-scope and
  graph-scale contracts passed.
- Hallmark static sweep: 0 FAIL, 0 REFLEX, 0 WARN across 17 files. The requested
  render-tier invocation could not locate puppeteer-core; actual rendered review
  used the populated Playwright captures above. A real metric-card overlap found
  in that review was corrected and covered by a regression assertion.
- No claim of physical-device testing or measured coverage percentage.

The pre-existing PDF money-column width work was reviewed, tested and committed
separately. The redesign retains it and replaces collection-percentage gauges
with explicit balance values. Existing PDF/Excel source attribution remains.

See `docs/design/sales-visual-directory.md` for every chart family, layout and
source relationship. The workspace comparison gallery and per-device captures
are in `outputs/sales-simplification-2026-10-31/`. Deployment IDs, final source and
push/performance evidence are recorded there after publication.
