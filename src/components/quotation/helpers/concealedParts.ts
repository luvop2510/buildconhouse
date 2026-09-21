// Concealed-part expansion is deliberately a pure helper. The quotation
// builder can keep its undo/redo state update atomic, while this behaviour is
// directly regression-testable without rendering React Native components.

type ConcealedPart = {
  sku: string; product_id?: string | null; name?: string | null;
  description?: string | null; unit_price?: number | null; mrp?: number | null;
  image?: string | null; qty?: number | null;
};

type ProductLike = {
  id: string; sku: string; name: string; price: number; mrp: number;
  category_id: string; finish?: string | null; colour?: string | null;
  family_key?: string | null; images?: string[]; concealed_part?: ConcealedPart | null; specs?: Record<string, unknown> | null;
};

type VariantLike = {
  id?: string | null; sku: string; price: number; mrp: number;
  finish?: string | null; colour?: string | null; color?: string | null;
  size?: string | null; image?: string | null; concealed_part?: ConcealedPart | null; specs?: Record<string, unknown> | null;
};

type LineLike = {
  id: string; product_id: string; sku: string; name: string; image?: string | null;
  category_id?: string | null; room?: string; qty: number; unit_price: number;
  mrp?: number | null; discount_pct: number | null; finish?: string | null;
  family_key?: string | null; description?: string | null;
  included_for_line_id?: string | null; included_qty_per_parent?: number | null;
};

type IncludedPart = ConcealedPart & { role?: string };

function defaultIncludedParts(product: ProductLike, variant?: VariantLike): IncludedPart[] {
  const source = variant?.specs?.default_included_parts ?? product.specs?.default_included_parts;
  if (!Array.isArray(source)) return [];
  return source.filter((part): part is IncludedPart => (
    !!part && typeof part === "object" && typeof part.sku === "string" && !!part.sku.trim()
      && typeof part.product_id === "string" && !!part.product_id
      && typeof part.unit_price === "number" && Number.isFinite(part.unit_price)
  ));
}

/** Replace catalog-controlled included parts for an already-created parent line. */
export function syncDefaultIncludedParts<T extends LineLike>(
  lines: T[], parent: T, product: ProductLike, variant: VariantLike | undefined,
  newLineId: (productId: string) => string,
): T[] {
  let next = lines.filter((line) => line.included_for_line_id !== parent.id);
  for (const part of defaultIncludedParts(product, variant)) {
    next.push({
      id: newLineId(part.product_id!), product_id: part.product_id!, sku: part.sku.trim(),
      name: part.name || `Included part · ${part.sku}`, image: part.image || null,
      category_id: product.category_id, room: parent.room, qty: parent.qty * Number(part.qty || 1),
      unit_price: Number(part.unit_price), mrp: part.mrp ?? part.unit_price ?? null,
      discount_pct: null, finish: null, family_key: null,
      included_for_line_id: parent.id, included_qty_per_parent: Number(part.qty || 1),
    } as T);
  }
  return next;
}

export function addProductAndConcealedPart<T extends LineLike>(
  lines: T[], product: ProductLike, variant: VariantLike | undefined, room: string,
  newLineId: (productId: string) => string, primaryImage: string | null,
): T[] {
  const productId = variant?.id || product.id;
  const sku = variant?.sku || product.sku;
  const variantColour = variant?.colour || variant?.color;
  const finish = variant?.finish || variantColour || variant?.size || product.finish || product.colour || null;
  const displayName = variant && (variant.finish || variantColour || variant.size)
    ? `${product.name} · ${variant.finish || variantColour || variant.size}` : product.name;
  const addOrIncrease = (current: T[], line: T): T[] => {
    const index = current.findIndex((item) => item.product_id === line.product_id && item.room === room);
    if (index < 0) return [...current, line];
    const next = [...current];
    next[index] = { ...next[index], qty: next[index].qty + line.qty };
    return next;
  };
  let next = addOrIncrease(lines, {
    id: newLineId(productId), product_id: productId, sku, name: displayName,
    image: variant?.image || primaryImage, category_id: product.category_id, room,
    qty: 1, unit_price: variant?.price ?? product.price, mrp: variant?.mrp ?? product.mrp,
    discount_pct: null, finish, family_key: product.family_key || null,
  } as T);
  const parent = next.find((line) => line.product_id === productId && line.room === room)!;

  // Seat covers are not an optional cross-sell: they follow their selected
  // WC's SKU and quantity. A re-select replaces any prior linked cover rather
  // than accumulating a duplicate line.
  next = syncDefaultIncludedParts(next, parent, product, variant, newLineId);

  const concealed = variant?.concealed_part || product.concealed_part;
  const concealedId = concealed?.product_id;
  if (!concealedId || concealedId === productId || !concealed?.sku) return next;
  const qty = Number(concealed.qty || 1);
  if (!Number.isFinite(qty) || qty <= 0) return next;
  return addOrIncrease(next, {
    id: newLineId(concealedId), product_id: concealedId, sku: concealed.sku,
    name: concealed.name || `Conceal part · ${concealed.sku}`,
    image: concealed.image || null, category_id: null, room, qty,
    unit_price: Number(concealed.unit_price || 0), mrp: concealed.mrp ?? null,
    discount_pct: null, finish: null, family_key: null,
    description: concealed.description || null,
  } as T);
}
