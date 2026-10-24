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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { Text } from "@/src/components/AppText";
import { Button, ErrorState } from "@/src/components/ui";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { LazyQuotationBuilder } from "@/src/components/quotation/LazyQuotationBuilder";
import { useRequireFloorAccessState } from "@/src/hooks/use-floor-access";

export default function QuotationBuilderScreen() {
  const router = useRouter();
  const canCreate = useActionAccess("quotations", "create");
  const canUpdate = useActionAccess("quotations", "update");
  const floor = useRequireFloorAccessState("first-floor");
  // Optional ?productId=... — set by Catalog's "Add to quotation" CTA so
  // starting a new quotation from a product's detail page actually seeds
  // that product instead of landing on an empty builder.
  const { productId, catalogEntryId, godownStockId, godownVariant, quotationId } = useLocalSearchParams<{
    productId?: string;
    catalogEntryId?: string;
    godownStockId?: string;
    godownVariant?: string;
    /** Opens an existing customer quotation in the same product workspace. */
    quotationId?: string;
  }>();
  if (floor.error) return <ErrorState title="Couldn’t open Sanitary Bathroom" subtitle={floor.error} onRetry={() => void floor.retry()} />;
  if (!floor.ready) return <View accessibilityLabel="Opening Sanitary quotation workspace" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>;
  if (quotationId ? !canUpdate : !canCreate) return (
    <View testID="quotation-builder-access-denied" style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}>
      <Text accessibilityRole="alert">{quotationId ? "You don't have access to edit this quotation." : "You don't have access to create quotations."}</Text>
      <Button label={quotationId ? "View quotation" : "View quotations"}
        onPress={() => router.replace(quotationId ? `/(admin)/quotations/${quotationId}` as any : "/(admin)/quotations" as any)} />
    </View>
  );
  return (
    <LazyQuotationBuilder
      mode="sanitary"
      initialProductId={productId || null}
      initialCatalogEntryId={catalogEntryId || null}
      initialGodownStockId={godownStockId || null}
      initialGodownVariant={godownVariant ?? null}
      initialQuotationId={quotationId || null}
    />
  );
}
