// frontend/app/(admin)/tiles/orders/[id].tsx
// Ground Floor → Tiles → Tile Orders → Customer detail — this IS BuildCon
// operations (workflow redesign, 2026-08). Once a Brand releases material,
// it shows up here for BuildCon to decide: Move to Godown, or Dispatch
// (from Released or from Godown stock) straight to the customer. The
// Brand/Company page never makes this decision and never generates a
// Chalan — only the two Dispatch actions on this page do. Products are
// grouped by BRAND (never by dealer/supplier company).
//
// This is the screen an operator sits on all day, so it leads with the order
// summary, then the workflow position, then one section per brand whose every
// product line is immediately actionable.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { tileOrdersApi, type CustomerOrderDetail, type CustomerOrderItem } from "@/src/api/tileOrders";
import { toast } from "@/src/components/Toast";
import { DispatchRecordSheet, openChalanPdf } from "@/src/components/tiles/DispatchRecordSheet";
import { DispatchFromGodownSheet, DispatchFromReleasedSheet, MoveToGodownSheet } from "@/src/components/tiles/TileMovementSheets";
import {
  BackLink, Button, ButtonGroup, Card, CenteredState, PageHeader, PageShell,
  Section, SectionHeader, Stat,
} from "@/src/components/tiles/TileLayout";
import { AgeingBadge, StatusPill, WorkflowRail } from "@/src/components/tiles/TileOrderStatusUI";
import { TileOrderProductCell } from "@/src/components/tiles/TileOrderProductCell";
import { tileIdentityMeta } from "@/src/components/tiles/tilePresentation";
import { CellNumber, DataTable, type Column } from "@/src/components/tiles/TileTable";
import { Sheet } from "@/src/components/ui";
import { Dropdown } from "@/src/components/ds";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type } from "@/src/theme/tokens";

type ActiveSheet = { kind: "godown" | "dispatch-released" | "dispatch-godown"; poId: string; item: CustomerOrderItem } | null;

// Keep all movement options discoverable without repeating three wide buttons
// per product. Unavailable movements stay disabled with the current stock hint.
function ItemActions({
  item, poId, onOpen, readOnly = false,
}: { item: CustomerOrderItem; poId: string; onOpen: (sheet: ActiveSheet) => void; readOnly?: boolean }) {
  if (readOnly) return <Text style={styles.hint}>Read-only delivery lookup</Text>;
  const actions: { key: string; label: string; kind: NonNullable<ActiveSheet>["kind"]; enabled: boolean }[] = [
    { key: "move-godown", label: "Move to Godown", kind: "godown", enabled: item.boxes_ready > 0 },
    { key: "dispatch-released", label: "Dispatch from Released", kind: "dispatch-released", enabled: item.boxes_ready > 0 },
    { key: "dispatch-godown", label: "Dispatch from Godown", kind: "dispatch-godown", enabled: item.boxes_godown > 0 },
  ];
  const hint = item.boxes_ready <= 0 && item.boxes_godown <= 0
    ? (item.boxes_pending > 0 ? `Awaiting brand release · ${item.boxes_pending} ${item.quantity_unit === "Pieces" ? "pieces" : "boxes"} still owed` : "Fully dispatched")
    : null;

  return (
    <View style={styles.actionCell}>
      <Dropdown label="Move / Dispatch" testID={`tile-order-actions-${item.po_item_id}`} items={actions.map(action => ({
        label: action.label,
        disabled: !action.enabled,
        testID: `tile-order-${action.key}-${item.po_item_id}`,
        onPress: () => onOpen({ kind: action.kind, poId, item }),
      }))} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export default function CustomerOrderDetailScreen() {
  useRequireFloorAccess("ground-floor");
  const { staff } = useAuth();
  const readOnlyDeliveryLookup = staff?.access_profile === "ground_tile_quotations_followups";
  const { id, timeline: timelineParam } = useLocalSearchParams<{ id: string; timeline?: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<CustomerOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<ActiveSheet>(null);
  const [timeline, setTimeline] = useState<Record<string, any>[] | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [openDispatchId, setOpenDispatchId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      setOrder(await tileOrdersApi.customerOrderDetail(id));
    } catch (e: any) {
      const message = e?.detail || "Could not load order";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const openTimeline = useCallback(async () => {
    if (!id) return;
    setTimelineLoading(true);
    try {
      const result = await tileOrdersApi.customerOrderTimeline(id);
      setTimeline(result.events);
    } catch (e: any) {
      toast.error(e?.detail || "Could not load order timeline");
    } finally {
      setTimelineLoading(false);
    }
  }, [id]);

  // Register rows link here with ?timeline=1 ("Open timeline"), so the
  // sheet has to open itself on arrival rather than waiting for a tap.
  useEffect(() => { if (timelineParam) openTimeline(); }, [timelineParam, openTimeline]);

  // Every timeline event carries the ids of whatever it created
  // (services/activity_log payloads) — a chalan.generated event knows its
  // chalan, a dispatch.* event knows its dispatch. Those are what make a
  // timeline row worth clicking.
  const timelineTarget = (event: Record<string, any>): { kind: "chalan" | "dispatch"; id: string } | null => {
    const payload = event.payload || {};
    if (payload.chalan_id && event.event_type === "chalan.generated") return { kind: "chalan", id: payload.chalan_id };
    if (payload.dispatch_id) return { kind: "dispatch", id: payload.dispatch_id };
    if (payload.chalan_id) return { kind: "chalan", id: payload.chalan_id };
    return null;
  };

  const openTimelineTarget = (event: Record<string, any>) => {
    const target = timelineTarget(event);
    if (!target) return;
    if (target.kind === "chalan") {
      openChalanPdf(target.id);
    } else {
      setTimeline(null);
      setOpenDispatchId(target.id);
    }
  };

  // Counters are fixed-width and right-aligned so a operator can compare the
  // same figure straight down the column; the product name absorbs the rest.
  const columns = useMemo<Column<CustomerOrderItem & { __poId: string }>[]>(() => [
    {
      key: "product", label: "TILE NAME", grow: 3, minWidth: 320, mobile: "primary",
      render: (item) => (
        <TileOrderProductCell
          name={item.tile_name}
          subtitle={tileIdentityMeta([item.series, item.finish, item.size], item.sku)}
          image={item.image} sku={item.sku} testID={`tile-customer-product-image-${item.po_item_id}`}
        />
      ),
    },
    { key: "ordered", label: "ORDERED", width: 120, align: "right", render: (i) => <CellNumber value={`${i.boxes_ordered} ${i.quantity_unit === "Pieces" ? "pieces" : "boxes"}`} /> },
    { key: "released", label: "RELEASED", width: 124, align: "right", mobile: "hidden", render: (i) => <CellNumber value={`${i.boxes_ready} ${i.quantity_unit === "Pieces" ? "pieces" : "boxes"}`} /> },
    { key: "godown", label: "GODOWN", width: 120, align: "right", mobile: "hidden", render: (i) => <CellNumber value={`${i.boxes_godown} ${i.quantity_unit === "Pieces" ? "pieces" : "boxes"}`} /> },
    { key: "dispatched", label: "DISPATCHED", width: 136, align: "right", mobile: "hidden", render: (i) => <CellNumber value={`${i.boxes_dispatched} ${i.quantity_unit === "Pieces" ? "pieces" : "boxes"}`} /> },
    {
      key: "delivered", label: "DELIVERED", width: 118, align: "right", mobile: "hidden",
      render: (i) => <CellNumber value={i.current_location === "Delivered" ? `${i.boxes_dispatched} ${i.quantity_unit === "Pieces" ? "pieces" : "boxes"}` : "—"} dim={i.current_location !== "Delivered"} />,
    },
    { key: "remaining", label: "REMAINING", width: 130, align: "right", render: (i) => <CellNumber value={`${i.boxes_pending} ${i.quantity_unit === "Pieces" ? "pieces" : "boxes"}`} dim={i.boxes_pending === 0} /> },
    {
      // Keep the movement menu visible while reading the fulfilment counters.
      key: "actions", label: "ACTIONS", width: 260, sticky: true, mobile: "action",
      render: (item) => <ItemActions item={item} poId={item.__poId} onOpen={setSheet} readOnly={readOnlyDeliveryLookup} />,
    },
  ], [readOnlyDeliveryLookup]);

  if (loading) {
    return (
      <CenteredState>
        <ActivityIndicator color={colors.brand} />
      </CenteredState>
    );
  }

  if (loadError || !order) {
    return (
      <CenteredState>
        <Text style={type.titleMd}>{loadError || "Order not found"}</Text>
        <Button label="Retry" variant="primary" testID="tile-order-retry" onPress={() => load()} />
        <BackLink label="Back to Tile Orders" testID="tile-order-back" onPress={() => router.back()} />
      </CenteredState>
    );
  }

  const { summary, suppliers: brandGroups } = order;

  return (
    <>
      <PageShell testID="tile-order-detail-screen">
        <BackLink label="Back to Tile Orders" testID="tile-order-back" onPress={() => router.back()} />

        <PageHeader
          eyebrow={summary.number}
          title={summary.customer_name}
          subtitle={`Ordered ${summary.order_date.slice(0, 10)} · ${summary.brand_count} brand${summary.brand_count === 1 ? "" : "s"}`}
          actions={
            // The whole workflow is reachable from the order it belongs to.
            // Without these, Register/Dispatches/Timeline were three separate
            // screens an operator had to find and re-filter by hand, which is
            // what made this page read as a report.
            <ButtonGroup>
              <Button
                label={timelineLoading ? "Loading timeline…" : "View Timeline"}
                testID="tile-order-view-timeline"
                onPress={openTimeline}
              />
              <Button
                label="View Register"
                testID="tile-order-view-register"
                onPress={() => router.push(`/(admin)/tiles/orders?tab=material-register&search=${encodeURIComponent(summary.customer_name)}` as any)}
              />
              <Button
                label="View Dispatches"
                testID="tile-order-view-dispatches"
                onPress={() => router.push(`/(admin)/tiles/orders?tab=dispatch-list&search=${encodeURIComponent(summary.customer_name)}` as any)}
              />
            </ButtonGroup>
          }
        />

        <Section testID="tile-order-summary">
          <Card>
            <View style={styles.summaryBadges}>
              <StatusPill status={summary.overall_status} />
              <AgeingBadge days={summary.waiting_days} band={summary.ageing_band} />
            </View>
            <View style={styles.summaryStats}>
              <Stat label="Products" value={summary.total_products} />
              <Stat label="Units ordered" value={summary.total_boxes} />
              <Stat label="Complete" value={`${summary.completion_percentage}%`} tone="brand" />
              <Stat label="Brands" value={summary.brand_count} />
              <Stat label="Waiting" value={`${summary.waiting_days}d`} tone={summary.ageing_band === "green" ? "default" : "warn"} />
            </View>
          </Card>
        </Section>

        <Section>
          <WorkflowRail
            active={summary.completion_percentage >= 100 ? "delivered" : summary.overall_status === "Ready" ? "released" : "release"}
            testID="tile-customer-workflow-rail"
          />
        </Section>

        {brandGroups.map((group) => (
          <Section key={group.purchase_order_id} testID={`tile-order-brand-${group.purchase_order_id}`}>
            <SectionHeader
              title={group.brand_name}
              meta={<StatusPill status={group.overall_status} />}
              actions={!readOnlyDeliveryLookup ? (
                // Releasing is the brand's step, but this is where an operator
                // notices it is owed — so the release queue has to be one tap
                // from here, not a separate hunt through the Brands tab.
                <Button
                  label="Open Release Queue →"
                  testID={`tile-order-open-release-queue-${group.purchase_order_id}`}
                  onPress={() => router.push(`/(admin)/tiles/orders/po/${group.purchase_order_id}` as any)}
                />
              ) : undefined}
            />
            <DataTable
              scrollOwner="parent"
              columns={columns}
              data={group.items.map((item) => ({ ...item, __poId: group.purchase_order_id }))}
              keyExtractor={(item) => item.po_item_id}
              rowMinHeight={76}
              emptyMessage="No product lines on this brand order."
            />
            <Text testID={`tile-order-delivery-note-${group.purchase_order_id}`} style={styles.note}>
              Delivered is populated only when the existing workflow records a delivery confirmation.
            </Text>
          </Section>
        ))}
      </PageShell>

      <Sheet
        visible={timeline !== null}
        onClose={() => setTimeline(null)}
        title="Order timeline"
        subtitle="Immutable material movement history"
        testID="tile-order-timeline-sheet"
      >
        {/* Fields must match what GET /tile-orders/customer-orders/{id}/timeline
            actually returns — activity_events documents, whose human text is
            `summary` and whose kind is `event_type` (services/activity_log.py).
            Reading `title`/`type` made every row render "Workflow event". */}
        <ScrollView contentContainerStyle={styles.timelineList}>
          {timeline?.length ? timeline.map((event, index) => {
            const target = timelineTarget(event);
            return (
              <View
                key={`${event.id || event.created_at || "event"}-${index}`}
                testID={`tile-order-timeline-event-${index}`}
                style={styles.timelineRow}
              >
                <Text style={type.bodyStrong}>{event.summary || event.event_type || "Workflow event"}</Text>
                <Text style={type.bodyMuted}>
                  {[(event.created_at || "").slice(0, 16).replace("T", " ") || "—", event.actor_name].filter(Boolean).join(" · ")}
                </Text>
                {target ? (
                  <View style={styles.timelineAction}>
                    <Button
                      label={target.kind === "chalan" ? "Open Chalan PDF" : "Open dispatch"}
                      size="sm"
                      onPress={() => openTimelineTarget(event)}
                    />
                  </View>
                ) : null}
              </View>
            );
          }) : <Text style={type.bodyMuted}>No timeline events yet.</Text>}
        </ScrollView>
      </Sheet>

      {openDispatchId ? (
        <DispatchRecordSheet
          dispatchId={openDispatchId}
          onClose={() => setOpenDispatchId(null)}
          onChanged={async () => { await load(); }}
          readOnly={readOnlyDeliveryLookup}
        />
      ) : null}

      {sheet?.kind === "godown" ? (
        <MoveToGodownSheet
          poId={sheet.poId} items={[sheet.item]} onClose={() => setSheet(null)}
          onDone={async () => { setSheet(null); await load(); }}
        />
      ) : null}
      {sheet?.kind === "dispatch-released" ? (
        <DispatchFromReleasedSheet
          poId={sheet.poId} items={[sheet.item]} onClose={() => setSheet(null)}
          onDone={async () => { setSheet(null); await load(); }}
        />
      ) : null}
      {sheet?.kind === "dispatch-godown" ? (
        <DispatchFromGodownSheet
          poId={sheet.poId} items={[sheet.item]} onClose={() => setSheet(null)}
          onDone={async () => { setSheet(null); await load(); }}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  summaryBadges: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.s12, marginBottom: spacing.s20 },
  summaryStats: { flexDirection: "row", flexWrap: "wrap", columnGap: spacing.s40, rowGap: spacing.s24 },
  actionCell: { gap: spacing.s8, width: "100%" },
  hint: { ...type.caption, color: colors.onSurfaceMuted },
  note: { ...type.caption, color: colors.onSurfaceMuted, marginTop: spacing.s12 },
  timelineList: { padding: spacing.s24, gap: spacing.lg },
  timelineRow: {
    paddingBottom: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
    gap: spacing.s4,
  },
  timelineAction: { marginTop: spacing.s8, alignSelf: "flex-start" },
});
