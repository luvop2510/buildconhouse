// BuildCon House · Design System V1 tokens.
// Blue actions and a calm white/graphite surface foundation.
// One system face, touch-first controls and predictable spacing across workflows.
// Everything downstream (primitives, screens) references these tokens; no hardcoded hex.

import { color, radius as designRadius, font as designFont, shadow as designShadow } from "@/src/design/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// Palette (raw)
// ─────────────────────────────────────────────────────────────────────────────
// Compatibility palette: source shared roles from the canonical design tokens.
// Existing imports keep working without maintaining a second visual system.
const palette = {
  blue50: color.brassTint, blue100: color.brassTint, blue200: color.brassLine,
  blue500: color.action, blue600: color.action, blue700: color.actionHover, blue900: color.actionHover,
  gray0: color.surface, gray15: color.canvas, gray25: color.sunken,
  gray50: color.sunken, gray75: color.sunkenDeep, gray100: color.line,
  gray150: color.lineStrong, gray200: color.lineStrong, gray400: color.inkFaint,
  gray500: color.inkSoft, gray600: color.inkMid, gray700: color.inkMid,
  gray800: color.ink, gray900: color.ink,
  green50: color.okTint, green100: "#D6E5DB", green600: color.ok, green700: color.ok,
  amber50: color.warnTint, amber100: "#EFE0C4", amber600: color.warn, amber700: color.warn,
  red50: color.riskTint, red100: "#F0DAD4", red600: color.risk, red700: color.risk,
  sky50: color.brassTint, sky100: color.brassLine, sky600: color.action, sky700: color.actionHover,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Semantic color roles — the ONLY thing screens should reference.
// ─────────────────────────────────────────────────────────────────────────────
export const colors = {
  // Surfaces (page → card → nested) — aliases of the shared palette
  surface: palette.gray15,             // neutral page background
  surfaceSecondary: palette.gray0,     // #FFFFFF — cards, sheets, elevated
  surfaceTertiary: palette.gray25,     // hover fill on white cards
  surfaceInverse: palette.gray900,     // dark heroes, inverse chips
  surfaceRaised: palette.gray0,        // synonym for elevated card
  surfaceSubtle: palette.gray15,       // table zebra / muted panel

  // Text
  onSurface: palette.gray900,          // primary text
  onSurfaceSecondary: palette.gray700, // secondary text
  onSurfaceMuted: palette.gray500,     // captions, hints
  onSurfaceSubtle: palette.gray400,    // placeholders, disabled
  onSurfaceInverse: palette.gray0,     // text on dark

  // Primary actions — blue; legacy brand names remain compatible
  brand: palette.blue600,
  brandHover: palette.blue700,
  brandTint: palette.blue50,
  brandTintStrong: palette.blue100,
  brandBorder: palette.blue200,
  onBrand: palette.gray0,
  brandSecondary: palette.gray900,     // neutral secondary CTA

  // Borders & dividers — shared neutral separators
  border: palette.gray100,             // default separator
  controlBorder: color.controlBorder, // input boundaries, not panel separators
  borderStrong: palette.gray150,       // hovered/emphasized
  borderMuted: "rgba(15, 23, 42, 0.06)",
  divider: palette.gray100,

  // Focus and selection — the shared blue accent
  focusRing: color.focus,
  selection: color.brassTint,

  // Overlays & scrims
  overlay: "rgba(26, 23, 18, 0.44)",
  overlaySoft: "rgba(26, 23, 18, 0.16)",

  // Semantic — foreground and matching background wash
  success: palette.green700,
  successFg: palette.green700,
  successBg: palette.green50,
  successBorder: palette.green100,

  warning: palette.amber700,
  warningFg: palette.amber700,
  warningBg: palette.amber50,
  warningBorder: palette.amber100,

  error: palette.red700,
  errorFg: palette.red700,
  errorBg: palette.red50,
  errorBorder: palette.red100,

  info: palette.sky700,
  infoFg: palette.sky700,
  infoBg: palette.sky50,
  infoBorder: palette.sky100,

  // Aliases (backwards compat — some screens still reference these names)
  brandTertiary: palette.gray100,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Spacing — canonical 4pt grid.
// Approved scale: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48
// Nothing off-grid is allowed. Legacy alphabetic names kept for backwards-compat.
// ─────────────────────────────────────────────────────────────────────────────
export const spacing = {
  // Canonical numeric scale — prefer these in new code
  s4: 4,
  s8: 8,
  s12: 12,
  s16: 16,
  s20: 20,
  s24: 24,
  s32: 32,
  s40: 40,
  s48: 48,

  // Legacy alphabetic aliases (retained for existing screens; do not use in new code)
  xxs: 2,     // deprecated — will be removed
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  huge: 64,   // deprecated — use s48 or compose
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Radii — geometric, product-consistent.
// ─────────────────────────────────────────────────────────────────────────────
export const radius = { xs: 4, sm: designRadius.sm, md: designRadius.lg,
  lg: designRadius.xl, xl: designRadius.xl, pill: designRadius.pill } as const;

// Shared landscape frame for all product imagery.
export const PRODUCT_IMAGE_ASPECT_RATIO = 16 / 10;

// ─────────────────────────────────────────────────────────────────────────────
// Elevation — LOCKED to 4 subtle levels + none. Very subtle only. No garish shadows.
//   low      = e1  resting card (barely visible, 1px offset)
//   medium   = e2  sticky toolbar / floating pill
//   high     = e3  sheets, modals
//   overlay  = e4  popovers, dropdowns lifted above sheets
// Every card in the app uses ONE of these.
// ─────────────────────────────────────────────────────────────────────────────
const flat = { shadowColor: "transparent", shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 };
export const elevation = { none: flat, low: flat, hairline: flat,
  medium: designShadow.raised, high: designShadow.overlay, overlay: designShadow.overlay } as const;

// Legacy alias — some existing screens reference `shadow.soft` etc.
export const shadow = {
  hair: elevation.hairline,
  soft: elevation.low,
  lifted: elevation.medium,
  strong: elevation.high,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Motion — LOCKED to the V2 spec.
//   press      → button press feedback                        (80ms)
//   hover      → chip toggles, card hover fills, link hover    (120ms)
//   modal      → modal enter/exit                              (180ms)
//   drawer     → sheet enter/exit                              (220ms)
//   page       → route transitions                             (220ms)
//   base/fast/slow/instant kept as aliases for existing screens.
//   spring / springSoft → interactive drag/reorder (physics)
// Card-hover: scale 1.01 only. No other size transforms allowed.
// Every drawer, dialog, dropdown, hover, button, and page transition MUST pick one.
// ─────────────────────────────────────────────────────────────────────────────
export const motion = {
  press:   { duration: 90,  easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  hover:   { duration: 140, easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  modal:   { duration: 200, easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  drawer:  { duration: 200, easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  page:    { duration: 200, easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  // Card hover scale
  cardHoverScale: 1.01,
  // Legacy aliases
  instant: { duration: 90,  easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  fast:    { duration: 140, easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  base:    { duration: 200, easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  slow:    { duration: 320, easing: "cubic-bezier(0.2, 0.0, 0.0, 1.0)" },
  spring:  { damping: 22, stiffness: 260, mass: 0.9 },
  springSoft: { damping: 18, stiffness: 160, mass: 0.9 },
  easeStandard: "cubic-bezier(0.2, 0.0, 0.0, 1.0)",
  easeEmphasized: "cubic-bezier(0.05, 0.7, 0.1, 1.0)",
  easeDecel: "cubic-bezier(0.0, 0.0, 0.2, 1.0)",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Font families — one native system face shared with the canonical design tokens.
// Weight stays explicit in each text style, so all roles use the same family.
// ─────────────────────────────────────────────────────────────────────────────
export const font = {
  regular: designFont.regular,
  medium: designFont.medium,
  semibold: designFont.semibold,
  bold: designFont.bold,
  sans: designFont.regular,
  mono: designFont.mono,
  systemSans: designFont.regular,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Typography scale — hierarchy through weight & size, not decoration.
// Every style pre-composes fontFamily so screens never re-declare it.
// ─────────────────────────────────────────────────────────────────────────────
export const type = {
  // Display — hero moments, splash, empty-state headlines
  displayXl: { fontFamily: font.bold, fontSize: 40, lineHeight: 48, letterSpacing: -0.8, color: colors.onSurface, fontWeight: "700" as const },
  displayLg: { fontFamily: font.bold, fontSize: 32, lineHeight: 40, letterSpacing: -0.6, color: colors.onSurface, fontWeight: "700" as const },
  displayMd: { fontFamily: font.bold, fontSize: 24, lineHeight: 32, letterSpacing: -0.4, color: colors.onSurface, fontWeight: "700" as const },

  // Titles — page headings, card headers
  titleLg: { fontFamily: font.semibold, fontSize: 20, lineHeight: 28, letterSpacing: -0.2, color: colors.onSurface, fontWeight: "600" as const },
  titleMd: { fontFamily: font.semibold, fontSize: 17, lineHeight: 24, letterSpacing: -0.1, color: colors.onSurface, fontWeight: "600" as const },
  titleSm: { fontFamily: font.semibold, fontSize: 15, lineHeight: 22, color: colors.onSurface, fontWeight: "600" as const },

  // Body
  bodyLg: { fontFamily: font.regular, fontSize: 16, lineHeight: 24, color: colors.onSurface, fontWeight: "400" as const },
  body:   { fontFamily: font.regular, fontSize: 16, lineHeight: 24, color: colors.onSurface, fontWeight: "400" as const },
  bodyStrong: { fontFamily: font.medium, fontSize: 16, lineHeight: 24, color: colors.onSurface, fontWeight: "500" as const },
  bodyMuted: { fontFamily: font.regular, fontSize: 16, lineHeight: 24, color: colors.onSurfaceMuted, fontWeight: "400" as const },
  bodySm: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.onSurface, fontWeight: "400" as const },

  // Meta
  caption: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.onSurfaceMuted, fontWeight: "400" as const },
  captionStrong: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: colors.onSurfaceSecondary, fontWeight: "500" as const },
  overline: { fontFamily: font.semibold, fontSize: 10, lineHeight: 14, color: colors.onSurfaceMuted, letterSpacing: 1.2, textTransform: "uppercase" as const, fontWeight: "600" as const },
  label: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: colors.onSurfaceSecondary, fontWeight: "500" as const },

  // Numeric (tabular)
  mono:    { fontFamily: font.mono, fontSize: 13, lineHeight: 18, color: colors.onSurface, fontVariant: ["tabular-nums"] as any },
  monoLg:  { fontFamily: font.mono, fontSize: 18, lineHeight: 24, color: colors.onSurface, fontWeight: "600" as const, fontVariant: ["tabular-nums"] as any },
  numeric: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, color: colors.onSurface, fontWeight: "600" as const, fontVariant: ["tabular-nums"] as any },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Layout tokens
// ─────────────────────────────────────────────────────────────────────────────
export const layout = {
  hitSlop: { top: 8, bottom: 8, left: 8, right: 8 },
  tapTarget: 44,
  screenPadding: { phone: spacing.lg, tablet: spacing.xl },
  maxContentWidth: 1280,
  tabBarHeight: 60,
  headerHeight: 56,
  // Card language — every card in the app uses ONE of these interior padding values.
  cardPadding: { compact: spacing.md, base: spacing.lg, spacious: spacing.xl },
  // Sheet language — same header/footer chrome everywhere.
  sheet: {
    drawerWidth: 460,       // right-anchored on desktop
    drawerWidthWide: 560,   // for detail drawers
    headerHeight: 56,
    footerHeight: 68,
    padding: spacing.xl,
    modalMaxWidth: 520,
  },
  // Table language — every table shares row height & header height.
  table: {
    headerHeight: 44,
    rowHeight: 56,
    rowHeightCompact: 44,
    cellPaddingX: spacing.lg,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Icon scale — one weight, one line-thickness (Feather). Six approved sizes.
// Use `icon.<name>` everywhere. Never pass a raw number to <Feather size={...} />.
// ─────────────────────────────────────────────────────────────────────────────
export const icon = {
  xs: 12,   // dense inline (badge inner icon)
  sm: 14,   // captions, list-row hint
  md: 16,   // body-inline, button 40px
  lg: 18,   // button 44px, sub-titles
  xl: 20,   // page-level actions
  hero: 28, // empty-state, hero cards
  display: 40, // large hero moments
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
export const money = (v: number, currency = "₹") =>
  `${currency}${Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

export const moneyShort = (v: number, currency = "₹") => {
  const n = Number(v || 0);
  if (Math.abs(n) >= 10000000) return `${currency}${(n / 10000000).toFixed(2)} Cr`;
  if (Math.abs(n) >= 100000) return `${currency}${(n / 100000).toFixed(2)} L`;
  return `${currency}${n.toLocaleString("en-IN")}`;
};

export const roleLabels: Record<string, string> = {
  owner: "Owner", admin: "Admin", manager: "Manager", sales: "Sales",
  purchase: "Purchase", warehouse: "Warehouse", accounts: "Accounts", worker: "Worker",
};

// Status meta — used across quotations, orders, payments.
export const statusMeta: Record<string, { label: string; bg: string; fg: string; border?: string }> = {
  draft:            { label: "Draft",           bg: palette.gray75,   fg: palette.gray700,  border: palette.gray100 },
  pending_approval: { label: "Pending Approval", bg: palette.amber50,  fg: palette.amber700, border: palette.amber100 },
  approved:         { label: "Approved",        bg: palette.green50,  fg: palette.green700, border: palette.green100 },
  rejected:         { label: "Rejected",        bg: palette.red50,    fg: palette.red700,   border: palette.red100 },
  sent:             { label: "Sent",            bg: palette.blue50,   fg: palette.blue700,  border: palette.blue100 },
  won:              { label: "Won",             bg: palette.green50,  fg: palette.green700, border: palette.green100 },
  lost:             { label: "Lost",            bg: palette.red50,    fg: palette.red700,   border: palette.red100 },
  expired:          { label: "Expired",         bg: palette.gray75,   fg: palette.gray500,  border: palette.gray100 },
  ordered:          { label: "Confirmed",       bg: palette.blue50,   fg: palette.blue700,  border: palette.blue100 },
  in_transit:       { label: "In Transit",      bg: palette.sky50,    fg: palette.sky700,   border: palette.sky100 },
  delivered:        { label: "Delivered",       bg: palette.green50,  fg: palette.green700, border: palette.green100 },
  paid:             { label: "Paid",            bg: palette.green50,  fg: palette.green700, border: palette.green100 },
  partial:          { label: "Partial",         bg: palette.amber50,  fg: palette.amber700, border: palette.amber100 },
  due:              { label: "Due",             bg: palette.red50,    fg: palette.red700,   border: palette.red100 },
  overdue:          { label: "Overdue",         bg: palette.red50,    fg: palette.red700,   border: palette.red100 },
};

// Brand identity
export const brand = {
  name: "BuildCon House",
  short: "BuildCon",
  tagline: "Let you live better",
  monogram: "BC",
} as const;

// Backwards-compat: some files still import `palette` internals; expose read-only.
export const _palette = palette;
