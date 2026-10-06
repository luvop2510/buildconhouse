import type { FontSource } from "expo-font";
import regular from "@/assets/fonts/Inter-Regular.woff2";
import medium from "@/assets/fonts/Inter-Medium.woff2";
import semibold from "@/assets/fonts/Inter-SemiBold.woff2";
import bold from "@/assets/fonts/Inter-Bold.woff2";

// Full glyph coverage and typography are preserved; only web packaging changes.
export const INTER_FAMILY = {
  "Inter-Regular": regular,
  "Inter-Medium": medium,
  "Inter-SemiBold": semibold,
  "Inter-Bold": bold,
} satisfies Record<string, FontSource>;
