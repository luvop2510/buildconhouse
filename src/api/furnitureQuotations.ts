import { api } from "@/src/api/client";
import { FURNITURE_FLOOR_ID } from "@/src/constants/floors";

export type FurnitureCharge = { id?: string; description: string; amount_rmb: string; created_at?: string; updated_at?: string };
export type FurnitureDeposit = { id?: string; description: string; currency: "INR" | "USD" | "RMB"; amount: string; rate: string; amount_rmb?: string; created_at?: string; updated_at?: string };
export type FurnitureDraft = { customer_id?: string | null; referrer_id?: string | null; referrer_name?: string | null; referrer_type?: "architect" | "interior_designer" | null; referrer_company?: string | null; referrer_customers_acquired?: number | null; customer_name: string; customer_phone: string; charges: FurnitureCharge[]; deposits: FurnitureDeposit[]; status: "draft" | "final" };
export type FurnitureQuotation = FurnitureDraft & { id: string; floor_id: string; created_at: string; updated_at: string; revision: number; total_payable_rmb: string; total_received_rmb: string; balance_rmb: string };
export type FurnitureSummary = Omit<FurnitureQuotation, "charges" | "deposits">;
export type WhatsAppReceipt = { status: string; message_id?: string; updated_at?: string; error_code?: string; idempotency_key?: string };
const options = { floorId: FURNITURE_FLOOR_ID };
const payload = (body: FurnitureDraft) => ({
  ...(body.customer_id !== undefined ? { customer_id: body.customer_id } : {}),
  customer_name: body.customer_name, customer_phone: body.customer_phone, status: body.status,
  referrer_id: body.referrer_id ?? null,
  charges: body.charges.map(({ id, description, amount_rmb }) => ({ ...(id ? { id } : {}), description, amount_rmb })),
  deposits: body.deposits.map(({ id, description, currency, amount, rate }) => ({ ...(id ? { id } : {}), description, currency, amount, rate })),
});
export const furnitureQuotationsApi = {
  list: (cursor?: string) => api.get<{ rows: FurnitureSummary[]; next_cursor: string | null }>(`/furniture-quotations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, options),
  get: (id: string) => api.get<FurnitureQuotation>(`/furniture-quotations/${encodeURIComponent(id)}`, options),
  create: (body: FurnitureDraft) => api.post<FurnitureQuotation>("/furniture-quotations", payload(body), options),
  save: (id: string, body: FurnitureDraft, updatedAt: string) => api.put<FurnitureQuotation>(`/furniture-quotations/${encodeURIComponent(id)}`, { ...payload(body), expected_updated_at: updatedAt }, options),
  configuration: () => api.get<{ configured: boolean; template_configured: boolean }>("/whatsapp/configuration", options),
  receipt: (id: string, key: string) => api.get<WhatsAppReceipt>(`/whatsapp/deliveries/${encodeURIComponent(id)}/${encodeURIComponent(key)}`, options),
  send: (doc: FurnitureQuotation, message: string, idempotencyKey: string) => api.post<WhatsAppReceipt>(`/furniture-quotations/${encodeURIComponent(doc.id)}/whatsapp-send`, { message, expected_updated_at: doc.updated_at, idempotency_key: idempotencyKey }, options),
};
