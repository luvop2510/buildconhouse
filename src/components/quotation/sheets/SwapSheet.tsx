// Swap alternates sheet — ranked closest-first, preserves qty/discount/room.
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { BottomSheet } from "@/src/components/BottomSheet";
import { EmptyState } from "@/src/components/ui";
import { ProductImage } from "@/src/components/ProductImage";
import { colors, money, PRODUCT_IMAGE_ASPECT_RATIO, radius, spacing, type } from "@/src/theme/tokens";

import { useBuilder } from "../context/BuilderContext";
import { VariantSwatchStrip } from "../shared/VariantChip";
import { resolveVariantImages } from "../helpers/media";
import { variantDescriptor } from "../helpers/pricing";
import type { Product, ProductVariant } from "../helpers/types";

type SwapChoice = { product: Product; variant: ProductVariant | null };

export function SwapSheet() {
  const b = useBuilder();
  const [choice, setChoice] = useState<SwapChoice | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);

  useEffect(() => {
    if (!b.swapSheet) {
      setChoice(null);
      setIsCommitting(false);
    }
  }, [b.swapSheet]);

  const choiceImage = useMemo(
    () => choice ? resolveVariantImages(choice.product, choice.variant).images : [],
    [choice],
  );
  const choiceLabel = choice
    ? `${choice.product.name}${choice.variant ? ` · ${variantDescriptor(choice.variant) || choice.variant.sku}` : ""}`
    : "";
  const confirmSwap = () => {
    if (!choice || isCommitting) return;
    setIsCommitting(true);
    b.commitSwap(choice.product, choice.variant ?? undefined);
  };

  return (
    <BottomSheet
      visible={!!b.swapSheet}
      onClose={b.closeSwap}
      title="Swap for an alternate"
      testID="swap-sheet"
      footer={choice ? (
        <View style={styles.previewCard} accessibilityLiveRegion="polite">
          <ProductImage source={choiceImage} style={styles.previewImage} fallbackLabel={choice.variant?.sku ?? choice.product.sku} preferOriginal transition={180} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.previewEyebrow}>Ready to replace with</Text>
            <Text style={styles.previewName} numberOfLines={2}>{choiceLabel}</Text>
          </View>
          <Pressable
            testID="swap-confirm"
            accessibilityRole="button"
            accessibilityLabel={`Swap to ${choiceLabel}`}
            accessibilityState={{ disabled: isCommitting }}
            disabled={isCommitting}
            onPress={confirmSwap}
            style={[styles.confirmButton, isCommitting && styles.confirmButtonBusy]}
          >
            {isCommitting ? <ActivityIndicator size="small" color={colors.onBrand} /> : <Feather name="repeat" size={15} color={colors.onBrand} />}
            <Text style={styles.confirmLabel}>{isCommitting ? "Swapping…" : "Swap"}</Text>
          </Pressable>
        </View>
      ) : undefined}
    >
      {b.swapLoading ? (
        <View style={{ alignItems: "center", padding: spacing.xl }}>
          <ActivityIndicator />
        </View>
      ) : b.swapItems.length === 0 ? (
        <EmptyState icon="refresh-cw" title="No alternates found" subtitle="Try a different product." />
      ) : (
        <View style={{ gap: 8 }}>
          <Text style={type.caption}>
            Pick a replacement to preview its exact finish. Qty, discount and room are preserved.
          </Text>
          {b.swapItems.map((p) => (
            <View key={p.id} style={{ gap: 4 }}>
              {(() => {
                const isSelected = choice?.product.id === p.id;
                const preview = resolveVariantImages(p, null);
                return <Pressable
                  testID={`swap-target-${p.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`Select ${p.name}${isSelected ? ", selected" : ""}`}
                  disabled={isCommitting}
                  onPress={() => setChoice({ product: p, variant: null })}
                  style={({ pressed }) => [
                    styles.row,
                    isSelected && styles.rowSelected,
                    { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary },
                  ]}
                >
                <ProductImage source={preview.images} style={styles.thumb} fallbackLabel={p.sku} disableSkeleton />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: colors.onSurface }} numberOfLines={1}>{p.name}</Text>
                  <Text style={type.caption}>{p.sku}{variantDescriptor(p) ? ` · ${variantDescriptor(p)}` : ""}</Text>
                </View>
                <Text style={[type.numeric, { fontSize: 13, lineHeight: 18 }]}>{money(p.price)}</Text>
                <Feather name={isSelected ? "check-circle" : "circle"} size={16} color={isSelected ? colors.brand : colors.onSurfaceMuted} />
                </Pressable>;
              })()}
              <VariantSwatchStrip
                product={p}
                activeSku={choice?.product.id === p.id ? (choice.variant?.sku ?? p.sku) : undefined}
                onSelect={(v) => setChoice({ product: p, variant: v })}
              />
            </View>
          ))}
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 72, flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  rowSelected: { borderColor: colors.brand, borderWidth: 1.5 },
  thumb: { width: 64, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: 8, backgroundColor: colors.surfaceTertiary },
  previewCard: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 10, marginTop: 4,
    borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  previewImage: { width: 76, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: 8, backgroundColor: colors.surfaceTertiary },
  previewEyebrow: { fontSize: 10, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase", color: colors.onSurfaceMuted },
  previewName: { marginTop: 2, fontSize: 12, fontWeight: "700", color: colors.onSurface },
  confirmButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: colors.brand },
  confirmButtonBusy: { opacity: 0.72 },
  confirmLabel: { fontSize: 12, fontWeight: "700", color: colors.onBrand },
});
