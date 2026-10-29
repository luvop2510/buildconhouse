import { api } from './client';

export type AnalyticsKind = 'companies' | 'products' | 'architects' | 'customers';
export type AnalyticsFilters = Record<string, string>;
export type AnalyticsEntity = { id: string; name: string; sales: number | null; sales_rnb?: number | null; orders: number | null; customers?: number | null; quantity?: number | null; unit?: string; floor_ids?: string[]; detail?: string };
export type AnalyticsOrder = { id: string; number?: string; customer_id?: string; customer_name?: string; floor_id: string; currency: string; date: string | null; status: string; sales: number | null; collected?: number | null; outstanding?: number | null; architect_id?: string; architect_name?: string; source?: string };
export type AnalyticsTrend = { id: string; label: string; start: string; end: string; sales: number | null; sales_rnb?: number | null; orders: number; orders_inr?: number; orders_rnb?: number; previous_sales: number | null; previous_sales_rnb?: number | null; quantity?: number | null; unit?: string | null };
export type AnalyticsFloor = { id: string; floor_id: string; name: string; currency: string; sales: number | null; orders: number | null; customers: number | null; average_order_value: number | null; contribution_pct: number | null };
export type AnalyticsDashboardData = {
 currencies?: ('INR' | 'RNB')[]; metric_label?: string; title: string; generated_at: string; period: { label: string; start: string | null; end: string | null }; filters: AnalyticsFilters;
 kpis: { sales: number | null; sales_rnb: number | null; orders: number | null; customers: number | null; average_order_value: number | null; average_order_value_rnb: number | null; collected: number | null; outstanding: number | null; products: number | null; change_pct: number | null; change_pct_rnb?: number | null; collected_rnb?: number | null; outstanding_rnb?: number | null; orders_inr?: number; orders_rnb?: number };
 floors: AnalyticsFloor[]; trend: AnalyticsTrend[]; companies: AnalyticsEntity[]; products: AnalyticsEntity[]; architects: AnalyticsEntity[]; customers: AnalyticsEntity[];
 attribute_breakdowns?: Record<string, {id:string;name:string;sales:number|null;quantity?:number|null;unit?:string;orders?:number}[]>; customer_segments: { id: string; name: string; customers: number }[];
 coverage: { notes: string[]; missing_dates: number; missing_customer_ids: number; products_available: boolean }; insights: string[];
};
export type AnalyticsWorkflow = {floor_id:string;name:string;unit:string;total:number;active:number|null;completed:number|null;on_hold?:number;overdue?:number;stages:{id:string;name:string;count:number}[];workload?:{id:string|null;name:string;count:number}[]};
export type AnalyticsOwnerOperations = { workflows?: AnalyticsWorkflow[]; generated_at: string; floor_ids: string[]; period_label: string; open_followups: number; overdue_followups: number; completed_followups: number; dismissed_followups: number; unassigned_followups: number; team: {id:string;name:string;open:number;overdue:number;completed:number;contacts:number;calls:number}[]; notes: string[] };
export type AnalyticsPage<T> = { items: T[]; total: number; page: number; page_size: number };
export type AnalyticsTable = { items: Record<string, unknown>[]; total: number; page?: number; page_size?: number };
export type AnalyticsProfile = AnalyticsDashboardData & { identity: { id: string; name: string; kind: string; status?: string; floor_ids: string[]; attributes: { label: string; value: string | number | null }[] }; tables: Record<string, AnalyticsTable> };
export type AnalyticsOrderDetail = AnalyticsOrder & { lines: Record<string, unknown>[]; payments: Record<string, unknown>[]; timeline: Record<string, unknown>[]; documents: Record<string, unknown>[]; summary: { subtotal: number | null; discount: number | null; total: number | null; collected: number | null; outstanding: number | null }; notes: string[] };
export type AnalyticsDuplicateReview = { decision: 'distinct' | 'needs_correction' | 'resolved'; note: string; reviewed_at: string; reviewed_by_name: string; revision: number };
export type AnalyticsDuplicateGroup = { id: string; kind: AnalyticsKind; name: string; entities: { id: string; name: string; floor_id: string; sku?: string | null; status?: string | null }[]; review: AnalyticsDuplicateReview | null };
export function analyticsQuery(filters: AnalyticsFilters) { const query = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value && !(key === 'floor_id' && value === 'all')) query.set(key, value); }); return query.toString(); }
export const salesAnalyticsApi = {
 ownerOperations: (filters: AnalyticsFilters, signal?: AbortSignal) => api.get<AnalyticsOwnerOperations>(`/sales-analytics/owner-operations?${analyticsQuery({floor_id: filters.floor_id})}`, { signal, cacheMs: 0 }),
 duplicates: (filters: AnalyticsFilters, signal?: AbortSignal) => api.get<AnalyticsPage<AnalyticsDuplicateGroup>>(`/sales-analytics/duplicates?${analyticsQuery(filters)}`, { signal, cacheMs: 0 }),
 reviewDuplicates: (filters: AnalyticsFilters, body: {kind:AnalyticsKind;entity_ids:string[];decision:AnalyticsDuplicateReview['decision'];note:string;expected_revision:number}) => api.post<AnalyticsDuplicateReview>(`/sales-analytics/duplicates/review?${analyticsQuery({floor_id:filters.floor_id})}`, body),
 dashboard: (filters: AnalyticsFilters, signal?: AbortSignal) => api.get<AnalyticsDashboardData>(`/sales-analytics/dashboard?${analyticsQuery(filters)}`, { signal, cacheMs: 0 }),
 entities: (kind: AnalyticsKind, filters: AnalyticsFilters, signal?: AbortSignal) => api.get<AnalyticsPage<AnalyticsEntity>>(`/sales-analytics/entities/${kind}?${analyticsQuery(filters)}`, { signal, cacheMs: 0 }),
 profile: (kind: string, id: string, filters: AnalyticsFilters, signal?: AbortSignal) => api.get<AnalyticsProfile>(`/sales-analytics/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}?${analyticsQuery(filters)}`, { signal, cacheMs: 0 }),
 records: (filters: AnalyticsFilters, signal?: AbortSignal) => api.get<AnalyticsPage<AnalyticsOrder>>(`/sales-analytics/records?${analyticsQuery(filters)}`, { signal, cacheMs: 0 }),
 order: (id: string, filters: AnalyticsFilters, signal?: AbortSignal) => api.get<AnalyticsOrderDetail>(`/sales-analytics/orders/${encodeURIComponent(id)}?${analyticsQuery(filters)}`, { signal, cacheMs: 0 }),
};
