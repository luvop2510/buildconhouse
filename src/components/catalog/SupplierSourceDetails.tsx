import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import type { CatalogEntry } from "@/src/services/catalogService";
import { supplierSourceDetails } from "@/src/components/quotation/helpers/catalogSource";
import { colors, spacing, type } from "@/src/theme/tokens";

export function SupplierSourceDetails({ entries }: { entries?: CatalogEntry[] }) {
  const details = supplierSourceDetails(entries);
  if (!details.length) return null;
  return (
    <View style={{ gap: spacing.sm }} testID="supplier-source-details">
      <Text style={type.overline}>Supplier details</Text>
      {details.map((text, i) => (
        <Text key={i} style={[type.body, { color: colors.onSurfaceSecondary }]}>{text}</Text>
      ))}
    </View>
  );
}
