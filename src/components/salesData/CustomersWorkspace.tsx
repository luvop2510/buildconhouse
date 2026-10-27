import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { AdminPage } from "@/src/components/AdminPage";
import { Button, TextField } from "@/src/components/ui";
import { setSelectedFloorId } from "@/src/hooks/use-floor-access";
import { colors, spacing, type } from "@/src/theme/tokens";
import { Sheet } from "@/src/design/components";
import { FLOOR_LABEL, SalesFilters } from "./SalesFilters";
import { useSalesScope } from "./SalesScope";
import { useSalesSummary } from "./useSalesSummary";
import { count, money, Metric, ReportHeader, ReportPanel, SummaryError, SummaryLoading } from "./SalesReportParts";
import { SectionExcelButton } from "./SectionExcelButton";

export function CustomersWorkspace() {
  const router = useRouter();
  const { floorId, setFloorId, floors, period, choose, accessError, retryAccess } = useSalesScope();
  const { data, error, updating, refresh } = useSalesSummary();
  const [search, setSearch] = useState("");
  const [onlyUnpaid, setOnlyUnpaid] = useState(false);
  const [workDestination, setWorkDestination] = useState<"followups" | "payments" | null>(null);
  const [visible, setVisible] = useState(20);
  const currency = floorId === "third-floor" ? "RNB" : "INR";
  const workspace = (floor: string, kind: "followups" | "payments") => kind === "followups" ? "/(admin)/followups" : floor === "second-floor" ? "/(admin)/kitchen" : floor === "third-floor" ? "/(admin)/notebook/furniture-quotations" : "/(admin)/payments";
  const rows = data?.customers.filter(row => (!onlyUnpaid || row.outstanding > 0) && row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) || [];
  const openWork = async (kind: "followups" | "payments") => {
    if (floorId === "all") { setWorkDestination(kind); return; }
    if (floorId) await setSelectedFloorId(floorId);
    router.push(workspace(floorId, kind) as never);
  };
  return <AdminPage title="Customers" header={false} contentStyle={{ gap: spacing.s16, paddingTop: spacing.s16 }}>
    <ReportHeader title="Customers" subtitle={[FLOOR_LABEL[floorId] || floors.find(floor => floor.id === floorId)?.name || (floorId === "all" ? "All business units" : ""), period?.label].filter(Boolean).join(" · ")} updating={updating} refresh={refresh} />
    {period ? <SalesFilters floors={floors} floorId={floorId} onFloorChange={setFloorId} period={period} onPeriodChange={choose} /> : null}
    {accessError ? <SummaryError error={accessError} retry={() => void retryAccess()} /> : error ? <SummaryError error={error} retry={refresh} /> : null}
    {!data && !error && !accessError ? <SummaryLoading /> : null}
    <Sheet open={workDestination !== null} onClose={() => setWorkDestination(null)} title="Choose a business unit">
      <View style={{ gap: spacing.s8 }}>{floors.map(floor => <Pressable key={floor.id} accessibilityRole="button" accessibilityLabel={FLOOR_LABEL[floor.id] || floor.name}
        onPress={() => { const destination = workDestination; setWorkDestination(null); if (destination) void setSelectedFloorId(floor.id).then(() => router.push(workspace(floor.id, destination) as never)); }}
        style={{ minHeight: 48, padding: spacing.s12 }}><Text style={type.body}>{FLOOR_LABEL[floor.id] || floor.name}</Text></Pressable>)}</View>
    </Sheet>
    {data ? <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
        <Metric label="Customers" testID="sales-kpi-customers" value={data.coverage.sales_available ? count(data.kpis.total_customers) : "—"} detail={`${count(data.kpis.customers)} bought in this period`} />
        <Metric label="Follow-ups" testID="sales-kpi-followups" value={count(data.kpis.followups)} detail={`${count(data.kpis.overdue_followups)} overdue · Open follow-ups`} onPress={() => void openWork("followups")} />
        <Metric label="Outstanding" testID="sales-kpi-outstanding" value={data.coverage.outstanding_available ? money(currency === "RNB" ? data.kpis.outstanding_rnb : data.kpis.outstanding, currency) : "—"} secondaryValue={currency === "INR" && data.departments.some(unit => unit.currency === "RNB") ? money(data.kpis.outstanding_rnb, "RNB") : undefined} detail="Current unpaid balance · Open accounts" onPress={data.coverage.outstanding_available ? () => void openWork("payments") : undefined} />
      </View>
      <Text style={type.bodySm}>Follow-ups and outstanding balances are current, across all dates.{floorId === "all" ? " Open a business unit to work its follow-ups or payments." : ""}</Text>
      {data.coverage.note ? <Text style={type.bodySm}>{data.coverage.note}</Text> : null}
      <ReportPanel title="Customer balances" testID="sales-customers-list" actions={rows.length ? <SectionExcelButton testID="sales-customers-export-xlsx" page="Customers" section={`Customer balances · ${period?.label}`} filename="customer-balances.xlsx" floorId={floorId === "all" ? undefined : floorId} rows={[["Customer", "Currency", "Departments", "Sales in period", "Orders in period", "Current outstanding"], ...rows.map(row => [row.name, row.currency, row.floor_ids.map(id => FLOOR_LABEL[id] || id).join(", "), row.revenue, row.orders, row.outstanding])]} /> : undefined}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: spacing.s12 }}>
          <View style={{ flex: 1, minWidth: 160 }}><TextField placeholderTextColor={colors.onSurfaceMuted} label="Search customers" value={search} onChangeText={value => { setSearch(value); setVisible(20); }} placeholder="Customer name" /></View>
          <Button label={onlyUnpaid ? "Show all customers" : "Only outstanding"} variant="secondary" onPress={() => { setOnlyUnpaid(value => !value); setVisible(20); }} />
        </View>
        <Text style={type.caption}>{count(rows.length)} accounts{data.totals.customers > data.customers.length ? ` shown of ${count(data.totals.customers)}` : ""} · Grouped by currency, highest outstanding first</Text>
        {!rows.length ? <Text style={type.body}>{search || onlyUnpaid ? "No customers match these filters." : "No customer sales or unpaid balances in this scope."}</Text> : null}
        {rows.slice(0, visible).map(row => <View key={row.key} style={{ paddingVertical: spacing.s12, borderTopWidth: 1, borderTopColor: colors.border, gap: spacing.s8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.s8, alignItems: "flex-start", justifyContent: "space-between" }}>
            <Text style={[type.bodyStrong, { flex: 1, minWidth: 120 }]}>{row.name}</Text>
            <Text style={[type.bodyStrong, { textAlign: "right", fontVariant: ["tabular-nums"] }]}>{money(row.outstanding, row.currency)} due</Text>
          </View>
          <Text style={type.bodySm}>{money(row.revenue, row.currency)} sales · {count(row.orders)} orders in this period</Text>
          <Text style={type.caption}>{row.floor_ids.map(id => FLOOR_LABEL[id] || id).join(" · ")}</Text>
        </View>)}
        {rows.length > visible ? <Button label={`Show more (${visible} of ${rows.length})`} variant="secondary" onPress={() => setVisible(value => value + 20)} /> : null}
      </ReportPanel>
    </> : null}
  </AdminPage>;
}
