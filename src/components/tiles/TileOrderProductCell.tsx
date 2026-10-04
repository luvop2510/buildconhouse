import { memo } from "react";
import { StyleSheet, View } from "react-native";

import { ProductImage } from "@/src/components/ProductImage";
import { PRODUCT_IMAGE_ASPECT_RATIO, spacing } from "@/src/theme/tokens";
import { CellStack } from "./TileTable";

type Props = {
  name: string;
  subtitle?: string;
  sku?: string | null;
  image?: string | null;
  testID: string;
};

/** Shared bounded product identity for customer movements and supplier release. */
export const TileOrderProductCell = memo(function TileOrderProductCell({ name, subtitle, sku, image, testID }: Props) {
  return <View style={styles.row}>
    <ProductImage source={image} style={styles.image} contentFit="contain" disableSkeleton
      fallbackLabel={sku} testID={testID} accessibilityLabel={`Product image for ${name}`} />
    <View style={styles.identity}><CellStack title={name} subtitle={subtitle} /></View>
  </View>;
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minWidth: 0 },
  image: { width: 96, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, flexShrink: 0 },
  identity: { flex: 1, minWidth: 0 },
});
