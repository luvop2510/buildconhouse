import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { recordGodownMovement, type GodownLot, type StockMovementInput } from "@/src/api/godownStock";
import { Text, TextInput } from "@/src/components/AppText";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

export function StockMovementEditor({ lot, floorId, onUpdated }: { lot: GodownLot; floorId?: string; onUpdated: (lot: GodownLot) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<StockMovementInput["kind"]>("receipt");
  const [qty, setQty] = useState("");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<StockMovementInput | null>(null);
  const submitting = useRef(false);
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    pending.current = null; submitting.current = false;
    setSaving(false); setUncertain(false); setOpen(false); setError(""); setQty(""); setDate(""); setReason("");
    return () => controller.abort();
  }, [lot.id, floorId]);
  if (lot.archived || lot.quantity_missing) return null;
  const save = async () => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || submitting.current) return;
    const amount = Number(qty);
    if (!pending.current) {
      if (!qty.trim() || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || reason.trim().length < 3) {
        setError("Enter a positive quantity, date (YYYY-MM-DD), and stock source or reason."); return;
      }
      pending.current = { kind, qty: amount, occurred_on: date, reason: reason.trim(), expected_updated_at: lot.updated_at || null, idempotency_key: randomUUID() };
    }
    submitting.current = true; setSaving(true); setError("");
    try {
      const updated = await recordGodownMovement(lot.id, pending.current, controller.signal, floorId);
      if (controller.signal.aborted) return;
      onUpdated(updated); pending.current = null; setUncertain(false); setOpen(false); setQty(""); setReason("");
    } catch (failure: any) {
      if (controller.signal.aborted) return;
      const definitive = [400, 401, 403, 404, 409, 422].includes(failure?.status);
      if (definitive) pending.current = null;
      setUncertain(!definitive);
      setError(failure?.detail || failure?.message || "Movement could not be confirmed. Retry to resolve the same request.");
    } finally { if (lifecycle.current === controller) { submitting.current = false; if (!controller.signal.aborted) setSaving(false); } }
  };
  const locked = saving || uncertain;
  return <View style={{ gap: spacing.sm }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Record stock movement for ${lot.name}`} testID={`godown-movement-${lot.id}`} disabled={saving} onPress={() => setOpen(value => !value)} style={styles.action}><Text style={styles.label}>{open ? "Close stock movement" : "Stock movement · receive / adjust"}</Text></Pressable>
    {open ? <View style={styles.form}>
      <Text style={type.titleSm}>Record stock movement</Text>
      <Text style={type.caption}>Receive new stock, or remove damaged / missing units. Existing transfers and purchase history stay recorded.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>{(["receipt", "adjustment_out"] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: kind === value }} disabled={locked} onPress={() => setKind(value)} style={[styles.action, kind === value && { backgroundColor: colors.surfaceTertiary }]}><Text style={styles.label}>{value === "receipt" ? "Receive stock" : "Remove stock"}</Text></Pressable>)}</View>
      <Text style={type.caption}>Quantity (required)</Text><TextInput testID={`godown-movement-qty-${lot.id}`} accessibilityLabel="Stock movement quantity" keyboardType="decimal-pad" editable={!locked} value={qty} onChangeText={setQty} style={styles.input} />
      <Text style={type.caption}>Movement date (YYYY-MM-DD, required)</Text><TextInput testID={`godown-movement-date-${lot.id}`} accessibilityLabel="Stock movement date" maxLength={10} editable={!locked} value={date} onChangeText={setDate} style={styles.input} />
      <Text style={type.caption}>Source / reason (required)</Text><TextInput testID={`godown-movement-reason-${lot.id}`} accessibilityLabel="Stock movement reason" maxLength={280} editable={!locked} value={reason} onChangeText={setReason} style={styles.input} />
      {error ? <Text accessibilityRole="alert" style={[type.body, { color: colors.error }]}>{error}</Text> : null}
      {uncertain ? <Text style={type.caption}>Keep these details until retry confirms whether the movement was recorded.</Text> : null}
      <Pressable accessibilityRole="button" testID={`godown-movement-save-${lot.id}`} disabled={saving} onPress={() => void save()} style={styles.action}><Text style={styles.label}>{saving ? "Recording…" : uncertain ? "Retry same movement" : "Save stock movement"}</Text></Pressable>
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({
  action: { paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  label: { ...type.body, color: colors.brand },
  form: { gap: spacing.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  input: { ...type.body, minHeight: 42, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
});
