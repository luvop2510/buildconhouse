// Purchases — the ONE Movement Engine.
// -----------------------------------------------------------------------------
// Every surface that can move a purchased item forward (Purchases tracker,
// Purchase Order detail, Customer Purchase Workspace, Catalog product detail)
// shares these three sheets instead of re-implementing move/transfer/history
// logic locally. Backed by:
//   POST /purchases/items/{id}/move       — full OR partial ("3 of 20") move
//   POST /purchases/items/{id}/transfer   — to an existing OR brand-new customer
//   GET  /purchases/items/{id}            — full movement history + lineage
// -----------------------------------------------------------------------------
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { ProductImage } from "@/src/components/ProductImage";
import { Button, Field, Input, Sheet, Txt } from "@/src/design/components";
import { color as ds, radius, space } from "@/src/design/tokens";
import { api, ApiError, getRequestFloorId } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { PRODUCT_IMAGE_ASPECT_RATIO } from "@/src/theme/tokens";

// -----------------------------------------------------------------------------
// Shared types
// -----------------------------------------------------------------------------
export type TrackerStage =
  | "po_final" | "order_in_company" | "company_billing" | "in_box" | "dispatched";

export type StageMeta = {
  key: TrackerStage;
  label: string;
  count?: number;
  tone?: { bg: string; fg: string };
};

export type MovableItem = {
  item_id: string;
  sku: string;
  name: string;
  image?: string | null;
  qty: number;
  loaned_qty?: number;
  loan_replenishment_promised_qty?: number;
  loan_replenishment_returned_qty?: number;
  loan_replenishment_for_customer_name?: string | null;
  loan_replenishment_status?: string | null;
  stage: TrackerStage;
  customer_id?: string | null;
  customer_name?: string | null;
  po_number?: string | null;
  brand_name?: string | null;
  supplier_name?: string | null;
};

export const STAGE_TONE: Record<TrackerStage, { bg: string; fg: string }> = {
  order_in_company: { bg: ds.warnTint, fg: ds.warn },
  po_final:         { bg: ds.sunken, fg: ds.inkMid },
  company_billing:  { bg: ds.warnTint, fg: ds.warn },
  in_box:           { bg: ds.sunken, fg: ds.inkMid },
  dispatched:       { bg: ds.brassTint, fg: ds.brassDeep },

};

const STAGE_ICON: Record<string, keyof typeof Feather.glyphMap> = {
  po_final: "box", order_in_company: "shopping-cart", company_billing: "file-text", in_box: "archive",
  dispatched: "truck", in_transit: "navigation", delivered: "check-circle",
  create: "plus-circle", move: "arrow-right", transfer_in: "log-in",
  transfer_out: "log-out", split_in: "git-branch", split_out: "git-commit",
};

let _stagesCache: StageMeta[] | null = null;
export async function fetchStages(force = false): Promise<StageMeta[]> {
  if (_stagesCache && !force) return _stagesCache;
  const s = await api.get<StageMeta[]>("/purchases/stages");
  _stagesCache = s;
  return s;
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "2-digit", hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch { return "—"; }
}

export function Thumb({ image, size = 40 }: { image?: string | null; size?: number }) {
  return (
    <ProductImage
      source={image}
      fallbackLabel="SKU"
      contentFit="contain"
      disableSkeleton
      borderRadius={8}
      style={{ width: size, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO }}
    />
  );
}

function StageDot({ stage }: { stage: string }) {
  const t = STAGE_TONE[stage as TrackerStage] || { bg: ds.sunken, fg: ds.inkMid };
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.fg }} />;
}

// -----------------------------------------------------------------------------
// MoveStageSheet — move all or PART of a line to another stage.
// -----------------------------------------------------------------------------
export function MoveStageSheet({
  visible, item, onClose, onMoved,
}: {
  visible: boolean;
  item: MovableItem | null;
  onClose: () => void;
  onMoved: (result: any) => void | Promise<void>;
}) {
  const router = useRouter();
  const [stages, setStages] = useState<StageMeta[]>([]);
  const [target, setTarget] = useState<TrackerStage | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [moveError, setMoveError] = useState("");
  const moveCommand = useRef<{ fingerprint: string; key: string; pending: boolean } | null>(null);
  const returnRequest = useRef<{ controller: AbortController; generation: number } | null>(null);
  const returnGeneration = useRef(0);
  const openingItem = useRef(item);
  openingItem.current = item;
  const itemId = item?.item_id;

  useEffect(() => {
    returnGeneration.current += 1;
    returnRequest.current?.controller.abort();
    returnRequest.current = null;
    const initialItem = openingItem.current;
    if (!visible || !initialItem) return;
    moveCommand.current = null;
    setBusy(false);
    setMoveError("");
    setTarget(null);
    const reserved = Math.max(0, (initialItem.loan_replenishment_promised_qty || 0) - (initialItem.loan_replenishment_returned_qty || 0));
    const legacyMixed = initialItem.stage === "in_box" && !!initialItem.loan_replenishment_for_customer_name && reserved < initialItem.qty;
    setQty(String(Math.max(0, initialItem.qty - (initialItem.loaned_qty || 0) - (legacyMixed ? reserved : 0))));
    setNote("");
    let live = true;
    fetchStages().then(rows => { if (live) setStages(rows); }).catch(() => {});
    return () => { live = false; moveCommand.current = null; returnGeneration.current += 1; returnRequest.current?.controller.abort(); returnRequest.current = null; };
  // Same-row refreshes retain the draft and its retry identity.
  }, [visible, itemId]);

  if (!item) return null;

  const n = Number(qty || "0");
  const isPartial = n > 0 && n < item.qty - 1e-6;
  const returnObligation = !!item.loan_replenishment_for_customer_name && item.loan_replenishment_status !== "returned";
  const returnQty = Math.min(item.qty, Math.max(0, (item.loan_replenishment_promised_qty || item.qty) - (item.loan_replenishment_returned_qty || 0)));
  const mixedReplacement = returnObligation && item.stage === "in_box" && returnQty < item.qty - 1e-6;
  const returningReplacement = returnObligation && item.stage === "in_box" && !mixedReplacement;
  const moveAvailable = Math.max(0, item.qty - (item.loaned_qty || 0));
  const body = { stage: target, qty: n, note: note || undefined };
  const fingerprint = JSON.stringify([item.item_id, body]);
  const replaying = moveCommand.current?.fingerprint === fingerprint;
  // A refresh may show the reduced source quantity after a response was lost.
  // Let its original command resolve; the server checks the receipt first.
  const valid = !!target && Number.isFinite(n) && n > 0 && (replaying || (n <= moveAvailable + 1e-6
    && (!returnObligation || ["po_final", "order_in_company", "company_billing", "in_box"].includes(target) || n <= item.qty - Math.max(0, (item.loan_replenishment_promised_qty || 0) - (item.loan_replenishment_returned_qty || 0)))));

  const submit = async () => {
    if (!valid || !target || moveCommand.current?.pending) return;
    if (moveCommand.current?.fingerprint !== fingerprint) moveCommand.current = { fingerprint, key: randomUUID(), pending: false };
    const command = moveCommand.current;
    command.pending = true;
    setMoveError("");
    setBusy(true);
    try {
      const r = await api.post<any>(`/purchases/items/${item.item_id}/move`, {
        ...body, idempotency_key: command.key,
      });
      if (moveCommand.current !== command) return;
      moveCommand.current = null;
      const label = stages.find((s) => s.key === target)?.label || target;
      toast.success(r?.split ? `Moved ${r.qty_moved} of ${item.qty} to ${label}` : `Moved to ${label}`);
      onClose();
      try {
        await onMoved(r);
      } catch {
        toast.error("Stage moved, but the list could not refresh");
      }
    } catch (e: any) {
      if (moveCommand.current === command) setMoveError(e instanceof ApiError ? e.detail || e.message : "Move could not be confirmed. Retry the unchanged form to check the same movement.");
    } finally { command.pending = false; if (moveCommand.current === command || moveCommand.current === null) setBusy(false); }
  };

  const returnReplacement = async () => {
    if (busy || returnRequest.current) return;
    const command = { controller: new AbortController(), generation: returnGeneration.current };
    returnRequest.current = command;
    setBusy(true);
    setMoveError("");
    const floorId = await getRequestFloorId();
    const current = async () => returnRequest.current === command && command.generation === returnGeneration.current
      && !command.controller.signal.aborted && await getRequestFloorId() === floorId;
    try {
      if (!floorId || !await current()) return;
      const result = await api.post(`/purchases/items/${item.item_id}/return-loans`, {}, { floorId, signal: command.controller.signal });
      if (!await current()) return;
      toast.success("Reserved products returned to the original customer’s In Box");
      onClose();
      await onMoved(result);
    } catch (error: any) {
      if (await current()) setMoveError(error instanceof ApiError ? error.detail || error.message : "Return could not be confirmed. Retry to check the same return.");
    } finally {
      if (returnRequest.current === command) { returnRequest.current = null; setBusy(false); }
    }
  };

  const moveToGodown = async () => {
    if (!n || n <= 0 || n > item.qty + 1e-6) return;
    setBusy(true);
    try {
      // The tracker detail owns the parent PO id; resolve it here rather than
      // trusting a stale row after a split/move.  The stock intake endpoint
      // then performs the conditional source-quantity update and records
      // customer/PO provenance atomically with the new lot.
      const detail = await api.get<{ po_id: string }>(`/purchases/items/${item.item_id}`);
      const lot = await api.post<{ id: string }>("/godown-stock/intakes", {
        purchase_order_id: detail.po_id,
        purchase_item_id: item.item_id,
        qty: n,
        reason: note.trim() || "Customer declined / cancelled item",
      });
      toast.success(`${n} × ${item.name} moved to godown stock`);
      onClose();
      router.push(`/(admin)/godown-stock?newStockId=${encodeURIComponent(lot.id)}` as any);
      try {
        await onMoved({ moved_to_godown: true, qty_moved: n });
      } catch {
        toast.error("Stock moved, but the list could not refresh");
      }
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.detail || e.message : "Could not move item to godown stock");
    } finally { setBusy(false); }
  };

  return (
    <Sheet open={visible} onClose={() => { if (!busy) onClose(); }} title={returnObligation ? "Replacement for customer loan" : "Move stage"} width={440}
      footer={
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button label="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
          <Button
            label={returningReplacement ? `Return to ${item.loan_replenishment_for_customer_name}` : isPartial ? `Move ${n || 0} of ${item.qty}` : "Move"}
            icon="arrow-right" onPress={returningReplacement ? returnReplacement : submit} loading={busy} disabled={!returningReplacement && !valid}
            testID="movement-move-submit"
          />
        </View>
      }
    >
      <View style={{ gap: space.x5 }}>
        {moveError ? <Text accessibilityRole="alert" testID="movement-move-error" style={{ color: ds.ink, fontSize: 14, lineHeight: 21 }}>{moveError}</Text> : null}
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Thumb image={item.image} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt v="heading" numberOfLines={1}>{item.name}</Txt>
            <Txt v="caption" tone="mid" numberOfLines={1}>
              {item.sku}{item.customer_name ? ` · ${item.customer_name}` : ""}
            </Txt>
          </View>
        </View>

        {!returningReplacement ? <><View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Field label="Current stage">
              <View style={{
                flexDirection: "row", alignItems: "center", gap: 8, height: 44,
                borderRadius: radius.md, paddingHorizontal: 14, backgroundColor: ds.sunken,
              }}>
                <StageDot stage={item.stage} />
                <Txt v="body">{stages.find((s) => s.key === item.stage)?.label || item.stage}</Txt>
              </View>
            </Field>
          </View>
          <View style={{ width: 130 }}>
            <Field label="Qty to move" helper={`of ${moveAvailable} available`}>
              <Input
                testID="movement-qty"
                value={qty}
                onChangeText={(v) => setQty(v.replace(/[^0-9.]/g, ""))}
                keyboardType="numeric"
                style={{ textAlign: "center", fontWeight: "700" }}
                right={n !== item.qty ? (
                  <Pressable onPress={() => setQty(String(moveAvailable))} hitSlop={8}>
                    <Txt v="caption" tone="brass">All</Txt>
                  </Pressable>
                ) : null}
              />
            </Field>
          </View>
        </View>

        </> : null}
        {returnObligation ? <Txt v="caption" tone="mid">{Math.min(item.qty, Math.max(0, (item.loan_replenishment_promised_qty || item.qty) - (item.loan_replenishment_returned_qty || 0)))} reserved units go back to {item.loan_replenishment_for_customer_name}. {returningReplacement ? "Use Return to send it to their In Box." : "Move the replacement to In Box, then return it."}</Txt> : null}
        {mixedReplacement ? <Button label={`Return ${returnQty} reserved units to ${item.loan_replenishment_for_customer_name}`} onPress={returnReplacement} loading={busy} testID="movement-return-reserved" /> : null}
        {!returningReplacement ? <><Field label="Move to stage">
          <View style={{ gap: 4 }}>
            {stages.filter((s) => !returnObligation || mixedReplacement || ["po_final", "order_in_company", "company_billing", "in_box"].includes(s.key)).map((s) => {
              const disabled = s.key === item.stage && !isPartial;
              const on = target === s.key;
              return (
                <Pressable
                  key={s.key}
                  testID={`movement-stage-${s.key}`}
                  onPress={() => !disabled && setTarget(s.key)}
                  style={({ pressed, hovered }: any) => [
                    {
                      flexDirection: "row", alignItems: "center", gap: 10,
                      paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: on ? ds.brass : ds.line,
                      backgroundColor: on ? ds.brassTint : (pressed || hovered) ? ds.sunken : "transparent",
                      opacity: disabled ? 0.4 : 1,
                    },
                  ]}
                >
                  <StageDot stage={s.key} />
                  <Text style={{ fontSize: 14, color: ds.ink, flex: 1 }}>{s.label}</Text>
                  {s.key === item.stage ? <Txt v="caption" tone="soft">current</Txt> : null}
                  {on ? <Feather name="check" size={15} color={ds.brassDeep} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Field>

        {!returnObligation ? <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Move ${item.name} to godown stock`}
          testID="movement-godown-submit"
          disabled={!n || n <= 0 || n > item.qty + 1e-6 || busy}
          onPress={moveToGodown}
          style={({ pressed }) => [{
            minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: ds.brass,
            paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 9,
            backgroundColor: pressed ? ds.brassTint : "transparent",
            opacity: (!n || n <= 0 || n > item.qty + 1e-6 || busy) ? 0.45 : 1,
          }]}
        >
          <Feather name="archive" size={16} color={ds.brassDeep} />
          <View style={{ flex: 1 }}><Txt v="body" tone="brass">Move to godown stock</Txt><Txt v="caption" tone="soft">Keep the product available for a future customer instead of ordering it again.</Txt></View>
        </Pressable> : null}
        </> : null}

        <Field label="Note (optional)">
          <TextInput
            testID="movement-note"
            value={note}
            onChangeText={setNote}
            placeholder="e.g. courier name, invoice #…"
            placeholderTextColor={ds.inkFaint}
            multiline
            style={{
              minHeight: 56, borderRadius: radius.md, borderWidth: 1, borderColor: ds.line,
              padding: 10, fontSize: 14, color: ds.ink,
              ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : {}),
            }}
          />
        </Field>

        {!returningReplacement && isPartial ? (
          <View style={{
            flexDirection: "row", gap: 8, alignItems: "flex-start",
            backgroundColor: ds.sunken, padding: 10, borderRadius: radius.md,
          }}>
            <Feather name="info" size={13} color={ds.inkMid} style={{ marginTop: 1 }} />
            <Txt v="caption" tone="mid" style={{ flex: 1 }}>
              This splits the line — {n} unit{n === 1 ? "" : "s"} move to the new stage, the remaining{" "}
              {Math.max(0, item.qty - n)} stay{item.qty - n === 1 ? "s" : ""} at {stages.find((s) => s.key === item.stage)?.label}.
            </Txt>
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// TransferSheet — Existing Customer OR Create New Customer, same dialog.
// -----------------------------------------------------------------------------
type CustomerLite = { id: string; name: string; company?: string | null };

export function TransferSheet({
  visible, item, onClose, onSuccess,
}: {
  visible: boolean;
  item: MovableItem | null;
  onClose: () => void;
  onSuccess: (result: any) => void | Promise<void>;
}) {
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [pick, setPick] = useState("");
  const [custSearch, setCustSearch] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [commandKey, setCommandKey] = useState("");

  useEffect(() => {
    if (!visible || !item) return;
    setPick(""); setCustSearch("");
    setQty(String(Math.max(0, item.qty - (item.loaned_qty || 0)))); setReason("");
    setCommandKey(`transfer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    api.get<CustomerLite[]>(`/purchases/items/${item.item_id}/eligible-recipients`).then((list) => {
      setCustomers((list || []).filter((c) => c.id !== item.customer_id));
    }).catch(() => {});
  }, [visible, item]);

  const filteredCustomers = useMemo(() => {
    const term = custSearch.trim().toLowerCase();
    if (!term) return customers;
    return customers.filter((c) => (c.company || c.name || "").toLowerCase().includes(term));
  }, [customers, custSearch]);

  if (!item) return null;
  const n = Number(qty || "0");
  const transferAvailable = Math.max(0, item.qty - (item.loaned_qty || 0));

  const submit = async () => {
    if (item.stage !== "in_box") { toast.error("Products can be transferred only from In Box"); return; }
    if (!pick) { toast.error("Pick a customer who already ordered this product"); return; }
    if (!n || n <= 0 || n > transferAvailable + 1e-6) { toast.error(`Enter a qty up to ${transferAvailable}`); return; }
    setBusy(true);
    try {
      const payload = { destination_customer_id: pick, qty: n, reason: reason || undefined, idempotency_key: commandKey };
      const r = await api.post<{ destination: { po_number: string; customer_name: string } }>(
        `/purchases/items/${item.item_id}/transfer`,
        payload,
      );
      toast.success(`Transfer recorded for ${r.destination?.customer_name || customers.find((customer) => customer.id === pick)?.name || "customer"}`);
      onClose();
      try {
        await onSuccess(r);
      } catch {
        toast.error("Transfer recorded, but the list could not refresh");
      }
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.detail || e.message : "Transfer failed");
    } finally { setBusy(false); }
  };

  return (
    <Sheet open={visible} onClose={onClose} title="Transfer to another customer" width={460}
      footer={
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Record transfer" icon="repeat" onPress={submit} loading={busy} disabled={item.stage !== "in_box" || transferAvailable <= 0 || !pick} testID="movement-transfer-submit" />
        </View>
      }
    >
      <View style={{ gap: space.x5 }}>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Thumb image={item.image} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt v="heading" numberOfLines={1}>{item.name}</Txt>
            <Txt v="caption" tone="mid" numberOfLines={1}>
              {item.sku} · from {item.customer_name || "—"}
            </Txt>
          </View>
          <View style={{ width: 90 }}>
            <Field label="Qty">
              <Input
                testID="transfer-qty"
                value={qty} onChangeText={(v) => setQty(v.replace(/[^0-9.]/g, ""))}
                keyboardType="numeric" style={{ textAlign: "center", fontWeight: "700" }}
              />
            </Field>
          </View>
        </View>
        <Txt v="caption" tone="soft">Available to lend: {transferAvailable} of {item.qty} · transfer allowed only in In Box</Txt>

        <Txt v="caption" tone="mid">Only customers with this product in PO Final can receive it.</Txt>
          <View style={{ gap: 8 }}>
            <Input
              testID="transfer-customer-search"
              placeholder="Search customers…"
              value={custSearch}
              onChangeText={setCustSearch}
              left={<Feather name="search" size={14} color={ds.inkFaint} />}
            />
            <ScrollView style={{ maxHeight: 200, borderWidth: 1, borderColor: ds.line, borderRadius: radius.md }}>
              {filteredCustomers.length === 0 ? (
                <View style={{ padding: 14 }}><Txt v="caption" tone="soft">No matching customer orders found</Txt></View>
              ) : filteredCustomers.map((c) => (
                <Pressable
                  key={c.id}
                  testID={`transfer-pick-${c.id}`}
                  onPress={() => setPick(c.id)}
                  style={({ hovered }: any) => [
                    {
                      flexDirection: "row", alignItems: "center", gap: 6,
                      paddingHorizontal: 12, paddingVertical: 10,
                      backgroundColor: pick === c.id ? ds.brassTint : hovered ? ds.sunken : "transparent",
                    },
                  ]}
                >
                  <Text style={{ fontSize: 13, color: ds.ink, flex: 1 }} numberOfLines={1}>{c.company || c.name}</Text>
                  {pick === c.id ? <Feather name="check" size={14} color={ds.brassDeep} /> : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>

        <Field label="Reason (optional)">
          <TextInput
            testID="transfer-reason"
            value={reason} onChangeText={setReason}
            placeholder="Enter reason for transfer…"
            placeholderTextColor={ds.inkFaint}
            multiline
            style={{
              minHeight: 50, borderRadius: radius.md, borderWidth: 1, borderColor: ds.line,
              padding: 10, fontSize: 14, color: ds.ink,
              ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : {}),
            }}
          />
        </Field>

        <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start", backgroundColor: ds.sunken, padding: 10, borderRadius: radius.md }}>
          <Feather name="info" size={12} color={ds.inkMid} style={{ marginTop: 1 }} />
          <Txt v="caption" tone="mid" style={{ flex: 1 }}>
            The original customer&apos;s order and quantity remain in place. Both customers see the transfer and the return due when the ordered product arrives. Existing payments stay unchanged.
          </Txt>
        </View>
      </View>
    </Sheet>
  );
}

// -----------------------------------------------------------------------------
// HistorySheet — full movement/transfer/split lineage for one item.
// -----------------------------------------------------------------------------
type HistoryEvent = {
  id: string; at: string; from_stage?: string | null; to_stage: string;
  by_user_name: string; note?: string | null; action: string; qty?: number | null;
};

export function HistorySheet({
  visible, itemId, onClose,
}: { visible: boolean; itemId: string | null; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [row, setRow] = useState<any | null>(null);

  useEffect(() => {
    if (!visible || !itemId) return;
    setLoading(true);
    api.get<any>(`/purchases/items/${itemId}`)
      .then(setRow)
      .catch(() => toast.error("Could not load history"))
      .finally(() => setLoading(false));
  }, [visible, itemId]);

  const history: HistoryEvent[] = useMemo(
    () => (row?.stage_history || []).slice().reverse(),
    [row],
  );

  return (
    <Sheet open={visible} onClose={onClose} title="Movement history" width={440}>
      {loading || !row ? (
        <View style={{ paddingVertical: 30, alignItems: "center" }}><ActivityIndicator /></View>
      ) : (
        <View style={{ gap: space.x5 }}>
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <Thumb image={row.image} size={44} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Txt v="heading" numberOfLines={1}>{row.name}</Txt>
              <Txt v="caption" tone="mid" numberOfLines={1}>{row.sku} · {row.po_number}</Txt>
            </View>
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <MetaChip icon="user" label={row.customer_name} />
            <MetaChip icon="tag" label={row.brand_name} />
            {row.supplier_name ? <MetaChip icon="truck" label={row.supplier_name} /> : null}
            <MetaChip icon="hash" label={`Qty ${row.qty}`} />
          </View>

          {row.split_from_item_id ? (
            <LineageNote icon="git-branch" text="This piece was split off from another line." />
          ) : null}
          {row.transferred_from_item_id ? (
            <LineageNote icon="log-in" text={`Transferred in from a previous customer's order.`} />
          ) : null}

          <View style={{ gap: 0 }}>
            {history.length === 0 ? (
              <Txt v="caption" tone="soft">No stage changes recorded yet.</Txt>
            ) : history.map((ev, i) => (
              <View key={ev.id} style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ alignItems: "center" }}>
                  <View style={{
                    width: 26, height: 26, borderRadius: 13, backgroundColor: ds.sunken,
                    alignItems: "center", justifyContent: "center",
                  }}>
                    <Feather name={STAGE_ICON[ev.action] || "circle"} size={12} color={ds.inkMid} />
                  </View>
                  {i < history.length - 1 ? <View style={{ width: 1, flex: 1, backgroundColor: ds.line, marginVertical: 2 }} /> : null}
                </View>
                <View style={{ flex: 1, paddingBottom: space.x5 }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: ds.ink }}>
                    {STAGE_LABEL_HINT(ev)}
                  </Text>
                  <Txt v="caption" tone="soft">{ev.by_user_name} · {fmtDateTime(ev.at)}</Txt>
                  {ev.note ? <Txt v="caption" tone="mid" style={{ marginTop: 2 }}>“{ev.note}”</Txt> : null}
                </View>
              </View>
            ))}
          </View>
        </View>
      )}
    </Sheet>
  );
}

function STAGE_LABEL_HINT(ev: HistoryEvent): string {
  const from = ev.from_stage ? LABEL(ev.from_stage) : null;
  const to = LABEL(ev.to_stage);
  if (ev.action === "split_out") return `Split ${ev.qty ?? ""} unit(s) out → ${to}`;
  if (ev.action === "split_in") return `Received ${ev.qty ?? ""} unit(s) via split${from ? ` · now ${to}` : ""}`;
  if (ev.action === "transfer_in") return `Transferred in · ${to}`;
  if (ev.action === "transfer_out") return `Transferred out`;
  if (ev.action === "create") return `Created · ${to}`;
  return from ? `${from} → ${to}` : to;
}
function LABEL(stage: string): string {
  const map: Record<string, string> = {
    po_final: "PO Final", order_in_company: "Order in Company", company_billing: "Company Billing", in_box: "Inbox",
    dispatched: "Dispatched", in_transit: "In Transit", delivered: "Delivered",
  };
  return map[stage] || stage;
}

function MetaChip({ icon, label }: { icon: keyof typeof Feather.glyphMap; label?: string | null }) {
  if (!label) return null;
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 5,
      paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, backgroundColor: ds.sunken,
    }}>
      <Feather name={icon} size={11} color={ds.inkMid} />
      <Text style={{ fontSize: 11.5, color: ds.inkMid, fontWeight: "600" }} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function LineageNote({ icon, text }: { icon: keyof typeof Feather.glyphMap; text: string }) {
  return (
    <View style={{
      flexDirection: "row", gap: 8, alignItems: "flex-start",
      backgroundColor: ds.brassTint, padding: 10, borderRadius: radius.md,
    }}>
      <Feather name={icon} size={13} color={ds.brassDeep} style={{ marginTop: 1 }} />
      <Txt v="caption" tone="brass" style={{ flex: 1 }}>{text}</Txt>
    </View>
  );
}
