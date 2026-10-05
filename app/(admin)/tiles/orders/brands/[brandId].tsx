// frontend/app/(admin)/tiles/orders/brands/[brandId].tsx
// Ground Floor → Tiles → Tile Orders → Brands → Brand Detail — this
// BRAND's Customer Orders only (Qutone, Dimore, Kajaria… never mixes in
// another brand's orders, and never groups by dealer/supplier company —
// see services/domain_outbox.py, PurchaseOrder.brand_id/brand_name is set
// once per-brand at order-placement time). Ordered/Released/Remaining are
// the only columns here; tapping a row opens the order for Release only.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { tileOrdersApi, type BrandOrderRow, type BrandOrdersKpi } from "@/src/api/tileOrders";
import { toast } from "@/src/components/Toast";
import {
  BackLink, Button, CenteredState, PageHeader, PageShell, Section, Stat, StatRow,
} from "@/src/components/tiles/TileLayout";
import { AgeingBadge, StatusPill, WorkflowRail } from "@/src/components/tiles/TileOrderStatusUI";
import { CellLink, CellMono, CellNumber, CellTitle, DataTable, type Column } from "@/src/components/tiles/TileTable";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";
import { colors, spacing, type } from "@/src/theme/tokens";

export default function BrandDashboardScreen() {
  useRequireFloorAccess("ground-floor");
  const { brandId } = useLocalSearchParams<{ brandId: string }>();
  const router = useRouter();
  const [kpi, setKpi] = useState<BrandOrdersKpi | null>(null);
  const [orders, setOrders] = useState<BrandOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async (nextPage = 1) => {
    if (!brandId) return;
    const currentRequest = ++requestId.current;
    if (nextPage === 1) setLoading(true);
    setLoadError(null);
    try {
      const r = await tileOrdersApi.brandOrders(brandId, { page: nextPage, page_size: 30 });
      if (currentRequest !== requestId.current) return;
      setKpi(r.kpi);
      setOrders((previous) => nextPage === 1 ? r.orders : [...previous, ...r.orders]);
      setPage(nextPage);
      setHasMore(r.has_more);
    } catch (e: any) {
      if (currentRequest !== requestId.current) return;
      const message = e?.detail || "Could not load brand orders";
      setLoadError(message);
      toast.error(message);
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [brandId]);

  useEffect(() => {
    void load(1);
    return () => { requestId.current += 1; };
  }, [load]);

  const openOrder = (poId: string) => router.push(`/(admin)/tiles/orders/po/${poId}` as any);

  const columns = useMemo<Column<BrandOrderRow>[]>(() => [
    // Sized so the whole queue fits the content area beside the app sidebar on
    // a 1512px window — this is a triage screen, and an operator triaging a
    // release queue should not have to scroll sideways to see the status.
    {
      key: "customer", label: "CUSTOMER", grow: 1, minWidth: 200,
      render: (order) => <CellTitle>{order.customer_name}</CellTitle>,
    },
    {
      key: "number", label: "ORDER NO.", width: 150,
      render: (order) => <CellMono>{order.po_number}</CellMono>,
    },
    { key: "products", label: "PRODUCTS", width: 108, align: "right", render: (o) => <CellNumber value={o.total_products} /> },
    { key: "ordered", label: "ORDERED", width: 104, align: "right", render: (o) => <CellNumber value={o.total_boxes} /> },
    { key: "released", label: "RELEASED", width: 108, align: "right", render: (o) => <CellNumber value={o.boxes_released} /> },
    {
      key: "remaining", label: "REMAINING", width: 114, align: "right",
      render: (o) => <CellNumber value={o.boxes_remaining} dim={o.boxes_remaining === 0} />,
    },
    {
      key: "waiting", label: "WAITING", width: 108, align: "center",
      render: (order) => <AgeingBadge days={order.waiting_days} band={order.ageing_band} compact />,
    },
    {
      // 180px is the floor for the longest pill, "Partially Dispatched".
      key: "status", label: "STATUS", width: 180, align: "center",
      render: (order) => <StatusPill status={order.overall_status} />,
    },
    {
      key: "action", label: "", width: 120, align: "right",
      render: () => <CellLink>Release →</CellLink>,
    },
  ], []);

  if (loading) {
    return (
      <CenteredState>
        <ActivityIndicator color={colors.brand} />
      </CenteredState>
    );
  }

  return (
    <PageShell testID="tile-brand-queue-screen">
      <BackLink label="Back to Brands" testID="tile-brand-queue-back" onPress={() => router.back()} />

      {/* The brand's display name is not on this endpoint's rows
          (BrandOrderRow carries po/customer fields only), so the page keeps
          the generic queue title rather than inventing one from the route id. */}
      <PageHeader
        eyebrow="GROUND FLOOR · TILES"
        title="Brand release queue"
        subtitle="Every customer order this brand still owes material against."
      />

      <Section>
        <WorkflowRail active="release" testID="tile-brand-queue-workflow-rail" />
      </Section>

      {loadError ? (
        <Section>
          <View style={styles.errorBlock}>
            <Text style={type.titleSm}>{loadError}</Text>
            <Button label="Retry" variant="primary" testID="tile-brand-queue-retry" onPress={() => load()} />
          </View>
        </Section>
      ) : (
        <>
          {kpi ? (
            <Section>
              <StatRow testID="tile-brand-queue-kpis">
                <Stat label="Orders" value={kpi.orders} />
                <Stat label="Pending" value={kpi.pending} tone={kpi.pending > 0 ? "warn" : "default"} />
                <Stat label="Released" value={kpi.ready} tone="brand" />
                <Stat label="Partial" value={kpi.partially_dispatched} />
                <Stat label="Completed" value={kpi.completed} />
                <Stat label="Units remaining" value={kpi.boxes_remaining} />
                <Stat label="Units released" value={kpi.boxes_released} />
                <Stat label="Oldest waiting" value={`${kpi.oldest_pending_days}d`} tone={kpi.oldest_pending_days > 7 ? "warn" : "default"} />
              </StatRow>
            </Section>
          ) : null}

          <Section>
            <DataTable
              testID="tile-brand-queue-table"
              scrollOwner="parent"
              columns={columns}
              data={orders}
              rowMinHeight={60}
              keyExtractor={(order) => order.po_id}
              rowTestID={(order) => `tile-brand-order-${order.po_id}`}
              onRowPress={(order) => openOrder(order.po_id)}
              emptyMessage="No orders for this brand yet."
            />
            {hasMore ? (
              <View style={styles.loadMore}>
                <Button label="Load more" size="lg" testID="tile-brand-queue-load-more" onPress={() => void load(page + 1)} />
              </View>
            ) : null}
          </Section>
        </>
      )}
    </PageShell>
  );
}

const styles = StyleSheet.create({
  errorBlock: { alignItems: "flex-start", gap: spacing.lg },
  loadMore: { alignItems: "center", paddingTop: spacing.lg },
});
