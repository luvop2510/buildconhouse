import type { FeatherName } from "./components";
import { SANITARY_FLOOR_ID, TILES_FLOOR_ID, FURNITURE_FLOOR_ID, KITCHEN_FLOOR_ID } from "@/src/constants/floors";
export type NavItem = {
  href: string; label: string; icon: FeatherName; match: string; roles?: string[];
  // Business units this destination exists in. Omitted = every unit.
  // A single-unit module must be invisible from the others, not merely
  // reachable-but-empty: the Quotation Builder is pinned to Sanitary
  // Bathroom (every request it makes passes floorId: "first-floor"), so on
  // Ground Floor the Quotations item listed nothing and its "New Quotation"
  // button silently moved the user to the other business unit. Tile Orders /
  // Quotation Tiles are the mirror image and are already handled this way by
  // `useTilesNav`.
  //
  // Purchases belongs exclusively to the sanitary business unit.
  floors?: string[];
};

export const PRIMARY: NavItem[] = [
  { href: "/(admin)/kitchen", label: "Overview", icon: "home", match: "kitchen-overview", floors: [KITCHEN_FLOOR_ID] },
  { href: "/(admin)/kitchen/projects", label: "Projects", icon: "layers", match: "kitchen-projects", floors: [KITCHEN_FLOOR_ID] },
  { href: "/(admin)/kitchen/workflow", label: "Workflow", icon: "git-branch", match: "kitchen-workflow", floors: [KITCHEN_FLOOR_ID] },
  { href: "/(admin)/kitchen/completed", label: "Completed", icon: "check-circle", match: "kitchen-completed", floors: [KITCHEN_FLOOR_ID] },
  { href: "/(admin)/dashboard", label: "Today", icon: "sunrise", match: "dashboard" },
  { href: "/(admin)/walkins", label: "Walk-ins", icon: "user-plus", match: "walkins" },
  { href: "/(admin)/quotations", label: "Quotations", icon: "file-text", match: "quotations", floors: [SANITARY_FLOOR_ID] },
  { href: "/(admin)/catalog", label: "Catalog", icon: "package", match: "catalog", floors: [SANITARY_FLOOR_ID, TILES_FLOOR_ID] },
  { href: "/(admin)/customers", label: "Customers", icon: "users", match: "customers" },
  { href: "/(admin)/purchases", label: "Purchases", icon: "shopping-cart", match: "purchases", floors: [SANITARY_FLOOR_ID] },
  { href: "/(admin)/godown-stock", label: "Godown stock", icon: "archive", match: "godown-stock", floors: [SANITARY_FLOOR_ID] },
  { href: "/(admin)/payments", label: "Payments", icon: "credit-card", match: "payments" },
  { href: "/(admin)/payments-list", label: "Fully paid orders", icon: "list", match: "payments-list" },
  { href: "/(admin)/followups", label: "Follow-ups", icon: "phone-call", match: "followups" },
  { href: "/(admin)/notebook/furniture-quotations", label: "RNB quotations", icon: "file-text", match: "furniture-quotations", floors: [FURNITURE_FLOOR_ID] },
];

export const SECONDARY: NavItem[] = [
  { href: "/(admin)/notifications", label: "Notifications", icon: "bell", match: "notifications" },
  { href: "/(admin)/sales-data", label: "Sales Data", icon: "trending-up", match: "sales-data" },
  { href: "/(admin)/team-assign", label: "Team assign", icon: "users", match: "team-assign", roles: ["owner"] },
  { href: "/(admin)/team", label: "Team", icon: "user-check", match: "team", roles: ["owner"] },
  { href: "/(admin)/settings", label: "Settings", icon: "settings", match: "settings" },
];

export const TILES_ITEMS: NavItem[] = [
  { href: "/(admin)/tiles", label: "Quotations", icon: "layers", match: "tiles" },
  // Tile Orders' read endpoints require the backend's `sales` level. Keep
  // the selection workflow visible to a Worker, but do not link them to a
  // screen that can only respond with a 403 / "Insufficient role".
  { href: "/(admin)/tiles/orders", label: "Tile Orders", icon: "truck", match: "orders", roles: ["owner", "admin", "manager", "accounts", "purchase", "sales"] },
];


export const NAVIGATION = [...PRIMARY, ...TILES_ITEMS, ...SECONDARY];
