import { TILES_FLOOR_ID } from "@/src/constants/floors";
// frontend/src/components/tiles/CreateDispatchSheet.tsx
// "Create dispatch" straight from the Dispatch List — the tab used to be
// history-only, so raising a dispatch meant knowing to go find the right
// customer order first. Three steps, all inside one sheet:
//
//   1. pick the customer order        (only orders with dispatchable stock)
//   2. pick the brand + source pool   (Released or Godown)
//   3. enter quantity per line + transport details -> Confirm
//
// Confirm calls the exact same backend actions the Customer workspace
// uses (dispatch-from-released / dispatch-from-godown), so a dispatch
// raised here is identical in every way — Chalan, Register row, timeline.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import {
  tileOrdersApi,
  type CustomerOrderBrandGroup, type CustomerOrderCard, type CustomerOrderDetail,
} from "@/src/api/tileOrders";
import { toast } from "@/src/components/Toast";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { Button, ErrorState, SearchField, Sheet } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type Source = "released" | "godown";

const available = (item: { boxes_ready: number; boxes_godown: number }, source: Source) =>
  source === "released" ? item.boxes_ready : item.boxes_godown;

const qtyUnit = (item: { quantity_unit?: string }) => item.quantity_unit === "Pieces" ? "pieces" : "boxes";

function validateDispatchQuantities(
  qtyByItem: Record<string, string>,
  items: { po_item_id: string; tile_name: string; boxes_ready: number; boxes_godown: number; quantity_unit?: string }[],
  source: Source,
) {
  const entries: { po_item_id: string; qty: number }[] = [];
  const errors: Record<string, string> = {};

  for (const item of items.filter((candidate) => available(candidate, source) > 0)) {
    const raw = (qtyByItem[item.po_item_id] || "").trim();
    // Clearing a prefilled line deliberately leaves it out of this dispatch.
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) {
      errors[item.po_item_id] = "Enter a whole number.";
      continue;
    }
    const value = Number(raw);
    const max = available(item, source);
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors[item.po_item_id] = "Enter a positive whole number.";
    } else if (value > max) {
      errors[item.po_item_id] = `Only ${max} ${qtyUnit(item)} available.`;
    } else {
      entries.push({ po_item_id: item.po_item_id, qty: value });
    }
  }

  return { entries, errors, formError: entries.length === 0 && Object.keys(errors).length === 0 ? "Enter at least one quantity." : null };
}

export function CreateDispatchSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [orders, setOrders] = useState<CustomerOrderCard[] | null>(null);
  const [detail, setDetail] = useState<CustomerOrderDetail | null>(null);
  const [group, setGroup] = useState<CustomerOrderBrandGroup | null>(null);
  const [source, setSource] = useState<Source>("released");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [transport, setTransport] = useState({ vehicle_number: "", driver_name: "", receiver_name: "", reference_number: "", labor_cost: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const ordersRequest = useRef(0);
  const orderSelectionBusy = useRef(false);
  const submitBusy = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setCommittedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const loadOrders = useCallback(async (nextPage = 1) => {
    const request = ++ordersRequest.current;
    setOrdersLoading(true);
    setError(null);
    if (nextPage === 1) setOrders(null);
    try {
      const result = await tileOrdersApi.listCustomerOrders({ page: nextPage, page_size: 30, search: committedSearch || undefined });
      if (request !== ordersRequest.current) return;
      setOrders((current) => nextPage === 1 ? result.orders : [...(current || []), ...result.orders]);
      setPage(nextPage);
      setHasMore(result.has_more);
    } catch (e: any) {
      if (request === ordersRequest.current) setError(e?.detail || "Could not load orders");
    } finally {
      if (request === ordersRequest.current) setOrdersLoading(false);
    }
  }, [committedSearch]);

  useEffect(() => {
    void loadOrders();
    return () => { ordersRequest.current += 1; };
  }, [loadOrders]);

  const openOrder = useCallback(async (orderId: string) => {
    if (orderSelectionBusy.current) return;
    orderSelectionBusy.current = true;
    setBusy(true);
    try {
      setDetail(await tileOrdersApi.customerOrderDetail(orderId));
    } catch (e: any) {
      toast.error(e?.detail || "Could not load order");
    } finally {
      orderSelectionBusy.current = false;
      setBusy(false);
    }
  }, []);

  // A group is only worth offering if it actually has stock sitting in one
  // of the two dispatchable pools — otherwise the operator picks it and
  // finds an empty form.
  const dispatchableGroups = useMemo(
    () => (detail?.suppliers || []).filter((g) => g.items.some((i) => i.boxes_ready > 0 || i.boxes_godown > 0)),
    [detail],
  );

  const lines = useMemo(
    () => (group?.items || []).filter((item) => available(item, source) > 0),
    [group, source],
  );
  const quantityValidation = useMemo(
    () => validateDispatchQuantities(qty, group?.items || [], source),
    [qty, group, source],
  );

  const chooseGroup = (next: CustomerOrderBrandGroup) => {
    const preferred: Source = next.items.some((i) => i.boxes_ready > 0) ? "released" : "godown";
    setGroup(next);
    setSource(preferred);
    setQty(Object.fromEntries(
      next.items.filter((i) => available(i, preferred) > 0).map((i) => [i.po_item_id, String(available(i, preferred))]),
    ));
  };

  const switchSource = (next: Source) => {
    setSource(next);
    setQty(Object.fromEntries(
      (group?.items || []).filter((i) => available(i, next) > 0).map((i) => [i.po_item_id, String(available(i, next))]),
    ));
  };

  const confirm = async () => {
    if (!group || submitBusy.current) return;
    if (Object.keys(quantityValidation.errors).length || quantityValidation.formError) {
      toast.error("Fix the highlighted quantities before creating the dispatch");
      return;
    }
    const laborCost = Number(transport.labor_cost || 0);
    if (!Number.isFinite(laborCost) || laborCost < 0) {
      toast.error("Enter a valid labour cost");
      return;
    }
    const destination = {
      ...Object.fromEntries(Object.entries(transport).filter(([key, value]) => key !== "labor_cost" && value.trim() !== "")),
      ...(laborCost > 0 ? { labor_cost: laborCost } : {}),
    };
    submitBusy.current = true;
    setBusy(true);
    let chalanId: string | null = null;
    try {
      const call = source === "released" ? tileOrdersApi.dispatchFromReleased : tileOrdersApi.dispatchFromGodown;
      const result = await call(group.purchase_order_id, quantityValidation.entries, destination);
      chalanId = result.chalan?.id ?? null;
    } catch (e: any) {
      toast.error(e?.detail || "Could not create dispatch");
      submitBusy.current = false;
      setBusy(false);
      return;
    }
    // Dispatch + Chalan are committed at this point; opening the PDF is a
    // convenience that must never report the dispatch itself as failed.
    toast.success("Dispatch created — Chalan generated");
    submitBusy.current = false;
    setBusy(false);
    onCreated();
    onClose();
    if (chalanId) {
      try {
        await downloadApiFile(`/tile-orders/chalans/${chalanId}/pdf`, `Chalan-${chalanId}.pdf`, "Chalan PDF", TILES_FLOOR_ID);
      } catch {
        toast.error("Dispatch saved. Open the Chalan from the Dispatch List.");
      }
    }
  };

  const subtitle = !detail ? "Step 1 of 3 · choose the customer order"
    : !group ? "Step 2 of 3 · choose the brand and stock pool"
      : "Step 3 of 3 · quantities and transport";

  return (
    <Sheet visible onClose={onClose} title="Create dispatch" subtitle={subtitle} testID="tile-create-dispatch-sheet">
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {!detail ? <SearchField value={search} onChangeText={setSearch} onClear={() => setSearch("")} placeholder="Search by customer or order number" testID="tile-create-dispatch-search" /> : null}

        {!detail ? (
          error ? <ErrorState title="Orders unavailable" subtitle={error} onRetry={() => void loadOrders()} /> : orders === null ? <ActivityIndicator color={colors.brand} /> : orders.length === 0 ? (
            <Text style={type.bodyMuted}>{committedSearch ? "No orders match this search." : "No tile orders yet."}</Text>
          ) : orders.map((order) => (
            <Pressable
              testID={`tile-create-dispatch-order-${order.id}`} key={order.id}
              accessibilityRole="button" accessibilityLabel={`Select order ${order.number} for ${order.customer_name}`}
              disabled={busy} accessibilityState={{ disabled: busy, busy }}
              onPress={() => openOrder(order.id)} style={[styles.pickRow, busy && styles.disabled]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={type.bodyStrong}>{order.customer_name}</Text>
                <Text style={type.caption}>{order.number} · {order.brands.map((b) => b.brand_name).join(", ")}</Text>
              </View>
              <Text style={styles.pickAction}>Select →</Text>
            </Pressable>
          ))
        ) : !group ? (
          <>
            <Pressable testID="tile-create-dispatch-back-orders" onPress={() => setDetail(null)} style={styles.linkRow}>
              <Text style={styles.pickAction}>← Choose a different order</Text>
            </Pressable>
            <Text style={type.bodyStrong}>{detail.summary.customer_name} · {detail.summary.number}</Text>
            {dispatchableGroups.length === 0 ? (
              <Text style={type.bodyMuted}>
                Nothing is available to dispatch on this order yet — the brand has to release material first
                (Tile Orders → Brands → Release queue).
              </Text>
            ) : dispatchableGroups.map((candidate) => (
              <Pressable
                testID={`tile-create-dispatch-group-${candidate.purchase_order_id}`} key={candidate.purchase_order_id}
                onPress={() => chooseGroup(candidate)} style={styles.pickRow}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={type.bodyStrong}>{candidate.brand_name}</Text>
                  <Text style={type.caption}>
                    {candidate.items.reduce((t, i) => t + i.boxes_ready, 0)} released ·{" "}
                    {candidate.items.reduce((t, i) => t + i.boxes_godown, 0)} at Godown
                  </Text>
                </View>
                <Text style={styles.pickAction}>Select →</Text>
              </Pressable>
            ))}
          </>
        ) : (
          <>
            <Pressable testID="tile-create-dispatch-back-groups" onPress={() => setGroup(null)} style={styles.linkRow}>
              <Text style={styles.pickAction}>← Choose a different brand</Text>
            </Pressable>
            <Text style={type.bodyStrong}>{detail.summary.customer_name} · {group.brand_name}</Text>
            <View style={styles.sourceRow}>
              {(["released", "godown"] as Source[]).map((option) => {
                const total = group.items.reduce((t, i) => t + available(i, option), 0);
                return (
                  <Pressable
                    testID={`tile-create-dispatch-source-${option}`} key={option} disabled={total <= 0}
                    accessibilityRole="radio" accessibilityState={{ checked: source === option, disabled: total <= 0 }}
                    onPress={() => switchSource(option)}
                    style={[styles.chip, source === option ? styles.chipActive : null, total <= 0 ? styles.chipDisabled : null]}
                  >
                    <Text style={[type.captionStrong, source === option ? { color: colors.brandHover } : null]}>
                      {option === "released" ? "From Released" : "From Godown"} · {total}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {lines.length === 0 ? (
              <Text style={type.bodyMuted}>No quantity in this pool. Switch pool above.</Text>
            ) : lines.map((item) => (
              <View key={item.po_item_id} style={{ marginBottom: spacing.sm }}>
                <Text style={type.bodyStrong}>{item.tile_name}</Text>
                <Text style={type.bodyMuted}>{available(item, source)} {qtyUnit(item)} available</Text>
                <TextInput
                  testID={`tile-create-dispatch-qty-${item.po_item_id}`} keyboardType="number-pad"
                  value={qty[item.po_item_id] || ""}
                  onChangeText={(v) => setQty((s) => ({ ...s, [item.po_item_id]: v }))}
                  accessibilityLabel={`Dispatch quantity for ${item.tile_name} in ${qtyUnit(item)}`}
                  placeholder={qtyUnit(item)} placeholderTextColor={colors.onSurfaceSubtle} style={styles.input}
                />
                {quantityValidation.errors[item.po_item_id] ? (
                  <Text style={styles.inputError}>{quantityValidation.errors[item.po_item_id]}</Text>
                ) : null}
              </View>
            ))}
            {quantityValidation.formError ? <Text style={styles.inputError}>{quantityValidation.formError}</Text> : null}
            <Text style={[type.bodyStrong, { marginTop: spacing.xs }]}>Transport details</Text>
            {([ 
              ["vehicle_number", "Vehicle number"], ["driver_name", "Driver name"],
              ["receiver_name", "Received by"], ["reference_number", "Reference no."],
            ] as const).map(([key, label]) => (
              <TextInput
                testID={`tile-create-dispatch-${key.replace(/_/g, "-")}`} key={key}
                value={transport[key]} onChangeText={(v) => setTransport((t) => ({ ...t, [key]: v }))}
                accessibilityLabel={label}
                placeholder={label} placeholderTextColor={colors.onSurfaceSubtle} style={styles.input}
              />
            ))}
            <TextInput
              testID="tile-create-dispatch-labor-cost" keyboardType="decimal-pad"
              value={transport.labor_cost} onChangeText={(v) => setTransport((t) => ({ ...t, labor_cost: v }))}
              accessibilityLabel="Labour cost added to payment"
              placeholder="Labour cost (added to payment)" placeholderTextColor={colors.onSurfaceSubtle} style={styles.input}
            />
            <View style={styles.actionRow}>
              <Pressable
                accessibilityRole="button" accessibilityLabel="Create dispatch and Chalan"
                testID="tile-create-dispatch-confirm" disabled={busy || lines.length === 0 || Boolean(Object.keys(quantityValidation.errors).length || quantityValidation.formError)}
                onPress={confirm} style={[styles.primaryAction, busy || lines.length === 0 || Boolean(Object.keys(quantityValidation.errors).length || quantityValidation.formError) ? styles.disabled : null]}
              >
                <Text style={styles.primaryActionText}>{busy ? "Creating…" : "Create Dispatch + Chalan"}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={busy} testID="tile-create-dispatch-cancel" onPress={onClose} style={styles.outlineAction}>
                <Text style={styles.outlineActionText}>Cancel</Text>
              </Pressable>
            </View>
          </>
        )}
        {!detail && !error && orders && hasMore ? <Button label={ordersLoading ? "Loading orders…" : "Load more orders"} variant="secondary" disabled={ordersLoading || busy} onPress={() => void loadOrders(page + 1)} testID="tile-create-dispatch-load-more" /> : null}
        {!detail && busy ? <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}><ActivityIndicator color={colors.brand} /><Text style={type.bodyMuted}>Loading order details…</Text></View> : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.xs },
  pickRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 52,
    paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.sm, backgroundColor: colors.surfaceSecondary, marginBottom: spacing.xs,
  },
  linkRow: { minHeight: 44, justifyContent: "center" },
  pickAction: { ...type.captionStrong, color: colors.brand },
  sourceRow: { flexDirection: "row", gap: spacing.xs, marginVertical: spacing.sm, flexWrap: "wrap" },
  chip: {
    minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
  chipActive: { backgroundColor: colors.brandTint, borderColor: colors.brandBorder },
  chipDisabled: { opacity: 0.45 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, minHeight: 44, marginTop: 4, color: colors.onSurface },
  inputError: { ...type.caption, color: colors.errorFg, marginTop: 4 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.md },
  primaryAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, borderRadius: radius.sm, backgroundColor: colors.brand },
  primaryActionText: { ...type.bodyStrong, color: colors.onBrand },
  outlineAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.brandBorder },
  outlineActionText: { ...type.bodyStrong, color: colors.brandHover },
  disabled: { opacity: 0.6 },
});
