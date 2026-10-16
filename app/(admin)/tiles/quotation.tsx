// Ground Floor → Tiles → Quotation — editable replica of the official
// light-blue quotation sheet. Optional ?id=… reopens a saved quotation;
// optional ?productId=… starts a new quotation with a Catalog tile selected.
import { useLocalSearchParams } from "expo-router";

import { LazyQuotationBuilder } from "@/src/components/quotation/LazyQuotationBuilder";
import { useRequireFloorAccessState } from "@/src/hooks/use-floor-access";
import { ActivityIndicator, View } from "react-native";
import { ErrorState } from "@/src/components/ui";

export default function TilesQuotationScreen() {
  const floor = useRequireFloorAccessState("ground-floor");
  const { productId, id, quotationId } = useLocalSearchParams<{ productId?: string; id?: string; quotationId?: string }>();
  if (floor.error) return <ErrorState title="Couldn’t open Ground Floor" subtitle={floor.error} onRetry={() => void floor.retry()} />;
  if (!floor.ready) return <View accessibilityLabel="Opening Ground Floor quotation workspace" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>;
  return <LazyQuotationBuilder mode="tiles_quotation" initialProductId={productId || null} initialQuotationId={id || quotationId || null} />;
}
