/** Quantity is determined by the catalog pricing unit, not by the quotation author. */
export function tileQuantityUnit(priceUnit: unknown): "Box" | "Pieces" {
  const unit = String(priceUnit || "").trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
  return ["piece", "pieces", "pc", "pcs", "per piece", "per pieces", "per pc", "per pcs", "tile", "per tile"].includes(unit) ? "Pieces" : "Box";
}
