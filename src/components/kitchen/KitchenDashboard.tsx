import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Pressable, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { ErrorState, LoadingState } from "@/src/components/ds";
import { NavigationLink } from "@/src/design/NavigationLink";
import { KITCHEN_STAGES, STAGE_LABELS, kitchenProjectsApi, type KitchenDashboard as Dashboard } from "@/src/api/kitchenProjects";
import { KitchenFloor, KitchenPage } from "./shared";
import { KitchenCustomerSearch } from "./KitchenCustomerSearch";
import { KitchenButton as Button, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";
import { useBp } from "@/src/design/responsive";

export function KitchenDashboard() { return <KitchenFloor><DashboardContent /></KitchenFloor>; }
function DashboardContent() {
  const { isPhone } = useBp();
  const [contentWidth, setContentWidth] = useState(0);
  const [snapshot, setSnapshot] = useState<{ retry: number; result: Dashboard } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const result = snapshot?.retry === retry ? snapshot.result : null;
  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    setLoading(true); setFailure(null); setSnapshot(null);
    kitchenProjectsApi.dashboard(controller.signal).then(value => { if (!controller.signal.aborted) setSnapshot({ retry, result: value }); }).catch(error => { if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : "Please try again."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]));
  const columns = contentWidth >= 600 ? 3 : contentWidth >= 280 ? 2 : 1;
  const tileWidth = contentWidth ? (contentWidth - (columns - 1) * 12) / columns : undefined;
  const tileStyle = ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({ width: tileWidth, flexGrow: 0, minWidth: 0, minHeight: 112, padding: 16, gap: 4, borderWidth: 1, borderColor: hovered || pressed ? colors.brand : colors.border, borderRadius: 8, backgroundColor: hovered || pressed ? colors.brandTint : colors.surfaceSecondary });
  const attention = [
    { key: "pending_approval", label: "Pending manager approvals", count: result?.pending_approvals },
    { key: "completion_overdue", label: "Completion overdue", count: result?.completion_overdue_projects },
    { key: "on_hold", label: "On hold", count: result?.on_hold_projects },
  ];
  return <KitchenPage title="Kitchen dashboard" compactHeader={isPhone} subtitle="Customer stages and work requiring attention." customerSearch={false} right={isPhone ? <Pressable accessibilityRole="button" accessibilityLabel="Refresh Kitchen dashboard" onPress={() => setRetry(value => value + 1)} testID="kitchen-dashboard-refresh" style={({ pressed }) => ({ minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: pressed ? colors.surfaceTertiary : "transparent" })}><Feather name="refresh-cw" size={20} color={colors.onSurfaceSecondary} /></Pressable> : <Button label="Refresh" icon="refresh-cw" variant="secondary" onPress={() => setRetry(value => value + 1)} testID="kitchen-dashboard-refresh" />}>
    <View testID="kitchen-dashboard" onLayout={event => setContentWidth(event.nativeEvent.layout.width)} style={{ gap: 24, minWidth: 0 }}>
      <KitchenCustomerSearch inline />
      {loading ? <LoadingState label="Loading Kitchen dashboard…" /> : failure ? <ErrorState title="Kitchen dashboard unavailable" subtitle={failure} onRetry={() => setRetry(value => value + 1)} /> : result ? <>
        <View style={{ gap: 8 }}><Text accessibilityRole="header" aria-level={2} style={type.titleMd}>Customers by stage</Text><Text style={type.caption}>Distinct customers per stage. One customer may have multiple projects.</Text></View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }} testID="kitchen-dashboard-stages">{KITCHEN_STAGES.map((stage, index) => <NavigationLink key={stage} href={`/kitchen/stages/${stage}` as any} testID={`kitchen-dashboard-stage-${stage}`} accessibilityLabel={`${STAGE_LABELS[stage]}: ${result.stage_customer_counts?.[stage] ?? "Customer count unavailable"} customers. View projects.`} style={tileStyle}>
          <Text style={type.bodyStrong}>{index + 1}. {STAGE_LABELS[stage]}</Text>
          <Text style={[type.titleLg, { fontVariant: ["tabular-nums"] }]} testID={`kitchen-dashboard-count-${stage}`}>{result.stage_customer_counts?.[stage] ?? "—"}</Text>
          <Text style={type.caption}>{result.stage_customer_counts?.[stage] === 1 ? "customer" : "customers"} · {result.stage_counts?.[stage] ?? 0} {result.stage_counts?.[stage] === 1 ? "project" : "projects"}</Text>
        </NavigationLink>)}</View>
        <View style={{ gap: 8 }}><Text accessibilityRole="header" aria-level={2} style={type.titleMd}>Needs attention</Text><Text style={type.caption}>Counts refer to projects and may overlap.</Text></View>
        {result.configured ? <View style={{ borderTopWidth: 1, borderColor: colors.border }}>{attention.map(item => <NavigationLink key={item.key} href={`/kitchen/projects?attention=${item.key}` as any} testID={`kitchen-dashboard-attention-${item.key}`} accessibilityLabel={`${item.label}: ${item.count ?? 0} projects`} style={({ hovered, pressed }) => ({ minHeight: 56, paddingVertical: 12, gap: 12, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderColor: colors.border, backgroundColor: hovered || pressed ? colors.surfaceTertiary : "transparent" })}><Text style={[type.bodyStrong, { flex: 1 }]}>{item.label}</Text><Text style={[type.bodyStrong, { fontVariant: ["tabular-nums"] }]}>{item.count ?? 0}</Text><Feather name="chevron-right" size={18} color={colors.onSurfaceMuted} /></NavigationLink>)}</View> : <Text style={type.bodyMuted}>{result.notice || "Configure Kitchen metrics to see attention counts."}</Text>}
        <NavigationLink href={"/kitchen/projects" as any} testID="kitchen-dashboard-projects" style={{ minHeight: 44, justifyContent: "center" }}><Text style={[type.bodyStrong, { color: colors.brand }]}>View all customer projects →</Text></NavigationLink>
      </> : null}
    </View>
  </KitchenPage>;
}
