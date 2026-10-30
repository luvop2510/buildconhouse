import { formatPhone } from "@/src/utils/phone";
import Feather from "@expo/vector-icons/Feather";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { ProductImage } from "@/src/components/ProductImage";
import { Sheet } from "@/src/design/components";
import type { PurchaseCustomer, PurchaseCustomerWorkspace, PurchaseItem as Item } from "@/src/api/purchases";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "2-digit",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch { return "—"; }
}

export function CustomerNavigator({ loading, customers, onOpen, completed = false }: { loading: boolean; customers: PurchaseCustomer[]; onOpen: (id: string) => void; completed?: boolean }) {
  if (loading) return <View style={customerStyles.loadingCard}><ActivityIndicator /><Text style={type.caption}>Loading customer workspaces…</Text></View>;
  return (
    <View style={{ gap: spacing.lg }}>
      <View><Text style={customerStyles.overline}>CUSTOMER WORKSPACES</Text><Text style={type.bodyMuted}>{completed ? "Customers with every active product delivered. Select one for their products, delivery dates and history." : "Customers with confirmed orders on this floor. Select one for their purchases, quotations, payments and lifecycle timeline."}</Text></View>
      <View style={customerStyles.workspaceCard}>
        {customers.length === 0 ? <Text style={type.bodyMuted}>No customers found on this floor.</Text> : customers.map((customer, index) => (
          <Pressable key={customer.id} testID={`customer-workspace-${customer.id}`} onPress={() => onOpen(customer.id)} style={({ pressed }) => [customerStyles.customerNavRow, index > 0 && customerStyles.customerNavDivider, pressed && { backgroundColor: colors.surfaceTertiary }]}>
            <View style={customerStyles.customerAvatar}><Text style={customerStyles.customerAvatarText}>{customer.name.slice(0, 1).toUpperCase()}</Text></View>
            <View style={{ flex: 1, minWidth: 0 }}><Text style={customerStyles.actionTitle} numberOfLines={1}>{customer.name}</Text>{completed ? <Text style={[type.caption, { color: colors.success }]}>100% completed</Text> : null}<Text style={type.caption} numberOfLines={1}>{customer.company || formatPhone(customer.phone) || customer.email || customer.city || "Customer lifecycle"}</Text></View>
            <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function CustomerPurchasePanel({ visible, loading, workspace, onClose, onMove, onTransfer, onHistory, readOnly = false, products, onLoadMore, loadingMore = false }: {
  visible: boolean; loading: boolean; workspace: PurchaseCustomerWorkspace | null; onClose: () => void;
  onMove: (item: Item) => void; onTransfer: (item: Item) => void; onHistory: (item: Item) => void;
  readOnly?: boolean; products?: Item[]; onLoadMore?: () => void; loadingMore?: boolean;
}) {
  const rupees = (value?: number) => `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  return (
    <Sheet open={visible} onClose={onClose} title={workspace?.customer.name || "Customer purchases"} width={560}
      footer={<Pressable accessibilityRole="button" accessibilityLabel="Close customer purchases" onPress={onClose} style={customerStyles.mobileSheetCancel}><Text style={customerStyles.mobileSheetCancelText}>Close</Text></Pressable>}
    >
      {loading || !workspace ? (
        <View style={customerStyles.loadingCard}><ActivityIndicator /><Text style={type.caption}>Loading customer purchases…</Text></View>
      ) : (
        <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
          <View style={customerStyles.customerPanelHero}>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={customerStyles.actionTitle}>{workspace.customer.company || workspace.customer.name}</Text>
              <Text style={type.caption}>{[formatPhone(workspace.customer.phone), workspace.customer.email, workspace.customer.city].filter(Boolean).join(" · ") || "Customer purchase workspace"}</Text>
            </View>
            <View style={customerStyles.customerPanelDue}><Text style={customerStyles.customerPanelDueLabel}>OUTSTANDING</Text><Text style={customerStyles.customerPanelDueValue}>{rupees(workspace.summary.outstanding_balance)}</Text></View>
          </View>
          <View style={customerStyles.customerPanelMetrics}>
            <CustomerMetric label="Open items" value={String(workspace.summary.outstanding_count)} />
            <CustomerMetric label="Open POs" value={String(workspace.summary.open_pos)} />
            <CustomerMetric label="Blocked" value={String(workspace.summary.blocked_count)} />
            <CustomerMetric label="Material value" value={rupees(workspace.summary.outstanding_value)} />
          </View>
          <View style={customerStyles.workspaceCard}>
            <Text style={customerStyles.workspaceTitle}>{readOnly ? "Delivered products" : "Purchase products"}</Text>
            {(products || workspace.products).length === 0 ? <Text style={type.bodyMuted}>No active purchase items.</Text> : (products || workspace.products).map((item, index) => (
              <View key={item.item_id} style={[customerStyles.customerPanelItem, index > 0 && customerStyles.customerNavDivider]}>
                <ProductImage source={item.image} style={customerStyles.customerPanelImage} contentFit="contain" frameInset={0} frameBackground="transparent" fallbackLabel={item.sku} borderRadius={8} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={customerStyles.actionTitle} numberOfLines={1}>{item.name}</Text>
                  <Text style={type.caption} numberOfLines={1}>{item.sku} · {item.qty} · {item.stage_label}</Text>
                  <Text style={type.caption}>{item.po_number} · {item.brand_name} · {rupees(item.unit_cost)} / unit{item.room ? ` · ${item.room}` : ""}</Text>
                  {item.stage === "dispatched" ? <Text style={type.caption}>Delivered {fmtDate(item.delivered_at || item.dispatched_at || item.last_moved_at)}</Text> : null}
                  <GodownStatus item={item} compact />
                  <PurchaseLoanStatus item={item} compact />
                </View>
                <View style={{ gap: 5 }}>
                  {!readOnly ? <Pressable accessibilityRole="button" accessibilityLabel={`Move ${item.name}`} onPress={() => onMove(item)} style={customerStyles.customerPanelAction}><Text style={customerStyles.customerPanelActionText}>Move</Text></Pressable> : null}
                  {!readOnly && item.stage === "in_box" && !item.loan_replenishment_for_customer_name ? <Pressable accessibilityRole="button" accessibilityLabel={`Transfer ${item.name}`} onPress={() => onTransfer(item)} style={customerStyles.customerPanelAction}><Text style={customerStyles.customerPanelActionText}>Transfer</Text></Pressable> : null}
                  <Pressable accessibilityRole="button" accessibilityLabel={`View movement history for ${item.name}`} onPress={() => onHistory(item)} style={customerStyles.customerPanelAction}><Text style={customerStyles.customerPanelActionText}>History</Text></Pressable>
                </View>
              </View>
            ))}
            {onLoadMore ? <Pressable accessibilityRole="button" accessibilityLabel="Load more delivered products" disabled={loadingMore} onPress={onLoadMore} style={customerStyles.mobileApplyButton}><Text style={customerStyles.mobileApplyText}>{loadingMore ? "Loading…" : "Load more products"}</Text></Pressable> : null}
          </View>
        </View>
      )}
    </Sheet>
  );
}

export function GodownStatus({ item, compact = false }: { item: Item; compact?: boolean }) {
  if (item.godown_stock_id) {
    const source = item.godown_source_customer_name ? ` · from ${item.godown_source_customer_name}` : "";
    const date = item.godown_transferred_at ? ` · transferred ${fmtDate(item.godown_transferred_at)}` : "";
    return <Text style={[customerStyles.godownStatus, compact && customerStyles.godownStatusCompact]} numberOfLines={1}>From godown stock{source}{date}</Text>;
  }
  if ((item.godown_transferred_qty || 0) > 0) {
    const latest = item.godown_transfer_history?.[item.godown_transfer_history.length - 1];
    const date = latest?.transferred_at ? ` · ${fmtDate(latest.transferred_at)}` : "";
    return <Text style={[customerStyles.godownStatus, compact && customerStyles.godownStatusCompact]} numberOfLines={1}>{item.godown_transferred_qty} moved to godown stock{date}</Text>;
  }
  return null;
}

export function PurchaseLoanStatus({ item, compact = false }: { item: Item; compact?: boolean }) {
  const history = item.customer_loan_history || [];
  const text = item.borrowed_from_customer_name
    ? `BORROWED from ${item.borrowed_from_customer_name}${item.borrowed_at ? ` · ${fmtDate(item.borrowed_at)}` : ""}${item.borrowing_note ? ` · ${item.borrowing_note}` : ""}`
    : item.loan_replenishment_for_customer_name && item.loan_replenishment_status !== "returned"
      ? `RETURN RESERVED for ${item.loan_replenishment_for_customer_name} · move to In Box, then return to the original customer`
    : history.length
    ? `We have lent ${history.map((loan) => `${loan.qty} ${loan.qty === 1 ? "unit" : "units"} to ${loan.destination_customer_name || "another customer"}${loan.status === "returned" ? " (returned)" : ""}`).join(", ")} · available again after the replacement is returned`
    : (item.loaned_qty || 0) > 0
      ? `We have lent ${item.loaned_qty} ${item.loaned_qty === 1 ? "unit" : "units"} to another customer · available again after the replacement is returned`
      : null;
  return text ? <Text style={[customerStyles.godownStatus, customerStyles.loanNotice, compact && customerStyles.godownStatusCompact]} numberOfLines={compact ? 3 : undefined}>{text}</Text> : null;
}

function CustomerMetric({ label, value }: { label: string; value: string }) {
  return <View style={customerStyles.customerPanelMetric}><Text style={customerStyles.customerPanelMetricValue}>{value}</Text><Text style={customerStyles.customerPanelMetricLabel}>{label}</Text></View>;
}

export const customerStyles = StyleSheet.create({
  overline: {
    fontSize: 10, fontWeight: "700", letterSpacing: 1.4, textTransform: "uppercase",
    color: colors.onSurfaceMuted, marginBottom: 4,
  },
  loadingCard: { minHeight: 180, alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  workspaceCard: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md },
  workspaceTitle: { fontSize: 14, fontWeight: "700", color: colors.onSurface, marginBottom: spacing.sm },
  actionTitle: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  customerNavRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 4 },
  customerNavDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  customerAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: ds.brassTint, alignItems: "center", justifyContent: "center" },
  customerAvatarText: { color: ds.brassDeep, fontWeight: "800", fontSize: 14 },
  customerPanelHero: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary },
  customerPanelDue: { alignItems: "flex-end" },
  customerPanelDueLabel: { color: colors.onSurfaceMuted, fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  customerPanelDueValue: { color: colors.error, fontSize: 17, fontWeight: "800", fontVariant: ["tabular-nums"] },
  customerPanelMetrics: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  customerPanelMetric: { minWidth: 108, flexGrow: 1, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surfaceSecondary },
  customerPanelMetricValue: { color: colors.onSurface, fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  customerPanelMetricLabel: { marginTop: 2, color: colors.onSurfaceMuted, fontSize: 10, fontWeight: "700" },
  customerPanelItem: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  customerPanelImage: { width: 64, height: 64, flexShrink: 0 },
  customerPanelAction: { minWidth: 62, minHeight: 27, paddingHorizontal: 8, borderRadius: 7, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  customerPanelActionText: { color: colors.onSurface, fontSize: 10, fontWeight: "800" },
  godownStatus: { marginTop: 6, color: colors.brand, fontSize: 11, fontWeight: "700" },
  loanNotice: { alignSelf: "flex-start", backgroundColor: colors.brandTint, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  godownStatusCompact: { marginTop: 3, fontSize: 10 },
  mobileSheetCancel: { minHeight: 48, marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  mobileSheetCancelText: { color: colors.onSurface, fontSize: 14, fontWeight: "800" },
  mobileApplyButton: { minHeight: 50, marginTop: 10, borderRadius: 12, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  mobileApplyText: { color: colors.onBrand, fontSize: 15, fontWeight: "800" }
});
