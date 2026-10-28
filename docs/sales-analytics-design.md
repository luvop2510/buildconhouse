# Buildcon House sales analytics

Source: the user-supplied Complete Sales Analytics & Interactive Drill-Down
Specification, dated 28 October 2026, including its illustrative gallery on pages
4–5. The PDF defines the requested product. Its example names, growth figures,
rankings and chart values are not application data.

## Design contract

The screen answers: which confirmed customer orders explain performance across
Tiles, Sanitary/Bathroom, Kitchen and Furniture? The defining element is a
reconcilable four-floor comparison with separate INR and RNB ledgers. Every
meaningful figure leads to its supporting authorized records.

The existing Expo Router / React Native Web design system remains authoritative.
Use its Inter font assets, neutral surfaces, blue chart/action accent, Feather
icons, shared controls, mobile scaffold and API transport. The supplied two pasted
templates are identical web banner examples; `src/components/ui/Banner.tsx`
adapts that component to the existing native/web stack, with wrapping content,
in-flow layout, accessible dismissal and persisted dismissal by stable ID.
It does not require replacing the application with Next.js, shadcn or Tailwind.

The taste-skill app draw is recorded under `.taste-skill/sales-analytics/`.
Its flat ledger layout fits analytics; existing typography and palette are kept.
The PDF's blue controls take precedence over the draw's neutral-button preference.
KPI icons, gradients and decorative growth badges are omitted: the financial
values and their evidence carry the visual hierarchy.

## Tokens and accessibility

Existing semantic roles, measured against white:

| Role | Color | Contrast |
| --- | --- | --- |
| Primary text | `#101828` | 17.75:1 |
| Secondary text | `#475467` | 7.69:1 |
| Captions | `#667085` | 4.97:1 |
| Main chart / link | `#0066CC` | 5.57:1 |
| Surface | `#FFFFFF` | — |
| Canvas | `#F7F8FA` | — |

Use 24px page titles, 17–20px section titles, 14–16px content, 12–13px metadata,
and tabular figures. Panels use a restrained 8px radius and hairlines. Layout
uses the existing 4px spacing scale and shared responsive breakpoints. Controls
remain at least 44px high. Chart data also has readable labels and record-list
alternatives; critical values are available without hovering. No new ornamental
animation is introduced.

Apple design references consulted: accessibility, layout, typography, color,
designing for iOS, charting data, charts, lists and tables, entering data, and the
cross-platform translation. Their legibility, adaptable layout, progressive
disclosure and chart interaction principles apply to this web application;
native macOS menu-bar conventions do not.

Regular width:

```text
App navigation | Sales analytics                 Refresh / Export
               | Dashboard / floor / entity / reports destinations
               | Period / date basis / filter disclosure
               | Confirmed sales | Orders | Buyers | Average order
               | Sales trend                 | Floor contribution
               | Company / architect / product / customer rankings
               | Floor comparison and supporting records
```

Compact width:

```text
Compact app header
Sales analytics       Export
Destination disclosure / Filters
Sales       Orders
Buyers      Average order
Full-width trend
Full-width floor comparison / rankings
Record cards, with all secondary fields accessible
Existing bottom navigation
```

## Data and navigation contract

- Stable entity IDs drive joins and links; names remain display labels.
- Confirmed customer orders are separate from quotation pipeline and supplier POs.
- Actual selected-period source data drives KPI totals, trends and rankings.
- Missing dates, attribution, amounts and unsupported metrics are disclosed.
- Furniture remains RNB; it cannot be added to INR or used as an INR percentage.
- Use existing source-floor allocation and single recorded referrer attribution;
  ambiguous historical mappings require review rather than invented allocations.
- Date range, date basis, floor, entity dimensions, status, search, sort and paging
  belong in the URL and carry through drilldowns, Back and exports.
- The backend enforces floor/role permissions for dashboards, direct entity/order
  URLs, supporting records and downloads. UI visibility is not authorization.
- PDF and Excel use the same filtered data foundation as the visible report.
  Exports include entity IDs, active scope, date basis and generation timestamp.
- Reports store a local account-scoped history of report configurations; financial
  records remain authoritative on the backend.

## Delivery and verification

Implement and verify five dashboards, four entity directories/profiles, source
record views, individual order details, reports and global export. Preserve old
bookmarks and the operational dashboard's follow-up actions. Acceptance evidence
is recorded in `docs/audits/2026-10-29-sales-analytics.md`.

The specification's D11 production-release condition remains a separate gate:
owner-approved pilot, successful backup/restore test and explicit owner-only
release authorization. A local implementation or test pass is not production
publication.
