// Ground Floor → Tiles → Selection — editable replica of the official grey
// selection sheet. Optional ?id=… reopens a saved selection document.
import { LazyQuotationBuilder } from "@/src/components/quotation/LazyQuotationBuilder";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";
import { useLocalSearchParams } from "expo-router";

export default function TilesSelectionScreen() {
  useRequireFloorAccess("ground-floor");
  const { id, quotationId } = useLocalSearchParams<{ id?: string; quotationId?: string }>();
  return <LazyQuotationBuilder mode="tiles_selection" initialQuotationId={id || quotationId || null} />;
}
