// Ground Floor → Tiles → Quotation — editable replica of the official
// light-blue quotation sheet. Optional ?id=… reopens a saved quotation;
// optional ?productId=… starts a new quotation with a Catalog tile selected.
import { useLocalSearchParams } from "expo-router";

import { LazyQuotationBuilder } from "@/src/components/quotation/LazyQuotationBuilder";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";

export default function TilesQuotationScreen() {
  useRequireFloorAccess("ground-floor");
  const { productId, id, quotationId } = useLocalSearchParams<{ productId?: string; id?: string; quotationId?: string }>();
  return <LazyQuotationBuilder mode="tiles_quotation" initialProductId={productId || null} initialQuotationId={id || quotationId || null} />;
}
