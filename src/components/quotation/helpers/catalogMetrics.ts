import type { Line, Product } from "./types";

/** Index once per room edit instead of rescanning every line for every card. */
export function roomProductQuantities(lines: readonly Pick<Line, "product_id" | "room" | "qty">[], activeRoom: string) {
  const quantities = new Map<string, number>();
  for (const line of lines) {
    if (line.room !== activeRoom || !line.product_id) continue;
    quantities.set(line.product_id, (quantities.get(line.product_id) || 0) + line.qty);
  }
  return quantities;
}

/** Representative cards include the quantities of their own finish variants. */
export function catalogProductQuantity(product: Pick<Product, "id" | "variants">, quantities: ReadonlyMap<string, number>) {
  const ids = new Set([product.id, ...(product.variants || []).map(variant => variant.id).filter((id): id is string => !!id)]);
  let quantity = 0;
  for (const id of ids) quantity += quantities.get(id) || 0;
  return quantity;
}
