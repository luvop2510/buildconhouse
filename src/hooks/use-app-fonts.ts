// App-wide font loader: Inter (text) + Expo vector icons (icon families under Expo Go).
// Inter is loaded from local /assets/fonts. Icon fonts fall back to CDN under Expo Go.
import Constants, { ExecutionEnvironment } from "expo-constants";
import { useFonts } from "expo-font";

const ICON_VECTOR_VERSION = "15.1.1";

const ICON_FAMILIES: Record<string, string> = {
  anticon: "AntDesign",
  entypo: "Entypo",
  evilicons: "EvilIcons",
  feather: "Feather",
  FontAwesome: "FontAwesome",
  Fontisto: "Fontisto",
  foundation: "Foundation",
  ionicons: "Ionicons",
  "material-community": "MaterialCommunityIcons",
  material: "MaterialIcons",
  octicons: "Octicons",
  "simple-line-icons": "SimpleLineIcons",
  zocial: "Zocial",
  "FontAwesome5Free-Regular": "FontAwesome5_Regular",
  "FontAwesome5Free-Solid": "FontAwesome5_Solid",
  "FontAwesome5Free-Brand": "FontAwesome5_Brands",
  "FontAwesome6Free-Regular": "FontAwesome6_Regular",
  "FontAwesome6Free-Solid": "FontAwesome6_Solid",
  "FontAwesome6Free-Brand": "FontAwesome6_Brands",
};

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

// Fraunces — the single serif voice. Greetings + auth headlines ONLY.
const FRAUNCES_FAMILY: Record<string, any> = {
  "Fraunces-Light": require("@expo-google-fonts/fraunces/300Light/Fraunces_300Light.ttf"),
  "Fraunces-LightItalic": require("@expo-google-fonts/fraunces/300Light_Italic/Fraunces_300Light_Italic.ttf"),
  "Fraunces-Regular": require("@expo-google-fonts/fraunces/400Regular/Fraunces_400Regular.ttf"),
};

export const useAppFonts = (): readonly [boolean, Error | null] =>
  useFonts({
    // Keep the same typographic voice on web and native. The local files are
    // bundled with the app, so the shell never depends on a font CDN.
    ...INTER_FAMILY,
    ...FRAUNCES_FAMILY,
    ...(Constants.executionEnvironment === ExecutionEnvironment.StoreClient
      ? iconFontMap()
      : {}),
  });
