import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "@/src/components/AppText";
import { BottomSheet } from "@/src/components/BottomSheet";
import { Alert, Button, TextField } from "@/src/components/ui";
import { colors, spacing, type } from "@/src/theme/tokens";
import { useBuilder } from "../context/BuilderContext";
import { hasReservedStock, previewQuantityIncrease, quotationRoomLines, validQuantityIncrease } from "../helpers/roomProducts";

const formatQuantity = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 }).format;

export function RoomProductsSheet({ room, mode, onClose }: { room: string; mode: "increase" | "copy"; onClose: () => void }) {
  const b = useBuilder();
  const [increase, setIncrease] = useState("1");
  const [destination, setDestination] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lines = quotationRoomLines(b.s, room);
  const stockLinked = lines.some(hasReservedStock);
  const availableRooms = b.s.rooms.filter(name => name !== room && !quotationRoomLines(b.s, name).length);
  const delta = /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(increase.trim()) ? Number(increase) : NaN;
  const preview = mode === "increase" ? previewQuantityIncrease(lines, delta) : null;
  const validPreview = validQuantityIncrease(preview);
  const busy = b.roomProductSaveBusy;
  const disabled = busy || !b.s.customerId || !lines.length || stockLinked
    || (mode === "increase" ? !validPreview : !availableRooms.includes(destination));

  const confirm = async () => {
    if (disabled) return;
    setError(null);
    try {
      const saved = await b.saveRoomProducts(room, mode === "increase" ? { increase: delta } : { destination });
      if (saved) onClose();
      else setError("The change could not be saved. Try again.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The change could not be saved. Try again.");
    }
  };

  return (
    <BottomSheet visible onClose={() => { if (!busy) onClose(); }} title={mode === "increase" ? "Increase quantities" : "Copy products"} testID={`room-products-${mode}-sheet`}
      footer={<View style={styles.footer}>
        <Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} />
        <Button label={mode === "increase" ? "Apply increase" : "Save copies"} disabled={disabled} loading={busy} onPress={() => void confirm()} testID="confirm-room-products" />
      </View>}
    >
      <View style={styles.body}>
        <Text style={type.bodyStrong}>{room}</Text>
        {!b.s.customerId ? <Alert tone="warning" title="Select a customer to save changes to this quotation." /> : null}
        {stockLinked ? <Alert tone="warning" title="This room contains Godown stock. Change its reserved quantity through the stock workflow." /> : null}
        {error ? <Alert tone="error" title={error} /> : null}
        {mode === "increase" ? <>
          <View style={styles.actions}>
            {[1, 2, 3].map(amount => <Button key={amount} label={`+${amount}`} variant={delta === amount ? "brandLight" : "secondary"} disabled={busy}
              onPress={() => { setIncrease(String(amount)); setError(null); }} testID={`quantity-increase-${amount}`} />)}
          </View>
          <TextField label="Quantity increase per product" value={increase} onChangeText={value => { setIncrease(value); setError(null); }} keyboardType="decimal-pad"
            editable={!busy} testID="custom-quantity-increase" />
          {validPreview && preview ? <>
            <Text style={type.bodyMuted} accessibilityLiveRegion="polite">
              {preview.length} {preview.length === 1 ? "product" : "products"} · +{formatQuantity(delta)} each selected product
            </Text>
            <View style={styles.list} testID="quantity-increase-preview">
              {preview.map(({ line, quantity }) => <View key={line.id} style={styles.previewRow}>
                <View style={styles.product}>
                  <Text style={type.body}>{line.name}</Text>
                  <Text style={type.caption}>{[line.sku, line.included_for_line_id ? "Included part" : line.finish].filter(Boolean).join(" · ")}</Text>
                </View>
                <Text style={styles.values} accessibilityLabel={`From ${formatQuantity(line.qty)} to ${formatQuantity(quantity)}`}>
                  {formatQuantity(line.qty)} → {formatQuantity(quantity)}
                </Text>
              </View>)}
            </View>
          </> : !stockLinked && lines.length ? <Text style={type.caption}>Enter a positive increase that fits the products’ quantity limits.</Text> : null}
        </> : <>
          <Text style={type.bodyMuted}>{lines.length} {lines.length === 1 ? "product" : "products"}. Choose an empty room to keep existing products intact.</Text>
          {availableRooms.length ? <View style={styles.actions}>
            {availableRooms.map(name => <Button key={name} label={name} variant={destination === name ? "brandLight" : "secondary"}
              disabled={busy || stockLinked} onPress={() => { setDestination(name); setError(null); }} testID={`copy-products-to-${name}`} />)}
          </View> : <Text style={type.caption}>Add an empty room before copying these products.</Text>}
        </>}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, paddingBottom: spacing.lg },
  footer: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: spacing.sm },
  actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  previewRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm, minHeight: 48,
    paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  product: { flex: 1, minWidth: 128 },
  values: { ...type.bodyStrong, fontVariant: ["tabular-nums"] },
});
