import { api } from "@/src/api/client";

export type LeadAssignment = { floor_id: string; user_id: string; user_name?: string };
export type LeadScope = {
  interested_floor_ids: string[];
  assignments: LeadAssignment[];
  reference_source?: string | null;
  referrer_id?: string | null;
};
export type LeadAssignee = { id: string; full_name: string; role: string; floor_ids: string[] };
export function newLeadRequestKey() {
  return `lead:${globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`}`;
}
export const leadsApi = {
  assignees: (floorIds: string[], converted = false, sourceId?: string, customerId?: string, customerPhone?: string, sourceFloorId?: string) => api.get<LeadAssignee[]>(`/followups/assignees?floor_ids=${encodeURIComponent(floorIds.join(","))}&view=${converted ? "quotation" : "walkin"}${sourceId ? `&source_id=${encodeURIComponent(sourceId)}` : customerId ? `&customer_id=${encodeURIComponent(customerId)}` : customerPhone ? `&customer_phone=${encodeURIComponent(customerPhone)}` : ""}`, sourceFloorId ? { floorId: sourceFloorId } : undefined),
  interests: (id: string, body: LeadScope, floorId?: string) => api.put(`/followups/${id}/interests`, body, floorId ? { floorId } : undefined),
};
