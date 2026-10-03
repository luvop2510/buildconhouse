import { Overlay } from "@/src/design/Overlay";
// ProductModal — the premium floating product modal in V4.
// Opens when a product card is tapped/quick-previewed. Shows gallery, color
// swatches, finish selector, dimensions, description, warranty, editable
// price, quantity, Add / Add & Continue / Favourite. Also surfaces
// Alternatives (via /alternates) and Complete-the-set (via /complete-the-set)
// so the salesperson can extend the quotation without leaving the modal.
// -----------------------------------------------------------------------------
import { Feather } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { ProductImage } from "@/src/components/ProductImage";
import { ProductEditor } from "@/src/components/catalog/ProductEditor";
import { toast } from "@/src/components/Toast";
import { useAuth } from "@/src/state/auth";
import { colors, money, PRODUCT_IMAGE_ASPECT_RATIO, radius, shadow, spacing } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";
import { useBp } from "@/src/design/responsive";
import { useBuilder } from "../context/BuilderContext";
import { productImageList, resolveVariantImages } from "../helpers/media";
import { variantDescriptor } from "../helpers/pricing";
import type { Product, ProductVariant } from "../helpers/types";
import { catalogPriceUnknown, manualCatalogPrice } from "../helpers/catalogSource";
import { SupplierSourceDetails } from "@/src/components/catalog/SupplierSourceDetails";

function productAsVariant(product: Product): ProductVariant {
  return {
    id: product.id, sku: product.sku, name: product.name,
    finish: product.finish ?? null, finish_code: product.finish_code ?? null,
    size: product.size ?? null, colour: product.colour ?? null,
    variant_label: product.variant_label ?? null,
    price: product.price, mrp: product.mrp, stock: product.stock ?? 0,
    price_unknown: product.price_unknown,
    dimensions: product.dimensions ?? null, material: product.material ?? null,
    dimension_image_urls: product.dimension_image_urls ?? [],
    seat_cover_image_urls: product.seat_cover_image_urls ?? [],
    warranty: product.warranty ?? null, specs: product.specs ?? null,
    description: product.description ?? null,
    image: product.hero_image_url ?? productImageList(product)[0] ?? null,
    concealed_part: product.concealed_part ?? null,
    configuration_options: product.configuration_options ?? [],
  };
}

function automaticParts(product: Product, variant: ProductVariant | null): { name?: string | null; sku: string }[] {
  const raw = variant?.specs?.default_included_parts ?? product.specs?.default_included_parts;
  if (!Array.isArray(raw)) return [];
  return raw.filter((part): part is { name?: string | null; sku: string } => (
    !!part && typeof part === "object" && typeof part.sku === "string" && !!part.sku.trim()
  ));
}

export function ProductModal() {
  const b = useBuilder();
  const { staff } = useAuth();
  const canEditProduct = !!staff && ["owner", "admin", "manager", "accounts", "purchase"].includes(staff.role);
  const open = !!b.productModal;
  const product = b.productModal;
  const { isPhone } = useBp();
  const isCompactFooter = isPhone;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<"General" | "Media">("General");
  const [concealQuery, setConcealQuery] = useState("");
  const [concealMatches, setConcealMatches] = useState<Product[]>([]);
  const [quotationConceal, setQuotationConceal] = useState<Product | null>(null);
  const [stockQty, setStockQty] = useState(1);
  const [stockBusy, setStockBusy] = useState(false);

  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [qty, setQty] = useState(1);
  const [priceOverride, setPriceOverride] = useState<string>("");
  const [excludeDimension, setExcludeDimension] = useState(false);
  const [notes, setNotes] = useState<string>("");
  const [alternates, setAlternates] = useState<Product[]>([]);
  const [completeSet, setCompleteSet] = useState<Product[]>([]);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [activeImageIdx, setActiveImageIdx] = useState(0);
  const [sourceEntries, setSourceEntries] = useState<Product["catalog_entries"]>([]);

  // Family cards contain all sibling SKUs, including their own SKU-specific
  // commercial/specification values. A selected finish must therefore replace
  // the displayed detail record, rather than merely changing the price chip.
  const selectableVariants = useMemo(() => {
    if (!product) return [];
    const variants = product.variants || [];
    return variants.some((variant) => variant.sku === product.sku)
      ? variants
      : [productAsVariant(product), ...variants];
  }, [product]);
  const selectedProduct = useMemo(() => {
    if (!product || !selectedVariant) return product;
    const variant = product.variants?.find((candidate) => candidate.id === selectedVariant.id) ?? selectedVariant;
    const variantColour = variant.colour ?? variant.color ?? product.colour;
    return {
      ...product,
      id: variant.id ?? product.id,
      name: variant.name ?? product.name,
      sku: variant.sku,
      finish: variant.finish ?? product.finish,
      finish_code: variant.finish_code ?? product.finish_code,
      variant_label: variant.variant_label ?? product.variant_label,
      colour: variantColour,
      size: variant.size ?? product.size,
      price: variant.price ?? product.price,
      price_unknown: variant.price_unknown ?? product.price_unknown,
      listing_id: variant.listing_id,
      catalog_entries: variant.id === product.id ? product.catalog_entries : undefined,
      mrp: variant.mrp ?? product.mrp,
      stock: variant.stock ?? product.stock,
      dimensions: variant.dimensions ?? product.dimensions,
      dimension_image_urls: variant.dimension_image_urls ?? product.dimension_image_urls,
      seat_cover_image_urls: variant.seat_cover_image_urls ?? product.seat_cover_image_urls,
      material: variant.material ?? product.material,
      warranty: variant.warranty ?? product.warranty,
      specs: variant.specs ?? product.specs,
      description: variant.description ?? product.description,
      concealed_part: variant.concealed_part ?? product.concealed_part,
      configuration_options: variant.configuration_options ?? product.configuration_options,
    };
  }, [product, selectedVariant]);

  useEffect(() => {
    setSourceEntries(selectedProduct?.catalog_entries || []);
    if (!selectedProduct || selectedProduct.catalog_entries) return;
    let active = true;
    const entryParam = selectedProduct.listing_id ? `?catalog_entry_id=${encodeURIComponent(selectedProduct.listing_id)}` : "";
    api.get<Product>(`/products/${selectedProduct.id}${entryParam}`).then((details) => {
      if (active) setSourceEntries(details.catalog_entries || []);
    }).catch(() => {});
    return () => { active = false; };
  }, [selectedProduct]);

  // Reset when product changes.
  useEffect(() => {
    if (!product) return;
    setSelectedVariant(null);
    setQty(1);
    setPriceOverride("");
    setExcludeDimension(false);
    setNotes("");
    setAlternates([]);
    setCompleteSet([]);
    setActiveImageIdx(0);
    setConcealQuery("");
    setConcealMatches([]);
    setQuotationConceal(null);
    setStockQty(1);
    (async () => {
      try {
        const [alt, set] = await Promise.all([
          api.get<{ items: Product[] }>(`/products/${product.id}/alternates?limit=8`),
          api.get<{ items: Product[] }>(`/products/${product.id}/complete-the-set?limit=6`),
        ]);
        setAlternates(alt.items || []);
        setCompleteSet(set.items || []);
      } catch {}
    })();
  }, [product]);

  useEffect(() => {
    const query = concealQuery.trim();
    if (!query || quotationConceal?.sku === query) { setConcealMatches([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api.get<{ items: Product[] }>(`/products?q=${encodeURIComponent(query)}&limit=20`);
        if (!cancelled) setConcealMatches((result.items || []).filter((item) => item.sku.toLowerCase().startsWith(query.toLowerCase()) && item.id !== selectedProduct?.id));
      } catch { if (!cancelled) setConcealMatches([]); }
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [concealQuery, quotationConceal, selectedProduct?.id]);

  const currentPrice = useMemo(() => {
    if (priceOverride) {
      const n = Number(priceOverride);
      return isNaN(n) ? (selectedVariant?.price ?? product?.price ?? 0) : n;
    }
    return selectedVariant?.price ?? product?.price ?? 0;
  }, [priceOverride, selectedVariant, product]);

  // Variant-aware gallery — when a finish/colour is selected AND that
  // sibling product has its own real photo, it takes priority; the base
  // product's gallery always follows as fallback/additional angles. When the
  // selected finish has NO photo of its own (a real gap in some supplier
  // rows), resolveVariantImages() falls back to any sibling finish's photo
  // rather than leaving the gallery empty — isFallback flags that case so we
  // can say "Representative photo" instead of silently implying it's exact.
  const { images: heroImages, isFallback: heroIsFallback } = useMemo(() => {
    if (!product) return { images: [] as string[], isFallback: false };
    return resolveVariantImages(product, selectedVariant);
  }, [product, selectedVariant]);

  const heroImageKey = heroImages.join("|");
  useEffect(() => {
    setActiveImageIdx(0);
  }, [heroImageKey]);

  const activeImage = heroImages[Math.min(activeImageIdx, Math.max(0, heroImages.length - 1))];

  if (!product || !selectedProduct) return null;

  const includedParts = automaticParts(selectedProduct, selectedVariant);
  const concealedPart = selectedVariant?.concealed_part ?? selectedProduct.concealed_part;
  const configurationOptions = selectedProduct.configuration_options || [];

  const chooseConfiguration = async (productId: string) => {
    if (productId === selectedProduct.id) return;
    try {
      b.openProductModal(await api.get<Product>(`/products/${productId}`));
    } catch {
      toast.error("Could not load this product configuration");
    }
  };

  const commit = (closeAfter: boolean) => {
    if (catalogPriceUnknown(product, selectedVariant) && manualCatalogPrice(priceOverride) === null) {
      toast.error("Enter a selling price before adding this item");
      return;
    }
    if (!Number.isFinite(currentPrice) || currentPrice < 0) {
      toast.error("Enter a valid selling price");
      return;
    }
    if (concealQuery.trim() && !quotationConceal) { toast.error("Select a concealed part from the catalog"); return; }
    const v = selectedVariant ?? productAsVariant(product);
    // Custom price / quantity override via a synthetic variant — keeps
    // the existing addFromProduct path a single source of truth.
    const custom: ProductVariant = { ...v, price: currentPrice,
      price_unknown: manualCatalogPrice(priceOverride) !== null ? false : catalogPriceUnknown(product, selectedVariant),
      exclude_dimension: excludeDimension,
      concealed_part: quotationConceal ? {
        product_id: quotationConceal.id, sku: quotationConceal.sku, name: quotationConceal.name,
        unit_price: quotationConceal.price, mrp: quotationConceal.mrp,
        image: productImageList(quotationConceal)[0] ?? null, qty: 1,
      } : v.concealed_part,
    };
    const qtyAdded = Math.max(1, Math.floor(qty));
    for (let i = 0; i < qtyAdded; i++) b.addFromProduct(product, custom);
    if (notes.trim() && b.s.lines.length) {
      // Attach notes to the just-added line (the last one).
      const last = b.s.lines[b.s.lines.length - 1];
      if (last) b.updateLine(last.id, { notes: notes.trim() });
    }
    toast.success(qtyAdded > 1 ? `${qtyAdded} × ${product.name} added` : `${product.name} added to quotation`);
    if (closeAfter) b.closeProductModal();
  };

  const moveToGodown = async () => {
    if (stockBusy) return;
    setStockBusy(true);
    try {
      await api.post("/godown-stock/direct-intakes", { product_id: selectedProduct.id, qty: stockQty });
      toast.success(`${stockQty} × ${selectedProduct.name} added to godown stock`);
    } catch (e: any) { toast.error(e?.detail || "Could not add to godown stock"); }
    finally { setStockBusy(false); }
  };

  return (
    <>
    <Overlay open={open && !editorOpen} onClose={b.closeProductModal} title={selectedProduct.name} width={960} presentation={isPhone ? "fullscreen" : "dialog"} scroll={false} header={false}>
        <View style={{ flex: 1, minHeight: 0 }}>
          {/* Header */}
          <View style={[styles.header, isPhone && styles.headerPhone]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.crumb}>{product.brand_name || "Product"}{product.collection ? ` · ${product.collection}` : ""}</Text>
              <Text style={styles.title} numberOfLines={2}>{selectedProduct.name}</Text>
              <Text style={styles.sku}>{selectedProduct.sku}</Text>
            </View>
            {canEditProduct ? (
              <Pressable onPress={() => { setEditorTab("General"); setEditorOpen(true); }} style={[styles.editBtn, isPhone && styles.editBtnPhone]} hitSlop={6} testID="product-modal-edit" accessibilityLabel="Edit product">
                <Feather name="edit-2" size={14} color={colors.onSurfaceSecondary} />
                {!isPhone ? <Text style={styles.editBtnLabel}>Edit product</Text> : null}
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Close product details" onPress={b.closeProductModal} style={styles.close} hitSlop={6}>
              <Feather name="x" size={18} color={colors.onSurface} />
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16 }}>
            <View style={[styles.body, isPhone && styles.bodyPhone]}>
              {/* Left: gallery + price */}
              <View style={[styles.left, isPhone && styles.leftPhone]}>
                <Pressable onPress={() => setZoomOpen(true)} disabled={!activeImage} testID="pm-hero-zoom">
                  {/* No `key` here on purpose — keeping the same ProductImage
                      instance across finish switches lets expo-image's own
                      transition crossfade smoothly between photos instead of
                      unmounting/remounting (which was causing a flash to the
                      empty/skeleton state on every swatch tap). */}
                  <ProductImage source={activeImage ? [activeImage] : []} style={styles.hero} fallbackLabel={selectedProduct.sku} preferOriginal transition={180} />
                  {activeImage ? (
                    <View style={styles.zoomHint}>
                      <Feather name="maximize-2" size={11} color="#fff" />
                    </View>
                  ) : null}
                </Pressable>
                {activeImage && heroIsFallback ? (
                  <Text style={styles.repImageNote}>Representative photo — exact finish photo not available</Text>
                ) : null}
                {heroImages.length > 1 ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 8 }}>
                    {heroImages.slice(0, 8).map((url, i) => (
                      <Pressable key={`${url}-${i}`} onPress={() => setActiveImageIdx(i)} style={[styles.thumb, i === activeImageIdx && styles.thumbActive]}>
                        <ProductImage source={[url]} style={{ width: "100%", height: "100%" }} fallbackLabel={selectedProduct.sku} disableSkeleton />
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : null}

                <View style={styles.priceCard}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                    <Text style={styles.priceBig} numberOfLines={1}>{catalogPriceUnknown(product, selectedVariant) && manualCatalogPrice(priceOverride) === null ? "Price unavailable" : money(currentPrice)}</Text>
                    {!catalogPriceUnknown(product, selectedVariant) && selectedProduct.mrp && selectedProduct.mrp > currentPrice ? (
                      <Text style={styles.mrpBig} numberOfLines={1}>{money(selectedProduct.mrp)}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.priceHint}>Editable selling price · MRP shown for reference</Text>
                  <TextInput
                    placeholder={selectedProduct.price_unknown ? "Enter selling price" : String(selectedProduct.price)}
                    placeholderTextColor={colors.onSurfaceMuted}
                    keyboardType="numeric"
                    value={priceOverride}
                    onChangeText={setPriceOverride}
                    style={styles.priceInput}
                    testID="pm-price-input"
                  />
                </View>
              </View>

              {/* Right: details */}
              <View style={[styles.right, isPhone && styles.rightPhone]}>
                <SupplierSourceDetails entries={sourceEntries} />
                {/* Variants / finishes */}
                {selectableVariants.length > 1 ? (
                  <View style={{ gap: 6 }}>
                    <Text style={styles.sectionLabel}>Available finishes</Text>
                    <View style={styles.variantRow}>
                      {selectableVariants.map((v) => {
                        const on = selectedProduct.sku === v.sku;
                        return (
                          <Pressable
                            key={v.sku}
                            accessibilityRole="button"
                            accessibilityState={{ selected: on }}
                            accessibilityLabel={`${variantDescriptor(v) || v.sku}${on ? ", selected" : ""}`}
                            onPress={() => {
                              if (on) return;
                              setSelectedVariant(v.sku === product.sku ? null : v);
                              setActiveImageIdx(0);
                            }}
                            style={[styles.variantChip, on && styles.variantChipActive]}
                            testID={`pm-variant-${v.sku}`}
                          >
                            <View style={[styles.swatch, { backgroundColor: colourHex(v.colour ?? v.color ?? v.finish) }]} />
                            <Text style={[styles.variantLabel, on && { color: colors.onBrand }]}>{variantDescriptor(v) || v.sku}</Text>
                            {v.price !== product.price ? (
                              <Text style={[styles.variantDelta, on && { color: colors.onBrand }]}>
                                {v.price > product.price ? "+" : ""}{money(v.price - product.price)}
                              </Text>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}

                {configurationOptions.length > 1 ? (
                  <View style={{ gap: 6 }} testID="pm-configuration-options">
                    <Text style={styles.sectionLabel}>Configuration</Text>
                    <View style={styles.variantRow}>
                      {configurationOptions.map((option) => {
                        const active = option.id === selectedProduct.id;
                        return (
                          <Pressable
                            key={option.id}
                            disabled={active}
                            onPress={() => chooseConfiguration(option.id)}
                            style={[styles.variantChip, active && styles.variantChipActive]}
                            testID={`pm-configuration-${option.sku}`}
                          >
                            <Text style={[styles.variantLabel, active && { color: colors.onBrand }]}>{option.label}</Text>
                            {option.price !== selectedProduct.price ? (
                              <Text style={[styles.variantDelta, active && { color: colors.onBrand }]}>
                                {option.price > selectedProduct.price ? "+" : ""}{money(option.price - selectedProduct.price)}
                              </Text>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}

                <View style={styles.specGrid}>
                  {[
                    ["Category", (selectedProduct as any).category_name || "—"],
                    ["Collection", selectedProduct.collection || selectedProduct.series || "—"],
                    ["Finish", variantDescriptor(selectedProduct) || "—"],
                    ["Warranty", selectedProduct.warranty || "—"],
                    ["Stock", (selectedProduct.stock ?? "—") + ""],
                  ].map(([label, val]) => (
                    <View key={label} style={styles.specCell}>
                      <Text style={styles.specLabel}>{label}</Text>
                      <Text style={styles.specVal} numberOfLines={2}>{val}</Text>
                    </View>
                  ))}
                </View>

                {(selectedProduct.dimension_image_urls?.length || selectedProduct.seat_cover_image_urls?.length) ? (
                  <View style={{ gap: 10 }} testID="pm-spec-photos">
                    {([
                      { label: "Dimension diagrams", urls: selectedProduct.dimension_image_urls || [] },
                      { label: "Seat-cover photos", urls: selectedProduct.seat_cover_image_urls || [] },
                    ]).filter((group) => group.urls.length > 0).map((group) => (
                      <View key={group.label} style={{ gap: 6 }}>
                        <Text style={styles.sectionLabel}>{group.label}</Text>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                          {group.urls.map((url, index) => (
                            <ProductImage key={`${url}-${index}`} source={url}
                              style={{ width: 112, height: 90 }} contentFit="contain" fallbackLabel={selectedProduct.sku} />
                          ))}
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}
                <View style={{ gap: 8 }}>
                  <Text style={styles.sectionLabel}>Dimension diagrams in PDF</Text>
                  {canEditProduct ? <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add dimension diagram"
                    testID="pm-add-dimension-diagram"
                    onPress={() => { setEditorTab("Media"); setEditorOpen(true); }}
                  ><Text style={styles.specVal}>Add a custom dimension diagram</Text></Pressable> : null}
                  <Pressable
                    testID="pm-exclude-dimension"
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: excludeDimension }}
                    onPress={() => setExcludeDimension((value) => !value)}
                    style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
                  >
                    <Feather name={excludeDimension ? "check-square" : "square"} size={18} color={colors.onSurface} />
                    <Text style={styles.specVal}>Exclude diagram from PDF</Text>
                  </Pressable>
                </View>

                {selectedProduct.description ? (
                  <View style={{ gap: 4 }}>
                    <Text style={styles.sectionLabel}>Description</Text>
                    <Text style={styles.desc}>{selectedProduct.description}</Text>
                  </View>
                ) : null}

                {(includedParts.length > 0 || concealedPart?.sku) ? (
                  <View style={styles.autoParts} testID="pm-automatic-parts">
                    <Text style={styles.sectionLabel}>Added automatically</Text>
                    {includedParts.map((part) => (
                      <Text key={part.sku} style={styles.autoPartText}>
                        {part.name || `Seat cover · ${part.sku}`}
                      </Text>
                    ))}
                    {concealedPart?.sku ? (
                      <Text style={styles.autoPartText}>
                        {concealedPart.name || `Concealed part · ${concealedPart.sku}`}
                      </Text>
                    ) : null}
                    <Text style={styles.autoPartHint}>Saved with this quotation when you add the product.</Text>
                  </View>
                ) : null}

                <View style={styles.autoParts} testID="pm-quotation-conceal">
                  <Text style={styles.sectionLabel}>Concealed part for this quotation</Text>
                  <Text style={styles.autoPartHint}>Choose a catalog SKU for this product only.</Text>
                  <TextInput value={concealQuery} onChangeText={(value) => { setConcealQuery(value); setQuotationConceal(null); }}
                    placeholder="Search concealed part SKU" placeholderTextColor={colors.onSurfaceMuted}
                    style={styles.notesInput} testID="pm-conceal-sku" autoCapitalize="characters" />
                  {concealMatches.slice(0, 8).map((item) => (
                    <Pressable key={item.id} onPress={() => { setQuotationConceal(item); setConcealQuery(item.sku); setConcealMatches([]); }}
                      style={styles.stockAction} testID={`pm-conceal-option-${item.sku}`}>
                      <Text style={styles.autoPartText}>{item.sku} · {item.name}</Text>
                    </Pressable>
                  ))}
                  {quotationConceal ? <Text style={styles.autoPartText}>Selected: {quotationConceal.name}</Text> : null}
                  {quotationConceal ? <Pressable onPress={() => { setQuotationConceal(null); setConcealQuery(""); }}><Text style={styles.autoPartHint}>Remove selection</Text></Pressable> : null}
                </View>

                <View style={styles.autoParts} testID="pm-godown-action">
                  <Text style={styles.sectionLabel}>Godown stock</Text>
                  <View style={styles.qtyRow}>
                    <Text style={styles.autoPartHint}>Quantity to add</Text>
                    <View style={styles.qtyStepper}>
                      <Pressable onPress={() => setStockQty((n) => Math.max(1, n - 1))} style={styles.qtyBtn}><Feather name="minus" size={14} color={colors.onSurface} /></Pressable>
                      <TextInput value={String(stockQty)} onChangeText={(value) => setStockQty(Math.max(1, Math.floor(Number(value.replace(/[^0-9]/g, "")) || 1)))} style={styles.qtyInput} keyboardType="number-pad" testID="pm-godown-qty" />
                      <Pressable onPress={() => setStockQty((n) => n + 1)} style={styles.qtyBtn}><Feather name="plus" size={14} color={colors.onSurface} /></Pressable>
                    </View>
                  </View>
                  <Pressable onPress={moveToGodown} disabled={stockBusy} style={styles.stockAction} testID="pm-add-to-godown">
                    <Feather name="package" size={14} color={colors.onSurface} />
                    <Text style={styles.autoPartText}>{stockBusy ? "Adding…" : "Add to godown stock"}</Text>
                  </Pressable>
                </View>

                {/* Quantity + notes */}
                <View style={styles.qtyRow}>
                  <Text style={styles.sectionLabel}>Quantity</Text>
                  <View style={styles.qtyStepper}>
                    <Pressable onPress={() => setQty((n) => Math.max(1, n - 1))} style={styles.qtyBtn} testID="pm-qty-minus">
                      <Feather name="minus" size={14} color={colors.onSurface} />
                    </Pressable>
                    <TextInput
                      value={String(qty)}
                      onChangeText={(v) => setQty(Math.max(1, Math.floor(Number(v.replace(/[^0-9]/g, "")) || 1)))}
                      style={styles.qtyInput}
                      keyboardType="number-pad"
                    />
                    <Pressable onPress={() => setQty((n) => n + 1)} style={styles.qtyBtn} testID="pm-qty-plus">
                      <Feather name="plus" size={14} color={colors.onSurface} />
                    </Pressable>
                  </View>
                </View>

                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Notes (optional)"
                  placeholderTextColor={colors.onSurfaceMuted}
                  style={styles.notesInput}
                  multiline
                />
              </View>
            </View>

            {/* Alternatives */}
            {alternates.length ? (
              <View style={styles.relSection}>
                <View style={styles.relHead}>
                  <Text style={styles.relTitle}>Alternatives</Text>
                  <Text style={styles.relHint}>Same category — tap to swap into this modal</Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingHorizontal: 20, paddingBottom: 6 }}>
                  {alternates.map((alt) => (
                    <Pressable
                      key={alt.id}
                      onPress={() => b.openProductModal(alt)}
                      style={styles.relCard}
                    >
                      <ProductImage source={productImageList(alt)} style={styles.relThumb} fallbackLabel={alt.sku} />
                      <Text style={styles.relName} numberOfLines={2}>{alt.name}</Text>
                      <Text style={styles.relPrice}>{alt.price_unknown ? "Price unavailable" : money(alt.price)}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {completeSet.length ? (
              <View style={styles.relSection}>
                <View style={styles.relHead}>
                  <Text style={styles.relTitle}>Complete the set</Text>
                  <Text style={styles.relHint}>From the same collection — tap to add to quotation</Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingHorizontal: 20, paddingBottom: 6 }}>
                  {completeSet.map((s) => (
                    <Pressable
                      key={s.id}
                      onPress={() => { if (s.price_unknown) { b.openProductModal(s); return; } b.addFromProduct(s); toast.success(`${s.name} added to quotation`); }}
                      style={styles.relCard}
                    >
                      <ProductImage source={productImageList(s)} style={styles.relThumb} fallbackLabel={s.sku} />
                      <Text style={styles.relName} numberOfLines={2}>{s.name}</Text>
                      <Text style={styles.relPrice}>{s.price_unknown ? "Price unavailable" : money(s.price)}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </ScrollView>

          {/* Footer actions — 3 competing actions ("Favourite" / "Add another" /
              "Add to quotation") used to be crammed into a single row that
              never adapted to phone width, forcing the primary CTA to either
              overflow or shrink unpredictably. Below ~480px we stack: a
              secondary row (Favourite + Add another, both compact) sits above
              a full-width primary "Add to quotation" button that's always
              easy to hit with a thumb and never gets squeezed by its
              siblings. Desktop/tablet keep the original single-row layout. */}
          <SafeAreaView edges={isPhone ? ["bottom"] : []} style={styles.footerSafeArea}>
          {isCompactFooter ? (
            <View style={styles.footerStacked}>
              <View style={styles.footerStackedTopRow}>
                <Pressable onPress={() => b.toggleFavourite(product.id)} style={styles.footerGhost} testID="pm-favourite">
                  <Feather name="heart" size={14} color={b.favouriteIds.includes(product.id) ? ds.brass : colors.onSurface} />
                  <Text style={styles.footerGhostLabel}>{b.favouriteIds.includes(product.id) ? "Favourited" : "Favourite"}</Text>
                </Pressable>
                <Pressable onPress={() => commit(false)} style={[styles.footerSecondary, { flex: 1 }]} testID="pm-add-more">
                  <Text style={styles.footerSecondaryLabel} numberOfLines={1}>Add another</Text>
                </Pressable>
              </View>
              <Pressable onPress={() => commit(true)} style={[styles.footerPrimary, styles.footerPrimaryFull]} testID="pm-add-close">
                <Feather name="plus" size={15} color={colors.onBrand} />
                <Text style={styles.footerPrimaryLabel} numberOfLines={1}>Add to quotation</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.footer}>
              <Pressable
                onPress={() => b.toggleFavourite(product.id)}
                style={styles.footerGhost}
                testID="pm-favourite"
              >
                <Feather name="heart" size={14} color={b.favouriteIds.includes(product.id) ? ds.brass : colors.onSurface} />
                <Text style={styles.footerGhostLabel}>{b.favouriteIds.includes(product.id) ? "Favourited" : "Favourite"}</Text>
              </Pressable>
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => commit(false)} style={styles.footerSecondary} testID="pm-add-more">
                <Text style={styles.footerSecondaryLabel}>Add another</Text>
              </Pressable>
              <Pressable onPress={() => commit(true)} style={styles.footerPrimary} testID="pm-add-close">
                <Feather name="plus" size={14} color={colors.onBrand} />
                <Text style={styles.footerPrimaryLabel}>Add to quotation</Text>
              </Pressable>
            </View>
          )}
          </SafeAreaView>
        </View>
    </Overlay>

    {/* Zoom overlay — tap-to-enlarge the active hero image */}
    <Overlay open={zoomOpen} onClose={() => setZoomOpen(false)} title="Product image" presentation="fullscreen" scroll={false} header={false}>
      <Pressable style={styles.zoomBackdrop} onPress={() => setZoomOpen(false)}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close product image" style={styles.zoomClose} onPress={() => setZoomOpen(false)} hitSlop={8}>
          <Feather name="x" size={20} color="#fff" />
        </Pressable>
        <ProductImage
          source={activeImage ? [activeImage] : []}
          style={styles.zoomImage}
          contentFit="contain"
          preferOriginal
          fallbackLabel={product.sku}
        />
      </Pressable>
    </Overlay>

    {/* Single shared Product Editor — same component used from Catalog. */}
    <ProductEditor
      productId={selectedProduct.id}
      visible={editorOpen}
      initialTab={editorTab}
      onClose={() => setEditorOpen(false)}
      onSaved={(updated) => b.patchProduct(selectedProduct.id, updated)}
    />

    </>
  );
}

// -----------------------------------------------------------------------------
// Tiny colour helper — maps finish/color labels to swatch hex.
// -----------------------------------------------------------------------------
function colourHex(v?: string | null): string {
  if (!v) return colors.borderStrong;
  const s = v.toLowerCase();
  if (s.includes("matt black") || s.includes("black")) return "#111";
  if (s.includes("chrome")) return "#D4D4D8";
  if (s.includes("gold")) return "#D4AF37";
  if (s.includes("brass") || s.includes("bronze")) return "#A97142";
  if (s.includes("brown") || s.includes("red") || s.includes("rose")) return "#8C3B2A";
  if (s.includes("white")) return "#F4F4F5";
  if (s.includes("copper")) return "#B87333";
  if (s.includes("nickel")) return "#B0B7C1";
  if (s.includes("stainless")) return "#8E9099";
  if (s.includes("beige") || s.includes("cream")) return "#EDE6D3";
  return "#B0B7C1";
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: "rgba(9,9,11,0.55)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  phoneBackdrop: { padding: 0, justifyContent: "flex-end" },
  sheet: {
    width: "100%", maxWidth: 960, maxHeight: "92%",
    backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg,
    overflow: "hidden",
    ...shadow.strong,
  },
  phoneSheet: {
    maxWidth: undefined, maxHeight: "96%", borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
  },

  header: {
    flexDirection: "row", padding: spacing.lg, alignItems: "flex-start", gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  headerPhone: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: 8 },
  crumb: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceMuted, letterSpacing: 1.2, textTransform: "uppercase" },
  title: { fontSize: 20, fontWeight: "700", color: colors.onSurface, marginTop: 4, letterSpacing: -0.3 },
  sku: { fontSize: 12, color: colors.onSurfaceMuted, marginTop: 4, fontVariant: ["tabular-nums"] },
  close: {
    width: 32, height: 32, borderRadius: radius.md, alignItems: "center", justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface,
  },
  editBtn: {
    flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start",
    paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.md, marginRight: 8,
    backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  editBtnPhone: { width: 44, height: 44, paddingHorizontal: 0, paddingVertical: 0, justifyContent: "center", marginRight: 0 },
  editBtnLabel: { fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary },

  body: { flexDirection: "row", padding: spacing.lg, gap: spacing.lg, flexWrap: "wrap" },
  bodyPhone: { flexDirection: "column", padding: spacing.md, gap: spacing.md, flexWrap: "nowrap" },
  left: { width: "100%", maxWidth: 300, gap: 12 },
  leftPhone: { maxWidth: undefined },
  right: { flex: 1, minWidth: 260, gap: 14 },
  rightPhone: { width: "100%", minWidth: 0, flex: undefined, gap: 12 },

  hero: { width: "100%", aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary },
  repImageNote: { fontSize: 10, color: colors.onSurfaceMuted, fontStyle: "italic", marginTop: -4 },
  thumb: { width: 52, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: 8, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  thumbActive: { borderWidth: 2, borderColor: ds.brass },
  zoomHint: {
    position: "absolute", bottom: 8, right: 8, width: 26, height: 26, borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center",
  },
  zoomBackdrop: {
    flex: 1, backgroundColor: "rgba(9,9,11,0.92)", alignItems: "center", justifyContent: "center", padding: 24,
  },
  zoomClose: {
    position: "absolute", top: 24, right: 24, width: 40, height: 40, borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center", zIndex: 2,
  },
  zoomImage: { width: "100%", height: "100%", maxWidth: 900 },

  priceCard: {
    padding: 12, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: 6,
  },
  priceBig: { fontSize: 22, fontWeight: "600", color: colors.onSurface, fontVariant: ["tabular-nums"], letterSpacing: -0.3 },
  mrpBig: { fontSize: 12, color: colors.onSurfaceMuted, textDecorationLine: "line-through", fontVariant: ["tabular-nums"] },
  priceHint: { fontSize: 10, color: colors.onSurfaceMuted },
  priceInput: {
    marginTop: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: colors.onSurface,
  },

  sectionLabel: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceMuted, letterSpacing: 1.1, textTransform: "uppercase" },

  variantRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  variantChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    minHeight: 44, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  variantChipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  swatch: { width: 12, height: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  variantLabel: { fontSize: 11, fontWeight: "600", color: colors.onSurfaceSecondary },
  variantDelta: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceMuted, fontVariant: ["tabular-nums"] },

  specGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  specCell: {
    width: "48%", padding: 8, borderRadius: radius.sm,
    backgroundColor: colors.surfaceTertiary,
  },
  specLabel: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceMuted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 2 },
  specVal: { fontSize: 12, fontWeight: "600", color: colors.onSurface },

  desc: { fontSize: 12, lineHeight: 18, color: colors.onSurfaceSecondary },
  autoParts: { gap: 4, padding: 10, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary },
  autoPartText: { fontSize: 12, fontWeight: "600", color: colors.onSurface },
  autoPartHint: { fontSize: 11, color: colors.onSurfaceSecondary },
  stockAction: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 10, borderRadius: radius.sm, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },

  qtyRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  qtyStepper: {
    flexDirection: "row", alignItems: "center", borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface,
  },
  qtyBtn: { paddingHorizontal: 10, paddingVertical: 8 },
  qtyInput: { width: 44, textAlign: "center", fontSize: 13, fontWeight: "700", color: colors.onSurface },

  notesInput: {
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md,
    minHeight: 48, padding: 10, fontSize: 12, color: colors.onSurface, backgroundColor: colors.surface,
  },

  relSection: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingTop: 12, marginTop: 4 },
  relHead: { paddingHorizontal: 20, paddingBottom: 8 },
  relTitle: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  relHint: { fontSize: 11, color: colors.onSurfaceMuted, marginTop: 1 },
  relCard: { width: 130, gap: 4 },
  relThumb: { width: "100%", aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary },
  relName: { fontSize: 11, fontWeight: "600", color: colors.onSurface, marginTop: 4 },
  relPrice: { fontSize: 11, fontWeight: "600", color: colors.onSurface, fontVariant: ["tabular-nums"] },

  footer: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: spacing.lg, paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  footerSafeArea: { backgroundColor: colors.surface },
  footerStacked: {
    gap: 8, paddingHorizontal: spacing.lg, paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  footerStackedTopRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  footerGhost: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.md,
  },
  footerGhostLabel: { fontSize: 12, fontWeight: "600", color: colors.onSurface },
  footerSecondary: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    alignItems: "center",
  },
  footerSecondaryLabel: { fontSize: 12, fontWeight: "700", color: colors.onSurface },
  footerPrimary: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.md, backgroundColor: colors.brand,
  },
  footerPrimaryFull: { justifyContent: "center", width: "100%", paddingVertical: 13 },
  footerPrimaryLabel: { fontSize: 12, fontWeight: "700", color: colors.onBrand, letterSpacing: 0.2 },
});
