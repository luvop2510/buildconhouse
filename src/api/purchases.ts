import { api } from "@/src/api/client";

export type PurchaseStage =
  | "po_final" | "order_in_company" | "company_billing" | "in_box" | "dispatched";

export type PurchaseItem = {
  item_id: string;
  po_id: string;
  po_number: string;
  quotation_id?: string | null;
  quotation_number?: string | null;
  product_id: string;
  sku: string;
  name: string;
  image?: string | null;
  customer_id: string;
  customer_name: string;
  brand_id: string;
  brand_name: string;
  supplier_id?: string | null;
  supplier_name?: string | null;
  stage: PurchaseStage;
  dispatched_at?: string | null;
  delivered_at?: string | null;
  stage_label: string;
  stage_tone: { bg: string; fg: string };
  qty: number;
  unit_cost: number;
  room?: string | null;
  last_moved_at: string;
  last_moved_by_name: string | null;
  age_days: number;
  blocked: boolean;
  sla_days: number;
  godown_transferred_qty?: number;
  godown_transfer_history?: {
    stock_id: string; qty: number; reason?: string; transferred_at?: string;
    transferred_by?: string; transferred_by_name?: string;
  }[];
  godown_stock_id?: string | null;
  godown_allocation_id?: string | null;
  godown_source_customer_name?: string | null;
  godown_source_purchased_at?: string | null;
  godown_transferred_at?: string | null;
  loaned_qty?: number;
  loan_transfer_id?: string | null;
  lent_to_customer_name?: string | null;
  customer_loan_history?: { transfer_id: string; qty: number; destination_customer_id?: string | null; destination_customer_name?: string | null; created_at?: string | null; status?: string | null }[];
  borrowed_from_customer_id?: string | null;
  borrowed_from_customer_name?: string | null;
  borrowed_at?: string | null;
  borrowing_note?: string | null;
  loan_return_status?: "awaiting_return" | "return_due" | "returned" | null;
  loan_return_due?: boolean;
  return_due_on_replenishment?: boolean;
  loan_replenishment_for_customer_name?: string | null;
  loan_replenishment_status?: "awaiting_return" | "returned" | null;
  loan_replenishment_returned_qty?: number;
};

/** Floor-scoped customer record used by the Purchases lifecycle navigator. */
export type PurchaseCustomer = {
  id: string;
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  tier?: "retail" | "trade" | "vip";
};

/** Live purchase workspace used by the inline customer panel. */
export type PurchaseCustomerWorkspace = {
  customer: PurchaseCustomer;
  summary: {
    total_items: number; total_value: number; outstanding_value: number;
    outstanding_count: number; open_pos: number; blocked_count: number;
    delivered_count: number; shortage_count: number; outstanding_balance?: number;
  };
  outstanding_items: PurchaseItem[];
  products: PurchaseItem[];
  expected_delivery?: { next_at: string | null };
};

export type PurchasesPage = {
  items: PurchaseItem[];
  total: number;
  has_more: boolean;
  next_skip: number | null;
  summaries: {
    sla_days: number;
    blocked_count: number;
    stage_counts: Partial<Record<PurchaseStage, number>>;
  };
};

export type PurchasesPageQuery = {
  view: "today" | "stock" | "customers" | "dispatch_record";
  brand?: string;
  customer?: string;
  stage?: PurchaseStage | "";
  q?: string;
  skip?: number;
  limit?: number;
};

export function purchasesPagePath(query: PurchasesPageQuery): string {
  const params = new URLSearchParams({
    view: query.view,
    skip: String(query.skip ?? 0),
    limit: String(query.limit ?? 30),
  });
  if (query.brand && query.brand !== "all") params.set("brand", query.brand);
  if (query.customer) params.set("customer", query.customer);
  if (query.stage) params.set("stage", query.stage);
  if (query.q?.trim()) params.set("q", query.q.trim());
  return `/purchases/items/page?${params.toString()}`;
}

export function getPurchasesPage(query: PurchasesPageQuery, signal?: AbortSignal) {
  return api.get<PurchasesPage>(purchasesPagePath(query), { signal });
}

/** CRM workspaces on this floor, with fully delivered customers moved out. */
export function getPurchaseCustomers(signal?: AbortSignal, includeCompleted = false) {
  return api.get<PurchaseCustomer[]>(`/purchases/customer-workspaces?include_completed=${includeCompleted}`, { signal });
}

export function getPurchaseCustomerWorkspace(customerId: string, signal?: AbortSignal) {
  return api.get<PurchaseCustomerWorkspace>(`/purchases/customers/${customerId}/workspace`, { signal });
}

export function cancelPurchaseItem(itemId: string, reason?: string) {
  return api.post(`/purchases/items/${itemId}/cancel`, reason?.trim() ? { reason: reason.trim() } : {});
}

export function returnPurchaseLoan(transferId: string) {
  return api.post(`/purchases/transfers/${encodeURIComponent(transferId)}/return`, {});
}
