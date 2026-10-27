import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Button, SkeletonCard } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { colors, spacing, type } from "@/src/theme/tokens";
import type { SalesQuantity } from "@/src/api/salesSummary";

export const count = (value: number) => value.toLocaleString("en-IN");
export const money = (value: number, currency: "INR" | "RNB" = "INR") => `${currency === "RNB" ? "RNB " : "₹"}${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export function quantityLabel(quantities: SalesQuantity[]) {
  return quantities.map(item => `${count(item.quantity)} ${item.unit}`).join(" · ");
}

export function ReportPanel({ title, children, actions, testID, plain = false }: { title: string; children: ReactNode; actions?: ReactNode; testID?: string; plain?: boolean }) {
  return <View testID={testID} style={{ minWidth: 0, backgroundColor: plain ? "transparent" : colors.surfaceSecondary, borderWidth: plain ? 0 : 1, borderColor: colors.border, borderRadius: plain ? 0 : 8, padding: plain ? 0 : spacing.s16, gap: spacing.s12 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: spacing.s8 }}>
      <Text accessibilityRole="header" aria-level={2} style={type.titleMd}>{title}</Text>{actions}
    </View>{children}
  </View>;
}

export function Metric({ label, value, secondaryValue, detail, testID, onPress, lead = false }: {
  label: string; value: string; secondaryValue?: string; detail?: string; testID?: string; onPress?: () => void; lead?: boolean;
}) {
  const { isPhone, isTabletPortrait } = useBp();
  const compact = isPhone || isTabletPortrait;
  const body = <><Text style={[type.bodySm, { color: colors.onSurfaceSecondary }]}>{label}</Text>
    <Text style={[lead ? type.displayLg : type.displayMd, { fontWeight: "500", fontVariant: ["tabular-nums"] }]}>{value}</Text>
    {secondaryValue ? <Text style={[type.titleLg, { fontVariant: ["tabular-nums"] }]}>{secondaryValue}</Text> : null}
    {detail && !(compact && lead) ? <Text style={type.caption}>{detail}</Text> : null}</>;
  const style = { flex: compact ? undefined : 1, flexGrow: 1, flexBasis: compact ? (lead ? "100%" as const : "45%" as const) : 0, minWidth: 0, gap: spacing.s4, padding: isPhone ? spacing.s12 : spacing.s16 };
  return onPress ? <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`${label}: ${value}${secondaryValue ? ` and ${secondaryValue}` : ""}. ${detail || "Open details"}`} onPress={onPress}
    style={({ pressed, hovered }: any) => [style, { backgroundColor: pressed || hovered ? colors.surfaceTertiary : "transparent" }]}>{body}</Pressable>
    : <View testID={testID} style={style}>{body}</View>;
}

export function SummaryError({ error, retry }: { error: string; retry: () => void }) {
  return <View style={{ gap: spacing.s12, padding: spacing.s16, backgroundColor: colors.surfaceSecondary, borderRadius: 8 }}>
    <Text accessibilityRole="alert" style={type.body}>{error}</Text><Button testID="sales-summary-retry" label="Try again" variant="secondary" onPress={retry} />
  </View>;
}
export function SummaryLoading() {
  return <View accessibilityLabel="Loading sales data" aria-busy style={{ gap: spacing.s16 }}><SkeletonCard height={104} /><SkeletonCard height={240} /></View>;
}

export function RankingRow({ name, detail, value, proportion, onPress, testID }: {
  name: string; detail?: string; value: number; proportion?: number; onPress?: () => void; testID?: string;
}) {
  const body = <>
    <View style={{ flexDirection: "row", gap: spacing.s12, alignItems: "flex-start" }}>
      <View style={{ flex: 1, minWidth: 0, gap: spacing.s4 }}><Text style={type.bodyStrong}>{name}</Text>{detail ? <Text style={type.bodySm}>{detail}</Text> : null}</View>
      <Text accessibilityLabel={money(value)} style={[type.bodyStrong, { textAlign: "right", fontVariant: ["tabular-nums"] }]}>{money(value)}</Text>
    </View>
    {proportion !== undefined ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 3, backgroundColor: colors.surfaceTertiary }}><View style={{ height: 3, width: `${Math.max(0, Math.min(1, proportion)) * 100}%`, backgroundColor: colors.brand }} /></View> : null}
  </>;
  const style = { minHeight: 60, paddingVertical: spacing.s12, gap: spacing.s8, borderBottomWidth: 1, borderBottomColor: colors.border };
  return onPress ? <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`Open ${name}`} onPress={onPress} style={({ hovered, pressed }: any) => [style, { backgroundColor: hovered || pressed ? colors.surfaceTertiary : "transparent" }]}>{body}</Pressable> : <View testID={testID} style={style}>{body}</View>;
}

export function ReportHeader({ title, subtitle, updating, refresh }: { title: string; subtitle: string; updating?: boolean; refresh: () => void }) {
  return <View style={{ gap: spacing.s4 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.s12 }}>
      <Text accessibilityRole="header" aria-level={1} style={type.displayMd}>{title}</Text>
      <Button label={updating ? "Updating…" : "Refresh"} icon="refresh-cw" variant="ghost" disabled={updating} onPress={refresh} />
    </View><Text style={type.bodyMuted}>{subtitle}</Text>
  </View>;
}
