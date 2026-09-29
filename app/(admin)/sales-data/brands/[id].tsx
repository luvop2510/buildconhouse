import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";

import { api } from "@/src/api/client";
import { AdminPage } from "@/src/components/AdminPage";
import { Card, ErrorState, LoadingState, Table, TableCell, TableHeader, TableRow } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { useAnalyticsDetailPeriod } from "@/src/components/salesData/useAnalyticsDetailPeriod";
import { SectionExcelButton } from "@/src/components/salesData/SectionExcelButton";
import { colors, spacing, type } from "@/src/theme/tokens";

type Detail = { brand: { name: string }; kpis: { revenue: number; orders: number; aov: number }; trend: { bucket: string; revenue: number }[]; products: any[]; customers: any[]; salespeople: any[]; referrals: any[] };
const money = (n = 0) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export default function ExecutiveBrandDetail() {
  const { id } = useLocalSearchParams<{ id: string }>(); const router = useRouter(); const { isPhone, isTablet } = useBp(); const [data, setData] = useState<Detail | null>(null); const [error, setError] = useState<string | null>(null);
  const { query: periodQuery, label: periodLabel } = useAnalyticsDetailPeriod();
  const load = useCallback(() => { if (!id || !periodQuery) return; setError(null); setData(null); api.get<Detail>(`/executive-analytics/brands/${id}?${periodQuery}&granularity=month`).then(setData).catch((e: any) => setError(e?.message || e?.detail || "Could not load brand analytics")); }, [id, periodQuery]);
  useEffect(() => { load(); }, [load]);
  const cardStyle = isPhone ? { width: "100%" as const } : isTablet ? { width: "48%" as const } : { flex: 1, minWidth: 150 };
  return <AdminPage title={data?.brand.name || "Brand analytics"} subtitle={`Confirmed-order contribution · ${periodLabel}`} back={() => router.back()} contentStyle={{ gap: spacing.lg }}>{error ? <ErrorState subtitle={error} onRetry={load} /> : null}{!error && !data ? <LoadingState label="Loading brand intelligence…" /> : null}{data ? <><View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}><Card testID="brand-detail-revenue" style={cardStyle}><Text style={type.caption}>Revenue</Text><Text style={type.titleLg}>{money(data.kpis.revenue)}</Text></Card><Card testID="brand-detail-orders" style={cardStyle}><Text style={type.caption}>Orders</Text><Text style={type.titleLg}>{data.kpis.orders}</Text></Card><Card testID="brand-detail-aov" style={cardStyle}><Text style={type.caption}>Average order</Text><Text style={type.titleLg}>{money(data.kpis.aov)}</Text></Card></View><Card testID="brand-detail-products" style={{ gap: spacing.md }}><View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}><Text style={type.titleMd}>Best selling products</Text><SectionExcelButton testID="brand-products-export-xlsx" page={data.brand.name} section="Best selling products" filename="brand-best-selling-products.xlsx" rows={[["Product", "Revenue"], ...data.products.map(row => [row.name, row.revenue])]} /></View>{isPhone ? data.products.map((row) => <MobileMetricRow key={row.product_id} label={row.name} value={money(row.revenue)} testID={`brand-product-${row.product_id}`} />) : <Table><TableHeader columns={[{ label: "Product", flex: 2 }, { label: "Revenue", align: "right" }]} />{data.products.map((row, i) => <TableRow key={row.product_id} isLast={i === data.products.length - 1} testID={`brand-product-${row.product_id}`}><TableCell flex={2}>{row.name}</TableCell><TableCell align="right">{money(row.revenue)}</TableCell></TableRow>)}</Table>}</Card><Card testID="brand-detail-customers" style={{ gap: spacing.md }}><View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}><Text style={type.titleMd}>Top customers</Text><SectionExcelButton testID="brand-customers-export-xlsx" page={data.brand.name} section="Top customers" filename="brand-top-customers.xlsx" rows={[["Customer", "Revenue"], ...data.customers.map(row => [row.name, row.revenue])]} /></View>{data.customers.slice(0, 5).map((row) => <MobileMetricRow key={row.customer_id} label={row.name} value={money(row.revenue)} />)}</Card></> : null}</AdminPage>;
}

function MobileMetricRow({ label, value, testID }: { label: string; value: string; testID?: string }) { return <View testID={testID} style={{ minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.divider }}><Text style={[type.bodyStrong, { flex: 1, minWidth: 0 }]} numberOfLines={2}>{label}</Text><Text style={[type.bodyStrong, { fontVariant: ["tabular-nums"] }]}>{value}</Text></View>; }
