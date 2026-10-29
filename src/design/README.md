# Buildcon House interface system

This file replaces the previous showroom design direction. It is the app-wide contract for every floor, workflow, dialog and analytics page. Mobile is the default: most people use the app on a phone. Desktop uses the same language with more room for comparison.

## Foundations

Use `src/design/tokens.ts` as the canonical source. `src/theme/tokens.ts` adapts its roles for legacy consumers. Do not introduce another palette, type family or spacing scale in a screen.

- Typography: the platform system face for every text role. Apple devices use San Francisco through `System` / `-apple-system`; other devices use their system sans. No bundled imitation or downloaded Apple fonts. Weights are explicit (400 body, 500 labels, 600 headings); data uses tabular figures in the same face. Icon glyph fonts are preserved separately.
- Type scale: 12px metadata, 14px secondary content, 16px mobile input/body, 18–20px section headings, 24px phone page titles and 28px regular titles. Text wraps and scales; never disable zoom. Small labels are supporting content, never the only explanation.
- Canvas `#F5F5F7`, surface `#FFFFFF`, primary text/action `#1D1D1F`, secondary text `#545458`, supporting text `#626267`, separators `#E2E2E7`. Text against white has contrast approximately 16.8:1, 7.6:1 and 6.1:1 respectively. Chart/focus teal `#22766D` is approximately 5.4:1 on white. Use roles rather than raw colors in components.
- Semantic status colors retain their own labels/icons. A zero or unavailable value is neutral. Color alone never conveys a state or identifies a series.
- Use the existing Feather outline family consistently. Typical sizes are 16px for inline affordances, 18px for controls, 20px for navigation. Hide decorative glyphs from accessibility; name icon-only controls. Avoid emoji, tinted icon tiles and competing icon families.
- Spacing follows 4/8px increments. Phone gutters 16px, inter-control gaps at least 8px, panel padding 16px, regular panel padding 24px, section gap 16–24px. Use shared token aliases. Keep equal metrics aligned with equal padding and radius; use a 12px panel radius and an 8px inset/control radius.

## Mobile structure

A phone page has one vertical scroll owner. Its title, filter summary and content scroll together below the shared app header. Keep the screen's primary job visible early: Today starts with scheduled work and task progress; owner analytics starts with its metric group and primary chart; an editor starts with its active task. Use two-column metrics only while labels and complete values fit. Secondary filters open a sheet; do not stack several complete filter forms above the data. Phone navigation keeps icon and text labels and uses existing floor/grant checks.

Buttons and text fields default to comfortable 44–48px targets. Charts support tap, keyboard controls and a readable data alternative. Lists retain identity and values by wrapping secondary information onto another line. Never rely on hover, truncate essential financial values, or create page-level horizontal scrolling. Tables may scroll only inside a bounded table frame when their meaning requires columns.

The breakpoint authority is `responsive.ts`: 768 / 1024 / 1366. Start with one content column; introduce two columns only when each remains useful, then additional comparison columns on desktop. Quotation editors continue to use measured container widths. Layout must survive 320px, landscape and enlarged text without hiding actions or drafts.

## Common components

`controls.tsx`, `forms.tsx` and the legacy `ui.tsx` adapter own controls. `typography.tsx` and AppText own type. `PageHeader`, `AdminPage` and `Screen` own page structure. `Overlay` owns safe areas, focus containment/restoration, Escape and sheet behavior. `NavigationTabs` / navigation controls own selected state and keyboard behavior. Retain those boundaries.

Navigation and row actions use graphite text, clear selected states, chevrons and restrained hover/press fills. Blue underlined labels and breadcrumb trails are removed from sales analytics. Use a single Back action for detail screens. Preserve meaningful document links and existing access checks.

Resting panels use a quiet border and a consistent surface. Shadows belong to floating overlays. Motion is brief, optional and interruptible; existing reduced-motion hooks and `prefers-reduced-motion` apply. No decorative chart animation delays access to values. The current theme is light; do not claim dark appearance support without a complete semantic theme and device verification.

## Data and owner overview

Today is a floor work dashboard. Department-limited staff see their permitted tasks and progress. Staff with access to every department on a floor see that floor's operational overview and payments; they do not inherit another floor's data. Sales Data and the company analytics overview are owner-only. Enforce this in server reads, direct routes and navigation, including an immediate floor switch while an earlier request is pending. An empty task list must not fall back to sales analytics.

Owner sales dashboards share `AnalyticsDashboard`. The supplied dashboard reference informs grouping and alignment; it does not determine permissions or require every screen to contain charts. Use a bento composition when adjacent panels answer related questions: a wide work queue with a narrower floor summary, or a sales trend with a meaningful comparison. Stack in reading order on phones. Omit self-comparison charts for a single floor and decorative metrics that duplicate the adjacent list. Business data replaces every sample statistic. Detailed source directories remain available through Explore data.

Confirmed-sales totals exclude drafts and supplier purchase orders. Every chart reads the same API model as its labels and supporting records. Time filters use India calendar boundaries. Missing values stay unavailable; do not create growth, targets, progress rates or activity that was not recorded. The RNB ledger is visible in explicit Furniture analysis and a dedicated Furniture section of the company overview. Never add RNB to INR, compare their amounts on a shared scale, or repeat RNB zero under non-furniture metrics.

Current team workload is a separate read and visibly separate time basis from period sales. Assignments describe current responsibility; recorded contacts/calls describe actual actor effort. Completed history is not a fabricated completion rate. Failure in one section exposes retry and preserves the rest.

## Finish gate

Review real rendered output at compact, tablet and desktop sizes. Check labels, focus order, enlarged text, currency wrapping, safe-area clearance and tap affordances. Run focused domain contracts first, then the existing required performance/stability gate once for the final source. Preserve auth, floor isolation, optimistic recovery and in-flight drafts while changing visual structure.

Use [the interface acceptance checklist](../../docs/design/interface-acceptance.md) for the page/viewpoint matrix, chart rules, loading states and reusable evidence requirements. Use [affected checks](../../docs/affected-checks.md) for development feedback; cached focused passes do not replace final release acceptance. Historical audits and reference previews are evidence of their original revision, not alternate style contracts.

Apple HIG principles used: `charting-data.md` (simple charts and descriptive context), `charts.md` (labels, keyboard exploration and accessible values), `typography.md` (consistent readable type), `layout.md` (adaptation), `icons.md` (consistent visual language), `motion.md` (optional purposeful motion), and `accessibility.md` (operable controls). The web/native translation uses existing React Native primitives rather than requiring web-only shadcn components.
