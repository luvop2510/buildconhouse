import { Feather } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { api } from "@/src/api/client";
import {
  getPoFinalMatches, transferGodownStockToCustomer,
  type GodownLot, type PoFinalMatch,
} from "@/src/api/godownStock";
import { toast } from "@/src/components/Toast";
import { Sheet } from "@/src/design/components";
import { useBp } from "@/src/design/responsive";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type Customer = { id: string; name: string; company?: string | null };

export function CustomerTransferSheet({ lot, initialMatch, onClose, onTransferred }: {
  lot: GodownLot | null;
  initialMatch?: PoFinalMatch | null;
  onClose: () => void;
  onTransferred: () => void | Promise<void>;
}) {
  const { isPhone } = useBp();
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
  const [idempotencyKey, setIdempotencyKey] = useState("");

  useEffect(() => {
    if (!lot) return;
    let live = true;
    setMode("existing");
    setCustomerId(initialMatch?.customer_id || "");
    setPurchaseItemId(initialMatch?.purchase_item_id || "");
    setCustomerSearch(""); setName(""); setPhone(""); setEmail(""); setReason("");
    setUnitPrice(String(lot.unit_price ?? 0)); setDiscountPct("0"); setLoadError("");
    const freeQty = lot.transferable_qty ?? Math.max(0, lot.available_qty - (lot.loaned_out_qty || 0));
    setQty(String(Math.min(freeQty, initialMatch?.remaining_qty ?? freeQty)));
    setMatches(initialMatch ? [initialMatch] : []);
    setIdempotencyKey(`godown-transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    setLoading(true);
    Promise.all([
      api.get<Customer[]>("/customers"),
      getPoFinalMatches(lot.id),
    ]).then(([nextCustomers, nextMatches]) => {
      if (!live) return;
      setCustomers(nextCustomers || []);
      setMatches(nextMatches.matches || []);
    }).catch((error: any) => {
      if (live) setLoadError(error?.detail || "Could not load customers and PO Final matches");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [lot, initialMatch, reloadCount]);

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
  const canSubmit = Boolean(lot && validQty && validPrice && (mode === "new" ? name.trim() : customerId) && !busy && !loading && !loadError);
  const netUnitPrice = validPrice ? priceAmount * (1 - discountAmount / 100) : 0;

  const submit = async () => {
    if (!lot || !canSubmit) return;
    setBusy(true);
    try {
      const response = await transferGodownStockToCustomer(lot.id, {
        qty: amount,
        ...(mode === "new"
          ? { new_customer: { name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined } }
          : { recipient_customer_id: customerId, recipient_purchase_item_id: purchaseItemId || undefined }),
        reason: reason.trim() || undefined,
        idempotency_key: idempotencyKey,
        unit_price: priceAmount,
        discount_pct: discountAmount,
      });
      toast.success(`${amount} ${amount === 1 ? "unit" : "units"} recorded for ${response.recipient_customer_name || name || customers.find((customer) => customer.id === customerId)?.name || "customer"}`);
      await onTransferred();
      onClose();
    } catch (error: any) {
      toast.error(error?.detail || "Could not transfer stock");
    } finally { setBusy(false); }
  };

  return <Sheet open={!!lot} onClose={onClose} title="Transfer stock to customer" width={540}
    footer={<View style={{ flexDirection: isPhone ? "column-reverse" : "row", gap: spacing.sm, justifyContent: "flex-end" }}>
      <Pressable accessibilityRole="button" onPress={onClose} disabled={busy} style={[button(false), isPhone && { width: "100%" }]}><Text style={buttonText(false)}>Cancel</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Confirm customer stock transfer" testID="godown-customer-transfer-submit" onPress={() => void submit()} disabled={!canSubmit} style={[button(true), isPhone && { width: "100%" }, !canSubmit && { opacity: .45 }]}><Text style={buttonText(true)}>{busy ? "Transferring…" : "Transfer to customer"}</Text></Pressable>
    </View>}>
    {lot ? <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
      <View style={{ gap: 3 }}><Text style={type.titleMd}>{lot.name}</Text><Text style={type.caption}>{lot.sku} · {lot.available_qty} stock · {freeQty} available to transfer{lot.source_customer_name ? ` · originally for ${lot.source_customer_name}` : ""}</Text></View>
      <View style={noteStyle}><Feather name="info" size={16} color={colors.brand} /><Text style={[type.caption, { flex: 1 }]}>This permanently moves stock to the customer. If you select a matching PO Final order, its transferred quantity moves directly to In Box. The remaining stock quantity decreases.</Text></View>
      <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.sm }}>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: mode === "existing" }} onPress={() => { setMode("existing"); setName(""); }} style={button(mode === "existing")}><Text style={buttonText(mode === "existing")}>Existing customer</Text></Pressable>
        <Pressable accessibilityRole="tab" accessibilityState={{ selected: mode === "new" }} onPress={() => { setMode("new"); setCustomerId(""); setPurchaseItemId(""); }} style={button(mode === "new")}><Text style={buttonText(mode === "new")}>New customer</Text></Pressable>
      </View>
      {loading ? <ActivityIndicator /> : null}
      {loadError ? <View style={noteStyle}><Text style={[type.caption, { flex: 1, color: colors.error }]}>{loadError}</Text><Pressable accessibilityRole="button" onPress={() => setReloadCount(value => value + 1)}><Text style={{ color: colors.brand, fontWeight: "700" }}>Retry</Text></Pressable></View> : null}
      {mode === "existing" ? <View style={{ gap: spacing.sm }}>
        <TextInput accessibilityLabel="Search recipient customers" value={customerSearch} onChangeText={setCustomerSearch} placeholder="Search customers" style={inputStyle} />
        <ScrollView style={{ maxHeight: 148, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }} keyboardShouldPersistTaps="handled">
          {filteredCustomers.map((customer) => <Pressable key={customer.id} accessibilityRole="button" accessibilityState={{ selected: customerId === customer.id }} testID={`godown-recipient-${customer.id}`} onPress={() => { setCustomerId(customer.id); setPurchaseItemId(""); }} style={[rowStyle, customerId === customer.id && { backgroundColor: colors.brandTint }]}><Text style={[type.body, { flex: 1 }]}>{customer.company || customer.name}</Text>{customerId === customer.id ? <Feather name="check" size={16} color={colors.brand} /> : null}</Pressable>)}
          {!filteredCustomers.length && !loading ? <Text style={[type.caption, { padding: 12 }]}>No matching customers</Text> : null}
        </ScrollView>
        {customerId && customerMatches.length ? <View style={{ gap: 5 }}><Text style={type.overline}>MATCHING PO FINAL ORDERS</Text>{customerMatches.map((match) => <Pressable key={match.purchase_item_id} accessibilityRole="button" accessibilityState={{ selected: purchaseItemId === match.purchase_item_id }} onPress={() => { setPurchaseItemId(match.purchase_item_id); setQty(String(Math.min(freeQty, match.remaining_qty))); }} style={[rowStyle, purchaseItemId === match.purchase_item_id && { backgroundColor: colors.brandTint }]}><Text style={[type.body, { flex: 1 }]}>{match.name} · {match.remaining_qty} waiting</Text>{purchaseItemId === match.purchase_item_id ? <Feather name="check" size={16} color={colors.brand} /> : null}</Pressable>)}</View> : null}
        {customerId ? <Text style={type.caption}>{purchaseItemId ? "The selected PO Final quantity will move to In Box." : "No order selected. This transfer will be recorded directly on the customer page."}</Text> : null}
      </View> : <View style={{ gap: spacing.sm }}>
        <TextInput accessibilityLabel="New customer name" value={name} onChangeText={setName} placeholder="Customer name" style={inputStyle} />
        <TextInput accessibilityLabel="New customer phone" value={phone} onChangeText={setPhone} placeholder="Phone (optional)" keyboardType="phone-pad" style={inputStyle} />
        <TextInput accessibilityLabel="New customer email" value={email} onChangeText={setEmail} placeholder="Email (optional)" keyboardType="email-address" autoCapitalize="none" style={inputStyle} />
      </View>}
      <View style={{ gap: 4 }}><Text style={type.overline}>QUANTITY TO TRANSFER</Text><TextInput accessibilityLabel="Transfer quantity" testID="godown-transfer-qty" value={qty} onChangeText={setQty} keyboardType="decimal-pad" style={inputStyle} /><Text style={type.caption}>Maximum {Number.isFinite(maxQty) ? maxQty : freeQty} available. Transferring reduces GoDown stock.</Text>{!validQty ? <Text style={{ color: colors.error }}>Enter a quantity greater than zero and no more than the available amount.</Text> : null}</View>
      <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.sm }}>
        <View style={{ flex: 1, gap: 4 }}><Text style={type.overline}>SELLING UNIT PRICE (₹)</Text><TextInput accessibilityLabel="Transfer unit price" testID="godown-transfer-price" value={unitPrice} onChangeText={setUnitPrice} keyboardType="decimal-pad" style={inputStyle} /><Text style={type.caption}>MRP {Number(lot.mrp ?? lot.unit_price ?? 0).toLocaleString("en-IN", { style: "currency", currency: "INR" })}</Text></View>
        <View style={{ flex: 1, gap: 4 }}><Text style={type.overline}>DISCOUNT (%)</Text><TextInput accessibilityLabel="Transfer discount percentage" testID="godown-transfer-discount" value={discountPct} onChangeText={setDiscountPct} keyboardType="decimal-pad" style={inputStyle} /></View>
      </View>
      {!validPrice ? <Text style={{ color: colors.error }}>Enter a nonnegative price and a discount from 0 to 100%.</Text> : <Text testID="godown-transfer-total" style={type.body}>Net {netUnitPrice.toLocaleString("en-IN", { style: "currency", currency: "INR" })} per unit · Total {(netUnitPrice * amount || 0).toLocaleString("en-IN", { style: "currency", currency: "INR" })}</Text>}
      <TextInput accessibilityLabel="Transfer reason" value={reason} onChangeText={setReason} placeholder="Reason (optional)" multiline style={[inputStyle, { minHeight: 72, paddingTop: 12 }]} />
    </View> : null}
  </Sheet>;
}

const inputStyle = { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, color: colors.onSurface, backgroundColor: colors.surfaceSecondary } as const;
const rowStyle = { minHeight: 42, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderColor: colors.border } as const;
const noteStyle = { flexDirection: "row", gap: 9, padding: 12, backgroundColor: colors.brandTint, borderRadius: radius.md } as const;
const button = (active: boolean) => ({ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", alignItems: "center", borderRadius: radius.md, borderWidth: 1, borderColor: active ? colors.brand : colors.border, backgroundColor: active ? colors.brand : colors.surfaceSecondary } as const);
const buttonText = (active: boolean) => ({ fontWeight: "700", color: active ? colors.onBrand : colors.onSurface } as const);
