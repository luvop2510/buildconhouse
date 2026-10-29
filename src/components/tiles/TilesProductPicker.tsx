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
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { ProductImage } from "@/src/components/ProductImage";
import { toast } from "@/src/components/Toast";
import { productImageList } from "@/src/components/quotation/helpers/media";
import type { Product } from "@/src/components/quotation/helpers/types";
import { colors, money, radius, spacing } from "@/src/theme/tokens";
import { catalogGridRows, catalogPageProgress, fetchCatalogPage, mergeCatalogPage } from "@/src/services/catalogService";
import { isNearScrollEnd } from "@/src/utils/scrollEnd";

import { TILE_IMAGE_ASPECT_RATIO, tilesPickerColumns } from "./tilePresentation";
import { tilePickerHistory } from "./tilePickerHistory";

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
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestId = useRef(0);
  const openedRef = useRef(false);
  const nextOffset = useRef(0);
  const pendingPage = useRef<number | null>(null);
  const queryContext = useRef({ query, open, customerId });
  queryContext.current = { query, open, customerId };
  const selection = useRef<AbortController | null>(null);
  const [choosing, setChoosing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    selection.current?.abort();
    selection.current = null;
    setChoosing(false);
    return () => { selection.current?.abort(); selection.current = null; };
  }, [open, customerId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current += 1; }; }, []);

  const search = useCallback(async (q: string, skip = 0) => {
    if (!mounted.current || !queryContext.current.open || q !== queryContext.current.query || (skip > 0 && pendingPage.current !== null)) return;
    const id = ++requestId.current;
    pendingPage.current = id;
    if (skip === 0) { nextOffset.current = 0; setHasMore(false); setLoading(true); }
    else setLoadingMore(true);
    if (skip === 0) setLoadError(null);
    try {
      const res = await fetchCatalogPage<Product>({ mode: "products", q, sort: "popular" }, skip, PAGE_SIZE, { floorId: "ground-floor" });
      if (!mounted.current || !queryContext.current.open || q !== queryContext.current.query || id !== requestId.current) return;
      const items = res.items || [];
      setResults((current) => skip === 0 ? items : mergeCatalogPage(current, items));
      const progress = catalogPageProgress(skip, items.length, res.total || 0);
      nextOffset.current = progress.nextSkip;
      setHasMore(progress.hasMore);
      setTotal(res.total || 0);
    } catch (error: any) {
      if (mounted.current && queryContext.current.open && q === queryContext.current.query && id === requestId.current) {
        setLoadError(error?.detail || "Could not load the tile catalog. Check your connection and try again.");
      }
    } finally {
      if (pendingPage.current === id) pendingPage.current = null;
      if (mounted.current && queryContext.current.open && q === queryContext.current.query && id === requestId.current) { setLoading(false); setLoadingMore(false); }
    }
  }, []);

  useEffect(() => {
    // Revoke earlier responses as soon as typing/closing begins, before the
    // debounce. A response in that interval must not restore obsolete cards.
    requestId.current += 1;
    pendingPage.current = null;
    setLoadingMore(false);
    setHasMore(false);
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
    return () => { clearTimeout(debounce); requestId.current += 1; pendingPage.current = null; };
  }, [query, open, search]);

  const pick = useCallback(async (product: Product, size?: string) => {
    if (selection.current || !mounted.current || !queryContext.current.open) return;
    const controller = new AbortController();
    selection.current = controller;
    setChoosing(true);
    const current = () => mounted.current && queryContext.current.open && queryContext.current.customerId === customerId && !controller.signal.aborted && selection.current === controller;
    void Haptics.selectionAsync().catch(() => {});
    try {
      let selected = product;
      if (size) {
        const resolution = await api.get<{ product: Product }>(`/products/${product.id}/size-variants?size=${encodeURIComponent(size)}`, { floorId: "ground-floor", signal: controller.signal });
        selected = resolution.product;
      }
      if (!current()) return;
      const history = customerId && !size
        ? await tilePickerHistory(signal => api.get<{ found: boolean } & Partial<ProductHistory>>(
          `/quotations/tiles/product-history?customer_id=${encodeURIComponent(customerId)}&product_id=${encodeURIComponent(selected.id)}`,
          { floorId: "ground-floor", signal },
        ), controller.signal)
        : undefined;
      if (!current()) return;
      onPick(selected, history?.found ? {
        size: history.size ?? null, rate_sqft: history.rate_sqft ?? null,
        rate_box: history.rate_box ?? null, pcs_per_box: history.pcs_per_box ?? null,
        box_sqft: history.box_sqft ?? null,
      } : undefined);
      onClose();
    } catch (error: any) {
      if (current()) toast.error(error?.detail || "That tile size could not be loaded. Please try again.");
    } finally {
      if (selection.current === controller) {
        selection.current = null;
        if (mounted.current) setChoosing(false);
      }
    }
  }, [customerId, onClose, onPick]);

  const loadMore = useCallback(() => {
    if (queryContext.current.open && queryContext.current.query === query && !loading && !loadingMore && hasMore) void search(query, nextOffset.current);
  }, [hasMore, loading, loadingMore, query, search]);

  return (
    <Overlay open={open} onClose={onClose} title="Add tiles" presentation="fullscreen" scroll={false} header={false}>
      <SafeAreaView style={styles.screen} edges={[]} onLayout={(event) => setPickerWidth(event.nativeEvent.layout.width)}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.close} testID="tiles-picker-close" accessibilityRole="button" accessibilityLabel="Close catalog">
            <Feather name="x" size={21} color={colors.onSurface} />
          </Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title}>Add tiles</Text>
            <Text style={styles.subtitle}>{total > 0 ? `${total.toLocaleString("en-IN")} products · ` : ""}Choose a product to add it to this document</Text>
          </View>
        </View>
        <View {...(Platform.OS === "web" ? { dataSet: { fieldShell: "true" } } : {})} style={styles.searchWrap}>
          <Feather name="search" size={17} color={colors.onSurfaceMuted} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder="Search SKU, tile name or brand"
            accessibilityLabel="Search tile catalog"
            placeholderTextColor={colors.onSurfaceMuted}
            style={styles.input}
            returnKeyType="search"
            testID="tiles-picker-search"
          />
          {query ? <Pressable onPress={() => setQuery("")} style={styles.clearSearch} accessibilityRole="button" accessibilityLabel="Clear search"><Feather name="x-circle" size={17} color={colors.onSurfaceMuted} /></Pressable> : null}
          {loading || choosing ? <ActivityIndicator size="small" color={colors.brand} /> : null}
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
              onPickSize={(size) => void pick(item, size)}
            />
          )}
          initialNumToRender={catalogGridRows(columns, 8)}
          maxToRenderPerBatch={catalogGridRows(columns, 8)}
          windowSize={5}
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
  close: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  title: { fontSize: 18, fontWeight: "700", color: colors.onSurface },
  subtitle: { fontSize: 12, color: colors.onSurfaceSecondary, marginTop: 1 },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: spacing.sm, margin: spacing.lg, marginBottom: spacing.sm, paddingHorizontal: spacing.md, minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
  input: { flex: 1, minWidth: 0, color: colors.onSurface, fontSize: 16, paddingVertical: 8, ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}) },
  clearSearch: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  grid: { padding: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xxxl, gap: spacing.md },
  gridRow: { gap: spacing.md },
  card: { minWidth: 0, overflow: "hidden", borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  cardPressed: { opacity: 0.82, borderColor: colors.brand },
  image: { width: "100%", aspectRatio: TILE_IMAGE_ASPECT_RATIO, borderRadius: 0, backgroundColor: colors.surfaceTertiary },
  phoneCard: { flexDirection: "row", alignItems: "stretch", minHeight: 100 },
  phoneImage: { width: 88, aspectRatio: TILE_IMAGE_ASPECT_RATIO, alignSelf: "center", marginLeft: spacing.sm, borderRadius: radius.sm },
  cardBody: { flex: 1, minWidth: 0, padding: spacing.sm, gap: 3 },
  brand: { fontSize: 12, fontWeight: "600", color: colors.onSurfaceMuted },
  name: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: colors.onSurface },
  meta: { fontSize: 12, color: colors.onSurfaceSecondary },
  sizePicker: { gap: 4, marginTop: 2 },
  sizeLabel: { fontSize: 12, fontWeight: "600", color: colors.onSurfaceMuted },
  sizeChoices: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  // Size is an independent action inside an otherwise tappable product card,
  // so it receives a full touch target rather than inheriting chip-sized UI.
  sizeChoice: { maxWidth: 104, minHeight: 44, justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 3, backgroundColor: colors.surface },
  sizeChoiceCurrent: { backgroundColor: colors.brand, borderColor: colors.brand },
  sizeChoicePressed: { opacity: 0.72 },
  sizeChoiceText: { fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary },
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
