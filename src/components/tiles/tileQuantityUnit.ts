/** Older square-foot imports stored coverage/rates without an explicit unit. */
export function tileSourcePriceUnit(specs: Record<string, unknown> | null | undefined): unknown {
  return specs?.price_unit || specs?.rate_unit || (specs && ("rate_per_sqft" in specs || "sqft_per_box" in specs) ? "sqft" : undefined);
}

/** Quantity is determined by the catalog pricing unit, not by the quotation author. */
export function tileQuantityUnit(priceUnit: unknown): "Box" | "Pieces" {
  const unit = String(priceUnit || "").trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
  if (!unit) return "Pieces";
  return ["piece", "pieces", "pc", "pcs", "per piece", "per pieces", "per pc", "per pcs", "tile", "per tile"].includes(unit) ? "Pieces" : "Box";
}

/** Missing pricing units follow the showroom's per-piece default. */
export function tilePriceUnit(priceUnit: unknown): string {
  const unit = String(priceUnit || "").trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
  if (!unit) return "per piece";
  if (tileQuantityUnit(unit) === "Pieces") return "per piece";
  if (["sqft", "sq ft", "per sqft", "per sq ft", "per square foot"].includes(unit)) return "per sq.ft";
  if (["box", "per box"].includes(unit)) return "per box";
  return "";
}
