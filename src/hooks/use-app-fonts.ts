import Feather from "@expo/vector-icons/Feather";
import { useFonts } from "expo-font";
import { INTER_FAMILY } from "./app-font-assets";

// Preload the same bundled font used by the icon component on every platform.
// Rendering icons must not initiate a second, potentially remote font request.
export const useAppFonts = (): readonly [boolean, Error | null] =>
  useFonts({ ...INTER_FAMILY, ...Feather.font });
