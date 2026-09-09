/**
 * Single quotation entry point.
 *
 * The quotation system has one workflow boundary, one autosave contract, one
 * totals contract, one media renderer and one PDF endpoint. This component is
 * the only route-facing builder entry point; the mode adapters below supply
 * floor-specific fields and workflow actions without duplicating navigation
 * or persistence wiring in the app routes.
 */
import { useRouter } from "expo-router";

import { TilesDocBuilder } from "../tiles/TilesDocBuilder";
import { BuilderProvider } from "./context/BuilderContext";
import { BuilderShell } from "./layout/BuilderShell";

export type QuotationBuilderMode = "sanitary" | "tiles_selection" | "tiles_quotation";

export function QuotationBuilder({
  mode,
  initialProductId,
}: {
  mode: QuotationBuilderMode;
  initialProductId?: string | null;
}) {
  const router = useRouter();

  if (mode === "tiles_selection" || mode === "tiles_quotation") {
    return <TilesDocBuilder docType={mode} initialProductId={initialProductId || null} />;
  }

  return (
    <BuilderProvider
      initialProductId={initialProductId || null}
      onFinalize={(quotationId) => router.replace(`/(admin)/quotations/${quotationId}` as any)}
    >
      <BuilderShell onBack={() => router.back()} />
    </BuilderProvider>
  );
}
