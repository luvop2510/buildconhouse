// frontend/src/api/tileOrders.ts
// Typed client for the /tile-orders backend router (see
// backend/routes/tile_orders.py). Mirrors the thin api.get/post pattern
// already used throughout the app (@/src/api/client) — no separate fetch
// layer, just typed wrappers around it.
//
// Tile Orders workflow redesign (2026-08): the UI is organised around
// Brands, Customers and Material Movement — NOT Purchase Orders/Company.
// The Brand page's only action is Release Material. The Customer page
// decides Move to Godown vs. Dispatch (from Released or from Godown) and
// is the only place a Chalan/PDF is ever generated. Boxes are the one
// operational unit everywhere — the underlying `qty`/`boxes_*` field names
// are unchanged for backend compatibility, this file just labels them.
import { api } from "@/src/api/client";
import { TILES_FLOOR_ID } from "@/src/constants/floors";

export type TileOverallStatus = "Pending" | "Ready" | "Partially Dispatched" | "Dispatched" | "Delivered";
export type TileLocation = "Pending" | "Ready" | "Dispatched" | "Godown" | "Delivered";
export type AgeingBand = "green" | "amber" | "red";
export type PageMeta = { page: number; page_size: number; total: number; has_more: boolean; next_page: number | null };
export type IdNameRef = { id: string; name: string };

export type CustomerOrderBrand = { brand_id: string | null; brand_name: string; supplier_id: string | null; supplier_name: string; purchase_order_id: string; status: TileOverallStatus };

export type CustomerOrderCard = {
  id: string; number: string; customer_name: string; customer_phone: string | null;
  order_date: string; waiting_days: number; ageing_band: AgeingBand;
  brands: CustomerOrderBrand[]; total_products: number; total_boxes: number; total_value: number;
  overall_status: TileOverallStatus; completion_percentage: number;
};

export type CustomerOrderItem = {
  product_id?: string | null; image?: string | null;
  po_item_id: string; tile_name: string; series: string | null; finish: string | null; size: string | null;
  sku: string | null;
  boxes_ordered: number; boxes_ready: number; boxes_godown: number; boxes_dispatched: number; boxes_pending: number; quantity_unit: "Box" | "Pieces";
  current_location: TileLocation; overall_status: TileOverallStatus;
};

export type CustomerOrderBrandGroup = {
  purchase_order_id: string; supplier_name: string; brand_id: string | null; brand_name: string;
  overall_status: TileOverallStatus; items: CustomerOrderItem[];
};

export type CustomerOrderDetail = {
  summary: {
    id: string; number: string; customer_name: string; order_date: string; brand_count: number;
    total_products: number; total_boxes: number; completion_percentage: number;
    waiting_days: number; ageing_band: AgeingBand; overall_status: TileOverallStatus;
  };
  // Backend response key stays "suppliers" for wire-compat, but every group
  // now also carries brand_id/brand_name — the Customer Detail screen
  // groups and labels by BRAND, never by dealer/supplier company.
  suppliers: CustomerOrderBrandGroup[];
};

export type BrandLandingCard = { brand_id: string | null; brand_name: string; active_orders: number; max_supplier_silent_days: number };

export type BrandOrderRow = {
  po_id: string; po_number: string; customer_id: string; customer_name: string; order_date: string;
  arrival_date: string; waiting_days: number; ageing_band: AgeingBand; total_products: number; total_boxes: number;
  boxes_released: number; boxes_remaining: number; overall_status: TileOverallStatus; completion_percentage: number;
};

export type BrandOrdersKpi = {
  orders: number; pending: number; ready: number; partially_dispatched: number; completed: number;
  boxes_remaining: number; boxes_released: number; boxes_dispatched: number; oldest_pending_days: number;
};

export type PurchaseOrderItemDetail = {
  product_id?: string | null; image?: string | null;
  id: string; name: string; series: string | null; finish: string | null; size: string | null; sku: string | null;
  qty: number; boxes_ready: number; boxes_godown: number; boxes_dispatched: number; boxes_pending: number; quantity_unit: "Box" | "Pieces";
  current_location: TileLocation; overall_status: TileOverallStatus;
};

export type PurchaseOrderDetail = {
  id: string; number: string; customer_name: string; supplier_name: string | null;
  brand_id: string | null; brand_name: string | null;
  overall_status: TileOverallStatus; items: PurchaseOrderItemDetail[];
  delivery_name: string; delivery_phone: string; delivery_address: string; delivery_city: string;
};

export type MaterialMovementType =
  | "order_created" | "release" | "move_to_godown"
  | "dispatch_from_released" | "dispatch_from_godown" | "delivered";

export type MaterialMovementRow = {
  id: string; movement_type: MaterialMovementType; created_at: string;
  purchase_order_id: string; po_item_id: string | null; customer_order_id: string | null;
  customer_id: string | null; customer_name: string;
  brand_id: string | null; brand_name: string; tile_name: string; series: string | null; finish: string | null;
  size: string | null; sku: string | null; boxes: number; quantity_unit: "Box" | "Pieces"; source: string | null; destination: string | null;
  dispatch_id: string | null; dispatch_number: string | null; chalan_id: string | null; chalan_number: string | null;
  performed_by_name: string;
};

export type DispatchListRow = {
  dispatch_id: string; dispatch_number: string; dispatch_date: string;
  customer_id: string | null; customer_name: string; customer_order_id: string | null;
  brand_id: string | null; brand_name: string;
  tile_name: string; tile_size: string | null; sku: string | null; boxes: number; quantity_unit: "Box" | "Pieces";
  source: "Released" | "Godown";
  chalan_id: string; chalan_number: string;
  vehicle_number: string | null; driver_name: string | null;
  status: "Dispatched" | "At Godown" | "Delivered";
  performed_by_name: string;
};

export type TileOrdersDashboard = {
  customer_orders: number; supplier_orders: number; dispatched_today: number; delivered_today: number;
  pending: number; ready: number; waiting_over_15_days: number; boxes_ordered: number; boxes_pending: number; revenue: number;
};
export type CompletedTileOrder = {
  id: string; customer_id: string | null; customer: string; order_number: string; delivery_date: string; completion_date: string;
  brands: string[]; brand_refs: { id: string | null; name: string }[]; products: { product: string; sku: string | null; size: string | null; quantity: number; boxes: number; pieces: number | null; quantity_unit: "Box" | "Pieces" }[];
  final_amount: number; delivery_status: "Dispatched" | "Delivered"; delivery_notes: string | null;
  timeline: Record<string, any>[]; chalan_references: { id: string; number: string }[]; dispatch_references: { id: string; number: string }[];
};
export type GodownInventoryRow = {
  id: string; customer: string; name: string; brand: string; product: string | null; size: string | null; arrival_date: string;
};

export type MovementItemInput = { po_item_id: string; qty: number };
export type DispatchDestinationOverride = {
  destination_name?: string; destination_address?: string; destination_city?: string;
  reference_number?: string; receiver_name?: string; sender_name?: string;
  vehicle_number?: string; driver_name?: string;
  labor_cost?: number;
};

export type ChalanItem = {
  po_item_id: string; tile_name: string; series: string | null; finish: string | null;
  size: string | null; sku: string | null; boxes: number; pieces_per_box: string | null; quantity_unit: "Box" | "Pieces"; quantity: number;
};

export type ChalanDetail = {
  id: string; number: string; generated_at: string; generated_by_name: string;
  delivery_address: string; delivery_city: string; reference_number: string | null;
  receiver_name: string | null; sender_name: string | null;
  vehicle_number: string | null; driver_name: string | null;
  supplier_name: string; customer_name: string; customer_phone: string | null;
  labor_cost: number;
  items: ChalanItem[];
};

export type DispatchDetail = {
  dispatch: {
    id: string; dispatch_number: string; dispatch_date: string; dispatch_time: string;
    source: "released" | "godown"; destination_type: "Customer" | "Godown";
    destination_name: string; destination_address: string; destination_city: string;
    customer_id: string | null; customer_name: string; customer_order_id: string | null;
    purchase_order_id: string; supplier_name: string; created_by_name: string;
    labor_cost: number;
    godown_received_at: string | null; godown_received_by_name: string | null;
    delivered_at: string | null; delivered_by_name: string | null;
    status: "Dispatched" | "At Godown" | "Delivered";
  };
  chalan: ChalanDetail;
  brand: { id: string | null; name: string | null };
  purchase_order: { id: string | null; number: string | null };
};

export type DispatchTransportInput = {
  vehicle_number?: string; driver_name?: string;
  receiver_name?: string; sender_name?: string; reference_number?: string;
};

// Every Tiles request is explicitly Ground Floor. Falling back to the
// global floor switcher (src/api/client.ts) was the leak: an all-floors
// owner on the "All floors" view sends no X-Floor-Id at all, and a sticky
// selection can point at The Sanitary Bathroom — both made Tile Orders
// screens show another floor's orders. The backend enforces this floor
// independently (auth.tiles_floor_query); this is the matching client half.
const GROUND_FLOOR = { floorId: TILES_FLOOR_ID } as const;

export const tileOrdersApi = {
  // ---- Customer tab ----
  listCustomerOrders: (params?: { page?: number; page_size?: number; sort?: string; status?: string; search?: string; customer_id?: string }, signal?: AbortSignal) =>
    api.get<{ orders: CustomerOrderCard[] } & PageMeta>(
      `/tile-orders/customer-orders${toQuery(params)}`, { ...GROUND_FLOOR, signal },
    ),
  customerOrderDetail: (id: string) => api.get<CustomerOrderDetail>(`/tile-orders/customer-orders/${id}`, GROUND_FLOOR),
  customerOrderTimeline: (id: string) => api.get<{ events: Record<string, any>[] }>(`/tile-orders/customer-orders/${id}/timeline`, GROUND_FLOOR),

  // ---- Brands tab ----
  listBrands: (params?: { page?: number; page_size?: number; search?: string }, signal?: AbortSignal) =>
    api.get<{ brands: BrandLandingCard[] } & PageMeta>(`/tile-orders/brands${toQuery(params)}`, { ...GROUND_FLOOR, signal }),
  brandOrders: (brandId: string, params?: { page?: number; page_size?: number; sort?: string; status?: string; search?: string }, signal?: AbortSignal) =>
    api.get<{ kpi: BrandOrdersKpi; orders: BrandOrderRow[] } & PageMeta>(
      `/tile-orders/brands/${brandId}/orders${toQuery(params)}`, { ...GROUND_FLOOR, signal },
    ),
  purchaseOrderDetail: (poId: string) => api.get<PurchaseOrderDetail>(`/tile-orders/purchase-orders/${poId}`, GROUND_FLOOR),

  // ---- Brand page's ONLY action ----
  releaseMaterial: (poId: string, items: MovementItemInput[]) =>
    api.post<{ po_id: string; ready_batches: Record<string, any>[]; overall_status: TileOverallStatus }>(
      `/tile-orders/purchase-orders/${poId}/ready`, { items }, GROUND_FLOOR,
    ),

  // ---- Customer page actions (BuildCon decides Godown vs. Dispatch) ----
  moveToGodown: (poId: string, items: MovementItemInput[]) =>
    api.post<{ po_id: string; moved: Record<string, any>[] }>(
      `/tile-orders/purchase-orders/${poId}/items/move-to-godown`, { items }, GROUND_FLOOR,
    ),
  dispatchFromReleased: (poId: string, items: MovementItemInput[], destination?: DispatchDestinationOverride) =>
    api.post<{ po_id: string; dispatch: Record<string, any>; chalan: { id: string; [key: string]: any }; overall_status: TileOverallStatus }>(
      `/tile-orders/purchase-orders/${poId}/dispatch-from-released`, { items, ...destination }, GROUND_FLOOR,
    ),
  dispatchFromGodown: (poId: string, items: MovementItemInput[], destination?: DispatchDestinationOverride) =>
    api.post<{ po_id: string; dispatch: Record<string, any>; chalan: { id: string; [key: string]: any }; overall_status: TileOverallStatus }>(
      `/tile-orders/purchase-orders/${poId}/dispatch-from-godown`, { items, ...destination }, GROUND_FLOOR,
    ),
  chalanPdfUrl: (chalanId: string) => api.authenticatedUrl(`/tile-orders/chalans/${chalanId}/pdf`),
  chalanDetail: (chalanId: string) => api.get<ChalanDetail>(`/tile-orders/chalans/${chalanId}`, GROUND_FLOOR),

  // ---- Dispatch record: open / edit / close out ----
  dispatchDetail: (dispatchId: string) => api.get<DispatchDetail>(`/tile-orders/dispatches/${dispatchId}`, GROUND_FLOOR),
  updateDispatchTransport: (dispatchId: string, body: DispatchTransportInput) =>
    api.patch<Record<string, any>>(`/tile-orders/dispatches/${dispatchId}/transport`, body, GROUND_FLOOR),
  markGodownReceived: (dispatchId: string, note?: string) =>
    api.post<{ dispatch_id: string; godown_received_at: string }>(
      `/tile-orders/dispatches/${dispatchId}/godown-received`, { note }, GROUND_FLOOR,
    ),
  markDelivered: (dispatchId: string, body: { received_by?: string; note?: string }) =>
    api.post<{ dispatch_id: string; delivered_at: string; overall_status: TileOverallStatus | null }>(
      `/tile-orders/dispatches/${dispatchId}/delivered`, body, GROUND_FLOOR,
    ),

  // ---- Material Movement Register ----
  listMovements: (params?: {
    customer_id?: string; brand_id?: string; movement_type?: string; date_from?: string; date_to?: string;
    chalan_number?: string; dispatch_number?: string; search?: string; page?: number; page_size?: number;
  }, signal?: AbortSignal) => api.get<{ rows: MaterialMovementRow[] } & PageMeta>(
    `/tile-orders/movements${toQuery(params)}`, { ...GROUND_FLOOR, signal },
  ),
  listHistory: (params?: { search?: string; customer_id?: string; brand_id?: string; date_from?: string; date_to?: string; page?: number; page_size?: number }, signal?: AbortSignal) =>
    api.get<{ rows: CompletedTileOrder[]; facets: { customers: IdNameRef[]; brands: IdNameRef[] } } & PageMeta>(`/tile-orders/history${toQuery(params)}`, { ...GROUND_FLOOR, signal }),
  listInventory: (params?: { search?: string; page?: number; page_size?: number }, signal?: AbortSignal) =>
    api.get<{ rows: GodownInventoryRow[] } & PageMeta>(`/tile-orders/inventory${toQuery(params)}`, { ...GROUND_FLOOR, signal }),

  itemHistory: (itemId: string) => api.get<{ item_id: string; events: Record<string, any>[] }>(`/tile-orders/items/${itemId}/history`, GROUND_FLOOR),
  dashboard: () => api.get<TileOrdersDashboard>("/tile-orders/dashboard", GROUND_FLOOR),

  // ---- Dispatch List (operational, dispatch-only) ----
  listDispatchList: (params?: {
    customer_id?: string; brand_id?: string; product?: string; dispatch_number?: string;
    chalan_number?: string; status?: string; date_from?: string; date_to?: string;
    search?: string; page?: number; page_size?: number;
  }, signal?: AbortSignal) => api.get<{ rows: DispatchListRow[] } & PageMeta>(
    `/tile-orders/dispatches${toQuery(params)}`, { ...GROUND_FLOOR, signal },
  ),
};

function toQuery(params?: Record<string, string | number | undefined>): string {
  if (!params) return "";
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}
