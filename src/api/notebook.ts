import { api } from "@/src/api/client";
import type { NotebookField, NotebookRow, NotebookView } from "@/src/components/notebook/notebookTypes";

export type NotebookList = { rows: NotebookRow[]; next_cursor: string | null };

export type NotebookCreate = {
  customer_name: string;
  customer_phone: string;
  address?: string;
  kitchen_type?: "GI" | "SS";
  referred_by?: string;
  referrer_id?: string | null;
  architect_interior_designer?: string;
  notes?: string;
  interested_floor_ids?: string[];
  assignments?: import("./leads").LeadAssignment[];
  reference_source?: string | null;
};

const query = (values: Record<string, string | undefined>) => {
  const parts = Object.entries(values).filter(([, value]) => value).map(([key, value]) => `${key}=${encodeURIComponent(value!)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

export const notebookApi = {
  list: (floorId: string, values: { view: NotebookView; status?: string; q?: string; cursor?: string }) =>
    api.get<NotebookList>(`/followups/notebook/${floorId}${query(values)}`, { floorId }),
  create: (floorId: string, body: NotebookCreate) =>
    api.post<NotebookRow>(`/followups/notebook/${floorId}`, body, { floorId }),
  patch: (floorId: string, rowId: string, field: NotebookField, value: unknown, updatedAt: string, notes?: string) =>
    api.patch<NotebookRow>(`/followups/notebook/${floorId}/${rowId}`, { field, value, updated_at: updatedAt, notes }, { floorId }),
  convert: (floorId: string, rowId: string, body: Pick<NotebookRow, "quotation_price">, updatedAt: string) =>
    api.post<NotebookRow>(`/followups/notebook/${floorId}/${rowId}/convert`, { ...body, updated_at: updatedAt }, { floorId }),
  outcome: (floorId: string, rowId: string, outcome: "lost", updatedAt: string, notes: string, lostReason?: string) =>
    api.post<NotebookRow>(`/followups/notebook/${floorId}/${rowId}/outcome`, { outcome, updated_at: updatedAt, notes, lost_reason: lostReason }, { floorId }),
  assignReferrer: (floorId: string, rowId: string, referrerId: string | null, updatedAt: string) =>
    api.put<NotebookRow>(`/followups/notebook/${floorId}/${rowId}/referrer`, { referrer_id: referrerId, updated_at: updatedAt }, { floorId }),
  contact: (floorId: string, rowId: string, channel: "call" | "whatsapp") =>
    api.post<{ phone?: string | null; wa_url?: string | null }>(`/followups/${rowId}/contact`, { channel }, { floorId }),
};
