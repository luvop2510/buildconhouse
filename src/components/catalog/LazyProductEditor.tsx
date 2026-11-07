import { lazy, Suspense, type ComponentProps } from "react";
import { ActivityIndicator, View } from "react-native";
import type { ProductEditor } from "./ProductEditor";

const Editor = lazy(() => import("./ProductEditor").then(module => ({ default: module.ProductEditor })));

export function LazyProductEditor(props: ComponentProps<typeof ProductEditor>) {
  if (!props.visible) return null;
  return <Suspense fallback={<View accessibilityRole="progressbar" accessibilityLabel="Loading product editor"><ActivityIndicator /></View>}>
    <Editor {...props} />
  </Suspense>;
}
