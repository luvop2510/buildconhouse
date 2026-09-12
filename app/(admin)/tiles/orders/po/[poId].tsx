// frontend/app/(admin)/tiles/orders/po/[poId].tsx
// Ground Floor → Tiles → Tile Orders → Brands → Brand → Order detail —
// the Brand page's ONLY responsibility is Release Material (workflow
// redesign, 2026-08). The supplier/brand never decides Godown or Dispatch
// — those decisions, and the Chalan, belong to BuildCon on the Customer
// page (see app/(admin)/tiles/orders/[id].tsx). Nothing else happens here.
//
// Because the page does exactly one job, the release table is the page: it
// takes the full content width, the quantity inputs share one column so they
// align down the screen, and the batch total plus "Release Selected" live in
// a sticky bar that is always reachable without scrolling back.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { tileOrdersApi, type PurchaseOrderDetail } from "@/src/api/tileOrders";
import { Alert } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import {
  ActionBar, BackLink, Button, ButtonGroup, CenteredState, PageHeader, PageShell,
  Section, Stat, StatRow, Toolbar,
} from "@/src/components/tiles/TileLayout";
import { StatusPill, WorkflowRail } from "@/src/components/tiles/TileOrderStatusUI";
import { tileIdentityMeta } from "@/src/components/tiles/tilePresentation";
import { CellNumber, CellStack, CellText, DataTable, type Column } from "@/src/components/tiles/TileTable";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type ReleaseItem = PurchaseOrderDetail["items"][number];

function qtyUnit(item: ReleaseItem): string {
  return item.quantity_unit === "Pieces" ? "pieces" : "boxes";
}

const webCursor = Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null;

const LINE_TONE = {
  pending: { bg: colors.surfaceTertiary, border: colors.border, fg: colors.onSurfaceSecondary },
  partial: { bg: colors.warningBg, border: colors.warningBorder, fg: colors.warningFg },
  done: { bg: colors.successBg, border: colors.successBorder, fg: colors.successFg },
} as const;

type LineTone = "pending" | "partial" | "done";

function lineStatus(item: ReleaseItem): { label: string; tone: LineTone } {
  if (item.boxes_pending <= 0) return { label: "Released", tone: "done" };
  if (item.boxes_ready > 0) return { label: "Partial", tone: "partial" };
  return { label: "Pending", tone: "pending" };
}

export default function BrandOrderDetailScreen() {
  useRequireFloorAccess("ground-floor");
  const { poId } = useLocalSearchParams<{ poId: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<PurchaseOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [releaseQty, setReleaseQty] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!poId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setOrder(await tileOrdersApi.purchaseOrderDetail(poId));
    } catch (e: any) {
      const message = e?.detail || "Could not load order";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [poId]);

  useEffect(() => { load(); }, [load]);

  // Ticking a line pre-fills its full remaining quantity. Without this the
  // checkbox alone left "Release Selected" disabled until a quantity was
  // also typed by hand, which reads as a dead button.
  const toggleItem = useCallback((itemId: string, remaining: number) => {
    setSelected((current) => {
      const next = !current[itemId];
      if (next) {
        setReleaseQty((qty) => (Number(qty[itemId] || 0) ? qty : { ...qty, [itemId]: String(remaining) }));
      }
      return { ...current, [itemId]: next };
    });
  }, []);

  const setQuantity = useCallback((itemId: string, value: string) => {
    const digits = value.replace(/[^0-9]/g, "");
    setReleaseQty((current) => ({ ...current, [itemId]: digits }));
    if (Number(digits) > 0) setSelected((current) => ({ ...current, [itemId]: true }));
  }, []);

  const releaseOne = useCallback(async (itemId: string, remaining: number) => {
    if (submitting) return;
    setSaveError(null);
    const rawQty = releaseQty[itemId]?.trim() ?? "";
    const qty = Number(rawQty);
    if (!rawQty || !Number.isSafeInteger(qty) || qty <= 0 || qty > remaining) {
      toast.error(`Enter between 1 and ${remaining} ${qtyUnit(order?.items.find((item) => item.id === itemId) || ({ quantity_unit: "Box" } as ReleaseItem))}`);
      return;
    }
    setSubmitting(true);
    try {
      await tileOrdersApi.releaseMaterial(order?.id || poId!, [{ po_item_id: itemId, qty }]);
      const releasedUnit = qtyUnit(order?.items.find((item) => item.id === itemId) || ({ quantity_unit: "Box" } as ReleaseItem));
      toast.success(`${qty} ${releasedUnit} released`);
      setReleaseQty((current) => ({ ...current, [itemId]: "" }));
      setSelected((current) => ({ ...current, [itemId]: false }));
      await load();
    } catch (e: any) {
      setSaveError(e?.detail || "Could not release material. Your selected quantities are retained; try again.");
    } finally {
      setSubmitting(false);
    }
  }, [releaseQty, order?.id, order?.items, poId, load, submitting]);

  const columns = useMemo<Column<ReleaseItem>[]>(() => [
    {
      key: "select", label: "", width: 60, align: "center",
      render: (item) => {
        const selectable = item.boxes_pending > 0;
        const checked = Boolean(selected[item.id]);
        return (
          <Pressable
            testID={`tile-release-select-${item.id}`}
            disabled={!selectable}
            onPress={() => toggleItem(item.id, item.boxes_pending)}
            hitSlop={11}
            accessibilityRole="checkbox"
            accessibilityState={{ checked, disabled: !selectable }}
            accessibilityLabel={`Select ${item.name} for material release`}
            style={({ hovered }: any) => [
              styles.checkbox,
              checked ? styles.checkboxChecked : null,
              !selectable ? styles.checkboxDisabled : null,
              hovered && selectable && !checked ? styles.checkboxHovered : null,
              selectable ? webCursor : null,
            ]}
          >
            {checked ? <Text style={styles.checkboxTick}>✓</Text> : null}
          </Pressable>
        );
      },
    },
    {
      // The only growing column on this table. Leaving FINISH growing too made
      // the two of them split the surplus and push the row 50px past the
      // viewport, which put RELEASE QTY — the page's entire purpose — off
      // screen. One grow column keeps the total predictable.
      key: "product", label: "TILE NAME", grow: 1, minWidth: 200,
      render: (item) => (
        <CellStack title={item.name} subtitle={tileIdentityMeta([item.series, item.size], item.sku)} />
      ),
    },
    {
      key: "finish", label: "FINISH", width: 130,
      render: (item) => <CellText muted>{item.finish || "—"}</CellText>,
    },
    { key: "ordered", label: "ORDERED", width: 104, align: "right", render: (i) => <CellNumber value={`${i.qty} ${qtyUnit(i)}`} /> },
    { key: "released", label: "RELEASED", width: 108, align: "right", render: (i) => <CellNumber value={`${i.boxes_ready} ${qtyUnit(i)}`} /> },
    {
      key: "remaining", label: "REMAINING", width: 116, align: "right",
      render: (i) => <CellNumber value={`${i.boxes_pending} ${qtyUnit(i)}`} dim={i.boxes_pending === 0} />,
    },
    {
      key: "qty", label: "RELEASE QTY", width: 156,
      render: (item) => {
        const selectable = item.boxes_pending > 0;
        return (
          <TextInput
            testID={`tile-release-quantity-${item.id}`}
            editable={selectable}
            value={releaseQty[item.id] || ""}
            onChangeText={(value) => setQuantity(item.id, value)}
            keyboardType="number-pad"
            accessibilityLabel={`Release quantity for ${item.name}`}
            placeholder={selectable ? `Max ${item.boxes_pending} ${qtyUnit(item)}` : "Complete"}
            placeholderTextColor={colors.onSurfaceSubtle}
            style={[styles.qtyInput, !selectable ? styles.qtyInputDisabled : null]}
          />
        );
      },
    },
    {
      key: "status", label: "STATUS", width: 132, align: "center",
      render: (item) => {
        const status = lineStatus(item);
        const tone = LINE_TONE[status.tone];
        return (
          <View style={[styles.lineStatus, { backgroundColor: tone.bg, borderColor: tone.border }]}>
            <Text numberOfLines={1} style={[styles.lineStatusText, { color: tone.fg }]}>
              {status.label}
            </Text>
          </View>
        );
      },
    },
    {
      // Pinned so the per-line Release button stays reachable on a viewport
      // too narrow to show the whole row.
      key: "action", label: "ACTIONS", width: 136,
      render: (item) => (
        item.boxes_pending > 0 ? (
          <Button
            label="Release"
            size="sm"
            variant="primary"
            disabled={submitting}
            testID={`tile-release-row-${item.id}`}
            onPress={() => releaseOne(item.id, item.boxes_pending)}
          />
        ) : (
          <Text style={styles.completeText}>Complete</Text>
        )
      ),
    },
  ], [selected, releaseQty, submitting, toggleItem, setQuantity, releaseOne]);

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
        <Button label="Retry" variant="primary" onPress={() => load()} />
        <BackLink label="Back" testID="tile-brand-release-back" onPress={() => router.back()} />
      </CenteredState>
    );
  }

  const anyPending = order.items.some((item) => item.boxes_pending > 0);
  const selectedItems = order.items.flatMap((item) => {
    const qty = Number(releaseQty[item.id] || 0);
    return selected[item.id] && qty > 0 && qty <= item.boxes_pending ? [{ po_item_id: item.id, qty }] : [];
  });
  const selectedBoxes = selectedItems.reduce((total, item) => total + item.qty, 0);
  const totals = order.items.reduce(
    (acc, item) => ({
      ordered: acc.ordered + item.qty,
      released: acc.released + item.boxes_ready,
      remaining: acc.remaining + item.boxes_pending,
    }),
    { ordered: 0, released: 0, remaining: 0 },
  );

  const selectAllPending = () => {
    const nextSelected: Record<string, boolean> = {};
    const nextQty: Record<string, string> = { ...releaseQty };
    order.items.forEach((item) => {
      if (item.boxes_pending > 0) {
        nextSelected[item.id] = true;
        if (!Number(nextQty[item.id] || 0)) nextQty[item.id] = String(item.boxes_pending);
      }
    });
    setSelected(nextSelected);
    setReleaseQty(nextQty);
  };

  const clearSelection = () => {
    setSelected({});
    setReleaseQty({});
  };

  const releaseSelected = async () => {
    if (submitting || !selectedItems.length) return;
    setSaveError(null);
    setSubmitting(true);
    try {
      await tileOrdersApi.releaseMaterial(order.id, selectedItems);
      toast.success(`${selectedItems.length} product line${selectedItems.length === 1 ? "" : "s"} released`);
      setReleaseQty({});
      setSelected({});
      await load();
    } catch (e: any) {
      setSaveError(e?.detail || "Could not release material. Your selected quantities are retained; try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageShell
      testID="tile-brand-release-screen"
      footer={
        <ActionBar testID="tile-release-action-bar">
          <Text style={styles.footerMeta}>
            {anyPending
              ? `${selectedItems.length} line${selectedItems.length === 1 ? "" : "s"} selected · ${selectedBoxes} units to release`
              : "All material has been released for this brand order."}
          </Text>
          {anyPending ? (
            <ButtonGroup align="right">
              <Button label="Clear" onPress={clearSelection} disabled={!selectedItems.length || submitting} />
              <Button
                label={submitting ? "Releasing…" : "Release Selected"}
                variant="primary"
                size="lg"
                disabled={!selectedItems.length || submitting}
                testID="tile-release-selected"
                onPress={releaseSelected}
              />
            </ButtonGroup>
          ) : null}
        </ActionBar>
      }
    >
      {saveError ? <Alert tone="error" title={saveError} /> : null}
      <BackLink
        label={`Back to ${order.brand_name || "Brand"}`}
        testID="tile-brand-release-back"
        onPress={() => router.back()}
      />

      <PageHeader
        eyebrow={order.number}
        title={order.customer_name}
        subtitle={`${order.brand_name || "Unassigned brand"} · release material to BuildCon`}
        actions={<StatusPill status={order.overall_status} />}
      />

      <Section>
        <WorkflowRail active={anyPending ? "release" : "released"} testID="tile-brand-workflow-rail" />
      </Section>

      <Section>
        <StatRow testID="tile-release-totals">
          <Stat label="Product lines" value={order.items.length} />
          <Stat label="Units ordered" value={totals.ordered} />
          <Stat label="Units released" value={totals.released} tone="brand" />
          <Stat label="Units remaining" value={totals.remaining} tone={totals.remaining > 0 ? "warn" : "default"} />
        </StatRow>
      </Section>

      <Section>
        <Toolbar
          search={
            <Text style={styles.instruction}>
              Select one or more product lines, enter the release quantity, then submit the batch.
            </Text>
          }
          actions={
            anyPending ? (
              <ButtonGroup>
                <Button label="Select all pending" testID="tile-release-select-all" onPress={selectAllPending} />
              </ButtonGroup>
            ) : null
          }
        />
        <DataTable
          testID="tile-release-table"
          scrollOwner="parent"
          columns={columns}
          data={order.items}
          keyExtractor={(item) => item.id}
          rowMinHeight={64}
          isRowSelected={(item) => Boolean(selected[item.id])}
          emptyMessage="This brand order has no product lines."
        />
      </Section>
    </PageShell>
  );
}

const styles = StyleSheet.create({
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radius.xs,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSecondary,
  },
  checkboxHovered: { borderColor: colors.brand },
  checkboxChecked: { backgroundColor: colors.brand, borderColor: colors.brand },
  checkboxDisabled: { borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  checkboxTick: { color: colors.onBrand, fontSize: 13, lineHeight: 16, fontWeight: "700" },

  // One width for every quantity input, so the column reads as a single
  // vertical run of fields rather than a ragged edge.
  qtyInput: {
    width: "100%",
    height: 44,
    borderWidth: 1,
    borderColor: colors.brandBorder,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.s12,
    fontFamily: type.mono.fontFamily,
    fontSize: 13,
    color: colors.onSurface,
    textAlign: "right",
    backgroundColor: colors.surfaceSecondary,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null),
  },
  qtyInputDisabled: { borderColor: colors.border, backgroundColor: colors.surfaceTertiary, color: colors.onSurfaceMuted },

  lineStatus: { height: 24, justifyContent: "center", paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1 },
  lineStatusText: { ...type.captionStrong, fontSize: 12 },

  completeText: { ...type.caption, color: colors.onSurfaceMuted },
  instruction: { ...type.bodyMuted },
  footerMeta: { ...type.bodyStrong, flexShrink: 1 },
});
