import { filterValues, toggleFilterValue } from "@/src/utils/filters";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import {
  Button, Dropdown, EmptyState, ErrorState, PageHeader, SearchField, Skeleton,
} from "@/src/components/ds";
import { CellNumber, CellText, CellTitle, DataTable, type Column } from "@/src/components/tiles/TileTable";
import { colors, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";
import { useFloorAccess } from "@/src/hooks/use-floor-access";

type PaymentRow = {
  id: string;
  customer_name?: string | null;
  number?: string | null;
  floor_id?: string | null;
  confirmed_at?: string | null;
  grand_total: number;
  received: number;
  outstanding: number;
  effective_order_total?: number;
  cash_received?: number;
  refund_due?: number;
};
type Floor = { id: string; name: string };
type PaymentListResponse = { total: number; items: PaymentRow[] };

const PAGE_SIZE = 50;
const SORT_OPTIONS = [
  { label: "Newest first", value: "date_desc" },
  { label: "Oldest first", value: "date_asc" },
  { label: "Amount: high to low", value: "amount_desc" },
  { label: "Amount: low to high", value: "amount_asc" },
];

function money(value: number): string {
  return `₹${(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function dateShort(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function PaymentListScreen() {
  const { isPhone } = useBp();
  const { selectedFloorId } = useFloorAccess();
  const filterRef = useRef("");
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [query, setQuery] = useState("");
  const [floor, setFloor] = useState("all");
  const [sort, setSort] = useState("date_desc");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestId = useRef(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (nextPage = page) => {
    if (!selectedFloorId) return;
    const request = ++requestId.current;
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ skip: String(nextPage * PAGE_SIZE), limit: String(PAGE_SIZE), sort });
      if (query.trim()) params.set("q", query.trim());
      if (floor !== "all") params.set("business_unit", floor);
      const response = await api.get<PaymentListResponse>(`/payments/fully-paid-orders?${params.toString()}`);
      if (request !== requestId.current) return;
      setRows(response.items);
      setTotal(response.total);
    } catch (error: any) {
      if (request !== requestId.current) return;
      setLoadError(error?.detail || "Could not load fully paid orders.");
    } finally { if (request === requestId.current) setLoading(false); }
  }, [floor, page, query, sort, selectedFloorId]);

  useEffect(() => { api.get<Floor[]>("/settings/floors").then(setFloors).catch(() => setFloors([])); }, []);
  useEffect(() => {
    requestId.current += 1;
    const filters = JSON.stringify([floor, query, sort, selectedFloorId]);
    if (filterRef.current !== filters && page !== 0) {
      setPage(0);
      return;
    }
    filterRef.current = filters;
    const timer = setTimeout(() => void load(page), query ? 250 : 0);
    return () => { clearTimeout(timer); requestId.current += 1; };
  }, [floor, query, sort, selectedFloorId, page, load]);

  const columns: Column<PaymentRow>[] = [
    { key: "customer", label: "Client / Order", grow: 1, minWidth: 180, render: (row) => <View><CellTitle>{`${row.customer_name || "Unknown client"} · ${row.number || "—"}`}</CellTitle>{(row.refund_due || 0) > 0 ? <Text style={[type.caption, { color: colors.error }]}>Refund due {money(row.refund_due || 0)}</Text> : null}</View> },
    { key: "date", label: "Order Date", width: 120, render: (row) => <CellText>{dateShort(row.confirmed_at)}</CellText> },
    { key: "amount", label: "Final Order", width: 120, align: "right", render: (row) => <CellNumber value={money(row.effective_order_total ?? row.grand_total)} /> },
    { key: "received", label: "Cash Received", width: 120, align: "right", render: (row) => <CellNumber value={money(row.cash_received ?? row.received)} /> },
    { key: "outstanding", label: "Outstanding", width: 120, align: "right", render: (row) => <CellNumber value={money(row.outstanding)} /> },
    { key: "unit", label: "Business Unit", width: 140, render: (row) => <CellText>{floors.find((floor) => floor.id === row.floor_id)?.name || row.floor_id || "—"}</CellText> },
  ];

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <SafeAreaView style={styles.screen} edges={isPhone ? [] : ["top"]}>
      <PageHeader
        title="Fully paid orders"
        overline="PAYMENTS"
        subtitle="One row per order once 100% of its balance has been received."
      />
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={[styles.content, isPhone && styles.contentPhone]}>
        <View style={styles.filters}>
          <View style={[styles.search, isPhone && styles.searchPhone]}><SearchField testID="payment-list-search" value={query} onChangeText={setQuery} onClear={() => setQuery("")} placeholder="Search client, invoice or reference…" /></View>
          <Dropdown label={floor === "all" ? "All business units" : floors.filter(item => filterValues(floor).includes(item.id)).map(item => item.name).join(", ") || floor} items={[{ label: "All business units", onPress: () => setFloor("all") }, ...floors.map((item) => ({ label: `${filterValues(floor).includes(item.id) ? "✓ " : ""}${item.name}`, onPress: () => setFloor(current => toggleFilterValue(current, item.id)) }))]} />
          <Dropdown label={SORT_OPTIONS.find((item) => item.value === sort)?.label || "Sort"} items={SORT_OPTIONS.map((item) => ({ label: item.label, onPress: () => setSort(item.value) }))} />
        </View>

        {loadError ? <ErrorState title="Could not load fully paid orders" subtitle={loadError} onRetry={() => void load()} /> : loading ? (
          <View style={{ gap: spacing.sm }}>{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} w="100%" h={54} />)}</View>
        ) : rows.length === 0 ? (
          <EmptyState icon="check-circle" title={query || floor !== "all" ? "No matching orders" : "No fully paid orders yet"} subtitle={query || floor !== "all" ? "Try a different search or clear the filters." : "Orders appear here once they are fully collected."} />
        ) : (
          <DataTable testID="payment-list-table" columns={columns} data={rows} keyExtractor={(row) => row.id} rowTestID={(row) => `payment-list-row-${row.id}`} emptyMessage="No fully paid payments found." />
        )}

        <View style={[styles.pagination, isPhone && styles.paginationPhone]}>
          <Text style={type.caption}>{total ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}` : "0 orders"}</Text>
          <View style={[styles.pageButtons, isPhone && styles.pageButtonsPhone]}>
            <Button label="Previous" variant="secondary" size="sm" disabled={page === 0} onPress={() => setPage((value) => Math.max(0, value - 1))} />
            <Text style={type.caption}>Page {page + 1} of {pageCount}</Text>
            <Button label="Next" variant="secondary" size="sm" disabled={page + 1 >= pageCount} onPress={() => setPage((value) => Math.min(pageCount - 1, value + 1))} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { padding: spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxxl },
  contentPhone: { padding: spacing.lg, paddingBottom: 132 },
  filters: { flexDirection: "row", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" },
  search: { flex: 1, minWidth: Platform.OS === "web" ? 280 : 220 },
  searchPhone: { flexBasis: "100%", minWidth: 0 },
  pagination: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md, flexWrap: "wrap" },
  paginationPhone: { alignItems: "flex-start" },
  pageButtons: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  pageButtonsPhone: { width: "100%", justifyContent: "space-between" },
});
