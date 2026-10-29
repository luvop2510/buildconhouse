# Owner overview and shared interface refresh — 29 October 2026

The supplied dashboard component guides the composition; Expo/React Native primitives preserve the existing web/native application. The user clarified that existing functionality must remain and that mobile is the default. They subsequently asked to leave the unidentified PDF aside.

## Delivered changes

- Homepage, overall/floor sales dashboards and report previews share dashboard content: equal KPI panels, explorable line/area and bar views, floor comparison bars, contribution ring, customer mix and source-backed rankings. Exact values, keyboard controls and data rows accompany the graphics. Compact navigation replaces the long hierarchy and underlined analytics rows.
- Current team workload and recorded 30-day contact effort sit alongside sales. Kitchen stage/workload and Furniture ledger status reuse existing authoritative sources. Their current time basis is explicit and independent of sales filters. Existing daily follow-up actions, quotation approvals, shortages, recent quotations and the original quotation/payment snapshot remain on the homepage. The snapshot is a disclosure for clarity.
- RNB appears in explicit Furniture analysis and one dedicated Furniture section of the company overview. Ordinary INR metrics, entity fields and export aggregates omit irrelevant RNB values. Supporting records honor validated currency filters without broadening floor access. Currency clears when switching business unit. Furniture trends use their own prior amounts and entity rankings use their own currency.
- Shared text tokens, AppText, input defaults and HTML use the operating-system font; Apple devices resolve to San Francisco. Feather stays the sole icon family. Shared controls, forms, navigation, surfaces and legal/sign-in views use consistent weights, graphite actions, porcelain backgrounds, readable spacing, touch targets and corner radii. Existing reduced-motion/focus handling remains.
- `src/design/README.md` replaces the old app-wide design file; `docs/sales-design-contract.md` records the dashboard contract. `.taste-skill/direction.json` records the implemented palette.

## Preservation and data accuracy

No business records, stored history, floor assignments or transactions are rewritten. No migration is required. Confirmed-sales sources, explicit missing values, India calendar boundaries, stable entity identities, contacts redaction, role/floor/export permissions and existing report/export routes remain. Owner operations is an additive read-only endpoint restricted to owners. It cannot write/reconcile workflow state. Team workload belongs to current assignees; contact counts belong to the actual recorded actor. Recorded completed history is never presented as a measured completion rate.

## Verification

TypeScript, focused ESLint and diff whitespace validation passed. App text, icon-font and font-asset contracts passed; optimistic follow-up completion regressions passed. Forty-four backend cases cover unified totals, currency separation/filter validation, exports, read bounds, owner-only operations, floor isolation, event deduplication and canonical workflow metrics. A pure currency/navigation contract covers floor changes and explicit source currencies.

Responsive browser checks use synthetic fixtures at 320, 375, 768, 1024 and 1440px. They cover exact currency wrapping, floor navigation, chart mode/keyboard/data controls, scoped supporting orders, profile source links, PDF/Excel export filters, report history, permission failures, owner team scope/recovery and page overflow. Rendered inspection identified and corrected stacked-panel overlap and cramped phone currency values. No real customer data is included in screenshots or fixtures.

The unchanged pre-push hook requires the full fresh-build performance/stability audit before GitHub publication. No budget, retry limit, required case, source check or remote protection is weakened. Its machine-readable results are generated under `output/playwright`; the push command is the final release gate. Browser emulation does not certify physical devices or production network performance. The user subsequently authorized GitHub publication and deployment to Vercel and Railway. Each provider must verify the final source independently; a push alone is not evidence of production publication.
