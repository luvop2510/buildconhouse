// BuildCon House · Quotations list
// Premium card list: number pill · customer + meta · total · status.
// Optimised for phone (no cramped inline rows), tablet gets a tabular feel.

import { filterValues, matchesFilter, toggleFilterValue } from "@/src/utils/filters";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert as RNAlert, FlatList, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { AdminPage } from "@/src/components/AdminPage";
import { useBp } from "@/src/design/responsive";
import {
  Avatar, Chip, EmptyState, ErrorState, IconButton, SearchField, Skeleton, StatusBadge,
} from "@/src/components/ui";
import { ConfirmDialog } from "@/src/components/ds";
import { api } from "@/src/api/client";
import { colors, font, money, radius, spacing, type } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";

type Quotation = {
  id: string; number: string; customer_name: string;
  purchase_completion_status?: "active" | "completed";
  customer_outcome?: "won" | "lost" | null;
  status: string; grand_total: number; created_at: string; items: any[];
};

type Filter = "all" | "draft" | "pending_approval" | "sent" | "approved" | "ordered" | "won";
const PENDING_FILTERS: { key: Filter; label: string }[] = [
  { key: "all",              label: "All" },
  { key: "draft",            label: "Draft" },
  { key: "pending_approval", label: "Pending" },
  { key: "sent",             label: "Sent" },
];
const COMPLETED_FILTERS: { key: Filter; label: string }[] = [
  { key: "all",      label: "All" },
  { key: "approved", label: "Approved" },
  { key: "ordered",  label: "Ordered" },
  { key: "won",      label: "Approved (legacy)" },
];

export default function QuotationsList() {
  useRequireFloorAccess("first-floor");
  const router = useRouter();
  const { view } = useLocalSearchParams<{ view?: string }>();
  const completed = view === "completed" || view === "fulfilled";
  const outcome = view === "won" || view === "lost" ? view : null;
  const { staff } = useAuth();
  const canDeleteQuotations = useActionAccess("quotations", "delete", !!staff && ["owner", "admin", "manager"].includes(staff.role));
  const { isPhone } = useBp();
  const isTablet = !isPhone;

  const [items, setItems] = useState<Quotation[] | null>(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [deleteTarget, setDeleteTarget] = useState<Quotation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const requestId = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => { setStatusFilter("all"); }, [completed, outcome]);

  const deleteQuotation = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/quotations/${deleteTarget.id}`);
      setItems((current) => current?.filter((item) => item.id !== deleteTarget.id) || []);
      setDeleteTarget(null);
    } catch (e: any) {
      RNAlert.alert("Delete failed", e?.detail || "Quotation could not be deleted");
    } finally { setDeleting(false); }
  };

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoadError(null);
    setItems(null);
    try {
      const nextItems = await api.get<Quotation[]>(outcome
        ? `/quotations?doc_type=standard&view=${outcome}`
        : `/quotations?doc_type=standard&view=${completed ? "completed" : "pending"}`);
      if (currentRequest === requestId.current) setItems(nextItems);
    } catch (e: any) {
      if (currentRequest === requestId.current) setLoadError(e?.detail || "Could not load quotations");
    }
  }, [completed, outcome]);
  useFocusEffect(useCallback(() => {
    void load();
    return () => { requestId.current += 1; };
  }, [load]));

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: items?.length || 0 };
    (items || []).forEach((it) => { map[it.status] = (map[it.status] || 0) + 1; });
    return map;
  }, [items]);

  const filters = outcome ? [{ key: "all" as const, label: "All" }] : completed ? COMPLETED_FILTERS : PENDING_FILTERS;

  const filtered = useMemo(() => (items || []).filter((it) => {
    if (!matchesFilter(it.status, statusFilter)) return false;
    if (q && !`${it.number} ${it.customer_name}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [items, q, statusFilter]);

  const totalValue = filtered.reduce((s, it) => s + (it.grand_total || 0), 0);

  return (
    <AdminPage
      title={outcome ? `${outcome === "won" ? "Won Customer" : "Lost Customer"} · Quotations` : completed ? "Approved & ordered quotations" : "Quotations"}
      subtitle={loadError ? "Pipeline unavailable" : items ? `${items.length} ${outcome ? `${outcome} quotations` : completed ? "approved or ordered" : "pending"} · ${money(totalValue)} filtered` : "Loading pipeline…"}
      scroll={false}
      contentStyle={{ paddingHorizontal: 0, paddingTop: 0 }}
      right={
        <View style={styles.headerActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={completed ? "View pending quotations" : "View completed quotations"}
            testID="quotations-lifecycle-toggle" onPress={() => router.push(`/(admin)/quotations?view=${completed ? "pending" : "completed"}` as any)} style={styles.lifecycleLink}>
            <Text style={styles.lifecycleText}>{completed ? "Pending" : "Completed"}</Text>
          </Pressable>
          {!completed && !outcome ? <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create new quotation"
            testID="new-quotation-btn"
            onPress={() => router.push("/(admin)/quotations/new" as any)}
            style={({ pressed }) => [styles.cta, { opacity: pressed ? 0.88 : 1 }]}
          >
            <Feather name="plus" size={16} color={colors.onBrand} />
            <Text style={styles.ctaText}>New{isTablet ? " Quotation" : ""}</Text>
          </Pressable> : null}
        </View>
      }
    >
      <FlatList
        data={loadError ? [] : items ? filtered : []}
        keyExtractor={(quotation) => quotation.id}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <ScrollView horizontal showsHorizontalScrollIndicator={isPhone} contentContainerStyle={{ gap: 8 }}>
              {(["lost", "won"] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityLabel={`View ${value} customer quotations`}
                accessibilityState={{ selected: outcome === value }} testID={`quotations-${value}-toggle`}
                onPress={() => router.push(`/(admin)/quotations?view=${value}` as any)} style={styles.lifecycleLink}>
                <Text style={styles.lifecycleText}>{value === "lost" ? "Lost Customer" : "Won Customer"}</Text>
              </Pressable>)}
            </ScrollView>
            <SearchField
              testID="quotations-search"
              value={q}
              onChangeText={setQ}
              placeholder="Search by number or customer…"
              onClear={() => setQ("")}
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={isPhone} contentContainerStyle={{ gap: 8, paddingRight: spacing.lg }}>
              {filters.map((f) => (
                <Chip key={f.key} testID={`filter-${f.key}`} label={f.label} active={f.key === "all" ? !filterValues(statusFilter).length : filterValues(statusFilter).includes(f.key)} onPress={() => setStatusFilter(current => toggleFilterValue(current, f.key))} count={counts[f.key]} />
              ))}
            </ScrollView>
          </View>
        }
        ListEmptyComponent={
          loadError ? (
            <ErrorState title="Quotations unavailable" subtitle={loadError} onRetry={load} />
          ) : !items ? (
            <View style={{ gap: spacing.sm }}>
              {Array.from({ length: 6 }).map((_, i) => <View key={i} style={[styles.card, { gap: 10 }]}><Skeleton w={110} h={12} /><Skeleton w={220} h={16} /><Skeleton w={160} h={12} /></View>)}
            </View>
          ) : (
            <EmptyState icon="file-text" title={q || statusFilter !== "all" ? "No quotations match" : "No quotations yet"} subtitle={q || statusFilter !== "all" ? "Try clearing filters or searching a different term." : outcome ? `No ${outcome} customer quotations have been recorded.` : "Press New Quotation to start building."} />
          )
        }
        renderItem={({ item }) => (
          <QuotationRow q={item} onPress={() => router.push(`/(admin)/quotations/${item.id}` as any)} canDelete={canDeleteQuotations} onDelete={() => setDeleteTarget(item)} />
        )}
      />
      <ConfirmDialog
        visible={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteQuotation}
        title="Delete this quotation?"
        description="Linked follow-ups and unpaid payment records will also be removed. Completed payments and purchase orders are protected."
        confirmLabel="Delete quotation"
        tone="danger"
        loading={deleting}
        testID="confirm-delete-quotation-list"
      />
    </AdminPage>
  );
}

// ── Single row card ──
function QuotationRow({ q, onPress, canDelete, onDelete }: { q: Quotation; onPress: () => void; canDelete: boolean; onDelete: () => void }) {
  const created = new Date(q.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open quotation ${q.number} for ${q.customer_name || "unnamed customer"}`}
      testID={`quotation-${q.id}`}
      onPress={onPress}
      style={({ pressed, hovered }: any) => [styles.card, {
        backgroundColor: pressed ? colors.surfaceTertiary : hovered ? colors.surfaceSubtle : colors.surfaceSecondary,
        borderColor: hovered ? colors.borderStrong : colors.border,
        opacity: pressed ? 0.94 : 1,
      }]}
    >
      {/* Row 1: number + status */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}>
        <Text style={[styles.numberText, { flex: 1 }]} numberOfLines={1}>{q.number}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          {q.purchase_completion_status === "completed" ? <Text style={[type.caption, { color: colors.success }]}>100% completed</Text> : <StatusBadge status={q.customer_outcome || q.status} />}
          {canDelete ? <IconButton icon="trash-2" onPress={onDelete} size={32} tone="danger" accessibilityLabel="Delete quotation" testID={`delete-quotation-${q.id}`} /> : null}
        </View>
      </View>

      {/* Row 2: customer + total */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: spacing.md, marginTop: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <Avatar name={q.customer_name} size={32} tone="surface" />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={styles.customer}>{q.customer_name || "Unknown customer"}</Text>
            <Text numberOfLines={1} style={type.caption}>{q.items.length} items · {created}</Text>
          </View>
        </View>
        <Text style={styles.total} numberOfLines={1}>{money(q.grand_total)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  lifecycleLink: { minHeight: 40, justifyContent: "center", paddingHorizontal: 10, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
  lifecycleText: { fontSize: 12, fontWeight: "700", color: colors.onSurface },
  cta: {
    flexDirection: "row", gap: 6, alignItems: "center",
    backgroundColor: ds.brass,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: radius.md,
  },
  ctaText: {
    color: "#FFFFFF", fontSize: 13,
    fontFamily: type.titleMd.fontFamily,
    fontWeight: "600", letterSpacing: -0.1,
  },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.huge, flexGrow: 1 },
  listHeader: { gap: spacing.md, marginBottom: spacing.md },
  numberText: {
    fontSize: 12,
    fontFamily: font.medium,
    fontWeight: "500",
    color: colors.onSurfaceSecondary,
    letterSpacing: 0.2,
    fontVariant: ["tabular-nums"],
  },
  customer: {
    fontSize: 15,
    fontFamily: type.titleMd.fontFamily,
    fontWeight: "600",
    color: colors.onSurface,
    letterSpacing: -0.1,
  },
  total: {
    fontSize: 16,
    fontFamily: font.medium,
    fontWeight: "500",
    color: colors.onSurface,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.2,
  },
});
