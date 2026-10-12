// Pricing helpers — pure, memoisable, testable.
// Discount precedence (single winner per line, most-specific wins — mirrors
// backend/routes/quotation_routes.py _effective_discount_pct EXACTLY so the
// builder's live totals never drift from what the server persists):
//   Product override  >  Room discount  >  Category discount  >  Project discount
// Room discounts come in two flavours:
//   percent — behaves exactly like a category/project discount (pct off the line)
//   amount  — a flat ₹ off the ROOM's subtotal, allocated proportionally across
//             that room's (non-product-overridden) lines for itemised display.
import type { Line, RoomDiscount } from "./types";
import { computeQuotationTotals } from "./totals";

export function effectivePct(
  l: Line,
  roomDiscs: Record<string, RoomDiscount>,
  catDiscs: Record<string, number>,
  projPct: number,
): { pct: number; source: string } {
  if (l.discount_pct != null) return { pct: l.discount_pct, source: "product" };
  const rd = l.room ? roomDiscs[l.room] : undefined;
  if (rd && rd.value > 0) {
    if (rd.type === "percent") return { pct: rd.value, source: "room" };
    // amount-type: no per-line pct — handled by the room-amount allocation pass.
    return { pct: 0, source: "room_amount" };
  }
  if (l.category_id && catDiscs[l.category_id] != null) return { pct: catDiscs[l.category_id], source: "category" };
  if (projPct) return { pct: projPct, source: "project" };
  return { pct: 0, source: "none" };
}

export function sourceBadge(source: string): { tone: "info" | "success" | "warning"; label: string } | null {
  if (source === "room" || source === "room_amount") return { tone: "warning", label: "Room" };
  if (source === "category") return { tone: "info", label: "Cat" };
  if (source === "project") return { tone: "success", label: "Proj" };
  return null;
}

export function computeLineTotal(l: Line, pct: number): number {
  return l.qty * l.unit_price * (1 - pct / 100);
}

// Per-line breakdown row — used by both the live totals AND the on-screen
// discount-source badges, so they can never disagree.
export type LineBreakdown = {
  line: Line; gross: number; pct: number; source: string;
  discountAmount: number; net: number;
};

export function computeLineBreakdown(
  lines: Line[],
  projectDiscount: number,
  categoryDiscounts: Record<string, number>,
  roomDiscounts: Record<string, RoomDiscount> = {},
): LineBreakdown[] {
  const rows: LineBreakdown[] = lines.map((l) => {
    const gross = l.qty * l.unit_price;
    const { pct, source } = effectivePct(l, roomDiscounts, categoryDiscounts, projectDiscount);
    return { line: l, gross, pct, source, discountAmount: gross * pct / 100, net: 0 };
  });

  // Second pass — allocate flat room-amount discounts proportionally across
  // the affected room's eligible lines (those that fell through to
  // source==="room_amount", i.e. no product override took precedence).
  const byRoom = new Map<string, LineBreakdown[]>();
  for (const row of rows) {
    if (row.source !== "room_amount") continue;
    const key = row.line.room || "";
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key)!.push(row);
  }
  for (const [room, roomRows] of byRoom) {
    const cfg = roomDiscounts[room];
    if (!cfg || cfg.type !== "amount" || cfg.value <= 0) continue;
    const roomGross = roomRows.reduce((s, r) => s + r.gross, 0);
    const flatDiscount = Math.min(cfg.value, roomGross);
    if (roomGross <= 0 || flatDiscount <= 0) continue;
    for (const row of roomRows) {
      row.discountAmount = flatDiscount * (row.gross / roomGross);
      row.pct = roomGross > 0 ? (row.discountAmount / row.gross) * 100 : 0;
    }
  }

  for (const row of rows) row.net = row.gross - row.discountAmount;
  return rows;
}

export function computeTotals(
  lines: Line[],
  projectDiscount: number,
  categoryDiscounts: Record<string, number>,
  roomDiscounts: Record<string, RoomDiscount> = {},
): { subtotal: number; discount: number; grand: number } {
  const rows = computeLineBreakdown(lines, projectDiscount, categoryDiscounts, roomDiscounts);
  let sub = 0, disc = 0;
  for (const r of rows) { sub += r.gross; disc += r.discountAmount; }
  const totals = computeQuotationTotals(
    [{ qty: 1, unitPrice: sub, discountAmount: disc }],
  );
  return { subtotal: totals.subtotal, discount: totals.discount, grand: totals.grandTotal };
}

// Joins whichever of finish/size/color are present into one display
// string, e.g. "Glossy · 600×600mm". A tile has both a finish and a size —
// the old pattern (`finish || color || size || sku`) picked only ONE of
// them, silently dropping the other. Returns "" (never a fallback to sku)
// so callers decide their own sku fallback explicitly.
export function variantDescriptor(v: { finish?: string | null; size?: string | null; colour?: string | null; color?: string | null; variant_label?: string | null }): string {
  if (v.variant_label?.trim()) return [v.variant_label.trim(), v.size].filter(Boolean).join(" · ");
  return [v.finish, v.size, v.colour ?? v.color].filter((part): part is string => !!part).join(" · ");
}

// Approximate swatch colour from a finish label. Kept deliberately small — we
// fall back to a neutral chrome tone when we don't recognise the finish.
export function finishSwatch(finish?: string | null): string {
  const f = (finish || "").toLowerCase();
  if (!f) return "#c5c8cc";
  if (f.includes("matt black") || f.includes("matte black") || f.includes(" black")) return "#111214";
  if (f.includes("chrome")) return "#c5c8cc";
  if (f.includes("brushed") && f.includes("brass")) return "#a37f38";
  if (f.includes("brass") || f.includes("gold")) return "#d4a94b";
  if (f.includes("copper")) return "#b87333";
  if (f.includes("bronze")) return "#8a5a2b";
  if (f.includes("nickel")) return "#a5a5a8";
  if (f.includes("stone") || f.includes("grey") || f.includes("gray")) return "#8a8a8f";
  if (f.includes("taupe")) return "#7f6f5b";
  if (f.includes("white")) return "#f6f6f7";
  return "#c5c8cc";
}
