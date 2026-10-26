// BuildCon House · Quotations list
// One padded scroll on phones; aligned commercial records on larger workspaces.

import { filterValues, matchesFilter, toggleFilterValue } from "@/src/utils/filters";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { AdminPage } from "@/src/components/AdminPage";
import { useBp } from "@/src/design/responsive";
import {
  Chip, PageHeader, EmptyState, ErrorState, IconButton, SearchField, Skeleton, StatusBadge,
} from "@/src/components/ui";
import { ConfirmDialog, MobileFilterSection } from "@/src/components/ds";
import { api } from "@/src/api/client";
import { colors, font, money, radius, spacing } from "@/src/theme/tokens";
import { color as ds, layout, space } from "@/src/design/tokens";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";

type Quotation = {
  id: string; number: string; customer_name: string;
  purchase_completion_status?: "active" | "completed";
  customer_outcome?: "won" | "lost" | null;
  status: string; grand_total: number; created_at: string; items: any[];
};

type Filter = "all" | "draft" | "approved" | "ordered" | "won";
const PENDING_FILTERS: { key: Filter; label: string }[] = [
  { key: "all",              label: "All" },
  { key: "draft",            label: "Draft" },
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
  const { isPhone, isDesktop, gutter } = useBp();
  const isTablet = !isPhone;

  const [items, setItems] = useState<Quotation[] | null>(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [deleteTarget, setDeleteTarget] = useState<Quotation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const requestId = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => { setStatusFilter("all"); }, [completed, outcome]);

  const deleteQuotation = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete(`/quotations/${deleteTarget.id}`);
      setItems((current) => current?.filter((item) => item.id !== deleteTarget.id) || []);
      setDeleteTarget(null);
    } catch (e: any) {
      setDeleteError(e?.detail || "Quotation could not be deleted. Try again.");
      setDeleteTarget(null);
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
    (items || []).forEach((it) => { const status = ["pending_approval", "sent"].includes(it.status) ? "draft" : it.status; map[status] = (map[status] || 0) + 1; });
    return map;
  }, [items]);

  const filters = outcome ? [{ key: "all" as const, label: "All" }] : completed ? COMPLETED_FILTERS : PENDING_FILTERS;

  const filtered = useMemo(() => (items || []).filter((it) => {
    if (!matchesFilter(!completed && ["pending_approval", "sent"].includes(it.status) ? "draft" : it.status, statusFilter)) return false;
    if (q && !`${it.number} ${it.customer_name}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [items, q, statusFilter, completed]);

  const totalValue = filtered.reduce((s, it) => s + (it.grand_total || 0), 0);

  const pageTitle = outcome ? `${outcome === "won" ? "Won Customer" : "Lost Customer"} · Quotations` : completed ? "Approved & ordered quotations" : "Quotations";
  const pageSubtitle = loadError ? "Pipeline unavailable" : items ? `${items.length} ${outcome ? `${outcome} quotations` : completed ? "approved or ordered" : "drafts"} · ${money(totalValue)} filtered` : "Loading pipeline…";
  const headerActions = (
        <View style={styles.headerActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={completed ? "View draft quotations" : "View completed quotations"}
            testID="quotations-lifecycle-toggle" onPress={() => router.push(`/(admin)/quotations?view=${completed ? "pending" : "completed"}` as any)} style={styles.lifecycleLink}>
            <Text style={styles.lifecycleText}>{completed ? "Drafts" : "Completed"}</Text>
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
  );

  return (
    <AdminPage
      title={pageTitle}
      subtitle={pageSubtitle}
      scroll={false}
      contentStyle={{ paddingHorizontal: 0, paddingTop: 0 }}
      header={!isPhone}
      right={headerActions}
    >
      <FlatList
        testID="quotation-list-scroll"
        data={loadError ? [] : items ? filtered : []}
        keyExtractor={(quotation) => quotation.id}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.listContent, { paddingHorizontal: gutter }, isPhone && styles.listContentPhone]}
        ItemSeparatorComponent={() => <View style={{ height: isPhone ? space.x3 : 1, backgroundColor: isPhone ? "transparent" : ds.line }} />}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            {isPhone ? <PageHeader embedded title={pageTitle} subtitle={pageSubtitle} actions={headerActions} /> : null}
            {deleteError ? <View accessibilityRole="alert" style={styles.deleteError}><Text style={{ color: ds.risk }}>{deleteError}</Text><Pressable accessibilityRole="button" accessibilityLabel="Dismiss deletion message" onPress={() => setDeleteError(null)} style={styles.dismiss}><Text style={{ color: ds.inkMid }}>Dismiss</Text></Pressable></View> : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={isPhone} contentContainerStyle={{ gap: 8 }}>
              {(["lost", "won"] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityLabel={`View ${value} customer quotations`}
                accessibilityState={{ selected: outcome === value }} testID={`quotations-${value}-toggle`}
                onPress={() => router.push(`/(admin)/quotations?view=${value}` as any)} style={styles.lifecycleLink}>
                <Text style={styles.lifecycleText}>{value === "lost" ? "Lost Customer" : "Won Customer"}</Text>
              </Pressable>)}
            </ScrollView>
            <MobileFilterSection testID="quotation-filters">
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
            </MobileFilterSection>
            {isDesktop && filtered.length > 0 ? <View style={styles.ledgerHeader} accessibilityElementsHidden>
              <Text style={[styles.columnLabel, styles.identityColumn]}>Customer / quotation</Text>
              <Text style={[styles.columnLabel, styles.dateColumn]}>Created</Text>
              <Text style={[styles.columnLabel, styles.amountColumn]}>Amount</Text>
              <Text style={[styles.columnLabel, styles.statusColumn]}>Status</Text>
              {canDeleteQuotations ? <View style={{ width: layout.tap - space.x2 }} /> : null}
            </View> : null}
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
          <QuotationRow q={item} onPress={() => router.push(`/(admin)/quotations/${item.id}` as any)} canDelete={canDeleteQuotations} onDelete={() => { setDeleteError(null); setDeleteTarget(item); }} />
        )}
      />
      <ConfirmDialog
        visible={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteQuotation}
        title="Delete this quotation?"
        description="This removes only this quotation, its pending records and reserved stock. The customer and other quotations stay. Paid orders must be removed through Customers → Delete customer data."
        confirmLabel="Delete quotation"
        tone="danger"
        loading={deleting}
        testID="confirm-delete-quotation-list"
      />
    </AdminPage>
  );
}

// The open and destructive targets are siblings so deleting never opens the record.
function QuotationRow({ q, onPress, canDelete, onDelete }: { q: Quotation; onPress: () => void; canDelete: boolean; onDelete: () => void }) {
  const { isPhone, isDesktop } = useBp();
  const created = new Date(q.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  const count = q.items?.length || 0;
  const status = q.purchase_completion_status === "completed" ? <Text style={[styles.meta, { color: ds.ok }]}>100% completed</Text> : <StatusBadge status={q.customer_outcome || (["pending_approval", "sent"].includes(q.status) ? "draft" : q.status)} />;
  return <View style={[styles.record, isPhone && styles.recordPhone]}>
    <Pressable accessibilityRole="button"
      accessibilityLabel={`Open quotation ${q.number} for ${q.customer_name || "unnamed customer"}`}
      testID={`quotation-${q.id}`} onPress={onPress}
      style={({ pressed, hovered }: any) => [styles.openRecord, isPhone && styles.openRecordPhone,
        { backgroundColor: pressed ? ds.sunken : hovered ? ds.canvas : ds.surface }]}>
      <View style={[styles.identityColumn, { gap: space.x1 }]}>
        <Text style={styles.customer}>{q.customer_name || "Unknown customer"}</Text>
        <Text style={styles.meta}>{q.number} · {count} {count === 1 ? "item" : "items"}{!isDesktop ? ` · ${created}` : ""}</Text>
      </View>
      {isDesktop ? <Text style={[styles.meta, styles.dateColumn]}>{created}</Text> : null}
      <View style={[styles.amountColumn, isPhone && styles.phoneAmount]}>
        <Text style={styles.total}>{money(q.grand_total)}</Text>
        {!isDesktop ? status : null}
      </View>
      {isDesktop ? <View style={styles.statusColumn}>{status}</View> : null}
    </Pressable>
    {canDelete ? <View style={[styles.deleteTarget, isPhone && { paddingTop: space.x3 }]}>
      <IconButton icon="trash-2" onPress={onDelete} size={44} tone="ghost" accessibilityLabel="Delete quotation" testID={`delete-quotation-${q.id}`} />
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
  lifecycleLink: { minHeight: layout.tap, justifyContent: "center", paddingHorizontal: space.x3, borderRadius: radius.sm, backgroundColor: ds.surface },
  lifecycleText: { fontSize: 14, fontFamily: font.medium, fontWeight: "500", color: ds.inkMid },
  cta: { flexDirection: "row", gap: space.x2, alignItems: "center", minHeight: layout.tap, backgroundColor: ds.action, paddingHorizontal: space.x4, paddingVertical: space.x3, borderRadius: radius.sm },
  ctaText: { color: ds.onAction, fontSize: 14, fontFamily: font.semibold, fontWeight: "600" },
  card: { backgroundColor: ds.surface, borderRadius: radius.sm, padding: space.x4 },
  listContent: { paddingTop: space.x4, paddingBottom: space.x12, flexGrow: 1 },
  listContentPhone: { paddingTop: 0 },
  listHeader: { gap: space.x4, marginBottom: space.x4 },
  ledgerHeader: { flexDirection: "row", gap: space.x4, paddingHorizontal: space.x4, alignItems: "center", paddingTop: space.x2 },
  columnLabel: { fontSize: 13, fontFamily: font.medium, color: ds.inkMid },
  identityColumn: { flex: 1, minWidth: 0 },
  dateColumn: { width: 108 },
  amountColumn: { width: 152, alignItems: "flex-end", textAlign: "right", gap: space.x2 },
  statusColumn: { width: 100, alignItems: "flex-start" },
  record: { flexDirection: "row", alignItems: "stretch", backgroundColor: ds.surface, minWidth: 0 },
  recordPhone: { borderRadius: radius.md, overflow: "hidden" },
  openRecord: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.x4, padding: space.x4, minHeight: 88 },
  openRecordPhone: { flexDirection: "column", alignItems: "stretch", gap: space.x4, paddingRight: space.x2 },
  phoneAmount: { width: "100%", flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" },
  deleteTarget: { justifyContent: "center", paddingRight: space.x2 },
  customer: { fontSize: 16, lineHeight: 24, fontFamily: font.semibold, fontWeight: "600", color: ds.ink },
  meta: { fontSize: 13, lineHeight: 20, fontFamily: font.regular, color: ds.inkMid },
  total: { fontSize: 16, lineHeight: 24, fontFamily: font.medium, fontWeight: "500", color: ds.ink, fontVariant: ["tabular-nums"] },
  deleteError: { padding: space.x4, borderRadius: radius.sm, backgroundColor: ds.riskTint, gap: space.x2 },
  dismiss: { minHeight: layout.tap, justifyContent: "center", alignSelf: "flex-start" },
});
