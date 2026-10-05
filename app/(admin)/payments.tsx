// ═══════════════════════════════════════════════════════════════════════════
// Payments — migrated to Design System V2.
// Consumes ONLY primitives from @/src/components/ds. Zero local styles for
// spacing, color, radius, elevation, typography, or motion. Business logic
// preserved byte-for-byte from the previous implementation.
// ═══════════════════════════════════════════════════════════════════════════
import { Disclosure } from "@/src/design/Disclosure";
import { useReducedMotion } from "@/src/hooks/use-reduced-motion";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useBp } from "@/src/design/responsive";
import { toast } from "@/src/components/Toast";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { quotationDestination } from "@/src/utils/quotationNavigation";
import { downloadApiFile } from "@/src/utils/downloadFile";
import {
  Alert as UIAlert,
  Badge, Button, Card, Dropdown, EmptyState, FilterBar, FormField, ErrorState,
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
  refund_due_total?: number;
  collected_this_month: number;
  active_orders: number;
  fully_paid: number;
  active_total: number;
  active_received: number;
  earned_total: number;
  spending_total: number;
};

type OrderRow = {
  id: string; number: string; customer_id: string; customer_name: string;
  grand_total: number; paid: number; outstanding: number;
  effective_order_total?: number; godown_transferred_value?: number; cash_received?: number; refund_due?: number;
  percent_collected: number; payment_status: "paid" | "partial" | "due";
  confirmed_at: string; outstanding_short: string | null; days_unpaid: number;
};

type PaymentEntry = {
  id: string; amount: number; mode: PayMode | "adjustment";
  reference?: string | null; note?: string | null; label?: string | null;
  entry_type?: "payment" | "godown_stock_credit" | "additional_cost";
  cost_name?: string | null;
  paid_at?: string | null; created_at?: string; recorded_by_name?: string | null;
  status?: "pending" | "completed" | "failed";
};

type OrderDetail = {
  id: string; number: string; status: string; doc_type?: string;
  customer: {
    id: string; name: string; company?: string | null;
    phone?: string | null; email?: string | null; city?: string | null;
  };
  customer_name: string; confirmed_at: string; notes?: string | null;
  project_name?: string | null;
  floor_id: string; mrp: number; discounted_rate: number;
  quotation_total: number; manual_extra_amount: number; manual_extra_name?: string | null; grand_total: number;
  effective_order_total?: number; godown_transferred_value?: number; cash_received?: number; refund_due?: number;
  additional_costs?: { id: string; name: string; amount: number; note?: string | null; created_at: string; recorded_by_name?: string | null }[];
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

const AGING_OPTIONS = [
  { value: "all", label: "All outstanding" },
  { value: "5_days", label: "5+ days" },
  { value: "1_week", label: "1+ week" },
  { value: "1_month", label: "1+ month" },
  { value: "6_months", label: "6+ months" },
  { value: "over_6_months", label: "Over 6 months" },
  { value: "custom", label: "Custom period" },
];

function money(n: number): string {
  return `₹${(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function paymentHistoryCopy(payment: PaymentEntry): { title: string; subtitle: string } {
  if (payment.entry_type === "additional_cost") {
    return {
      title: `Additional cost · ${payment.cost_name || "Unnamed cost"} · ${money(payment.amount)}`,
      subtitle: `${payment.note ? `${payment.note} · ` : ""}Recorded by ${payment.recorded_by_name || "—"}`,
    };
  }
  if (payment.entry_type === "godown_stock_credit") {
    return {
      title: `Moved to go-down stock · ${money(payment.amount)}`,
      subtitle: payment.note || "Customer balance reduced for returned stock.",
    };
  }
  if (payment.status === "failed") {
    return { title: `Failed payment · ${money(payment.amount)}`, subtitle: payment.note || "Excluded from money received." };
  }
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
  title: `${payment.status === "pending" ? "Pending · " : ""}${MODE_LABELS[payment.mode as PayMode] || "Adjustment"} · ${money(payment.amount)}`,
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
function dateTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return "—"; }
}
function todayIso(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

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
  paid_at?: string | null; amount: number; mode: PayMode | "adjustment";
  reference?: string | null; recorded_by_name?: string | null;
  outstanding_before: number | null; outstanding_after: number | null;
  status: "pending" | "completed" | "failed" | "adjustment"; note?: string | null; label?: string | null;
  entry_type?: "payment" | "godown_stock_credit" | "additional_cost";
  cost_name?: string | null;
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
  const { isDesktop, isTabletLandscape, isPhone, height } = useBp();
  const sideBySide = isDesktop || isTabletLandscape;
  const compactCostForm = isPhone || isTabletLandscape;
  const { selectedFloorId, selectFloor } = useFloorAccess();
  const router = useRouter();
  const activeFloorRef = useRef(selectedFloorId);
  activeFloorRef.current = selectedFloorId;

  // Collections can include Ground Floor orders while Sanitary is active.
  // Publish the document's floor before mounting its editor so its first fetch
  // and autosave cannot use the inherited workspace header.
  const openQuotation = async (document: { id: string; floor_id?: string | null; doc_type?: string | null }, edit = false) => {
    if (document.floor_id && document.floor_id !== selectedFloorId) await selectFloor(document.floor_id);
    router.push(quotationDestination(document, edit) as any);
  };
  const openHistoryQuotation = async (row: HistoryRow) => {
    if (!row.quotation_id) return;
    try {
      const document = await api.get<{ id: string; floor_id?: string; doc_type?: string }>(`/quotations/${encodeURIComponent(row.quotation_id)}`, { floorId: row.floor_id });
      await openQuotation({ ...document, floor_id: document.floor_id || row.floor_id });
    } catch (cause: any) { toast.error(cause?.detail || "Could not open this quotation. Please retry."); }
  };

  const [tab, setTab] = useState<TabKey>("collections");

  const [stats, setStats] = useState<Stats | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [q, setQ] = useState("");
  const [agingPeriod, setAgingPeriod] = useState("all");
  const [customMinDays, setCustomMinDays] = useState("");
  const [customMaxDays, setCustomMaxDays] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const selectedOrderRef = useRef(selectedId);
  selectedOrderRef.current = selectedId;
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const orderRequest = useRef(0);
  const detailRequest = useRef(0);
  const statsRequest = useRef(0);
  const historyRequest = useRef(0);
  const paymentSavingRef = useRef(false);
  const extraSavingRef = useRef(false);
  const paymentAttemptRef = useRef<{ signature: string; key: string } | null>(null);
  const historyFilterRef = useRef("");
  const extraAttemptRef = useRef<{ signature: string; key: string } | null>(null);
  const reducedMotion = useReducedMotion();
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [waLoading, setWaLoading] = useState(false);

  const [showRecord, setShowRecord] = useState(false);
  const [showMobileQueue, setShowMobileQueue] = useState(false);
  const [amount, setAmount] = useState("");
  const [payDate, setPayDate] = useState(todayIso());
  const [mode, setMode] = useState<PayMode>("cash");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [manualExtra, setManualExtra] = useState("");
  const [manualExtraName, setManualExtraName] = useState("");
  const [savingManualExtra, setSavingManualExtra] = useState(false);
  const collectionsScrollRef = useRef<ScrollView>(null);
  const bodyTopRef = useRef(0);
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
    if (!selectedFloorId || activeFloorRef.current !== selectedFloorId) return;
    const request = ++statsRequest.current;
    setStatsError(false);
    try { const result = await api.get<Stats>("/payments/stats"); if (request === statsRequest.current) setStats(result); }
    catch { if (request === statsRequest.current) setStatsError(true); }
  }, [selectedFloorId]);

  const loadOrders = useCallback(async (query: string = q) => {
    if (!selectedFloorId || activeFloorRef.current !== selectedFloorId) return;
    const request = ++orderRequest.current;
    setLoadingList(true);
    setListError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (agingPeriod !== "all") params.set("overdue_period", agingPeriod);
      if (agingPeriod === "custom") {
        if (customMinDays) params.set("custom_min_days", customMinDays);
        if (customMaxDays) params.set("custom_max_days", customMaxDays);
        if (!customMinDays && !customMaxDays) params.delete("overdue_period");
      }
      const url = `/payments/orders${params.toString() ? `?${params.toString()}` : ""}`;
      const list = await api.get<OrderRow[]>(url);
      if (request !== orderRequest.current) return;
      setOrders(list);
      setSelectedId((current) => list.some((order) => order.id === current) ? current : (list.length ? list[0].id : null));
      return list;
    } catch (e: any) {
      if (request === orderRequest.current) setListError(e?.detail || "Check your connection and try again.");
    } finally {
      if (request === orderRequest.current) setLoadingList(false);
    }
  }, [q, agingPeriod, customMinDays, customMaxDays, selectedFloorId]);

  const loadDetail = useCallback(async (id: string) => {
    if (!selectedFloorId || activeFloorRef.current !== selectedFloorId) return;
    const request = ++detailRequest.current;
    setLoadingDetail(true);
    setDetail(null);
    setDetailError(null);
    try {
      const d = await api.get<OrderDetail>(`/payments/orders/${id}`);
      if (request !== detailRequest.current) return;
      setDetail(d);
      setAmount(d.outstanding > 0 ? d.outstanding.toFixed(2) : "");
      setManualExtra("");
      setManualExtraName("");
    } catch (e: any) {
      if (request === detailRequest.current) setDetailError(e?.detail || "Check your connection and try again.");
    } finally {
      if (request === detailRequest.current) setLoadingDetail(false);
    }
  }, [selectedFloorId]);

  useEffect(() => {
    orderRequest.current += 1; detailRequest.current += 1; statsRequest.current += 1; historyRequest.current += 1;
    setShowRecord(false); setPaymentError(null); paymentAttemptRef.current = null;
    setListError(null); setDetailError(null);
    setStats(null); setOrders([]); setSelectedId(null); setDetail(null); setHistoryRows([]); setHistoryTotal(0);
    loadStats();
  }, [selectedFloorId, loadStats]);
  useEffect(() => {
    const t = setTimeout(() => { loadOrders(q); }, 220);
    return () => clearTimeout(t);
  }, [q, loadOrders, selectedFloorId]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); else { detailRequest.current += 1; setDetail(null); } }, [selectedId, loadDetail]);

  // Tablet portrait keeps the queue above the detail. Phones show only one
  // panel at a time, so switching customers never pushes Record Payment down.
  useEffect(() => {
    if (isPhone || sideBySide || !detail || !shouldFocusDetailRef.current) return;
    const timer = setTimeout(() => {
      collectionsScrollRef.current?.scrollTo({ y: bodyTopRef.current + detailTopRef.current, animated: !reducedMotion });
      shouldFocusDetailRef.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [detail, isPhone, sideBySide, reducedMotion]);

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

  const selectedCustomer = customerCollections.find((customer) => customer.orders.some((order) => order.id === selectedId))
    || customerCollections.find((customer) => customer.id === selectedCustomerId)
    || null;

  const selectCustomer = useCallback((customer: CustomerCollection) => {
    shouldFocusDetailRef.current = !isPhone;
    setSelectedCustomerId(customer.id);
    setSelectedId(customer.orders[0]?.id || null);
    if (isPhone) {
      setShowMobileQueue(false);
      collectionsScrollRef.current?.scrollTo({ y: 0, animated: false });
    }
  }, [isPhone]);

  const refreshCollections = async (orderId: string) => {
    // Refresh the queue first: a settled order can disappear and select the next
    // customer. Never race that selection with a detail request for the old order.
    const [, list] = await Promise.all([loadStats(), loadOrders(q)]);
    if (activeFloorRef.current === selectedFloorId && selectedOrderRef.current === orderId && (!list || list.some((order) => order.id === orderId))) await loadDetail(orderId);
  };
  const refreshOnFocus = useRef(() => {});
  refreshOnFocus.current = () => {
    const current = selectedOrderRef.current;
    if (current) void refreshCollections(current);
    else void Promise.all([loadStats(), loadOrders(q)]);
  };
  const hasFocused = useRef(false);
  useFocusEffect(useCallback(() => {
    // The initial floor/search effects load this screen. A second initial
    // request would replace the customer queue while staff start using it.
    if (hasFocused.current) refreshOnFocus.current();
    else hasFocused.current = true;
  }, []));

  const savePayment = async () => {
    if (!detail || paymentSavingRef.current) return;
    setPaymentError(null);
    const raw = amount.trim();
    const amt = Number(raw);
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || !Number.isFinite(amt) || amt <= 0) {
      setPaymentError("Enter an amount greater than zero with at most two decimal places."); return;
    }
    if (amt > detail.outstanding + 0.001) {
      setPaymentError(`The amount cannot exceed the outstanding balance of ${money(detail.outstanding)}.`); return;
    }
    const receivedDate = payDate ? new Date(`${payDate}T12:00:00Z`) : null;
    if (payDate && (!/^\d{4}-\d{2}-\d{2}$/.test(payDate) || !receivedDate || Number.isNaN(receivedDate.getTime()) || receivedDate.toISOString().slice(0, 10) !== payDate)) {
      setPaymentError("Enter a valid date received."); return;
    }
    const orderId = detail.id;
    const payload = {
      quotation_id: orderId, amount: amt, mode,
      reference: reference.trim() || null,
      paid_at: receivedDate?.toISOString() || null,
    };
    const signature = JSON.stringify(payload);
    // Keep the same key after a lost response so retrying cannot double collect.
    if (paymentAttemptRef.current?.signature !== signature) {
      paymentAttemptRef.current = { signature, key: `payment:${orderId}:${Date.now()}:${Math.random().toString(36).slice(2)}` };
    }
    paymentSavingRef.current = true;
    setSaving(true);
    try {
      await api.post("/payments", { ...payload, idempotency_key: paymentAttemptRef.current.key }, { floorId: selectedFloorId });
      paymentAttemptRef.current = null;
      toast.success("Payment recorded");
      setShowRecord(false);
      setReference("");
      setMode("cash");
      await refreshCollections(orderId);
    } catch (e: any) {
      setPaymentError(e?.detail || "Payment could not be saved. Retry the same payment to safely check whether it was recorded.");
    } finally { paymentSavingRef.current = false; setSaving(false); }
  };

  const saveManualExtra = async () => {
    if (!detail || extraSavingRef.current) return;
    const parsed = Number(manualExtra.trim());
    if (!/^\d+(?:\.\d{1,2})?$/.test(manualExtra.trim()) || !Number.isFinite(parsed) || parsed <= 0) {
      toast.error("Enter a valid extra cost");
      return;
    }
    const name = manualExtraName.trim();
    if (parsed > 0 && !name) {
      toast.error("Name the additional cost");
      return;
    }
    const payload = { amount: parsed, name };
    const signature = JSON.stringify({ orderId: detail.id, ...payload });
    if (extraAttemptRef.current?.signature !== signature) {
      extraAttemptRef.current = { signature, key: `cost:${detail.id}:${Date.now()}:${Math.random().toString(36).slice(2)}` };
    }
    extraSavingRef.current = true;
    setSavingManualExtra(true);
    try {
      const updated = await api.patch<{ quotation_total: number; manual_extra_amount: number; manual_extra_name?: string | null; additional_cost?: NonNullable<OrderDetail["additional_costs"]>[number]; ledger_entry?: PaymentEntry; grand_total: number }>(
        `/payments/orders/${detail.id}/manual-extra`, { ...payload, idempotency_key: extraAttemptRef.current.key }, { floorId: selectedFloorId },
      );
      extraAttemptRef.current = null;
      setDetail((current) => current?.id === detail.id ? {
        ...current,
        ...updated,
        outstanding: Math.max(0, updated.grand_total - current.paid),
        percent_collected: updated.grand_total > 0
          ? Math.min(100, Math.round(current.paid / updated.grand_total * 100)) : 0,
        additional_costs: updated.additional_cost ? [...(current.additional_costs || []).filter((cost) => cost.id !== updated.additional_cost!.id), updated.additional_cost] : current.additional_costs,
        payments: updated.ledger_entry ? [updated.ledger_entry, ...current.payments.filter((payment) => payment.id !== updated.ledger_entry!.id)] : current.payments,
        payment_status: current.paid >= updated.grand_total && updated.grand_total > 0
          ? "paid" : current.paid > 0 ? "partial" : "due",
      } : current);
      setManualExtra("");
      setManualExtraName("");
      toast.success("Additional cost recorded");
      await refreshCollections(detail.id);
    } catch (e: any) {
      toast.error(e?.detail || "Could not update extra cost");
    } finally {
      extraSavingRef.current = false;
      setSavingManualExtra(false);
    }
  };

  const sendWhatsAppReminderFor = async (orderId: string) => {
    setWaLoading(true);
    try {
      const res = await api.get<{ wa_url: string; message: string; phone: string | null; phone_display: string | null }>(
        `/payments/orders/${orderId}/whatsapp-reminder`,
      );
      if (!res.phone) toast.error("No phone number on file — please add one to the customer");
      else toast.success(`Opening WhatsApp for ${res.phone_display || res.phone}`);
      await Linking.openURL(res.wa_url);
    } catch (e: any) { toast.error(e?.detail || "Could not build reminder"); }
    finally { setWaLoading(false); }
  };
  const sendWhatsAppReminder = () => { if (detail) void sendWhatsAppReminderFor(detail.id); };

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
    if (!selectedFloorId || activeFloorRef.current !== selectedFloorId) return;
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const qs = historyParams();
      qs.set("skip", String(page * HISTORY_PAGE_SIZE));
      qs.set("limit", String(HISTORY_PAGE_SIZE));
      const res = await api.get<{ total: number; items: HistoryRow[] }>(`/payments/history?${qs.toString()}`);
      if (request !== historyRequest.current) return;
      // A partial or legacy response must still leave the operator with a
      // clear, recoverable state instead of a blank ledger surface.
      setHistoryRows(Array.isArray(res?.items) ? res.items : []);
      setHistoryTotal(Number.isFinite(res?.total) ? res.total : 0);
    } catch (e: any) {
      if (request !== historyRequest.current) return;
      const message = e?.detail || "Could not load payment history";
      setHistoryRows([]);
      setHistoryTotal(0);
      setHistoryError(message);
      toast.error(message);
    } finally {
      if (request === historyRequest.current) setHistoryLoading(false);
    }
  }, [historyParams, selectedFloorId]);

  // A single effect handles every page, including Previous back to page one.
  // Invalidate old reads immediately when filters, workspace or tab change.
  useEffect(() => {
    historyRequest.current += 1;
    if (tab !== "history") return;
    const filters = `${selectedFloorId}:${historyParams().toString()}`;
    if (historyFilterRef.current !== filters && historyPage !== 0) {
      setHistoryPage(0);
      return;
    }
    historyFilterRef.current = filters;
    const timer = setTimeout(() => void loadHistory(historyPage), historyQ ? 260 : 0);
    return () => { clearTimeout(timer); historyRequest.current += 1; };
  }, [tab, historyPage, historyQ, historyParams, selectedFloorId, loadHistory]);

  const exportHistory = async (fmt: "csv" | "xlsx") => {
    try {
      const qs = historyParams();
      qs.set("fmt", fmt);
      const ok = await downloadApiFile(
        `/payments/history/export?${qs.toString()}`,
        `Payment History ${todayIso()}.${fmt}`,
        "payment history",
      );
      if (ok) toast.success("Export ready");
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
          <Button label="Fully Paid Orders" icon="check-circle" variant="secondary"
            onPress={() => router.push("/(admin)/payments-list" as any)} testID="fully-paid-orders-link" />
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
      <ScrollView testID="payments-collections-scroll" ref={collectionsScrollRef} style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg, paddingBottom: isPhone ? 132 : spacing.xxxl }}>
        <Disclosure title="Collections summary" summary="Unpaid orders, cash received and remaining balance" defaultOpen={!isPhone}>
          {statsError ? <ErrorState title="Summary unavailable" onRetry={() => void loadStats()} /> : null}
        {/* Stats */}
        <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: "wrap" }}>
          <StatTile label="Earned" value={stats ? moneyShort(stats.earned_total) : "—"}
            icon="trending-up" tone="success" sub="Cash retained after adjustments" />
          <StatTile label="Total due now" value={stats ? money(stats.total_outstanding) : "—"}
            icon="alert-circle" tone="danger" sub="Remaining balance across unpaid orders" />
          {(stats?.refund_due_total || 0) > 0 ? <StatTile label="Refund due" value={moneyShort(stats?.refund_due_total || 0)}
            icon="rotate-ccw" tone="danger" sub="Review godown transfers" /> : null}
          <StatTile label="Spending" value={stats ? moneyShort(stats.spending_total) : "—"}
            icon="shopping-bag" tone="neutral" sub="Committed supplier purchases" />
        </View>
        <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: "wrap" }}>
          <StatTile dense label="Value of unpaid orders" value={stats ? money(stats.active_total) : "—"}
            icon="file-text" tone="brand" sub={`${stats?.active_orders ?? "—"} orders · includes amounts already received`} />
          <StatTile dense label="Received on active orders" value={stats ? money(stats.active_received) : "—"}
            icon="check" tone="success" sub="Partial payments received" />
        </View>
        <Text testID="payments-summary-equation" style={type.caption}>Value of unpaid orders − received on those orders = total due now. Fully paid orders appear in Fully Paid Orders and Payment History. {stats?.fully_paid ?? "—"} fully paid orders · {stats ? money(stats.collected_this_month) : "—"} received this month.</Text>

        </Disclosure>

        {isPhone && selectedId ? (
          <Button
            testID="payments-mobile-customer-switch"
            label={showMobileQueue ? "Back to selected order" : `Choose customer · ${selectedCustomer?.name || "none selected"}`}
            icon={showMobileQueue ? "arrow-left" : "users"}
            variant="secondary"
            fullWidth
            onPress={() => setShowMobileQueue((open) => !open)}
          />
        ) : null}

        {/* Body */}
        <View onLayout={(event) => { bodyTopRef.current = event.nativeEvent.layout.y; }}
          style={{ flexDirection: sideBySide ? "row" : "column", gap: spacing.lg, alignItems: "flex-start" }}>
          {/* Left rail */}
          {(!isPhone || showMobileQueue || !selectedId) && <View style={{ width: sideBySide ? 380 : "100%" }}>
            <Panel title="Customers with balances" overline="COLLECTIONS" padding={spacing.md}>
              <View style={{ gap: spacing.md }}>
                <SearchField
                  testID="payments-search"
                  value={q}
                  onChangeText={setQ}
                  placeholder="Search orders…"
                  onClear={() => setQ("")}
                />
                <Dropdown
                  testID="payments-aging-filter"
                  label={AGING_OPTIONS.find((option) => option.value === agingPeriod)?.label || "All outstanding"}
                  icon="calendar"
                  variant="secondary"
                  items={AGING_OPTIONS.map((option) => ({ label: option.label, onPress: () => setAgingPeriod(option.value) }))}
                />
                {agingPeriod === "custom" ? (
                  <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.sm }}>
                    <TextInput testID="payments-custom-min-days" value={customMinDays} onChangeText={(value) => setCustomMinDays(value.replace(/\D/g, ""))}
                      keyboardType="number-pad" placeholder="From days" placeholderTextColor={colors.onSurfaceMuted} style={[styles.dateInput, !isPhone && { flex: 1 }]} />
                    <TextInput testID="payments-custom-max-days" value={customMaxDays} onChangeText={(value) => setCustomMaxDays(value.replace(/\D/g, ""))}
                      keyboardType="number-pad" placeholder="To days" placeholderTextColor={colors.onSurfaceMuted} style={[styles.dateInput, !isPhone && { flex: 1 }]} />
                  </View>
                ) : null}
                {listError ? <ErrorState title="Could not load collections" subtitle={listError} onRetry={() => void loadOrders(q)} /> : loadingList ? (
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
                  <EmptyState icon="inbox" title={q || agingPeriod !== "all" ? "No orders match" : "No outstanding customers"}
                    subtitle={q || agingPeriod !== "all" ? "Try another search or overdue period." : "Place an order from a quotation to start tracking payments here."} />
                ) : (
                  <View style={{ gap: spacing.sm }}>
                    {customerCollections.map((customer) => (
                      <CustomerCollectionCard
                        key={customer.id}
                        customer={customer}
                        active={customer.id === selectedCustomer?.id}
                        onPress={() => selectCustomer(customer)}
                        onRemind={() => void sendWhatsAppReminderFor([...customer.orders].sort((a, b) => b.days_unpaid - a.days_unpaid)[0].id)}
                      />
                    ))}
                  </View>
                )}
              </View>
            </Panel>
          </View>}

          {/* Right — detail */}
          {(!isPhone || (!showMobileQueue && !!selectedId)) && <View
            testID="payments-order-detail"
            onLayout={(event) => { detailTopRef.current = event.nativeEvent.layout.y; }}
            style={[
              { flex: 1, gap: spacing.lg, minWidth: 0, width: sideBySide ? undefined : "100%" },
              sideBySide && Platform.OS === "web" && ({ position: "sticky", top: spacing.md, alignSelf: "flex-start", maxHeight: Math.max(280, height - 220), overflowY: "auto", overscrollBehavior: "contain" } as any),
            ]}
          >
            {detailError ? <ErrorState title="Could not load order" subtitle={detailError} onRetry={() => selectedId && void loadDetail(selectedId)} /> : loadingDetail || !detail ? (
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
                    <View style={{ flexDirection: "row", gap: spacing.sm, flexShrink: 0, flexWrap: "wrap" }}>
                      <Button label="WhatsApp" icon="message-circle" variant="secondary" size="sm"
                        loading={waLoading} onPress={sendWhatsAppReminder} testID="wa-reminder-btn" />
                      <Button label="Call" icon="phone" variant="secondary" size="sm"
                        onPress={callCustomer} testID="call-btn" />
                    </View>
                  </View>
                </Panel>

                {selectedCustomer && selectedCustomer.orders.length > 1 ? (
                  <Panel title="Outstanding customer orders" overline="SELECT AN ORDER" padding={spacing.md}>
                    <Text testID="payment-customer-balance" style={[type.body, { marginBottom: spacing.md }]}>Customer total due: {money(selectedCustomer.outstanding)} across {selectedCustomer.orderCount} orders. Choose one quotation below to view, update or record its payment.</Text>
                    <View style={{ gap: spacing.sm }}>
                      {selectedCustomer.orders.map((order) => (
                        <Pressable
                          key={order.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Select ${order.number}`}
                          accessibilityState={{ selected: order.id === detail.id }}
                          aria-pressed={order.id === detail.id}
                          testID={`payment-select-order-${order.id}`}
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
                              <Text style={type.caption}>Order value {money(order.effective_order_total ?? order.grand_total)} · received {money(order.cash_received ?? order.paid)}</Text>
                            </View>
                            <Text style={{ color: colors.error, fontWeight: "800", fontVariant: ["tabular-nums"], flexShrink: 1 }}>Due {money(order.outstanding)}</Text>
                          </View>
                        </Pressable>
                      ))}
                    </View>
                  </Panel>
                ) : null}

                {/* Collection actions precede the ledger so they are usable immediately on a phone. */}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                  <Button label="Quotation & history" icon="file-text" variant="secondary" size="sm"
                    testID="payment-open-quotation"
                    onPress={() => void openQuotation(detail)} />
                  <Button label="Update quotation" icon="edit-3" variant="secondary" size="sm"
                    testID="payment-edit-quotation"
                    onPress={() => void openQuotation(detail, true)} />
                </View>
                {(detail.refund_due || 0) > 0 ? <UIAlert tone="error" title={`Refund due · ${money(detail.refund_due || 0)}`}
                  description="Cash received exceeds the final order value after a godown transfer. The stock credit did not send money back to the customer; review this amount before settling it." /> : null}
                {detail.outstanding > 0 ? (
                  <Button
                    testID="open-record-payment"
                    label={`Record payment · ${detail.number}`}
                    icon="plus"
                    variant="primary"
                    size="lg"
                    fullWidth
                    onPress={() => { setPaymentError(null); setPayDate(todayIso()); setShowRecord(true); }}
                  />
                ) : (detail.refund_due || 0) > 0 ? null : (
                  <UIAlert tone="success" title="Order fully paid"
                    description="Every rupee collected — this order is closed." />
                )}

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
                          icon={p.entry_type === "additional_cost" ? "plus-circle" : p.status === "pending" ? "clock" : MODE_ICONS[p.mode as PayMode] || "rotate-ccw"}
                          iconTone={p.status === "failed" ? "danger" : p.status === "pending" ? "neutral" : "success"}
                          title={copy.title}
                          subtitle={copy.subtitle}
                          timestamp={dateShort(p.paid_at || p.created_at)}
                          isLast={i === detail.payments.length - 1}
                        />;
                      })}
                    </View>
                  )}
                </Panel>

                  <Panel title="Add an additional cost" overline="PAYMENT ADJUSTMENT" padding={spacing.lg}>
                    <Text style={[type.body, { color: colors.onSurfaceMuted, marginBottom: spacing.md }]}>Each cost is recorded separately with its timestamp. The original quotation price remains unchanged.</Text>
                    <View testID="payment-cost-fields" style={{ flexDirection: compactCostForm ? "column" : "row", gap: spacing.sm, alignItems: compactCostForm ? "stretch" : "flex-end" }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[type.caption, { marginBottom: 6 }]}>Cost name</Text>
                        <TextInput
                          testID="ground-floor-manual-extra-name"
                          value={manualExtraName}
                          onChangeText={setManualExtraName}
                          placeholder="e.g. Labour cost"
                          placeholderTextColor={colors.onSurfaceMuted}
                          style={[styles.dateInput, { minWidth: 0, width: "100%" }]}
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
                          style={[styles.dateInput, { minWidth: 0, width: "100%" }]}
                        />
                      </View>
                      <Button label="Add cost" icon="plus" variant="secondary" loading={savingManualExtra}
                        onPress={saveManualExtra} testID="save-ground-floor-manual-extra" />
                    </View>
                  </Panel>

                {/* Metrics */}
                <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: "wrap" }}>
                  <StatTile dense label="Selected quotation price" value={money(detail.quotation_total)} sub={detail.number} tone="brand" />
                  {(detail.godown_transferred_value || 0) > 0 ? <StatTile dense label="Final order value" value={money(detail.effective_order_total ?? detail.grand_total)} sub={`Godown adjustment ${money(detail.godown_transferred_value || 0)}`} tone="brand" /> : null}
                  {detail.manual_extra_amount > 0 ? (
                    <StatTile dense label="Additional cost" value={money(detail.manual_extra_amount)}
                      sub={detail.manual_extra_name || "Additional cost"} tone="neutral" />
                  ) : null}
                  <StatTile dense label={(detail.godown_transferred_value || 0) > 0 ? "Settled" : "Paid"} value={money(detail.paid)}
                    sub={`${detail.percent_collected}% of order${(detail.godown_transferred_value || 0) > 0 ? " including stock credits" : ""}`} tone="success" />
                  {(detail.godown_transferred_value || 0) > 0 ? <StatTile dense label="Cash received" value={money(detail.cash_received ?? detail.paid)} sub="Excludes stock credits" tone="neutral" /> : null}
                  <StatTile dense label="Outstanding" value={money(detail.outstanding)}
                    sub={detail.outstanding > 0 ? "Remaining balance" : "Fully paid"}
                    tone={detail.outstanding > 0 ? "danger" : "success"} />
                </View>

                {(detail.additional_costs || []).length ? (
                  <Panel title="Additional-cost history" overline="AUDIT LOG" actions={<Badge label={`${detail.additional_costs!.length} entries`} tone="neutral" size="sm" />}>
                    <View>{detail.additional_costs!.map((cost, i) => <ActivityRow key={cost.id} icon="plus-circle" iconTone="neutral" title={`${cost.name} · ${money(cost.amount)}`} subtitle={cost.note || `Recorded by ${cost.recorded_by_name || "—"}`} timestamp={dateShort(cost.created_at)} isLast={i === detail.additional_costs!.length - 1} />)}</View>
                  </Panel>
                ) : null}

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

              </>
            )}
          </View>}
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
          onOpenOrder={(row) => void openHistoryQuotation(row)}
        />
      )}

      <RecordPaymentSheet
        visible={showRecord}
        onClose={() => { if (!saving) { setShowRecord(false); setPaymentError(null); } }}
        detail={detail}
        amount={amount} setAmount={setAmount}
        payDate={payDate} setPayDate={setPayDate}
        mode={mode} setMode={setMode}
        reference={reference} setReference={setReference}
        onSave={savePayment}
        saving={saving}
        error={paymentError}
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
  { value: "adjustment", label: "Additional costs" },
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
  onOpenOrder: (row: HistoryRow) => void;
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
      key: "date", label: "DATE & TIME", width: 178,
      render: (r) => <CellText>{dateTime(r.paid_at)}</CellText>,
    },
    {
      key: "amount", label: "AMOUNT", width: 130, align: "right",
      render: (r) => <CellNumber value={money(r.amount)} />,
    },
    {
      key: "method", label: "METHOD", width: 128,
      render: (r) => <CellText muted>{r.entry_type === "additional_cost" ? "Additional cost" : r.entry_type === "godown_stock_credit" ? "Stock credit" : MODE_LABELS[r.mode as PayMode] || r.mode}</CellText>,
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
    <ScrollView testID="payment-history-scroll" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg, paddingBottom: isPhone ? 132 : spacing.xxxl }}>
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
            onRowPress={(r) => (r.quotation_id ? onOpenOrder(r) : onOpenCustomer(r.customer_id))}
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
function CustomerCollectionCard({ customer, active, onPress, onRemind }: { customer: CustomerCollection; active: boolean; onPress: () => void; onRemind: () => void }) {
  const collectedPercent = customer.paid + customer.outstanding <= 0 ? 0
    : Math.round(customer.paid / (customer.paid + customer.outstanding) * 100);
  const longestPending = Math.max(...customer.orders.map((order) => order.days_unpaid || 0));
  return <View style={{ gap: spacing.xs }}>
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
        {longestPending > 0 ? (
          <Text style={[type.caption, { color: colors.error }]}>
            Payment pending for {longestPending} days
          </Text>
        ) : null}
        <ProgressBar percent={collectedPercent} tone={collectedPercent ? "warning" : "danger"} size="xs" />
        <Text style={type.caption}>{collectedPercent}% collected across open orders</Text>
      </View>
    </HoverCard>
    <Button label={`Remind client · ${moneyShort(customer.outstanding)} due`} icon="message-circle" variant="secondary" size="sm" onPress={onRemind} />
  </View>;
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
  onSave: () => void; saving: boolean; error: string | null;
}) {
  const { visible, onClose, detail, amount, setAmount, payDate, setPayDate, mode, setMode, reference, setReference, onSave, saving, error } = props;
  if (!detail) return null;
  const modes: PayMode[] = ["cash", "upi", "bank", "cheque", "card"];

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      variant="drawer"
      scroll={false}
      dismissable={!saving}
      title="Record Payment"
      subtitle={`${detail.customer.company || detail.customer_name} · ${detail.number} · ${money(detail.outstanding)} outstanding`}
      testID="record-payment-sheet"
      footer={
        <>
          <Button label="Cancel" variant="secondary" onPress={onClose} disabled={saving} size="md" />
          <View style={{ flex: 1 }} />
          <Button label="Save Payment" variant="primary" icon="check"
            onPress={onSave} loading={saving} size="md" testID="save-payment" />
        </>
      }
    >
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, minHeight: 0 }}>
        <ScrollView testID="record-payment-scroll" keyboardShouldPersistTaps="handled" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
          {error ? <UIAlert tone="error" title="Payment not saved" description={error} /> : null}
          <FormField label="Amount Received (₹)" required>
            <TextInput
              accessibilityLabel="Amount received in rupees"
              testID="pay-amount"
              value={amount}
              editable={!saving}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="e.g. 1090000"
              placeholderTextColor={colors.onSurfaceMuted}
              style={styles.numericInput}
            />
            <Text style={[type.caption, { marginTop: 6 }]}>Outstanding: {money(detail.outstanding)}</Text>
          </FormField>

          <FormField label="Date Received">
            {Platform.OS === "web" ? (
              // @ts-ignore native HTML date input
              <input aria-label="Date received" type="date" disabled={saving} value={payDate}
                onChange={(e: any) => setPayDate(e.target.value)}
                style={{
                  border: `1px solid ${colors.border}`, borderRadius: radius.md,
                  padding: "10px 12px", fontSize: 16,
                  backgroundColor: colors.surfaceSecondary, color: colors.onSurface,
                  fontFamily: "inherit", outline: "none", boxSizing: "border-box", height: 44,
                } as any}
              />
            ) : (
              <TextInput
                testID="pay-date"
                value={payDate}
                editable={!saving}
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
                    disabled={saving}
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
              editable={!saving}
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
