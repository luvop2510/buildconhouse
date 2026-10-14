// RecentQuotationsPanel — embedded compact list in the left rail.
// Clicking any row restores the whole builder session (customer, rooms,
// items, discounts, UI state) via the backend GET /quotations/{id}.
import Feather from "@expo/vector-icons/Feather";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Text } from "@/src/components/AppText";
import { api } from "@/src/api/client";

import { colors, money, radius, spacing } from "@/src/theme/tokens";
import { color as ds, statusTone } from "@/src/design/tokens";
import { ConfirmDialog } from "@/src/components/ds";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { canManageDestructiveData } from "@/src/constants/roles";
import { useBuilder } from "../context/BuilderContext";
import type { RecentQuotation } from "../helpers/types";

const VIEWS = [
  { key: "recent", label: "Recent" },
  { key: "lost", label: "Lost Customer" },
  { key: "won", label: "Won Customer" },
] as const;
type QuotationView = typeof VIEWS[number]["key"];

export function RecentQuotationsPanel() {
  const b = useBuilder();
  const router = useRouter();
  const { staff } = useAuth();
  const canCreateQuotations = useActionAccess("quotations", "create");
  const canEditQuotations = useActionAccess("quotations", "update");
  const canDeleteQuotations = useActionAccess("quotations", "delete", canManageDestructiveData(staff?.role));
  const [deleteTarget, setDeleteTarget] = React.useState<typeof b.recentQuotations[number] | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [view, setView] = React.useState<QuotationView>("recent");
  const [retry, setRetry] = React.useState(0);
  const [outcomes, setOutcomes] = React.useState<{ key: string; items: RecentQuotation[]; error?: string } | null>(null);
  const queryKey = `${b.activeFloorId}:${view}`;

  React.useEffect(() => {
    if (view === "recent" || !canEditQuotations) return;
    const controller = new AbortController();
    let current = true;
    setOutcomes(null);
    api.get<RecentQuotation[]>(`/quotations/recent?limit=8&view=${view}`, { floorId: b.activeFloorId, signal: controller.signal })
      .then(items => { if (current) setOutcomes({ key: queryKey, items }); })
      .catch((error: any) => {
        if (current) setOutcomes({ key: queryKey, items: [], error: error?.detail || "Could not load quotations" });
      });
    return () => { current = false; controller.abort(); };
  }, [b.activeFloorId, view, queryKey, retry, canEditQuotations]);

  const selected = outcomes?.key === queryKey ? outcomes : null;
  const quotations = view === "recent" ? b.recentQuotations : selected?.items || [];

  if (!canEditQuotations) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <Text style={styles.groupLabel}>Recent Quotations</Text>
        {canCreateQuotations ? <Pressable hitSlop={6} onPress={b.startNewQuotation} testID="rail-new-quote">
          <Feather name="plus" size={14} color={ds.inkSoft} />
        </Pressable> : null}
      </View>
      <View style={styles.tabs}>
        {VIEWS.map(option => <Pressable key={option.key} accessibilityRole="tab" accessibilityState={{ selected: view === option.key }}
          testID={`builder-quotation-view-${option.key}`} onPress={() => setView(option.key)}
          style={[styles.tab, view === option.key && styles.rowActive]}>
          <Text style={[styles.tabLabel, view === option.key && { color: ds.ink }]}>{option.label}</Text>
        </Pressable>)}
      </View>
      {view !== "recent" && !selected ? <Text style={styles.empty}>Loading quotations…</Text> : null}
      {selected?.error ? <Pressable accessibilityRole="button" testID="builder-quotation-outcome-retry" onPress={() => setRetry(value => value + 1)}>
        <Text style={styles.empty}>{selected.error} · Retry</Text>
      </Pressable> : quotations.length === 0 && (view === "recent" || selected) ? <Text style={styles.empty}>No quotations yet</Text> : null}
      {quotations.slice(0, 8).map((q) => {
        const active = b.quotationId === q.id;
        return (
          <Pressable
            key={q.id}
            onPress={() => b.restoreQuotation(q.id)}
            style={[styles.row, active && styles.rowActive]}
            testID={`rail-recent-${q.number}`}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.num} numberOfLines={1}>{q.number}</Text>
              <Text style={styles.sub} numberOfLines={1}>
                {q.customer_name || "—"}
                {q.project_name ? ` · ${q.project_name}` : ""}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 2 }}>
              <Text style={styles.amt} numberOfLines={1}>{money(q.grand_total || 0)}</Text>
              <Text style={styles.status}>{statusTone[q.customer_outcome || q.status]?.label || q.status}</Text>
              {canDeleteQuotations ? (
                <Pressable
                  hitSlop={6}
                  onPress={(event) => { event.stopPropagation(); setDeleteTarget(q); }}
                  testID={`rail-delete-${q.number}`}
                  accessibilityLabel={`Delete quotation ${q.number}`}
                >
                  <Feather name="trash-2" size={12} color={colors.error} />
                </Pressable>
              ) : null}
            </View>
          </Pressable>
        );
      })}
      {view !== "recent" ? <Pressable accessibilityRole="button" testID="builder-quotation-view-all"
        onPress={() => router.push(`/(admin)/quotations?view=${view}` as any)} style={styles.tab}>
        <Text style={styles.tabLabel}>View all {view === "lost" ? "Lost Customer" : "Won Customer"} quotations</Text>
      </Pressable> : null}
      <ConfirmDialog
        visible={!!deleteTarget}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleting(true);
          const deleted = await b.deleteQuotation(deleteTarget.id);
          if (deleted) setOutcomes(current => current ? { ...current, items: current.items.filter(item => item.id !== deleteTarget.id) } : current);
          setDeleting(false);
          if (deleted) setDeleteTarget(null);
        }}
        title="Delete quotation?"
        description={deleteTarget ? `${deleteTarget.number} and its unpaid workflow records will be removed. Completed payments and purchase orders are protected.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        loading={deleting}
        testID="confirm-delete-builder-quotation"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.lg, paddingHorizontal: 4, gap: 3, paddingBottom: 12 },
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 4, marginBottom: 4 },
  groupLabel: { fontSize: 10, fontWeight: "600", color: ds.inkSoft, letterSpacing: 1.2, textTransform: "uppercase" },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 3, marginBottom: 4 },
  tab: { minHeight: 32, justifyContent: "center", paddingHorizontal: 6, paddingVertical: 4, borderRadius: radius.sm },
  tabLabel: { fontSize: 10.5, fontWeight: "600", color: ds.inkSoft },
  empty: { fontSize: 10.5, color: ds.inkSoft, padding: 8 },
  row: {
    flexDirection: "row", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.sm,
  },
  rowActive: { backgroundColor: ds.sunken },
  num: { fontSize: 11.5, fontWeight: "600", color: ds.ink, fontVariant: ["tabular-nums"] },
  sub: { fontSize: 10.5, color: ds.inkSoft, marginTop: 1 },
  amt: { fontSize: 11, fontWeight: "600", color: ds.ink, fontVariant: ["tabular-nums"] },
  status: { fontSize: 9, color: ds.inkSoft, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 1 },
});
