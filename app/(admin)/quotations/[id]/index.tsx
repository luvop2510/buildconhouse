import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActivityTimeline, TimelineEvent } from "@/src/components/ActivityTimeline";
import { useBp } from "@/src/design/responsive";
import { Alert, Button, Card, IconButton, PageHeader, PriceTag, StatusBadge } from "@/src/components/ui";
import { ConfirmDialog } from "@/src/components/ds";
import { api } from "@/src/api/client";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { colors, money, radius, spacing, type } from "@/src/theme/tokens";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";

type Line = { id: string; sku: string; name: string; qty: number; unit_price: number; discount_pct: number | null; room?: string; description?: string | null; category_id?: string | null; godown_stock_id?: string | null; godown_source_customer_name?: string | null; godown_source_purchased_at?: string | null; godown_allocated_at?: string | null };
type Quotation = {
  id: string; number: string; customer_name: string; status: string;
  items: Line[]; rooms: string[]; subtotal: number; discount_total: number;
  grand_total: number; created_at: string; notes?: string;
  created_by_name: string;
  project_discount_pct?: number;
  category_discounts?: Record<string, number>;
};
type Breakdown = {
  lines: { line_id: string; discount_pct: number; discount_source: string; discount_amount: number; gross: number; net: number; total: number }[];
  totals: { subtotal: number; discount_total: number; grand_total: number };
  project_discount_pct: number;
  category_discounts: Record<string, number>;
};

const NEXT_STATUS: Record<string, string> = {
  draft: "sent",
  sent: "won",
  pending_approval: "approved",
};

type PoStub = { id: string; number: string; brand_name?: string | null; status: string; grand_total: number };

export default function QuotationDetail() {
  useRequireFloorAccess("first-floor");
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { isPhone } = useBp();
  const isTablet = !isPhone;

  const [q, setQ] = useState<Quotation | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [linkedPos, setLinkedPos] = useState<PoStub[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [relatedError, setRelatedError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setRelatedError(false);
    try {
      const [doc, br, tl, pos] = await Promise.all([
        api.get<Quotation>(`/quotations/${id}`),
        api.get<Breakdown>(`/quotations/${id}/breakdown`).catch(() => null),
        api.get<TimelineEvent[]>(`/activity/quotation/${id}`).catch(() => { setRelatedError(true); return []; }),
        api.get<PoStub[]>(`/purchase-orders?quotation_id=${id}`).catch(() => { setRelatedError(true); return []; }),
      ]);
      setQ(doc); setBreakdown(br); setTimeline(tl); setLinkedPos(pos);
    } catch (e: any) {
      setQ(null);
      setLoadError(e?.detail || "Could not load this quotation");
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const openPdf = async () => {
    const name = (q?.customer_name || "Customer").replace(/[\\\\/:*?\"<>|]/g, "").trim().replace(/\s+/g, " ") || "Customer";
    await downloadApiFile(`/quotations/${id}/pdf`, `${name}.pdf`, "quotation PDF");
  };

  const advance = async () => {
    if (!q || advancing) return;
    const next = NEXT_STATUS[q.status];
    if (!next) return;
    setAdvancing(true); setActionError(null);
    try {
      const updated = await api.patch<Quotation>(`/quotations/${id}`, { status: next, reason: `Marked ${next}` });
      setQ(updated);
    } catch (error: any) { setActionError(error?.detail || "Could not update this quotation. Try again."); }
    finally { setAdvancing(false); }
  };

  const deleteQuotation = async () => {
    setDeleting(true);
    try {
      await api.delete(`/quotations/${id}`);
      setDeleteOpen(false);
      router.replace("/(admin)/quotations" as any);
    } catch (e: any) {
      // Keep the dialog open so a manager can read/retry after a protected
      // order/payment response rather than losing the failure context.
      setActionError(e?.detail || "Quotation could not be deleted");
      setDeleteOpen(false);
    } finally { setDeleting(false); }
  };

  if (loading) return <View style={styles.centered}><ActivityIndicator color={colors.brand} /></View>;
  if (loadError || !q) return (
    <View style={styles.centered}>
      <Text style={type.titleMd}>{loadError || "Quotation not found"}</Text>
      <Button label="Retry" onPress={load} />
      <Button label="Back" variant="secondary" onPress={() => router.back()} />
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <PageHeader title={q.number} overline="Quotation" back={() => router.back()} actions={
        <View style={{ flexDirection: "row", gap: isPhone ? 4 : 8, alignItems: "center", flexShrink: 0 }}>
          {isPhone ? (
            <IconButton icon="edit-3" tone="surface" onPress={() => router.push(`/(admin)/quotations/new?quotationId=${encodeURIComponent(id)}` as any)} testID="edit-quotation" accessibilityLabel="Edit quotation" />
          ) : <Button label="Edit" icon="edit-3" variant="secondary" size="sm" onPress={() => router.push(`/(admin)/quotations/new?quotationId=${encodeURIComponent(id)}` as any)} testID="edit-quotation" />}
          {isPhone ? (
            <IconButton icon="download" tone="surface" onPress={openPdf} testID="download-pdf" accessibilityLabel="Download PDF" />
          ) : <Button label="PDF" icon="download" variant="secondary" size="sm" onPress={openPdf} testID="download-pdf" />}
          {isPhone ? (
            <IconButton icon="trash-2" tone="danger" onPress={() => setDeleteOpen(true)} testID="delete-quotation" accessibilityLabel="Delete quotation" />
          ) : <Button label="Delete" icon="trash-2" variant="danger" size="sm" onPress={() => setDeleteOpen(true)} testID="delete-quotation" />}
          {NEXT_STATUS[q.status] ? (
            isPhone ? (
              <IconButton icon="check" tone="brand" disabled={advancing} onPress={advance} testID="advance-status" accessibilityLabel={`Mark ${NEXT_STATUS[q.status].replace("_", " ")}`} />
            ) : (
              <Button label={isTablet ? `Mark ${NEXT_STATUS[q.status].replace("_", " ")}` : "Mark"} icon="check" size="sm" disabled={advancing} onPress={advance} testID="advance-status" />
            )
          ) : null}
        </View>
      } />

      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.huge }}>
        {actionError ? <Alert tone="error" title="Action not completed" description={actionError} /> : null}
        {relatedError ? <Alert tone="warning" title="Some related records are unavailable" description="Order links or activity may be incomplete. Reload to refresh them." /> : null}
        {/* Document summary */}
        <View style={styles.hero}>
          <StatusBadge status={q.status} />
          <Text accessibilityRole="header" aria-level={2} style={[type.titleLg, { marginTop: 10 }]} numberOfLines={2}>{q.customer_name || "Unknown customer"}</Text>
          <Text style={[type.bodyMuted, { marginTop: 4 }]}>
            Prepared by {q.created_by_name} · {new Date(q.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
          </Text>
          <View style={styles.heroDivider} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
            <View>
              <Text style={type.caption}>Grand total</Text>
              <PriceTag price={q.grand_total} size="xl" />
            </View>
            {q.status !== "ordered" && q.items.length > 0 ? (
              <Pressable
                onPress={() => router.push(`/(admin)/quotations/${id}/place-order` as any)}
                style={({ pressed }) => [styles.placeOrder, { opacity: pressed ? 0.88 : 1 }]}
                testID="place-order-btn"
              >
                <Feather name="shopping-cart" size={14} color={colors.brand} />
                <Text style={styles.placeOrderText}>Place Order</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Line items — tablet: table, phone: stacked cards */}
        {isTablet ? (
          <Card style={{ padding: 0 }} variant="flat">
            <View style={styles.tableHead}>
              <Text style={[type.overline, { width: 40 }]}>#</Text>
              <Text style={[type.overline, { flex: 1 }]}>Item</Text>
              <Text style={[type.overline, { width: 60, textAlign: "right" }]}>QTY</Text>
              <Text style={[type.overline, { width: 100, textAlign: "right" }]}>RATE</Text>
              <Text style={[type.overline, { width: 70, textAlign: "right" }]}>DISC%</Text>
              <Text style={[type.overline, { width: 110, textAlign: "right" }]}>AMOUNT</Text>
            </View>
            {q.items.map((it, i) => {
              const br = breakdown?.lines.find((b) => b.line_id === it.id);
              const pct = br?.discount_pct ?? (it.discount_pct ?? 0);
              const source = br?.discount_source ?? (it.discount_pct != null ? "product" : "none");
              return (
                <View key={it.id} style={styles.tableRow}>
                  <Text style={[type.mono, { width: 40 }]}>{String(i + 1).padStart(2, "0")}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontFamily: type.titleMd.fontFamily, fontWeight: "600", color: colors.onSurface }} numberOfLines={2}>{it.name}</Text>
                    <Text style={type.caption}>{it.sku}{it.room ? ` · ${it.room}` : ""}</Text>
                    <GodownProvenance item={it} />
                  </View>
                  <Text style={[type.mono, { width: 60, textAlign: "right" }]} numberOfLines={1}>{it.qty}</Text>
                  <Text style={[type.mono, { width: 100, textAlign: "right" }]} numberOfLines={1}>{money(it.unit_price)}</Text>
                  <View style={{ width: 70, alignItems: "flex-end" }}>
                    <Text style={type.mono}>{pct}%</Text>
                    {source !== "none" && source !== "product" ? <Text style={[type.caption, { fontSize: 10 }]}>via {source}</Text> : null}
                  </View>
                  <Text style={{ width: 110, textAlign: "right", fontSize: 14, fontFamily: type.titleMd.fontFamily, fontWeight: "700", fontVariant: ["tabular-nums"], color: colors.onSurface }} numberOfLines={1}>
                    {money(it.qty * it.unit_price * (1 - pct / 100))}
                  </Text>
                </View>
              );
            })}
          </Card>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {q.items.map((it, i) => {
              const br = breakdown?.lines.find((b) => b.line_id === it.id);
              const pct = br?.discount_pct ?? (it.discount_pct ?? 0);
              const lineTotal = it.qty * it.unit_price * (1 - pct / 100);
              return (
                <View key={it.id} style={styles.mobileLineCard}>
                  <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" }}>
                    <View style={styles.lineIdx}>
                      <Text style={styles.lineIdxText}>{String(i + 1).padStart(2, "0")}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 14, fontFamily: type.titleMd.fontFamily, fontWeight: "600", color: colors.onSurface }} numberOfLines={2}>{it.name}</Text>
                      <Text style={[type.caption, { marginTop: 2 }]}>{it.sku}{it.room ? ` · ${it.room}` : ""}</Text>
                      <GodownProvenance item={it} />
                    </View>
                  </View>
                  <View style={styles.lineMeta}>
                    <View style={styles.metaCol}>
                      <Text style={type.caption}>Qty</Text>
                      <Text style={styles.metaValue}>{it.qty}</Text>
                    </View>
                    <View style={styles.metaCol}>
                      <Text style={type.caption}>Rate</Text>
                      <Text style={styles.metaValue} numberOfLines={1}>{money(it.unit_price)}</Text>
                    </View>
                    <View style={styles.metaCol}>
                      <Text style={type.caption}>Disc</Text>
                      <Text style={styles.metaValue}>{pct}%</Text>
                    </View>
                    <View style={[styles.metaCol, { alignItems: "flex-end" }]}>
                      <Text style={type.caption}>Total</Text>
                      <Text style={[styles.metaValue, { color: colors.brand }]} numberOfLines={1}>{money(lineTotal)}</Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* Totals card */}
        <Card variant="flat">
          <View style={{ gap: 8 }}>
            {q.project_discount_pct ? (
              <Row label="Project discount" value={`${q.project_discount_pct}%`} />
            ) : null}
            {q.category_discounts && Object.keys(q.category_discounts).length ? (
              <Row label="Category discounts" value={`${Object.keys(q.category_discounts).length} rules`} />
            ) : null}
            <Row label="Subtotal" value={money(q.subtotal)} />
            <Row label="Discount" value={`- ${money(q.discount_total)}`} />
            <View style={styles.totalRow}>
              <Text style={{ fontSize: 15, fontFamily: type.titleMd.fontFamily, fontWeight: "700", color: colors.onSurface }}>Grand total</Text>
              <Text style={{ fontSize: 22, fontFamily: type.displayMd.fontFamily, fontWeight: "700", fontVariant: ["tabular-nums"], color: colors.onSurface, letterSpacing: -0.3 }} numberOfLines={1}>
                {money(q.grand_total)}
              </Text>
            </View>
          </View>
        </Card>

        {q.notes ? (
          <Card variant="flat">
            <Text style={type.overline}>Notes</Text>
            <Text style={[type.body, { color: colors.onSurfaceSecondary, marginTop: 6, lineHeight: 22 }]}>{q.notes}</Text>
          </Card>
        ) : null}

        {linkedPos.length > 0 ? (
          <Card variant="flat">
            <Text style={type.overline}>Linked Purchase Orders</Text>
            <View style={{ gap: 8, marginTop: spacing.md }}>
              {linkedPos.map((po) => (
                <Pressable
                  key={po.id}
                  testID={`linked-po-${po.id}`}
                  onPress={() => router.push(`/(admin)/purchase-orders/${po.id}` as any)}
                  style={[styles.linkedPoRow, isPhone && styles.linkedPoRowPhone]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[type.mono, { fontSize: 12 }]}>{po.number}</Text>
                    <Text style={{ fontSize: 13, fontFamily: type.titleMd.fontFamily, fontWeight: "600", marginTop: 2, color: colors.onSurface }}>{po.brand_name || "—"}</Text>
                  </View>
                  <View style={[styles.linkedPoMeta, isPhone && styles.linkedPoMetaPhone]}>
                    <StatusBadge status={po.status} />
                    <Text style={[styles.linkedPoTotal, isPhone && styles.linkedPoTotalPhone]} numberOfLines={1}>{money(po.grand_total)}</Text>
                    <Feather name="chevron-right" size={14} color={colors.onSurfaceMuted} />
                  </View>
                </Pressable>
              ))}
            </View>
          </Card>
        ) : null}

        <Card variant="flat">
          <Text style={type.overline}>Activity</Text>
          <View style={{ marginTop: spacing.md }}>
            <ActivityTimeline events={timeline} emptyLabel="No activity yet — every mutation from now on will land here." />
          </View>
        </Card>
      </ScrollView>
      <ConfirmDialog
        visible={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={deleteQuotation}
        title="Delete this quotation?"
        description="This removes the quotation, linked follow-ups, and unpaid payment records. Completed payments and purchase orders are protected."
        confirmLabel="Delete quotation"
        tone="danger"
        loading={deleting}
        testID="confirm-delete-quotation"
      />
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}>
      <Text style={type.bodyMuted} numberOfLines={1}>{label}</Text>
      <Text style={{ fontSize: 14, fontFamily: type.bodyStrong.fontFamily, fontWeight: "500", fontVariant: ["tabular-nums"], color: colors.onSurface, flexShrink: 0 }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function GodownProvenance({ item }: { item: Line }) {
  if (!item.godown_stock_id) return null;
  const purchased = item.godown_source_purchased_at ? new Date(item.godown_source_purchased_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "date not recorded";
  return <View style={styles.godownTag}><Feather name="archive" size={11} color={colors.brand} /><Text style={styles.godownText}>From godown · {item.godown_source_customer_name || "source not recorded"} · purchased {purchased}</Text></View>;
}

const styles = StyleSheet.create({
  centered: {
    flex: 1, alignItems: "center", justifyContent: "center",
    gap: spacing.md, padding: spacing.xl, backgroundColor: colors.surface,
  },
  topbar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: spacing.lg, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  hero: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    padding: spacing.lg,
  },
  heroDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  placeOrder: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.brandTint,
    borderWidth: 1, borderColor: colors.brandBorder,
  },
  placeOrderText: {
    fontSize: 13, fontFamily: type.titleMd.fontFamily,
    fontWeight: "600", color: colors.brand,
  },
  godownTag: { marginTop: 5, flexDirection: "row", gap: 4, padding: 6, borderRadius: 6, backgroundColor: colors.brandTint },
  godownText: { flex: 1, fontSize: 10, lineHeight: 14, color: colors.onSurfaceSecondary },
  tableHead: {
    flexDirection: "row",
    padding: spacing.md,
    backgroundColor: colors.surfaceTertiary,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    alignItems: "center", gap: 8,
  },
  tableRow: {
    flexDirection: "row", padding: spacing.md, alignItems: "center", gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.divider,
  },
  mobileLineCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    padding: spacing.md, gap: spacing.md,
  },
  lineIdx: {
    width: 28, height: 28, borderRadius: 8,
    backgroundColor: colors.brandTint,
    alignItems: "center", justifyContent: "center",
  },
  lineIdxText: {
    fontSize: 11, fontFamily: type.titleMd.fontFamily,
    fontWeight: "700", color: colors.brand,
    fontVariant: ["tabular-nums"],
  },
  lineMeta: {
    flexDirection: "row", justifyContent: "space-between",
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.divider,
  },
  metaCol: { gap: 2, minWidth: 60 },
  metaValue: {
    fontSize: 13, fontFamily: type.titleMd.fontFamily,
    fontWeight: "600", color: colors.onSurface,
    fontVariant: ["tabular-nums"],
  },
  totalRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingTop: spacing.md,
    marginTop: 6,
    borderTopWidth: 1, borderColor: colors.borderStrong,
  },
  linkedPoRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    padding: spacing.md, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  linkedPoRowPhone: { alignItems: "flex-start", gap: spacing.sm },
  linkedPoMeta: { flexDirection: "row", alignItems: "center", gap: spacing.md, flexShrink: 0 },
  linkedPoMetaPhone: { flexDirection: "column", alignItems: "flex-end", gap: 4 },
  linkedPoTotal: { width: 100, textAlign: "right", fontFamily: type.titleMd.fontFamily, fontWeight: "600", fontVariant: ["tabular-nums"], color: colors.onSurface },
  linkedPoTotalPhone: { width: undefined, maxWidth: 120 },
});
