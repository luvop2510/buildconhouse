import { lazy, Suspense, type ComponentProps } from "react";
import { ActivityIndicator, View } from "react-native";
import type { KitchenProjectDetail } from "./KitchenProjectDetail";

// Several routes share these forms; defer them so Metro does not put the
// entire Kitchen editor in the bootstrap downloaded by every department.
const Detail = lazy(() => import("./KitchenProjectDetail").then(module => ({ default: module.KitchenProjectDetail })));

export function LazyKitchenProjectDetail(props: ComponentProps<typeof KitchenProjectDetail>) {
  return <Suspense fallback={<View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>}>
    <Detail {...props} />
  </Suspense>;
}
