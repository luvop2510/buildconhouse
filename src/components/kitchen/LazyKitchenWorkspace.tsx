import { lazy, Suspense, type ComponentProps } from "react";
import { ActivityIndicator, View } from "react-native";
import type { KitchenWorkspace } from "./KitchenWorkspace";

// Keep the shared queue and its optional editors out of every department's startup.
const Workspace = lazy(() => import("./KitchenWorkspace").then(module => ({ default: module.KitchenWorkspace })));

export function LazyKitchenWorkspace(props: ComponentProps<typeof KitchenWorkspace>) {
  return <Suspense fallback={<View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>}>
    <Workspace {...props} />
  </Suspense>;
}
