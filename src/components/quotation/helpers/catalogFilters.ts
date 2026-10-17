// Older quotations saved arrays of filter choices. Reopen them with one scope
// so hidden legacy selections cannot silently combine brands or categories.
export function restoreSingleCatalogChoice(values: unknown, legacyValue: unknown): string | null {
  if (Array.isArray(values)) return values.find((value): value is string => typeof value === "string" && value.length > 0) || null;
  return typeof legacyValue === "string" && legacyValue.length > 0 ? legacyValue : null;
}
