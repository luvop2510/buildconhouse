// Walk-ins — Phase 4 (2026-07-30). Thin typed API client, same shape as
// src/api/tileOrders.ts.
import { api } from "@/src/api/client";

function toQuery(params?: Record<string, any>): string {
  if (!params) return "";
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export type WalkInStatus =
  | "new" | "contacted" | "selection_scheduled" | "selection_completed"
  | "quotation_created" | "converted" | "lost";

export type WalkIn = {
  id: string; number: string; customer_id: string; customer_name: string;
  customer_phone: string | null; alternate_phone: string | null; visited_at: string;
  salesperson_id: string | null; salesperson_name: string | null; source: string;
  reference_contact: string | null; architect: string | null; builder: string | null;
  interested_floor_ids?: string[]; assignments?: import("./leads").LeadAssignment[]; referrer_id?: string | null; referrer_name?: string | null; referrer_type?: "architect" | "interior_designer" | null; reference_source?: string | null;
  floor_id: string; interested_products: string[]; budget: number | null; notes: string | null;
  quotation_price: number | null; showroom_followup_id?: string | null; showroom_transferred_at?: string | null;
  manual_priority_override: "low" | "medium" | "high" | "critical" | null;
  status: WalkInStatus; next_followup_at: string | null; lost_reason: string | null;
  selection_quotation_id: string | null; converted_at: string | null;
  created_at: string; updated_at: string;
};

export type CustomerMatch = {
  id: string; name: string; company?: string | null; phone?: string | null;
  alternate_phone?: string | null; email?: string | null; city?: string | null;
  address?: string | null; tier?: string;
};

export type DuplicateMatches = { high: CustomerMatch[]; medium: CustomerMatch[]; low: CustomerMatch[] };

export type WalkInsDashboard = {
  today_walkins: number; this_week: number; pending_followups: number;
  selections_scheduled: number; converted: number; lost: number;
  conversion_rate: number; avg_conversion_days: number; total: number;
};

export type WalkInsAnalytics = {
  funnel: { walk_ins: number; selections: number; quotations: number; orders: number };
  conversion_rate_pct: number; lost_leads: number; revenue_generated: number; revenue_lost: number;
  salesperson_performance: { salesperson: string; walkins: number; converted: number; lost: number }[];
};

export const walkinsApi = {
  list: (params?: {
    status?: string; priority?: string; salesperson_id?: string; source?: string; floor_id?: string; floor_ids?: string;
    date_from?: string; date_to?: string; search?: string;
  }, options?: { floorId?: string; signal?: AbortSignal }) => api.get<WalkIn[]>(`/walkins${toQuery(params)}`, options),

  get: (id: string, options?: { floorId?: string }) => api.get<WalkIn>(`/walkins/${id}`, options),

  create: (body: {
    customer_name: string; customer_phone: string; alternate_phone?: string; email?: string;
    address?: string; city?: string; state?: string; pincode?: string;
    visited_at?: string; salesperson_id?: string; source: string;
    reference_contact?: string; architect?: string; builder?: string;
    floor_id: string;
    interested_floor_ids?: string[]; assignments?: import("./leads").LeadAssignment[]; referrer_id?: string | null; reference_source?: string | null;
    interested_products?: string[]; budget?: number; notes?: string;
    priority?: "low" | "medium" | "high" | "critical"; next_followup_at?: string;
    use_existing_customer_id?: string; force_new_customer?: boolean;
  }) => api.post<WalkIn>("/walkins", body, { floorId: body.floor_id }),

  update: (id: string, body: Partial<{
    status: WalkInStatus; salesperson_id: string; notes: string;
    manual_priority_override: "low" | "medium" | "high" | "critical";
    next_followup_at: string; lost_reason: string; alternate_phone: string;
    budget: number; interested_products: string[];
    quotation_price: number | null;
    reference_contact: string; architect: string; builder: string;
    interested_floor_ids: string[]; assignments: import("./leads").LeadAssignment[]; referrer_id: string | null; reference_source: string | null;
  }>, options?: { floorId?: string }) => api.patch<WalkIn>(`/walkins/${id}`, body, options),

  visitShowroom: (id: string, options?: { floorId?: string }) =>
    api.post<{ walkin_id: string; followup_id: string }>(`/walkins/${id}/visit-showroom`, undefined, options),

  reassign: (id: string, salesperson_id: string, options?: { floorId?: string }) =>
    api.patch<WalkIn>(`/walkins/${id}/reassign`, { salesperson_id }, options),

  contact: (id: string, channel: "whatsapp" | "email", options?: { floorId?: string }) =>
    api.post<{ channel: string; message?: string; wa_url?: string; subject?: string; body?: string; mailto_url?: string }>(
      `/walkins/${id}/contact?channel=${channel}`, undefined, options,
    ),

  timeline: (id: string, options?: { floorId?: string }) => api.get<Record<string, any>[]>(`/walkins/${id}/timeline`, options),

  checkDuplicate: (params: { phone?: string; alternatePhone?: string; email?: string; name?: string; city?: string; address?: string; floorId?: string }) =>
    api.get<DuplicateMatches>(`/walkins/check-duplicate${toQuery({
      phone: params.phone, alternate_phone: params.alternatePhone, email: params.email,
      name: params.name, city: params.city, address: params.address,
    })}`, params.floorId ? { floorId: params.floorId } : undefined),

  dashboard: (options?: { floorId?: string; signal?: AbortSignal }, floorIds?: string) => api.get<WalkInsDashboard>(`/walkins/dashboard${toQuery({ floor_ids: floorIds })}`, options),
  analytics: () => api.get<WalkInsAnalytics>("/walkins/analytics"),

  listSources: () => api.get<{ sources: string[] }>("/walkins/config/sources"),
  updateSources: (sources: string[]) => api.put<{ sources: string[] }>("/walkins/config/sources", { sources }),

  listAssignees: (options?: { floorId?: string }) => api.get<{ id: string; full_name: string; role: string }[]>("/walkins/config/assignees", options),
};

// Best-effort parse of ApiError.detail — the client stringifies non-string
// `detail` payloads to JSON (see src/api/client.ts), so a 409 duplicate
// response's `{message, matches}` object arrives here as a JSON string.
export function parseDuplicateConflict(detail: string | undefined): { message: string; matches: DuplicateMatches } | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail);
    if (parsed && parsed.matches) return parsed;
  } catch {
    // not a JSON payload — a plain string error, not a duplicate conflict
  }
  return null;
}
