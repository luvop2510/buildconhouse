// ═══════════════════════════════════════════════════════════════════════════
// Payments — migrated to Design System V2.
// Consumes ONLY primitives from @/src/components/ds. Zero local styles for
// spacing, color, radius, elevation, typography, or motion. Business logic
// preserved byte-for-byte from the previous implementation.
// ═══════════════════════════════════════════════════════════════════════════
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useBp } from "@/src/design/responsive";
import { TILES_FLOOR_ID } from "@/src/constants/floors";
import { toast } from "@/src/components/Toast";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import {
  Alert as UIAlert,
  Badge, Button, Card, Dropdown, EmptyState, FilterBar, FormField, HeroCard,
  Panel, PageHeader, ProgressBar, SearchField, Sheet,
  Skeleton, StatTile, StatusBadge, HoverCard, ActivityRow, Tabs,
} from "@/src/components/ds";
// The ledger table reuses Tile Orders' DataTable rather than duplicating a
// second responsive-table primitive — it's the one component in the app
// that already solves "12 dense columns on a 375px phone" (pinned action
// column + horizontal scroll, see its own doc comment). Generic, not
// tiles-specific, despite the folder it lives in.
import { CellMono, CellNumber, CellText, CellTitle, DataTable, type Column } from "@/src/components/tiles/TileTable";
import {
  colors, icon as iconSize, moneyShort, radius, spacing, type,
} from "@/src/theme/tokens";

type PayMode = "cash" | "upi" | "bank" | "cheque" | "card";

type Stats = {
  total_outstanding: number;
  collected_this_month: number;
  active_orders: number;
  fully_paid: number;
};

type OrderRow = {
  id: string; number: string; customer_id: string; customer_name: string;
  grand_total: number; paid: number; outstanding: number;
  percent_collected: number; payment_status: "paid" | "partial" | "due";
  confirmed_at: string; outstanding_short: string | null;
};

type PaymentEntry = {
  id: string; amount: number; mode: PayMode;
  reference?: string | null; note?: string | null; label?: string | null;
  paid_at?: string | null; created_at?: string; recorded_by_name?: string | null;
};

type OrderDetail = {
  id: string; number: string; status: string;
  customer: {
    id: string; name: string; company?: string | null;
    phone?: string | null; email?: string | null; city?: string | null;
  };
  customer_name: string; confirmed_at: string; notes?: string | null;
  project_name?: string | null;
  floor_id: string; mrp: number; discounted_rate: number;
  quotation_total: number; manual_extra_amount: number; manual_extra_name?: string | null; grand_total: number;
  paid: number; outstanding: number; percent_collected: number;
  payment_status: "paid" | "partial" | "due";
  payments: PaymentEntry[];
};

type CustomerCollection = {
  id: string;
  name: string;
  outstanding: number;
  paid: number;
  orderCount: number;
  orders: OrderRow[];
};

const MODE_LABELS: Record<PayMode, string> = {
  cash: "Cash", upi: "UPI", bank: "Bank Transfer", cheque: "Cheque", card: "Credit Card",
};
const MODE_ICONS: Record<PayMode, keyof typeof Feather.glyphMap> = {
  cash: "dollar-sign", upi: "smartphone", bank: "briefcase", cheque: "file-text", card: "credit-card",
};

function money(n: number): string {
  return `₹${(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function paymentHistoryCopy(payment: PaymentEntry): { title: string; subtitle: string } {
  // Dispatches now write a structured payment label. Prefer it over text
  // parsing so every new dispatch appears under the exact, stable label.
  if (payment.label?.trim()) {
    return {
      title: payment.label.trim(),
      subtitle: payment.note || `Recorded by ${payment.recorded_by_name || "—"}`,
    };
  }
  // Dispatch labor charges are persisted by the backend as a pending ledger
  // row. Promote that human-readable charge to the main line and leave the
  // dispatch number as supporting context rather than burying the charge in
  // the generic bank-transfer label.
  const laborMatch = payment.note?.match(/^(₹[\d,]+(?:\.\d{1,2})?)\s+labou?r cost added(?: via dispatch (.+))?$/i);
  if (laborMatch) {
    return {
      title: "labor cost",
      subtitle: laborMatch[2]
        ? `${laborMatch[1]} · Dispatch ${laborMatch[2]}`
        : `${laborMatch[1]} · Recorded by ${payment.recorded_by_name || "—"}`,
    };
  }
  return {
    title: `${MODE_LABELS[payment.mode]} · ${money(payment.amount)}`,
    subtitle: (payment.reference || payment.note)
      ? `${payment.reference || ""}${payment.reference && payment.note ? " · " : ""}${payment.note || ""}`
      : `Recorded by ${payment.recorded_by_name || "—"}`,
  };
}

function dateShort(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return "—"; }
}
function todayIso(): string { return new Date().toISOString().slice(0, 10); }

const paymentTone = (s: "paid" | "partial" | "due"): "success" | "warning" | "danger" =>
  s === "paid" ? "success" : s === "partial" ? "warning" : "danger";

// ═══════════════════════════════════════════════════════════════════════════
// Payment History — permanent reconciliation ledger. Reads-only, derived
// entirely from the same Payment records the Collections tab already shows
// (see backend/routes/payment_routes.py GET /payments/history) — zero new
// storage, so it always reconciles exactly with Collections.
// ═══════════════════════════════════════════════════════════════════════════
type TabKey = "collections" | "history";

type HistoryRow = {
  id: string; customer_id: string; customer_name?: string | null;
  invoice_number?: string | null; business_unit?: string | null; floor_id: string;
  paid_at?: string | null; amount: number; mode: PayMode;
  reference?: string | null; recorded_by_name?: string | null;
  outstanding_before: number | null; outstanding_after: number | null;
  status: "pending" | "completed" | "failed"; note?: string | null; label?: string | null;
  quotation_id?: string | null;
};

type FloorOpt = { id: string; name: string };

const HISTORY_SORTS: { value: string; label: string }[] = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "amount_desc", label: "Amount: high to low" },
  { value: "amount_asc", label: "Amount: low to high" },
];

// ═══════════════════════════════════════════════════════════════════════════
export default function PaymentsScreen() {
  const { isDesktop, isPhone } = useBp();
  const { selectedFloorId } = useFloorAccess();
  const router = useRouter();

  const [tab, setTab] = useState<TabKey>("collections");

  const [stats, setStats] = useState<Stats | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [q, setQ] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const isGroundFloorOrder = detail?.floor_id === TILES_FLOOR_ID;
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [waLoading, setWaLoading] = useState(false);

  const [showRecord, setShowRecord] = useState(false);
  const [amount, setAmount] = useState("");
  const [payDate, setPayDate] = useState(todayIso());
  const [mode, setMode] = useState<PayMode>("cash");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [manualExtra, setManualExtra] = useState("");
  const [manualExtraName, setManualExtraName] = useState("");
  const [savingManualExtra, setSavingManualExtra] = useState(false);
  const collectionsScrollRef = useRef<ScrollView>(null);
  const detailTopRef = useRef(0);
  const shouldFocusDetailRef = useRef(false);

  // ── Payment History state ────────────────────────────────────────────────
  const [floors, setFloors] = useState<FloorOpt[]>([]);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyQ, setHistoryQ] = useState("");
  const [historyUnit, setHistoryUnit] = useState<string>("all");
  const [historyMode, setHistoryMode] = useState<string>("all");
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [historySort, setHistorySort] = useState("date_desc");
  const [historyPage, setHistoryPage] = useState(0);
  const HISTORY_PAGE_SIZE = 50;

  const loadStats = useCallback(async () => {
    if (!selectedFloorId) return;
    try { setStats(await api.get<Stats>("/payments/stats")); }
    catch (e: any) { console.warn("stats", e); }
  }, [selectedFloorId]);

  const loadOrders = useCallback(async (query: string = q) => {
    if (!selectedFloorId) return;
    setLoadingList(true);
    try {
      const url = query ? `/payments/orders?q=${encodeURIComponent(query)}` : "/payments/orders";
      const list = await api.get<OrderRow[]>(url);
      setOrders(list);
      setSelectedId((current) => list.some((order) => order.id === current) ? current : (list.length ? list[0].id : null));
    } catch (e: any) {
      toast.error(e?.detail || "Could not load orders");
    } finally {
      setLoadingList(false);
    }
  }, [q, selectedFloorId]);

  const loadDetail = useCallback(async (id: string) => {
    if (!selectedFloorId) return;
    setLoadingDetail(true);
    try {
      const d = await api.get<OrderDetail>(`/payments/orders/${id}`);
      setDetail(d);
      setAmount(d.outstanding > 0 ? String(Math.round(d.outstanding)) : "");
      setManualExtra(d.manual_extra_amount ? String(d.manual_extra_amount) : "");
      setManualExtraName(d.manual_extra_name || "");
    } catch (e: any) {
      toast.error(e?.detail || "Could not load order details");
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [selectedFloorId]);

  useEffect(() => {
    setStats(null); setOrders([]); setSelectedId(null); setDetail(null); setHistoryRows([]); setHistoryTotal(0);
    loadStats();
  }, [selectedFloorId, loadStats]);
  useEffect(() => {
    const t = setTimeout(() => { loadOrders(q); }, 220);
    return () => clearTimeout(t);
  }, [q, loadOrders, selectedFloorId]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); }, [selectedId, loadDetail]);

  // On a phone the customer queue precedes its detail panel. Bring the chosen
  // order into view immediately instead of leaving the collector below it.
  useEffect(() => {
    if (!isPhone || !detail || !shouldFocusDetailRef.current) return;
    const timer = setTimeout(() => {
      collectionsScrollRef.current?.scrollTo({ y: detailTopRef.current, animated: true });
      shouldFocusDetailRef.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [detail, isPhone]);

  const customerCollections = useMemo<CustomerCollection[]>(() => {
    const grouped = new Map<string, CustomerCollection>();
    orders.forEach((order) => {
      const current = grouped.get(order.customer_id) || {
        id: order.customer_id, name: order.customer_name, outstanding: 0, paid: 0, orderCount: 0, orders: [],
      };
      current.outstanding += order.outstanding;
      current.paid += order.paid;
      current.orderCount += 1;
      current.orders.push(order);
      grouped.set(order.customer_id, current);
    });
    return [...grouped.values()]
      .map((customer) => ({ ...customer, orders: [...customer.orders].sort((a, b) => b.outstanding - a.outstanding) }))
      .sort((a, b) => b.outstanding - a.outstanding);
  }, [orders]);

  const selectedCustomer = customerCollections.find((customer) => customer.id === selectedCustomerId)
    || customerCollections.find((customer) => customer.orders.some((order) => order.id === selectedId))
    || null;

  const selectCustomer = useCallback((customer: CustomerCollection) => {
    shouldFocusDetailRef.current = true;
    setSelectedCustomerId(customer.id);
    setSelectedId(customer.orders[0]?.id || null);
  }, []);

  const savePayment = async () => {
    if (!detail) return;
    const amt = Number((amount || "").toString().replace(/[^0-9.]/g, ""));
    if (!amt || amt <= 0) { toast.error("Enter a valid amount"); return; }
    setSaving(true);
    try {
      await api.post("/payments", {
        quotation_id: detail.id, amount: amt, mode,
        reference: reference || null,
        paid_at: payDate ? new Date(payDate + "T12:00:00Z").toISOString() : null,
      });
      toast.success("Payment recorded");
      setShowRecord(false);
      setReference("");
      setMode("cash");
      await Promise.all([loadStats(), loadOrders(q), loadDetail(detail.id)]);
    } catch (e: any) {
      toast.error(e?.detail || "Save failed");
    } finally { setSaving(false); }
  };

  const saveManualExtra = async () => {
    if (!detail || !isGroundFloorOrder) return;
    const parsed = Number((manualExtra || "").replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error("Enter a valid extra cost");
      return;
    }
    const name = manualExtraName.trim();
    if (parsed > 0 && !name) {
      toast.error("Name the additional cost");
      return;
    }
    setSavingManualExtra(true);
    try {
      const updated = await api.patch<{ quotation_total: number; manual_extra_amount: number; manual_extra_name?: string | null; grand_total: number }>(
        `/payments/orders/${detail.id}/manual-extra`, { amount: parsed || 0, name: name || null },
      );
      setDetail((current) => current ? {
        ...current,
        ...updated,
        outstanding: Math.max(0, updated.grand_total - current.paid),
        percent_collected: updated.grand_total > 0
          ? Math.min(100, Math.round(current.paid / updated.grand_total * 100)) : 0,
        payment_status: current.paid >= updated.grand_total && updated.grand_total > 0
          ? "paid" : current.paid > 0 ? "partial" : "due",
      } : current);
      setManualExtra(updated.manual_extra_amount ? String(updated.manual_extra_amount) : "");
      setManualExtraName(updated.manual_extra_name || "");
      toast.success("Extra cost updated");
      await Promise.all([loadStats(), loadOrders(q)]);
    } catch (e: any) {
      toast.error(e?.detail || "Could not update extra cost");
    } finally {
      setSavingManualExtra(false);
    }
  };

  const sendWhatsAppReminder = async () => {
    if (!detail) return;
    setWaLoading(true);
    try {
      const res = await api.get<{ wa_url: string; message: string; phone: string | null; phone_display: string | null }>(
        `/payments/orders/${detail.id}/whatsapp-reminder`,
      );
      if (!res.phone) toast.error("No phone number on file — please add one to the customer");
      else toast.success(`Opening WhatsApp for ${res.phone_display || res.phone}`);
      await Linking.openURL(res.wa_url);
    } catch (e: any) { toast.error(e?.detail || "Could not build reminder"); }
    finally { setWaLoading(false); }
  };

  const callCustomer = async () => {
    if (!detail?.customer.phone) { toast.error("No phone number on file"); return; }
    await Linking.openURL(`tel:${detail.customer.phone.replace(/\s+/g, "")}`);
  };

  // ── Payment History: load + export ───────────────────────────────────────
  useEffect(() => {
    api.get<FloorOpt[]>("/settings/floors").then(setFloors).catch(() => setFloors([]));
  }, [selectedFloorId]);

  const historyParams = useCallback(() => {
    const qs = new URLSearchParams();
    if (historyQ.trim()) qs.set("q", historyQ.trim());
    if (historyUnit !== "all") qs.set("business_unit", historyUnit);
    if (historyMode !== "all") qs.set("mode", historyMode);
    if (historyDateFrom) qs.set("date_from", historyDateFrom);
    if (historyDateTo) qs.set("date_to", historyDateTo);
    qs.set("sort", historySort);
    return qs;
  }, [historyQ, historyUnit, historyMode, historyDateFrom, historyDateTo, historySort]);

  const loadHistory = useCallback(async (page: number) => {
    if (!selectedFloorId) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const qs = historyParams();
      qs.set("skip", String(page * HISTORY_PAGE_SIZE));
      qs.set("limit", String(HISTORY_PAGE_SIZE));
      const res = await api.get<{ total: number; items: HistoryRow[] }>(`/payments/history?${qs.toString()}`);
      // A partial or legacy response must still leave the operator with a
      // clear, recoverable state instead of a blank ledger surface.
      setHistoryRows(Array.isArray(res?.items) ? res.items : []);
      setHistoryTotal(Number.isFinite(res?.total) ? res.total : 0);
    } catch (e: any) {
      const message = e?.detail || "Could not load payment history";
      setHistoryRows([]);
      setHistoryTotal(0);
      setHistoryError(message);
      toast.error(message);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyParams, selectedFloorId]);

  // Reset to page 0 whenever a filter changes, then load exactly once.
  // Previously switching to the ledger triggered both of these effects at
  // once, making a slow request look like an empty (or stuck) list on mobile.
  useEffect(() => {
    if (tab !== "history") return;
    setHistoryPage(0);
    const t = setTimeout(() => loadHistory(0), historyQ ? 260 : 0);
    return () => clearTimeout(t);
  }, [tab, historyQ, historyUnit, historyMode, historyDateFrom, historyDateTo, historySort, loadHistory]);

  useEffect(() => {
    // Page zero is loaded by the filter/tab effect above. Pagination is the
    // only source of non-zero pages, so it gets one dedicated request.
    if (tab === "history" && historyPage > 0) void loadHistory(historyPage);
  }, [tab, historyPage, loadHistory]);

  const exportHistory = async (fmt: "csv" | "xlsx") => {
    try {
      const qs = historyParams();
      qs.set("fmt", fmt);
      const url = await api.authenticatedUrl(`/payments/history/export?${qs.toString()}`);
      if (Platform.OS === "web") {
        // @ts-ignore — web only
        window.open(url, "_blank");
      } else {
        await Linking.openURL(url);
      }
      toast.success("Export ready");
    } catch (e: any) {
      toast.error(e?.detail || "Could not export");
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <PageHeader
        title="Payments"
        subtitle={tab === "collections"
          ? "Track outstanding balances, record payments, and send reminders."
          : "Permanent reconciliation ledger — every collected payment, reconciled exactly with Collections."}
        overline={tab === "collections" ? "COLLECTIONS" : "LEDGER"}
        actions={tab === "collections" ? (
          <Button icon="download" label="Export" variant="secondary" size="md"
            onPress={() => toast.success("Export coming soon")} />
        ) : (
          <Dropdown
            testID="history-export"
            label="Export"
            icon="download"
            variant="secondary"
            items={[
              { label: "Export as XLSX", icon: "file-text", onPress: () => exportHistory("xlsx") },
              { label: "Export as CSV", icon: "file", onPress: () => exportHistory("csv") },
            ]}
          />
        )}
      />

      <View style={{ paddingHorizontal: isPhone ? spacing.lg : spacing.xl }}>
        <Tabs
          testID="payments-tabs"
          value={tab}
          onChange={setTab}
          options={[
            { value: "collections", label: "Collections" },
            { value: "history", label: "Payment History", count: historyTotal || undefined },
          ]}
        />
      </View>

      {tab === "collections" ? (
      <ScrollView ref={collectionsScrollRef} contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg, paddingBottom: isPhone ? 132 : spacing.xxxl }}>
        {/* Hero — white card with brand icon tile */}
        <HeroCard
          overline="THIS MONTH"
          title={stats ? `${moneyShort(stats.total_outstanding)} outstanding` : "Loading collections…"}
          subtitle="Follow up on partial and due orders. Recording a payment updates the customer's timeline automatically."
          icon="credit-card"
          iconTone="brand"
        />

        {/* Stats */}
        <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: "wrap" }}>
          <StatTile label="Total Outstanding" value={stats ? moneyShort(stats.total_outstanding) : "—"}
            icon="alert-circle" tone="danger" sub="Across all active orders" />
          <StatTile label="Collected This Month" value={stats ? moneyShort(stats.collected_this_month) : "—"}
            icon="trending-up" tone="success" sub="Payments received" />
          <StatTile label="Active Orders" value={stats ? String(stats.active_orders) : "—"}
            icon="package" tone="brand" sub="Ordered · not fully paid" />
          <StatTile label="Fully Paid" value={stats ? String(stats.fully_paid) : "—"}
            icon="check-circle" tone="success" sub="Closed collections" />
        </View>

        {/* Body */}
        <View style={{ flexDirection: isDesktop ? "row" : "column", gap: spacing.lg, alignItems: "flex-start" }}>
          {/* Left rail */}
          <View style={{ width: isDesktop ? 380 : "100%" }}>
            <Panel title="Customers with balances" overline="COLLECTIONS" padding={spacing.md}>
              <View style={{ gap: spacing.md }}>
                <SearchField
                  testID="payments-search"
                  value={q}
                  onChangeText={setQ}
                  placeholder="Search orders…"
                  onClear={() => setQ("")}
                />
                {loadingList ? (
                  <View style={{ gap: spacing.sm }}>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <View key={i} style={{
                        padding: spacing.md, gap: spacing.sm,
                        borderRadius: radius.md,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: colors.border,
                      }}>
                        <Skeleton w="60%" h={14} radius={radius.sm} />
                        <Skeleton w="40%" h={12} radius={radius.sm} />
                        <Skeleton w="100%" h={4} radius={radius.pill} />
                      </View>
                    ))}
                  </View>
                ) : orders.length === 0 ? (
                  <EmptyState icon="inbox" title="No outstanding customers"
                    subtitle="Place an order from a quotation to start tracking payments here." />
                ) : (
                  <View style={{ gap: spacing.sm }}>
                    {customerCollections.map((customer) => (
                      <CustomerCollectionCard
                        key={customer.id}
                        customer={customer}
                        active={customer.id === selectedCustomer?.id}
                        onPress={() => selectCustomer(customer)}
                      />
                    ))}
                  </View>
                )}
              </View>
            </Panel>
          </View>

          {/* Right — detail */}
          <View
            onLayout={(event) => { detailTopRef.current = event.nativeEvent.layout.y; }}
            style={{ flex: 1, gap: spacing.lg, minWidth: 0, width: isDesktop ? undefined : "100%" }}
          >
            {loadingDetail || !detail ? (
              <Card>
                <EmptyState
                  icon={loadingDetail ? "loader" : "file-text"}
                  title={loadingDetail ? "Loading order…" : "Select an order"}
                  subtitle={loadingDetail ? "Fetching the latest payment history." : "Choose a row on the left to see its details."}
                />
              </Card>
            ) : (
              <>
                {/* Detail header */}
                <Panel padding={spacing.lg}>
                  <View style={{
                    flexDirection: "row", justifyContent: "space-between",
                    alignItems: "flex-start", gap: spacing.md, flexWrap: "wrap",
                  }}>
                    <View style={{ flex: 1, minWidth: 200, gap: 4 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
                        <Text style={[type.titleLg, { flexShrink: 1 }]} numberOfLines={2}>
                          {detail.customer.company || detail.customer_name}
                        </Text>
                        <StatusBadge status={detail.payment_status} />
                      </View>
                      <Text style={type.caption} numberOfLines={2}>
                        {detail.number} · Confirmed {dateShort(detail.confirmed_at)}
                        {detail.customer.city ? ` · ${detail.customer.city}` : ""}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", gap: spacing.sm, flexShrink: 0 }}>
                      <Button label="WhatsApp" icon="message-circle" variant="secondary" size="sm"
                        loading={waLoading} onPress={sendWhatsAppReminder} testID="wa-reminder-btn" />
                      <Button label="Call" icon="phone" variant="secondary" size="sm"
                        onPress={callCustomer} testID="call-btn" />
                    </View>
                  </View>
                </Panel>

                {/* Collection actions precede the ledger so they are usable immediately on a phone. */}
                {detail.outstanding > 0 ? (
                  <Button
                    testID="open-record-payment"
                    label="Record Payment"
                    icon="plus"
                    variant="primary"
                    size="lg"
                    fullWidth
                    onPress={() => setShowRecord(true)}
                  />
                ) : (
                  <UIAlert tone="success" title="Order fully paid"
                    description="Every rupee collected — this order is closed." />
                )}

                {isGroundFloorOrder ? (
                  <Panel title="Additional cost" overline="GROUND FLOOR" padding={spacing.lg}>
                    <Text style={[type.body, { color: colors.onSurfaceMuted, marginBottom: spacing.md }]}>Name the expense and update its amount whenever the agreed price changes. The original quotation price remains unchanged.</Text>
                    <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.sm, alignItems: isPhone ? "stretch" : "flex-end" }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[type.caption, { marginBottom: 6 }]}>Cost name</Text>
                        <TextInput
                          testID="ground-floor-manual-extra-name"
                          value={manualExtraName}
                          onChangeText={setManualExtraName}
                          placeholder="e.g. Labour cost"
                          placeholderTextColor={colors.onSurfaceMuted}
                          style={styles.dateInput}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[type.caption, { marginBottom: 6 }]}>Amount (₹)</Text>
                        <TextInput
                          testID="ground-floor-manual-extra"
                          value={manualExtra}
                          onChangeText={setManualExtra}
                          keyboardType="decimal-pad"
                          placeholder="0"
                          placeholderTextColor={colors.onSurfaceMuted}
                          style={styles.dateInput}
                        />
                      </View>
                      <Button label="Update total" icon="plus" variant="secondary" loading={savingManualExtra}
                        onPress={saveManualExtra} testID="save-ground-floor-manual-extra" />
                    </View>
                  </Panel>
                ) : null}

                {selectedCustomer && selectedCustomer.orders.length > 1 ? (
                  <Panel title="Outstanding customer orders" overline="SELECT AN ORDER" padding={spacing.md}>
                    <View style={{ gap: spacing.sm }}>
                      {selectedCustomer.orders.map((order) => (
                        <Pressable
                          key={order.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Select ${order.number}`}
                          onPress={() => {
                            shouldFocusDetailRef.current = true;
                            setSelectedId(order.id);
                          }}
                          style={({ pressed }) => [{
                            padding: spacing.md, borderRadius: radius.md, borderWidth: 1,
                            borderColor: order.id === detail.id ? colors.brand : colors.border,
                            backgroundColor: order.id === detail.id ? colors.surfaceTertiary : colors.surfaceSecondary,
                            opacity: pressed ? 0.84 : 1,
                          }]}
                        >
                          <View style={{ flexDirection: "row", gap: spacing.sm, justifyContent: "space-between", alignItems: "center" }}>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={type.titleSm}>{order.number}</Text>
                              <Text style={type.caption}>{order.percent_collected}% collected · {money(order.paid)} paid</Text>
                            </View>
                            <Text style={{ color: colors.error, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{money(order.outstanding)}</Text>
                          </View>
                        </Pressable>
                      ))}
                    </View>
                  </Panel>
                ) : null}

                {/* Metrics */}
                <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: "wrap" }}>
                  {isGroundFloorOrder ? (
                    <StatTile dense label="Quotation price" value={money(detail.quotation_total)}
                      sub="Original quotation" tone="brand" />
                  ) : (
                    <>
                      <StatTile dense label="MRP" value={money(detail.mrp)} sub="Catalog price" tone="neutral" />
                      <StatTile dense label="Discounted" value={money(detail.discounted_rate)}
                        sub={detail.mrp > detail.discounted_rate ? `Save ${moneyShort(detail.mrp - detail.discounted_rate)}` : "No discount"}
                        tone="brand" />
                    </>
                  )}
                  {isGroundFloorOrder && detail.manual_extra_amount > 0 ? (
                    <StatTile dense label="Additional cost" value={money(detail.manual_extra_amount)}
                      sub={detail.manual_extra_name || "Additional cost"} tone="neutral" />
                  ) : null}
                  <StatTile dense label="Paid" value={money(detail.paid)}
                    sub={`${detail.percent_collected}% of order`} tone="success" />
                  <StatTile dense label="Outstanding" value={money(detail.outstanding)}
                    sub={detail.outstanding > 0 ? "Remaining balance" : "Fully paid"}
                    tone={detail.outstanding > 0 ? "danger" : "success"} />
                </View>

                {/* Progress */}
                <Panel padding={spacing.lg}>
                  <View style={{ gap: spacing.sm }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={type.overline}>Collection progress</Text>
                      <Text style={{
                        fontSize: 13, fontFamily: type.titleMd.fontFamily, fontWeight: "700",
                        color: colors.onSurface, fontVariant: ["tabular-nums"],
                      }}>{detail.percent_collected}%</Text>
                    </View>
                    <ProgressBar percent={detail.percent_collected}
                      tone={paymentTone(detail.payment_status)} size="md" />
                  </View>
                </Panel>

                {/* History */}
                <Panel
                  title="Payment history"
                  overline="LEDGER"
                  actions={detail.payments.length
                    ? <Badge label={`${detail.payments.length} entries`} tone="neutral" size="sm" />
                    : undefined}
                >
                  {detail.payments.length === 0 && detail.outstanding > 0 ? (
                    <UIAlert
                      tone="error"
                      title={`${money(detail.outstanding)} still outstanding`}
                      description="No payments recorded yet. Send a WhatsApp reminder or use Record Payment above."
                    />
                  ) : detail.payments.length === 0 ? (
                    <EmptyState icon="check-circle" title="Fully paid"
                      subtitle="No payments to show." tone="brand" />
                  ) : (
                    <View>
                      {detail.payments.map((p, i) => {
                        const copy = paymentHistoryCopy(p);
                        return <ActivityRow
                          key={p.id}
                          icon={MODE_ICONS[p.mode]}
                          iconTone="success"
                          title={copy.title}
                          subtitle={copy.subtitle}
                          timestamp={dateShort(p.paid_at || p.created_at)}
                          isLast={i === detail.payments.length - 1}
                        />;
                      })}
                    </View>
                  )}
                </Panel>

              </>
            )}
          </View>
        </View>
      </ScrollView>
      ) : (
        <PaymentHistoryTab
          rows={historyRows}
          total={historyTotal}
          loading={historyLoading}
          error={historyError}
          onRetry={() => void loadHistory(historyPage)}
          page={historyPage}
          pageSize={HISTORY_PAGE_SIZE}
          onPageChange={setHistoryPage}
          q={historyQ} onQChange={setHistoryQ}
          unit={historyUnit} onUnitChange={setHistoryUnit}
          floors={floors}
          mode={historyMode} onModeChange={setHistoryMode}
          dateFrom={historyDateFrom} onDateFromChange={setHistoryDateFrom}
          dateTo={historyDateTo} onDateToChange={setHistoryDateTo}
          sort={historySort} onSortChange={setHistorySort}
          onOpenCustomer={(id) => router.push(`/(admin)/customers/${id}` as any)}
          onOpenOrder={(id) => router.push(`/(admin)/quotations/${id}` as any)}
        />
      )}

      <RecordPaymentSheet
        visible={showRecord}
        onClose={() => setShowRecord(false)}
        detail={detail}
        amount={amount} setAmount={setAmount}
        payDate={payDate} setPayDate={setPayDate}
        mode={mode} setMode={setMode}
        reference={reference} setReference={setReference}
        onSave={savePayment}
        saving={saving}
      />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PaymentHistoryTab — banking-ledger view. Filters + a dense DataTable that
// horizontally scrolls (with the customer name pinned) rather than clipping
// on a phone — same table primitive as Tile Orders, so a 12-column ledger
// behaves identically to every other dense operational table in the app.
// ─────────────────────────────────────────────────────────────────────────────
const PAY_MODE_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All methods" },
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "bank", label: "Bank Transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
];

function DateInput({ value, onChange, placeholder, testID }: {
  value: string; onChange: (v: string) => void; placeholder: string; testID?: string;
}) {
  if (Platform.OS === "web") {
    return (
      // @ts-ignore native HTML date input — matches RecordPaymentSheet's pattern.
      <input
        type="date" value={value} onChange={(e: any) => onChange(e.target.value)}
        data-testid={testID}
        style={{
          border: `1px solid ${colors.border}`, borderRadius: radius.md,
          padding: "0 12px", fontSize: 13, height: 40, minWidth: 140,
          backgroundColor: colors.surfaceSecondary, color: colors.onSurface,
          fontFamily: "inherit", outline: "none", boxSizing: "border-box",
        } as any}
      />
    );
  }
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={colors.onSurfaceMuted}
      style={styles.dateInput}
    />
  );
}

function PaymentHistoryTab(props: {
  rows: HistoryRow[]; total: number; loading: boolean; error: string | null; onRetry: () => void;
  page: number; pageSize: number; onPageChange: (p: number) => void;
  q: string; onQChange: (v: string) => void;
  unit: string; onUnitChange: (v: string) => void; floors: FloorOpt[];
  mode: string; onModeChange: (v: string) => void;
  dateFrom: string; onDateFromChange: (v: string) => void;
  dateTo: string; onDateToChange: (v: string) => void;
  sort: string; onSortChange: (v: string) => void;
  onOpenCustomer: (customerId: string) => void;
  onOpenOrder: (quotationId: string) => void;
}) {
  const { isPhone } = useBp();
  const {
    rows, total, loading, error, onRetry, page, pageSize, onPageChange,
    q, onQChange, unit, onUnitChange, floors,
    mode, onModeChange, dateFrom, onDateFromChange, dateTo, onDateToChange,
    sort, onSortChange, onOpenCustomer, onOpenOrder,
  } = props;

  const unitOptions = [{ value: "all", label: "All business units" }, ...floors.map((f) => ({ value: f.id, label: f.name }))];
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(total, (page + 1) * pageSize);

  const columns: Column<HistoryRow>[] = [
    {
      key: "customer", label: "CUSTOMER", grow: 2, minWidth: 170, sticky: true,
      render: (r) => <CellTitle>{r.customer_name || "—"}</CellTitle>,
    },
    {
      key: "invoice", label: "INVOICE / ORDER", width: 150,
      render: (r) => <CellMono>{r.invoice_number || "—"}</CellMono>,
    },
    {
      key: "unit", label: "BUSINESS UNIT", width: 168,
      render: (r) => <CellText muted>{r.business_unit || r.floor_id}</CellText>,
    },
    {
      key: "date", label: "PAYMENT DATE", width: 120,
      render: (r) => <CellText>{dateShort(r.paid_at)}</CellText>,
    },
    {
      key: "amount", label: "AMOUNT", width: 130, align: "right",
      render: (r) => <CellNumber value={money(r.amount)} />,
    },
    {
      key: "method", label: "METHOD", width: 128,
      render: (r) => <CellText muted>{MODE_LABELS[r.mode] || r.mode}</CellText>,
    },
    {
      key: "reference", label: "REFERENCE", width: 140,
      render: (r) => <CellMono>{r.reference || "—"}</CellMono>,
    },
    {
      key: "collected_by", label: "COLLECTED BY", width: 150,
      render: (r) => <CellText muted>{r.recorded_by_name || "—"}</CellText>,
    },
    {
      key: "before", label: "OUTSTANDING BEFORE", width: 150, align: "right",
      render: (r) => <CellNumber value={r.outstanding_before != null ? money(r.outstanding_before) : "—"} dim />,
    },
    {
      key: "after", label: "OUTSTANDING AFTER", width: 150, align: "right",
      render: (r) => <CellNumber value={r.outstanding_after != null ? money(r.outstanding_after) : "—"} dim />,
    },
    {
      key: "status", label: "STATUS", width: 118, align: "center",
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "notes", label: "NOTES", grow: 1, minWidth: 160,
      render: (r) => <CellText muted>{r.label ? `${r.label}${r.note ? ` · ${r.note}` : ""}` : r.note || "—"}</CellText>,
    },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg, paddingBottom: isPhone ? 132 : spacing.xxxl }}>
      <Card padding={spacing.md} style={{ gap: spacing.md }}>
        <SearchField
          testID="history-search"
          value={q}
          onChangeText={onQChange}
          placeholder="Search customer, invoice number, or reference…"
          onClear={() => onQChange("")}
        />
        <FilterBar testID="history-unit-filter" label="BUSINESS UNIT" value={unit} onChange={onUnitChange} options={unitOptions} />
        <FilterBar testID="history-mode-filter" label="PAYMENT METHOD" value={mode} onChange={onModeChange} options={PAY_MODE_FILTERS} />
        <View style={{ gap: spacing.sm }}>
          <Text style={type.overline}>DATE RANGE</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
            <DateInput testID="history-date-from" value={dateFrom} onChange={onDateFromChange} placeholder="From (YYYY-MM-DD)" />
            <Text style={type.caption}>to</Text>
            <DateInput testID="history-date-to" value={dateTo} onChange={onDateToChange} placeholder="To (YYYY-MM-DD)" />
            {dateFrom || dateTo ? (
              <Button label="Clear dates" variant="ghost" size="sm"
                onPress={() => { onDateFromChange(""); onDateToChange(""); }} />
            ) : null}
            <View style={{ flex: 1 }} />
            <Dropdown
              testID="history-sort"
              label={HISTORY_SORTS.find((s) => s.value === sort)?.label || "Sort"}
              icon="arrow-down"
              variant="secondary"
              items={HISTORY_SORTS.map((s) => ({ label: s.label, onPress: () => onSortChange(s.value) }))}
            />
          </View>
        </View>
      </Card>

      {loading && rows.length === 0 ? (
        <View style={{ gap: spacing.sm }}>
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} w="100%" h={56} radius={radius.md} />)}
        </View>
      ) : error ? (
        <EmptyState icon="alert-triangle" title="Couldn't load payment history"
          subtitle={error} action={<Button label="Try again" variant="secondary" onPress={onRetry} />} />
      ) : rows.length === 0 ? (
        <EmptyState icon="file-text" title={q || unit !== "all" || mode !== "all" || dateFrom || dateTo ? "No payments match these filters" : "No completed payments yet"}
          subtitle={q || unit !== "all" || mode !== "all" || dateFrom || dateTo
            ? "Try widening the date range or clearing a filter."
            : "Completed payments will appear here after they are recorded."} />
      ) : (
        <>
          <DataTable
            testID="payment-history-table"
            columns={columns}
            data={rows}
            rowMinHeight={56}
            keyExtractor={(r) => r.id}
            rowTestID={(r) => `history-row-${r.id}`}
            onRowPress={(r) => (r.quotation_id ? onOpenOrder(r.quotation_id) : onOpenCustomer(r.customer_id))}
            emptyMessage="No payments match these filters."
          />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.sm }}>
            <Text style={type.caption}>
              {rangeStart}–{rangeEnd} of {total} payment{total === 1 ? "" : "s"}
            </Text>
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <Button label="Previous" size="sm" variant="secondary" disabled={page <= 0}
                onPress={() => onPageChange(Math.max(0, page - 1))} testID="history-prev-page" />
              <Button label={`Page ${page + 1} of ${pageCount}`} size="sm" variant="ghost" disabled />
              <Button label="Next" size="sm" variant="secondary" disabled={page + 1 >= pageCount}
                onPress={() => onPageChange(page + 1)} testID="history-next-page" />
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CustomerCollectionCard — a customer-first collection queue. Payment writes
// remain safely scoped to the selected order in the detail panel.
// ─────────────────────────────────────────────────────────────────────────────
function CustomerCollectionCard({ customer, active, onPress }: { customer: CustomerCollection; active: boolean; onPress: () => void }) {
  const collectedPercent = customer.paid + customer.outstanding <= 0 ? 0
    : Math.round(customer.paid / (customer.paid + customer.outstanding) * 100);
  return (
    <HoverCard
      onPress={onPress}
      padding={spacing.md}
      testID={`payment-customer-${customer.id}`}
      style={{
        borderColor: active ? colors.brand : colors.border,
        backgroundColor: active ? colors.brandTint : colors.surfaceSecondary,
      }}
    >
      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
          <Text style={[type.titleSm, { flex: 1 }]} numberOfLines={1}>{customer.name}</Text>
          <Badge label={`${moneyShort(customer.outstanding)} due`} tone="error" size="sm" />
        </View>
        <Text style={type.caption} numberOfLines={1}>
          {customer.orderCount} outstanding order{customer.orderCount === 1 ? "" : "s"}
        </Text>
        <ProgressBar percent={collectedPercent} tone={collectedPercent ? "warning" : "danger"} size="xs" />
        <Text style={type.caption}>{collectedPercent}% collected across open orders</Text>
      </View>
    </HoverCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RecordPaymentSheet — unified Sheet primitive.
// ─────────────────────────────────────────────────────────────────────────────
function RecordPaymentSheet(props: {
  visible: boolean; onClose: () => void;
  detail: OrderDetail | null;
  amount: string; setAmount: (v: string) => void;
  payDate: string; setPayDate: (v: string) => void;
  mode: PayMode; setMode: (m: PayMode) => void;
  reference: string; setReference: (v: string) => void;
  onSave: () => void; saving: boolean;
}) {
  const { visible, onClose, detail, amount, setAmount, payDate, setPayDate, mode, setMode, reference, setReference, onSave, saving } = props;
  if (!detail) return null;
  const modes: PayMode[] = ["cash", "upi", "bank", "cheque", "card"];

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      variant="drawer"
      title="Record Payment"
      subtitle={`${detail.customer.company || detail.customer_name} · ${detail.number} · ${money(detail.outstanding)} outstanding`}
      testID="record-payment-sheet"
      footer={
        <>
          <Button label="Cancel" variant="secondary" onPress={onClose} size="md" />
          <View style={{ flex: 1 }} />
          <Button label="Save Payment" variant="primary" icon="check"
            onPress={onSave} loading={saving} size="md" testID="save-payment" />
        </>
      }
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
          <FormField label="Amount Received (₹)" required>
            <TextInput
              testID="pay-amount"
              value={amount}
              onChangeText={(v) => setAmount(v.replace(/[^0-9.]/g, ""))}
              keyboardType="numeric"
              placeholder="e.g. 1090000"
              placeholderTextColor={colors.onSurfaceMuted}
              style={styles.numericInput}
            />
            <Text style={[type.caption, { marginTop: 6 }]}>Outstanding: {money(detail.outstanding)}</Text>
          </FormField>

          <FormField label="Date Received">
            {Platform.OS === "web" ? (
              // @ts-ignore native HTML date input
              <input type="date" value={payDate}
                onChange={(e: any) => setPayDate(e.target.value)}
                style={{
                  border: `1px solid ${colors.border}`, borderRadius: radius.md,
                  padding: "10px 12px", fontSize: 14,
                  backgroundColor: colors.surfaceSecondary, color: colors.onSurface,
                  fontFamily: "inherit", outline: "none", boxSizing: "border-box", height: 40,
                } as any}
              />
            ) : (
              <TextInput
                testID="pay-date"
                value={payDate}
                onChangeText={setPayDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.onSurfaceMuted}
                style={styles.textInput}
              />
            )}
          </FormField>

          <FormField label="Payment Method">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
              {modes.map((m) => {
                const on = mode === m;
                return (
                  <Pressable
                    key={m}
                    testID={`pay-mode-${m}`}
                    onPress={() => setMode(m)}
                    style={({ pressed, hovered }: any) => ({
                      paddingHorizontal: spacing.md,
                      height: 40,
                      borderRadius: radius.md,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: on ? colors.brand : hovered ? colors.borderStrong : colors.border,
                      backgroundColor: on ? colors.brand : colors.surfaceSecondary,
                      alignItems: "center", justifyContent: "center",
                      flexDirection: "row", gap: 6,
                      opacity: pressed ? 0.85 : 1,
                    })}
                  >
                    <Feather name={MODE_ICONS[m]} size={iconSize.sm}
                      color={on ? colors.onBrand : colors.onSurfaceSecondary} />
                    <Text style={{
                      color: on ? colors.onBrand : colors.onSurface,
                      fontSize: 13, fontFamily: type.titleMd.fontFamily,
                      fontWeight: on ? "600" : "500",
                    }}>
                      {MODE_LABELS[m]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </FormField>

          <FormField label="Reference / Notes" helper="Cheque number, UTR, or any internal note">
            <TextInput
              testID="pay-reference"
              value={reference}
              onChangeText={setReference}
              placeholder="Optional…"
              placeholderTextColor={colors.onSurfaceMuted}
              style={[styles.textInput, { minHeight: 72, textAlignVertical: "top" }]}
              multiline
            />
          </FormField>
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

// Local styles — only for form inputs (which are not in the DS yet).
const styles = StyleSheet.create({
  textInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: colors.surfaceSecondary,
    color: colors.onSurface,
    fontFamily: type.body.fontFamily,
    height: 40,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}),
  },
  numericInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 22,
    fontFamily: type.titleLg.fontFamily,
    fontWeight: "700",
    backgroundColor: colors.surfaceSecondary,
    color: colors.onSurface,
    fontVariant: ["tabular-nums"],
    ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}),
  },
  dateInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 13,
    backgroundColor: colors.surfaceSecondary,
    color: colors.onSurface,
    fontFamily: type.body.fontFamily,
    height: 40,
    minWidth: 140,
  },
});
