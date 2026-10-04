import type Feather from "@expo/vector-icons/Feather";
import { Platform } from "react-native";
export type FeatherName = keyof typeof Feather.glyphMap;
export const webCursor = Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null;
