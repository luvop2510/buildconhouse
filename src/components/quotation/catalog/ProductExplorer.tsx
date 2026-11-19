// ProductExplorer — the center pane in V4. Premium product grid with
// virtualisation, badges (Popular / Frequently used / Recent), color
// swatches, favourite heart, quick-preview → ProductModal, and "Add" button.
//
// Uses FlatList w/ numColumns for grid layout. Search + sort + filters live
// in the scrolling list header.
import Feather from "@expo/vector-icons/Feather";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, LayoutChangeEvent, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { Button, EmptyState, ErrorState } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { ProductImage } from "@/src/components/ProductImage";
import { colors, money, PRODUCT_IMAGE_ASPECT_RATIO, radius, spacing } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";
import { storage } from "@/src/utils/storage";
import { useBuilder, type BuilderCatalogSort } from "../context/BuilderContext";
import { ProductFilterSheet } from "../sheets/ProductFilterSheet";
import { VariantSwatchStrip } from "../shared/VariantChip";
import { QuickAddButton } from "../shared/QuickAddButton";
import { resolveVariantImages } from "../helpers/media";
import { variantDescriptor } from "../helpers/pricing";
import { quotationGridColumns } from "../helpers/responsive";
import type { Product, ProductVariant } from "../helpers/types";
import { catalogPriceUnknown } from "../helpers/catalogSource";
import { catalogProductQuantity, roomProductQuantities } from "../helpers/catalogMetrics";
import { isNearScrollEnd } from "@/src/utils/scrollEnd";
import { catalogGridRows, catalogReferences, catalogItemKey, supportsCatalogOrdering, type CatalogOrderProduct } from "@/src/services/catalogService";
import { CatalogReorderList } from "./CatalogReorderList";
import { useCatalogProductOrder } from "./useCatalogProductOrder";

const RECENT_SEARCHES_KEY = "forge.builder.recentSearches.v1";
const MAX_RECENT_SEARCHES = 8;

const SORT_OPTIONS: { k: BuilderCatalogSort; label: string; icon: React.ComponentProps<typeof Feather>["name"] }[] = [
  { k: "custom", label: "Custom Order", icon: "list" },
  { k: "popular", label: "Most used", icon: "trending-up" },
  { k: "recent", label: "Recent", icon: "clock" },
  { k: "price_asc", label: "Price ↑", icon: "arrow-up" },
  { k: "price_desc", label: "Price ↓", icon: "arrow-down" },
  { k: "name", label: "A–Z", icon: "align-left" },
];

export function ProductExplorer({ showCompactFilters = true, scrollHeader }: { showCompactFilters?: boolean; scrollHeader?: ReactNode }) {
  const b = useBuilder();
  const { activeFloorId, selectedBrandId, selectedCategoryId, setSortKey, retryProducts } = b;
  const orderScope = useMemo(() => supportsCatalogOrdering(activeFloorId)
    ? { floorId: activeFloorId, brandId: selectedBrandId, categoryId: selectedCategoryId } : null,
  [activeFloorId, selectedBrandId, selectedCategoryId]);
  const finishOrdering = useCallback(() => {
    setSortKey(null);
    retryProducts();
    toast.success("Catalog order saved");
  }, [setSortKey, retryProducts]);
  const order = useCatalogProductOrder(orderScope, finishOrdering);
  const sortOptions = orderScope ? SORT_OPTIONS : SORT_OPTIONS.filter((option) => option.k !== "custom");
  const [paneWidth, setPaneWidth] = useState(0);
  const [facets, setFacets] = useState<Record<string, { value: string }[]>>({});
  useEffect(() => { let active = true; if (!b.activeFloorId) return; setFacets({}); void catalogReferences.facets<Record<string, { value: string }[]>>({ floorId: b.activeFloorId }).then(value => { if (active) setFacets(value); }).catch(() => {}); return () => { active = false; }; }, [b.activeFloorId]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const numCols = quotationGridColumns(paneWidth, !showCompactFilters);
  // Cap compact imagery so tablets show multiple complete rows, even when a
  // narrow inline pane only has room for three cards across.
  const compactCards = showCompactFilters;
  const cardWidth = Math.max(0, (paneWidth - (showCompactFilters ? 24 : 32) - (numCols - 1) * 12) / numCols);
  const favouriteIds = useMemo(() => new Set(b.favouriteIds), [b.favouriteIds]);
  const roomQuantities = useMemo(() => roomProductQuantities(b.s.lines, b.s.activeRoom), [b.s.lines, b.s.activeRoom]);
  const brandName = useMemo(() => {
    if (!b.selectedBrandIds.length) return "All brands";
    return b.brands.filter(x => b.selectedBrandIds.includes(x.id)).map(x => x.name).join(", ") || "Brand";
  }, [b.brands, b.selectedBrandIds]);

  const catName = useMemo(() => {
    if (!b.selectedCategoryIds.length) return null;
    return b.categories.filter(c => b.selectedCategoryIds.includes(c.id)).map(c => c.name).join(", ") || null;
  }, [b.categories, b.selectedCategoryIds]);
  const hasFilters = !!(b.q.trim() || b.selectedBrandIds.length || b.selectedCategoryIds.length || b.selectedSizes.length);
  const clearFilters = () => {
    b.setQ("");
    b.setSelectedBrandId(null);
    b.setSelectedCategoryId(null);
    b.setSelectedSizes([]);
  };

  // ---- Recent searches (phone catalog experience parity) ----------------
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      const raw = await storage.getItem<string>(RECENT_SEARCHES_KEY, "[]");
      try {
        const parsed = JSON.parse(raw || "[]");
        if (Array.isArray(parsed)) setRecentSearches(parsed.filter((x) => typeof x === "string"));
      } catch { /* ignore corrupt cache */ }
    })();
  }, []);

  const commitSearch = useCallback((term: string) => {
    const t = term.trim();
    if (t.length < 2) return;
    setRecentSearches((cur) => {
      const next = [t, ...cur.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, MAX_RECENT_SEARCHES);
      storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const clearRecentSearches = useCallback(() => {
    setRecentSearches([]);
    storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify([]));
  }, []);

  const header = <>
      {scrollHeader}
      <View style={[styles.head, showCompactFilters && styles.headCompact]}>
        <View style={styles.crumbs}>
          <Text style={styles.crumb} numberOfLines={1}>{brandName}</Text>
          {catName ? (
            <>
              <Feather name="chevron-right" size={12} color={colors.onSurfaceMuted} />
              <Text style={[styles.crumb, styles.crumbActive]} numberOfLines={1}>{catName}</Text>
            </>
          ) : null}
          {!b.productLoading && !b.productError ? <Text testID="explorer-product-count" style={styles.crumbCount}>· {b.productTotal} products</Text> : null}
        </View>

        <View {...(Platform.OS === "web" ? { dataSet: { fieldShell: "true" } } : {})} style={styles.searchWrap}>
          <Feather name="search" size={14} color={colors.onSurfaceMuted} />
          <TextInput
            ref={b.searchRef}
            value={b.q}
            onChangeText={b.setQ}
            onSubmitEditing={() => commitSearch(b.q)}
            accessibilityLabel="Search products by name, SKU or finish"
            placeholder={showCompactFilters ? "Search products, SKU or finish" : "Search products · SKU · finish · ⌘K"}
            placeholderTextColor={colors.onSurfaceMuted}
            style={[styles.searchInput, showCompactFilters && { fontSize: 16 }]}
            testID="explorer-search"
            returnKeyType="search"
          />
          {b.q ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear product search" style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }} onPress={() => b.setQ("")} testID="explorer-search-clear">
              <Feather name="x" size={14} color={colors.onSurfaceMuted} />
            </Pressable>
          ) : null}
        </View>

        {order.canReorder ? <View style={styles.reorderEntry}>
          <Button label="Reorder Products" icon="move" variant="secondary" size="sm" testID="reorder-catalog-products" onPress={() => void order.start()} />
        </View> : null}

        {showCompactFilters ? <View style={styles.filterToolbar}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: filtersOpen }}
            accessibilityLabel="Filters and sort" testID="explorer-filter-toggle" onPress={() => setFiltersOpen(v => !v)} style={styles.filterTrigger}>
            <Feather name="sliders" size={15} color={colors.onSurface} />
            <Text style={styles.filterTriggerLabel}>Filters & sort{b.selectedBrandId || b.selectedCategoryId || b.selectedSizes.length ? " · Active" : ""}</Text>
            <Feather name={filtersOpen ? "chevron-up" : "chevron-down"} size={13} color={colors.onSurface} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Add custom product" testID="explorer-custom-product"
            onPress={() => { b.setPickerSheetOpen(false); b.setCustomProductSheetOpen(true); }} style={[styles.filterTrigger, styles.customTrigger]}>
            <Feather name="plus" size={16} color={colors.onSurface} /><Text style={styles.filterTriggerLabel}>Custom product</Text>
          </Pressable>
        </View> : null}
        {!showCompactFilters ? <ScrollView contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
        {([["sizes", "Size", b.selectedSizes, b.setSelectedSizes]] as const).map(([field, label, selected, update]) => facets[field]?.length ? <View key={field} style={{ gap: 4 }}>
          <Text style={styles.filterHint}>{label} · select multiple</Text>
          <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>
            <FilterPill label="All" active={!selected.length} onPress={() => update([])} />
            {facets[field].map(option => <FilterPill key={option.value} label={option.value} active={selected.includes(option.value)} onPress={() => update(selected.includes(option.value) ? selected.filter(value => value !== option.value) : [...selected, option.value])} />)}
          </ScrollView>
        </View> : null)}

        {/* Keep sorting secondary on phones: filters and the first product row
            should remain reachable without spending the viewport on controls. */}
        {showCompactFilters ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.mobileSortContent}
            testID="mobile-sort-selector"
          >
            {sortOptions.map((opt) => {
              const on = b.sortKey === opt.k;
              return (
                <Pressable
                  key={opt.k}
                  accessibilityRole="button" accessibilityState={{ selected: on }} aria-pressed={on}
                  onPress={() => b.setSortKey(opt.k)}
                  style={[styles.sortChip, on && styles.sortChipActive]}
                  testID={`sort-${opt.k}`}
                >
                  <Feather name={opt.icon} size={11} color={on ? colors.onBrand : colors.onSurfaceSecondary} />
                  <Text style={[styles.sortLabel, on && styles.sortLabelActive]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : (
          <View style={styles.sortRow}>
            {sortOptions.map((opt) => {
              const on = b.sortKey === opt.k;
              return (
                <Pressable
                  key={opt.k}
                  accessibilityRole="button" accessibilityState={{ selected: on }} aria-pressed={on}
                  onPress={() => b.setSortKey(opt.k)}
                  style={[styles.sortChip, on && styles.sortChipActive]}
                  testID={`sort-${opt.k}`}
                >
                  <Feather name={opt.icon} size={11} color={on ? colors.onBrand : colors.onSurfaceSecondary} />
                  <Text style={[styles.sortLabel, on && styles.sortLabelActive]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {!b.q && recentSearches.length > 0 ? (
          <View style={styles.recentRow}>
            <Text style={styles.recentLabel}>Recent searches</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {recentSearches.map((term) => (
                <Pressable
                  key={term}
                  onPress={() => { b.setQ(term); commitSearch(term); }}
                  style={styles.recentChip}
                  testID={`recent-search-${term}`}
                >
                  <Feather name="clock" size={10} color={colors.onSurfaceSecondary} />
                  <Text style={styles.recentChipLabel} numberOfLines={1}>{term}</Text>
                </Pressable>
              ))}
              <Pressable onPress={clearRecentSearches} style={styles.recentClear} testID="recent-search-clear">
                <Text style={styles.recentClearLabel}>Clear</Text>
              </Pressable>
            </ScrollView>
          </View>
        ) : null}
        </ScrollView> : null}
      </View>
    </>;

  if (order.draft) {
    const { products, phase, error, reloadRequired } = order.draft;
    return <View style={styles.panel} testID="catalog-reorder-mode">
      <View style={styles.reorderHeader}>
        <Text accessibilityRole="header" style={styles.reorderTitle}>Reorder Products</Text>
        <Text numberOfLines={2} style={styles.crumb}>{brandName} · {catName || "All Products"}</Text>
        {products.length > 1 && phase === "ready" && !reloadRequired
          ? <Text style={styles.crumb}>{showCompactFilters ? "Touch and hold a card, then drag to move it." : "Drag a card to move it."}</Text>
          : null}
        <View style={styles.reorderActions}>
          <Button label="Cancel" variant="secondary" size="sm" onPress={order.cancel} disabled={phase === "saving"} testID="catalog-cancel-order" />
          {reloadRequired ? <Button label="Reload Order" size="sm" onPress={() => void order.start()} testID="catalog-reload-order" />
            : <Button label="Save Order" size="sm" onPress={() => void order.save()} loading={phase === "saving"}
                disabled={phase !== "ready" || !products.length} testID="catalog-save-order" />}
        </View>
        {error ? <Text accessibilityRole="alert" style={styles.reorderError}>{error}</Text> : null}
      </View>
      {phase === "loading" ? <View style={styles.reorderLoading} accessibilityRole="progressbar" accessibilityLabel="Loading the catalog order">
        <ActivityIndicator color={ds.brass} />
      </View> : products.length ? <CatalogReorderList products={products} onReorder={order.reorder}
        disabled={phase === "saving" || reloadRequired} renderCard={renderReorderCard} columns={numCols} />
        : !error ? <EmptyState icon="package" title="No products in this catalog view" /> : null}
    </View>;
  }

  return (
    <View style={styles.panel} onLayout={(event: LayoutChangeEvent) => {
      const next = Math.round(event.nativeEvent.layout.width);
      if (next !== paneWidth) setPaneWidth(next);
    }}>
      {!showCompactFilters ? header : null}
      <ProductFilterSheet open={showCompactFilters && filtersOpen} onClose={() => setFiltersOpen(false)} facets={facets} />

      <FlatList
        testID="explorer-product-list"
        ListHeaderComponent={showCompactFilters ? header : null}
        // A query keeps the previous page in memory until it settles. Never
        // offer those cards as matches for the new search/filter, including
        // the timeout path where the old page can still be present.
        data={b.productLoading || b.productError ? [] : b.products}
        key={`grid-${numCols}`}
        numColumns={numCols}
        style={{ flex: 1, minHeight: 0 }}
        columnWrapperStyle={numCols > 1 ? { gap: 12, paddingHorizontal: showCompactFilters ? 12 : 16 } : undefined}
        keyExtractor={catalogItemKey}
        contentContainerStyle={{ paddingTop: showCompactFilters ? 0 : 16, paddingHorizontal: numCols > 1 ? 0 : (showCompactFilters ? 12 : 16), gap: 12, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <ProductGridCard
            product={item}
            compact={compactCards}
            width={cardWidth || undefined}
            favourite={favouriteIds.has(item.id)}
            addedQty={catalogProductQuantity(item, roomQuantities)}
            onToggleFav={b.toggleFavourite}
            onQuickAdd={b.addFromProduct}
            onOpenModal={b.openProductModal}
          />
        )}
        removeClippedSubviews={Platform.OS !== "web"}
        // FlatList counts multi-column rows; keep the initial working set in
        // cards so wider grids do not multiply image decoding/render work.
        initialNumToRender={catalogGridRows(numCols, showCompactFilters ? 20 : 16)}
        maxToRenderPerBatch={catalogGridRows(numCols, 12)}
        windowSize={5}
        onEndReached={() => b.loadMoreProducts()}
        onEndReachedThreshold={0.5}
        onScroll={(e) => { if (isNearScrollEnd(e.nativeEvent, 0.5)) b.loadMoreProducts(); }}
        scrollEventThrottle={50}
        ListFooterComponent={
          b.productLoading || b.productError ? null : b.productLoadingMore ? (
            <View style={{ paddingVertical: 20, alignItems: "center" }}>
              <ActivityIndicator size="small" color={ds.brass} />
            </View>
          ) : !b.productLoading && b.products.length > 0 && !b.productHasMore ? (
            <Text style={styles.endOfList}>
              {b.products.length} of {b.productTotal} products — you&apos;ve reached the end
            </Text>
          ) : null
        }
        ListEmptyComponent={
          b.productLoading ? (
            <View testID="explorer-products-loading" accessibilityLabel="Loading products" accessibilityRole="progressbar" style={[styles.skeletonGrid, { flexDirection: numCols > 1 ? "row" : "column", flexWrap: "wrap" }]}>
              {Array.from({ length: numCols > 1 ? 12 : 6 }).map((_, i) => (
                <View key={i} style={[styles.skeletonCard, { width: numCols > 1 ? `${100 / numCols}%` : "100%" }]}>
                  <View style={styles.skeletonMedia} />
                  <View style={{ padding: 10, gap: 8 }}>
                    <View style={[styles.skeletonLine, { width: "85%" }]} />
                    <View style={[styles.skeletonLine, { width: "50%", height: 9 }]} />
                    <View style={[styles.skeletonLine, { width: "40%", height: 13, marginTop: 4 }]} />
                  </View>
                </View>
              ))}
            </View>
          ) : b.productError || b.referenceError ? (
            <ErrorState title="Products unavailable" subtitle={b.productError || b.referenceError || undefined} onRetry={() => { b.retryProducts(); b.retryReferenceData(); }} />
          ) : (
            <EmptyState icon="package" title={hasFilters ? "No products match" : "No products available"}
              subtitle={hasFilters ? "Clear the search and filters to browse all products." : "Add a custom product or retry the catalog."}
              action={hasFilters ? <Button label="Clear search and filters" testID="explorer-clear-filters" variant="secondary" onPress={clearFilters} /> :
                <Button label="Retry catalog" variant="secondary" onPress={b.retryProducts} />} />
          )
        }
      />
    </View>
  );
}

function renderReorderCard(product: CatalogOrderProduct) {
  const web = Platform.OS === "web";
  return <View style={web ? styles.reorderGridCard : styles.reorderCard}>
    <ProductImage source={product.image} style={styles.reorderImage} contentFit="contain" fallbackLabel={product.sku} disableSkeleton />
    <View style={styles.reorderCardText}>
      <Text numberOfLines={2} style={styles.cardName}>{product.name}</Text>
      <Text numberOfLines={1} style={styles.cardSku}>{product.sku}</Text>
    </View>
    <Text numberOfLines={1} style={[styles.reorderPrice, web && styles.reorderGridPrice]}>{catalogPriceUnknown(product) ? "Price unavailable" : money(product.price)}</Text>
  </View>;
}

// -----------------------------------------------------------------------------
// Product grid card
// -----------------------------------------------------------------------------
type CardProps = {
  product: Product;
  compact: boolean;
  width?: number;
  favourite: boolean;
  addedQty: number;
  onToggleFav: (id: string) => void;
  onQuickAdd: (p: Product, v?: ProductVariant) => void;
  onOpenModal: (p: Product) => void;
};

function ProductGridCardImpl({ product, compact, width, favourite, addedQty, onToggleFav, onQuickAdd, onOpenModal }: CardProps) {
  const [chosenVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const selectedVariant = chosenVariant ? product.variants?.find((variant) => variant.id === chosenVariant.id && variant.sku === chosenVariant.sku) ?? chosenVariant : null;
  const badges: { label: string; tone: "popular" | "frequent" | "recent" }[] = [];
  if (product.popular) badges.push({ label: "Popular", tone: "popular" });
  else if (product.frequently_used) badges.push({ label: "Frequently used", tone: "frequent" });
  else if (product.recently_used) badges.push({ label: "Recent", tone: "recent" });
  const selectedImages = useMemo(() => resolveVariantImages(product, selectedVariant), [product, selectedVariant]);
  const selectedSku = selectedVariant?.sku ?? product.sku;
  const selectedPrice = selectedVariant?.price ?? product.price;
  const selectedMrp = selectedVariant?.mrp ?? product.mrp;
  const mrpOverride = selectedVariant ? selectedVariant.catalog_mrp_override : product.catalog_mrp_override;

  return (
    <View
      style={[styles.card, compact && styles.cardCompact, width ? { width, flex: undefined, flexBasis: width, flexGrow: 0, flexShrink: 0 } : null]}
      testID={`product-card-${product.sku}`}
    >
      <View style={[styles.cardMedia, compact && styles.cardMediaCompact]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`View ${product.name}`} onPress={() => onOpenModal(product)} style={styles.thumb}>
          <ProductImage source={selectedImages.images} style={styles.thumb} contentFit="contain" fallbackLabel={selectedSku} disableSkeleton />
        </Pressable>
        {/* Overlay: badges + fav heart */}
        <View pointerEvents="none" style={styles.badgeRow}>
          {badges.slice(0, 1).map((bg) => (
            <View
              key={bg.label}
              style={[
                styles.badge,
                bg.tone === "popular" && { backgroundColor: ds.brassTint },
                bg.tone === "frequent" && { backgroundColor: ds.sunken },
                bg.tone === "recent" && { backgroundColor: ds.sunken },
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  bg.tone === "popular" && { color: ds.brassDeep },
                  bg.tone === "frequent" && { color: ds.inkMid },
                  bg.tone === "recent" && { color: ds.inkMid },
                ]}
              >
                {bg.label}
              </Text>
            </View>
          ))}
        </View>
        <Pressable
          accessibilityRole="button" accessibilityLabel={`${favourite ? "Remove" : "Save"} ${product.name} ${favourite ? "from" : "to"} favorites`} accessibilityState={{ selected: favourite }}
          onPress={() => onToggleFav(product.id)}
          style={styles.favBtn}
          testID={`fav-${product.sku}`}
        >
          <Feather name="heart" size={14} color={favourite ? ds.brass : colors.onSurfaceMuted} />
        </Pressable>
      </View>

      <View style={[styles.cardBody, compact && styles.cardBodyCompact]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Details for ${product.name}`} onPress={() => onOpenModal(product)} style={styles.cardNameTarget}><Text style={[styles.cardName, compact && styles.cardNameCompact]} numberOfLines={2}>{product.name}</Text></Pressable>
        <Text style={styles.cardSku} numberOfLines={1}>
          {selectedSku}{product.brand_name ? ` · ${product.brand_name}` : ""}
        </Text>

        <View style={styles.priceRow}>
          <View style={styles.priceCol}>
            <Text style={styles.price} numberOfLines={1} ellipsizeMode="clip">{catalogPriceUnknown(product, selectedVariant) ? "Price unavailable" : money(selectedPrice)}</Text>
            {mrpOverride || (!catalogPriceUnknown(product, selectedVariant) && selectedMrp > selectedPrice) ? (
              <Text style={[styles.mrp, mrpOverride && styles.currentMrp]} numberOfLines={1} ellipsizeMode="clip">{mrpOverride ? "MRP " : ""}{money(selectedMrp)}</Text>
            ) : null}
          </View>
        </View>
        {catalogPriceUnknown(product, selectedVariant) ? <Pressable accessibilityRole="button" accessibilityLabel="Enter selling price" onPress={() => onOpenModal(selectedVariant ? { ...product, ...selectedVariant, id: selectedVariant.id || product.id, name: selectedVariant.name || product.name, price_unknown: true } : product)} style={styles.cardAdd}><Text style={styles.finishLabel}>Set price</Text></Pressable> : <QuickAddButton onAdd={() => onQuickAdd(product, selectedVariant ?? undefined)} toastText={`${product.name}${selectedVariant ? ` · ${variantDescriptor(selectedVariant) || selectedVariant.sku}` : ""} added to quotation`}
          testID={`add-${product.sku}`} style={styles.cardAdd} />}
        {addedQty > 0 ? <Text accessibilityLiveRegion="polite" style={styles.addedLabel}>{addedQty} in this room</Text> : null}

        <View style={[styles.variantSlot, compact && styles.variantSlotCompact]}>
          {compact && product.variants?.length ? <Pressable accessibilityRole="button" accessibilityLabel={`Choose finish for ${product.name}`} onPress={() => onOpenModal(product)} style={styles.chooseFinish}>
            <Text style={styles.finishLabel}>{product.variants.length} options · Choose finish</Text>
            <Feather name="chevron-right" size={12} color={colors.onSurfaceSecondary} />
          </Pressable> : <VariantSwatchStrip
            product={product}
            onSelect={setSelectedVariant}
            activeSku={selectedVariant?.sku ?? product.sku}
            paddingLeft={0}
          />}
        </View>
      </View>
    </View>
  );
}

const ProductGridCard = memo(ProductGridCardImpl);

// -----------------------------------------------------------------------------
// Size choices remain inline beside the desktop brand rail.
function FilterPill({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: !!active }} aria-pressed={!!active} onPress={onPress}
    style={[styles.filterPill, active && styles.filterPillActive]}>
    <Text style={[styles.filterPillLabel, active && styles.filterPillLabelActive]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, overflow: "hidden", backgroundColor: colors.surface },
  reorderEntry: { alignItems: "flex-start" },
  reorderHeader: { gap: 6, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border },
  reorderTitle: { fontSize: 16, fontWeight: "700", color: colors.onSurface },
  reorderActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  reorderError: { fontSize: 13, color: colors.onSurface },
  reorderLoading: { padding: 24, alignItems: "center" },
  reorderCard: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0, paddingVertical: 5 },
  reorderGridCard: { alignItems: "stretch", gap: 4, minWidth: 0 },
  reorderImage: { width: 42, height: 42, borderRadius: radius.sm, backgroundColor: colors.surfaceSecondary },
  reorderCardText: { flex: 1, minWidth: 0 },
  reorderPrice: { fontSize: 12, color: colors.onSurfaceSecondary, flexShrink: 1, maxWidth: "32%" },
  reorderGridPrice: { maxWidth: "100%" },
  head: {
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary, gap: spacing.sm,
  },
  headCompact: { paddingHorizontal: 16, paddingVertical: 8, gap: 6 },
  cardNameTarget: { minHeight: 44, justifyContent: "center" },
  filterToolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  filterTrigger: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 },
  customTrigger: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface },
  filterTriggerLabel: { fontSize: 13, fontWeight: "600", color: colors.onSurface },
  filterHint: { fontSize: 11, color: colors.onSurfaceSecondary },
  cardAdd: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 4 },
  addedLabel: { fontSize: 12, color: ds.brassDeep, fontWeight: "600" },
  chooseFinish: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 },
  finishLabel: { flex: 1, fontSize: 12, color: colors.onSurfaceSecondary },
  crumbs: { flexDirection: "row", alignItems: "center", gap: 6 },
  crumb: { flexShrink: 1, fontSize: 13, fontWeight: "600", color: colors.onSurfaceSecondary },
  crumbActive: { color: colors.onSurface },
  crumbCount: { fontSize: 12, color: colors.onSurfaceMuted, marginLeft: 4 },

  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    paddingHorizontal: 12, borderRadius: radius.md, minHeight: 44,
  },
  searchInput: { flex: 1, fontSize: 13, paddingVertical: 8, color: colors.onSurface },

  recentRow: { gap: 4 },
  recentLabel: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceMuted, letterSpacing: 0.8, textTransform: "uppercase" },
  recentChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    minHeight: 44, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  recentChipLabel: { fontSize: 11, fontWeight: "600", color: colors.onSurfaceSecondary, maxWidth: 140 },
  recentClear: { paddingHorizontal: 8, paddingVertical: 5, justifyContent: "center" },
  recentClearLabel: { fontSize: 11, fontWeight: "600", color: colors.onSurfaceMuted, textDecorationLine: "underline" },

  filterPill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 11, paddingLeft: 11, minHeight: 44, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  filterPillActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  filterPillLogoWrap: {
    width: 18, height: 18, borderRadius: 9, overflow: "hidden",
    backgroundColor: "#fff", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  filterPillLabel: { fontSize: 12, fontWeight: "600", color: colors.onSurface, maxWidth: 140 },
  filterPillLabelActive: { color: colors.onBrand, fontWeight: "700" },
  filterPillCount: { fontSize: 10, color: colors.onSurfaceMuted },
  filterPillCountActive: { color: colors.onBrand, opacity: 0.85 },

  sortRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  mobileSortContent: { gap: 6, paddingRight: 4 },
  sortChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    minHeight: 44, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill,
    backgroundColor: colors.surfaceTertiary,
  },
  sortChipActive: { backgroundColor: colors.brand },
  sortLabel: { fontSize: 11, fontWeight: "600", color: colors.onSurfaceSecondary },
  sortLabelActive: { color: colors.onBrand },

  card: {
    flex: 1, backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    overflow: "hidden",
  },
  cardCompact: { minHeight: 0 },
  cardMedia: { aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, backgroundColor: colors.surfaceTertiary, position: "relative" },
  // Contain the full product in a fixed frame instead of making each tablet
  // image as tall as the card width. Touch controls retain their 44px size.
  cardMediaCompact: { height: 120, aspectRatio: undefined },
  thumb: { width: "100%", height: "100%" },
  badgeRow: { position: "absolute", top: 8, left: 8, flexDirection: "row", gap: 4 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.2 },
  favBtn: {
    position: "absolute", top: 8, right: 8,
    width: 44, height: 44, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.92)",
    alignItems: "center", justifyContent: "center",
  },
  // Fixed-slot layout: cardName reserves 2 lines' worth of height always
  // (numberOfLines=2 + explicit minHeight) and the variant strip reserves
  // its row height even when a product has no variants — this is what
  // keeps every card in the grid the same height regardless of content.
  cardBody: { padding: 10, gap: 6 },
  cardBodyCompact: { padding: 10, gap: 5 },
  cardName: { fontSize: 14, fontWeight: "600", color: colors.onSurface, lineHeight: 19, minHeight: 38 },
  cardNameCompact: { fontSize: 14, lineHeight: 19, minHeight: 38 },
  cardSku: { fontSize: 12, color: colors.onSurfaceMuted, fontVariant: ["tabular-nums"] },
  priceRow: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 },
  priceCol: { flex: 1, minWidth: 0 },
  price: { fontSize: 14, fontWeight: "600", color: colors.onSurface, fontVariant: ["tabular-nums"], letterSpacing: -0.1 },
  mrp: { fontSize: 10, color: colors.onSurfaceMuted, textDecorationLine: "line-through", fontVariant: ["tabular-nums"] },
  currentMrp: { textDecorationLine: "none" },
  variantSlot: { minHeight: 26, justifyContent: "center" },
  variantSlotCompact: { minHeight: 22 },
  endOfList: {
    textAlign: "center", fontSize: 11, color: colors.onSurfaceMuted,
    paddingVertical: 20, paddingHorizontal: 24,
  },
  skeletonGrid: { gap: 12 },
  skeletonCard: {
    padding: 4,
  },
  skeletonMedia: {
    aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary,
  },
  skeletonLine: {
    height: 11, borderRadius: 4, backgroundColor: colors.surfaceTertiary,
  },
});
