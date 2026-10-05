// Product picker card — tap to quick-add; long-press to focus in the Assistant
// (or open the quick-add sheet on mobile). Whole-row tap and the inline "+"
// both quick-add; both flash the same success confirmation (row tint + toast)
// so the feedback is identical regardless of which hit-target the user used.
import * as Haptics from "expo-haptics";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { toast } from "@/src/components/Toast";
import { ProductImage } from "@/src/components/ProductImage";
import { colors, money, PRODUCT_IMAGE_ASPECT_RATIO, radius, type } from "@/src/theme/tokens";

import { VariantSwatchStrip } from "../shared/VariantChip";
import { QuickAddButton } from "../shared/QuickAddButton";
import { resolveVariantImages } from "../helpers/media";
import { variantDescriptor } from "../helpers/pricing";
import type { Product, ProductVariant } from "../helpers/types";
import { catalogPriceUnknown } from "../helpers/catalogSource";

type Props = {
  product: Product;
  onQuickAdd: (p: Product, v?: ProductVariant) => void;
  onLongPress?: (p: Product) => void;
  onOpenDetails?: (p: Product) => void;
};

const ROW_FLASH_MS = 700;

function PickerCardImpl({ product, onQuickAdd, onLongPress, onOpenDetails }: Props) {
  const [rowFlash, setRowFlash] = useState(false);
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const handleLong = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (onLongPress) onLongPress(product);
    else if (onOpenDetails) onOpenDetails(product);
  };

  const handleRowAdd = () => {
    if (catalogPriceUnknown(product, selectedVariant)) {
      onOpenDetails?.(selectedVariant ? { ...product, ...selectedVariant, id: selectedVariant.id || product.id, name: selectedVariant.name || product.name, price_unknown: true } : product);
      return;
    }
    onQuickAdd(product, selectedVariant ?? undefined);
    Haptics.selectionAsync();
    const finish = selectedVariant ? variantDescriptor(selectedVariant) : "";
    toast.success(`${product.name}${finish ? ` · ${finish}` : ""} added to quotation`);
    setRowFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setRowFlash(false), ROW_FLASH_MS);
  };
  const selectedImages = useMemo(() => resolveVariantImages(product, selectedVariant), [product, selectedVariant]);
  const selectedSku = selectedVariant?.sku ?? product.sku;
  const selectedPrice = selectedVariant?.price ?? product.price;
  const automaticParts = selectedVariant?.specs?.default_included_parts ?? product.specs?.default_included_parts;
  const hasAutomaticPart = Array.isArray(automaticParts) && automaticParts.length > 0;
  const hasConcealedPart = !!(selectedVariant?.concealed_part ?? product.concealed_part)?.sku;

  return (
    <View style={{ gap: 6 }}>
      <Pressable
        testID={`add-product-${product.id}`}
        onPress={handleRowAdd}
        onLongPress={handleLong}
        delayLongPress={280}
        style={({ pressed }) => [
          styles.row,
          rowFlash
            ? { backgroundColor: colors.successBg, borderColor: colors.successBorder }
            : { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary },
        ]}
      >
        <ProductImage source={selectedImages.images} style={styles.thumb} fallbackLabel={selectedSku} disableSkeleton />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.name} numberOfLines={1}>{product.name}</Text>
          <Text style={type.caption} numberOfLines={1}>
            {selectedSku}{variantDescriptor(selectedVariant ?? product) ? ` · ${variantDescriptor(selectedVariant ?? product)}` : ""}
          </Text>
          {(hasAutomaticPart || hasConcealedPart) ? (
            <Text testID={`automatic-parts-${product.id}`} style={styles.automaticPart} numberOfLines={1}>
              {hasAutomaticPart ? "Seat cover added automatically" : "Concealed part added automatically"}
            </Text>
          ) : null}
        </View>
        <Text style={styles.price} numberOfLines={1}>{catalogPriceUnknown(product, selectedVariant) ? "Price unavailable" : money(selectedPrice)}</Text>
        {catalogPriceUnknown(product, selectedVariant) ? <Pressable accessibilityRole="button" accessibilityLabel="Enter selling price" onPress={handleRowAdd} hitSlop={8}><Text style={type.caption}>Set price</Text></Pressable> : <QuickAddButton
          circular
          circularSize={28}
          iconSize={16}
          onAdd={() => onQuickAdd(product, selectedVariant ?? undefined)}
          toastText={`${product.name}${selectedVariant ? ` · ${variantDescriptor(selectedVariant) || selectedVariant.sku}` : ""} added to quotation`}
          testID={`add-plus-${product.id}`}
        />}
      </Pressable>
      <VariantSwatchStrip
        product={product}
        onSelect={(v) => {
          setSelectedVariant(v);
          Haptics.selectionAsync();
        }}
        activeSku={selectedVariant?.sku ?? product.sku}
      />
    </View>
  );
}

export const PickerCard = memo(PickerCardImpl, (a, b) =>
  a.product === b.product && a.onQuickAdd === b.onQuickAdd && a.onOpenDetails === b.onOpenDetails && a.onLongPress === b.onLongPress
);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  thumb: { width: 64, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: 8, backgroundColor: colors.surfaceTertiary },
  name: { fontSize: 13, fontWeight: "600", color: colors.onSurface },
  price: { ...type.numeric, fontSize: 13, lineHeight: 18, color: colors.onSurface, flexShrink: 0 },
  automaticPart: { fontSize: 10, lineHeight: 14, color: colors.success, fontWeight: "600" },
});
