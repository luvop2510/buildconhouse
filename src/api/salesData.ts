// frontend/src/api/salesData.ts
// Typed client for the Sales Data launch surfaces — the four breakdowns in
// backend/routes/sales_breakdown_routes.py plus the smart default period in
// executive_overview_routes.py. Same thin-wrapper pattern as src/api/executive.ts.
//
// Nothing here computes a KPI, a total, or a rank. Every figure is derived by
// the backend analytics layer so the page cannot disagree with the books —
// which is the entire reason these endpoints exist rather than the page
// reusing /executive-analytics/dashboard's differently-derived numbers.
import { api } from "@/src/api/client";

/** Every breakdown takes the same filter. Floor and date live in one place. */
export type SalesFilter = {
  floorId: string;
  preset: string;
  dateFrom?: string | null;
  dateTo?: string | null;
};

/** Options deliberately limited to read lifecycle concerns. The shared API
 * client keeps a shared GET transport alive for other consumers, while this
 * screen can still stop waiting for a stale floor or period. */
type SalesReadOptions = { signal?: AbortSignal };

export type BrandRevenueRow = {
  brand_id: string;
  name: string;
  revenue: number;
  quantity: number;
  orders: number;
  /** Revenue from products that no longer resolve to a catalog doc. Rendered
   *  as a labelled row rather than dropped, so the column still totals to the
   *  Total Revenue card. */
  is_unlinked: boolean;
};

export type CustomerRevenueRow = {
  customer_id: string;
  name: string;
  revenue: number;
  orders: number;
  aov: number;
  last_order_at: string | null;
};

export type BestSellingProductRow = {
  product_id: string;
  name: string;
  sku: string | null;
  brand_name: string | null;
  revenue: number;
  quantity: number;
  orders: number;
  customers: number;
};

export type RecentOrderRow = {
  id: string;
  number: string | null;
  customer_id: string | null;
  customer_name: string;
  floor_id: string | null;
  salesperson_name: string | null;
  ordered_at: string | null;
  grand_total: number;
  collected: number;
  outstanding: number;
};

/** One row of the Referred By workspaces. Mirrors backend
 *  services/analytics/referrals.py::ReferrerSummary — the Phase 0 surface,
 *  reused as-is. The page reads the quotation's own "Referred By" field
 *  through it and never invents referral data: when the book has no
 *  attributed referrals, the workspace renders an empty state. */
export type ReferrerSummaryRow = {
  referrer_id: string;
  name: string;
  type: "architect" | "interior_designer";
  customers_referred: number;
  quotations_total: number;
  quotations_confirmed: number;
  revenue: number;
  aov: number;
  conversion_rate: number | null;
  pending_value: number;
  pending_payments: number;
  is_active: boolean;
  repeat_customers: number;
  last_referral_at: string | null;
};

export type ReferrerType = "architect" | "interior_designer";

/** The period the page should open on, resolved server-side because only the
 *  database knows whether the current month has any confirmed orders in it. */
export type DefaultPeriod = {
  preset: string;
  date_from: string | null;
  date_to: string | null;
  label: string;
  /** True when the current month was empty and this fell back to the month of
   *  the most recent order — the page shows a banner saying so. */
  fallback_applied: boolean;
  latest_order_at: string | null;
};

function query(filter: SalesFilter, extra: Record<string, string | number | undefined> = {}) {
  const params = new URLSearchParams();
  if (filter.floorId && filter.floorId !== "all") params.set("floor_id", filter.floorId);
  params.set("preset", filter.preset);
  // A custom preset carries its own bounds; every other preset resolves them
  // server-side, and sending stale bounds alongside would silently win.
  if (filter.preset === "custom") {
    if (filter.dateFrom) params.set("date_from", filter.dateFrom);
    if (filter.dateTo) params.set("date_to", filter.dateTo);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

export const salesDataApi = {
  revenueTrend(filter: SalesFilter, options?: SalesReadOptions) {
    const days = filter.dateFrom && filter.dateTo ? (Date.parse(filter.dateTo) - Date.parse(filter.dateFrom)) / 86400000 : null;
    const granularity = ["quarter", "year"].includes(filter.preset) || (days !== null && days > 62) ? "month" : "day";
    return api.get<{ points: { bucket: string; revenue: number }[] }>(`/analytics/revenue-trend?${query(filter, { granularity })}`, options);
  },
  defaultPeriod(floorId: string, options?: SalesReadOptions) {
    const params = new URLSearchParams();
    if (floorId && floorId !== "all") params.set("floor_id", floorId);
    return api.get<DefaultPeriod>(`/analytics/default-period?${params.toString()}`, options);
  },

  revenueByBrand(filter: SalesFilter, options?: SalesReadOptions) {
    return api.get<{ rows: BrandRevenueRow[] }>(`/analytics/revenue-by-brand?${query(filter)}`, options);
  },

  revenueByCustomer(filter: SalesFilter, options?: SalesReadOptions) {
    return api.get<{ rows: CustomerRevenueRow[] }>(`/analytics/revenue-by-customer?${query(filter)}`, options);
  },

  bestSellingProducts(filter: SalesFilter, limit = 10, options?: SalesReadOptions) {
    return api.get<{ rows: BestSellingProductRow[]; total: number }>(
      `/analytics/best-selling-products?${query(filter, { limit })}`,
      options,
    );
  },

  recentOrders(filter: SalesFilter, limit = 10, options?: SalesReadOptions) {
    return api.get<{ rows: RecentOrderRow[]; total: number }>(
      `/analytics/recent-orders?${query(filter, { limit })}`,
      options,
    );
  },

  /**
   * The same canonical confirmed-order rows shown in the Sales Data table,
   * exported without the UI's top-N limit. `query` carries the active floor
   * and period so the workbook cannot include records outside the view the
   * user is currently analysing.
   */
  salesExportPath(filter: SalesFilter) {
    return `/analytics/recent-orders?${query(filter, { format: "xlsx" })}`;
  },

  /** Phase 0's referral surface, consumed unchanged — one call per referrer
   *  type so Architects and Interior Designers render as the two separate
   *  workspaces the launch spec asks for. */
  referrers(filter: SalesFilter, type: ReferrerType, options?: SalesReadOptions) {
    return api.get<{ rows: ReferrerSummaryRow[] }>(
      `/analytics/referrers?${query(filter, { type })}`,
      options,
    );
  },
};
