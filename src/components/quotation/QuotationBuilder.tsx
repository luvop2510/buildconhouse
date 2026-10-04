/**
 * Single quotation entry point.
 *
 * The quotation system has one workflow boundary, one autosave contract, one
 * totals contract, one media renderer and one PDF endpoint. This component is
 * the only route-facing builder entry point; the mode adapters below supply
 * floor-specific fields and workflow actions without duplicating navigation
 * or persistence wiring in the app routes.
 */
import { useAuth } from "@/src/state/auth";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useRouter } from "expo-router";

import { TilesDocBuilder } from "../tiles/TilesDocBuilder";
import { BuilderProvider } from "./context/BuilderContext";
import { BuilderShell } from "./layout/BuilderShell";

export type QuotationBuilderMode = "sanitary" | "tiles_selection" | "tiles_quotation";

export function QuotationBuilder({
  mode,
  initialProductId,
  initialCatalogEntryId,
  initialGodownStockId,
  initialGodownVariant,
  initialQuotationId,
}: {
  mode: QuotationBuilderMode;
  initialProductId?: string | null;
  initialCatalogEntryId?: string | null;
  initialGodownStockId?: string | null;
  initialGodownVariant?: string | null;
  initialQuotationId?: string | null;
}) {
  const router = useRouter();
  const { staff } = useAuth();
  const { selectedFloorId, floors } = useFloorAccess();

  if (mode === "tiles_selection" || mode === "tiles_quotation") {
    return <TilesDocBuilder docType={mode} initialProductId={initialProductId || null} initialQuotationId={initialQuotationId || null} />;
  }

  return (
    <BuilderProvider
      key={`${staff?.id}:${selectedFloorId || floors[0]?.id || ""}`}
      initialProductId={initialProductId || null}
      initialCatalogEntryId={initialCatalogEntryId || null}
      initialGodownStockId={initialGodownStockId || null}
      initialGodownVariant={initialGodownVariant || null}
      initialQuotationId={initialQuotationId || null}
      onFinalize={(quotationId) => router.replace(`/(admin)/quotations/${quotationId}` as any)}
    >
      <BuilderShell onBack={() => router.back()} />
    </BuilderProvider>
  );
}
