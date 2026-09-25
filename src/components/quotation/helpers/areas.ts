/** Presentation grouping inferred from catalog terms; staff can always edit it. */
export function suggestedProductArea(name?: string | null, category?: string | null): string {
  const text = `${category || ""} ${name || ""}`.toLowerCase();
  if (/\b(shower|rainshower|handshower|overhead|body jet|thermostat|diverter|bath tub|bathtub)\b/.test(text)) return "Shower Area";
  if (/\b(wc|toilet|commode|water closet|cistern|flush|urinal|bidet|seat cover|health faucet)\b/.test(text)) return "WC Area";
  if (/\b(basin|washbasin|wash basin|lavatory|vessel|countertop|counter top|pillar tap|mixer tap)\b/.test(text)) return "Basin Area";
  return "Other Area";
}
