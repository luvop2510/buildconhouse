import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { AdminPage } from "@/src/components/AdminPage";
import { Button, TextField } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { setSelectedFloorId } from "@/src/hooks/use-floor-access";
import { colors, spacing, type } from "@/src/theme/tokens";
import { FLOOR_LABEL, SalesFilters } from "./SalesFilters";
import { useSalesScope } from "./SalesScope";
import { useSalesSummary } from "./useSalesSummary";
import { SectionExcelButton } from "./SectionExcelButton";
import { count, money, quantityLabel, Metric, ReportHeader, RankingRow, ReportPanel, SummaryError, SummaryLoading } from "./SalesReportParts";

export function SalesWorkspace() {
  const router = useRouter();
  const params = useLocalSearchParams<{ view?: string }>();
  const { isDesktop } = useBp();
  const { floorId, setFloorId, floors, period, choose, accessError, retryAccess } = useSalesScope();
  const { data, error, updating, refresh } = useSalesSummary();
  const [expanded, setExpanded] = useState<string | null>(params.view || null);
  const [search, setSearch] = useState("");
  const currency = floorId === "third-floor" ? "RNB" : "INR";
  const needle = search.trim().toLocaleLowerCase();
  const brands = data?.brands.filter(row => row.name.toLocaleLowerCase().includes(needle)) || [];
  const products = data?.products.filter(row => [row.name, row.brand_name, row.sku].some(value => value?.toLocaleLowerCase().includes(needle))) || [];
  const detail = (id: string) => {
    const query = new URLSearchParams({ floorId, preset: period?.preset || "this_month" });
    if (period?.preset === "custom") { if (period.dateFrom) query.set("dateFrom", period.dateFrom); if (period.dateTo) query.set("dateTo", period.dateTo); }
    router.push(`/(admin)/sales-data/brands/${encodeURIComponent(id)}?${query}` as never);
  };
  const exportFloor = floorId === "all" ? undefined : floorId;
  const sections = <>
    <View style={{ flex: 1, minWidth: 0 }}><ReportPanel plain title="Best performing brands" testID="sales-brands" actions={data && brands.length ? <SectionExcelButton testID="sales-brands-export-xlsx" page="Sales" section={`Brands · ${period?.label}`} filename="sales-brands.xlsx" floorId={exportFloor} rows={[["Brand", "Revenue", "Products", "Orders", "Quantities"], ...brands.map(row => [row.name, row.revenue, row.products, row.orders, quantityLabel(row.quantities)])]} /> : undefined}>
      {brands.slice(0, expanded === "brands" || needle ? 100 : 5).map(row => <RankingRow key={row.brand_id} name={row.name} value={row.revenue} detail={`${count(row.products)} products · ${count(row.orders)} orders`} proportion={data ? row.revenue / Math.max(1, data.brands.reduce((sum, brand) => sum + brand.revenue, 0)) : 0} onPress={row.is_unlinked ? undefined : () => detail(row.brand_id)} />)}
      {!brands.length ? <Text style={type.body}>{needle ? "No matching brands." : "No brand sales in this period."}</Text> : null}
      {brands.length > 5 ? <Button variant="ghost" label={expanded === "brands" ? "Show top 5 brands" : `View ${count(brands.length)} brands`} onPress={() => setExpanded(expanded === "brands" ? null : "brands")} /> : null}
      {data && data.totals.brands > data.brands.length ? <Text style={type.caption}>Top {count(data.brands.length)} of {count(data.totals.brands)} brands by sales.</Text> : null}
    </ReportPanel></View>
    <View style={{ flex: 1, minWidth: 0 }}><ReportPanel plain title="Best selling products" testID="sales-products" actions={data && products.length ? <SectionExcelButton testID="sales-products-export-xlsx" page="Sales" section={`Products · ${period?.label}`} filename="sales-products.xlsx" floorId={exportFloor} rows={[["Product", "Brand", "SKU", "Revenue", "Quantities", "Orders"], ...products.map(row => [row.name, row.brand_name, row.sku, row.revenue, quantityLabel(row.quantities), row.orders])]} /> : undefined}>
      {products.slice(0, expanded === "products" || needle ? 100 : 5).map(row => <RankingRow key={row.product_id} name={row.name} value={row.revenue} detail={[row.brand_name, quantityLabel(row.quantities)].filter(Boolean).join(" · ")} />)}
      {!products.length ? <Text style={type.body}>{needle ? "No matching products." : "No product sales in this period."}</Text> : null}
      {products.length > 5 ? <Button variant="ghost" label={expanded === "products" ? "Show top 5 products" : `View ${count(products.length)} products`} onPress={() => setExpanded(expanded === "products" ? null : "products")} /> : null}
      {data && data.totals.products > data.products.length ? <Text style={type.caption}>Top {count(data.products.length)} of {count(data.totals.products)} products by sales.</Text> : null}
    </ReportPanel></View>
  </>;
  return <AdminPage title="Sales" header={false} contentStyle={{ gap: spacing.s16, paddingTop: spacing.s16 }}>
    <ReportHeader title="Sales" subtitle={[FLOOR_LABEL[floorId] || floors.find(floor => floor.id === floorId)?.name || (floorId === "all" ? "All business units" : ""), period?.label].filter(Boolean).join(" · ")} updating={updating} refresh={refresh} />
    {period ? <SalesFilters floors={floors} floorId={floorId} onFloorChange={setFloorId} period={period} onPeriodChange={choose} /> : null}
    {accessError ? <SummaryError error={accessError} retry={() => void retryAccess()} /> : error ? <SummaryError error={error} retry={refresh} /> : null}
    {!data && !error && !accessError ? <SummaryLoading /> : null}
    {data ? <>
      <View testID="sales-data-kpis" style={{ flexDirection: "row", flexWrap: "wrap", backgroundColor: colors.surfaceSecondary, borderRadius: 8, borderWidth: 1, borderColor: colors.border }}>
        <Metric label="Sales" testID="sales-kpi-revenue" value={data.coverage.sales_available ? money(currency === "RNB" ? data.kpis.revenue_rnb : data.kpis.revenue, currency) : "—"} secondaryValue={currency === "INR" && data.departments.some(unit => unit.currency === "RNB") ? money(data.kpis.revenue_rnb, "RNB") : undefined} detail={data.period.label} lead />
        {data.coverage.products_available ? <Metric label="Products sold" testID="sales-kpi-products" value={count(data.kpis.products)} detail="Tiles and Sanitary products" /> : null}
        <Metric label="Orders" testID="sales-kpi-orders" value={data.coverage.sales_available ? count(data.kpis.orders) : "—"} detail="Confirmed sales" />
      </View>
      {data.quantities.length ? <Text style={type.bodySm}>Quantity sold: {quantityLabel(data.quantities)}</Text> : null}
      {data.coverage.note ? <Text style={type.bodySm}>{data.coverage.note}</Text> : null}
      {data.departments.length > 1 ? <ReportPanel title="Sales by department" testID="sales-departments"><View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.s16 }}>{data.departments.map(unit => <View key={unit.floor_id} style={{ flexGrow: 1, flexBasis: isDesktop ? "20%" : "45%", minWidth: 0, gap: spacing.s4 }}><Text style={type.bodyStrong}>{FLOOR_LABEL[unit.floor_id] || unit.floor_id}</Text><Text style={type.numeric}>{money(unit.revenue, unit.currency)}</Text><Text style={type.bodySm}>{count(unit.orders)} orders · {count(unit.customers)} buyers</Text></View>)}</View></ReportPanel> : null}
      {data.coverage.products_available ? <><TextField placeholderTextColor={colors.onSurfaceMuted} label="Find a brand or product" value={search} onChangeText={setSearch} placeholder="Search names, brands or SKU" />
      <View style={{ backgroundColor: colors.surfaceSecondary, borderRadius: 8, borderWidth: 1, borderColor: colors.border, padding: spacing.s16, flexDirection: isDesktop ? "row" : "column", gap: spacing.s24, alignItems: "stretch" }}>{sections}</View></> : <ReportPanel title={floorId === "third-floor" ? "Furniture ledgers" : "Kitchen projects"}><Text style={type.body}>Sales are based on {floorId === "third-floor" ? "finalized Furniture ledgers in RNB" : "confirmed Kitchen project orders"}. Product and brand quantities are not recorded in this workflow.</Text><Button label={floorId === "third-floor" ? "Open Furniture ledgers" : "Open Kitchen projects"} variant="secondary" onPress={() => void setSelectedFloorId(floorId).then(() => router.push((floorId === "third-floor" ? "/(admin)/notebook/furniture-quotations" : "/(admin)/kitchen") as never))} /></ReportPanel>}
    </> : null}
  </AdminPage>;
}
