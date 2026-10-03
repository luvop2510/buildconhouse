import type { CatalogEntry } from "../../../services/catalogService";

export function catalogProductDetailPath(productId: string, entryId?: string | null): string {
  return `/products/${encodeURIComponent(productId)}${entryId ? `?catalog_entry_id=${encodeURIComponent(entryId)}` : ""}`;
}

/** A known sibling must keep its price even when the base SKU has none. */
export function catalogPriceUnknown(
  product: { price_unknown?: boolean }, variant?: { price_unknown?: boolean } | null,
): boolean {
  return variant?.price_unknown ?? product.price_unknown ?? false;
}

export function manualCatalogPrice(input: string): number | null {
  if (!input.trim()) return null;
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Every textual supplier cell stays readable, with exact repeats collapsed. */
export function supplierSourceDetails(entries: CatalogEntry[] = []): string[] {
  const texts = new Set<string>();
  for (const entry of entries) {
    for (const value of [entry.category_name, entry.subcategory, entry.name,
      entry.description, entry.source_sku, entry.source_status_note,
      ...Object.values(entry.source_cells || {})]) {
      const text = value && typeof value === "object" && "value" in value ? value.value : value;
      if (typeof text === "string" && text.trim()) texts.add(text);
    }
  }
  return [...texts];
}
