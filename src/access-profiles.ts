export type AccessProfile =
  | "ground_tile_quotations_followups"
  | "ground_payments_dispatches"
  | "sanitary_quotations_followups"
  | "sanitary_purchases";

export type PersonalGrant = { resource: string; actions: string[]; floor_id?: string | null };

export const PROFILE_PROVISIONING: Record<AccessProfile, {
  label: string;
  description: string;
  floorId: string;
  minimumRole: "sales" | "accounts" | "purchase";
}> = {
  ground_tile_quotations_followups: {
    label: "Ground Floor · Tile Quotations & Follow-ups",
    description: "Tiles, quotations, follow-ups, and read-only customer delivery status.",
    floorId: "ground-floor",
    minimumRole: "sales",
  },
  ground_payments_dispatches: {
    label: "Ground Floor · Payments & Dispatches",
    description: "Ground Floor payments and tile dispatch workflow.",
    floorId: "ground-floor",
    minimumRole: "accounts",
  },
  sanitary_quotations_followups: {
    label: "Sanitary Bathroom · Quotations & Follow-ups",
    description: "Sanitary quotations and customer follow-ups.",
    floorId: "first-floor",
    minimumRole: "sales",
  },
  sanitary_purchases: {
    label: "Sanitary Bathroom · Purchases",
    description: "Sanitary purchase orders, suppliers, and purchase tracking.",
    floorId: "first-floor",
    minimumRole: "purchase",
  },
};

export const PROFILE_MODULES: Record<AccessProfile, Set<string>> = {
  // Customer delivery lookup is read-only and routes directly to that
  // customer's Ground Floor order statuses. It is not general CRM access.
  ground_tile_quotations_followups: new Set(["tiles", "followups", "customers"]),
  ground_payments_dispatches: new Set(["payments", "orders"]),
  sanitary_quotations_followups: new Set(["quotations", "followups"]),
  sanitary_purchases: new Set(["purchases"]),
};

export function staffLandingPath(profile?: AccessProfile | null, grants?: PersonalGrant[], floorId?: string): string {
  const permitted = grants?.find((grant) => grant.actions.includes("view") && (!floorId || !grant.floor_id || grant.floor_id === floorId));
  if (permitted) {
    const routeByResource: Record<string, string> = {
      payments: "/(admin)/payments", quotations: "/(admin)/quotations", catalog: "/(admin)/catalog",
      customers: "/(admin)/customers", purchases: "/(admin)/purchases", followups: "/(admin)/followups",
      orders: "/(admin)/tiles/orders", walkins: "/(admin)/walkins", dashboard: "/(admin)/dashboard",
      notifications: "/(admin)/notifications", tiles: "/(admin)/tiles", godown_stock: "/(admin)/godown-stock",
      furniture_quotations: "/(admin)/notebook/furniture-quotations", sales_data: "/(admin)/sales-data",
      notebook_walkins: (floorId || permitted.floor_id) === "third-floor" ? "/(admin)/notebook/furniture" : "/(admin)/notebook/kitchen",
      notebook_quotations: (floorId || permitted.floor_id) === "third-floor" ? "/(admin)/notebook/furniture/quotation-follow-up" : "/(admin)/notebook/kitchen/quotation-follow-up",
    };
    if (routeByResource[permitted.resource]) return routeByResource[permitted.resource];
  }
  if (grants !== undefined) return "/(admin)/access";
  switch (profile) {
    case "ground_tile_quotations_followups": return "/(admin)/tiles";
    case "ground_payments_dispatches": return "/(admin)/payments";
    case "sanitary_quotations_followups": return "/(admin)/quotations";
    case "sanitary_purchases": return "/(admin)/purchases";
    default: return "/(admin)/dashboard";
  }
}
