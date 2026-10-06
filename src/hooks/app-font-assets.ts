import type { FontSource } from "expo-font";

// Native platforms retain the supplied TrueType originals.
export const INTER_FAMILY = {
  "Inter-Regular": require("@/assets/fonts/Inter-Regular.ttf"),
  "Inter-Medium": require("@/assets/fonts/Inter-Medium.ttf"),
  "Inter-SemiBold": require("@/assets/fonts/Inter-SemiBold.ttf"),
  "Inter-Bold": require("@/assets/fonts/Inter-Bold.ttf"),
} satisfies Record<string, FontSource>;
