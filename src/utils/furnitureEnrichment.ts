import type { FurnitureQuotation } from "@/src/api/furnitureQuotations";

/** Apply an optional count only to the exact, still-current server revision. */
export function mergeFurnitureAcquisition(
  current: FurnitureQuotation | null, enriched: FurnitureQuotation, requestIsCurrent: boolean,
): FurnitureQuotation | null {
  if (!requestIsCurrent || !current || current.id !== enriched.id || current.updated_at !== enriched.updated_at || current.referrer_id !== enriched.referrer_id) return current;
  return { ...current, referrer_customers_acquired: enriched.referrer_customers_acquired };
}
