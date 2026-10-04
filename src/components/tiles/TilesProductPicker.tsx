import { Overlay } from "@/src/design/Overlay";
// TilesProductPicker — a mobile-first catalog for adding a tile to a document.
//
// This intentionally shares the same search API and media resolver as the
// sanitary quotation builder. The old text-only dialog forced workers through
// a one-result-at-a-time flow; phones use spacious landscape product rows and
// wider picker layouts use a measured grid with direct add.
import Feather from "@expo/vector-icons/Feather";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { ProductImage } from "@/src/components/ProductImage";
import { toast } from "@/src/components/Toast";
import { productImageList } from "@/src/components/quotation/helpers/media";
import type { Product } from "@/src/components/quotation/helpers/types";
import { colors, money, radius, spacing } from "@/src/theme/tokens";
import { isNearScrollEnd } from "@/src/utils/scrollEnd";

import { TILE_IMAGE_ASPECT_RATIO, tilesPickerColumns } from "./tilePresentation";

const PAGE_SIZE = 24;

type ProductHistory = {
  size: string | null; rate_sqft: number | null; rate_box: number | null;
  pcs_per_box: string | null; box_sqft: number | null;
};

function tileSizes(product: Product): string[] {
  return [...new Set((product.available_sizes || []).map((size) => String(size || "").trim()).filter(Boolean))];
}

export function TilesProductPicker({
  open, onClose, onPick, customerId,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (product: Product, history?: ProductHistory) => void;
  customerId?: string | null;
}) {
  const { width } = useWindowDimensions();
  const [pickerWidth, setPickerWidth] = useState(0);
  const availableWidth = pickerWidth || width;
  const columns = tilesPickerColumns(availableWidth);
  const cardWidth = (availableWidth - spacing.lg * 2 - spacing.md * (columns - 1)) / columns;
  const isPhonePicker = columns === 1;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestId = useRef(0);
  const openedRef = useRef(false);

  const search = useCallback(async (q: string, skip = 0) => {
    const id = ++requestId.current;
    if (skip === 0) setLoading(true);
    else setLoadingMore(true);
    if (skip === 0) setLoadError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), skip: String(skip), sort: "popular" });
      if (q.trim()) params.set("q", q.trim());
      const res = await api.get<{ items: Product[]; total: number }>(`/products?${params.toString()}`, { floorId: "ground-floor" });
      if (id !== requestId.current) return;
      const items = res.items || [];
      setResults((current) => skip === 0 ? items : [...current, ...items.filter((item) => !current.some((x) => x.id === item.id))]);
      setTotal(res.total || 0);
    } catch (error: any) {
      if (id === requestId.current) {
        setLoadError(error?.detail || "Could not load the tile catalog. Check your connection and try again.");
      }
    } finally {
      if (id === requestId.current) { setLoading(false); setLoadingMore(false); }
    }
  }, []);

  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    // Opening with a prior query should first clear the input; the following
    // effect run performs one fresh initial search rather than racing it.
    if (!openedRef.current) {
      openedRef.current = true;
      if (query) setQuery("");
      else void search("");
      return;
    }
    const debounce = setTimeout(() => { void search(query); }, 180);
    return () => clearTimeout(debounce);
  }, [query, open, search]);

  const pick = useCallback(async (product: Product, useCustomerHistory = true) => {
    Haptics.selectionAsync();
    if (customerId && useCustomerHistory) {
      try {
        const history = await api.get<{ found: boolean } & Partial<ProductHistory>>(
          `/quotations/tiles/product-history?customer_id=${customerId}&product_id=${product.id}`,
          { floorId: "ground-floor" },
        );
        if (history.found) {
          onPick(product, {
            size: history.size ?? null, rate_sqft: history.rate_sqft ?? null,
            rate_box: history.rate_box ?? null, pcs_per_box: history.pcs_per_box ?? null,
            box_sqft: history.box_sqft ?? null,
          });
          onClose();
          return;
        }
      } catch { /* History is optional; add the selected product normally. */ }
    }
    onPick(product);
    onClose();
  }, [customerId, onClose, onPick]);

  const hasMore = results.length < total;
  const loadMore = useCallback(() => {
    if (!loading && !loadingMore && hasMore) void search(query, results.length);
  }, [hasMore, loading, loadingMore, query, results.length, search]);

  return (
    <Overlay open={open} onClose={onClose} title="Add tiles" presentation="fullscreen" scroll={false} header={false}>
      <SafeAreaView style={styles.screen} edges={[]} onLayout={(event) => setPickerWidth(event.nativeEvent.layout.width)}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.close} testID="tiles-picker-close" accessibilityRole="button" accessibilityLabel="Close catalog">
            <Feather name="x" size={21} color={colors.onSurface} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title}>Add tiles</Text>
            <Text style={styles.subtitle}>Choose a product to add it to this document</Text>
          </View>
        </View>
        <View style={styles.searchWrap}>
          <Feather name="search" size={17} color={colors.onSurfaceMuted} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search SKU, tile name or brand"
            placeholderTextColor={colors.onSurfaceMuted}
            style={styles.input}
            returnKeyType="search"
            testID="tiles-picker-search"
          />
          {query ? <Pressable onPress={() => setQuery("")} hitSlop={10} accessibilityLabel="Clear search"><Feather name="x-circle" size={17} color={colors.onSurfaceMuted} /></Pressable> : null}
          {loading ? <ActivityIndicator size="small" color={colors.brand} /> : null}
        </View>
        <FlatList
          key={`tiles-picker-${columns}`}
          data={results}
          keyExtractor={(product) => product.id}
          numColumns={columns}
          columnWrapperStyle={columns > 1 ? styles.gridRow : undefined}
          contentContainerStyle={styles.grid}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TileCatalogCard
              product={item}
              compact={isPhonePicker}
              cardWidth={cardWidth}
              onPress={() => void pick(item)}
              onPickSize={(size) => void (async () => {
                try {
                  // Resolve by size server-side. The response is the complete
                  // sibling product, so adding it updates all tile attributes.
                  const resolution = await api.get<{ product: Product }>(`/products/${item.id}/size-variants?size=${encodeURIComponent(size)}`, { floorId: "ground-floor" });
                  await pick(resolution.product, false);
                } catch (error: any) {
                  toast.error(error?.detail || "That tile size could not be loaded. Please try again.");
                }
              })()}
            />
          )}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          removeClippedSubviews={Platform.OS !== "web"}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          onScroll={(event) => { if (isNearScrollEnd(event.nativeEvent, 0.5)) loadMore(); }}
          scrollEventThrottle={50}
          ListEmptyComponent={!loading && !loadError ? <Text style={styles.empty}>No tiles match “{query}”. Try another search.</Text> : null}
          ListFooterComponent={loadingMore ? <ActivityIndicator style={{ paddingVertical: spacing.lg }} color={colors.brand} /> : null}
        />
        {loadError ? (
          <View style={styles.errorNotice} accessibilityLiveRegion="polite">
            <Text style={styles.errorText}>{loadError}</Text>
            <Pressable
              onPress={() => void search(query)}
              accessibilityRole="button"
              accessibilityLabel="Retry loading tile catalog"
              style={styles.retryButton}
            >
              <Feather name="refresh-cw" size={14} color={colors.error} />
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
      </SafeAreaView>
    </Overlay>
  );
}

function TileCatalogCard({
  product, compact, cardWidth, onPress, onPickSize,
}: {
  product: Product; compact: boolean; cardWidth: number; onPress: () => void; onPickSize: (size: string) => void;
}) {
  const sizes = tileSizes(product);
  const canSwitchSize = sizes.length >= 2;
  const selectedSize = String(product.size || product.dimensions || "").trim();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, { width: cardWidth }, compact && styles.phoneCard, pressed && styles.cardPressed]} testID={`tiles-picker-card-${product.id}`} accessibilityRole="button" accessibilityLabel={`Add ${product.name}`}>
      <ProductImage source={productImageList(product)} style={[styles.image, ...(compact ? [styles.phoneImage] : [])]} fallbackLabel={product.sku} disableSkeleton contentFit="contain" />
      <View style={styles.cardBody}>
        <Text style={styles.brand} numberOfLines={1}>{product.brand_name || "Tile"}</Text>
        <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>{[product.sku, product.size || product.dimensions].filter(Boolean).join(" · ")}</Text>
        {canSwitchSize ? (
          <View style={styles.sizePicker} accessibilityLabel={`${sizes.length} sizes available for ${product.name}`}>
            <Text style={styles.sizeLabel}>{sizes.length} sizes</Text>
            <View style={styles.sizeChoices}>
              {sizes.map((choice) => (
                <Pressable
                  key={choice}
                  onPress={(event) => { event.stopPropagation(); onPickSize(choice); }}
                  style={({ pressed }) => [styles.sizeChoice, choice === selectedSize && styles.sizeChoiceCurrent, pressed && styles.sizeChoicePressed]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: choice === selectedSize }}
                  accessibilityLabel={`Choose ${choice}${choice === selectedSize ? ", selected" : ""}`}
                  testID={`tiles-picker-size-${product.id}-${choice}`}
                >
                  <Text numberOfLines={1} style={[styles.sizeChoiceText, choice === selectedSize && styles.sizeChoiceTextCurrent]}>{choice}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
        <View style={styles.cardFooter}>
          <Text style={styles.price}>{product.price ? money(product.price) : "Price on request"}</Text>
          <View style={styles.add}><Feather name="plus" size={16} color={colors.onBrand} /></View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, backgroundColor: colors.surfaceSecondary, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  close: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  title: { fontSize: 18, fontWeight: "700", color: colors.onSurface },
  subtitle: { fontSize: 12, color: colors.onSurfaceSecondary, marginTop: 1 },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: spacing.sm, margin: spacing.lg, marginBottom: spacing.sm, paddingHorizontal: spacing.md, minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
  input: { flex: 1, minWidth: 0, color: colors.onSurface, fontSize: 15, paddingVertical: 8, ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}) },
  grid: { padding: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xxxl, gap: spacing.md },
  gridRow: { gap: spacing.md },
  card: { minWidth: 0, overflow: "hidden", borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  cardPressed: { opacity: 0.82, borderColor: colors.brand },
  image: { width: "100%", aspectRatio: TILE_IMAGE_ASPECT_RATIO, borderRadius: 0, backgroundColor: colors.surfaceTertiary },
  phoneCard: { flexDirection: "row", alignItems: "stretch", minHeight: 100 },
  phoneImage: { width: 128, aspectRatio: TILE_IMAGE_ASPECT_RATIO, alignSelf: "center", marginLeft: spacing.sm, borderRadius: radius.sm },
  cardBody: { flex: 1, minWidth: 0, padding: spacing.sm, gap: 3 },
  brand: { fontSize: 10, fontWeight: "700", letterSpacing: 0.45, textTransform: "uppercase", color: colors.onSurfaceMuted },
  name: { minHeight: 34, fontSize: 13, lineHeight: 17, fontWeight: "700", color: colors.onSurface },
  meta: { fontSize: 11, color: colors.onSurfaceSecondary },
  sizePicker: { gap: 4, marginTop: 2 },
  sizeLabel: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceMuted, textTransform: "uppercase", letterSpacing: 0.35 },
  sizeChoices: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  // Size is an independent action inside an otherwise tappable product card,
  // so it receives a full touch target rather than inheriting chip-sized UI.
  sizeChoice: { maxWidth: 104, minHeight: 44, justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 3, backgroundColor: colors.surface },
  sizeChoiceCurrent: { backgroundColor: colors.brand, borderColor: colors.brand },
  sizeChoicePressed: { opacity: 0.72 },
  sizeChoiceText: { fontSize: 10, fontWeight: "600", color: colors.onSurfaceSecondary },
  sizeChoiceTextCurrent: { color: colors.onBrand },
  cardFooter: { minHeight: 32, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4, marginTop: 3 },
  price: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: "700", color: colors.onSurface, fontVariant: ["tabular-nums"] },
  add: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.brand },
  empty: { padding: spacing.xl, color: colors.onSurfaceMuted, fontSize: 14, textAlign: "center" },
  errorNotice: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.errorBg },
  errorText: { flex: 1, color: colors.error, fontSize: 13 },
  retryButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: spacing.sm },
  retryText: { color: colors.error, fontSize: 13, fontWeight: "700" },
});
