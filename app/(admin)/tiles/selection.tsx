// Ground Floor → Tiles → Selection — editable replica of the official grey
// selection sheet. Optional ?id=… reopens a saved selection document.
import { LazyQuotationBuilder } from "@/src/components/quotation/LazyQuotationBuilder";
import { useRequireFloorAccessState } from "@/src/hooks/use-floor-access";
import { ActivityIndicator, View } from "react-native";
import { ErrorState } from "@/src/components/ui";
import { useLocalSearchParams } from "expo-router";

export default function TilesSelectionScreen() {
  const floor = useRequireFloorAccessState("ground-floor");
  const { id, quotationId } = useLocalSearchParams<{ id?: string; quotationId?: string }>();
  if (floor.error) return <ErrorState title="Couldn’t open Ground Floor" subtitle={floor.error} onRetry={() => void floor.retry()} />;
  if (!floor.ready) return <View accessibilityLabel="Opening Ground Floor quotation workspace" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>;
  return <LazyQuotationBuilder mode="tiles_selection" initialQuotationId={id || quotationId || null} />;
}
