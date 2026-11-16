/** Only remove a dimension that is already represented by this row's Size. */
export function tileProductName(name: string, size: string | null | undefined): string {
  const normalize = (value: string) => value.replace(/\s/g, "").replace(/[×*]/g, "x").toLowerCase();
  const dimension = normalize(size || "");
  if (!/^\d+(?:\.\d+)?(?:mm|cm|m|in)?x\d+(?:\.\d+)?(?:mm|cm|m|in)?(?:x\d+(?:\.\d+)?(?:mm|cm|m|in)?)?$/.test(dimension)) return name;
  const withoutBrackets = name.replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (whole, round: string | undefined, square: string | undefined) => normalize(round ?? square ?? "") === dimension ? "" : whole);
  // Preserve product codes and descriptions; an unparenthesized size is
  // removed only as a complete trailing token with an explicit boundary.
  const tokens = dimension.split("x").map(token => token.replace(/\./g, "\\."));
  const suffix = new RegExp(`(?:\\s+|\\s*[-–—,:]\\s*)${tokens.join("\\s*[x×*]\\s*")}\\s*$`, "i");
  const cleaned = withoutBrackets.replace(suffix, "");
  return cleaned === name ? name : cleaned.replace(/[ \t]{2,}/g, " ").trim() || name;
}
