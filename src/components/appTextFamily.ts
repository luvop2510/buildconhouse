/** Pick a bundled Inter weight for interface text without a family. */
export function appTextFamily(style?: { fontFamily?: string; fontWeight?: string | number } | null): string {
  if (style?.fontFamily) return style.fontFamily;
  const weight = style?.fontWeight === "bold" ? 700 : Number(style?.fontWeight || 400);
  return weight >= 700 ? "Inter-Bold" : weight >= 600 ? "Inter-SemiBold" : weight >= 500 ? "Inter-Medium" : "Inter-Regular";
}
