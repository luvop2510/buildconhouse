// BrandLogo — the ONE BuildCon House wordmark asset, used everywhere the brand
// identity appears (auth screens, customer portal header, sidebar). Never
// re-typeset the name as text next to a monogram — always this image, so the
// exact same lockup (brass letterforms + "Let you live better" tagline)
// shows up consistently across the whole app.
//
// Also exports the supplier brand logo map used by the Quotation Builder's
// brand rail (and anywhere else a brand badge is rendered) — Grohe, Hansgrohe,
// Vitra and Geberit ship real logos; unlisted brands use an initials badge.
import { Image, ImageStyle, StyleProp } from "react-native";

// Native aspect ratio of the source lockup (1414×412) — always size by height
// and let width follow, so the wordmark never looks stretched.
export const BUILDCON_LOGO_RATIO = 1414 / 412;

export function BuildConLogo({
  height = 26,
  radius = 0,
  style,
}: {
  height?: number;
  radius?: number;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      source={require("@/assets/brands/buildcon-logo.png")}
      resizeMode="contain"
      accessibilityLabel="BuildCon House — Let you live better"
      style={[{ height, width: height * BUILDCON_LOGO_RATIO, borderRadius: radius }, style]}
    />
  );
}

// Supplier brand logos — keyed by lowercase brand name for a forgiving match
// against whatever casing the API returns.
export const SUPPLIER_LOGOS: Record<string, any> = {
  grohe: require("@/assets/brands/grohe.jpg"),
  hansgrohe: require("@/assets/brands/hansgrohe.jpg"),
  vitra: require("@/assets/brands/vitra.png"),
  geberit: require("@/assets/brands/geberit.png"),
};

export function supplierLogoFor(brandName?: string | null) {
  if (!brandName) return null;
  return SUPPLIER_LOGOS[brandName.trim().toLowerCase()] || null;
}
