// CustomProductSheet — quick-add sheet for a one-off custom product.
// Two modes controlled by a checkbox:
//   [ ] Keep in catalogue          → persists via /products/custom (is_custom=true)
//   [ ] Inline only                → lives ONLY inside this quotation
// In both cases a line is inserted into the current room.
// -----------------------------------------------------------------------------
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";
import { Overlay } from "@/src/design/Overlay";

import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { colors, radius, shadow, spacing } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";
import { useBuilder } from "../context/BuilderContext";
import type { Product } from "../helpers/types";

export function CustomProductSheet() {
  const b = useBuilder();
  const open = b.customProductSheetOpen;
  const { isPhone } = useBp();

  const initialized = useRef(false);
  const committing = useRef(false);
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [brandId, setBrandId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [mrp, setMrp] = useState("");
  const [finish, setFinish] = useState("");
  const [description, setDescription] = useState("");
  const [saveToCatalog, setSaveToCatalog] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { initialized.current = false; return; }
    if (initialized.current) return;
    initialized.current = true;
    setName(""); setSku(""); setPrice(""); setMrp(""); setFinish(""); setDescription("");
    setBrandId(b.selectedBrandId ?? b.brands[0]?.id ?? null);
    setCategoryId(b.selectedCategoryId ?? b.categories[0]?.id ?? null);
    setSaveToCatalog(true);
  }, [open, b.selectedBrandId, b.selectedCategoryId, b.brands, b.categories]);

  const commit = async () => {
    if (committing.current) return;
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!brandId || !categoryId) { toast.error("Pick a brand and category"); return; }
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) { toast.error("Enter a valid price"); return; }
    const catalogueMrp = mrp.trim() ? Number(mrp) : p;
    if (!Number.isFinite(catalogueMrp) || catalogueMrp < 0) { toast.error("Enter a valid MRP (zero or more)"); return; }

    committing.current = true;
    setBusy(true);
    try {
      if (saveToCatalog) {
        // Persist to catalog with is_custom=true so it's searchable in future.
        const prod = await api.post<Product>("/products/custom", {
          name: name.trim(),
          sku: sku.trim() || `CUSTOM-${Date.now().toString(36).toUpperCase()}`,
          brand_id: brandId, category_id: categoryId,
          price: p, mrp: catalogueMrp,
          finish: finish.trim() || null, description: description.trim() || null,
          is_custom: true,
        });
        b.addFromProduct(prod);
        toast.success(`Added · ${prod.sku}`);
      } else {
        // In-quotation only. Fabricate a synthetic "product" object.
        const localId = `custom-${Date.now()}`;
        const prod: Product = {
          id: localId,
          name: name.trim(),
          sku: sku.trim() || `INLINE-${Date.now().toString(36).toUpperCase()}`,
          brand_id: brandId, category_id: categoryId,
          price: p, mrp: catalogueMrp,
          finish: finish.trim() || null, description: description.trim() || null,
          images: [], variants: [],
        } as Product;
        b.addFromProduct(prod);
        toast.success("Added inline");
      }
      b.setCustomProductSheetOpen(false);
    } catch (e: any) {
      toast.error(e?.detail || "Could not add product");
    } finally {
      committing.current = false;
      setBusy(false);
    }
  };

  return (
    <Overlay open={open} onClose={() => { if (!busy) b.setCustomProductSheetOpen(false); }} title="Custom product"
      subtitle="Add a one-off item and choose whether to keep it in the catalog." testID="custom-product-sheet" scroll={false} dismissable={!busy}
      width={640} presentation={isPhone ? "fullscreen" : "dialog"} footer={<>
        <Pressable onPress={() => b.setCustomProductSheetOpen(false)} disabled={busy} style={styles.secondary} accessibilityRole="button">
          <Text style={styles.secondaryLabel}>Cancel</Text>
        </Pressable>
        <Pressable onPress={commit} style={[styles.primary, busy && { opacity: 0.6 }]} disabled={busy} testID="cp-commit" accessibilityRole="button">
          <Feather name="plus" size={16} color={colors.onBrand} />
          <Text style={styles.primaryLabel}>{busy ? "Adding…" : saveToCatalog ? "Add & keep" : "Add to quotation"}</Text>
        </Pressable>
      </>}>
          <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: 12 }} keyboardShouldPersistTaps="handled">
            <Field label="Product name *">
              <TextInput value={name} onChangeText={setName} placeholder="e.g. Custom stone-cladding sink" style={styles.input} testID="cp-name" accessibilityLabel="Custom product name" />
            </Field>
            <Field label="SKU (optional — auto if blank)">
              <TextInput value={sku} onChangeText={setSku} placeholder="e.g. CUSTOM-STONE-SINK" style={styles.input} autoCapitalize="characters" accessibilityLabel="Custom product SKU" />
            </Field>

            <View style={[styles.grid, isPhone && styles.phoneGrid]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Brand *</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
                  {b.brands.map((br) => {
                    const on = brandId === br.id;
                    return (
                      <Pressable key={br.id} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setBrandId(br.id)} style={[styles.pill, on && styles.pillActive]}>
                        <Text style={[styles.pillLabel, on && styles.pillLabelActive]}>{br.name}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            </View>

            <View>
              <Text style={styles.label}>Category *</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
                {b.categories.map((c) => {
                  const on = categoryId === c.id;
                  return (
                    <Pressable key={c.id} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setCategoryId(c.id)} style={[styles.pill, on && styles.pillActive]}>
                      <Text style={[styles.pillLabel, on && styles.pillLabelActive]}>{c.name}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            <View style={[styles.grid, isPhone && styles.phoneGrid]}>
              <Field label="Price *" flex={1}>
                <TextInput value={price} onChangeText={setPrice} placeholder="0" keyboardType="numeric" style={styles.input} testID="cp-price" accessibilityLabel="Custom product price" />
              </Field>
              <Field label="MRP" flex={1}>
                <TextInput accessibilityLabel="Custom product MRP" value={mrp} onChangeText={setMrp} placeholder="0" keyboardType="numeric" style={styles.input} />
              </Field>
              <Field label="Finish" flex={1.2}>
                <TextInput accessibilityLabel="Custom product finish" value={finish} onChangeText={setFinish} placeholder="Chrome, Matt Black …" style={styles.input} />
              </Field>
            </View>

            <Field label="Description">
              <TextInput
                accessibilityLabel="Custom product description" value={description} onChangeText={setDescription}
                placeholder="Optional — shown on quotation & PDF"
                multiline style={[styles.input, { minHeight: 60 }]}
              />
            </Field>

            <Pressable accessibilityRole="checkbox" accessibilityLabel="Keep in catalogue" accessibilityState={{ checked: saveToCatalog }} onPress={() => setSaveToCatalog((v) => !v)} style={styles.checkbox} testID="cp-save">
              <View style={[styles.checkboxBox, saveToCatalog && styles.checkboxBoxOn]}>
                {saveToCatalog ? <Feather name="check" size={11} color={colors.onBrand} /> : null}
              </View>
              <View style={{ flex: 1 }}>
              <Text style={styles.checkboxLabel}>Keep in catalogue</Text>
                <Text style={styles.checkboxHint}>
                  {saveToCatalog
                    ? "Appears in future quotations, searchable, editable."
                    : "Lives only inside this quotation — won’t pollute the catalog."}
                </Text>
              </View>
            </Pressable>
          </ScrollView>

    </Overlay>
  );
}

function Field({ label, children, flex }: { label: string; children: React.ReactNode; flex?: number }) {
  return (
    <View style={{ flex, gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(9,9,11,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  phoneBackdrop: { padding: 0, justifyContent: "flex-end" },
  sheet: { width: "100%", maxWidth: 640, maxHeight: "92%", backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg, overflow: "hidden", ...shadow.strong },
  phoneSheet: { maxWidth: undefined, maxHeight: "96%", borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  keyboard: { maxHeight: "100%" },
  safeArea: { maxHeight: "100%" },

  head: { flexDirection: "row", padding: spacing.lg, alignItems: "flex-start", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { fontSize: 18, fontWeight: "700", color: colors.onSurface, letterSpacing: -0.2 },
  subtitle: { fontSize: 12, color: colors.onSurfaceMuted, marginTop: 2 },
  close: { width: 44, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },

  label: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceMuted, letterSpacing: 1.1, textTransform: "uppercase", marginBottom: 4 },
  input: {
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 10, paddingVertical: 8, minHeight: 48, fontSize: 16, color: colors.onSurface, backgroundColor: colors.surface,
  },

  grid: { flexDirection: "row", gap: 10 },
  phoneGrid: { flexDirection: "column" },

  pill: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceTertiary },
  pillActive: { backgroundColor: colors.brand },
  pillLabel: { fontSize: 11, fontWeight: "600", color: colors.onSurfaceSecondary },
  pillLabelActive: { color: colors.onBrand },

  checkbox: { flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary },
  checkboxBox: { width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center", marginTop: 1 },
  checkboxBoxOn: { backgroundColor: colors.brand, borderColor: colors.brand },
  checkboxLabel: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  checkboxHint: { fontSize: 11, color: colors.onSurfaceMuted, marginTop: 2 },

  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 8, padding: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface },
  phoneFooter: { padding: spacing.md },
  secondary: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  secondaryLabel: { fontSize: 12, fontWeight: "700", color: colors.onSurface },
  primary: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", minHeight: 44, gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.md, backgroundColor: colors.brand },
  primaryLabel: { fontSize: 12, fontWeight: "700", color: colors.onBrand, letterSpacing: 0.2 },
});
