// Concealed-part expansion is deliberately a pure helper. The quotation
// builder can keep its undo/redo state update atomic, while this behaviour is
// directly regression-testable without rendering React Native components.

type ConcealedPart = {
  sku: string; product_id?: string | null; name?: string | null;
  description?: string | null; unit_price?: number | null; mrp?: number | null;
  image?: string | null; qty?: number | null;
};

type ProductLike = {
  id: string; sku: string; name: string; price: number; mrp: number; description?: string | null;
  category_id: string; finish?: string | null; colour?: string | null; dimensions?: string | null;
  family_key?: string | null; images?: string[]; concealed_part?: ConcealedPart | null; specs?: Record<string, unknown> | null;
  variants?: VariantLike[];
};

type VariantLike = {
  id?: string | null; sku: string; name?: string | null; price: number; mrp: number; description?: string | null;
  finish?: string | null; colour?: string | null; color?: string | null;
  size?: string | null; image?: string | null; dimensions?: string | null; exclude_dimension?: boolean; concealed_part?: ConcealedPart | null; specs?: Record<string, unknown> | null;
};

type LineLike = {
  id: string; product_id: string; sku: string; name: string; image?: string | null;
  image_candidates?: string[];
  category_id?: string | null; room?: string; qty: number; unit_price: number;
  mrp?: number | null; discount_pct: number | null; finish?: string | null;
  family_key?: string | null; description?: string | null;
  dimension?: string | null; exclude_dimension?: boolean;
  included_for_line_id?: string | null; included_qty_per_parent?: number | null;
  included_part_role?: "seat_cover" | null; availability?: "Coming Soon" | null;
  area?: string | null;
};

type IncludedPart = ConcealedPart & { role?: string; finish?: string | null; category_id?: string | null };

export function selectedProductSpecs(product: ProductLike, variant?: VariantLike | null) {
  if (variant && (variant.sku !== product.sku || (variant.id && variant.id !== product.id))) return variant.specs;
  return variant?.specs ?? product.specs;
}

export function catalogAvailability(product: ProductLike, variant?: VariantLike | null) {
  return selectedProductSpecs(product, variant)?.availability === "Coming Soon" ? "Coming Soon" as const : null;
}

/** A sibling SKU must never inherit the representative product's rough-in. */
export function productConcealedPart(product: ProductLike, variant?: VariantLike | null): ConcealedPart | null | undefined {
  if (variant && (variant.concealed_part !== undefined || (variant.id && variant.id !== product.id))) {
    return variant.concealed_part;
  }
  return product.concealed_part;
}

export function defaultIncludedParts(product: ProductLike, variant?: VariantLike | null): IncludedPart[] {
  const source = selectedProductSpecs(product, variant)?.default_included_parts;
  if (!Array.isArray(source)) return [];
  return source.filter((part): part is IncludedPart => (
    !!part && typeof part === "object" && typeof part.sku === "string" && !!part.sku.trim()
      && typeof part.product_id === "string" && !!part.product_id
      && typeof part.unit_price === "number" && Number.isFinite(part.unit_price)
  ));
}

function automaticIncludedParts(product: ProductLike, variant: VariantLike | undefined, parentProductId: string): IncludedPart[] {
  const concealed = productConcealedPart(product, variant);
  const seen = new Set<string>();
  return [...defaultIncludedParts(product, variant), ...(concealed ? [{ ...concealed, role: "concealed" }] : [])]
    .filter((part) => {
      const ratio = Number(part.qty ?? 1);
      if (!part.product_id || part.product_id === parentProductId || !part.sku?.trim()
          || !Number.isFinite(ratio) || ratio <= 0 || seen.has(part.product_id)) return false;
      seen.add(part.product_id);
      return true;
    });
}

/** Replace automatic parts for a parent, keeping quantity/room/removal linked. */
export function syncDefaultIncludedParts<T extends LineLike>(
  lines: T[], parent: T, product: ProductLike, variant: VariantLike | undefined,
  newLineId: (productId: string) => string,
): T[] {
  const previous = new Map(lines.filter(line => line.included_for_line_id === parent.id).map(line => [line.product_id, line]));
  const included = automaticIncludedParts(product, variant, parent.product_id).map((part) => {
    const ratio = Number(part.qty ?? 1);
    const quantity = parent.qty * ratio;
    const unitPrice = Number(part.unit_price ?? 0);
    const existing = previous.get(part.product_id!);
    if (existing && existing.sku === part.sku && existing.unit_price === unitPrice
        && (existing.included_qty_per_parent ?? 1) === ratio) {
      return { ...existing, qty: quantity, room: parent.room, area: parent.area };
    }
    return {
      id: newLineId(part.product_id!), product_id: part.product_id!, sku: part.sku.trim(),
      name: part.name || `Included part · ${part.sku}`, image: part.image || null,
      category_id: part.role === "concealed" ? null : part.category_id ?? product.category_id,
      room: parent.room, area: parent.area, qty: quantity,
      unit_price: unitPrice, mrp: part.mrp ?? part.unit_price ?? null,
      discount_pct: null, finish: part.finish ?? null, family_key: null,
      description: part.description || null,
      included_for_line_id: parent.id, included_qty_per_parent: ratio,
      ...(part.role === "seat_cover" ? { included_part_role: "seat_cover" } : {}),
    } as T;
  });
  return lines.flatMap((line) => {
    if (line.id === parent.id) return [line, ...included];
    return line.included_for_line_id === parent.id ? [] : [line];
  });
}

export function addProductAndConcealedPart<T extends LineLike>(
  lines: T[], product: ProductLike, variant: VariantLike | undefined, room: string,
  newLineId: (productId: string) => string, photoUrls: string[],
  quantity = 1, notes?: string,
): T[] {
  if (!Number.isFinite(quantity) || quantity <= 0) return lines;
  const productId = variant?.id || product.id;
  const sku = variant?.sku || product.sku;
  const variantColour = variant?.colour || variant?.color;
  const availability = catalogAvailability(product, variant);
  const finish = variant?.finish || variantColour || variant?.size || product.finish || product.colour || null;
  const displayName = variant?.name || product.variants?.find(candidate =>
    candidate.sku === sku && candidate.id === productId)?.name || product.name;
  const expectedParts = automaticIncludedParts(product, variant, productId);
  const childrenByParent = new Map<string, T[]>();
  for (const line of lines) {
    if (!line.included_for_line_id) continue;
    const children = childrenByParent.get(line.included_for_line_id) ?? [];
    children.push(line);
    childrenByParent.set(line.included_for_line_id, children);
  }
  const sameAutomaticParts = (parentId: string) => {
    const children = childrenByParent.get(parentId) ?? [];
    return children.length === expectedParts.length && expectedParts.every((part) => children.some((line) =>
      line.product_id === part.product_id && line.sku === part.sku && line.unit_price === Number(part.unit_price ?? 0)
      && Number(line.included_qty_per_parent ?? 1) === Number(part.qty ?? 1)));
  };
  let parentId = "";
  const addOrIncrease = (current: T[], line: T): T[] => {
    const index = current.findIndex((item) => item.product_id === line.product_id && item.sku === line.sku && item.room === room
      && !item.included_for_line_id
      && !!item.exclude_dimension === !!line.exclude_dimension
      && item.unit_price === line.unit_price && (item.availability ?? null) === availability && sameAutomaticParts(item.id));
    if (index < 0) { parentId = line.id; return [...current, line]; }
    parentId = current[index].id;
    const next = [...current];
    next[index] = { ...next[index], qty: next[index].qty + line.qty,
      ...(line.image ? { image: line.image, image_candidates: line.image_candidates } : {}),
      ...(notes?.trim() ? { notes: notes.trim() } : {}) };
    return next;
  };
  const next = addOrIncrease(lines, {
    id: newLineId(productId), product_id: productId, sku, name: displayName,
    image: photoUrls[0] ?? null, image_candidates: photoUrls.slice(1), category_id: product.category_id, room,
    qty: quantity, unit_price: variant?.price ?? product.price, mrp: variant?.mrp ?? product.mrp,
    discount_pct: null, finish, family_key: product.family_key || null,
    description: variant?.description ?? product.description ?? null,
    exclude_dimension: !!variant?.exclude_dimension,
    ...(availability ? { availability } : {}),
    ...(notes?.trim() ? { notes: notes.trim() } : {}),
  } as T);
  // A changed association or rough-in price starts another parent line;
  // already quoted commercial snapshots remain intact.
  const parent = next.find((line) => line.id === parentId)!;

  return syncDefaultIncludedParts(next, parent, product, variant, newLineId);
}

export function wcCombinations<T extends LineLike>(
  lines: readonly T[], pricing: Record<string, { net: number }>,
) {
  const parents = new Map(lines.filter(line => !line.included_for_line_id).map(line => [line.id, line]));
  const combinations: Record<string, { cover: T; mrp: number; net: number }> = Object.create(null);
  for (const cover of lines) {
    if (cover.included_part_role !== "seat_cover" || !cover.included_for_line_id) continue;
    const parent = parents.get(cover.included_for_line_id);
    if (!parent) continue;
    combinations[parent.id] = {
      cover,
      mrp: (parent.mrp ?? parent.unit_price) * parent.qty + (cover.mrp ?? cover.unit_price) * cover.qty,
      net: (pricing[parent.id]?.net ?? 0) + (pricing[cover.id]?.net ?? 0),
    };
  }
  return combinations;
}
