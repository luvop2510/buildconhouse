// Purchase Order Detail
// -----------------------------------------------------------------------------
// Tablet: two-pane (items + status | timeline & notes)
// Phone:  single scroll with sticky top action bar
//
// Actions:
//   * Change status (walks the ALLOWED_TRANSITIONS state machine)
//   * Receive items (per-line qty_received; auto-transitions status)
//   * Add internal note
//   * Add attachment (base64)
// -----------------------------------------------------------------------------
import Feather from "@expo/vector-icons/Feather";
import * as DocumentPicker from "expo-document-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActivityTimeline, TimelineEvent } from "@/src/components/ActivityTimeline";
import { useBp } from "@/src/design/responsive";
import { Badge, Button, Card, ErrorState, IconButton, LoadingState } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { api } from "@/src/api/client";
import { colors, money, radius, shadow, spacing, type } from "@/src/theme/tokens";
import {
  HistorySheet, MovableItem, MoveStageSheet, TransferSheet,
} from "@/src/components/purchases/MovementEngine";
import { useRoles } from "@/src/hooks/use-roles";
import { useAuth } from "@/src/state/auth";
import { downloadApiFile } from "@/src/utils/downloadFile";

type PoStatus =
  | "draft" | "awaiting_review" | "ordered" | "awaiting_supplier"
  | "partial_received" | "fully_received" | "packed" | "ready_for_dispatch" | "cancelled";

type PoItem = {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  image?: string | null;
  room?: string | null;
  qty: number;
  qty_received: number;
  unit_cost: number;
  finish?: string | null;
  stage?: string;
  loaned_qty?: number;
};

type ChalanStage = "released" | "at_godown" | "dispatched";
type ChalanOrderStage = "order" | "material_released" | "godown" | "dispatch" | "completed";

type ChalanLine = {
  po_item_id: string;
  name: string;
  size?: string | null;
  qty: number;
  unit: string;
};

function chalanQuantityUnit(unit: string): "Piece" | "Box" {
  return ["pcs", "pc", "piece", "pieces"].includes(unit.trim().toLowerCase()) ? "Piece" : "Box";
}

type Chalan = {
  id: string;
  number: string;
  created_at: string;
  created_by_name?: string | null;
  items: ChalanLine[];
  reference_number?: string | null;
  receiver_name?: string | null;
  sender_name?: string | null;
  request_key?: string | null;
  stage: ChalanStage;
  godown_received_at?: string | null;
  godown_received_by_name?: string | null;
  dispatched_at?: string | null;
  dispatched_by_name?: string | null;
  dispatch_note?: string | null;
};

type StatusEvent = {
  id: string;
  at: string;
  from_status: string | null;
  to_status: string;
  by_user_name: string;
  note?: string | null;
};

type Attachment = {
  id: string;
  at: string;
  by_user_name: string;
  filename: string;
  mime: string;
  data_url?: string | null;
  storage_key?: string | null;
  size_bytes: number;
  note?: string | null;
};

type PO = {
  id: string;
  number: string;
  quotation_id?: string | null;
  quotation_number?: string | null;
  customer_id: string;
  customer_name: string;
  customer_phone?: string | null;
  project_name?: string | null;
  brand_id?: string | null;
  brand_name?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  status: PoStatus;
  items: PoItem[];
  status_history: StatusEvent[];
  attachments: Attachment[];
  internal_notes?: string | null;
  expected_delivery_at?: string | null;
  subtotal: number;
  grand_total: number;
  created_at: string;
  created_by_name: string;
  stage: ChalanOrderStage;
  chalans: Chalan[];
  remaining_qty_by_item: Record<string, number>;
};

type StatusConfig = {
  columns: { value: PoStatus; label: string }[];
  transitions: Record<string, PoStatus[]>;
  labels: Record<string, string>;
};

const DEFAULT_STATUS_CONFIG: StatusConfig = {
  columns: [],
  transitions: {},
  labels: {
    draft: "Draft", awaiting_review: "Awaiting review", ordered: "Ordered", awaiting_supplier: "Awaiting supplier",
    partial_received: "Partially received", fully_received: "Fully received", packed: "Packed",
    ready_for_dispatch: "Ready for dispatch", cancelled: "Cancelled",
  },
};

const STATUS_TONE: Record<PoStatus, string> = {
  draft: colors.onSurfaceMuted,
  awaiting_review: colors.warning,
  ordered: colors.info,
  awaiting_supplier: colors.info,
  partial_received: colors.warning,
  fully_received: colors.success,
  packed: colors.success,
  ready_for_dispatch: colors.success,
  cancelled: colors.error,
};

const STAGE_LABELS: Record<string, string> = {
  po_final: "PO Final", order_in_company: "PO Final", company_billing: "Company Billing", in_box: "In Box",
  dispatched: "Dispatched", in_transit: "In Transit", delivered: "Delivered",
};
const STAGE_TONE: Record<string, { bg: string; fg: string }> = {
  po_final: { bg: colors.surfaceTertiary, fg: colors.onSurfaceMuted },
  order_in_company: { bg: colors.surfaceTertiary, fg: colors.onSurfaceMuted },
  company_billing: { bg: "#FEF3E2", fg: colors.warning },
  in_box: { bg: colors.surfaceTertiary, fg: colors.onSurfaceMuted },
  dispatched: { bg: "#FBF0DD", fg: "#8A6116" },
  in_transit: { bg: "#FBF0DD", fg: "#8A6116" },
  delivered: { bg: "#E8F5EA", fg: colors.success },
};

const CHALAN_STAGE_LABEL: Record<ChalanStage, string> = {
  released: "Released",
  at_godown: "At Godown",
  dispatched: "Dispatched",
};

const CHALAN_STAGE_BADGE: Record<ChalanStage, "info" | "warning" | "success"> = {
  released: "info",
  at_godown: "warning",
  dispatched: "success",
};

const CHALAN_ORDER_STAGE_LABEL: Record<ChalanOrderStage, string> = {
  order: "Awaiting material release",
  material_released: "Material released",
  godown: "At Godown",
  dispatch: "Partially dispatched",
  completed: "Fully dispatched",
};

type GenerateChalanPayload = {
  items: { po_item_id: string; qty: number }[];
  reference_number?: string;
  receiver_name?: string;
  sender_name?: string;
  transport?: string;
  remarks?: string;
};

type ChalanTransition = { kind: "godown" | "dispatch"; chalan: Chalan };

function apiErrorMessage(error: any, fallback: string): string {
  const detail = error?.detail;
  if (typeof detail !== "string" || !detail) return fallback;
  try {
    const parsed = JSON.parse(detail);
    return parsed?.message || parsed?.detail || detail;
  } catch {
    return detail;
  }
}

function generationKey(poId: string): string {
  return `sanitary-chalan:${poId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export default function PurchaseOrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { isPhone, isDesktop } = useBp();
  const { staff } = useAuth();
  const { roles, loading: rolesLoading, error: rolesError, refresh: refreshRoles } = useRoles();

  const [po, setPo] = useState<PO | null>(null);
  const [config, setConfig] = useState<StatusConfig | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesEditing, setNotesEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moveItem, setMoveItem] = useState<PoItem | null>(null);
  const [transferItem, setTransferItem] = useState<PoItem | null>(null);
  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
  const [chalanFormKey, setChalanFormKey] = useState<string | null>(null);
  const [chalanTransition, setChalanTransition] = useState<ChalanTransition | null>(null);
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<{ chalan: Chalan; message: string } | null>(null);

  const toMovable = useCallback((it: PoItem): MovableItem => ({
    item_id: it.id, sku: it.sku, name: it.name, image: it.image, qty: it.qty, loaned_qty: it.loaned_qty,
    stage: (it.stage as any) || "po_final",
    customer_id: po?.customer_id, customer_name: po?.customer_name,
    po_number: po?.number, brand_name: po?.brand_name, supplier_name: po?.supplier_name,
  }), [po]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      // The canonical order is the only blocking request. The legacy status
      // configuration and activity stream add controls/context, but must not
      // make a valid purchase order disappear when either is unavailable.
      const d = await api.get<PO>(`/purchases/${id}/order-detail`);
      const [configResult, timelineResult] = await Promise.allSettled([
        api.get<StatusConfig>("/purchase-orders/config/statuses"),
        api.get<TimelineEvent[]>(`/activity/purchase/${id}`),
      ]);
      const cfg = configResult.status === "fulfilled" ? configResult.value : DEFAULT_STATUS_CONFIG;
      const tl = timelineResult.status === "fulfilled" ? timelineResult.value : [];
      setPo(d);
      setConfig(cfg);
      setTimeline(tl);
      setNotesDraft(d.internal_notes || "");
      setRefreshError(null);
    } catch (e: any) {
      setLoadError(apiErrorMessage(e, "Could not load purchase order"));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const refreshPersistedOrder = useCallback(async (): Promise<PO | null> => {
    if (!id) return null;
    try {
      const fresh = await api.get<PO>(`/purchases/${id}/order-detail`);
      setPo(fresh);
      setRefreshError(null);
      api.get<TimelineEvent[]>(`/activity/purchase/${id}`).then(setTimeline).catch(() => {});
      return fresh;
    } catch (e: any) {
      setRefreshError(apiErrorMessage(e, "Latest persisted Chalan state could not be loaded"));
      return null;
    }
  }, [id]);

  const warehouseLevel = roles.find((role) => role.role === "warehouse")?.level;
  const staffLevel = roles.find((role) => role.role === staff?.role)?.level;
  const canManageChalans = warehouseLevel !== undefined && staffLevel !== undefined && staffLevel >= warehouseLevel;

  const applyGeneratedChalan = useCallback((chalan: Chalan, stage: ChalanOrderStage, items: GenerateChalanPayload["items"]) => {
    setPo((current) => {
      if (!current) return current;
      const exists = current.chalans.some((candidate) => candidate.id === chalan.id);
      const remaining = { ...current.remaining_qty_by_item };
      items.forEach((item) => {
        remaining[item.po_item_id] = Math.max(0, (remaining[item.po_item_id] || 0) - item.qty);
      });
      return {
        ...current,
        stage,
        chalans: exists ? current.chalans : [...current.chalans, chalan],
        remaining_qty_by_item: remaining,
      };
    });
  }, []);

  const generateChalan = useCallback(async (payload: GenerateChalanPayload, requestKey: string): Promise<string | null> => {
    if (!id) return "Purchase order is unavailable";
    try {
      const result = await api.post<{ chalan: Chalan; stage: ChalanOrderStage; idempotent?: boolean }>(
        `/purchases/${id}/chalans`,
        { ...payload, idempotency_key: requestKey },
      );
      applyGeneratedChalan(result.chalan, result.stage, payload.items);
      toast.success(result.idempotent ? "Chalan already generated" : "Chalan generated");
      setChalanFormKey(null);
      await refreshPersistedOrder();
      return null;
    } catch (e: any) {
      // A timed-out response may still have committed. Re-read the source of
      // truth and match the stable request key before offering a safe retry.
      const fresh = await refreshPersistedOrder();
      if (fresh?.chalans.some((chalan) => chalan.request_key === requestKey)) {
        toast.success("Chalan generated");
        setChalanFormKey(null);
        return null;
      }
      return apiErrorMessage(e, "Could not generate Chalan");
    }
  }, [applyGeneratedChalan, id, refreshPersistedOrder]);

  const runChalanTransition = useCallback(async (
    transition: ChalanTransition,
    dispatchNote?: string,
  ): Promise<string | null> => {
    if (!id) return "Purchase order is unavailable";
    const { chalan, kind } = transition;
    const targetStage: ChalanStage = kind === "godown" ? "at_godown" : "dispatched";
    const path = kind === "godown"
      ? `/purchases/${id}/chalans/${chalan.id}/godown-received`
      : `/purchases/${id}/chalans/${chalan.id}/dispatch`;
    try {
      const result = await api.post<{ stage: ChalanOrderStage }>(
        path,
        kind === "dispatch" ? { dispatch_note: dispatchNote || undefined } : undefined,
      );
      // The response means the transition is committed. Reflect only that
      // persisted acknowledgement while the canonical order is reloaded.
      setPo((current) => current ? {
        ...current,
        stage: result.stage,
        chalans: current.chalans.map((candidate) => candidate.id === chalan.id
          ? { ...candidate, stage: targetStage, dispatch_note: kind === "dispatch" ? dispatchNote : candidate.dispatch_note }
          : candidate),
      } : current);
      toast.success(kind === "godown" ? "Marked received at Godown" : "Chalan dispatched");
      setChalanTransition(null);
      await refreshPersistedOrder();
      return null;
    } catch (e: any) {
      // Both lifecycle routes are identity-addressed. If the write committed
      // but its response was lost, the persisted stage wins and no duplicate
      // action is presented to the operator.
      const fresh = await refreshPersistedOrder();
      const persisted = fresh?.chalans.find((candidate) => candidate.id === chalan.id);
      const reachedTarget = kind === "godown"
        ? persisted?.stage === "at_godown" || persisted?.stage === "dispatched"
        : persisted?.stage === "dispatched";
      if (reachedTarget) {
        toast.success(kind === "godown" ? "Marked received at Godown" : "Chalan dispatched");
        setChalanTransition(null);
        return null;
      }
      return apiErrorMessage(e, "Could not update Chalan");
    }
  }, [id, refreshPersistedOrder]);

  const downloadChalanPdf = useCallback(async (chalan: Chalan) => {
    if (!id || !po) return;
    setPdfBusyId(chalan.id);
    setPdfError(null);
    const stamp = new Date(chalan.created_at);
    const validStamp = !Number.isNaN(stamp.getTime());
    const date = validStamp
      ? `${String(stamp.getDate()).padStart(2, "0")}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${stamp.getFullYear()}`
      : "Chalan";
    const filename = `${chalan.number} ${po.customer_name} ${date}.pdf`;
    try {
      const opened = await downloadApiFile(`/purchases/${id}/chalans/${chalan.id}/pdf`, filename, "Chalan PDF");
      if (!opened) setPdfError({ chalan, message: "Could not download the Chalan PDF. You can retry safely." });
    } catch (e: any) {
      setPdfError({ chalan, message: apiErrorMessage(e, "Could not download the Chalan PDF") });
    } finally {
      setPdfBusyId(null);
    }
  }, [id, po]);

  const allowedNext = useMemo(
    () => (po && config ? (config.transitions[po.status] || []).filter((s) => s !== po.status) : []),
    [po, config],
  );

  const changeStatus = async (next: PoStatus, note?: string) => {
    if (!po) return;
    setBusy(true);
    try {
      await api.post(`/purchase-orders/${po.id}/status`, { to_status: next, note });
      toast.success(`Marked ${config?.labels[next] || next}`);
      await load();
    } catch (e: any) {
      toast.error(e?.detail || "Status change failed");
    } finally {
      setBusy(false);
      setStatusOpen(false);
    }
  };

  const receiveItems = async (receipts: Record<string, number>, note?: string) => {
    if (!po) return;
    setBusy(true);
    try {
      await api.post(`/purchase-orders/${po.id}/receive`, { receipts, note });
      toast.success("Receipts saved");
      await load();
    } catch (e: any) {
      toast.error(e?.detail || "Save failed");
    } finally {
      setBusy(false);
      setReceiveOpen(false);
    }
  };

  const saveNotes = async () => {
    if (!po) return;
    setBusy(true);
    try {
      await api.patch(`/purchase-orders/${po.id}`, { internal_notes: notesDraft });
      toast.success("Notes saved");
      setNotesEditing(false);
      await load();
    } catch (e: any) {
      toast.error(e?.detail || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const addAttachment = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: false, type: "*/*", copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      let dataUrl = "";
      if (Platform.OS === "web") {
        // On web, asset.uri is already a blob: URL or data URL. Fetch → base64.
        const blob = await (await fetch(asset.uri)).blob();
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } else {
        // Native: fetch → base64 via FileReader-equivalent
        const blob = await (await fetch(asset.uri)).blob();
        dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
      await api.post(`/purchase-orders/${id}/attachments`, {
        filename: asset.name,
        mime: asset.mimeType || "application/octet-stream",
        data_url: dataUrl,
      });
      toast.success("Attachment added");
      await load();
    } catch (e: any) {
      toast.error(e?.detail || "Could not attach");
    }
  };

  const openAttachment = async (a: Attachment) => {
    try {
      // New attachments store only a private-bucket key — mint a short-lived
      // signed URL on demand. Attachments written before this migration
      // still carry data_url directly; the endpoint returns that as-is too.
      const res = await api.get<{ url: string }>(`/purchase-orders/${id}/attachments/${a.id}/url`);
      if (Platform.OS === "web") window.open(res.url, "_blank");
      else await Linking.openURL(res.url);
    } catch (e: any) {
      toast.error(e?.detail || "Could not open attachment");
    }
  };

  if (loading && !po) {
    return (
      <SafeAreaView style={styles.centeredState} edges={isPhone ? [] : ["top"]}>
        <LoadingState label="Loading purchase order…" />
      </SafeAreaView>
    );
  }

  if (loadError || !po) {
    return (
      <SafeAreaView style={styles.centeredState} edges={isPhone ? [] : ["top"]}>
        <ErrorState title="Could not load purchase order" subtitle={loadError || "Purchase order not found"} onRetry={load} />
        <Button label="Back to Purchases" icon="arrow-left" variant="ghost" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }

  const statusConfig = config || DEFAULT_STATUS_CONFIG;
  // The admin rail consumes a substantial part of a tablet viewport. Keep
  // this page single-column until the actual desktop tier, rather than
  // squeezing two panes and their fixed value columns into the remainder.
  const wideDetail = isDesktop;
  const hasRemainingChalanQty = Object.values(po.remaining_qty_by_item || {}).some((qty) => qty > 1e-6);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <View style={[styles.topbar, isPhone && styles.topbarPhone]}>
        <Pressable testID="back-btn" onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Feather name="chevron-left" size={18} color={colors.onSurface} />
          <Text style={{ fontSize: 14, fontWeight: "500" }}>Purchases</Text>
        </Pressable>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {po.status !== "draft" && po.status !== "cancelled" && po.status !== "packed" && po.status !== "ready_for_dispatch" ? (
            <Button label="Receive" icon="package" variant="secondary" size="sm" onPress={() => setReceiveOpen(true)} testID="receive-btn" />
          ) : null}
          {allowedNext.length > 0 ? (
            <Button label="Change Status" icon="arrow-right" size="sm" onPress={() => setStatusOpen(true)} testID="status-btn" />
          ) : null}
        </View>
      </View>

      {refreshError ? (
        <View style={styles.refreshBanner} testID="sanitary-chalan-refresh-error">
          <Feather name="alert-triangle" size={15} color={colors.error} />
          <Text style={[type.bodySm, { color: colors.error, flex: 1 }]}>{refreshError}</Text>
          <Button label="Retry" size="sm" variant="secondary" onPress={() => refreshPersistedOrder()} testID="sanitary-chalan-refresh-retry" />
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={{
          padding: isPhone ? spacing.lg : spacing.xl,
          paddingBottom: isPhone ? 132 : spacing.xxl,
          gap: spacing.lg,
          flexDirection: wideDetail ? "row" : "column",
        }}
      >
        {/* Left / main column */}
        <View style={{ flex: wideDetail ? 1.6 : undefined, gap: spacing.lg, minWidth: 0 }}>
          <View>
            <Text style={[type.mono, { color: colors.onSurfaceMuted }]}>{po.number}</Text>
            <Text style={[type.displayLg, { marginTop: 4 }]} numberOfLines={2}>{po.customer_name}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8, alignItems: "center" }}>
              <View style={[styles.statusPill, { backgroundColor: STATUS_TONE[po.status] + "22", borderColor: STATUS_TONE[po.status] }]}>
                <View style={[styles.statusDot, { backgroundColor: STATUS_TONE[po.status] }]} />
                <Text style={{ fontSize: 12, fontWeight: "700", color: STATUS_TONE[po.status] }}>
                  {statusConfig.labels[po.status]}
                </Text>
              </View>
              {po.brand_name ? <Badge label={po.brand_name} tone="neutral" /> : null}
              {po.supplier_name ? (
                <Text style={type.caption} numberOfLines={1}>via {po.supplier_name}</Text>
              ) : (
                <Text style={[type.caption, { color: colors.warning }]}>No supplier</Text>
              )}
              {po.quotation_number ? (
                <Pressable onPress={() => router.push(`/(admin)/quotations/${po.quotation_id}` as any)}>
                  <Text style={[type.caption, { textDecorationLine: "underline" }]}>from {po.quotation_number}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          {/* Items table */}
          <Card style={{ padding: 0 }}>
            {isDesktop ? (
              <View style={styles.itemsHeader}>
                <Text style={[type.overline, { width: 40 }]}>#</Text>
                <Text style={[type.overline, { flex: 1 }]}>Item</Text>
                <Text style={[type.overline, { width: 70, textAlign: "right" }]}>QTY</Text>
                <Text style={[type.overline, { width: 90, textAlign: "right" }]}>RECD</Text>
                <Text style={[type.overline, { width: 90, textAlign: "right" }]}>COST</Text>
                <Text style={[type.overline, { width: 100, textAlign: "right" }]}>AMOUNT</Text>
              </View>
            ) : null}
            {po.items.map((it, i) => {
              const full = it.qty_received >= it.qty - 1e-6 && it.qty > 0;
              const partial = it.qty_received > 0 && !full;
              const stage = it.stage || "po_final";
              return (
                <View key={it.id} style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                  {isDesktop ? (
                    <View style={styles.itemRow}>
                      <Text style={[type.mono, { width: 40 }]}>{String(i + 1).padStart(2, "0")}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: "600" }} numberOfLines={2}>{it.name}</Text>
                        <Text style={type.caption} numberOfLines={1}>{it.sku}{it.room ? ` · ${it.room}` : ""}</Text>
                      </View>
                      <Text style={[type.mono, { width: 70, textAlign: "right" }]}>{it.qty}</Text>
                      <View style={{ width: 90, alignItems: "flex-end" }}>
                        <Text style={[type.mono, { fontWeight: "600", color: full ? colors.success : partial ? colors.warning : colors.onSurfaceMuted }]}>
                          {it.qty_received}
                        </Text>
                        {partial ? (
                          <Text style={[type.caption, { fontSize: 10 }]}>{Math.round((it.qty_received / it.qty) * 100)}%</Text>
                        ) : null}
                      </View>
                      <Text style={[type.mono, { width: 90, textAlign: "right" }]} numberOfLines={1}>{money(it.unit_cost)}</Text>
                      <Text style={[type.mono, { width: 100, textAlign: "right", fontWeight: "700" }]} numberOfLines={1}>
                        {money(it.qty * it.unit_cost)}
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.itemRowCompact}>
                      <Text style={[type.mono, { width: 28 }]}>{String(i + 1).padStart(2, "0")}</Text>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 13, fontWeight: "600" }} numberOfLines={2}>{it.name}</Text>
                        <Text style={type.caption} numberOfLines={1}>{it.sku}{it.room ? ` · ${it.room}` : ""}</Text>
                        <Text style={[type.caption, { marginTop: 2 }]}>
                          Qty {it.qty} · Recd{" "}
                          <Text style={{ fontWeight: "600", color: full ? colors.success : partial ? colors.warning : colors.onSurfaceMuted }}>
                            {it.qty_received}{partial ? ` (${Math.round((it.qty_received / it.qty) * 100)}%)` : ""}
                          </Text>
                          {" "}· {money(it.unit_cost)} ea
                        </Text>
                      </View>
                      <Text style={[type.mono, { fontWeight: "700", textAlign: "right" }]} numberOfLines={1}>
                        {money(it.qty * it.unit_cost)}
                      </Text>
                    </View>
                  )}
                  <View style={styles.itemActionsRow}>
                    <View style={[styles.stagePill, { backgroundColor: STAGE_TONE[stage]?.bg || colors.surfaceTertiary }]}>
                      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: STAGE_TONE[stage]?.fg || colors.onSurfaceMuted, marginRight: 5 }} />
                      <Text style={{ fontSize: 11, fontWeight: "600", color: STAGE_TONE[stage]?.fg || colors.onSurfaceMuted }}>
                        {STAGE_LABELS[stage] || stage}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", gap: 6, marginLeft: "auto" }}>
                      <Pressable testID={`po-item-history-${it.id}`} onPress={() => setHistoryItemId(it.id)} style={styles.itemActionBtn} hitSlop={6}>
                        <Feather name="clock" size={12} color={colors.onSurface} />
                      </Pressable>
                      <Pressable testID={`po-item-move-${it.id}`} onPress={() => setMoveItem(it)} style={styles.itemActionBtn} hitSlop={6}>
                        <Text style={{ fontSize: 11, fontWeight: "600", color: colors.onSurface }}>Move</Text>
                        <Feather name="chevron-down" size={10} color={colors.onSurfaceMuted} />
                      </Pressable>
                      {stage === "in_box" ? <Pressable testID={`po-item-transfer-${it.id}`} onPress={() => setTransferItem(it)} style={styles.itemActionBtn} hitSlop={6}>
                        <Feather name="repeat" size={12} color={colors.onSurface} />
                      </Pressable> : null}
                    </View>
                  </View>
                </View>
              );
            })}
            <View style={styles.itemsFooter}>
              <View style={{ flex: 1 }} />
              <View style={{ minWidth: 220, gap: 4 }}>
                <FooterRow label="Subtotal" value={money(po.subtotal)} />
                <View style={{ borderTopWidth: 1, borderColor: colors.onSurface, paddingTop: 8, marginTop: 4 }}>
                  <FooterRow label="Grand total" value={money(po.grand_total)} bold />
                </View>
              </View>
            </View>
          </Card>

          {/* Sanitary material release / Chalan lifecycle */}
          <Card testID="sanitary-chalan-section">
            <View style={styles.chalanHeader}>
              <View style={{ flex: 1, minWidth: 180 }}>
                <Text style={type.overline}>Sanitary Chalans</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <Badge
                    label={CHALAN_ORDER_STAGE_LABEL[po.stage] || po.stage}
                    tone={po.stage === "completed" ? "success" : po.stage === "order" ? "neutral" : "info"}
                    testID="sanitary-chalan-order-stage"
                  />
                  <Text style={type.caption}>
                    {po.chalans.length} Chalan{po.chalans.length === 1 ? "" : "s"}
                  </Text>
                </View>
              </View>
              {canManageChalans && hasRemainingChalanQty ? (
                <Button
                  label="Generate Chalan"
                  icon="file-plus"
                  size="sm"
                  onPress={() => setChalanFormKey(generationKey(po.id))}
                  testID="sanitary-generate-chalan"
                />
              ) : null}
            </View>

            {rolesLoading ? (
              <View style={styles.permissionState} testID="sanitary-chalan-permissions-loading">
                <ActivityIndicator size="small" color={colors.brand} />
                <Text style={type.caption}>Checking Chalan action permissions…</Text>
              </View>
            ) : rolesError ? (
              <View style={[styles.inlineNotice, { backgroundColor: colors.errorBg, borderColor: colors.errorBorder }]} testID="sanitary-chalan-permissions-error">
                <Text style={[type.bodySm, { color: colors.error, flex: 1 }]}>Could not confirm Chalan action permissions.</Text>
                <Button label="Retry" size="sm" variant="secondary" onPress={refreshRoles} testID="sanitary-chalan-permissions-retry" />
              </View>
            ) : !canManageChalans ? (
              <Text style={[type.caption, { marginTop: spacing.sm }]}>Your role has read-only access to Chalans.</Text>
            ) : !hasRemainingChalanQty ? (
              <Text style={[type.caption, { marginTop: spacing.sm }]}>All ordered quantities are covered by persisted Chalans.</Text>
            ) : null}

            {po.chalans.length === 0 ? (
              <View style={styles.chalanEmpty}>
                <Feather name="file-text" size={20} color={colors.onSurfaceMuted} />
                <Text style={type.bodyMuted}>No material has been released on a Chalan yet.</Text>
              </View>
            ) : (
              <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
                {po.chalans.slice().reverse().map((chalan) => (
                  <View key={chalan.id} style={styles.chalanCard} testID={`sanitary-chalan-${chalan.id}`}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.sm }}>
                      <View style={{ flex: 1 }}>
                        <Text style={type.titleMd}>{chalan.number}</Text>
                        <Text style={type.caption}>
                          {new Date(chalan.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                          {chalan.created_by_name ? ` · ${chalan.created_by_name}` : ""}
                        </Text>
                      </View>
                      <Badge label={CHALAN_STAGE_LABEL[chalan.stage]} tone={CHALAN_STAGE_BADGE[chalan.stage]} testID={`sanitary-chalan-stage-${chalan.id}`} />
                    </View>

                    <View style={styles.chalanLines}>
                      {chalan.items.map((line, index) => (
                        <View key={`${line.po_item_id}-${index}`} style={styles.chalanLine}>
                          <Text style={[type.bodySm, { flex: 1 }]} numberOfLines={2}>
                            {line.name}{line.size ? ` · ${line.size}` : ""}
                          </Text>
                          <Text style={[type.mono, { fontSize: 12 }]}>{line.qty} {chalanQuantityUnit(line.unit)}</Text>
                        </View>
                      ))}
                    </View>

                    {(chalan.reference_number || chalan.receiver_name || chalan.sender_name || chalan.dispatch_note) ? (
                      <View style={styles.chalanMeta}>
                        {chalan.reference_number ? <Text style={type.caption} numberOfLines={1}>Reference · {chalan.reference_number}</Text> : null}
                        {chalan.receiver_name ? <Text style={type.caption} numberOfLines={1}>Receiver · {chalan.receiver_name}</Text> : null}
                        {chalan.sender_name ? <Text style={type.caption} numberOfLines={1}>Supplier representative · {chalan.sender_name}</Text> : null}
                        {chalan.dispatch_note ? <Text style={type.caption} numberOfLines={2}>Dispatch note · {chalan.dispatch_note}</Text> : null}
                      </View>
                    ) : null}

                    <View style={styles.chalanActions}>
                      <Button
                        label="Download PDF"
                        icon="download"
                        variant="secondary"
                        size="sm"
                        loading={pdfBusyId === chalan.id}
                        disabled={pdfBusyId !== null && pdfBusyId !== chalan.id}
                        onPress={() => downloadChalanPdf(chalan)}
                        testID={`sanitary-chalan-download-${chalan.id}`}
                      />
                      {canManageChalans && chalan.stage === "released" ? (
                        <Button
                          label="Received at Godown"
                          icon="archive"
                          variant="secondary"
                          size="sm"
                          onPress={() => setChalanTransition({ kind: "godown", chalan })}
                          testID={`sanitary-chalan-godown-${chalan.id}`}
                        />
                      ) : null}
                      {canManageChalans && (chalan.stage === "released" || chalan.stage === "at_godown") ? (
                        <Button
                          label="Dispatch"
                          icon="truck"
                          size="sm"
                          onPress={() => setChalanTransition({ kind: "dispatch", chalan })}
                          testID={`sanitary-chalan-dispatch-${chalan.id}`}
                        />
                      ) : null}
                    </View>

                    {pdfError?.chalan.id === chalan.id ? (
                      <View style={[styles.inlineNotice, { backgroundColor: colors.errorBg, borderColor: colors.errorBorder }]} testID={`sanitary-chalan-download-error-${chalan.id}`}>
                        <Text style={[type.bodySm, { color: colors.error, flex: 1 }]}>{pdfError.message}</Text>
                        <Button label="Retry" size="sm" variant="secondary" onPress={() => downloadChalanPdf(pdfError.chalan)} />
                      </View>
                    ) : null}
                  </View>
                ))}
              </View>
            )}
          </Card>

          {/* Internal notes */}
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={type.overline}>Internal Notes</Text>
              {!notesEditing ? (
                <Pressable onPress={() => setNotesEditing(true)} hitSlop={8}>
                  <Feather name="edit-2" size={14} color={colors.onSurfaceMuted} />
                </Pressable>
              ) : null}
            </View>
            {notesEditing ? (
              <View style={{ gap: spacing.sm, marginTop: 8 }}>
                <TextInput
                  value={notesDraft}
                  onChangeText={setNotesDraft}
                  multiline
                  placeholder="Add internal notes (visible only to team)"
                  placeholderTextColor={colors.onSurfaceMuted}
                  style={styles.notesInput}
                  testID="notes-input"
                />
                <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
                  <Button label="Cancel" variant="ghost" size="sm" onPress={() => { setNotesEditing(false); setNotesDraft(po.internal_notes || ""); }} />
                  <Button label="Save" icon="check" size="sm" onPress={saveNotes} loading={busy} testID="save-notes" />
                </View>
              </View>
            ) : (
              <Text style={{ fontSize: 13, color: po.internal_notes ? colors.onSurface : colors.onSurfaceMuted, marginTop: 6 }}>
                {po.internal_notes || "No internal notes yet."}
              </Text>
            )}
          </Card>

          {/* Attachments */}
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm }}>
              <Text style={type.overline}>Attachments</Text>
              <Pressable onPress={addAttachment} style={styles.attachBtn}>
                <Feather name="paperclip" size={12} color={colors.onSurface} />
                <Text style={{ fontSize: 12, fontWeight: "600" }}>Attach</Text>
              </Pressable>
            </View>
            {po.attachments.length === 0 ? (
              <Text style={type.caption}>No attachments</Text>
            ) : (
              <View style={{ gap: 6 }}>
                {po.attachments.map((a) => (
                  <Pressable key={a.id} onPress={() => openAttachment(a)} style={styles.attachRow}>
                    <Feather name="file" size={14} color={colors.onSurfaceMuted} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: "500" }} numberOfLines={1}>{a.filename}</Text>
                      <Text style={type.caption}>{a.by_user_name} · {new Date(a.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</Text>
                    </View>
                    <Text style={type.caption}>{(a.size_bytes / 1024).toFixed(1)} KB</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </Card>
        </View>

        {/* Right column — status timeline + activity */}
        <View style={{ flex: wideDetail ? 1 : undefined, gap: spacing.lg, minWidth: 0 }}>
          <Card>
            <Text style={type.overline}>Status Timeline</Text>
            <View style={{ marginTop: spacing.md, gap: spacing.md }}>
              {po.status_history.slice().reverse().map((ev) => (
                <View key={ev.id} style={{ flexDirection: "row", gap: spacing.md }}>
                  <View style={[styles.statusMarker, { backgroundColor: STATUS_TONE[ev.to_status as PoStatus] || colors.onSurfaceMuted }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: "600" }}>
                      {statusConfig.labels[ev.to_status] || ev.to_status}
                      {ev.from_status ? (
                        <Text style={type.caption}> · from {statusConfig.labels[ev.from_status] || ev.from_status}</Text>
                      ) : null}
                    </Text>
                    <Text style={type.caption}>
                      {ev.by_user_name} · {new Date(ev.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </Text>
                    {ev.note ? <Text style={[type.body, { fontSize: 12, marginTop: 2, color: colors.onSurfaceSecondary }]}>“{ev.note}”</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          </Card>

          <Card>
            <Text style={type.overline}>Activity</Text>
            <View style={{ marginTop: spacing.md }}>
              <ActivityTimeline events={timeline} emptyLabel="No activity yet" dense />
            </View>
          </Card>
        </View>
      </ScrollView>

      {/* Modals */}
      <StatusModal
        visible={statusOpen}
        onClose={() => setStatusOpen(false)}
        current={po.status}
        allowed={allowedNext}
        labels={statusConfig.labels}
        busy={busy}
        onConfirm={changeStatus}
      />
      <ReceiveModal
        visible={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        items={po.items}
        busy={busy}
        onConfirm={receiveItems}
      />
      <MoveStageSheet
        visible={!!moveItem}
        item={moveItem ? toMovable(moveItem) : null}
        onClose={() => setMoveItem(null)}
        onMoved={async () => { await load(); }}
      />
      <TransferSheet
        visible={!!transferItem}
        item={transferItem ? toMovable(transferItem) : null}
        onClose={() => setTransferItem(null)}
        onSuccess={async () => { await load(); }}
      />
      <HistorySheet
        visible={!!historyItemId}
        itemId={historyItemId}
        onClose={() => setHistoryItemId(null)}
      />
      {chalanFormKey ? (
        <GenerateChalanModal
          po={po}
          requestKey={chalanFormKey}
          onClose={() => setChalanFormKey(null)}
          onSubmit={generateChalan}
        />
      ) : null}
      {chalanTransition ? (
        <ChalanTransitionModal
          transition={chalanTransition}
          onClose={() => setChalanTransition(null)}
          onSubmit={runChalanTransition}
        />
      ) : null}
    </SafeAreaView>
  );
}

// -----------------------------------------------------------------------------
// StatusModal — pick from ALLOWED_TRANSITIONS with an optional note
// -----------------------------------------------------------------------------
function StatusModal({
  visible, onClose, current, allowed, labels, busy, onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  current: PoStatus;
  allowed: PoStatus[];
  labels: Record<string, string>;
  busy: boolean;
  onConfirm: (next: PoStatus, note?: string) => void;
}) {
  const [next, setNext] = useState<PoStatus | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => { if (visible) { setNext(null); setNote(""); } }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable onPress={onClose} style={styles.modalScrim}>
          <Pressable onPress={() => {}} style={styles.modalCard}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={type.titleMd}>Change status</Text>
              <IconButton icon="x" size={30} onPress={onClose} />
            </View>
            <Text style={[type.caption, { marginTop: 4 }]}>Current · {labels[current]}</Text>
            <View style={{ gap: 8, marginTop: spacing.md }}>
              {allowed.map((s) => (
                <Pressable
                  key={s}
                  testID={`status-opt-${s}`}
                  onPress={() => setNext(s)}
                  style={[styles.optionRow, next === s && { borderColor: colors.brand, backgroundColor: colors.brandTint }]}
                >
                  <View style={[styles.statusDot, { backgroundColor: STATUS_TONE[s] }]} />
                  <Text style={{ fontSize: 14, fontWeight: "600", flex: 1 }}>{labels[s]}</Text>
                  {next === s ? <Feather name="check" size={16} color={colors.brand} /> : null}
                </Pressable>
              ))}
            </View>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Add a note (optional)"
              placeholderTextColor={colors.onSurfaceMuted}
              style={[styles.notesInput, { minHeight: 60, marginTop: spacing.md }]}
              multiline
            />
            <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end", marginTop: spacing.md }}>
              <Button label="Cancel" variant="ghost" onPress={onClose} />
              <Button
                label="Confirm"
                icon="check"
                onPress={() => next && onConfirm(next, note || undefined)}
                disabled={!next}
                loading={busy}
                testID="confirm-status"
              />
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// -----------------------------------------------------------------------------
// ReceiveModal — per-line qty_received input
// -----------------------------------------------------------------------------
function ReceiveModal({
  visible, onClose, items, busy, onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  items: PoItem[];
  busy: boolean;
  onConfirm: (r: Record<string, number>, note?: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  useEffect(() => {
    if (visible) {
      const d: Record<string, string> = {};
      items.forEach((it) => { d[it.id] = String(it.qty_received); });
      setDraft(d);
      setNote("");
    }
  }, [visible, items]);

  const setAllFull = () => {
    const d: Record<string, string> = {};
    items.forEach((it) => { d[it.id] = String(it.qty); });
    setDraft(d);
  };

  const submit = () => {
    const payload: Record<string, number> = {};
    for (const it of items) {
      const n = parseFloat(draft[it.id] || "0");
      if (Number.isFinite(n) && Math.abs(n - it.qty_received) > 1e-6) payload[it.id] = n;
    }
    onConfirm(payload, note || undefined);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable onPress={onClose} style={styles.modalScrim}>
          <Pressable onPress={() => {}} style={[styles.modalCard, { maxHeight: "90%" }]}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={type.titleMd}>Record receipts</Text>
              <IconButton icon="x" size={30} onPress={onClose} />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
              <Text style={type.caption}>Enter quantities received per line item</Text>
              <Pressable onPress={setAllFull} hitSlop={8}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: colors.brand }}>Mark all full</Text>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 360, marginTop: spacing.md }} contentContainerStyle={{ gap: spacing.sm }} keyboardShouldPersistTaps="handled">
              {items.map((it) => (
                <View key={it.id} style={styles.receiveRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{it.name}</Text>
                    <Text style={type.caption}>{it.sku} · ordered {it.qty}</Text>
                  </View>
                  <TextInput
                    value={draft[it.id] ?? "0"}
                    onChangeText={(v) => setDraft((d) => ({ ...d, [it.id]: v.replace(/[^0-9.]/g, "") }))}
                    keyboardType="numeric"
                    style={styles.qtyInput}
                    testID={`recv-${it.sku}`}
                  />
                  <Text style={type.caption}>of {it.qty}</Text>
                </View>
              ))}
            </ScrollView>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Note (e.g. invoice #, courier)"
              placeholderTextColor={colors.onSurfaceMuted}
              style={[styles.notesInput, { minHeight: 50, marginTop: spacing.md }]}
              multiline
            />
            <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end", marginTop: spacing.md }}>
              <Button label="Cancel" variant="ghost" onPress={onClose} />
              <Button label="Save receipts" icon="package" onPress={submit} loading={busy} testID="confirm-receive" />
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function GenerateChalanModal({
  po, requestKey, onClose, onSubmit,
}: {
  po: PO;
  requestKey: string;
  onClose: () => void;
  onSubmit: (payload: GenerateChalanPayload, requestKey: string) => Promise<string | null>;
}) {
  const releasable = po.items.filter((item) => (po.remaining_qty_by_item[item.id] || 0) > 1e-6);
  const [qtyById, setQtyById] = useState<Record<string, string>>(() => Object.fromEntries(
    releasable.map((item) => [item.id, String(po.remaining_qty_by_item[item.id])]),
  ));
  const [referenceNumber, setReferenceNumber] = useState("");
  const [receiverName, setReceiverName] = useState("");
  const [senderName, setSenderName] = useState("");
  const [transport, setTransport] = useState("");
  const [remarks, setRemarks] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const entries = releasable.map((item) => ({
      po_item_id: item.id,
      qty: Number(qtyById[item.id] || 0),
      maximum: po.remaining_qty_by_item[item.id] || 0,
      name: item.name,
    })).filter((entry) => entry.qty > 0);
    if (entries.length === 0) {
      setError("Enter a quantity for at least one item.");
      return;
    }
    const invalid = entries.find((entry) => !Number.isFinite(entry.qty) || entry.qty > entry.maximum + 1e-6);
    if (invalid) {
      setError(`${invalid.name} has only ${invalid.maximum} remaining to release.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    const message = await onSubmit({
      items: entries.map(({ po_item_id, qty }) => ({ po_item_id, qty })),
      reference_number: referenceNumber.trim() || undefined,
      receiver_name: receiverName.trim() || undefined,
      sender_name: senderName.trim() || undefined,
      transport: transport.trim() || undefined,
      remarks: remarks.trim() || undefined,
    }, requestKey);
    setSubmitting(false);
    if (message) setError(message);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={() => { if (!submitting) onClose(); }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.sheetScrim}>
          <View style={styles.chalanSheet} testID="sanitary-generate-chalan-modal">
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <Text style={type.titleLg}>Generate Chalan</Text>
                <Text style={type.bodyMuted}>Release all or part of the remaining sanitary material.</Text>
              </View>
              <IconButton icon="x" size={34} disabled={submitting} onPress={onClose} accessibilityLabel="Close generate Chalan form" />
            </View>

            <ScrollView style={{ maxHeight: 430, marginTop: spacing.md }} contentContainerStyle={{ gap: spacing.md }} keyboardShouldPersistTaps="handled">
              {releasable.map((item) => (
                <View key={item.id} style={styles.chalanFormItem}>
                  <View style={{ flex: 1, minWidth: 150 }}>
                    <Text style={type.bodyStrong}>{item.name}</Text>
                    <Text style={type.caption}>
                      {[item.sku, item.finish].filter(Boolean).join(" · ")} · {po.remaining_qty_by_item[item.id]} remaining
                    </Text>
                  </View>
                  <TextInput
                    value={qtyById[item.id] || ""}
                    onChangeText={(value) => setQtyById((current) => ({ ...current, [item.id]: value.replace(/[^0-9.]/g, "") }))}
                    keyboardType="numeric"
                    style={styles.chalanQtyInput}
                    testID={`sanitary-chalan-qty-${item.id}`}
                    accessibilityLabel={`Quantity for ${item.name}`}
                  />
                </View>
              ))}

              <View style={styles.chalanFieldGrid}>
                <ChalanTextField label="Reference number" placeholder="Optional" value={referenceNumber} onChangeText={setReferenceNumber} testID="sanitary-chalan-reference" />
                <ChalanTextField label="Receiver name" placeholder="Site contact" value={receiverName} onChangeText={setReceiverName} testID="sanitary-chalan-receiver" />
                <ChalanTextField label="Supplier representative" placeholder="Sender name" value={senderName} onChangeText={setSenderName} testID="sanitary-chalan-sender" />
                <ChalanTextField label="Transport" placeholder="Transport details" value={transport} onChangeText={setTransport} testID="sanitary-chalan-transport" />
                <ChalanTextField label="Remarks" placeholder="Optional remarks" value={remarks} onChangeText={setRemarks} testID="sanitary-chalan-remarks" />
              </View>

              {error ? (
                <View style={[styles.inlineNotice, { backgroundColor: colors.errorBg, borderColor: colors.errorBorder }]} testID="sanitary-generate-chalan-error">
                  <Feather name="alert-triangle" size={14} color={colors.error} />
                  <Text style={[type.bodySm, { color: colors.error, flex: 1 }]}>{error}</Text>
                </View>
              ) : null}
            </ScrollView>

            <View style={styles.sheetActions}>
              <Button label="Cancel" variant="ghost" disabled={submitting} onPress={onClose} />
              <Button
                label={error ? "Retry Generate" : "Generate Chalan"}
                icon="file-plus"
                loading={submitting}
                onPress={submit}
                testID="sanitary-generate-chalan-confirm"
              />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ChalanTextField({
  label, placeholder, value, onChangeText, testID,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChangeText: (value: string) => void;
  testID: string;
}) {
  return (
    <View style={{ flex: 1, minWidth: 180 }}>
      <Text style={type.caption}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.onSurfaceMuted}
        style={styles.chalanTextInput}
        testID={testID}
      />
    </View>
  );
}

function ChalanTransitionModal({
  transition, onClose, onSubmit,
}: {
  transition: ChalanTransition;
  onClose: () => void;
  onSubmit: (transition: ChalanTransition, dispatchNote?: string) => Promise<string | null>;
}) {
  const [dispatchNote, setDispatchNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDispatch = transition.kind === "dispatch";

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const message = await onSubmit(transition, dispatchNote.trim() || undefined);
    setSubmitting(false);
    if (message) setError(message);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (!submitting) onClose(); }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={styles.modalScrim} onPress={() => { if (!submitting) onClose(); }}>
          <Pressable style={styles.modalCard} onPress={() => {}} testID="sanitary-chalan-transition-modal">
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={type.titleMd}>{isDispatch ? "Dispatch Chalan" : "Confirm Godown receipt"}</Text>
              <IconButton icon="x" size={30} disabled={submitting} onPress={onClose} />
            </View>
            <Text style={[type.bodyMuted, { marginTop: spacing.xs }]}>
              {isDispatch
                ? `${transition.chalan.number} will be marked dispatched from ${transition.chalan.stage === "at_godown" ? "the Godown" : "the supplier"}.`
                : `${transition.chalan.number} will move from Released to At Godown.`}
            </Text>
            {isDispatch ? (
              <TextInput
                value={dispatchNote}
                onChangeText={setDispatchNote}
                placeholder="Dispatch note (optional)"
                placeholderTextColor={colors.onSurfaceMuted}
                multiline
                style={[styles.notesInput, { minHeight: 64, marginTop: spacing.md }]}
                testID="sanitary-chalan-dispatch-note"
              />
            ) : null}
            {error ? (
              <View style={[styles.inlineNotice, { backgroundColor: colors.errorBg, borderColor: colors.errorBorder, marginTop: spacing.md }]} testID="sanitary-chalan-transition-error">
                <Feather name="alert-triangle" size={14} color={colors.error} />
                <Text style={[type.bodySm, { color: colors.error, flex: 1 }]}>{error}</Text>
              </View>
            ) : null}
            <View style={styles.sheetActions}>
              <Button label="Cancel" variant="ghost" disabled={submitting} onPress={onClose} />
              <Button
                label={error ? "Retry" : isDispatch ? "Confirm Dispatch" : "Confirm Receipt"}
                icon={isDispatch ? "truck" : "archive"}
                loading={submitting}
                onPress={submit}
                testID="sanitary-chalan-transition-confirm"
              />
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function FooterRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.sm }}>
      <Text style={bold ? { fontSize: 14, fontWeight: "700" } : type.bodyMuted} numberOfLines={1}>{label}</Text>
      <Text style={[type.mono, bold && { fontSize: 16, fontWeight: "700" }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centeredState: {
    flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", padding: spacing.lg,
  },
  topbar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: spacing.lg, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  topbarPhone: {
    alignItems: "flex-start",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  refreshBanner: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    backgroundColor: colors.errorBg, borderBottomWidth: 1, borderBottomColor: colors.errorBorder,
  },
  statusPill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, borderWidth: 1,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  itemsHeader: {
    flexDirection: "row", padding: spacing.md, backgroundColor: colors.surfaceTertiary,
    borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, alignItems: "center",
  },
  itemRow: { flexDirection: "row", padding: spacing.md, alignItems: "center", gap: 8, flexWrap: "wrap" },
  itemRowCompact: { flexDirection: "row", padding: spacing.md, alignItems: "flex-start", gap: 8 },
  itemActionsRow: {
    flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6,
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm, marginTop: -4,
  },
  stagePill: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
  },
  itemActionBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 5, borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  itemsFooter: {
    flexDirection: "row", padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surfaceTertiary,
    borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md,
  },
  chalanHeader: {
    flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.md,
  },
  permissionState: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm,
  },
  inlineNotice: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.sm,
  },
  chalanEmpty: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
  },
  chalanCard: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: spacing.md, backgroundColor: colors.surface, gap: spacing.sm,
  },
  chalanLines: {
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.sm,
  },
  chalanLine: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  chalanMeta: { gap: 2 },
  chalanActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  sheetScrim: { flex: 1, backgroundColor: colors.overlay, justifyContent: "flex-end" },
  chalanSheet: {
    backgroundColor: colors.surfaceSecondary, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: spacing.xl, maxHeight: "90%", ...shadow.lifted,
  },
  chalanFormItem: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    padding: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    borderRadius: radius.md, backgroundColor: colors.surface,
  },
  chalanQtyInput: {
    width: 84, textAlign: "right", fontVariant: ["tabular-nums"],
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    padding: 9, fontSize: 14, color: colors.onSurface, backgroundColor: colors.surface,
  },
  chalanFieldGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chalanTextInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    padding: 10, marginTop: 3, fontSize: 14, color: colors.onSurface, backgroundColor: colors.surface,
  },
  sheetActions: {
    flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.lg,
  },
  notesInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 10, fontSize: 14, backgroundColor: colors.surface, minHeight: 80,
    textAlignVertical: "top", color: colors.onSurface,
  },
  attachBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  attachRow: {
    flexDirection: "row", gap: 8, alignItems: "center",
    padding: spacing.sm, borderRadius: radius.sm,
    backgroundColor: colors.surfaceTertiary,
  },
  statusMarker: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  modalScrim: { flex: 1, backgroundColor: colors.overlay, justifyContent: "center", alignItems: "center", padding: spacing.lg },
  modalCard: {
    width: "100%", maxWidth: 480,
    backgroundColor: colors.surfaceSecondary, borderRadius: radius.md,
    padding: spacing.lg, ...shadow.lifted,
  },
  optionRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  receiveRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: 10, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  qtyInput: {
    width: 70, textAlign: "right", fontVariant: ["tabular-nums"],
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    padding: 8, fontSize: 14, color: colors.onSurface, backgroundColor: colors.surface,
  },
});
