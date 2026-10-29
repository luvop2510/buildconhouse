import Feather from "@expo/vector-icons/Feather";
import { useFonts } from "expo-font";
import { useEffect, useState } from "react";
import { retryBrowserFontSources } from "./app-font-recovery.web";

const APP_FONTS = { ...Feather.font };
const FONT_LOAD_TIMEOUT_MS = 12_000;

export function useAppFonts(): readonly [boolean, Error | null] {
  // System text is available immediately; preload only the bundled icon face.
  // Its Safari readiness result only means that CSS rules were registered.
  useFonts(APP_FONTS);
  // Match the exported shell and wait for the icon face before showing controls.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    retryBrowserFontSources(Object.keys(APP_FONTS));
    const timer = setTimeout(() => {
      if (active) { active = false; setError(new Error("Workspace fonts took too long to load.")); }
    }, FONT_LOAD_TIMEOUT_MS);
    // useFonts registers the CSS synchronously in its earlier effect. Explicit
    // glyphs ensure that the icon face is decoded before rendering.
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
