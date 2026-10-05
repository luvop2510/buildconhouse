// Small, reusable variant chip + swatch row.
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { colors, money } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { finishSwatch, variantDescriptor } from "../helpers/pricing";
import type { Product, ProductVariant } from "../helpers/types";

export function FinishSwatch({ finish, size = 12 }: { finish?: string | null; size?: number }) {
  return (
    <View
      style={{
        width: size, height: size, borderRadius: 999,
        backgroundColor: finishSwatch(finish),
        borderWidth: 1, borderColor: "rgba(0,0,0,0.12)",
      }}
    />
  );
}

export function VariantChip({
  variant, basePrice, onPress, testID, active,
}: {
  variant: ProductVariant;
  basePrice: number;
  onPress: () => void;
  testID?: string;
  active?: boolean;
}) {
  const delta = (variant.price ?? basePrice) - basePrice;
  const label = variantDescriptor(variant) || variant.sku;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active && { backgroundColor: ds.brassTint, borderColor: ds.brassLine },
        pressed && { opacity: 0.85 },
      ]}
    >
      <FinishSwatch finish={variant.finish} />
      <Text
        style={[styles.label, active && { color: ds.brassDeep }]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {delta !== 0 ? (
        <Text style={[
          styles.delta,
          { color: active ? ds.brassDeep : delta > 0 ? colors.onSurfaceMuted : colors.success },
        ]}>
          {delta > 0 ? "+" : "−"}{money(Math.abs(delta))}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function VariantSwatchStrip({
  product, onSelect, activeSku, paddingLeft = 54,
}: {
  product: Product;
  onSelect: (v: ProductVariant) => void;
  activeSku?: string | null;
  paddingLeft?: number;
}) {
  const variants = product.variants || [];
  if (variants.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 6, paddingLeft, paddingBottom: 2 }}
    >
      {variants.map((v) => (
        <VariantChip
          key={v.sku}
          variant={v}
          basePrice={product.price}
          testID={`variant-${v.sku}`}
          onPress={() => onSelect(v)}
          active={activeSku === v.sku}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  label: { fontSize: 11, fontWeight: "600", color: colors.onSurface, maxWidth: 110 },
  delta: { fontSize: 10, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
