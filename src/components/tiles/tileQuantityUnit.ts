/** Supplier imports use either price_unit or rate_unit for the same field. */
export function tileSourcePriceUnit(specs: Record<string, unknown> | null | undefined): unknown {
  return specs?.price_unit || specs?.rate_unit;
}

/** Quantity is determined by the catalog pricing unit, not by the quotation author. */
export function tileQuantityUnit(priceUnit: unknown): "Box" | "Pieces" {
  const unit = String(priceUnit || "").trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
  return ["piece", "pieces", "pc", "pcs", "per piece", "per pieces", "per pc", "per pcs", "tile", "per tile"].includes(unit) ? "Pieces" : "Box";
}

/** A missing source unit must not be presented as a known price basis. */
export function tilePriceUnit(priceUnit: unknown): string {
  const unit = String(priceUnit || "").trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
  if (!unit) return "";
  if (tileQuantityUnit(unit) === "Pieces") return "per piece";
  if (["sqft", "sq ft", "per sqft", "per sq ft", "per square foot"].includes(unit)) return "per sq.ft";
  if (["box", "per box"].includes(unit)) return "per box";
  return "";
}
