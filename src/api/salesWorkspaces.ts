import { api } from "@/src/api/client";

export type WorkspaceName = "revenue" | "collections" | "forecasting" | "customers" | "architects" | "interior-designers" | "relationships" | "products" | "brands" | "suppliers" | "operations";
export type WorkspaceFilter = { floorId?: string; preset?: string; dateFrom?: string; dateTo?: string };
export type WorkspaceData = {
  workspace: WorkspaceName; period: string;
  kpis: { revenue: number; orders: number; outstanding: number; hansgrohe_revenue: number };
  brands: { brand_id: string; name: string; revenue: number; quantity: number; orders: number; is_unlinked: boolean }[];
  products: { product_id: string; name: string; revenue: number; quantity: number; orders: number; customers: number; brand_name: string | null }[];
  customers: { customer_id: string; name: string; revenue: number; orders: number; aov: number; last_order_at: string | null }[];
  floors: { floor_id: string; revenue: number; orders: number }[];
  relationships?: { id: string; name: string; company?: string | null; type: string; revenue: number; revenue_rnb?: number; orders: number; orders_rnb?: number; customers: number; customers_acquired?: number; last_order_at: string | null; historical?: boolean }[];
  relationships_truncated?: boolean;
  forecast?: { months_used: number; history_state: string; monthly_history: number[]; forecast: number | null };
};

function query(filter: WorkspaceFilter) {
  const p = new URLSearchParams();
  if (filter.floorId && filter.floorId !== "all") p.set("floor_id", filter.floorId);
  p.set("preset", filter.preset || "this_month");
  if (filter.preset === "custom") { if (filter.dateFrom) p.set("date_from", filter.dateFrom); if (filter.dateTo) p.set("date_to", filter.dateTo); }
  return p.toString();
}

export const salesWorkspaceApi = {
  get(workspace: WorkspaceName, filter: WorkspaceFilter, options?: { signal?: AbortSignal }) { return api.get<WorkspaceData>(`/analytics/workspaces/${workspace}?${query(filter)}`, options); },
  records(filter: WorkspaceFilter, offset = 0) { return api.get<{ rows: any[]; total: number }>(`/analytics/workspaces/sales-records?${query(filter)}&offset=${offset}&limit=25`); },
};
