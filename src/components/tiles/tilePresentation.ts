// Shared visual contract for the interactive tiles surfaces. Keeping this
// separate from the printed-document renderer ensures phone and picker layouts
// cannot quietly drift back to square/portrait frames.
import { PRODUCT_IMAGE_ASPECT_RATIO } from "@/src/theme/tokens";
import { layout } from "@/src/design/tokens";

export const TILE_IMAGE_ASPECT_RATIO = PRODUCT_IMAGE_ASPECT_RATIO;

export function tilesPickerColumns(containerWidth: number): number {
  if (containerWidth < layout.bp.tabletPortrait) return 1;
  // Count the products that fit in the picker itself, including gutters and
  // gaps. Tablet portrait shows four tiles and landscape shows five instead
  // of stretching two product photos across the entire screen.
  return Math.max(3, Math.min(6, Math.floor((containerWidth - 32 + 12) / (180 + 12))));
}

/** Consistent product identity on every operational Tile Orders surface. */
export function tileIdentityMeta(parts: (string | null | undefined)[], sku?: string | null): string {
  return [...parts.filter(Boolean), sku ? `SKU · ${sku}` : null].filter(Boolean).join(" · ") || "—";
}
