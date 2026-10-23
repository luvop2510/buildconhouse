import Feather from "@expo/vector-icons/Feather";
import { useFonts } from "expo-font";
import { useEffect, useState } from "react";
import { INTER_FAMILY } from "./app-font-assets";
import { retryBrowserFontSources } from "./app-font-recovery.web";

const APP_FONTS = { ...INTER_FAMILY, ...Feather.font };
const FONT_LOAD_TIMEOUT_MS = 12_000;

export function useAppFonts(): readonly [boolean, Error | null] {
  // Keep Expo's static font registration so exported HTML preloads every asset.
  // Its Safari readiness result only means that CSS rules were registered.
  useFonts(APP_FONTS);
  // The static export must show the loading state too: its form otherwise paints
  // in a fallback face before JavaScript hydrates, even with a correct client gate.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    retryBrowserFontSources(Object.keys(APP_FONTS));
    const timer = setTimeout(() => {
      if (active) { active = false; setError(new Error("Workspace fonts took too long to load.")); }
    }, FONT_LOAD_TIMEOUT_MS);
    // useFonts registers the CSS synchronously in its earlier effect. Explicit
    // glyphs ensure that the icon face is decoded as well as the four text faces.
    Promise.all(Object.keys(APP_FONTS).map(async family => {
      const sample = family === "feather" ? String.fromCodePoint(Number(Feather.glyphMap.activity)) : "BuildCon 0123456789";
      const faces = await document.fonts.load(`16px "${family}"`, sample);
      if (!faces.length || faces.some(face => face.status !== "loaded")) {
        throw new Error(`Workspace font ${family} could not be loaded.`);
      }
    })).then(() => {
      if (active) { clearTimeout(timer); setLoaded(true); }
    }).catch((cause: unknown) => {
      if (active) {
        clearTimeout(timer);
        setError(cause instanceof Error ? cause : new Error("Workspace fonts could not be loaded."));
      }
    });
    return () => { active = false; clearTimeout(timer); };
  }, []);

  return [loaded, error];
}
