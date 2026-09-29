// Customers list — DS-aligned rebuild.
// Uses PageHeader, HeroBanner stat row, filter chips, SearchField, and a
// unified customer-card language shared with quotations/purchases/payments.
import { Disclosure } from "@/src/design/Disclosure";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useBp } from "@/src/design/responsive";
import {
  Avatar, Badge, Button, Chip, ConfirmDialog, EmptyState, IconButton, PageHeader,
  SearchField, Skeleton, StatTile,
} from "@/src/components/ds";
import { colors, icon as iconSize, radius, spacing, type } from "@/src/theme/tokens";
import { useAuth } from "@/src/state/auth";
import { canManageDestructiveData } from "@/src/constants/roles";
import { toast } from "@/src/components/Toast";
import { ErrorState } from "@/src/components/ui";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";

type Customer = {
  id: string;
  name: string;
  company?: string | null;
  email: string;
  city?: string | null;
  tier: "retail" | "trade" | "vip";
  phone?: string | null;
};

const tierTone: Record<string, "success" | "info" | "neutral"> = {
  vip: "success",
  trade: "info",
  retail: "neutral",
};

type TierFilter = "all" | "vip" | "trade" | "retail";
const CUSTOMER_RENDER_BATCH = 40;

export default function Customers() {
  const router = useRouter();
  const { isDesktop, isPhone } = useBp();
  const { staff } = useAuth();
  const { selectedFloorId } = useFloorAccess();
  const isTileDeliveryLookup = staff?.access_profile === "ground_tile_quotations_followups";

  const [items, setItems] = useState<Customer[] | null>(null);
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<TierFilter>("all");
  const [visibleCount, setVisibleCount] = useState(CUSTOMER_RENDER_BATCH);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(() => {
    if (!selectedFloorId) return;
    const id = ++requestId.current;
    setItems(null);
    setLoadError(false);
    api.get<Customer[]>("/customers").then(
      (result) => { if (id === requestId.current) setItems(result); },
      () => { if (id === requestId.current) setLoadError(true); },
    );
  }, [selectedFloorId]);
  useEffect(() => { load(); return () => { requestId.current += 1; }; }, [load]);

  const deleteCustomer = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/customers/${deleteTarget.id}`);
      setItems((current) => (current || []).filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (e: any) {
      // The backend explains protected payments/orders and floor failures.
      // Keep the dialog open so the manager can read the error from the toast.
      toast.error(e?.detail || "Could not delete customer");
    } finally {
      setDeleting(false);
    }
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: items?.length || 0, vip: 0, trade: 0, retail: 0 };
    (items || []).forEach((c) => { map[c.tier] = (map[c.tier] || 0) + 1; });
    return map;
  }, [items]);

  const filtered = useMemo(() => (items || []).filter((c) => {
    if (tier !== "all" && c.tier !== tier) return false;
    if (!q) return true;
    const needle = q.toLowerCase();
    return `${c.name} ${c.company || ""} ${c.email} ${c.phone || ""} ${c.city || ""}`.toLowerCase().includes(needle);
  }), [items, q, tier]);

  // Keep the mobile scroll surface light even when the legacy list endpoint
  // returns hundreds of accounts. Search/filter changes always begin at the
  // most relevant results, while the operator can reveal the rest explicitly.
  useEffect(() => { setVisibleCount(CUSTOMER_RENDER_BATCH); }, [q, tier]);
  const visibleCustomers = filtered.slice(0, visibleCount);
  const exportCustomers = async () => {
    try {
      await downloadSectionExcel({
        page: "Customers",
        section: tier === "all" ? "Customer accounts" : `${tier.toUpperCase()} customers`,
        rows: [
          ["Name", "Company", "Tier", "Email", "Phone", "City"],
          ...filtered.map(customer => [customer.name, customer.company, customer.tier, customer.email, customer.phone, customer.city]),
        ],
        filename: `customers-${tier}.xlsx`,
        floorId: selectedFloorId,
      });
    } catch (error: any) { toast.error(error?.message || "Could not export customers"); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <PageHeader
        title={isTileDeliveryLookup ? "Customer delivery lookup" : "Customers"}
        subtitle={loadError ? "Customer data is unavailable" : items ? (isTileDeliveryLookup ? "Choose a customer to view their Ground Floor tile order and dispatch status." : `${items.length} accounts · Trade, VIP & retail buyers`) : "Loading customers…"}
        overline={isTileDeliveryLookup ? "GROUND FLOOR · READ ONLY" : "CRM"}
        actions={!isTileDeliveryLookup ? (
          <Button
            icon="plus"
            label="Add Customer"
            variant="primary"
            size="md"
            onPress={() => router.push("/(admin)/customers/new" as any)}
          />
        ) : undefined}
      />

      <ScrollView contentContainerStyle={[styles.content, isPhone && styles.contentPhone]}>
        <Disclosure title="Customer summary" summary="Account types and totals">
        {/* Stats */}
        <View style={[styles.statsRow, !isDesktop && styles.statsRowMobile]}>
          <StatTile
            label="Total Customers"
            value={items ? counts.all : "—"}
            icon="users"
            tone="brand"
            sub="All active accounts"
            dense={isPhone}
            style={isPhone ? styles.statPhone : undefined}
          />
          <StatTile
            label="VIP"
            value={items ? counts.vip : "—"}
            icon="star"
            tone="success"
            sub="Premium tier"
            dense={isPhone}
            style={isPhone ? styles.statPhone : undefined}
          />
          <StatTile
            label="Trade"
            value={items ? counts.trade : "—"}
            icon="briefcase"
            tone="brand"
            sub="Trade partners"
            dense={isPhone}
            style={isPhone ? styles.statPhone : undefined}
          />
          <StatTile
            label="Retail"
            value={items ? counts.retail : "—"}
            icon="user"
            tone="neutral"
            sub="Direct buyers"
            dense={isPhone}
            style={isPhone ? styles.statPhone : undefined}
          />
        </View>

        </Disclosure>

        {/* Toolbar */}
        <View style={{ gap: spacing.md }}>
          <SearchField
            value={q}
            onChangeText={setQ}
            onClear={() => setQ("")}
            placeholder="Search customers, cities, companies…"
            testID="customers-search"
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.lg }}
          >
            {([
              { key: "all",    label: "All" },
              { key: "vip",    label: "VIP" },
              { key: "trade",  label: "Trade" },
              { key: "retail", label: "Retail" },
            ] as { key: TierFilter; label: string }[]).map((f) => (
              <Chip
                key={f.key}
                label={f.label}
                active={tier === f.key}
                onPress={() => setTier(f.key)}
                count={counts[f.key]}
                testID={`tier-${f.key}`}
              />
            ))}
          </ScrollView>
          {!isTileDeliveryLookup ? <Pressable accessibilityRole="button" accessibilityLabel="Export filtered customer accounts to Excel" testID="customers-export-excel" disabled={!filtered.length} onPress={() => void exportCustomers()} style={[styles.exportButton, !filtered.length && { opacity: .45 }]}><Feather name="download" size={16} color={colors.brand} /><Text style={styles.exportText}>Export customer accounts .xlsx</Text></Pressable> : null}
        </View>

        {/* List */}
        {loadError ? <ErrorState title="Couldn't load customers" subtitle="Check your connection and try again." onRetry={load} /> : !items ? (
          <View style={{ gap: spacing.sm }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <View key={i} style={[styles.card, { flexDirection: "row", gap: spacing.md, alignItems: "center" }]}>
                <Skeleton w={44} h={44} radius={22} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Skeleton w="60%" h={14} />
                  <Skeleton w="40%" h={12} />
                </View>
                <Skeleton w={60} h={20} radius={radius.pill} />
              </View>
            ))}
          </View>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="users"
            title={items.length ? "No customers match" : "No customers yet"}
            subtitle={items.length ? "Try clearing the search or filter to see more." : "Customer accounts for this floor will appear here."}
            action={
              <Button
                label="Clear filters"
                variant="secondary"
                size="sm"
                icon="x"
                onPress={() => { setQ(""); setTier("all"); }}
              />
            }
          />
        ) : (
          <View style={{ gap: spacing.sm }}>
            {visibleCustomers.map((c) => (
              <Pressable
                key={c.id}
                testID={`customer-${c.id}`}
                onPress={() => router.push((
                  isTileDeliveryLookup
                    ? `/(admin)/tiles/orders?tab=customer&customer_id=${encodeURIComponent(c.id)}`
                    : `/(admin)/customers/${c.id}`
                ) as any)}
                style={({ pressed, hovered }: any) => [
                  styles.card,
                  !isDesktop && styles.cardMobile,
                  {
                    backgroundColor: pressed ? colors.surfaceTertiary
                      : hovered ? colors.surfaceSubtle
                      : colors.surfaceSecondary,
                    borderColor: hovered ? colors.borderStrong : colors.border,
                  },
                ]}
              >
                <View style={[styles.customerMain, !isDesktop && styles.customerMainMobile]}>
                <Avatar name={c.company || c.name} size={44} tone="brand" />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={isDesktop ? 1 : 2} style={type.titleSm}>{c.company || c.name}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
                    <Text style={type.caption} numberOfLines={isDesktop ? 1 : 2}>{c.email}</Text>
                    {c.city ? (
                      <>
                        <View style={styles.dot} />
                        <Text style={type.caption} numberOfLines={isDesktop ? 1 : 2}>{c.city}</Text>
                      </>
                    ) : null}
                  </View>
                </View>
                </View>
                  <View style={[{ alignItems: "flex-end", gap: spacing.sm, flexShrink: 0 }, !isDesktop && styles.customerActionsMobile]}>
                    <Badge label={c.tier.toUpperCase()} tone={tierTone[c.tier]} size="sm" />
                  {!isTileDeliveryLookup ? <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <IconButton
                      icon="edit-2"
                      onPress={() => router.push(`/(admin)/customers/${c.id}/edit` as any)}
                      size={isDesktop ? 30 : 44}
                      accessibilityLabel={`Edit ${c.name}`}
                      testID={`edit-customer-${c.id}`}
                    />
                    {canManageDestructiveData(staff?.role) ? (
                      <IconButton
                        icon="trash-2"
                        onPress={() => setDeleteTarget(c)}
                        size={isDesktop ? 30 : 44}
                        tone="danger"
                        accessibilityLabel={`Delete ${c.name}`}
                        testID={`delete-customer-${c.id}`}
                      />
                    ) : null}
                    <Feather name="chevron-right" size={iconSize.md} color={colors.onSurfaceMuted} />
                  </View> : null}
                </View>
              </Pressable>
            ))}
            {visibleCustomers.length < filtered.length ? (
              <Button
                label={`Show more (${filtered.length - visibleCustomers.length} remaining)`}
                variant="secondary"
                size="md"
                onPress={() => setVisibleCount((count) => count + CUSTOMER_RENDER_BATCH)}
                testID="customers-show-more"
              />
            ) : null}
          </View>
        )}
      </ScrollView>
      <ConfirmDialog
        visible={!!deleteTarget}
        onClose={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={deleteCustomer}
        title="Delete customer?"
        description={deleteTarget ? `${deleteTarget.company || deleteTarget.name} and disposable quotations, follow-ups, walk-ins, and unpaid payments will be removed. Customers with purchase orders or completed payments cannot be deleted.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        loading={deleting}
        testID="confirm-delete-customer-list"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxxl },
  contentPhone: { paddingHorizontal: spacing.md, paddingTop: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  statsRow: { flexDirection: "row", gap: spacing.md },
  statsRowMobile: { flexWrap: "wrap" },
  statPhone: { minWidth: "47%", flexBasis: "47%" },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  cardMobile: { flexDirection: "column", alignItems: "stretch", gap: spacing.sm },
  customerMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.md },
  customerMainMobile: { width: "100%", alignItems: "flex-start" },
  customerActionsMobile: { width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  exportButton: { minHeight: 44, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.brandBorder, borderRadius: radius.md, backgroundColor: colors.brandTint },
  exportText: { ...type.caption, color: colors.brand, fontWeight: "700" },
  dot: {
    width: 3, height: 3, borderRadius: 999,
    backgroundColor: colors.onSurfaceSubtle,
  },
});
