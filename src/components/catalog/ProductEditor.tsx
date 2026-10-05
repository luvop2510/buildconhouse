// Product Editor — the single, shared "single source of truth" editor for a
// catalog product. Every entry point (Catalog product detail, Quotation
// Builder's product sheet, and any future Purchases integration) renders
// THIS SAME component and writes through the SAME PATCH /products/{id}
// endpoint — there is intentionally no second editor anywhere in the app.
//
// Historical quotations are untouched by design, not by any special-casing
// here: QuotationLineItem snapshots name/sku/unit_price/finish/colour/image
// onto the quotation document at the moment a product is added (see
// backend/models.py + the /quotations/{id}/items endpoint), so this editor
// only ever changes what FUTURE additions will copy in.
import { useEffect, useMemo, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { api, csrfHeaders, getToken } from "@/src/api/client";
import { ProductImageManagerBody } from "@/src/components/catalog/ProductImageManager";
import { ProductImage } from "@/src/components/ProductImage";
import { toast } from "@/src/components/Toast";
import { Button, Dropdown, Sheet, TextField } from "@/src/components/ds";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";
import { uriToBlob } from "@/src/utils/uriToBlob";

type LookupItem = { id: string; name: string };

type EditableProduct = {
  id: string; name: string; sku: string; brand_id: string; category_id: string;
  family_name: string; finish: string; colour: string;
  description: string; mrp: number; price: number;
  dimension_image_urls: string[]; seat_cover_image_urls: string[];
  concealed_sku: string; concealed_name: string; concealed_price: number;
};

const TABS = ["General", "Pricing", "Media"] as const;
type Tab = (typeof TABS)[number];

export function ProductEditor({
  productId, visible, onClose, onSaved, initialTab = "General",
}: {
  productId: string | null;
  visible: boolean;
  onClose: () => void;
  /** Fired with the fresh product doc right after a successful save, so
   * every screen that opened this editor can update its own local copy
   * (BuilderContext.patchProduct, a plain refetch, etc.) without reloading
   * the page — the backend already flips the shared catalog cache; this is
   * what makes each OPEN screen behind the editor reflect it too. */
  onSaved?: (updated: Record<string, unknown>) => void;
  initialTab?: Tab;
}) {
  const { isPhone } = useBp();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brands, setBrands] = useState<LookupItem[]>([]);
  const [categories, setCategories] = useState<LookupItem[]>([]);
  const [original, setOriginal] = useState<EditableProduct | null>(null);
  const [form, setForm] = useState<EditableProduct | null>(null);
  const [uploadingKind, setUploadingKind] = useState<"dimension" | "seat_cover" | null>(null);

  useEffect(() => { if (visible) setTab(initialTab); }, [visible, initialTab]);

  useEffect(() => {
    if (!visible || !productId) { setForm(null); setOriginal(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [prod, b, c] = await Promise.all([
          api.get<Record<string, any>>(`/products/${productId}`),
          api.get<LookupItem[]>("/brands"),
          api.get<LookupItem[]>("/categories"),
        ]);
        if (cancelled) return;
        const editable: EditableProduct = {
          id: prod.id, name: prod.name || "", sku: prod.sku || "",
          brand_id: prod.brand_id || "", category_id: prod.category_id || "",
          family_name: prod.family_name || "", finish: prod.finish || "", colour: prod.colour || "",
          description: prod.description || "", mrp: Number(prod.mrp) || 0, price: Number(prod.price) || 0,
          dimension_image_urls: prod.dimension_image_urls || [],
          seat_cover_image_urls: prod.seat_cover_image_urls || [],
          concealed_sku: prod.concealed_part?.sku || prod.concealed_sku || "", concealed_name: prod.concealed_part?.name || "", concealed_price: Number(prod.concealed_part?.unit_price) || 0,
        };
        setOriginal(editable);
        setForm(editable);
        setBrands(b || []); setCategories(c || []);
      } catch (e: any) {
        toast.error(e?.message || "Couldn't load product");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, productId]);

  const dirty = useMemo(() => {
    if (!original || !form) return {} as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    (Object.keys(form) as (keyof EditableProduct)[]).forEach((k) => {
      if (k === "id") return;
      if (JSON.stringify(form[k]) !== JSON.stringify(original[k])) out[k] = form[k];
    });
    if ("concealed_sku" in out || "concealed_name" in out || "concealed_price" in out) {
      const sku = form.concealed_sku.trim();
      out.concealed_part = sku ? { sku, name: form.concealed_name.trim() || null, unit_price: form.concealed_price || null, qty: 1 } : null;
      out.must_buy_concealed = Boolean(sku); out.concealed_sku = sku || null;
      delete out.concealed_name; delete out.concealed_price;
    }
    return out;
  }, [original, form]);
  const hasChanges = Object.keys(dirty).length > 0;

  const save = async () => {
    if (!productId || !hasChanges) return;
    setSaving(true);
    try {
      const updated = await api.patch<Record<string, unknown>>(`/products/${productId}`, dirty);
      toast.success("Product updated everywhere it's shown");
      setOriginal((cur) => (cur ? { ...cur, ...dirty } : cur));
      onSaved?.(updated);
    } catch (e: any) {
      toast.error(e?.message || "Couldn't save changes");
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof EditableProduct>(k: K, v: EditableProduct[K]) =>
    setForm((cur) => (cur ? { ...cur, [k]: v } : cur));

  const brandName = brands.find((b) => b.id === form?.brand_id)?.name || "Select brand";
  const categoryName = categories.find((c) => c.id === form?.category_id)?.name || "Select category";
  const addDiagramPhoto = async (kind: "dimension" | "seat_cover") => {
    if (!productId || !form) return;
    // Image-only selection uses the system picker without broad library access.
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setUploadingKind(kind);
    try {
      const token = await getToken();
      const mimeType = asset.mimeType || "image/jpeg";
      const formData = new FormData();
      formData.append("file", await uriToBlob(asset.uri), `diagram-${kind}.${mimeType.split("/")[1] || "jpg"}`);
      const response = await fetch(`${api.base}/api/products/${productId}/diagram-media?kind=${kind}`, {
        method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...csrfHeaders() }, body: formData,
      });
      if (!response.ok) throw new Error(await response.text() || `Upload failed (${response.status})`);
      const updated = await response.json();
      const fields = {
        dimension_image_urls: updated.dimension_image_urls || [],
        seat_cover_image_urls: updated.seat_cover_image_urls || [],
      };
      setForm((current) => current ? { ...current, ...fields } : current);
      setOriginal((current) => current ? { ...current, ...fields } : current);
      onSaved?.(updated);
      toast.success(kind === "dimension" ? "Dimension photo added" : "Seat-cover photo added");
    } catch (error: any) {
      toast.error(error?.message || "Couldn't upload photo");
    } finally { setUploadingKind(null); }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Edit product"
      subtitle={form?.name}
      variant="drawer"
      width={640}
      testID="product-editor"
      footer={tab !== "Media" ? (
        <>
          <Button label="Cancel" variant="secondary" onPress={onClose} size="md" testID="product-editor-cancel" />
          <View style={{ flex: 1 }} />
          <Button
            label={hasChanges ? "Save changes" : "Saved"} onPress={save} loading={saving}
            disabled={!hasChanges} size="md" testID="product-editor-save"
          />
        </>
      ) : undefined}
    >
      <View style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((t) => (
          <Pressable
            key={t} onPress={() => setTab(t)}
            style={[styles.tab, tab === t && styles.tabActive]}
            accessibilityRole="tab"
            accessibilityLabel={`${t} tab`}
            accessibilityState={{ selected: tab === t }}
            testID={`product-editor-tab-${t.toLowerCase()}`}
          >
            <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>

      {loading || !form ? (
        <View style={{ padding: spacing.xxl, alignItems: "center" }}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : tab === "Media" ? (
        <ScrollView contentContainerStyle={{ gap: spacing.lg, paddingBottom: spacing.xl }}>
            <View style={{ padding: spacing.lg, gap: spacing.md }} testID="diagram-media-editor">
              <Text style={type.label}>Specification photos · {form.sku}</Text>
              <Text style={type.caption}>Upload a custom dimension diagram for this product code. Diagrams appear beside product images when included in a quotation PDF.</Text>
              {([
                { key: "dimension_image_urls", kind: "dimension", title: "Dimension diagrams" },
                { key: "seat_cover_image_urls", kind: "seat_cover", title: "Seat-cover photos" },
              ] as const).map((group) => (
                <View key={group.key} style={{ gap: spacing.sm }}>
                  <Text style={type.label}>{group.title}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                    {form[group.key].map((url, index) => (
                      <View key={`${url}-${index}`} style={{ width: 130, gap: 4 }}>
                        <ProductImage source={url} style={{ width: 130, height: 110 }} contentFit="contain" fallbackLabel={form.sku} />
                        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${group.title.toLowerCase()} photo ${index + 1}`}
                          onPress={() => set(group.key, form[group.key].filter((_, i) => i !== index))}
                          testID={`diagram-remove-${group.kind}-${index}`}>
                          <Text style={{ color: colors.error, fontSize: 12 }}>Remove</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                  <Button label={`Add ${group.kind === "dimension" ? "dimension diagram" : "seat-cover photo"}`}
                    onPress={() => addDiagramPhoto(group.kind)} loading={uploadingKind === group.kind}
                    disabled={!!uploadingKind} testID={`diagram-add-${group.kind}`} />
                </View>
              ))}
              {hasChanges ? <Button label="Save photo removals" onPress={save} loading={saving} testID="diagram-save-media" /> : null}
            </View>
          <ProductImageManagerBody productId={form.id} />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }} keyboardShouldPersistTaps="handled">
          {tab === "General" ? (
            <>
              <TextField label="Product name" value={form.name} onChangeText={(v) => set("name", v)} testID="edit-name" />
              <TextField label="SKU" value={form.sku} onChangeText={(v) => set("sku", v)} testID="edit-sku" autoCapitalize="characters" />
              <View style={{ gap: 6 }}>
                <Text style={type.label}>Brand</Text>
                <Dropdown
                  label={brandName} variant="secondary" testID="edit-brand"
                  items={brands.map((b) => ({ label: b.name, onPress: () => set("brand_id", b.id) }))}
                />
              </View>
              <View style={{ gap: 6 }}>
                <Text style={type.label}>Category</Text>
                <Dropdown
                  label={categoryName} variant="secondary" testID="edit-category"
                  items={categories.map((c) => ({ label: c.name, onPress: () => set("category_id", c.id) }))}
                />
              </View>
              <TextField label="Family" value={form.family_name} onChangeText={(v) => set("family_name", v)} testID="edit-family" />
              <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <TextField label="Finish" value={form.finish} onChangeText={(v) => set("finish", v)} testID="edit-finish" />
                </View>
                <View style={{ flex: 1 }}>
                  <TextField label="Colour" value={form.colour} onChangeText={(v) => set("colour", v)} testID="edit-colour" />
                </View>
              </View>
              <TextField
                label="Description" value={form.description} onChangeText={(v) => set("description", v)}
                multiline numberOfLines={4} style={{ minHeight: 90, textAlignVertical: "top" }} testID="edit-description"
              />
              <View style={{ gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary }}>
                <Text style={type.label}>Default concealed part</Text>
                <Text style={type.caption}>Automatically added in new quotations. Replace or clear it here at any time.</Text>
                <TextField label="Concealed SKU" value={form.concealed_sku} onChangeText={(v) => set("concealed_sku", v)} testID="edit-concealed-sku" autoCapitalize="characters" />
                <TextField label="Part name (optional)" value={form.concealed_name} onChangeText={(v) => set("concealed_name", v)} testID="edit-concealed-name" />
                <TextField label="Unit price (optional)" value={form.concealed_price ? String(form.concealed_price) : ""} keyboardType="decimal-pad" onChangeText={(v) => set("concealed_price", Number(v.replace(/[^0-9.]/g, "")) || 0)} testID="edit-concealed-price" />
              </View>
            </>
          ) : (
            <>
              <TextField
                label="MRP (₹)" value={String(form.mrp)} keyboardType="decimal-pad" testID="edit-mrp"
                onChangeText={(v) => set("mrp", Number(v.replace(/[^0-9.]/g, "")) || 0)}
              />
              <TextField
                label="Offer price (₹)" helper="Leave equal to MRP for no discount." value={String(form.price)}
                keyboardType="decimal-pad" testID="edit-price"
                onChangeText={(v) => set("price", Number(v.replace(/[^0-9.]/g, "")) || 0)}
              />
              <View style={styles.currencyRow}>
                <Text style={type.label}>Currency</Text>
                <Text style={type.body}>₹ INR (fixed — Forge is single-currency)</Text>
              </View>
              <Text style={[type.caption, { marginTop: spacing.sm }]}>
                Quotations already sent to customers keep the prices they were created with —
                this only affects the catalog price used by quotations, purchases, and the
                customer portal from now on.
              </Text>
            </>
          )}
        </ScrollView>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  tab: { paddingVertical: spacing.sm, paddingHorizontal: spacing.xs, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: colors.brand },
  tabLabel: { fontSize: 13, fontWeight: "600", color: colors.onSurfaceMuted },
  tabLabelActive: { color: colors.brand },
  currencyRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.xs,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
  },
});
