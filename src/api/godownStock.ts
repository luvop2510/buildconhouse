import { api } from "./client";

export type GodownLot = {
  id: string; product_id: string | null; sku: string; name: string; image?: string | null; finish?: string | null;
  size?: string | null; feature?: string | null; category?: string | null;
  brand_id?: string | null; brand_name?: string | null; qty_received: number; available_qty: number;
  source_customer_name?: string | null; source_purchased_at?: string | null;
  transferred_at?: string | null; reason?: string | null;
};
export type GodownStockResponse = { lots: GodownLot[]; brands: { id?: string | null; name: string; lot_count: number; available_qty: number }[]; total_available_qty: number };
export const getGodownStock = (params = "") => api.get<GodownStockResponse>(`/godown-stock${params}`);
export type SkuSuggestion = { id: string; sku: string; name: string; brand_name?: string | null; image?: string | null; size?: string | null; category_id?: string | null };
export const getSkuSuggestions = (prefix: string) => api.get<SkuSuggestion[]>(`/godown-stock/sku-suggestions?prefix=${encodeURIComponent(prefix)}`);
export type DirectIntake = { qty: number; reason?: string; product_id?: string; sku?: string; name?: string; brand?: string; image?: string; size?: string; feature?: string; category?: string };
export const addDirectGodownStock = (body: DirectIntake) => api.post<GodownLot>("/godown-stock/direct-intakes", body);
