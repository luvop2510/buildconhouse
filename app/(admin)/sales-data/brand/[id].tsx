import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";

import { AdminPage } from "@/src/components/AdminPage";
import { api } from "@/src/api/client";
import {
  Button, EmptyState, ErrorState, LoadingState, PillTabs, Table, TableCell, TableHeader, TableRow,
} from "@/src/components/ui";
import { fmtMoney } from "@/src/design/tokens";
import { useBp } from "@/src/design/responsive";
import { colors, spacing, type } from "@/src/theme/tokens";
import { TrendChart } from "@/src/components/salesData/TrendChart";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";
import { toast } from "@/src/components/Toast";
import {
  DATE_PRESET_LABEL, DatePreset, Granularity, presetToRange,
} from "@/src/components/salesData/salesDataApi";

type BrandDetailResponse = {
  brand: { id: string; name: string };
  total_revenue: number;
  trend: { bucket: string; revenue: number }[];
  top_products: { product_id: string; name: string; sku: string; revenue: number }[];
};

export default function BrandDetail() {
  const { id, preset: presetParam, floorId } = useLocalSearchParams<{ id: string; preset?: string; floorId?: string }>();
  const preset: DatePreset = presetParam && presetParam in DATE_PRESET_LABEL ? (presetParam as DatePreset) : "this_month";
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [data, setData] = useState<BrandDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isPhone } = useBp();

  const { date_from, date_to } = useMemo(() => presetToRange(preset), [preset]);

  const load = useCallback(() => {
    setError(null);
    setData(null);
    const params = new URLSearchParams();
    params.set("granularity", granularity);
    if (floorId && floorId !== "both") params.set("floor_id", floorId);
    if (date_from) params.set("date_from", date_from);
    if (date_to) params.set("date_to", date_to);
    api.get<BrandDetailResponse>(`/sales-data/brands/${id}?${params.toString()}`)
      .then(setData)
      .catch((e: any) => setError(e?.detail || "Could not load brand"));
  }, [id, granularity, date_from, date_to, floorId]);

  useEffect(() => { load(); }, [load]);

  const exportData = (section: string, rows: (string | number | null)[][]) => {
    if (!data) return;
    void downloadSectionExcel({ page: `Brand / ${data.brand.name}`, section, filename: `brand-${section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.xlsx`, floorId, rows }).catch((error: unknown) => toast.show(error instanceof Error ? error.message : "Could not export brand data"));
  };

  return (
    <AdminPage
      title={data?.brand.name || "Brand"}
      subtitle={data ? `₹${fmtMoney(data.total_revenue)} total revenue · ${DATE_PRESET_LABEL[preset]}` : undefined}
    >
      <PillTabs
        testID="brand-detail-granularity"
        value={granularity}
        onChange={setGranularity}
        options={[
          { value: "day", label: "Day" }, { value: "month", label: "Month" },
          { value: "quarter", label: "Quarter" }, { value: "year", label: "Year" },
        ]}
      />
      {error ? <ErrorState subtitle={error} onRetry={load} /> : null}
      {!error && !data ? <LoadingState label="Loading…" /> : null}
      {data ? (
        <View style={{ gap: spacing.lg }}>
          {data.trend.length ? <Button testID="brand-detail-trend-export-xlsx" label="Export revenue trend" icon="download" variant="secondary" onPress={() => exportData("Revenue trend", [["Period", "Revenue"], ...data.trend.map(point => [point.bucket, point.revenue])])} /> : null}
          <TrendChart points={data.trend} />
          {data.top_products.length === 0 ? (
            <EmptyState title="No product revenue in this range" />
          ) : (
            <View style={{ gap: spacing.sm }}>
            <Button testID="brand-detail-products-export-xlsx" label="Export products" icon="download" variant="secondary" onPress={() => exportData("Top products", [["Product", "SKU", "Revenue"], ...data.top_products.map(product => [product.name, product.sku, product.revenue])])} />
            {isPhone ? (
              <View style={{ gap: spacing.xs }}>
                {data.top_products.map((p) => (
                  <View key={p.product_id} testID={`brand-product-row-${p.product_id}`} style={{ minHeight: 56, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}><Text style={type.bodyStrong} numberOfLines={2}>{p.name}</Text><Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{p.sku || "No SKU"}</Text></View>
                    <Text style={[type.bodyStrong, { fontVariant: ["tabular-nums"] }]}>₹{fmtMoney(p.revenue)}</Text>
                  </View>
                ))}
              </View>
            ) : <Table>
              <TableHeader columns={[
                { label: "Product", flex: 2 }, { label: "SKU", flex: 1 }, { label: "Revenue", align: "right" },
              ]} />
              {data.top_products.map((p, i) => (
                <TableRow key={p.product_id} isLast={i === data.top_products.length - 1} testID={`brand-product-row-${p.product_id}`}>
                  <TableCell flex={2}>{p.name}</TableCell>
                  <TableCell flex={1}>{p.sku}</TableCell>
                  <TableCell align="right">₹{fmtMoney(p.revenue)}</TableCell>
                </TableRow>
              ))}
            </Table>}
            </View>
          )}
        </View>
      ) : null}
    </AdminPage>
  );
}
