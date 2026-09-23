import { Suspense, lazy } from "react";
import { ActivityIndicator, View } from "react-native";

import type { QuotationBuilderMode } from "./QuotationBuilder";

type QuotationBuilderProps = {
  mode: QuotationBuilderMode;
  initialProductId?: string | null;
  initialGodownStockId?: string | null;
  initialGodownVariant?: string | null;
  /** Existing quotation to load into the editable builder workspace. */
  initialQuotationId?: string | null;
};

// The builder contains catalog, PDF and tile-document tooling. It is reached
// from a dedicated route, so keeping it out of the shared web bootstrap lets
// login/dashboard become interactive before those specialist modules download.
const QuotationBuilder = lazy(() => import("./QuotationBuilder").then((module) => ({ default: module.QuotationBuilder })));

export function LazyQuotationBuilder(props: QuotationBuilderProps) {
  return (
    <Suspense fallback={<View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>}>
      <QuotationBuilder {...props} />
    </Suspense>
  );
}
