import type { GodownLot } from "../../../api/godownStock";

/** A quotation must retain the exact physical lot, never a guessed catalog SKU. */
export function godownQuotationPrice(lot: GodownLot, variantParam?: string | null): { price: number; label: string | null } {
  if (lot.archived || lot.quantity_missing || !lot.product_id || !(Number(lot.transferable_qty ?? lot.available_qty) > 0)) {
    throw new Error("That godown lot is no longer available");
  }
  const hasVariant = variantParam != null;
  const index = hasVariant && variantParam.trim() ? Number(variantParam) : -1;
  const variant = hasVariant && Number.isInteger(index) && index >= 0 ? lot.price_variants?.[index] : null;
  if (hasVariant && !variant) throw new Error("That price variant is no longer available. Choose a price again in Godown stock.");
  const price = hasVariant ? variant?.price : lot.unit_price;
  if (price == null || !Number.isFinite(price) || price < 0) {
    throw new Error("Record a unit price in Godown stock before adding this lot to a quotation.");
  }
  return { price, label: variant?.label || null };
}
