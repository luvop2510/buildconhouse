import { SANITARY_FLOOR_ID } from '@/src/constants/floors';
import { api } from './client';

export type SanitaryReport =
  | 'pending-company' | 'pending-interior' | 'placed-company' | 'placed-interior'
  | 'products' | 'interior-orders';
export type SanitaryPreset = 'all_time' | 'last_7_days' | 'last_30_days' | 'custom';
export type SanitaryValueBasis = 'mrp' | 'offer';
export type SanitarySort = 'quantity' | 'value' | 'orders' | 'customers';

export type SanitaryFilters = {
  preset: SanitaryPreset;
  date_from?: string;
  date_to?: string;
  value_basis: SanitaryValueBasis;
  brand_id?: string;
  sort?: SanitarySort;
};
export type SanitaryReadFilters = SanitaryFilters & {
  group_id?: string;
  customer_id?: string;
  page?: number;
  page_size?: number;
};

export type SanitaryBrand = { id: string; name: string };
export type SanitaryMetrics = {
  value: number | null;
  mrp_value: number | null;
  offer_value: number | null;
  missing_value_lines: number;
  missing_mrp_lines: number;
  missing_offer_lines: number;
  customer_count: number;
  document_count: number;
};
export type SanitarySummary = SanitaryMetrics & {
  id: string;
  name: string;
  brands: string[];
  statuses: string[];
  quantity?: number | null;
  unit?: string | null;
  brand?: string | null;
  sku?: string | null;
  size?: string | null;
  finish?: string | null;
  image_url?: string | null;
};
export type SanitaryLine = {
  id: string;
  name: string;
  brand: string | null;
  sku: string | null;
  size: string | null;
  finish: string | null;
  unit: string | null;
  quantity: number | null;
  value: number | null;
  mrp_value: number | null;
  offer_value: number | null;
};
export type SanitaryDocument = SanitaryMetrics & {
  id: string;
  name: string;
  customer_name: string | null;
  contact: string | null;
  number: string | null;
  date: string | null;
  status: string | null;
  quotation_id: string | null;
  quotation_number: string | null;
  quotation_date?: string | null;
  pdf_available: boolean;
  brands: string[];
  items: SanitaryLine[];
};
export type SanitaryResponse = {
  total: number;
  page: number;
  page_size: number;
  totals: SanitaryMetrics;
  date_from: string | null;
  date_to: string | null;
  notes: string[];
} & (
  | { level: 'groups' | 'customers'; items: SanitarySummary[] }
  | { level: 'documents'; items: SanitaryDocument[] }
);

export type OverviewFilters = SanitaryFilters & {
  architect_sort: 'value' | 'orders' | 'customers';
  product_sort: 'quantity' | 'value';
};
export type SanitaryStage = 'draft' | 'pending' | 'placed' | 'delivered' | 'payment_pending' | 'paid';
export type OverviewSection = SanitaryStage | 'pending_quotations' | 'followups' | 'outstanding' | 'delivered_unpaid'
  | 'conversion' | 'brand' | 'architect' | 'attention';
export type SanitaryBalance = {
  value: number | null;
  order_count: number;
  missing_amounts: number;
};
export type SanitaryOverview = {
  kpis: {
    pending_quotations: SanitaryMetrics;
    placed_orders: SanitaryMetrics;
    draft_customers: number;
    pending_customers: number;
    followups: { overdue: number; today: number; customer_count: number };
    outstanding: SanitaryBalance & { customer_count: number };
    delivered_unpaid: SanitaryBalance;
    conversion: { rate: number | null; converted: number; opportunities: number };
  };
  pipeline: ({ id: SanitaryStage; name: string } & Pick<SanitaryMetrics,
    'document_count' | 'customer_count' | 'value' | 'missing_value_lines'>)[];
  brands: (SanitaryBrand & {
    pending_value: number | null;
    placed_value: number | null;
    order_count: number;
    quantities: { unit: string; quantity: number }[];
    share: number | null;
  })[];
  architects: {
    id: string; name: string; type?: string | null; customer_count: number; draft_customers: number; pending_customers: number;
    order_count: number; order_value: number | null; outstanding: number | null;
  }[];
  products: SanitarySummary[];
  attention: SanitaryActions[];
  payments: {
    items: SanitaryActivity[];
    aging: ({ id: string; name: string } & Pick<SanitaryBalance, 'order_count' | 'value'>)[];
  };
  notes: string[];
};
export type SanitaryActivity = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  number?: string | null;
  status?: string | null;
  date?: string | null;
  value?: number | null;
  target_type: 'quotation' | 'payment' | 'followup';
  target_id: string;
  kind: string;
  label?: string;
  reason?: string;
  order_amount?: number | null;
  paid?: number | null;
  credits?: number | null;
  outstanding?: number | null;
  due_date?: string | null;
  payment_due_date?: string | null;
  days_overdue?: number | null;
  age_days?: number | null;
  age_reference?: string | null;
  delivery_status?: string | null;
  delivered_at?: string | null;
  employee?: string | null;
};
export type SanitaryActions = {
  id: string;
  customer_id: string | null;
  customer_name: string;
  items: SanitaryActivity[];
};
type OverviewPage = { items: (SanitaryActions | SanitaryActivity)[]; page: number; page_size: number; total: number };

function salesPath(resource: string, filters: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return `/sanitary-sales/${resource}?${query}`;
}

export const sanitarySalesApi = {
  brands: (signal: AbortSignal) =>
    api.get<{ items: SanitaryBrand[] }>('/sanitary-sales/brands', { floorId: SANITARY_FLOOR_ID, signal, cacheMs: 0 }),
  report: (report: SanitaryReport, filters: SanitaryReadFilters, signal: AbortSignal) =>
    api.get<SanitaryResponse>(salesPath(report, filters), { floorId: SANITARY_FLOOR_ID, signal, cacheMs: 0 }),
  reportKey: (report: SanitaryReport, filters: SanitaryReadFilters) => salesPath(report, filters),
  exportPath: (report: SanitaryReport, filters: SanitaryFilters) => salesPath(`${report}/export`, filters),
  overviewKey: (filters: OverviewFilters) => salesPath('overview', filters),
  overview: (filters: OverviewFilters, signal: AbortSignal) =>
    api.get<SanitaryOverview>(salesPath('overview', filters), { floorId: SANITARY_FLOOR_ID, signal, cacheMs: 0 }),
  overviewSectionKey: (section: OverviewSection, filters: OverviewFilters, page: number, groupId?: string) =>
    salesPath(`overview/${section}`, { ...filters, page, group_id: groupId }),
  overviewSection: (key: string, signal: AbortSignal) =>
    api.get<OverviewPage>(key, { floorId: SANITARY_FLOOR_ID, signal, cacheMs: 0 }),
  pdfPath: (quotationId: string) => `/sanitary-sales/quotation-pdfs/${encodeURIComponent(quotationId)}`,
};
