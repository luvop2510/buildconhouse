// Product Detail — premium, mobile-first, Amazon-caliber.
// -----------------------------------------------------------------------------
// Layout
//   * Phone: full-bleed swipeable gallery with page dots, sticky bottom CTA
//   * Tablet: two-column (gallery / details) matching Apple Store PDP
// Content sequence
//   1. Brand & series overline
//   2. Family name (display), colour badge
//   3. Price + save %
//   4. Variant/finish selector (large swatches)
//   5. Description
//   6. Spec table (clean pairs)
//   7. Related products carousel
// Details
//   * Quality banner only when supplier shipped a low-res thumbnail (rare) —
//     styled as a soft inline hint, never a screaming red alert.
//   * Sticky bottom bar on phone: price on left, "Add to quotation" on right.
// -----------------------------------------------------------------------------
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, Pressable,
  ScrollView, Share, StyleSheet, Text, View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { ProductImage } from "@/src/components/ProductImage";
import { productImageList } from "@/src/components/quotation/helpers/media";
import { Button, Card, IconButton, PriceTag } from "@/src/components/ui";
import { ProductEditor } from "@/src/components/catalog/ProductEditor";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/state/auth";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, money, PRODUCT_IMAGE_ASPECT_RATIO, radius, spacing, type } from "@/src/theme/tokens";
import {
  HistorySheet, MovableItem, MoveStageSheet, STAGE_TONE, TransferSheet,
} from "@/src/components/purchases/MovementEngine";

type Product = {
  id: string; name: string; sku: string; description?: string | null;
  finish?: string | null; material?: string | null; dimensions?: string | null; warranty?: string | null;
  price: number; mrp: number; stock: number; images: string[]; tags: string[];
  brand_id: string; category_id: string;
  subcategory?: string | null; series?: string | null; family_key?: string | null;
  family_name?: string | null; variant_label?: string | null;
  finish_code?: string | null; colour?: string | null;
  image_quality?: string | null;
  must_buy_concealed?: boolean;
  concealed_sku?: string | null;
  concealed_skus?: string[];
  hero_image_url?: string | null;
  gallery?: { url: string; role?: string; source_type?: string; quality?: string; family_key?: string | null; width?: number | null; height?: number | null; is_primary?: boolean }[];
  specs?: Record<string, any>;
};

type Brand = { id: string; name: string };

type PipelineItem = {
  item_id: string; po_id: string; po_number: string; sku: string; name: string; image?: string | null;
  customer_id: string; customer_name: string; brand_name?: string | null; supplier_name?: string | null;
  stage: string; stage_label: string; qty: number;
};

function swatchColor(label?: string | null): string {
  const l = (label || "").toLowerCase();
  if (!l) return "#D1D5DB";
  if (l.includes("black")) return "#0F172A";
  if (l.includes("matt white")) return "#F8FAFC";
  if (l.includes("white")) return "#FFFFFF";
  if (l.includes("taupe") || l.includes("beige")) return "#B7A08A";
  if (l.includes("stone") || l.includes("grey") || l.includes("gray")) return "#8A8A8E";
  if (l.includes("chrome") || l.includes("steel") || l.includes("polished")) return "#C0C5CB";
  if (l.includes("brushed") && l.includes("brass")) return "#B08D57";
  if (l.includes("brass") || l.includes("gold")) return "#C6A664";
  if (l.includes("bronze") || l.includes("copper")) return "#8C5E3C";
  if (l.includes("nickel")) return "#7C8791";
  if (l.includes("graphite") || l.includes("anthracite")) return "#3A3A3A";
  return "#D1D5DB";
}

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { isPhone, isWide, pad } = useBreakpoint();
  const insets = useSafeAreaInsets();
  const { staff } = useAuth();
  // Same threshold as backend's require_min_role("purchase") for the media
  // endpoints — keep in sync if that ever changes.
  const canManageImages = !!staff && ["owner", "admin", "manager", "accounts", "purchase"].includes(staff.role);
  const [editorTab, setEditorTab] = useState<"General" | "Pricing" | "Media">("General");

  const [p, setP] = useState<Product | null>(null);
  const [siblings, setSiblings] = useState<Product[]>([]);
  const [alternates, setAlternates] = useState<Product[]>([]);
  const [brandName, setBrandName] = useState<string>("");
  const [imageIdx, setImageIdx] = useState(0);
  const [galleryW, setGalleryW] = useState(0);
  const galleryRef = useRef<FlatList<string>>(null);
  const [pipeline, setPipeline] = useState<PipelineItem[]>([]);
  const [moveItem, setMoveItem] = useState<PipelineItem | null>(null);
  const [transferItem, setTransferItem] = useState<PipelineItem | null>(null);
  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
  const [showImageManager, setShowImageManager] = useState(false);

  const shareProduct = async () => {
    if (!p) return;
    try {
      await Share.share({
        title: p.name,
        message: `${p.name}${p.sku ? ` (${p.sku})` : ""}${brandName ? ` · ${brandName}` : ""} · ${money(p.price)}`,
      });
    } catch {
      // user dismissed the native share sheet — nothing to do
    }
  };

  const toMovable = (it: PipelineItem): MovableItem => ({
    item_id: it.item_id, sku: it.sku, name: it.name, image: it.image, qty: it.qty,
    stage: it.stage as any, customer_id: it.customer_id, customer_name: it.customer_name,
    po_number: it.po_number, brand_name: it.brand_name, supplier_name: it.supplier_name,
  });

  const loadPipeline = async (productId: string) => {
    try {
      const r = await api.get<{ items: PipelineItem[] }>(`/purchases/items?product_id=${productId}&limit=50`);
      setPipeline((r.items || []).filter((it) => it.stage !== "delivered"));
    } catch { setPipeline([]); }
  };

  const [loadError, setLoadError] = useState(false);
  const loadProduct = async (productId: string) => {
    setLoadError(false);
    try {
      const prod = await api.get<Product>(`/products/${productId}`);
      setP(prod);
      loadPipeline(prod.id);
      if (prod.family_key) {
        const res = await api.get<{ items: Product[] }>(`/products?family_key=${encodeURIComponent(prod.family_key)}&limit=20`);
        setSiblings(res.items.filter((x) => x.id !== prod.id));
      }
      try {
        const alt = await api.get<{ items: Product[] }>(`/products/${prod.id}/alternates?limit=6`);
        setAlternates(alt.items || []);
      } catch { /* ignore */ }
      try {
        const brands = await api.get<Brand[]>("/brands");
        const b = brands.find((x) => x.id === prod.brand_id);
        setBrandName(b?.name || "");
      } catch { /* ignore */ }
    } catch {
      setP(null);
      setLoadError(true);
    }
  };

  useEffect(() => {
    if (!id) return;
    // Deliberately NOT clearing `p` here. Switching finishes on this screen
    // is a full navigation (each variant is its own route/id, with its own
    // pipeline/alternates/editor state) — clearing `p` immediately used to
    // blank the whole screen for the duration of the fetch, then pop the new
    // product in, which read as an abrupt flash rather than a smooth finish
    // switch. Keeping the previous product on screen until the new one is
    // ready (then swapping everything in one commit) gives a seamless
    // transition instead, with the trade-off that stale content lingers for
    // one fetch round-trip — imperceptible on a same-origin API call.
    setAlternates([]); setImageIdx(0);
    loadProduct(id);
    // loadProduct intentionally owns its request dependencies; re-running
    // this effect is driven only by the route product id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const ownImageUrls = (item: Pick<Product, "gallery" | "hero_image_url" | "images">): string[] => {
    return productImageList(item);
  };

  // Some supplier rows ship a finish with no photo of its own — never leave
  // the gallery empty when a real photo exists anywhere in this family.
  // Falls back to the first sibling finish (in swatch order) that has one;
  // `isFallbackGallery` lets the UI say so rather than silently implying
  // it's this exact finish's own photograph. Siblings are filtered to the
  // current product's family_key defensively, in case `siblings` state is
  // momentarily stale from the previous product during a finish switch.
  const { urls: galleryUrls, isFallbackGallery } = useMemo(() => {
    if (!p) return { urls: [] as string[], isFallbackGallery: false };
    const own = ownImageUrls(p);
    if (own.length > 0) return { urls: own, isFallbackGallery: false };
    const familySiblings = siblings.filter((s) => s.family_key === p.family_key);
    for (const s of familySiblings) {
      const sOwn = ownImageUrls(s);
      if (sOwn.length > 0) return { urls: sOwn, isFallbackGallery: true };
    }
    return { urls: [], isFallbackGallery: false };
  }, [p, siblings]);

  if (!p) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <SafeAreaView edges={isPhone ? [] : ["top"]} style={styles.topBar}>
          <IconButton icon="chevron-left" onPress={() => router.back()} size={36} tone="surface" accessibilityLabel="Back" />
          <View style={{ flex: 1 }} />
        </SafeAreaView>
        <View style={{ padding: 24, gap: 16 }}>
          <Text accessibilityLiveRegion="polite">{loadError ? "Couldn't load product. Check your connection and try again." : "Loading product…"}</Text>
          {loadError ? <Button label="Retry" onPress={() => { if (id) void loadProduct(id); }} /> : null}
        </View>
      </View>
    );
  }

  const savedPct = p.mrp > p.price ? Math.round((1 - p.price / p.mrp) * 100) : 0;
  const showPoorHint = p.image_quality === "poor";
  const bottomBarHeight = 72;

  const Gallery = (
    <View
      style={{ position: "relative" }}
      onLayout={(e: LayoutChangeEvent) => setGalleryW(e.nativeEvent.layout.width)}
    >
      {isWide ? (
        // Tablet: static hero image + thumb strip (no pager — plays nicer with flex)
        <View>
          <View style={{ aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, backgroundColor: colors.surfaceTertiary, borderRadius: radius.lg, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: "80%", aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO }}>
              <ProductImage
                source={galleryUrls[imageIdx] ? [galleryUrls[imageIdx]] : []}
                style={StyleSheet.absoluteFill as any}
                contentFit="contain"
                fallbackLabel={p.sku}
                borderRadius={0}
              />
            </View>
            {galleryUrls.length > 1 ? (
              <View style={styles.countPill}>
                <Feather name="image" size={11} color="#fff" />
                <Text style={styles.countPillText}>{imageIdx + 1} / {galleryUrls.length}</Text>
              </View>
            ) : null}
          </View>
          {galleryUrls.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 12 }}>
              {galleryUrls.map((url, i) => (
                <Pressable
                  key={i}
                  onPress={() => setImageIdx(i)}
                  style={[styles.thumb, imageIdx === i && { borderColor: colors.brand, borderWidth: 2 }]}
                >
                  <ProductImage source={[url]} style={StyleSheet.absoluteFill as any} contentFit="contain" fallbackLabel="" borderRadius={0} />
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </View>
      ) : (
        // Phone: full-bleed swipeable pager
        <View style={{ backgroundColor: colors.surfaceTertiary, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO }}>
          {galleryW > 0 ? (
            <FlatList
              ref={galleryRef}
              data={galleryUrls.length > 0 ? galleryUrls : [""]}
              keyExtractor={(_, i) => `img-${i}`}
              horizontal pagingEnabled
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                const w = e.nativeEvent.layoutMeasurement.width;
                const i = Math.round(e.nativeEvent.contentOffset.x / (w || 1));
                setImageIdx(i);
              }}
              renderItem={({ item }) => (
                <View style={{ width: galleryW, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary }}>
                  <View style={{ width: "80%", aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO }}>
                    <ProductImage
                      source={item ? [item] : []}
                      style={StyleSheet.absoluteFill as any}
                      contentFit="contain"
                      fallbackLabel={p.sku}
                      borderRadius={0}
                    />
                  </View>
                </View>
              )}
            />
          ) : null}
          {galleryUrls.length > 1 ? (
            <View style={styles.pageDots}>
              {galleryUrls.map((_, i) => (
                <View key={i} style={[styles.dot, imageIdx === i && styles.dotActive]} />
              ))}
            </View>
          ) : null}
          {galleryUrls.length > 1 ? (
            <View style={styles.countPill}>
              <Feather name="image" size={11} color="#fff" />
              <Text style={styles.countPillText}>{imageIdx + 1} / {galleryUrls.length}</Text>
            </View>
          ) : null}
        </View>
      )}
      {galleryUrls.length > 0 && isFallbackGallery ? (
        <Text style={styles.repImageNote}>Representative photo — exact finish photo not available</Text>
      ) : null}
    </View>
  );

  const Details = (
    <View style={{ paddingHorizontal: isWide ? 0 : pad, paddingTop: isPhone ? spacing.lg : 0, gap: spacing.lg }}>
      {/* Brand + series overline */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {brandName ? <Text style={styles.brandTag}>{brandName.toUpperCase()}</Text> : null}
        {p.family_name ? <Text style={styles.overline}>{p.family_name}</Text> : null}
        {p.series ? (
          <>
            {p.family_name ? <Feather name="chevron-right" size={11} color={colors.onSurfaceMuted} /> : null}
            <Text style={styles.overline}>{p.series}</Text>
          </>
        ) : null}
        {p.subcategory ? (
          <>
            <Feather name="chevron-right" size={11} color={colors.onSurfaceMuted} />
            <Text style={styles.overline}>{p.subcategory}</Text>
          </>
        ) : null}
      </View>

      {/* Title — always the product's own editable `name` (this is exactly
          the field the shared Product Editor's "Product Name" writes to,
          so an edit is immediately visible here; family grouping is still
          shown above, in the overline, rather than replacing the title). */}
      <View>
        <Text style={type.displayLg}>{p.name}</Text>
        <Text style={[type.mono, { marginTop: 6, color: colors.onSurfaceMuted }]}>SKU · {p.sku}</Text>
      </View>

      {/* Price */}
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 12 }}>
        <PriceTag price={p.price} mrp={p.mrp} size="xl" />
        {savedPct > 0 ? (
          <View style={styles.savePill}>
            <Text style={styles.savePillText}>SAVE {savedPct}%</Text>
          </View>
        ) : null}
      </View>

      {/* Availability */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.stock > 0 ? colors.success : colors.onSurfaceMuted }} />
        <Text style={{ fontSize: 13, fontWeight: "600", color: p.stock > 0 ? colors.success : colors.onSurfaceMuted }}>
          {p.stock > 0 ? `In stock · ${p.stock} available` : "Made to order"}
        </Text>
      </View>

      {/* Variant / finish selector */}
      {siblings.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
            <Text style={type.overline}>Finish</Text>
            <Text style={type.caption}>{siblings.length + 1} variants</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <VariantSwatch product={p} active onPress={() => {}} />
            {siblings.map((s) => (
              <VariantSwatch key={s.id} product={s} onPress={() => router.replace(`/(admin)/catalog/${s.id}` as any)} />
            ))}
          </View>
        </View>
      ) : p.colour || p.finish ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={[styles.swatchLg, { backgroundColor: swatchColor(p.colour || p.finish) }]} />
          <View>
            <Text style={type.overline}>Finish</Text>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.onSurface, marginTop: 2 }}>
              {p.colour || p.finish}{p.finish_code ? ` · ${p.finish_code}` : ""}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Poor-quality hint — soft inline */}
      {showPoorHint ? (
        <View style={styles.poorHint}>
          <Feather name="info" size={13} color={colors.onSurfaceSecondary} />
          <Text style={{ flex: 1, fontSize: 12, color: colors.onSurfaceSecondary, lineHeight: 17 }}>
            Only a thumbnail is available for this item. High-resolution imagery will be added shortly.
          </Text>
        </View>
      ) : null}

      {/* Description */}
      {p.must_buy_concealed && (p.concealed_skus?.length || p.concealed_sku) ? (
        <View style={[styles.poorHint, { borderColor: "#D97706", backgroundColor: "#FFF7ED" }]}>
          <Feather name="alert-triangle" size={14} color="#B45309" />
          <Text style={{ flex: 1, fontSize: 12, fontWeight: "700", color: "#92400E", lineHeight: 17 }}>
            Must Buy Concealed · {(p.concealed_skus?.length ? p.concealed_skus : [p.concealed_sku]).filter(Boolean).join(", ")}
          </Text>
        </View>
      ) : null}
      {p.description ? (
        <Text style={[type.body, { color: colors.onSurfaceSecondary, lineHeight: 22 }]}>{p.description}</Text>
      ) : null}

      {/* Spec pairs */}
      <View style={{ gap: spacing.sm }}>
        <Text style={type.overline}>Specifications</Text>
        <Card style={{ padding: 0 }}>
          {(
            [
              ["Series", p.series],
              ["Subcategory", p.subcategory],
              ["Colour / Finish", [p.colour, p.finish].filter(Boolean).join(" · ")],
              ["Finish code", p.finish_code],
              ["Material", p.material],
              ["Dimensions", p.dimensions],
              ["Warranty", p.warranty],
              ...((p.specs && Object.keys(p.specs).length)
                ? Object.entries(p.specs).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])
                : []),
            ] as [string, any][]
          )
            .filter(([, v]) => v && String(v).trim() !== "")
            .map(([k, v], i, arr) => (
              <View key={k} style={[styles.specRow, i < arr.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border }]}>
                <Text style={{ fontSize: 13, color: colors.onSurfaceMuted, flex: 1 }}>{k}</Text>
                <Text style={{ fontSize: 13, fontWeight: "600", color: colors.onSurface, flex: 1.4, textAlign: "right" }}>{String(v)}</Text>
              </View>
            ))}
        </Card>
      </View>

      {/* Where this is right now — live purchase pipeline for this SKU */}
      {pipeline.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={type.overline}>Where this is right now · {pipeline.length}</Text>
          <Card style={{ padding: 0 }}>
            {pipeline.map((it, i) => (
              <View
                key={it.item_id}
                style={{
                  flexDirection: "row", alignItems: "center", gap: 10, padding: spacing.md,
                  borderTopWidth: i > 0 ? StyleSheet.hairlineWidth : 0, borderTopColor: colors.border,
                }}
              >
                <Pressable
                  onPress={() => router.push(`/(admin)/purchase-orders/${it.po_id}` as any)}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: colors.onSurface }} numberOfLines={1}>{it.customer_name}</Text>
                  <Text style={type.caption} numberOfLines={1}>
                    {it.po_number} · Qty {it.qty}{it.supplier_name ? ` · via ${it.supplier_name}` : ""}
                  </Text>
                </Pressable>
                <View style={[styles.pipelinePill, { backgroundColor: STAGE_TONE[it.stage as keyof typeof STAGE_TONE]?.bg || colors.surfaceTertiary }]}>
                  <Text style={{ fontSize: 11, fontWeight: "600", color: STAGE_TONE[it.stage as keyof typeof STAGE_TONE]?.fg || colors.onSurfaceMuted }}>
                    {it.stage_label}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  <Pressable onPress={() => setHistoryItemId(it.item_id)} style={styles.pipelineBtn} hitSlop={6}>
                    <Feather name="clock" size={12} color={colors.onSurface} />
                  </Pressable>
                  <Pressable onPress={() => setMoveItem(it)} style={styles.pipelineBtn} hitSlop={6}>
                    <Feather name="arrow-right" size={12} color={colors.onSurface} />
                  </Pressable>
                  <Pressable onPress={() => setTransferItem(it)} style={styles.pipelineBtn} hitSlop={6}>
                    <Feather name="repeat" size={12} color={colors.onSurface} />
                  </Pressable>
                </View>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {/* Actions (inline on tablet; sticky on phone below) */}
      {isWide ? (
        <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
          <Button label="Add to quotation" icon="plus" size="lg" onPress={() => router.push(`/(admin)/quotations/new?productId=${p.id}` as any)} testID="add-to-quote" />
          <Button label="Share" variant="secondary" icon="share-2" size="lg" onPress={shareProduct} testID="share-product-wide" />
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <SafeAreaView edges={isPhone ? [] : ["top"]} style={styles.topBar}>
        <IconButton icon="chevron-left" onPress={() => router.back()} size={36} tone="surface" accessibilityLabel="Back" />
        <View style={{ flex: 1 }}>
          <Text style={type.caption} numberOfLines={1}>{brandName}{p.series ? ` · ${p.series}` : ""}</Text>
        </View>
        {canManageImages ? (
          <IconButton
            icon="edit-2" onPress={() => { setEditorTab("General"); setShowImageManager(true); }} size={36} tone="surface"
            accessibilityLabel="Edit product" testID="manage-images-btn"
          />
        ) : null}
        <IconButton icon="share-2" onPress={shareProduct} size={36} tone="surface" accessibilityLabel="Share" testID="share-product-top" />
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={{ paddingBottom: isPhone ? bottomBarHeight + insets.bottom + spacing.lg : spacing.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        {isWide ? (
          <View style={{ flexDirection: "row", padding: pad, gap: spacing.xxl, alignItems: "flex-start" }}>
            <View style={{ flexBasis: 0, flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{Gallery}</View>
            <View style={{ flexBasis: 0, flexGrow: 1.05, flexShrink: 1, minWidth: 0 }}>{Details}</View>
          </View>
        ) : (
          <>
            {Gallery}
            {Details}
          </>
        )}

        {/* Related products */}
        {alternates.length > 0 ? (
          <View style={{ marginTop: spacing.xxxl, gap: spacing.md, paddingHorizontal: pad }}>
            <View>
              <Text style={type.overline}>Related</Text>
              <Text style={[type.titleLg, { marginTop: 2 }]}>You may also like</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingBottom: 4 }} style={{ marginHorizontal: -pad, paddingHorizontal: pad }}>
              {alternates.map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => router.replace(`/(admin)/catalog/${a.id}` as any)}
                  style={{ width: 180 }}
                >
                  <View style={{ aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surfaceTertiary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
                    <ProductImage
                      source={productImageList(a as any)}
                      style={StyleSheet.absoluteFill as any}
                      contentFit="contain"
                      fallbackLabel={a.sku}
                      borderRadius={0}
                    />
                  </View>
                  <Text numberOfLines={2} style={{ fontSize: 13, fontWeight: "600", color: colors.onSurface, marginTop: 8, minHeight: 34 }}>{a.name}</Text>
                  <View style={{ marginTop: 4 }}><PriceTag price={a.price} mrp={a.mrp} size="sm" /></View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}
      </ScrollView>

      {/* Sticky bottom CTA — phone only */}
      {isPhone ? (
        <View style={[styles.stickyBar, { paddingBottom: insets.bottom + 10 }]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={type.caption}>Total</Text>
            <Text style={{ fontSize: 18, fontWeight: "800", color: colors.onSurface, fontVariant: ["tabular-nums"] }} numberOfLines={1}>{money(p.price)}</Text>
          </View>
          <Button label="Add to quotation" icon="plus" size="md" onPress={() => router.push(`/(admin)/quotations/new?productId=${p.id}` as any)} testID="add-to-quote" />
        </View>
      ) : null}

      <MoveStageSheet
        visible={!!moveItem}
        item={moveItem ? toMovable(moveItem) : null}
        onClose={() => setMoveItem(null)}
        onMoved={async () => { await loadPipeline(p.id); }}
      />
      <TransferSheet
        visible={!!transferItem}
        item={transferItem ? toMovable(transferItem) : null}
        onClose={() => setTransferItem(null)}
        onSuccess={async () => { await loadPipeline(p.id); }}
      />
      <HistorySheet
        visible={!!historyItemId}
        itemId={historyItemId}
        onClose={() => setHistoryItemId(null)}
      />
      {p ? (
        <ProductEditor
          productId={p.id}
          visible={showImageManager}
          initialTab={editorTab}
          onClose={() => setShowImageManager(false)}
          onSaved={(updated) => { setP((cur) => (cur ? ({ ...cur, ...updated } as Product) : cur)); }}
        />
      ) : null}
    </View>
  );
}

function VariantSwatch({ product, active, onPress }: { product: Product; active?: boolean; onPress: () => void }) {
  const label = product.colour || product.variant_label || product.finish || "Variant";
  const c = swatchColor(label);
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row", alignItems: "center", gap: 8,
        borderWidth: active ? 2 : 1, borderColor: active ? colors.brand : colors.border,
        paddingLeft: 5, paddingRight: 12, paddingVertical: 5, borderRadius: 999,
        backgroundColor: active ? colors.brandTint : colors.surfaceSecondary,
      }}
    >
      <View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: c }} />
      <Text style={{ fontSize: 12, fontWeight: active ? "700" : "600", color: colors.onSurface, maxWidth: 140 }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: spacing.md, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  brandTag: { fontSize: 10, fontWeight: "800", color: colors.brand, letterSpacing: 1.3 },
  overline: { fontSize: 10, fontWeight: "700", letterSpacing: 1.1, color: colors.onSurfaceMuted, textTransform: "uppercase" },

  pageDots: {
    position: "absolute", left: 0, right: 0, bottom: 12,
    flexDirection: "row", justifyContent: "center", gap: 5,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(15,23,42,0.25)" },
  dotActive: { width: 18, backgroundColor: colors.brand },
  countPill: {
    position: "absolute", top: 12, right: 12,
    backgroundColor: "rgba(15,23,42,0.72)",
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999,
    flexDirection: "row", alignItems: "center", gap: 4,
  },
  countPillText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  repImageNote: { fontSize: 11, color: colors.onSurfaceMuted, fontStyle: "italic", padding: 8, textAlign: "center" },

  thumb: {
    width: 64, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: radius.sm, overflow: "hidden",
    backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border,
  },

  savePill: {
    backgroundColor: colors.successBg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6,
  },
  savePillText: { color: colors.success, fontSize: 11, fontWeight: "800", letterSpacing: 0.4 },
  swatchLg: {
    width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  poorHint: {
    flexDirection: "row", gap: 8, alignItems: "flex-start",
    padding: 10, backgroundColor: colors.surfaceTertiary, borderRadius: radius.sm,
    borderLeftWidth: 3, borderLeftColor: colors.onSurfaceMuted,
  },
  specRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: 14, gap: 12,
  },
  stickyBar: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: spacing.lg, paddingTop: 10,
    backgroundColor: colors.surfaceSecondary,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
    shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: -8 }, elevation: 8,
  },
  pipelinePill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  pipelineBtn: {
    width: 28, height: 28, borderRadius: radius.sm, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
});
