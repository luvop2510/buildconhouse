// App-wide font loader: Inter (text) + Feather icons (CDN fallback under Expo Go).
// Inter is loaded from local /assets/fonts. Icon fonts fall back to CDN under Expo Go.
import Constants, { ExecutionEnvironment } from "expo-constants";
import { useFonts } from "expo-font";

const ICON_VECTOR_VERSION = "15.1.1";

// Feather is the only icon family used by the canonical app. Loading every
// Expo icon font here delayed Expo Go startup with 18 unnecessary downloads.
const ICON_FAMILIES: Record<string, string> = { feather: "Feather" };

const cdnIconUrl = (file: string): string =>
  `https://cdn.jsdelivr.net/npm/@expo/vector-icons@${ICON_VECTOR_VERSION}/build/vendor/react-native-vector-icons/Fonts/${file}.ttf`;

const iconFontMap = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(ICON_FAMILIES).map(([key, file]) => [key, cdnIconUrl(file)]),
  );

// Inter — the app's typographic voice. Four weights cover 99% of use.
const INTER_FAMILY: Record<string, any> = {
  "Inter-Regular": require("@/assets/fonts/Inter-Regular.ttf"),
  "Inter-Medium": require("@/assets/fonts/Inter-Medium.ttf"),
  "Inter-SemiBold": require("@/assets/fonts/Inter-SemiBold.ttf"),
  "Inter-Bold": require("@/assets/fonts/Inter-Bold.ttf"),
};

export const useAppFonts = (): readonly [boolean, Error | null] =>
  useFonts({
    // Keep the same typographic voice on web and native. The local files are
    // bundled with the app, so the shell never depends on a font CDN.
    ...INTER_FAMILY,
    ...(Constants.executionEnvironment === ExecutionEnvironment.StoreClient
      ? iconFontMap()
      : {}),
  });
