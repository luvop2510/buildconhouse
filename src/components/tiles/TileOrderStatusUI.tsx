// frontend/src/components/tiles/TileOrderStatusUI.tsx
// Shared building blocks for every Tile Orders screen: the overall_status
// pill (business-language label, see statusLabel()), the waiting-days
// ageing badge (green/amber/red per the design doc's 0-7/8-14/15+ bands),
// and the per-line box-counter rows.
//
// Tile Orders workflow redesign (2026-08): the ladder value stored on the
// backend (Pending/Ready/Partially Dispatched/Dispatched/Delivered) is
// unchanged, but staff never see those words — statusLabel() translates
// them to the business vocabulary confirmed with BuildCon (Released instead
// of Ready, Delivered instead of Dispatched). The box-counter row is split
// into a Brand-page version (Ordered/Released/Remaining) and a
// Customer-page version (Ordered/Released/Godown/Delivered) — no more
// generic Ready/Dispatched/Pending counters.
import { View } from "react-native";
import { Text } from "@/src/components/AppText";

import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import type { AgeingBand, CustomerOrderBrand, TileOverallStatus } from "@/src/api/tileOrders";

const STATUS_COLORS: Record<TileOverallStatus, { fg: string; bg: string; border: string }> = {
  Pending: { fg: colors.onSurfaceMuted, bg: colors.surfaceSecondary, border: colors.border },
  Ready: { fg: colors.infoFg, bg: colors.infoBg, border: colors.infoBorder },
  "Partially Dispatched": { fg: colors.warningFg, bg: colors.warningBg, border: colors.warningBorder },
  Dispatched: { fg: colors.infoFg, bg: colors.infoBg, border: colors.infoBorder },
  Delivered: { fg: colors.successFg, bg: colors.successBg, border: colors.successBorder },
};

// Backend ladder word -> business word BuildCon staff actually use.
//
// "Dispatched" is NOT relabelled to "Delivered" (it was until 2026-07-31).
// Dispatch and Delivery are two separate, separately-recorded steps of the
// workflow — material on a truck is not material a customer has signed
// for — and collapsing them meant an operator could never tell the two
// apart on any screen, and the real Delivered state (set by
// POST /tile-orders/dispatches/{id}/delivered) had no way to show itself.
export function statusLabel(status: TileOverallStatus): string {
  switch (status) {
    case "Pending": return "Pending";
    case "Ready": return "Released";
    case "Partially Dispatched": return "Partially Dispatched";
    case "Dispatched": return "Dispatched";
    case "Delivered": return "Delivered";
    default: return status;
  }
}

// A pill is a 24px-tall object with 10px of side padding: tall enough to read
// as a deliberate badge rather than tight-wrapped text, short enough that a
// 56px table row still breathes around it.
const pillShell = {
  alignSelf: "flex-start" as const,
  height: 24,
  justifyContent: "center" as const,
  paddingHorizontal: 10,
  borderRadius: radius.pill,
  borderWidth: 1,
};

export function StatusPill({ status }: { status: TileOverallStatus }) {
  const palette = STATUS_COLORS[status] || STATUS_COLORS.Pending;
  // Purchase orders raised before the box-counter redesign carry no
  // overall_status at all; without this they rendered as an empty pill.
  const label = statusLabel(status) || "Pending";
  return (
    <View style={{ ...pillShell, backgroundColor: palette.bg, borderColor: palette.border }}>
      <Text numberOfLines={1} style={[type.captionStrong, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

const AGEING_COLORS: Record<AgeingBand, { fg: string; bg: string; border: string }> = {
  green: { fg: colors.successFg, bg: colors.successBg, border: colors.successBorder },
  amber: { fg: colors.warningFg, bg: colors.warningBg, border: colors.warningBorder },
  red: { fg: colors.errorFg, bg: colors.errorBg, border: colors.errorBorder },
};

export function AgeingBadge({ days, band, compact }: { days: number; band: AgeingBand; compact?: boolean }) {
  const palette = AGEING_COLORS[band];
  // Inside a table cell the word "waiting" is already supplied by the column
  // header, so the badge drops to just the figure and keeps the column narrow.
  const label = compact ? `${days}d` : `${days} day${days === 1 ? "" : "s"} waiting`;
  return (
    <View style={{ ...pillShell, backgroundColor: palette.bg, borderColor: palette.border }}>
      <Text numberOfLines={1} style={[type.captionStrong, { color: palette.fg, fontVariant: ["tabular-nums"] }]}>
        {label}
      </Text>
    </View>
  );
}

function Cell({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <View style={{ alignItems: "center", flex: 1 }}>
      <Text style={[type.numeric as any, emphasis ? { color: colors.brand } : null]}>{value}</Text>
      <Text style={[type.bodyMuted, { fontSize: 11 }]}>{label}</Text>
    </View>
  );
}

// Brand page — its ONLY job is Release Material, so it only ever shows
// what's left to release. No Godown/Dispatched columns here; those
// decisions belong to BuildCon on the Customer page.
export function BrandBoxCounterRow({ ordered, released, remaining }: { ordered: number; released: number; remaining: number }) {
  return (
    <View style={{ flexDirection: "row", paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.divider }}>
      <Cell label="Ordered" value={ordered} />
      <Cell label="Released" value={released} emphasis />
      <Cell label="Remaining" value={remaining} />
    </View>
  );
}

// Customer page — BuildCon operations. Shows every bucket a box can be in
// once the Brand has released it: still-Released (in the brand's stock
// pipeline, available to move), at BuildCon's own Godown, or Delivered to
// the customer.
export function CustomerBoxCounterRow({ ordered, released, godown, delivered }: { ordered: number; released: number; godown: number; delivered: number }) {
  return (
    <View style={{ flexDirection: "row", paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.divider }}>
      <Cell label="Ordered" value={ordered} />
      <Cell label="Released" value={released} emphasis={released > 0} />
      <Cell label="Godown" value={godown} emphasis={godown > 0} />
      <Cell label="Delivered" value={delivered} />
    </View>
  );
}

type WorkflowStage = "quotation" | "release" | "released" | "godown" | "dispatch" | "register" | "chalan" | "delivered";
const WORKFLOW_STEPS: { key: WorkflowStage; label: string }[] = [
  { key: "quotation", label: "Quotation" },
  { key: "release", label: "Brand release" },
  { key: "released", label: "Released" },
  // "Godown / direct" was long enough to run into the next step's label at
  // desktop widths; the step means the same thing at half the length.
  { key: "godown", label: "Godown" },
  { key: "dispatch", label: "Dispatch" },
  { key: "register", label: "Register" },
  { key: "chalan", label: "Chalan" },
  { key: "delivered", label: "Delivered" },
];

// The rail is the operator's "where is this order" answer, so it gets real
// width: each step claims an equal share and the connector between two steps
// stretches to fill whatever is left. Previously every step was content-width
// with a fixed 10px stub connector and a 4px gap, which collapsed the whole
// workflow into an unreadable 8-word run and wrapped raggedly under 1100px.
//
// Eight labels cannot fit side by side below roughly 1000px, and shrinking
// them just produces "Quotati…"/"Godow…". So under that width the rail states
// the same fact in the form that does fit: which step, out of how many, and
// how far along.
export function WorkflowRail({ active, testID }: { active: WorkflowStage; testID?: string }) {
  const { isDesktop } = useBreakpoint();
  const current = Math.max(0, WORKFLOW_STEPS.findIndex((step) => step.key === active));

  if (!isDesktop) {
    const percent = Math.round(((current + 1) / WORKFLOW_STEPS.length) * 100);
    return (
      <View testID={testID} style={workflowStyles.compactRail}>
        <View style={workflowStyles.compactHeader}>
          <Text style={workflowStyles.compactLabel}>{WORKFLOW_STEPS[current].label}</Text>
          <Text style={workflowStyles.compactCount}>
            Step {current + 1} of {WORKFLOW_STEPS.length}
          </Text>
        </View>
        <View style={workflowStyles.compactTrack}>
          <View style={[workflowStyles.compactFill, { width: `${percent}%` }]} />
        </View>
      </View>
    );
  }

  return (
    <View testID={testID} style={workflowStyles.rail}>
      {WORKFLOW_STEPS.map((step, index) => {
        const isActive = index === current;
        const isComplete = index < current;
        return (
          <View key={step.key} style={workflowStyles.step}>
            <View style={workflowStyles.markerRow}>
              <View
                style={[
                  workflowStyles.dot,
                  isComplete ? workflowStyles.dotComplete : null,
                  isActive ? workflowStyles.dotActive : null,
                ]}
              />
              {index < WORKFLOW_STEPS.length - 1 ? (
                <View style={[workflowStyles.line, isComplete ? workflowStyles.lineActive : null]} />
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={[workflowStyles.label, isActive ? workflowStyles.labelActive : null]}
            >
              {step.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function BrandStatusChips({ brands }: { brands: CustomerOrderBrand[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
      {brands.map((brand) => (
        <View key={brand.purchase_order_id} style={{
          flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2, paddingHorizontal: spacing.sm,
          borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
        }}>
          <Text style={type.bodySm}>{brand.brand_name}</Text>
          <StatusPill status={brand.status} />
        </View>
      ))}
    </View>
  );
}

const workflowStyles = {
  rail: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.s20,
    paddingVertical: spacing.lg,
  },
  // Equal shares, so the eight steps span the card evenly instead of
  // bunching wherever the label text happens to be shortest.
  step: { flex: 1, minWidth: 0, gap: spacing.sm },
  markerRow: { flexDirection: "row" as const, alignItems: "center" as const },
  dot: {
    width: 10, height: 10, borderRadius: 5,
    borderWidth: 2, borderColor: colors.borderStrong, backgroundColor: colors.surfaceSecondary,
  },
  dotComplete: { backgroundColor: colors.brand, borderColor: colors.brand },
  // The current step reads as a ring rather than a filled dot — "here", not "done".
  dotActive: { backgroundColor: colors.surfaceSecondary, borderColor: colors.brand },
  // The trailing gutter guarantees two adjacent step labels can never touch,
  // whatever the card width divides into.
  label: { ...type.caption, fontSize: 12, color: colors.onSurfaceMuted, paddingRight: spacing.s12 },
  labelActive: { color: colors.brandHover, fontWeight: "600" as const },
  line: { flex: 1, height: 2, backgroundColor: colors.border, marginHorizontal: spacing.sm },
  lineActive: { backgroundColor: colors.brand },

  compactRail: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.s20,
    paddingVertical: spacing.lg,
    gap: spacing.s12,
  },
  compactHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: spacing.s12,
  },
  compactLabel: { ...type.titleSm, color: colors.brandHover },
  compactCount: { ...type.caption, fontVariant: ["tabular-nums"] as any },
  compactTrack: {
    height: 6,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.pill,
    overflow: "hidden" as const,
  },
  compactFill: { height: "100%" as const, backgroundColor: colors.brand, borderRadius: radius.pill },
};
