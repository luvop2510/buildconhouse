// Catalog — premium family-first browsing.
// -----------------------------------------------------------------------------
// Mobile-first layout with tablet-landscape parallel design:
//   * Compact sticky title bar (never wraps, action icons pinned right)
//   * Search + filter icon in a single row → advanced filters live in a bottom
//     sheet so the wall of chip strips doesn't eat vertical space
//   * A single brand strip surfaced above the fold (biggest signal)
//   * Categories collapse into a horizontal scroll strip with icons
//   * FlashList-backed grid, 2 cols phone → 5 cols desktop
//   * Family cards: 1:1 image, series overline, family name, variant swatches,
//     price range on one line, tap = variant PDP
// -----------------------------------------------------------------------------
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { ProductImage } from "@/src/components/ProductImage";
import { productImageList } from "@/src/components/quotation/helpers/media";
import { BottomSheet } from "@/src/components/BottomSheet";
import { Chip, EmptyState, IconButton, PriceTag, ScreenTitle, SegmentedControl, Skeleton, Button } from "@/src/components/ui";
import { catalogReferences, fetchCatalogPage, mergeCatalogPage, type CatalogEntry } from "@/src/services/catalogService";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { colors, money, PRODUCT_IMAGE_ASPECT_RATIO, radius, spacing, type } from "@/src/theme/tokens";
import { supplierLogoFor } from "@/src/design/BrandLogo";
import { isNearScrollEnd } from "@/src/utils/scrollEnd";
import { Image as ExpoImage } from "expo-image";

type Brand = { id: string; name: string; slug?: string; catalog_authoritative?: boolean };
type Category = { id: string; name: string; slug?: string };
type Family = {
  family_key: string | null; family_name: string; brand_id: string; category_id: string;
  listing_id?: string | null; sample_product_id: string; catalog_entry?: CatalogEntry | null; price_unknown?: boolean;
  subcategory?: string | null; series?: string | null;
  min_price: number; max_price: number; product_count: number;
  sample_image?: string | null; sample_image_quality?: string | null;
  floor_id?: string | null;
  variants: {
    id: string; sku: string; variant_label?: string | null; colour?: string | null;
    finish?: string | null; finish_code?: string | null; size?: string | null; price: number; mrp: number;
    image?: string | null; image_quality?: string | null;
  }[];
};
type Product = {
  id: string; name: string; sku: string; brand_id: string; category_id: string;
  listing_id?: string | null; catalog_entry?: CatalogEntry | null; price_unknown?: boolean;
  subcategory?: string | null; series?: string | null;
  price: number; mrp: number; finish?: string | null; images: string[]; stock: number;
  image_quality?: string | null;
  must_buy_concealed?: boolean;
  concealed_sku?: string | null;
  concealed_skus?: string[];
  hero_image_url?: string | null;
  gallery?: { url: string; role?: string; source_type?: string; quality?: string; family_key?: string | null; width?: number | null; height?: number | null; is_primary?: boolean }[] | null;
  family_key?: string | null;
  colour?: string | null;
  floor_id?: string | null;
};

type ViewMode = "families" | "products";

// Category icon mapping — Feather set. Anything not mapped falls back to `package`.
const CATEGORY_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  bathroom: "droplet",
  kitchen: "coffee",
  faucets: "droplet",
  showers: "cloud-drizzle",
  showering: "cloud-drizzle",
  toilet: "circle",
  toilets: "circle",
  accessories: "grid",
  sanitaryware: "circle",
  tapware: "droplet",
  taps: "droplet",
  mixers: "droplet",
  thermostat: "sliders",
  thermostats: "sliders",
  basins: "circle",
  ceramics: "circle",
  wellness: "cloud-drizzle",
  fittings: "settings",
};
function iconFor(name: string): keyof typeof Feather.glyphMap {
  const key = name.toLowerCase().trim();
  for (const k in CATEGORY_ICONS) if (key.includes(k)) return CATEGORY_ICONS[k];
  return "package";
}

// Map colour/finish label to a swatch background
function swatchColor(colour?: string | null, finish?: string | null): string {
  const label = (colour || finish || "").toLowerCase();
  if (!label) return "#D1D5DB";
  if (label.includes("black")) return "#0F172A";
  if (label.includes("matt white")) return "#F8FAFC";
  if (label.includes("white")) return "#FFFFFF";
  if (label.includes("taupe") || label.includes("beige")) return "#B7A08A";
  if (label.includes("stone") || label.includes("grey") || label.includes("gray")) return "#8A8A8E";
  if (label.includes("chrome") || label.includes("steel") || label.includes("polished")) return "#C0C5CB";
  if (label.includes("brushed") && label.includes("brass")) return "#B08D57";
  if (label.includes("brass") || label.includes("gold")) return "#C6A664";
  if (label.includes("brown") || label.includes("red") || label.includes("rust") || label.includes("terracotta")) return "#7B3F2D";
  if (label.includes("bronze") || label.includes("copper")) return "#8C5E3C";
  if (label.includes("nickel")) return "#7C8791";
  if (label.includes("graphite") || label.includes("anthracite")) return "#3A3A3A";
  return "#D1D5DB";
}

export default function Catalog() {
  const router = useRouter();
  const { productCols, pad, isPhone } = useBreakpoint();
  const { selectedFloorId } = useFloorAccess();

  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [subcategories, setSubcategories] = useState<string[]>([]);
  const [seriesList, setSeriesList] = useState<string[]>([]);
  const [brandCounts, setBrandCounts] = useState<Record<string, number>>({});
  const [categoriesForBrand, setCategoriesForBrand] = useState<Category[] | null>(null);
  const [hierarchyTree, setHierarchyTree] = useState<any[]>([]);
  const [families, setFamilies] = useState<Family[] | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const categoryScrollRef = useRef<ScrollView>(null);
  const categoryScrollOffset = useRef(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [subcat, setSubcat] = useState<string | null>(null);
  const [series, setSeries] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("families");

  // A Catalog response is scoped by the selected floor. Never issue an
  // unscoped reference request during floor hydration, and reset all derived
  // selections before the next floor's catalog becomes visible.
  useEffect(() => {
    setBrands([]); setCategories([]); setHierarchyTree([]);
    setBrandId(null); setCat(null); setSubcat(null); setSeries(null);
    setCategoriesForBrand(null); setBrandCounts({});
    setProducts(null); setFamilies(null); setTotal(null); setHasMore(false);
    if (!selectedFloorId) return;
    let active = true;
    (async () => {
      try {
        const [bs, cs] = await Promise.all([
          catalogReferences.brands<Brand[]>({ floorId: selectedFloorId }),
          catalogReferences.categories<Category[]>(undefined, { floorId: selectedFloorId }),
        ]);
        if (!active) return;
        setBrands(bs); setCategories(cs);
        setLoadError(null);
      } catch {
        if (!active) return;
        setBrands([]); setCategories([]);
        setLoadError("Catalog filters could not be loaded. Refresh and sign in again if this persists.");
      }
    })();
    return () => { active = false; };
  }, [selectedFloorId]);

  // Hierarchy is invariant across filter changes. Load and parse it once; the
  // filter-derived rail options below are computed from this stable snapshot.
  useEffect(() => {
    if (!selectedFloorId) return;
    let active = true;
    (async () => {
      try {
        const res = await catalogReferences.hierarchy<{ tree: any[] }>({ floorId: selectedFloorId });
        if (!active) return;
        setHierarchyTree(res.tree);
      } catch {
        if (!active) return;
        setHierarchyTree([]);
        setLoadError("Catalog data could not be loaded. Refresh and sign in again if this persists.");
      }
    })();
    return () => { active = false; };
  }, [selectedFloorId]);

  // Hierarchy → derive brand counts, brand-scoped categories, subcategory & series options
  useEffect(() => {
    const bc: Record<string, number> = {};
    for (const b of hierarchyTree) bc[b.brand.id] = b.product_count;
    setBrandCounts(bc);

    if (brandId) {
      const bNode = hierarchyTree.find((b) => b.brand.id === brandId);
      setCategoriesForBrand(bNode ? bNode.categories.map((c: any) => c.category) : []);
    } else {
      setCategoriesForBrand(null);
    }

    const subs = new Set<string>();
    const ser = new Set<string>();
    for (const b of hierarchyTree) {
      if (brandId && b.brand.id !== brandId) continue;
      for (const c of b.categories) {
        if (cat && c.category.id !== cat) continue;
        for (const s of c.subcategories) {
          subs.add(s.name);
          for (const se of s.series) {
            if (!subcat || subcat === s.name) ser.add(se.name);
          }
        }
      }
    }
    setSubcategories(Array.from(subs).sort());
    setSeriesList(Array.from(ser).sort());
  }, [hierarchyTree, cat, brandId, subcat]);

  const PAGE_SIZE = 60;
  const requestIdRef = useRef(0);
  // A filter/search/mode change replaces the current query result with page 1.
  // Subsequent pages are appended exclusively by `loadMore`, never simulated.
  const load = useCallback(async () => {
    if (!selectedFloorId) return;
    const requestId = ++requestIdRef.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setProducts(null); setFamilies(null); setTotal(null); setHasMore(false);
    try {
      if (mode === "families") {
        const res = await fetchCatalogPage<Family>({
          mode: "families", q, brandId, categoryId: cat, subcategory: subcat, series,
        }, 0, PAGE_SIZE, { floorId: selectedFloorId });
        if (requestId !== requestIdRef.current) return;
        const items = res.items || [];
        setFamilies(items); setTotal(res.total); setHasMore(items.length < res.total);
      } else {
        const res = await fetchCatalogPage<Product>({
          mode: "products", q, brandId, categoryId: cat, subcategory: subcat, series, sort: "popular",
        }, 0, PAGE_SIZE, { floorId: selectedFloorId });
        if (requestId !== requestIdRef.current) return;
        const items = res.items || [];
        setProducts(items); setTotal(res.total); setHasMore(items.length < res.total);
      }
      setLoadError(null);
    } catch {
      if (requestId !== requestIdRef.current) return;
      if (mode === "families") setFamilies([]); else setProducts([]);
      setTotal(0); setHasMore(false);
      setLoadError("Catalog products could not be loaded. Refresh and sign in again if this persists.");
    }
  }, [q, cat, brandId, subcat, series, mode, selectedFloorId]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || total === null || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const requestId = requestIdRef.current;
    const currentLength = mode === "families" ? (families || []).length : (products || []).length;
    try {
      if (mode === "families") {
        const currentFamilies = families || [];
        const res = await fetchCatalogPage<Family>({
          mode: "families", q, brandId, categoryId: cat, subcategory: subcat, series,
        }, currentLength, PAGE_SIZE, { floorId: selectedFloorId || undefined });
        if (requestId !== requestIdRef.current) return;
        const incoming = res.items || [];
        const merged = mergeCatalogPage(currentFamilies, incoming);
        setFamilies(merged); setTotal(res.total); setHasMore(merged.length < res.total && incoming.length > 0);
      } else {
        const currentProducts = products || [];
        const res = await fetchCatalogPage<Product>({
          mode: "products", q, brandId, categoryId: cat, subcategory: subcat, series, sort: "popular",
        }, currentLength, PAGE_SIZE, { floorId: selectedFloorId || undefined });
        if (requestId !== requestIdRef.current) return;
        const incoming = res.items || [];
        const merged = mergeCatalogPage(currentProducts, incoming);
        setProducts(merged); setTotal(res.total); setHasMore(merged.length < res.total && incoming.length > 0);
      }
    } catch {
      // Preserve the loaded page and leave the user able to retry by scrolling.
    } finally {
      if (requestId === requestIdRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [q, cat, brandId, subcat, series, families, hasMore, mode, products, selectedFloorId, total]);

  const brandById: Record<string, string> = useMemo(
    () => Object.fromEntries(brands.map((b) => [b.id, b.name])), [brands],
  );
  const activeFilterCount = [brandId, subcat, series].filter(Boolean).length;
  const resetFilters = () => { setBrandId(null); setSubcat(null); setSeries(null); };
  const clearAll = () => { setQ(""); setCat(null); resetFilters(); };
  const hasActiveFilters = Boolean(q) || Boolean(cat) || activeFilterCount > 0;

  const subtitle = total === null
    ? "Loading…"
    : `${total.toLocaleString("en-IN")} ${mode === "families" ? "families" : "products"}${cat ? " · filtered" : ""}`;

  const gridPadding = pad;
  const gap = 14;

  // Header actions
  const HeaderRight = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <IconButton
        icon="upload-cloud"
        onPress={() => router.push("/(admin)/catalog/import" as any)}
        size={36}
        tone="surface"
        testID="import-catalog-btn"
        accessibilityLabel="Import catalog"
      />
    </View>
  );

  const gridItems = mode === "families" ? families : products;
  const catalogItems = gridItems || [];
  const showSkeleton = gridItems === null;
  const showEmpty = !showSkeleton && catalogItems.length === 0;

  const renderCatalogItem = ({ item }: { item: Family | Product }) => (
    <View style={{ width: `${100 / productCols}%`, paddingHorizontal: gap / 2, paddingBottom: gap }}>
      {mode === "families" ? (
        <FamilyCard
          family={item as Family}
          brandName={brandById[(item as Family).brand_id] || ""}
          onPress={() => router.push(`/(admin)/catalog/${(item as Family).sample_product_id || (item as Family).variants[0]?.id}${item.listing_id ? `?catalogEntryId=${encodeURIComponent(item.listing_id)}` : ""}` as any)}
        />
      ) : (
        <ProductCard
          product={item as Product}
          brandName={brandById[(item as Product).brand_id] || ""}
          onPress={() => router.push(`/(admin)/catalog/${(item as Product).id}${item.listing_id ? `?catalogEntryId=${encodeURIComponent(item.listing_id)}` : ""}` as any)}
        />
      )}
    </View>
  );

  const catalogHeader = (
    <View style={{ paddingTop: spacing.md, paddingBottom: spacing.md, gap: spacing.md }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={styles.searchWrap}>
          <Feather name="search" size={16} color={colors.onSurfaceMuted} />
          <TextInput
            testID="catalog-search"
            value={q}
            onChangeText={setQ}
            placeholder="Search products, series, SKU…"
            placeholderTextColor={colors.onSurfaceMuted}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {q ? (
            <Pressable onPress={() => setQ("")} hitSlop={8}>
              <Feather name="x" size={16} color={colors.onSurfaceMuted} />
            </Pressable>
          ) : null}
        </View>
        <Pressable testID="catalog-filter-btn" onPress={() => setFiltersOpen(true)} style={styles.filterBtn}>
          <Feather name="sliders" size={16} color={colors.onSurface} />
          {activeFilterCount > 0 ? <View style={styles.filterDot}><Text style={styles.filterDotText}>{activeFilterCount}</Text></View> : null}
        </Pressable>
      </View>

      {!isPhone ? <>
      <View style={styles.horizontalStrip}>
        <ScrollView
          horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingRight: gridPadding + 28, paddingVertical: 2 }}
          style={{ marginHorizontal: -gridPadding, paddingHorizontal: gridPadding }}
        >
          <BrandPill
            label="All brands"
            count={brands.reduce((sum, b) => sum + (brandCounts[b.id] || 0), 0)}
            active={!brandId}
            onPress={() => { setBrandId(null); setCat(null); setSubcat(null); setSeries(null); }}
            testID="brand-pill-all"
          />
          {brands.map((b) => (
            <BrandPill
              key={b.id}
              label={b.name}
              logo={supplierLogoFor(b.name)}
              count={brandCounts[b.id]}
              active={brandId === b.id}
              onPress={() => { setBrandId(brandId === b.id ? null : b.id); setCat(null); setSubcat(null); setSeries(null); }}
              testID={`brand-pill-${b.id}`}
            />
          ))}
        </ScrollView>
        <View pointerEvents="none" style={styles.stripOverflowCue}>
          <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
        </View>
      </View>

      <View style={styles.horizontalStrip}>
      <ScrollView
        ref={categoryScrollRef}
        horizontal showsHorizontalScrollIndicator
        onScroll={(event) => { categoryScrollOffset.current = event.nativeEvent.contentOffset.x; }}
        scrollEventThrottle={32}
        contentContainerStyle={{ gap: 8, paddingLeft: 32, paddingRight: gridPadding + 48, paddingVertical: 2 }}
        style={{ marginHorizontal: -gridPadding, paddingHorizontal: gridPadding }}
      >
        <CategoryPill label="All categories" icon="grid" active={!cat} onPress={() => { setCat(null); setSubcat(null); setSeries(null); }} testID="cat-all" />
        {(categoriesForBrand ?? categories).map((c) => (
          <CategoryPill
            key={c.id}
            label={c.name}
            icon={iconFor(c.name)}
            active={cat === c.id}
            onPress={() => { setCat(cat === c.id ? null : c.id); setSubcat(null); setSeries(null); }}
            testID={`cat-${c.id}`}
          />
        ))}
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel="Scroll categories right"
        testID="category-scroll-right" onPress={() => { categoryScrollOffset.current += 300; categoryScrollRef.current?.scrollTo({ x: categoryScrollOffset.current, animated: true }); }}
        style={styles.categoryScrollRight}>
        <Feather name="chevron-right" size={18} color={colors.onSurface} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Scroll categories left"
        testID="category-scroll-left" onPress={() => { categoryScrollOffset.current = Math.max(0, categoryScrollOffset.current - 300); categoryScrollRef.current?.scrollTo({ x: categoryScrollOffset.current, animated: true }); }}
        style={styles.categoryScrollLeft}>
        <Feather name="chevron-left" size={18} color={colors.onSurface} />
      </Pressable>
      </View>
      </> : hasActiveFilters ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingRight: 8 }}>
          {brandId ? <ActiveChip label={brandById[brandId] || "Brand"} onClose={() => { setBrandId(null); setCat(null); }} /> : null}
          {cat ? <ActiveChip label={(categoriesForBrand ?? categories).find((item) => item.id === cat)?.name || "Category"} onClose={() => setCat(null)} /> : null}
          <Pressable onPress={clearAll} style={styles.clearAll}><Text style={styles.clearAllText}>Clear</Text></Pressable>
        </ScrollView>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={(subcat || series) ? { flex: 1, flexShrink: 1 } : undefined}>
          {(subcat || series) ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingRight: 8 }}>
              {subcat ? <ActiveChip label={subcat} onClose={() => { setSubcat(null); setSeries(null); }} /> : null}
              {series ? <ActiveChip label={series} onClose={() => setSeries(null)} /> : null}
              <Pressable onPress={resetFilters} style={styles.clearAll}><Text style={styles.clearAllText}>Clear</Text></Pressable>
            </ScrollView>
          ) : null}
        </View>
        <SegmentedControl<ViewMode>
          testID="mode-toggle"
          size="sm"
          value={mode}
          options={[{ value: "families", label: "Families", icon: "layers" }, { value: "products", label: "Variants", icon: "grid" }]}
          onChange={setMode}
        />
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScreenTitle title="Catalog" subtitle={subtitle} right={HeaderRight} />
      <FlatList
        key={`catalog-${mode}-${productCols}`}
        data={catalogItems}
        numColumns={productCols}
        keyExtractor={(item) => item.listing_id || (mode === "families" ? ((item as Family).family_key || (item as Family).sample_product_id) : (item as Product).id)}
        renderItem={renderCatalogItem}
        style={{ flex: 1, minHeight: 0 }}
        ListHeaderComponent={catalogHeader}
        ListHeaderComponentStyle={{ paddingHorizontal: gridPadding }}
        columnWrapperStyle={productCols > 1 && catalogItems.length ? { marginHorizontal: gridPadding - gap / 2 } : undefined}
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={Platform.OS !== "web"}
        initialNumToRender={isPhone ? 12 : Platform.OS === "web" ? 40 : 24}
        maxToRenderPerBatch={isPhone ? 12 : Platform.OS === "web" ? 30 : 24}
        windowSize={isPhone ? 7 : 11}
        onEndReached={loadMore}
        onEndReachedThreshold={0.45}
        onScroll={(e) => { if (isNearScrollEnd(e.nativeEvent)) loadMore(); }}
        scrollEventThrottle={50}
        ListEmptyComponent={
          showSkeleton ? (
            <View style={[styles.skeletonGrid, { paddingHorizontal: gridPadding - gap / 2, flexDirection: "row", flexWrap: "wrap" }]}>
              {Array.from({ length: 8 }).map((_, i) => (
                <View key={`sk-${i}`} style={{ width: `${100 / productCols}%`, paddingHorizontal: gap / 2, paddingBottom: gap }}>
                  <SkeletonCard tall={mode === "families"} />
                </View>
              ))}
            </View>
          ) : loadError ? (
            <View style={{ paddingHorizontal: gridPadding }}>
              <EmptyState icon="alert-triangle" title="Couldn't load the catalog" subtitle={loadError} action={<Button label="Try again" variant="secondary" onPress={load} />} />
            </View>
          ) : showEmpty ? (
            <View style={{ paddingHorizontal: gridPadding }}>
              {hasActiveFilters ? (
                <EmptyState icon="package" title="Nothing matches" subtitle="Try clearing filters or adjusting your search." action={<Button label="Reset filters" variant="secondary" onPress={clearAll} />} />
              ) : (
                <EmptyState
                  icon="package"
                  title="No products on this floor yet"
                  subtitle="This floor's catalog is empty — import products to get started."
                  action={<Button label="Import catalog" variant="secondary" onPress={() => router.push("/(admin)/catalog/import" as any)} />}
                />
              )}
            </View>
          ) : null
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.listFooter}><ActivityIndicator size="small" color={colors.brand} /><Text style={type.caption}>Loading more…</Text></View>
          ) : total !== null && catalogItems.length > 0 && !hasMore ? (
            <Text testID="catalog-end-of-list" style={styles.endOfList}>Showing all {catalogItems.length.toLocaleString("en-IN")} {mode === "families" ? "families" : "products"}</Text>
          ) : null
        }
      />

      <FiltersSheet
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        brands={brands}
        categories={categoriesForBrand ?? categories}
        subcategories={subcategories}
        seriesList={seriesList}
        brandId={brandId} setBrandId={setBrandId}
        cat={cat} setCat={setCat}
        subcat={subcat} setSubcat={setSubcat}
        series={series} setSeries={setSeries}
        onReset={resetFilters}
      />
    </View>
  );
}

// ---------- Brand pill (logo + label + count) ----------
function BrandPill({
  label, logo, count, active, onPress, testID,
}: {
  label: string; logo?: any; count?: number;
  active?: boolean; onPress?: () => void; testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label}${count != null ? `, ${count.toLocaleString("en-IN")} products` : ""}`}
      accessibilityState={{ selected: Boolean(active) }}
      style={{
        flexDirection: "row", alignItems: "center", gap: 8,
        paddingHorizontal: 12, paddingLeft: logo ? 6 : 12, height: 40, borderRadius: 999,
        borderWidth: 1, borderColor: active ? colors.brand : colors.border,
        backgroundColor: active ? colors.brand : colors.surfaceSecondary,
      }}
    >
      {logo ? (
        <View style={styles.brandPillLogoWrap}>
          <ExpoImage source={logo} style={{ width: "100%", height: "100%" }} contentFit="cover" />
        </View>
      ) : null}
      <Text style={{ color: active ? colors.onBrand : colors.onSurface, fontSize: 13, fontWeight: active ? "700" : "500" }}>{label}</Text>
      {count != null ? (
        <Text style={{ color: active ? colors.onBrand : colors.onSurfaceMuted, fontSize: 11, opacity: 0.85 }}>
          {count.toLocaleString("en-IN")}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ---------- Category pill (icon + label) ----------
function CategoryPill({
  label, icon, active, onPress, testID,
}: {
  label: string; icon: keyof typeof Feather.glyphMap;
  active?: boolean; onPress?: () => void; testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Filter by ${label}`}
      accessibilityState={{ selected: Boolean(active) }}
      style={{
        flexDirection: "row", alignItems: "center", gap: 8,
        paddingHorizontal: 14, height: 44, borderRadius: 999,
        borderWidth: 1, borderColor: active ? colors.brand : colors.border,
        backgroundColor: active ? colors.brand : colors.surfaceSecondary,
      }}
    >
      <Feather name={icon} size={14} color={active ? colors.onBrand : colors.onSurfaceSecondary} />
      <Text style={{ color: active ? colors.onBrand : colors.onSurface, fontSize: 13, fontWeight: active ? "700" : "500" }}>{label}</Text>
    </Pressable>
  );
}

function ActiveChip({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 6,
      paddingLeft: 10, paddingRight: 4, height: 44,
      backgroundColor: colors.brand, borderRadius: 999,
    }}>
      <Text style={{ color: colors.onBrand, fontSize: 11, fontWeight: "700" }} numberOfLines={1}>{label}</Text>
      <Pressable
        onPress={onClose}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label} filter`}
        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", marginRight: -9 }}
      >
        <Feather name="x" size={12} color={colors.onBrand} />
      </Pressable>
    </View>
  );
}

// ---------- Family card ----------
function FamilyCard({ family: f, brandName, onPress }: { family: Family; brandName: string; onPress: () => void }) {
  const representative = f.variants[0];
  const isTile = f.floor_id === "ground-floor";
  return (
    <Pressable
      testID={`family-${f.listing_id || f.family_key || f.sample_product_id}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { opacity: pressed ? 0.9 : 1 }]}
    >
      <View style={[styles.imageWrap, f.floor_id === "ground-floor" && styles.imageWrapTile]}>
        <ProductImage
          source={f.sample_image ? [f.sample_image] : []}
          style={StyleSheet.absoluteFill as any}
          contentFit="contain"
          fallbackLabel={f.variants[0]?.sku || ""}
          borderRadius={0}
        />
        <View style={styles.brandOverlay}>
          <Text style={styles.brandOverlayText}>{brandName.toUpperCase()}</Text>
        </View>
        {f.product_count > 1 ? (
          <View style={styles.variantsPill}>
            <Text style={styles.variantsPillText}>{f.product_count} variants</Text>
          </View>
        ) : null}
      </View>
      <View style={{ padding: 12, gap: 4 }}>
        <View style={styles.metaSlot}>
          {(f.catalog_entry || f.series || f.subcategory) ? (
            <Text style={styles.overlineSubtle} numberOfLines={1}>{f.catalog_entry ? [f.catalog_entry.serial_number, f.catalog_entry.category_name, f.subcategory].filter((v) => v !== null && v !== undefined && v !== "").join(" · ") : f.series || f.subcategory}</Text>
          ) : null}
        </View>
        <Text numberOfLines={2} style={styles.title}>{f.family_name}</Text>
        {(isTile || f.catalog_entry) && representative ? (
          <Text style={type.caption} numberOfLines={2}>
            {[f.catalog_entry?.source_sku || representative.sku, representative.size, representative.finish].filter(Boolean).join(" · ")}
          </Text>
        ) : null}

        {/* swatch row — reserved height always, so family cards with and
            without multiple variants sit at identical row heights (same
            fix pattern as the Quotation Builder's picker grid). */}
        <View style={styles.variantSlot}>
          {f.variants.length > 1 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
              {f.variants.slice(0, 5).map((v) => (
                <View key={v.id} style={styles.swatchRing}>
                  <View style={[styles.swatchDot, { backgroundColor: swatchColor(v.colour, v.finish) }]} />
                </View>
              ))}
              {f.variants.length > 5 ? (
                <View style={styles.swatchRing}>
                  <Text style={{ fontSize: 8, fontWeight: "700", color: colors.onSurfaceMuted }}>+{f.variants.length - 5}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={{ marginTop: 6 }}>
          {f.price_unknown ? <Text style={type.bodyMuted}>Price unavailable</Text> : f.max_price > f.min_price ? (
            <Text style={styles.priceRange} numberOfLines={1}>
              {money(f.min_price)}
              <Text style={styles.priceRangeMuted}> – {money(f.max_price)}</Text>
            </Text>
          ) : (
            <PriceTag price={f.min_price} size="md" />
          )}
        </View>
      </View>
    </Pressable>
  );
}

// ---------- Product (variant) card ----------
function ProductCard({ product: p, brandName, onPress }: { product: Product; brandName: string; onPress: () => void }) {
  return (
    <Pressable
      testID={`product-${p.listing_id || p.id}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { opacity: pressed ? 0.9 : 1 }]}
    >
      <View style={[styles.imageWrap, p.floor_id === "ground-floor" && styles.imageWrapTile]}>
        <ProductImage
          source={productImageList(p as any)}
          style={StyleSheet.absoluteFill as any}
          contentFit="contain"
          fallbackLabel={p.sku}
          borderRadius={0}
        />
        <View style={styles.brandOverlay}>
          <Text style={styles.brandOverlayText}>{brandName.toUpperCase()}</Text>
        </View>
        {!p.price_unknown && p.mrp > p.price ? (
          <View style={styles.discountPill}>
            <Text style={styles.discountPillText}>−{Math.round((1 - p.price / p.mrp) * 100)}%</Text>
          </View>
        ) : null}
      </View>
      <View style={{ padding: 12, gap: 4 }}>
        <View style={styles.metaSlot}>
          {p.catalog_entry || p.series ? <Text style={styles.overlineSubtle} numberOfLines={1}>{p.catalog_entry ? [p.catalog_entry.serial_number, p.catalog_entry.category_name, p.subcategory].filter((v) => v !== null && v !== undefined && v !== "").join(" · ") : p.series}</Text> : null}
        </View>
        <Text numberOfLines={2} style={styles.title}>{p.name}</Text>
        <Text style={type.caption} numberOfLines={1}>{p.catalog_entry?.source_sku || p.sku}{p.finish ? ` · ${p.finish}` : ""}</Text>
        {p.must_buy_concealed && (p.concealed_skus?.length || p.concealed_sku) ? (
          <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: "700", color: "#B45309" }}>
            Must Buy Concealed · {(p.concealed_skus?.length ? p.concealed_skus : [p.concealed_sku]).filter(Boolean).join(", ")}
          </Text>
        ) : null}
        <View style={{ marginTop: 6 }}>
          {p.price_unknown ? <Text style={type.bodyMuted}>Price unavailable</Text> : <PriceTag price={p.price} mrp={p.mrp} size="md" />}
        </View>
      </View>
    </Pressable>
  );
}

function SkeletonCard({ tall }: { tall?: boolean }) {
  return (
    <View style={styles.card}>
      <View style={[styles.imageWrap, { height: tall ? 180 : 160 }]}>
        <Skeleton w="100%" h={tall ? 180 : 160} />
      </View>
      <View style={{ padding: 12, gap: 8 }}>
        <Skeleton w="70%" />
        <Skeleton w="40%" />
        <Skeleton w="50%" h={16} />
      </View>
    </View>
  );
}

// ---------- Filters bottom sheet ----------
function FiltersSheet({
  visible, onClose, brands, categories, subcategories, seriesList,
  brandId, setBrandId, cat, setCat, subcat, setSubcat, series, setSeries, onReset,
}: {
  visible: boolean; onClose: () => void;
  brands: Brand[]; categories: Category[]; subcategories: string[]; seriesList: string[];
  brandId: string | null; setBrandId: (v: string | null) => void;
  cat: string | null; setCat: (v: string | null) => void;
  subcat: string | null; setSubcat: (v: string | null) => void;
  series: string | null; setSeries: (v: string | null) => void;
  onReset: () => void;
}) {
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Filters"
      testID="catalog-filters"
      footer={
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}><Button label="Reset" variant="secondary" onPress={() => { onReset(); }} fullWidth /></View>
          <View style={{ flex: 1 }}><Button label="Show results" onPress={onClose} fullWidth /></View>
        </View>
      }
    >
      <View style={{ gap: spacing.xl }}>
        <FilterSection title="Brand">
          <Chip label="Any" active={!brandId} onPress={() => { setBrandId(null); setCat(null); setSubcat(null); setSeries(null); }} />
          {brands.map((brand) => (
            <Chip key={brand.id} label={brand.name} active={brandId === brand.id} onPress={() => { setBrandId(brandId === brand.id ? null : brand.id); setCat(null); setSubcat(null); setSeries(null); }} />
          ))}
        </FilterSection>
        <FilterSection title="Category">
          <Chip label="Any" active={!cat} onPress={() => { setCat(null); setSubcat(null); setSeries(null); }} />
          {categories.map((category) => (
            <Chip key={category.id} label={category.name} active={cat === category.id} onPress={() => { setCat(cat === category.id ? null : category.id); setSubcat(null); setSeries(null); }} />
          ))}
        </FilterSection>
        {subcategories.length > 0 ? (
          <FilterSection title="Subcategory">
            <Chip label="Any" active={!subcat} onPress={() => { setSubcat(null); setSeries(null); }} testID="subcat-all" />
            {subcategories.map((s) => (
              <Chip key={s} label={s} active={subcat === s} onPress={() => { setSubcat(subcat === s ? null : s); setSeries(null); }} />
            ))}
          </FilterSection>
        ) : null}
        {seriesList.length > 0 ? (
          <FilterSection title="Series">
            <Chip label="Any" active={!series} onPress={() => setSeries(null)} testID="series-all" />
            {seriesList.map((s) => (
              <Chip key={s} label={s} active={series === s} onPress={() => setSeries(series === s ? null : s)} />
            ))}
          </FilterSection>
        ) : null}
      </View>
    </BottomSheet>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={type.overline}>{title}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  skeletonGrid: { flexDirection: "row", flexWrap: "wrap" },
  horizontalStrip: { position: "relative" },
  categoryScrollRight: { position: "absolute", right: 0, top: 0, bottom: 0, width: 32, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceSecondary },
  categoryScrollLeft: { position: "absolute", left: 0, top: 0, bottom: 0, width: 32, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceSecondary },
  stripOverflowCue: {
    position: "absolute", top: 0, right: -2, bottom: 0, width: 30,
    alignItems: "flex-end", justifyContent: "center",
    backgroundColor: colors.surface,
  },
  searchWrap: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 10,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 14, borderRadius: radius.md, height: 44,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.onSurface, height: 44 },
  filterBtn: {
    width: 44, height: 44, borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center", position: "relative",
  },
  filterDot: {
    position: "absolute", top: 6, right: 6, minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: colors.brand, alignItems: "center", justifyContent: "center", paddingHorizontal: 3,
  },
  filterDotText: { color: colors.onBrand, fontSize: 9, fontWeight: "800" },
  clearAll: { paddingHorizontal: 10, height: 26, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  clearAllText: { fontSize: 11, fontWeight: "600", color: colors.onSurfaceMuted, textDecorationLine: "underline" },
  brandPillLogoWrap: {
    width: 28, height: 28, borderRadius: 14, overflow: "hidden",
    backgroundColor: "#fff", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },

  card: {
    backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  imageWrap: {
    width: "100%", aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, backgroundColor: colors.surfaceTertiary, position: "relative",
  },
  imageWrapTile: {
    aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO,
  },
  brandOverlay: {
    position: "absolute", top: 10, left: 10,
    backgroundColor: "rgba(255,255,255,0.95)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
  },
  brandOverlayText: { fontSize: 9, fontWeight: "800", color: colors.onSurface, letterSpacing: 0.8 },
  variantsPill: {
    position: "absolute", bottom: 10, right: 10,
    backgroundColor: "rgba(24,24,27,0.88)", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
  },
  variantsPillText: { color: "#fff", fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  discountPill: {
    position: "absolute", top: 10, right: 10,
    backgroundColor: colors.brand, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
  },
  discountPillText: { color: colors.onBrand, fontSize: 10, fontWeight: "800" },
  overlineSubtle: { fontSize: 10, fontWeight: "700", letterSpacing: 1.1, color: colors.onSurfaceMuted, textTransform: "uppercase" },
  title: { fontSize: 14, fontWeight: "600", color: colors.onSurface, lineHeight: 18, minHeight: 36 },
  priceRange: { fontSize: 14, fontWeight: "700", color: colors.onSurface, fontVariant: ["tabular-nums"] },
  priceRangeMuted: { fontSize: 12, fontWeight: "500", color: colors.onSurfaceMuted },
  swatchRing: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center", overflow: "hidden",
    backgroundColor: colors.surfaceSecondary,
  },
  swatchDot: { width: 16, height: 16, borderRadius: 8 },
  variantSlot: { minHeight: 24, justifyContent: "center", marginTop: 2 },
  metaSlot: { minHeight: 14, justifyContent: "center" },
  listFooter: { paddingVertical: 20, alignItems: "center", justifyContent: "center", gap: 8 },
  endOfList: { textAlign: "center", paddingVertical: 24, color: colors.onSurfaceMuted, fontSize: 12, fontWeight: "600" },
});
