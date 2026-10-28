// ProductImage
// -----------------------------------------------------------------------------
// A production-ready image renderer for supplier catalog products.
//
// Responsibilities
//   * Skeleton loader while the byte stream lands
//   * Graceful fallback (branded "no image" glyph) when the product has no
//     image or every candidate URL / data-URL fails to load
//   * Error handling that walks through the images array before giving up
//     (some suppliers ship multiple candidates; we prefer the first that loads)
//   * Caching via expo-image's memory+disk cache (default policy `disk`)
//   * Responsive by design — the caller controls dimensions via `style`
//   * Supports both http(s) URLs and base64 data URLs (the format the catalog
//     pipeline produces after image_extractor decodes WDP → PNG)
//
// It is deliberately dependency-free of app state; it just needs the array of
// candidate images (or a single string) and optional style/contentFit props.
// -----------------------------------------------------------------------------
import Feather from "@expo/vector-icons/Feather";
import { Image as ExpoImage, ImageContentFit } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, PixelRatio, Platform, StyleSheet, View, ViewStyle } from "react-native";
import { Text } from "@/src/components/AppText";

import { colors, radius } from "@/src/theme/tokens";
import { useReducedMotion } from "@/src/hooks/use-reduced-motion";

export type ProductImageProps = {
  // Accept either a single URL/data-URL or an ordered list of fallback candidates.
  source?: string | string[] | null | undefined;
  // Container style — width/height/aspectRatio live here.
  style?: ViewStyle | ViewStyle[];
  // "cover" | "contain" | "fill" | "scale-down" — passed through to expo-image.
  contentFit?: ImageContentFit;
  // Optional breathing room inside the product frame; zero fills the slot.
  frameInset?: number;
  // Optional testID for e2e testing.
  testID?: string;
  // Optional accessible name; falls back to "Product image".
  accessibilityLabel?: string;
  // If true, the skeleton shimmer is disabled (useful for tiny thumbs).
  disableSkeleton?: boolean;
  // Corner radius override; defaults to `radius.md`.
  borderRadius?: number;
  // Optional label to display in the fallback state (usually SKU).
  fallbackLabel?: string | null;
  // Operational lists can explain missing/failed photos without presenting
  // the SKU alone as an empty image box. Other consumers keep their layout.
  statusMessages?: { missing: string; loading: string; failed: string };
  // Lets document cells render media with no shaded image-card background.
  frameBackground?: string;
  // A hero/zoom image should begin with the full source. Compact list cells
  // retain the responsive Supabase derivative to protect scrolling latency.
  preferOriginal?: boolean;
  // Use a short crossfade for meaningful image changes. Tiny recycled cells
  // can opt out to avoid animating an entire virtualized list at once.
  transition?: number;
};

const CACHE_POLICY = "memory-disk" as const;
// Small transparent placeholder shown by expo-image while the real image
// loads. Prevents a flash of layout-shifting default.
const BLURHASH = "L6PZfSjE.AyE_3t7t7R**0o#DgR4";
const SUPABASE_PUBLIC_OBJECT = "/storage/v1/object/public/";

function transformWidth(requestedWidth: number): number {
  return requestedWidth <= 320 ? 320 : requestedWidth <= 640 ? 640 : requestedWidth <= 1024 ? 1024 : requestedWidth <= 1600 ? 1600 : 2048;
}

export function supabaseSizedImageUrl(uri: string, requestedWidth: number): string | null {
  if (!uri.startsWith("http") || !uri.includes(SUPABASE_PUBLIC_OBJECT)) return null;
  // Preserve the bandwidth savings of Supabase transforms for thumbnails,
  // without forcing a soft 640px derivative into a desktop product gallery.
  // The value is the physical display width (CSS width × device pixel ratio),
  // rounded to a small set of cache-friendly transform sizes.
  const width = transformWidth(requestedWidth);
  const quality = width >= 1024 ? 90 : 85;
  const rendered = uri.replace(SUPABASE_PUBLIC_OBJECT, "/storage/v1/render/image/public/");
  const separator = rendered.includes("?") ? "&" : "?";
  return `${rendered}${separator}width=${width}&resize=contain&quality=${quality}`;
}

export function r2SizedImageUrl(uri: string, requestedWidth: number): string | null {
  try {
    const url = new URL(uri);
    if (url.origin !== "https://forge-media.yashvardhansinh2510.workers.dev" || url.search || url.hash || url.pathname.startsWith("/_image_variants/")) return null;
    url.searchParams.set("width", String(transformWidth(requestedWidth)));
    return url.toString();
  } catch { return null; }
}

export function ProductImage({
  source,
  style,
  // Product frames are landscape, but their contents must remain upright.
  // `contain` preserves the source aspect ratio without distortion.
  contentFit = "contain",
  frameInset = 0,
  testID,
  accessibilityLabel = "Product image",
  disableSkeleton = false,
  borderRadius,
  fallbackLabel,
  statusMessages,
  frameBackground = colors.surfaceTertiary,
  preferOriginal = false,
  transition = 0,
}: ProductImageProps) {
  // Fixed thumbnail frames already know their width. Avoid first requesting a
  // default derivative and then resetting every image after layout measurement.
  const [frameWidth, setFrameWidth] = useState(() => {
    const declared = StyleSheet.flatten(style)?.width;
    return typeof declared === "number" ? declared : 160;
  });
  // Normalise `source` into an ordered list of candidates. Empty / null entries
  // are stripped so we don't waste a load attempt on them.
  const candidates: string[] = useMemo(() => {
    if (!source) return [];
    const arr = Array.isArray(source) ? source : [source];
    return arr.filter((s): s is string => typeof s === "string" && s.length > 0);
  }, [source]);

  // `source` is already ordered by the shared media resolver. Preserve that
  // order: a URI heuristic here can silently replace an exact product image
  // with a sibling/fallback and makes every consumer disagree about media
  // identity. Only remove duplicate candidates.
  const sanitizedCandidates: string[] = useMemo(() => {
    const seen = new Set<string>();
    const requestedWidth = Math.max(1, frameWidth || 160) * PixelRatio.get();
    const expanded = candidates.flatMap((uri) => {
      const sized = r2SizedImageUrl(uri, requestedWidth) || supabaseSizedImageUrl(uri, requestedWidth);
      if (!sized) return [uri];
      return preferOriginal ? [uri, sized] : [sized, uri];
    });
    return expanded.filter((uri) => !seen.has(uri) && seen.add(uri));
  }, [candidates, frameWidth, preferOriginal]);

  // Track the current candidate index. On error we advance; once we run out
  // of candidates we render the fallback glyph.
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(sanitizedCandidates.length === 0);
  const candidateKey = sanitizedCandidates.join("|");

  // Reset when the candidate list changes (e.g. product swap).
  useEffect(() => {
    setIdx(0);
    setLoaded(false);
    setFailed(sanitizedCandidates.length === 0);
  }, [candidateKey, sanitizedCandidates.length]);

  const current = sanitizedCandidates[idx];
  const finalRadius = typeof borderRadius === "number" ? borderRadius : radius.md;

  return (
    <View
      style={[styles.wrap, { borderRadius: finalRadius, backgroundColor: frameBackground }, style as any]}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      onLayout={(event) => {
        const width = Math.round(event.nativeEvent.layout.width);
        if (width > 0 && transformWidth(width * PixelRatio.get()) !== transformWidth(frameWidth * PixelRatio.get())) setFrameWidth(width);
      }}
    >
      <View
        style={[styles.inner, { margin: Math.max(0, frameInset), borderRadius: Math.max(0, finalRadius - frameInset), backgroundColor: frameBackground }]}
      >
        {failed || !current ? (
          <FallbackGlyph label={fallbackLabel} message={candidates.length ? statusMessages?.failed : statusMessages?.missing} />
        ) : (
          <>
            {!loaded && !disableSkeleton ? <Skeleton /> : null}
            <ExpoImage
              source={{ uri: current }}
              style={[
                StyleSheet.absoluteFill,
                { borderRadius: Math.max(0, finalRadius - frameInset) },
              ]}
              contentFit={contentFit}
              cachePolicy={CACHE_POLICY}
              placeholder={{ blurhash: BLURHASH }}
              transition={transition}
              recyclingKey={current}
              onLoad={() => {
                setLoaded(true);
              }}
              onError={() => {
                // Advance to next candidate, or give up.
                if (idx + 1 < sanitizedCandidates.length) {
                  setIdx(idx + 1);
                  setLoaded(false);
                } else {
                  setFailed(true);
                }
              }}
            />
            {!loaded && statusMessages ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.loadingMessage]}>
              <Text style={styles.statusMessage}>{statusMessages.loading}</Text>
            </View> : null}
          </>
        )}
      </View>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Skeleton — a soft shimmer used while the real bytes are decoding. Kept
// deliberately small; big shimmer animations on lists cause jank.
// -----------------------------------------------------------------------------
function Skeleton() {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    // React Native Web has no native animation driver. Dozens of image
    // placeholders otherwise schedule JS opacity updates on every frame while
    // the tablet is also decoding images and handling scroll gestures.
    if (Platform.OS === "web" || reducedMotion) { opacity.setValue(0.7); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reducedMotion]);

  return <Animated.View style={[StyleSheet.absoluteFill, styles.skeleton, { opacity }]} />;
}

// -----------------------------------------------------------------------------
// FallbackGlyph — displayed when the product has no image at all, or every
// candidate failed. Deliberately understated so it doesn't scream "broken".
// -----------------------------------------------------------------------------
function FallbackGlyph({ label, message }: { label?: string | null; message?: string }) {
  return (
    <View style={styles.fallback}>
      <Feather name="image" size={18} color={colors.onSurfaceMuted} />
      {message ? <Text style={styles.statusMessage}>{message}</Text> : null}
      {label ? (
        <View style={styles.fallbackLabelWrap}>
          <FallbackLabel label={label} />
        </View>
      ) : null}
    </View>
  );
}

function FallbackLabel({ label }: { label: string }) {
  return (
    <Text
      numberOfLines={1}
      style={{
        fontSize: 9,
        fontWeight: "600",
        color: colors.onSurfaceMuted,
        letterSpacing: 0.4,
      }}
    >
      {label.toUpperCase()}
    </Text>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surfaceTertiary,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    alignSelf: "stretch",
    overflow: "hidden",
    backgroundColor: colors.surfaceTertiary,
  },
  skeleton: {
    backgroundColor: colors.surfaceTertiary,
  },
  fallback: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  fallbackLabelWrap: {
    paddingHorizontal: 4,
    maxWidth: "90%",
  },
  loadingMessage: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceTertiary,
    paddingHorizontal: 4,
  },
  statusMessage: {
    fontSize: 12,
    lineHeight: 14,
    color: colors.onSurfaceSecondary,
    textAlign: "center",
    paddingHorizontal: 3,
  },
});
