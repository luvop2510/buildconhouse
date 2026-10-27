import { api } from "@/src/api/client";
import type { WorkspaceFilter } from "@/src/api/salesWorkspaces";

export type SalesQuantity = { unit: string; quantity: number };
export type SalesSummaryBrand = {
  brand_id: string; name: string; revenue: number; orders: number; products: number;
  quantities: SalesQuantity[]; is_unlinked: boolean;
};
export type SalesSummaryProduct = {
  product_id: string; name: string; sku: string | null; brand_name: string | null;
  revenue: number; orders: number; customers: number; quantities: SalesQuantity[];
};
export type SalesSummaryCustomer = {
  key: string; customer_id: string | null; name: string; phone: string | null;
  currency: "INR" | "RNB"; floor_ids: string[]; revenue: number; orders: number;
  outstanding: number; last_order_at: string | null;
};
export type SalesSummaryDepartment = {
  floor_id: string; currency: "INR" | "RNB"; revenue: number; orders: number;
  customers: number; total_customers: number; outstanding: number;
};
export type SalesSummary = {
  period: { start: string | null; end: string | null; label: string };
  kpis: {
    revenue: number; revenue_rnb: number; orders: number; customers: number; total_customers: number;
    products: number; outstanding: number; outstanding_rnb: number; followups: number; overdue_followups: number;
  };
  quantities: SalesQuantity[];
  brands: SalesSummaryBrand[];
  products: SalesSummaryProduct[];
  customers: SalesSummaryCustomer[];
  departments: SalesSummaryDepartment[];
  totals: { brands: number; products: number; customers: number };
  limit: number;
  coverage: {
    sales: "all_departments"; outstanding: "department_ledgers";
    sales_available: boolean; products_available: boolean; outstanding_available: boolean;
    note: string;
  };
};

export const salesSummaryApi = {
  get(filter: WorkspaceFilter, options?: { signal?: AbortSignal; fresh?: boolean }) {
    const query = new URLSearchParams();
    if (filter.floorId && filter.floorId !== "all") query.set("floor_id", filter.floorId);
    query.set("preset", filter.preset || "this_month");
    if (filter.preset === "custom") {
      if (filter.dateFrom) query.set("date_from", filter.dateFrom);
      if (filter.dateTo) query.set("date_to", filter.dateTo);
    }
    if (options?.fresh) query.set("fresh", "true");
    return api.get<SalesSummary>(`/analytics/sales-summary?${query}`, { signal: options?.signal });
  },
};
