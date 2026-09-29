import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api } from "@/src/api/client";
import { AdminPage } from "@/src/components/AdminPage";
import { Card, ErrorState, KpiCard, LoadingState, Table, TableCell, TableHeader, TableRow } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { useAnalyticsDetailPeriod } from "@/src/components/salesData/useAnalyticsDetailPeriod";
import { SectionExcelButton } from "@/src/components/salesData/SectionExcelButton";
import { colors, spacing, type } from "@/src/theme/tokens";

type Detail = { salesperson?: { full_name: string }; referrer?: { name: string; type: string }; kpis: { revenue: number; orders: number; aov: number; customers: number }; brands: any[]; products: any[]; customers: any[] };
const money = (n = 0) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export default function PeopleAnalytics() {
  const { kind, id } = useLocalSearchParams<{ kind: "salespeople" | "referrers"; id: string }>(); const router = useRouter(); const { isPhone, isTablet } = useBp(); const [data, setData] = useState<Detail | null>(null); const [error, setError] = useState<string | null>(null);
  const { query: periodQuery, label: periodLabel } = useAnalyticsDetailPeriod();
  const load = useCallback(() => { if (!id || !kind || !periodQuery) return; setError(null); setData(null); api.get<Detail>(`/executive-analytics/${kind}/${id}?${periodQuery}`).then(setData).catch((e: any) => setError(e?.message || e?.detail || "Could not load analytics")); }, [kind, id, periodQuery]);
  useEffect(() => { load(); }, [load]); const name = data?.salesperson?.full_name || data?.referrer?.name || "Performance detail";
  const cardStyle = isPhone ? { width: "100%" as const } : isTablet ? { width: "48%" as const } : { flex: 1, minWidth: 140 };
  return <AdminPage title={name} subtitle={`${kind === "salespeople" ? "Salesperson performance" : "Referral performance"} · ${periodLabel}`} back={() => router.back()} contentStyle={{ gap: spacing.lg }}>{error ? <ErrorState subtitle={error} onRetry={load} /> : null}{!error && !data ? <LoadingState label="Loading performance…" /> : null}{data ? <><View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><KpiCard label="Revenue" value={money(data.kpis.revenue)} style={cardStyle} /><KpiCard label="Orders" value={String(data.kpis.orders)} style={cardStyle} /><KpiCard label="Average deal" value={money(data.kpis.aov)} style={cardStyle} /><KpiCard label="Customers" value={String(data.kpis.customers)} style={cardStyle} /></View><Card testID="people-detail-brands" style={{ gap: spacing.md }}><View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}><Text style={type.titleMd}>Top brands</Text><SectionExcelButton testID="people-brands-export-xlsx" page={name} section="Top brands" filename="people-top-brands.xlsx" rows={[["Brand", "Revenue"], ...data.brands.map(row => [row.brand_name || "Unmapped", row.revenue])]} /></View>{isPhone ? data.brands.slice(0, 10).map((row, i) => <View key={row.brand_id || i} testID={`people-brand-${row.brand_id}`} style={{ minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.divider }}><Text style={[type.bodyStrong, { flex: 1, minWidth: 0 }]} numberOfLines={2}>{row.brand_name || "Unmapped"}</Text><Text style={[type.bodyStrong, { fontVariant: ["tabular-nums"] }]}>{money(row.revenue)}</Text></View>) : <Table><TableHeader columns={[{ label: "Brand", flex: 2 }, { label: "Revenue", align: "right" }]} />{data.brands.slice(0, 10).map((row, i) => <TableRow key={row.brand_id || i} isLast={i === Math.min(10, data.brands.length) - 1} testID={`people-brand-${row.brand_id}`}><TableCell flex={2}>{row.brand_name || "Unmapped"}</TableCell><TableCell align="right">{money(row.revenue)}</TableCell></TableRow>)}</Table>}</Card></> : null}</AdminPage>;
}
