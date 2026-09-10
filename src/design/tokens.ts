// ─────────────────────────────────────────────────────────────────────────────
// BuildCon House · Workspace Design System — the single source of truth.
//
// Calm neutral surfaces, readable system typography and one blue action accent.
// Legacy brass keys remain aliases so every existing module shares this palette.
//
// Every module MUST consume these tokens. Zero local styling downstream.
// ─────────────────────────────────────────────────────────────────────────────
import { Platform, StyleSheet } from "react-native";

// ── Raw palette (never import this from screens — use `color`) ──────────────
const pal = {
  // Neutral surfaces and contrast-tested foregrounds.
  white:   "#FFFFFF",
  canvas:  "#F5F5F7",  // app background — warm gallery wall
  sunken:  "#EEEEF2",  // inset fills: inputs, washes, rails
  sunken2: "#E4E5EB",  // pressed / deeper inset
  line:    "#E1E2E7",  // hairline
  line2:   "#C5C7D0",  // emphasized hairline
  ink:     "#1D1D1F",  // warm near-black — text & the primary action
  ink2:    "#515158",  // secondary text
  ink3:    "#686870",  // tertiary text, captions
  ink4:    "#787880",  // placeholders, disabled
  inkHover:"#333336",

  // Action accent. Brass names are retained for source compatibility.
  brass:      "#0066CC",
  brassDeep:  "#004F9F",
  brassTint:  "#EAF2FF",
  brassLine:  "#BED6F7",

  // Muted status hues — always dot+word, never shouting pills.
  ok:      "#3E7C55",
  okTint:  "#EAF1EC",
  warn:    "#8B5A16",
  warnTint:"#F6EEDF",
  risk:    "#AE4A3D",
  riskTint:"#F7ECE9",
} as const;

// ── Semantic color roles ─────────────────────────────────────────────────────
export const color = {
  canvas: pal.canvas,
  surface: pal.white,
  sunken: pal.sunken,
  sunkenDeep: pal.sunken2,
  line: pal.line,
  lineStrong: pal.line2,

  ink: pal.ink,
  inkMid: pal.ink2,
  inkSoft: pal.ink3,
  inkFaint: pal.ink4,

  // The primary action is brass; ink remains text/chrome.
  action: pal.brass,
  actionHover: pal.brassDeep,
  onAction: pal.white,

  // Brass — guidance & emphasis. Active nav bar, focus ring, selected marks.
  brass: pal.brass,
  brassDeep: pal.brassDeep,
  brassTint: pal.brassTint,
  brassLine: pal.brassLine,
  focus: "#0066CC",

  ok: pal.ok,
  okTint: pal.okTint,
  warn: pal.warn,
  warnTint: pal.warnTint,
  risk: pal.risk,
  riskTint: pal.riskTint,

  scrim: "rgba(26,23,18,0.44)",
  hoverWash: "rgba(29,27,22,0.045)",
  pressWash: "rgba(29,27,22,0.08)",
} as const;

// ── Fonts ────────────────────────────────────────────────────────────────────
export const font = {
  regular: Platform.OS === "web" ? "system-ui" : "Inter-Regular",
  medium: Platform.OS === "web" ? "system-ui" : "Inter-Medium",
  semibold: Platform.OS === "web" ? "system-ui" : "Inter-SemiBold",
  bold: Platform.OS === "web" ? "system-ui" : "Inter-Bold",
  display: Platform.OS === "web" ? "system-ui" : "Inter-SemiBold",        // the single serif voice — greetings, auth
  displayItalic: Platform.OS === "web" ? "system-ui" : "Inter-Medium",
  serif: Platform.OS === "web" ? "Georgia" : "Fraunces-Regular",
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace" }) as string,
} as const;

// ── Type scale — 4pt baseline rhythm ────────────────────────────────────────
type Style = Record<string, unknown>;
const tabular = { fontVariant: ["tabular-nums"] as any };

export const text = {
  // Display — Fraunces. Two places only: greetings and auth. Never in chrome.
  display:   { fontFamily: font.display, fontSize: 34, lineHeight: 42, fontWeight: "600", letterSpacing: -0.8, color: color.ink } as Style,
  displaySm: { fontFamily: font.display, fontSize: 27, lineHeight: 34, fontWeight: "600", letterSpacing: -0.6, color: color.ink } as Style,

  // Titles
  title:    { fontFamily: font.semibold, fontSize: 19, lineHeight: 26, letterSpacing: -0.3, color: color.ink, fontWeight: "600" as const } as Style,
  heading:  { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, letterSpacing: -0.2, color: color.ink, fontWeight: "600" as const } as Style,
  rowTitle: { fontFamily: font.medium,  fontSize: 15, lineHeight: 21, letterSpacing: -0.1, color: color.ink, fontWeight: "500" as const } as Style,

  // Body
  body:    { fontFamily: font.regular, fontSize: 15, lineHeight: 22, color: color.ink } as Style,
  bodyMid: { fontFamily: font.regular, fontSize: 15, lineHeight: 22, color: color.inkMid } as Style,
  sub:     { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: color.inkMid } as Style,
  caption: { fontFamily: font.medium,  fontSize: 12, lineHeight: 16, color: color.inkSoft, fontWeight: "500" as const } as Style,
  eyebrow: { fontFamily: font.semibold, fontSize: 11, lineHeight: 14, letterSpacing: 1.3, textTransform: "uppercase" as const, color: color.inkSoft, fontWeight: "600" as const } as Style,

  // Money — always tabular. The ₹ symbol is styled by <Money/>, not here.
  moneyXl: { fontFamily: font.regular, fontSize: 30, lineHeight: 38, letterSpacing: -0.6, color: color.ink, ...tabular } as Style,
  moneyLg: { fontFamily: font.regular, fontSize: 22, lineHeight: 28, letterSpacing: -0.4, color: color.ink, ...tabular } as Style,
  money:   { fontFamily: font.medium,  fontSize: 15, lineHeight: 21, color: color.ink, fontWeight: "500" as const, ...tabular } as Style,
  moneySm: { fontFamily: font.medium,  fontSize: 13, lineHeight: 18, color: color.ink, fontWeight: "500" as const, ...tabular } as Style,

  num: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: color.inkSoft, ...tabular } as Style,
} as const;

// ── Spacing — 4pt grid ──────────────────────────────────────────────────────
export const space = {
  x1: 4, x2: 8, x3: 12, x4: 16, x5: 20, x6: 24, x8: 32, x10: 40, x12: 48, x16: 64,
} as const;

// ── Radii ───────────────────────────────────────────────────────────────────
export const radius = { sm: 7, md: 10, lg: 14, xl: 20, pill: 999 } as const;

// ── Elevation — exactly two levels. Everything else is hairlines. ───────────
export const shadow = {
  raised: {
    shadowColor: "#26221B", shadowOpacity: 0.05, shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  overlay: {
    shadowColor: "#26221B", shadowOpacity: 0.18, shadowRadius: 44,
    shadowOffset: { width: 0, height: 18 }, elevation: 16,
  },
} as const;

// ── Motion — state communication only. Nothing decorative. ─────────────────
export const motion = {
  tap: 90,        // press feedback
  quick: 140,     // hovers, small reveals
  standard: 200,  // overlays, palette, sheets
  entrance: 260,  // page-level content settle
  // For CSS-side (web) easing strings:
  easeOut: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

// ── Layout ──────────────────────────────────────────────────────────────────
export const layout = {
  hairline: StyleSheet.hairlineWidth,
  hitSlop: { top: 8, bottom: 8, left: 8, right: 8 },
  tap: 44,
  sidebar: 240,
  rail: 64,
  bottomBar: 62,
  gutter: { phone: 20, tablet: 28, desktop: 40 },
  content: 1120,          // default page max width
  contentNarrow: 760,     // reading / form pages
  // One responsive contract. Components must consume this through `useBp()`
  // instead of creating their own width thresholds.
  bp: {
    tabletPortrait: 768,
    tabletLandscape: 1024,
    desktop: 1366,
    // Backwards-compatible aliases for older primitives. New code should use
    // the explicit orientation-aware names above.
    tablet: 768,
    wide: 1366,
  },
} as const;

// ── Formatters ──────────────────────────────────────────────────────────────
export const fmtMoney = (v: number) =>
  Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

export const fmtMoneyCompact = (v: number): string => {
  const n = Number(v || 0);
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(a >= 1e8 ? 1 : 2)} Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(a >= 1e6 ? 1 : 2)} L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return fmtMoney(n);
};

// ── Status language — dot + word, one calm vocabulary for the whole app ─────
export type Tone = "ok" | "warn" | "risk" | "neutral" | "brass";
export const statusTone: Record<string, { label: string; tone: Tone }> = {
  draft:            { label: "Draft",     tone: "neutral" },
  sent:             { label: "Sent",      tone: "brass" },
  pending_approval: { label: "Approval",  tone: "warn" },
  approved:         { label: "Approved",  tone: "ok" },
  rejected:         { label: "Rejected",  tone: "risk" },
  won:              { label: "Won",       tone: "ok" },
  lost:             { label: "Lost",      tone: "risk" },
  expired:          { label: "Expired",   tone: "neutral" },
  ordered:          { label: "Confirmed", tone: "ok" },
  in_transit:       { label: "In transit",tone: "brass" },
  delivered:        { label: "Delivered", tone: "ok" },
  paid:             { label: "Paid",      tone: "ok" },
  partial:          { label: "Partial",   tone: "warn" },
  due:              { label: "Due",       tone: "risk" },
  overdue:          { label: "Overdue",   tone: "risk" },
  open:             { label: "Open",      tone: "neutral" },
  done:             { label: "Done",      tone: "ok" },
  snoozed:          { label: "Snoozed",   tone: "neutral" },
  // Payment.status (backend/models.py) — distinct from the quotation-derived
  // paid/partial/due tones above. Added for the Payment History ledger;
  // any other status-badge consumer of a raw Payment record benefits too.
  completed:        { label: "Completed", tone: "ok" },
  pending:          { label: "Pending",   tone: "warn" },
  failed:           { label: "Failed",    tone: "risk" },
} as const;

export const toneColor: Record<Tone, { fg: string; dot: string; tint: string }> = {
  ok:      { fg: color.ok,      dot: color.ok,      tint: color.okTint },
  warn:    { fg: color.warn,    dot: color.warn,    tint: color.warnTint },
  risk:    { fg: color.risk,    dot: color.risk,    tint: color.riskTint },
  neutral: { fg: color.inkMid,  dot: color.inkFaint, tint: color.sunken },
  brass:   { fg: color.brassDeep, dot: color.brass, tint: color.brassTint },
};

// ── Brand ───────────────────────────────────────────────────────────────────
export const brand = {
  name: "BuildCon House",
  tagline: "Let you live better",
} as const;
