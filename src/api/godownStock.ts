import { api } from "./client";

export type GodownLot = {
  id: string; product_id: string | null; sku: string; name: string; image?: string | null; finish?: string | null;
  size?: string | null; feature?: string | null; category?: string | null;
  brand_id?: string | null; brand_name?: string | null; qty_received: number; available_qty: number;
  loaned_out_qty?: number; transferable_qty?: number;
  source_customer_id?: string | null; source_customer_name?: string | null; source_purchased_at?: string | null;
  transferred_at?: string | null; reason?: string | null;
  transferred_by_name?: string | null; source_type?: string | null; created_at?: string | null;
  source_purchase_order_id?: string | null; source_quotation_id?: string | null;
  mrp?: number | null; unit_price?: number | null; stock_value?: number | null; price_variants?: { label: string; price: number }[];
  allocations?: { id: string; quotation_id?: string | null; quotation_number?: string | null; customer_name?: string | null; qty: number; allocated_at: string; allocated_by_name?: string | null }[];
  customer_transfers?: CustomerStockTransfer[];
};
export type CustomerStockTransfer = {
  id: string; stock_id: string; product_id?: string | null; sku: string; name: string; qty: number;
  source_customer_id?: string | null; source_customer_name?: string | null;
  recipient_customer_id: string; recipient_customer_name: string;
  recipient_purchase_item_id?: string | null; recipient_inbox_stage: "in_box";
  transfer_type?: "godown_stock"; status: "completed" | "awaiting_return" | "returned"; return_due?: boolean;
  unit_price?: number; mrp?: number; discount_pct?: number; net_unit_price?: number; total?: number;
  recipient_purchase_order_id?: string | null; replacement_item_id?: string | null;
  created_at: string; returned_at?: string | null; reason?: string | null;
};
export type PoFinalMatch = {
  purchase_item_id: string; purchase_order_id: string; customer_id: string;
  customer_name: string; ordered_qty: number; remaining_qty: number;
  product_id?: string | null; name: string; sku: string;
};
export type GodownStockResponse = { lots: GodownLot[]; brands: { id?: string | null; name: string; lot_count: number; available_qty: number }[]; total_available_qty: number; total_stock_value: number; unpriced_lot_count: number };
export const getGodownStock = (params = "") => api.get<GodownStockResponse>(`/godown-stock${params}`);
export type SkuSuggestion = { id: string; sku: string; name: string; brand_name?: string | null; image?: string | null; size?: string | null; category_id?: string | null };
export const getSkuSuggestions = (prefix: string) => api.get<SkuSuggestion[]>(`/godown-stock/sku-suggestions?prefix=${encodeURIComponent(prefix)}`);
export type DirectIntake = { qty: number; reason?: string; product_id?: string; sku?: string; name?: string; brand?: string; image?: string; size?: string; feature?: string; category?: string; unit_price?: number; price_variants?: { label: string; price: number }[] };
export const addDirectGodownStock = (body: DirectIntake) => api.post<GodownLot>("/godown-stock/direct-intakes", body);
export const getPoFinalMatches = (stockId: string) => api.get<{ matches: PoFinalMatch[]; total_ordered_qty: number; transferable_qty: number }>(`/godown-stock/${encodeURIComponent(stockId)}/po-final-matches`);
export const getCustomerStockTransfers = (customerId: string) => api.get<{ transfers: CustomerStockTransfer[] }>(`/godown-stock/customer-transfers?customer_id=${encodeURIComponent(customerId)}`);
export const returnCustomerStockTransfer = (transferId: string) => api.post<CustomerStockTransfer>(`/godown-stock/customer-transfers/${encodeURIComponent(transferId)}/return`, {});
export type CustomerTransferInput = {
  qty: number; recipient_customer_id?: string; new_customer?: { name: string; phone?: string; email?: string };
  recipient_purchase_item_id?: string; reason?: string; idempotency_key: string;
  unit_price?: number; discount_pct?: number;
};
export const transferGodownStockToCustomer = (stockId: string, body: CustomerTransferInput) =>
  api.post<CustomerStockTransfer>(`/godown-stock/${encodeURIComponent(stockId)}/customer-transfers`, body);
export const updateGodownPricing = (id: string, body: { unit_price: number; price_variants: { label: string; price: number }[] }) => api.patch<GodownLot>(`/godown-stock/${encodeURIComponent(id)}/pricing`, body);
