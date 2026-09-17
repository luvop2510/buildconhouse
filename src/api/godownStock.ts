import { api } from "./client";

export type GodownLot = {
  id: string; product_id: string; sku: string; name: string; image?: string | null; finish?: string | null;
  brand_id?: string | null; brand_name?: string | null; qty_received: number; available_qty: number;
  source_customer_name?: string | null; source_purchased_at?: string | null;
  transferred_at?: string | null; reason?: string | null;
};
export type GodownStockResponse = { lots: GodownLot[]; brands: { id?: string | null; name: string; lot_count: number; available_qty: number }[]; total_available_qty: number };
export const getGodownStock = (params = "") => api.get<GodownStockResponse>(`/godown-stock${params}`);
