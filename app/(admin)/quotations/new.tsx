// Forge Quotation Builder 3.0 · entry point
// -----------------------------------------------------------------------------
// The 1,300-line monolith has been split into a feature-scoped architecture
// under /src/components/quotation. This file just wires up the provider +
// responsive shell so the same builder works across mobile, tablet portrait,
// tablet landscape and desktop.
//
// All state is centralised in BuilderContext, so future features (payments,
// approvals, complete-the-set upgrades, AI recommendations, comparison mode)
// can slot in without another mega file appearing.
// -----------------------------------------------------------------------------
import { useLocalSearchParams } from "expo-router";

import { LazyQuotationBuilder } from "@/src/components/quotation/LazyQuotationBuilder";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";

export default function QuotationBuilderScreen() {
  useRequireFloorAccess("first-floor");
  // Optional ?productId=... — set by Catalog's "Add to quotation" CTA so
  // starting a new quotation from a product's detail page actually seeds
  // that product instead of landing on an empty builder.
  const { productId, godownStockId, godownVariant, quotationId } = useLocalSearchParams<{
    productId?: string;
    godownStockId?: string;
    godownVariant?: string;
    /** Opens an existing customer quotation in the same product workspace. */
    quotationId?: string;
  }>();
  return (
    <LazyQuotationBuilder
      mode="sanitary"
      initialProductId={productId || null}
      initialGodownStockId={godownStockId || null}
      initialGodownVariant={godownVariant ?? null}
      initialQuotationId={quotationId || null}
    />
  );
}
