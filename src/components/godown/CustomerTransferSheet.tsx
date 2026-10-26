import Feather from "@expo/vector-icons/Feather";
import { useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import {
  getPoFinalMatches, transferGodownStockToCustomer,
  type CustomerStockTransfer, type CustomerTransferInput, type GodownLot, type PoFinalMatch,
} from "@/src/api/godownStock";
import { toast } from "@/src/components/Toast";
import { Sheet } from "@/src/design/components";
import { useBp } from "@/src/design/responsive";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";

type Customer = { id: string; name: string; company?: string | null };

export function CustomerTransferSheet({ lot, initialMatch, onClose, onTransferred }: {
  lot: GodownLot | null;
  initialMatch?: PoFinalMatch | null;
  onClose: () => void;
  onTransferred: () => void | Promise<void>;
}) {
  const { isPhone } = useBp();
  const { selectedFloorId } = useFloorAccess();
  const { staff } = useAuth();
  const context = lot && selectedFloorId ? JSON.stringify([staff?.id, selectedFloorId, lot.id]) : "";
  const currentContext = useRef(context); currentContext.current = context;
  const generation = useRef(0);
  // Keep an unresolved command when this mounted sheet closes and reopens.
  // A retry must resolve that transfer before another command can consume stock.
  const commands = useRef(new Map<string, { body: CustomerTransferInput; pending: boolean; uncertain: boolean; recorded?: CustomerStockTransfer }>());
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [matches, setMatches] = useState<PoFinalMatch[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [purchaseItemId, setPurchaseItemId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [discountPct, setDiscountPct] = useState("0");
  const [loadError, setLoadError] = useState("");
  const [reloadCount, setReloadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [recorded, setRecorded] = useState<CustomerStockTransfer | null>(null);
  const [draftContext, setDraftContext] = useState("");
  const activeCommandKey = useRef("");
  const opening = useRef({ lot, initialMatch }); opening.current = { lot, initialMatch };
  useEffect(() => () => { currentContext.current = ""; generation.current += 1; }, []);

  useEffect(() => {
    const lot = opening.current.lot, initialMatch = opening.current.initialMatch;
    generation.current += 1;
    setDraftContext(context); activeCommandKey.current = "";
    setBusy(false); setSubmitError(""); setLoadError(""); setRecorded(null);
    if (!context || !lot) return;
    const saved = commands.current.get(context);
    setUncertain(!!saved?.uncertain);
    setRecorded(saved?.recorded || null);
    if (saved?.uncertain || saved?.recorded) {
      activeCommandKey.current = saved.body.idempotency_key;
      setBusy(saved.pending);
      const body = saved.body;
      setMode(body.new_customer ? "new" : "existing");
      setCustomerId(body.recipient_customer_id || ""); setPurchaseItemId(body.recipient_purchase_item_id || "");
      setName(body.new_customer?.name || ""); setPhone(body.new_customer?.phone || ""); setEmail(body.new_customer?.email || "");
      setQty(String(body.qty)); setUnitPrice(body.unit_price == null ? "" : String(body.unit_price));
      setDiscountPct(String(body.discount_pct ?? 0)); setReason(body.reason || "");
      setSubmitError(saved.recorded ? "A transfer is already recorded. Review it below before starting another." : "The previous transfer has not been confirmed. Retry the same transfer to check its result.");
      return;
    }
    setMode("existing");
    setCustomerId(initialMatch?.customer_id || "");
    setPurchaseItemId(initialMatch?.purchase_item_id || "");
    setCustomerSearch(""); setName(""); setPhone(""); setEmail(""); setReason("");
    setUnitPrice(lot.unit_price == null ? "" : String(lot.unit_price)); setDiscountPct("0"); setLoadError("");
    const freeQty = lot.transferable_qty ?? Math.max(0, lot.available_qty - (lot.loaned_out_qty || 0));
    setQty(String(Math.min(freeQty, initialMatch?.remaining_qty ?? freeQty)));
    setMatches(initialMatch ? [initialMatch] : []);
  }, [context]);

  useEffect(() => {
    if (!context || !lot || !selectedFloorId) return;
    if (commands.current.get(context)?.recorded) { setLoading(false); return; }
    let live = true;
    setLoading(true);
    setLoadError("");
    setCustomers([]); setMatches(initialMatch ? [initialMatch] : []);
    Promise.all([
      api.get<Customer[]>("/customers", { floorId: selectedFloorId }),
      getPoFinalMatches(lot.id, selectedFloorId),
    ]).then(([nextCustomers, nextMatches]) => {
      if (!live) return;
      setCustomers(nextCustomers || []);
      setMatches(nextMatches.matches || []);
    }).catch((error: any) => {
      if (live) setLoadError(error?.detail || "Could not load customers and PO Final matches");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  // Retrying metadata must not reset the transfer draft or command identity.
  // Same-lot refreshes likewise retain the open form.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, reloadCount]);

  const filteredCustomers = useMemo(() => customers.filter((customer) => {
    const label = `${customer.name} ${customer.company || ""}`.toLowerCase();
    return customer.id !== lot?.source_customer_id && label.includes(customerSearch.trim().toLowerCase());
  }), [customers, customerSearch, lot?.source_customer_id]);
  const customerMatches = matches.filter((match) => match.customer_id === customerId);
  const selectedMatch = matches.find((match) => match.purchase_item_id === purchaseItemId);
  const amount = Number(qty);
  const freeQty = lot ? lot.transferable_qty ?? Math.max(0, lot.available_qty - (lot.loaned_out_qty || 0)) : 0;
  const maxQty = Math.min(freeQty, selectedMatch?.remaining_qty ?? Infinity);
  const validQty = Number.isFinite(amount) && amount > 0 && amount <= maxQty;
  const priceAmount = Number(unitPrice);
  const discountAmount = Number(discountPct);
  const validPrice = unitPrice.trim() !== "" && Number.isFinite(priceAmount) && priceAmount >= 0 && discountPct.trim() !== "" && Number.isFinite(discountAmount) && discountAmount >= 0 && discountAmount <= 100;
  const canSubmit = Boolean(lot && context && draftContext === context && !recorded && (uncertain || (validQty && validPrice && (mode === "new" ? name.trim() : customerId))) && !busy && (uncertain || (!loading && !loadError)));
  const locked = busy || uncertain || !!recorded;
  const netUnitPrice = validPrice ? priceAmount * (1 - discountAmount / 100) : 0;

  const submit = async () => {
    if (!lot || !canSubmit || !selectedFloorId || currentContext.current !== context || commands.current.get(context)?.pending || commands.current.get(context)?.recorded) return;
    const requestContext = context, requestGeneration = generation.current;
    let command = commands.current.get(context);
    if (!command?.uncertain) command = { pending: false, uncertain: false, body: {
      qty: amount,
      ...(mode === "new" ? { new_customer: { name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined } }
        : { recipient_customer_id: customerId, recipient_purchase_item_id: purchaseItemId || undefined }),
      reason: reason.trim() || undefined, idempotency_key: command?.body.idempotency_key || randomUUID(), unit_price: priceAmount, discount_pct: discountAmount,
    } };
    commands.current.set(context, command);
    activeCommandKey.current = command.body.idempotency_key;
    const isCurrent = () => currentContext.current === requestContext && (generation.current === requestGeneration || activeCommandKey.current === command.body.idempotency_key);
    command.pending = true; command.uncertain = true;
    setBusy(true);
    setSubmitError("");
    try {
      const response = await transferGodownStockToCustomer(lot.id, command.body, selectedFloorId);
      commands.current.delete(requestContext);
      if (!isCurrent()) return;
      setUncertain(false);
      toast.success(`${amount} ${amount === 1 ? "unit" : "units"} transferred to ${response.recipient_customer_name || name || customers.find((customer) => customer.id === customerId)?.name || "customer"} and added to In Box`);
      // Close on the confirmed write, not after an unrelated list-read deadline.
      // The list owns its inline refresh/retry state while keeping drafts mounted.
      const refresh = Promise.resolve().then(onTransferred);
      onClose();
      try { await refresh; }
      catch { if (isCurrent()) toast.error("Transfer recorded. Stock could not be refreshed; refresh the stock list before another transfer."); }
    } catch (error: any) {
      const status = error?.status;
      const conflict = error?.payload?.detail;
      if (["godown_transfer_already_recorded", "godown_transfer_record_removed"].includes(conflict?.code) && conflict.transfer?.stock_id === lot.id && conflict.transfer?.floor_id === selectedFloorId) {
        command.uncertain = false; command.recorded = conflict.transfer;
        if (isCurrent()) { setUncertain(false); setRecorded(conflict.transfer); setSubmitError(conflict.message); }
        return;
      }
      command.uncertain = !status || status === 408 || status === 429 || status >= 500;
      // A definitive rejection permits correction, but retains the same key:
      // a concurrently completed original must reject a changed request.
      if (isCurrent()) {
        setUncertain(command.uncertain);
        setSubmitError(error?.detail || "Could not confirm the transfer. Retry to check its result.");
      }
    } finally { command.pending = false; if (isCurrent()) setBusy(false); }
  };

  const acknowledgeRecorded = async () => {
    if (!recorded || !context || currentContext.current !== context || commands.current.get(context)?.recorded?.id !== recorded.id) return;
    commands.current.delete(context); setRecorded(null); setUncertain(false); setSubmitError("");
    const refresh = Promise.resolve().then(onTransferred);
    onClose();
    try { await refresh; } catch { /* The stock screen exposes its refresh failure inline. */ }
  };

  return <Sheet open={!!lot} dismissable={!busy} onClose={() => { if (!commands.current.get(context)?.pending) onClose(); }} title="Transfer stock to customer" width={540}
    footer={<View style={{ flexDirection: isPhone ? "column-reverse" : "row", gap: spacing.sm, justifyContent: "flex-end" }}>
      <Pressable accessibilityRole="button" onPress={onClose} disabled={busy} style={[button(false), isPhone && { width: "100%" }]}><Text style={buttonText(false)}>Cancel</Text></Pressable>
      {recorded ? <Pressable accessibilityRole="button" accessibilityLabel="Acknowledge recorded stock transfer" onPress={() => void acknowledgeRecorded()} style={[button(true), isPhone && { width: "100%" }]}><Text style={buttonText(true)}>Acknowledge recorded transfer</Text></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel="Confirm customer stock transfer" testID="godown-customer-transfer-submit" onPress={() => void submit()} disabled={!canSubmit} style={[button(true), isPhone && { width: "100%" }, !canSubmit && { opacity: .45 }]}><Text style={buttonText(true)}>{busy ? "Transferring…" : uncertain ? "Retry transfer confirmation" : "Transfer to customer"}</Text></Pressable>}
    </View>}>
    {lot ? <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
      <View style={{ gap: 3 }}><Text style={type.titleMd}>{lot.name}</Text><Text style={type.caption}>{lot.sku}{recorded ? " · Balance will refresh after acknowledgement" : ` · ${lot.available_qty} stock · ${freeQty} available to transfer${lot.source_customer_name ? ` · originally for ${lot.source_customer_name}` : ""}`}</Text></View>
      {!recorded ? <View style={noteStyle}><Feather name="info" size={16} color={colors.brand} /><Text style={[type.caption, { flex: 1 }]}>This moves stock to customer purchases in In Box and updates the amount due. A matching PO Final order is fulfilled when selected. The remaining GoDown stock quantity decreases.</Text></View> : null}
      {submitError ? <View accessibilityRole="alert" testID="godown-transfer-error" style={noteStyle}><Text style={[type.body, { flex: 1, color: colors.error }]}>{submitError}{uncertain ? " Your transfer details are preserved. Retry confirmation before changing them." : ""}</Text></View> : null}
      {recorded ? <View testID="godown-recorded-transfer" style={{ gap: spacing.sm }}>
        <Text style={type.titleMd}>Recorded transfer</Text>
        <Text style={type.body}>{recorded.qty} units to {recorded.recipient_customer_name}</Text>
        <Text style={type.caption}>Receipt {recorded.id}{recorded.created_at ? ` · ${new Date(recorded.created_at).toLocaleString("en-IN")}` : ""}</Text>
        <Text style={type.body}>This transfer has already reduced stock. Acknowledging it refreshes the list; it does not transfer stock again.</Text>
      </View> : null}
      {!recorded ? <><View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.sm }}>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: mode === "existing" }} disabled={locked} onPress={() => { setMode("existing"); setName(""); }} style={button(mode === "existing")}><Text style={buttonText(mode === "existing")}>Existing customer</Text></Pressable>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: mode === "new" }} disabled={locked} onPress={() => { setMode("new"); setCustomerId(""); setPurchaseItemId(""); }} style={button(mode === "new")}><Text style={buttonText(mode === "new")}>New customer</Text></Pressable>
      </View>
      {loading ? <ActivityIndicator /> : null}
      {loadError ? <View style={noteStyle}><Text style={[type.caption, { flex: 1, color: colors.error }]}>{loadError}</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry transfer recipients" disabled={locked} onPress={() => setReloadCount(value => value + 1)}><Text style={{ color: colors.brand, fontWeight: "700" }}>Retry</Text></Pressable></View> : null}
      {mode === "existing" ? <View style={{ gap: spacing.sm }}>
        <TextInput editable={!locked} accessibilityLabel="Search recipient customers" value={customerSearch} onChangeText={setCustomerSearch} placeholder="Search customers" style={inputStyle} />
        <ScrollView style={{ maxHeight: 148, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }} keyboardShouldPersistTaps="handled">
          {filteredCustomers.map((customer) => <Pressable key={customer.id} accessibilityRole="button" accessibilityState={{ selected: customerId === customer.id }} testID={`godown-recipient-${customer.id}`} disabled={locked} onPress={() => { if (customer.id !== customerId) setPurchaseItemId(""); setCustomerId(customer.id); }} style={[rowStyle, customerId === customer.id && { backgroundColor: colors.brandTint }]}><Text style={[type.body, { flex: 1 }]}>{customer.company || customer.name}</Text>{customerId === customer.id ? <Feather name="check" size={16} color={colors.brand} /> : null}</Pressable>)}
          {!filteredCustomers.length && !loading ? <Text style={[type.caption, { padding: 12 }]}>No matching customers</Text> : null}
        </ScrollView>
        {customerId && customerMatches.length ? <View style={{ gap: 5 }}><Text style={type.overline}>MATCHING PO FINAL ORDERS</Text>{customerMatches.map((match) => <Pressable key={match.purchase_item_id} accessibilityRole="button" accessibilityState={{ selected: purchaseItemId === match.purchase_item_id }} disabled={locked} onPress={() => { setPurchaseItemId(match.purchase_item_id); setQty(String(Math.min(freeQty, match.remaining_qty))); }} style={[rowStyle, purchaseItemId === match.purchase_item_id && { backgroundColor: colors.brandTint }]}><Text style={[type.body, { flex: 1 }]}>{match.name} · {match.remaining_qty} waiting</Text>{purchaseItemId === match.purchase_item_id ? <Feather name="check" size={16} color={colors.brand} /> : null}</Pressable>)}</View> : null}
        {customerId ? <Text style={type.caption}>{purchaseItemId ? "The selected PO Final quantity will move to In Box." : "A purchase will be created in In Box for this customer."}</Text> : null}
      </View> : <View style={{ gap: spacing.sm }}>
        <TextInput editable={!locked} accessibilityLabel="New customer name" value={name} onChangeText={setName} placeholder="Customer name" style={inputStyle} />
        <TextInput editable={!locked} accessibilityLabel="New customer phone" value={phone} onChangeText={setPhone} placeholder="Phone (optional)" keyboardType="phone-pad" style={inputStyle} />
        <TextInput editable={!locked} accessibilityLabel="New customer email" value={email} onChangeText={setEmail} placeholder="Email (optional)" keyboardType="email-address" autoCapitalize="none" style={inputStyle} />
      </View>}
      <View style={{ gap: 4 }}><Text style={type.overline}>QUANTITY TO TRANSFER</Text><TextInput editable={!locked} accessibilityLabel="Transfer quantity" testID="godown-transfer-qty" value={qty} onChangeText={setQty} keyboardType="decimal-pad" style={inputStyle} /><Text style={type.caption}>Maximum {Number.isFinite(maxQty) ? maxQty : freeQty} available. Transferring reduces GoDown stock.</Text>{!validQty ? <Text style={{ color: colors.error }}>Enter a quantity greater than zero and no more than the available amount.</Text> : null}</View>
      <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.sm }}>
        <View style={{ flex: 1, gap: 4 }}><Text style={type.overline}>SELLING UNIT PRICE (₹)</Text><TextInput editable={!locked} accessibilityLabel="Transfer unit price" testID="godown-transfer-price" value={unitPrice} onChangeText={setUnitPrice} keyboardType="decimal-pad" style={inputStyle} /><Text style={type.caption}>MRP {lot.mrp == null && lot.unit_price == null ? "not recorded" : Number(lot.mrp ?? lot.unit_price).toLocaleString("en-IN", { style: "currency", currency: "INR" })}</Text></View>
        <View style={{ flex: 1, gap: 4 }}><Text style={type.overline}>DISCOUNT (%)</Text><TextInput editable={!locked} accessibilityLabel="Transfer discount percentage" testID="godown-transfer-discount" value={discountPct} onChangeText={setDiscountPct} keyboardType="decimal-pad" style={inputStyle} /></View>
      </View>
      {!validPrice ? <Text style={{ color: colors.error }}>Enter a nonnegative price and a discount from 0 to 100%.</Text> : <Text testID="godown-transfer-total" style={type.body}>Net {netUnitPrice.toLocaleString("en-IN", { style: "currency", currency: "INR" })} per unit · Total {(netUnitPrice * amount || 0).toLocaleString("en-IN", { style: "currency", currency: "INR" })}</Text>}
      <TextInput editable={!locked} accessibilityLabel="Transfer reason" value={reason} onChangeText={setReason} placeholder="Reason (optional)" multiline style={[inputStyle, { minHeight: 72, paddingTop: 12 }]} /></> : null}
    </View> : null}
  </Sheet>;
}

const inputStyle = { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, color: colors.onSurface, backgroundColor: colors.surfaceSecondary } as const;
const rowStyle = { minHeight: 42, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderColor: colors.border } as const;
const noteStyle = { flexDirection: "row", gap: 9, padding: 12, backgroundColor: colors.brandTint, borderRadius: radius.md } as const;
const button = (active: boolean) => ({ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", alignItems: "center", borderRadius: radius.md, borderWidth: 1, borderColor: active ? colors.brand : colors.border, backgroundColor: active ? colors.brand : colors.surfaceSecondary } as const);
const buttonText = (active: boolean) => ({ fontWeight: "700", color: active ? colors.onBrand : colors.onSurface } as const);
