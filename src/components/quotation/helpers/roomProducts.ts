import type { BuilderState, Line } from "./types";

/** Keep legacy unassigned products in the first room without rewriting them on load. */
export function quotationRoom(line: Line, rooms: readonly string[]): string {
  return line.room && rooms.includes(line.room) ? line.room : rooms[0];
}

export function quotationRoomLines(state: BuilderState, room: string): Line[] {
  return state.lines.filter(line => quotationRoom(line, state.rooms) === room);
}

export function hasReservedStock(line: Line): boolean {
  return Boolean(line.godown_stock_id || line.godown_allocation_id);
}

export function previewQuantityIncrease(lines: Line[], increase: number) {
  if (!Number.isFinite(increase) || increase <= 0) return null;
  const quantities = new Map(lines.filter(line => !line.included_for_line_id).map(line => [line.id, line.qty + increase]));
  if (!quantities.size || lines.some(hasReservedStock)) return null;

  return lines.flatMap(line => {
    const parentQty = quantities.get(line.included_for_line_id || line.id);
    if (parentQty === undefined) return [];
    const quantity = parentQty * (line.included_for_line_id ? line.included_qty_per_parent || 1 : 1);
    return [{ line, quantity }];
  });
}

export function validQuantityIncrease(preview: ReturnType<typeof previewQuantityIncrease>): boolean {
  return !!preview?.length && preview.every(({ line, quantity }) => Number.isFinite(quantity) && quantity > line.qty);
}

export function cloneRoomProducts(lines: Line[], room: string, newId: () => string): Line[] {
  // Stock allocations are bound to their original line and cannot be copied.
  if (lines.some(hasReservedStock)) return [];
  const ids = new Map(lines.map(line => [line.id, newId()]));
  return lines.map(line => ({
    ...line, id: ids.get(line.id)!, room,
    included_for_line_id: line.included_for_line_id ? ids.get(line.included_for_line_id) ?? null : null,
  }));
}

export type SavedRoomSnapshot = {
  status?: string;
  updated_at?: string;
  customer_id?: string;
  items?: Line[];
  rooms?: string[];
  notes?: string;
  project_name?: string;
  phone_snapshot?: string;
  address_snapshot?: string;
  reference_source?: string;
  referrer_id?: string;
  project_discount_pct?: number;
  category_discounts?: BuilderState["categoryDiscounts"];
  room_discounts?: BuilderState["roomDiscounts"];
};

export function matchesSavedRoomSnapshot(state: BuilderState, saved: SavedRoomSnapshot): boolean {
  const header = state.header;
  if (!saved.items || !saved.rooms || saved.items.length !== state.lines.length || saved.rooms.length !== state.rooms.length
    || saved.customer_id !== state.customerId || (saved.notes || "") !== state.notes
    || (saved.project_name || "") !== header.projectName || (saved.phone_snapshot || "") !== header.phone
    || (saved.address_snapshot || "") !== header.address.trim() || (saved.reference_source || "") !== header.referenceSource
    || (saved.referrer_id || null) !== header.referrerId || (saved.project_discount_pct || 0) !== state.projectDiscount
    || !saved.rooms.every((room, index) => room === state.rooms[index])) return false;

  const categories = saved.category_discounts || {};
  const rooms = saved.room_discounts || {};
  const lineFields = [
    "id", "product_id", "sku", "name", "room", "area", "qty", "unit_price", "mrp", "discount_pct",
    "description", "notes", "dimension", "exclude_dimension", "finish", "included_for_line_id",
    "included_qty_per_parent", "godown_stock_id", "godown_allocation_id",
  ] satisfies (keyof Line)[];
  return Object.keys(categories).length === Object.keys(state.categoryDiscounts).length
    && Object.entries(categories).every(([id, pct]) => pct === state.categoryDiscounts[id])
    && Object.keys(rooms).length === Object.keys(state.roomDiscounts).length
    && Object.entries(rooms).every(([room, discount]) => discount.type === state.roomDiscounts[room]?.type && discount.value === state.roomDiscounts[room]?.value)
    && saved.items.every((line, index) => lineFields.every(key => {
      const defaultValue = key === "exclude_dimension" ? false : null;
      return (line[key] ?? defaultValue) === (state.lines[index][key] ?? defaultValue);
    }));
}
