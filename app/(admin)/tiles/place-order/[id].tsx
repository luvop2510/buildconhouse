// Ground Floor alias for the shared review flow. Keeping this URL inside the
// Tiles module prevents the Sanitary quotation access gate from intercepting
// an approved tile quotation during order placement.
import { lazy, Suspense } from "react";
import { ActivityIndicator, View } from "react-native";

// A synchronous re-export puts the full shared order screen in every web page.
const PlaceOrder = lazy(() => import("../../quotations/[id]/place-order"));

export default function TilePlaceOrder() {
  return <Suspense fallback={<View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>}>
    <PlaceOrder />
  </Suspense>;
}
