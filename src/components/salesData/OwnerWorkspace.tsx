import { Redirect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { salesWorkspaceApi, type WorkspaceData, type WorkspaceName } from "@/src/api/salesWorkspaces";
import { AdminPage } from "@/src/components/AdminPage";
import { Card, EmptyState, ErrorState, KpiCard, LoadingState, Button, Table, TableCell, TableHeader, TableRow } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { fmtMoneyCompact } from "@/src/design/tokens";
import { getSelectedFloorId, useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { SalesFilters } from "./SalesFilters";
import { useSalesPeriod } from "./useSalesPeriod";
import { colors, layout, spacing, type } from "@/src/theme/tokens";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";
import { toast } from "@/src/components/Toast";

const LABELS: Record<WorkspaceName, { title: string; subtitle: string; rows: "brands" | "products" | "customers" | "relationships" | "floors" }> = {
  revenue: { title: "Revenue", subtitle: "Confirmed sales, dated by order confirmation", rows: "brands" },
  collections: { title: "Collections", subtitle: "What has been collected and what remains due", rows: "customers" },
  forecasting: { title: "Forecasting", subtitle: "Conservative forecast from completed sales history", rows: "floors" },
  customers: { title: "Customers", subtitle: "Customers ranked by confirmed revenue", rows: "customers" },
  architects: { title: "Architects", subtitle: "Architects with attributed confirmed revenue", rows: "relationships" },
  "interior-designers": { title: "Interior Designers", subtitle: "Interior designers, acquired customers and attributed confirmed revenue", rows: "relationships" },
  relationships: { title: "Relationships", subtitle: "Referred customer relationships and generated revenue", rows: "relationships" },
  products: { title: "Products", subtitle: "Products ranked by net confirmed revenue", rows: "products" },
  brands: { title: "Brands", subtitle: "Brand contribution to confirmed revenue", rows: "brands" },
  suppliers: { title: "Suppliers", subtitle: "Supplier attribution and purchasing context", rows: "brands" },
  operations: { title: "Operations", subtitle: "Confirmed-order workload by business unit", rows: "floors" },
};

export function OwnerWorkspace({ workspace }: { workspace: WorkspaceName }) {
  const { staff } = useAuth();
  const canViewSales = useActionAccess("sales_data", "view", staff?.role === "owner"); const { floors } = useFloorAccess(); const router = useRouter(); const { isPhone, isTablet } = useBp();
  const [floorId, setFloorId] = useState(""); const [data, setData] = useState<WorkspaceData | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!floorId) void getSelectedFloorId().then((id) => setFloorId(id || "all")); }, [floorId]);
  const { period, choose } = useSalesPeriod(floorId);
  const requestId = useRef(0);
  const load = useCallback(() => {
    if (!floorId || !period) return;
    const id = ++requestId.current;
    setError(null); setData(null);
    salesWorkspaceApi.get(workspace, { floorId, preset: period.preset, dateFrom: period.dateFrom || undefined, dateTo: period.dateTo || undefined }).then(
      result => { if (id === requestId.current) setData(result); },
      (e: any) => { if (id === requestId.current) setError(e?.detail || "Could not load this workspace"); },
    );
  }, [workspace, floorId, period]);
  useEffect(() => { load(); return () => { requestId.current += 1; }; }, [load]);
  if (staff && !canViewSales) return <Redirect href="/(admin)/sales-data" />;
  const meta = LABELS[workspace]; const cardStyle = isPhone ? { width: "100%" as const } : isTablet ? { width: "48%" as const } : { flex: 1, minWidth: 180 };
  return <AdminPage title={meta.title} subtitle={data ? `${meta.subtitle} · ${data.period}` : meta.subtitle}>
    {period ? <SalesFilters floors={floors} floorId={floorId} onFloorChange={setFloorId} period={period} onPeriodChange={choose} /> : null}
    {error ? <ErrorState subtitle={error} onRetry={load} /> : null}
    {!error && !data ? <LoadingState label={`Loading ${meta.title.toLowerCase()}…`} /> : null}
    {data ? <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
        <KpiCard label="Revenue" value={fmtMoneyCompact(data.kpis.revenue)} question="What did confirmed sales generate?" style={cardStyle} />
        <KpiCard label="Orders" value={String(data.kpis.orders)} question="How many confirmed sales are included?" style={cardStyle} />
        <KpiCard label="Outstanding" value={fmtMoneyCompact(data.kpis.outstanding)} question="What is still due on these sales?" tone="warning" style={cardStyle} />
        <KpiCard label="Average order" value={data.kpis.orders ? fmtMoneyCompact(data.kpis.revenue / data.kpis.orders) : "—"} question="Confirmed revenue per order in this period" style={cardStyle} />
      </View>
      {workspace === "forecasting" ? <Forecast data={data} floorId={floorId} /> : null}
      {workspace === "suppliers" ? <EmptyState icon="truck" title="Supplier sales attribution unavailable" subtitle="These sales records link products to brands, but do not identify their purchasing supplier. Review supplier purchase orders in Purchases." /> : <WorkspaceTable key={`${workspace}:${floorId}:${period?.label}`} kind={meta.rows} data={data} floorId={floorId} phone={isPhone} onOpen={(path) => router.push(path as never)} />}
    </> : null}
  </AdminPage>;
}

function Forecast({ data, floorId }: { data: WorkspaceData; floorId: string }) { const forecast = data.forecast; return <Card variant="flat" padding={spacing.xl}><View style={{ gap: spacing.sm }}><View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}><Text style={type.titleSm}>Conservative forecast</Text>{forecast?.forecast != null ? <Button testID="sales-forecast-export-xlsx" label="Export Excel" icon="download" variant="secondary" onPress={() => void downloadSectionExcel({ resource: "sales_data", page: "Sales Data", section: "Conservative forecast", filename: "sales-forecast.xlsx", floorId: floorId === "all" ? undefined : floorId, rows: [["Measure", "Value"], ["Forecast", forecast.forecast], ...forecast.monthly_history.map((value, index) => [`Prior month ${index + 1}`, value])] }).catch((error: unknown) => toast.show(error instanceof Error ? error.message : "Could not export forecast"))} /> : null}</View>{forecast?.forecast == null ? <Text style={[type.body, { color: colors.onSurfaceMuted }]}>Orders in each of the previous three complete UTC calendar months are required. This baseline uses the selected business unit and is independent of the report period.</Text> : <><Text style={type.displayMd}>{fmtMoneyCompact(forecast?.forecast || 0)}</Text><Text style={[type.caption, { color: colors.onSurfaceMuted }]}>Baseline for the current month, independent of the report period. Prior three complete UTC months (oldest first): {forecast?.monthly_history.map(fmtMoneyCompact).join(" · ")}</Text></>}</View></Card>; }

function WorkspaceTable({ kind, data, floorId, phone, onOpen }: { kind: "brands" | "products" | "customers" | "relationships" | "floors"; data: WorkspaceData; floorId: string; phone: boolean; onOpen: (path: string) => void }) {
  const [visibleCount, setVisibleCount] = useState(25);
  const rows: any[] = kind === "brands" ? data.brands : kind === "products" ? data.products : kind === "customers" ? data.customers : kind === "relationships" ? (data.relationships || []) : data.floors;
  if (!rows.length) return <EmptyState icon="bar-chart-2" title="No confirmed sales in this period" subtitle="Try a different date range or business unit." tone="brand" />;
  const title = kind === "relationships" ? "Revenue relationships" : kind === "floors" ? "Business units" : `Top ${kind}`;
  const exportRows = () => {
    const headers = kind === "products" ? ["Product", "Brand", "Revenue", "Units", "Orders", "Customers"]
      : kind === "customers" ? ["Customer", "Revenue", "Orders", "Average order", "Last order"]
      : kind === "relationships" ? ["Name", "Interior / studio", "Type", "Revenue", "Orders", "Customers", "Customers acquired", "Last referral"]
      : kind === "brands" ? ["Brand", "Revenue", "Units", "Orders"]
      : ["Business unit", "Revenue", "Orders"];
    const values = rows.map((r) => kind === "products" ? [r.name, r.brand_name, r.revenue, r.quantity, r.orders, r.customers]
      : kind === "customers" ? [r.name, r.revenue, r.orders, r.aov, r.last_order_at]
      : kind === "relationships" ? [r.name, r.company, r.type, r.revenue, r.orders, r.customers, r.customers_acquired ?? r.customers, r.last_order_at]
      : kind === "brands" ? [r.name, r.revenue, r.quantity, r.orders]
      : [r.floor_id, r.revenue, r.orders]);
    void downloadSectionExcel({ resource: "sales_data", page: `Sales Data / ${data.workspace}`, section: title, filename: `sales-${data.workspace}-${kind}.xlsx`, floorId: floorId === "all" ? undefined : floorId, rows: [headers, ...values] }).catch((error: unknown) => toast.show(error instanceof Error ? error.message : "Could not export this section"));
  };
  const phoneRow = (r: any) => {
    const key = r.id || r.brand_id || r.product_id || r.customer_id || r.floor_id;
    const detail = `${fmtMoneyCompact(r.revenue)} · ${r.orders ?? r.quantity ?? 0} ${r.orders !== undefined ? "orders" : "units"}`;
    const body = <View style={{ minHeight: 56, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.border, justifyContent: "center" }}><Text style={type.bodyStrong} numberOfLines={2}>{[r.name, r.company].filter(Boolean).join(" · ") || r.floor_id}</Text><Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{detail}</Text>{kind === "relationships" ? <Text style={type.caption}>Through this {r.type === "interior_designer" ? "interior" : "architect"}, {r.customers_acquired ?? r.customers ?? 0} customers were acquired.</Text> : null}</View>;
    return r.customer_id ? <Pressable key={key} accessibilityRole="button" accessibilityLabel={`Open customer ${r.name}`} onPress={() => onOpen(`/(admin)/customers/${r.customer_id}`)}>{body}</Pressable> : <View key={key}>{body}</View>;
  };
  return <Card variant="flat" padding={phone ? layout.cardPadding.base : spacing.lg}><View style={{ gap: spacing.md }}><View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}><Text style={type.titleSm}>{title}</Text><Button testID={`sales-workspace-${kind}-export-xlsx`} label="Export Excel" icon="download" variant="secondary" onPress={exportRows} /></View>{phone ? <View style={{ gap: spacing.xs }}>{rows.slice(0, visibleCount).map(phoneRow)}</View> : <Table><TableHeader columns={[{ label: "Name", flex: 2 }, { label: "Revenue", align: "right" }, { label: kind === "products" ? "Units" : "Orders", align: "right" }]} />{rows.slice(0, visibleCount).map((r, i) => <TableRow key={r.id || r.brand_id || r.product_id || r.customer_id || r.floor_id} isLast={i === Math.min(rows.length, visibleCount) - 1} onPress={r.customer_id ? () => onOpen(`/(admin)/customers/${r.customer_id}`) : undefined}><TableCell flex={2}>{kind === "relationships" ? `${[r.name, r.company].filter(Boolean).join(" · ")} · Through this ${r.type === "interior_designer" ? "interior" : "architect"}, ${r.customers_acquired ?? r.customers ?? 0} customers were acquired.` : r.name || r.floor_id}</TableCell><TableCell align="right">{fmtMoneyCompact(r.revenue)}</TableCell><TableCell align="right">{String(kind === "products" ? r.quantity ?? 0 : r.orders ?? 0)}</TableCell></TableRow>)}</Table>}{rows.length > visibleCount ? <Button label={`Show more (${visibleCount} of ${rows.length})`} variant="secondary" onPress={() => setVisibleCount(n => n + 25)} /> : null}</View></Card>;
}
