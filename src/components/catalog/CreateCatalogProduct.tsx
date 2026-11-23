import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { randomUUID } from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { ProductImage } from "@/src/components/ProductImage";
import { Button, Chip, Sheet, TextField } from "@/src/components/ui";
import { spacing, type } from "@/src/theme/tokens";
import { appendImageUpload, type UploadImage } from "@/src/utils/appendImageUpload";

type Reference = { id: string; name: string; brand_id?: string | null };
type SavedProduct = { id: string; sku: string; brand_id: string; category_id: string; floor_id: string; active: boolean };

export function CreateCatalogProduct({ visible, floorId, brands, categories, onClose, onCreated }: {
  visible: boolean; floorId: string; brands: Reference[]; categories: Reference[];
  onClose: () => void; onCreated: (product: SavedProduct) => void;
}) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [mrp, setMrp] = useState("");
  const [size, setSize] = useState("");
  const [finish, setFinish] = useState("");
  const [photo, setPhoto] = useState<UploadImage | null>(null);
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<number | null>(null);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    if (visible) {
      setName(""); setSku(""); setPrice(""); setMrp(""); setBrand(""); setCategory(""); setError("");
      setSize(""); setFinish(""); setPhoto(null);
      intent.current = null;
    }
  }, [visible, floorId]);

  const selectBrand = (id: string) => {
    setBrand(id);
    const owner = categories.find(item => item.id === category)?.brand_id;
    if (owner && owner !== id) setCategory("");
  };

  const pickPhoto = async () => {
    const current = generation.current;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
      if (current === generation.current && !result.canceled && result.assets[0]) setPhoto(result.assets[0]);
    } catch (e) {
      if (current === generation.current) setError(e instanceof Error ? e.message : "Could not choose the product photo.");
    }
  };

  const create = async () => {
    const current = generation.current;
    if (pending.current === current) return;
    const amount = Number(price), retail = mrp.trim() ? Number(mrp) : amount;
    if (!name.trim() || !price.trim() || !Number.isFinite(amount) || !Number.isFinite(retail) || amount < 0 || retail < 0) {
      setError("Enter a product name and valid non-negative prices."); return;
    }
    const body = { name: name.trim(), sku: sku.trim(), price: amount, mrp: retail, brand_id: brand, category_id: category,
      size: size.trim() || null, finish: finish.trim() || null };
    const fingerprint = JSON.stringify([floorId, body, photo?.uri]);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: randomUUID() };
    const product = { ...body, request_id: intent.current.key };
    pending.current = current; setBusy(true); setError("");
    try {
      let saved: SavedProduct;
      if (photo) {
        const form = new FormData();
        form.append("product", JSON.stringify(product));
        await appendImageUpload(form, photo);
        if (current !== generation.current) return;
        saved = await api.upload<SavedProduct>("/products/catalog-custom-with-media", form, { floorId });
      } else {
        saved = await api.post<SavedProduct>("/products/catalog-custom", product, { floorId });
      }
      if (!saved?.id || !saved.sku || !saved.brand_id || !saved.category_id || saved.floor_id !== floorId || saved.active !== true) {
        throw new Error("The server did not confirm the catalog product. Please retry.");
      }
      if (current === generation.current) { onCreated(saved); onClose(); }
    } catch (e) {
      if (current === generation.current) setError(e instanceof Error ? e.message : "Could not add the product. Try again.");
    } finally {
      if (pending.current === current) pending.current = null;
      if (current === generation.current) setBusy(false);
    }
  };

  return <Sheet visible={visible} onClose={() => { if (!busy) onClose(); }} title="Add custom product" scroll
    footer={<><Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} /><View style={{flex:1}} /><Button label="Add product" loading={busy} onPress={() => { void create(); }} testID="save-catalog-custom-product" /></>}>
    <View style={{ padding: spacing.lg, gap: spacing.md }}>
      <TextField label="Product name" value={name} onChangeText={setName} testID="custom-catalog-name" />
      <TextField label="SKU (optional)" value={sku} onChangeText={setSku} />
      <TextField label="Selling price" value={price} onChangeText={setPrice} keyboardType="decimal-pad" testID="custom-catalog-price" />
      <TextField label="MRP (optional)" value={mrp} onChangeText={setMrp} keyboardType="decimal-pad" />
      <TextField label="Size (optional)" value={size} onChangeText={setSize} />
      <TextField label="Finish (optional)" value={finish} onChangeText={setFinish} />
      <Text style={type.label}>Brand</Text>
      <ScrollView horizontal contentContainerStyle={{ gap: spacing.sm }}><Chip label="Custom" active={!brand} onPress={() => selectBrand("")} />{brands.map(item => <Chip key={item.id} label={item.name} active={brand === item.id} onPress={() => selectBrand(item.id)} />)}</ScrollView>
      <Text style={type.label}>Category</Text>
      <ScrollView horizontal contentContainerStyle={{ gap: spacing.sm }}><Chip label="Custom" active={!category} onPress={() => setCategory("")} />{categories.filter(item => !item.brand_id || item.brand_id === brand).map(item => <Chip key={item.id} label={item.name} active={category === item.id} onPress={() => setCategory(item.id)} />)}</ScrollView>
      {photo ? <ProductImage source={photo.uri} style={{ width: "100%", height: 140 }} contentFit="contain" fallbackLabel={name} /> : null}
      <Button label={photo ? "Change product photo" : "Add product photo"} variant="secondary" disabled={busy} onPress={() => { void pickPhoto(); }} />
      {photo ? <Button label="Remove photo" variant="secondary" disabled={busy} onPress={() => setPhoto(null)} /> : null}
      {error ? <Text accessibilityRole="alert" style={type.body}>{error}</Text> : null}
    </View>
  </Sheet>;
}
