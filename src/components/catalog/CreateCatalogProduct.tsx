import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Button, Chip, Sheet, TextField } from "@/src/components/ui";
import { spacing, type } from "@/src/theme/tokens";

type Reference = { id: string; name: string };

export function CreateCatalogProduct({ visible, floorId, brands, categories, onClose, onCreated }: {
  visible: boolean; floorId: string; brands: Reference[]; categories: Reference[];
  onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [mrp, setMrp] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    if (visible) {
      setName(""); setSku(""); setPrice(""); setMrp(""); setBrand(""); setCategory(""); setError("");
      intent.current = null;
    }
  }, [visible, floorId]);

  const create = async () => {
    if (pending.current) return;
    const amount = Number(price), retail = mrp.trim() ? Number(mrp) : amount;
    if (!name.trim() || !price.trim() || !Number.isFinite(amount) || !Number.isFinite(retail) || amount < 0 || retail < 0) {
      setError("Enter a product name and valid non-negative prices."); return;
    }
    const body = { name: name.trim(), sku: sku.trim(), price: amount, mrp: retail, brand_id: brand, category_id: category };
    const fingerprint = JSON.stringify([floorId, body]);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: randomUUID() };
    const current = generation.current;
    pending.current = true; setBusy(true); setError("");
    try {
      await api.post("/products/catalog-custom", { ...body, request_id: intent.current.key }, { floorId });
      if (current === generation.current) { onCreated(); onClose(); }
    } catch (e: any) {
      if (current === generation.current) setError(e?.detail || "Could not add the product. Try again.");
    } finally { pending.current = false; if (current === generation.current) setBusy(false); }
  };

  return <Sheet visible={visible} onClose={() => { if (!busy) onClose(); }} title="Add custom product" scroll
    footer={<><Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} /><View style={{flex:1}} /><Button label="Add product" loading={busy} onPress={() => { void create(); }} testID="save-catalog-custom-product" /></>}>
    <View style={{ padding: spacing.lg, gap: spacing.md }}>
      <TextField label="Product name" value={name} onChangeText={setName} testID="custom-catalog-name" />
      <TextField label="SKU (optional)" value={sku} onChangeText={setSku} />
      <TextField label="Selling price" value={price} onChangeText={setPrice} keyboardType="decimal-pad" testID="custom-catalog-price" />
      <TextField label="MRP (optional)" value={mrp} onChangeText={setMrp} keyboardType="decimal-pad" />
      <Text style={type.label}>Brand</Text>
      <ScrollView horizontal contentContainerStyle={{ gap: spacing.sm }}><Chip label="Custom" active={!brand} onPress={() => setBrand("")} />{brands.map(item => <Chip key={item.id} label={item.name} active={brand === item.id} onPress={() => setBrand(item.id)} />)}</ScrollView>
      <Text style={type.label}>Category</Text>
      <ScrollView horizontal contentContainerStyle={{ gap: spacing.sm }}><Chip label="Custom" active={!category} onPress={() => setCategory("")} />{categories.map(item => <Chip key={item.id} label={item.name} active={category === item.id} onPress={() => setCategory(item.id)} />)}</ScrollView>
      {error ? <Text accessibilityRole="alert" style={type.body}>{error}</Text> : null}
    </View>
  </Sheet>;
}
