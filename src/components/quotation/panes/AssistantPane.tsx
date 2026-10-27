// AssistantPane
// -----------------------------------------------------------------------------
// The right-pane "Quotation Assistant". A lightweight, focus-driven surface
// that mirrors whatever the user is currently interacting with in the canvas
// (a line) or the picker (a product hovered / long-pressed).
//
// Sections (in order):
//   * Large product image
//   * Name + SKU + Brand + Series
//   * Variant selector (finish/color/size)
//   * Pricing (MRP, price, discount %, final)
//   * Qty controls (only when a Line is focused)
//   * Key specifications
//   * Stock availability
//   * Alternates (loaded on demand, ranked closest-first)
//   * Complete-the-Set (same family_key, other categories)
// -----------------------------------------------------------------------------
import Feather from "@expo/vector-icons/Feather";
import * as Haptics from "expo-haptics";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import { ProductImage } from "@/src/components/ProductImage";
import { Badge, EmptyState } from "@/src/components/ui";
import { colors, money, PRODUCT_IMAGE_ASPECT_RATIO, radius, spacing, type } from "@/src/theme/tokens";

import { useBuilder } from "../context/BuilderContext";
import { effectivePct } from "../helpers/pricing";
import { productImageList, resolveVariantImages } from "../helpers/media";
import { VariantChip } from "../shared/VariantChip";
import type { Line, Product, ProductVariant } from "../helpers/types";

// -----------------------------------------------------------------------------
// Data hook for the assistant. Fetches full product detail (variants, specs,
// brand/series) plus alternates and family suggestions.
// -----------------------------------------------------------------------------
function useAssistantData(productId: string | null) {
  const [product, setProduct] = useState<Product | null>(null);
  const [alternates, setAlternates] = useState<Product[]>([]);
  const [family, setFamily] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!productId) { setProduct(null); setAlternates([]); setFamily([]); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const p = await api.get<Product>(`/products/${productId}`);
        if (cancelled) return;
        setProduct(p);
        // Alternates (family → brand+category → category, backend-ranked)
        const alt = await api.get<{ items: Product[] }>(`/products/${productId}/alternates?limit=12`).catch(() => ({ items: [] as Product[] }));
        if (cancelled) return;
        setAlternates(alt.items || []);
        // Complete-the-Set via family_key (skip the current product's category)
        if (p.family_key) {
          const fam = await api.get<{ items: Product[] }>(
            `/products?family_key=${encodeURIComponent(p.family_key)}&limit=20`,
          ).catch(() => ({ items: [] as Product[] }));
          if (cancelled) return;
          const filtered = (fam.items || []).filter((x) => x.id !== p.id && x.category_id !== p.category_id);
          setFamily(filtered);
        } else {
          setFamily([]);
        }
      } catch {
        if (!cancelled) { setProduct(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [productId]);

  return { product, alternates, family, loading };
}

// -----------------------------------------------------------------------------
// Main pane
// -----------------------------------------------------------------------------
export function AssistantPane({ onClose }: { onClose?: () => void }) {
  const b = useBuilder();

  // Resolve which line + product is focused.
  const focusedLine: Line | null = useMemo(() => {
    const focus = b.assistantFocus;
    if (focus && focus.kind === "line") {
      return b.s.lines.find((l) => l.id === focus.line_id) || null;
    }
    return null;
  }, [b.assistantFocus, b.s.lines]);

  const productId = focusedLine?.product_id
    || (b.assistantFocus && b.assistantFocus.kind === "product" ? b.assistantFocus.product_id : null);

  const { product, alternates, family, loading } = useAssistantData(productId);

  if (!productId) {
    return (
      <View style={styles.panel}>
        <View style={styles.head}>
          <Text style={type.overline}>Quotation Assistant</Text>
          {onClose ? (
            <Pressable onPress={onClose} hitSlop={8}><Feather name="x" size={18} color={colors.onSurfaceMuted} /></Pressable>
          ) : null}
        </View>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="sidebar"
            title="Nothing focused"
            subtitle="Tap a line in the quotation, or long-press a product in the catalog to see details, alternates and complete-the-set suggestions here."
          />
        </View>
      </View>
    );
  }

  if (loading || !product) {
    return (
      <View style={styles.panel}>
        <View style={styles.head}>
          <Text style={type.overline}>Quotation Assistant</Text>
          {onClose ? (
            <Pressable onPress={onClose} hitSlop={8}><Feather name="x" size={18} color={colors.onSurfaceMuted} /></Pressable>
          ) : null}
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator />
        </View>
      </View>
    );
  }

  const activeSku = focusedLine?.sku ?? product.sku;
  const activeVariant: ProductVariant | undefined = (product.variants || []).find((v) => v.sku === activeSku);
  // Falls back to a sibling finish's photo when the active one has none of
  // its own, rather than leaving the gallery empty (see helpers/media.ts).
  const { images: heroImages, isFallback: heroIsFallback } = resolveVariantImages(product, activeVariant);
  // A quotation retains the image selected at the time its line was added.
  // Keep that snapshot as a final fallback so a deleted/migrated catalog
  // media row cannot leave the right-pane preview as an empty frame.
  const assistantImages = Array.from(new Set([
    ...heroImages,
    focusedLine?.image || "",
  ].filter(Boolean)));
  const price = focusedLine?.unit_price ?? activeVariant?.price ?? product.price;
  const mrp = activeVariant?.mrp ?? product.mrp ?? product.price;
  const brand = product.brand_name || product.brand_id;
  const series = product.series || product.collection || null;

  // If it's a line, discount + line total
  const eff = focusedLine ? effectivePct(focusedLine, b.s.roomDiscounts, b.s.categoryDiscounts, b.s.projectDiscount) : null;
  const lineTotal = focusedLine ? focusedLine.qty * focusedLine.unit_price * (1 - (eff?.pct ?? 0) / 100) : null;

  // Variant change:
  // - If a line is focused, swap the line to that variant (via commit-style update).
  // - Otherwise (product-only focus), just refocus the assistant on that variant's sku.
  const onPickVariant = (v: ProductVariant) => {
    Haptics.selectionAsync();
  if (focusedLine) {
      const finish = v.finish ?? v.color ?? v.size ?? product.finish ?? null;
      const displayName = (v.finish || v.color || v.size)
        ? `${product.name} · ${v.finish || v.color || v.size}`
        : product.name;
      b.updateLine(focusedLine.id, {
        product_id: v.id ?? focusedLine.product_id,
        sku: v.sku,
        name: displayName,
        unit_price: v.price ?? product.price,
        finish,
        image: resolveVariantImages(product, v).images[0] ?? focusedLine.image,
      });
    } else if (v.id) {
      b.setAssistantFocus({ kind: "product", product_id: v.id, product });
    }
  };

  const addAlternate = (target: Product, v?: ProductVariant) => {
    b.addFromProduct(target, v);
  };

  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Text style={type.overline}>Quotation Assistant</Text>
        {onClose ? (
          <Pressable onPress={onClose} hitSlop={8}><Feather name="x" size={18} color={colors.onSurfaceMuted} /></Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.lg, paddingBottom: 40 }}>
        {/* --- Image --- */}
        <View style={styles.hero}>
          {/* No `key` here — keeping the same ProductImage instance across
              finish switches lets expo-image's own transition crossfade
              smoothly instead of a hard remount/flash. */}
          <ProductImage
            source={assistantImages}
            style={styles.heroImage}
            fallbackLabel={activeVariant?.sku || product.sku}
          />
          {heroImages.length && heroIsFallback ? (
            <Text style={styles.repImageNote}>Representative photo — exact finish photo not available</Text>
          ) : null}
        </View>

        {/* --- Title block --- */}
        <View style={{ gap: 4 }}>
          <Text style={type.titleLg} numberOfLines={2}>{product.name}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <Text style={type.caption}>{product.sku}</Text>
            {brand ? <Text style={type.caption}>· {brand}</Text> : null}
            {series ? <Text style={type.caption}>· {series}</Text> : null}
          </View>
        </View>

        {/* --- Variants --- */}
        {(product.variants || []).length > 0 ? (
          <View style={{ gap: 8 }}>
            <Text style={type.overline}>Finish / Variant</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {(product.variants || []).map((v) => (
                <VariantChip
                  key={v.sku}
                  variant={v}
                  basePrice={product.price}
                  onPress={() => onPickVariant(v)}
                  active={activeSku === v.sku}
                  testID={`assist-variant-${v.sku}`}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* --- Pricing --- */}
        <View style={styles.priceBlock}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <Text numberOfLines={1} style={{ fontSize: 22, fontWeight: "700", fontVariant: ["tabular-nums"], flexShrink: 0 }}>{money(price)}</Text>
            {mrp > price ? (
              <Text numberOfLines={1} style={{ fontSize: 13, color: colors.onSurfaceMuted, textDecorationLine: "line-through", fontVariant: ["tabular-nums"], flexShrink: 0 }}>
                {money(mrp)}
              </Text>
            ) : null}
          </View>
          {focusedLine && eff ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {eff.source !== "none" ? (
                <Badge tone={eff.source === "product" ? "warning" : eff.source === "category" ? "info" : "success"} label={`${eff.pct}% ${eff.source}`} />
              ) : null}
              <Badge tone="neutral" label={`Line total ${money(lineTotal || 0)}`} />
            </View>
          ) : null}
        </View>

        {/* --- Qty controls (line-only) --- */}
        {focusedLine ? (
          <View style={{ gap: 8 }}>
            <Text style={type.overline}>Quantity</Text>
            <View style={styles.qtyRow}>
              <Pressable
                testID="assist-qty-minus"
                onPress={() => b.updateLine(focusedLine.id, { qty: Math.max(0, focusedLine.qty - 1) }, "qty")}
                style={styles.qtyBtn}
              >
                <Feather name="minus" size={16} color={colors.onSurface} />
              </Pressable>
              <TextInput
                testID="assist-qty-input"
                value={String(focusedLine.qty)}
                keyboardType="number-pad"
                onChangeText={(v) => b.updateLine(focusedLine.id, { qty: Math.max(0, Number(v) || 0) }, "qty")}
                style={styles.qtyInput}
                selectTextOnFocus
              />
              <Pressable
                testID="assist-qty-plus"
                onPress={() => b.updateLine(focusedLine.id, { qty: focusedLine.qty + 1 }, "qty")}
                style={styles.qtyBtn}
              >
                <Feather name="plus" size={16} color={colors.onSurface} />
              </Pressable>
              <Pressable
                testID="assist-open-line-disc"
                onPress={() => b.setDiscountSheet({ kind: "line", line_id: focusedLine.id })}
                style={[styles.qtyBtn, { flex: 1, flexDirection: "row", gap: 6 }]}
              >
                <Feather name="percent" size={14} color={colors.onSurface} />
                <Text style={{ fontSize: 13, fontWeight: "600" }}>Discount</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            testID="assist-add-to-quote"
            onPress={() => b.addFromProduct(product, activeVariant)}
            style={styles.addPrimary}
          >
            <Feather name="plus" size={16} color={colors.onBrand} />
            <Text style={styles.addPrimaryText}>Add to quotation</Text>
          </Pressable>
        )}

        {/* --- Specs --- */}
        <View style={{ gap: 8 }}>
          <Text style={type.overline}>Dimension diagrams</Text>
          {(activeVariant?.dimension_image_urls ?? product.dimension_image_urls ?? []).length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {(activeVariant?.dimension_image_urls ?? product.dimension_image_urls ?? []).map((url, index) => (
                <ProductImage key={`${url}-${index}`} source={url} style={{ width: 100, height: 80 }} contentFit="contain" fallbackLabel={product.sku} />
              ))}
            </View>
          ) : <Text style={type.body}>No diagram uploaded. Open Edit product → Media to add one.</Text>}
          {focusedLine ? (
            <Pressable
              testID="assist-exclude-dimension"
              accessibilityRole="checkbox"
              accessibilityState={{ checked: !!focusedLine.exclude_dimension }}
              onPress={() => b.updateLine(focusedLine.id, { exclude_dimension: !focusedLine.exclude_dimension })}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Feather name={focusedLine.exclude_dimension ? "check-square" : "square"} size={18} color={colors.onSurface} />
              <Text style={type.body}>Exclude diagram from PDF</Text>
            </Pressable>
          ) : null}
        </View>

        {product.specs && Object.keys(product.specs).length ? (
          <View style={{ gap: 6 }}>
            <Text style={type.overline}>Specifications</Text>
            <View style={styles.specGrid}>
              {Object.entries(product.specs).slice(0, 10).map(([k, v]) => (
                <View key={k} style={styles.specRow}>
                  <Text style={[type.caption, { flex: 1 }]}>{k}</Text>
                  <Text style={[type.body, { fontWeight: "600" }]}>{String(v)}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* --- Stock --- */}
        {typeof (activeVariant?.stock ?? product.stock) === "number" ? (
          <View style={styles.stockPill}>
            <Feather
              name={((activeVariant?.stock ?? product.stock) || 0) > 0 ? "check-circle" : "alert-circle"}
              size={13}
              color={((activeVariant?.stock ?? product.stock) || 0) > 0 ? colors.success : colors.warning}
            />
            <Text style={{ fontSize: 12, color: colors.onSurfaceSecondary, fontWeight: "600" }}>
              {((activeVariant?.stock ?? product.stock) || 0) > 0
                ? `In stock · ${activeVariant?.stock ?? product.stock} units`
                : "Out of stock"}
            </Text>
          </View>
        ) : null}

        {/* --- Alternates --- */}
        {alternates.length > 0 ? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
              <Text style={type.overline}>Alternates</Text>
              <Text style={type.caption}>Ranked closest-first</Text>
            </View>
            <View style={{ gap: 6 }}>
              {alternates.slice(0, 6).map((p) => (
                <SuggestionRow
                  key={p.id}
                  product={p}
                  onPress={() => addAlternate(p)}
                  onSwap={focusedLine ? () => b.openSwap(focusedLine) : undefined}
                />
              ))}
            </View>
          </View>
        ) : null}

        {/* --- Complete the Set --- */}
        {family.length > 0 ? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
              <Text style={type.overline}>Complete the set</Text>
              <Text style={type.caption}>Same series</Text>
            </View>
            <View style={{ gap: 6 }}>
              {family.slice(0, 6).map((p) => (
                <SuggestionRow key={p.id} product={p} onPress={() => addAlternate(p)} />
              ))}
            </View>
          </View>
        ) : null}

      </ScrollView>
    </View>
  );
}

// -----------------------------------------------------------------------------
// SuggestionRow — reusable compact card for alternates + complete-the-set.
// -----------------------------------------------------------------------------
function SuggestionRow({
  product, onPress, onSwap,
}: {
  product: Product;
  onPress: () => void;
  onSwap?: () => void;
}) {
  return (
    <View style={styles.suggestion}>
      <ProductImage source={productImageList(product)} style={styles.suggestionThumb} fallbackLabel={product.sku} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onSurface }} numberOfLines={1}>{product.name}</Text>
        <Text style={type.caption} numberOfLines={1}>{product.sku}{product.finish ? ` · ${product.finish}` : ""}</Text>
      </View>
      <Text style={{ fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{money(product.price)}</Text>
      <Pressable
        onPress={onPress}
        hitSlop={6}
        style={styles.suggestionAdd}
        testID={`assist-add-${product.id}`}
      >
        <Feather name="plus" size={14} color={colors.onBrand} />
      </Pressable>
      {onSwap ? (
        <Pressable
          onPress={onSwap}
          hitSlop={6}
          style={styles.suggestionSwap}
          testID={`assist-swap-${product.id}`}
        >
          <Feather name="refresh-cw" size={13} color={colors.onSurface} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: colors.surface, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  head: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  hero: {
    padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  // A proportional hero could consume most of the narrow assistant pane.
  // Bound the preview so product controls and alternates remain visible.
  heroImage: { width: "100%", height: 148, borderRadius: radius.md },
  repImageNote: { fontSize: 10, color: colors.onSurfaceMuted, fontStyle: "italic", marginTop: 4 },
  priceBlock: {
    padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  qtyRow: { flexDirection: "row", gap: 6, alignItems: "center" },
  qtyBtn: {
    minWidth: 40, height: 40, paddingHorizontal: 10, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
    alignItems: "center", justifyContent: "center",
  },
  qtyInput: {
    width: 60, height: 40, textAlign: "center", fontSize: 15, fontWeight: "700",
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface,
    color: colors.onSurface,
  },
  addPrimary: {
    backgroundColor: colors.brand, paddingVertical: 12, borderRadius: radius.md,
    flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8,
  },
  addPrimaryText: { color: colors.onBrand, fontSize: 14, fontWeight: "700" },
  specGrid: { gap: 4, backgroundColor: colors.surfaceSecondary, padding: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  specRow: { flexDirection: "row", gap: 8, justifyContent: "space-between", paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.divider },
  stockPill: {
    alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border,
  },
  suggestion: {
    flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
  suggestionThumb: { width: 56, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: 6, backgroundColor: colors.surfaceTertiary },
  suggestionAdd: {
    width: 28, height: 28, borderRadius: 999, backgroundColor: colors.brand,
    alignItems: "center", justifyContent: "center",
  },
  suggestionSwap: {
    width: 28, height: 28, borderRadius: 999, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, alignItems: "center", justifyContent: "center",
  },
  notes: {
    padding: 10, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  notesInput: { fontSize: 13, color: colors.onSurface, padding: 0, minHeight: 60, maxHeight: 120, textAlignVertical: "top" },
});
