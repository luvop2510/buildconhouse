import { api } from "./client";

export type GodownLot = {
  id: string; product_id: string | null; sku: string; name: string; image?: string | null; finish?: string | null;
  size?: string | null; feature?: string | null; category?: string | null;
  brand_id?: string | null; brand_name?: string | null; qty_received: number; available_qty: number;
  source_customer_name?: string | null; source_purchased_at?: string | null;
  transferred_at?: string | null; reason?: string | null;
  transferred_by_name?: string | null; source_type?: string | null; created_at?: string | null;
  source_purchase_order_id?: string | null; source_quotation_id?: string | null;
  unit_price?: number | null; stock_value?: number | null; price_variants?: { label: string; price: number }[];
  allocations?: { id: string; quotation_id?: string | null; quotation_number?: string | null; customer_name?: string | null; qty: number; allocated_at: string; allocated_by_name?: string | null }[];
};
export type GodownStockResponse = { lots: GodownLot[]; brands: { id?: string | null; name: string; lot_count: number; available_qty: number }[]; total_available_qty: number; total_stock_value: number; unpriced_lot_count: number };
export const getGodownStock = (params = "") => api.get<GodownStockResponse>(`/godown-stock${params}`);
export type SkuSuggestion = { id: string; sku: string; name: string; brand_name?: string | null; image?: string | null; size?: string | null; category_id?: string | null };
export const getSkuSuggestions = (prefix: string) => api.get<SkuSuggestion[]>(`/godown-stock/sku-suggestions?prefix=${encodeURIComponent(prefix)}`);
export type DirectIntake = { qty: number; reason?: string; product_id?: string; sku?: string; name?: string; brand?: string; image?: string; size?: string; feature?: string; category?: string; unit_price?: number; price_variants?: { label: string; price: number }[] };
export const addDirectGodownStock = (body: DirectIntake) => api.post<GodownLot>("/godown-stock/direct-intakes", body);
