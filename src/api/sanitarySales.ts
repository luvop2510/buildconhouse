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

function reportPath(report: SanitaryReport, filters: SanitaryReadFilters, exportFile = false) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return `/sanitary-sales/${report}${exportFile ? '/export' : ''}?${query}`;
}

export const sanitarySalesApi = {
  brands: (signal: AbortSignal) =>
    api.get<{ items: SanitaryBrand[] }>('/sanitary-sales/brands', { floorId: SANITARY_FLOOR_ID, signal, cacheMs: 0 }),
  report: (report: SanitaryReport, filters: SanitaryReadFilters, signal: AbortSignal) =>
    api.get<SanitaryResponse>(reportPath(report, filters), { floorId: SANITARY_FLOOR_ID, signal, cacheMs: 0 }),
  reportKey: (report: SanitaryReport, filters: SanitaryReadFilters) => reportPath(report, filters),
  exportPath: (report: SanitaryReport, filters: SanitaryFilters) => reportPath(report, filters, true),
  pdfPath: (quotationId: string) => `/sanitary-sales/quotation-pdfs/${encodeURIComponent(quotationId)}`,
};
