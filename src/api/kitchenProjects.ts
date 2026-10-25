import { api } from "@/src/api/client";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";

import { KITCHEN_WORKSPACE_PAGES } from "@/src/kitchen-workspace-pages";

export type KitchenStage = typeof KITCHEN_WORKSPACE_PAGES[number]["stage"];
export const KITCHEN_STAGES: readonly KitchenStage[] = KITCHEN_WORKSPACE_PAGES.map(page => page.stage);
export const STAGE_LABELS = Object.fromEntries(KITCHEN_WORKSPACE_PAGES.map(page => [page.stage, page.label])) as Record<KitchenStage, string>;
export type KitchenCustomer = { id: string; name: string; phone?: string | null; address?: string | null; email?: string | null; company?: string | null; property_name?: string | null; city?: string | null; state?: string | null; pincode?: string | null; gstin?: string | null; alternate_phone?: string | null; notes?: string | null; referrer_id?: string | null; referrer_name?: string | null; referrer_type?: "architect" | "interior_designer" | null; referrer_company?: string | null };
export type KitchenAssignee = { id: string; full_name: string; role: string };
export type KitchenLead = {
  referrer_id?: string | null; referrer_name?: string | null; referrer_type?: "architect" | "interior_designer" | null; referrer_company?: string | null;
  status: "New" | "Contacted" | "Qualified" | "Lost";
  site_location?: string | null; lead_source?: string | null;
  kitchen_type?: "New kitchen" | "Renovation" | "Other" | null;
  budget?: string | null; notes?: string | null; lead_date?: string | null;
  lost_reason?: string | null;
};
export type KitchenVisit = {
  status: "Scheduled" | "Visited" | "Follow-up Required";
  visit_date?: string | null; display_model?: string | null; requirements?: string | null;
  budget_discussion?: string | null; notes?: string | null; interested?: boolean | null;
};
export type KitchenCad = {
  received: boolean; progress: number; status: "Not Started" | "In Progress" | "Completed";
  notes?: string | null; ready: boolean;
};
export type KitchenActivity = { id: string; type: string; actor_name?: string; actor_id?: string; at: string; payload?: Record<string, unknown> };
export type KitchenVersion = { requirements?: string | null; budget_discussion?: string | null; id: string; actor_id?: string; at?: string; shared_by?: string; handoff_by?: string; workflow_cycle?: number; number: number; attachment_id?: string | null; url?: string | null; notes?: string | null; presentation_date?: string; received_date?: string; amount?: string; design_version_id?: string; response: "Pending" | "Approved" | "Changes Required" | "Rejected"; shared_date?: string | null; handoff_date?: string | null; response_notes?: string | null };
export type KitchenWork = { status: "Not Started" | "In Production" | "In Progress" | "Completed"; start_date?: string | null; completion_date?: string | null; notes?: string | null };
export type KitchenOrder = { id: string; approval_identity?: string; authorization_invalidated?: boolean; confirmed: boolean; status: "Confirmed" | "On Hold" | "Cancelled"; order_date: string; original_amount: string; final_amount: string; confirmation_document_id?: string | null; notes?: string | null; quotation_version_id: string; advance: { received: boolean; amount: string; date?: string | null }; amendments: { id: string; amount: string; reason: string; date: string; customer_approved: boolean }[] };
export type KitchenAttachment = { id: string; filename: string; size_bytes: number; content_type: string; sha256?: string };
export const KITCHEN_DECISION_CONTRACT = "2026-10-20" as const;
export const KITCHEN_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
export type KitchenPolicy = {
  decision_contract?: string | null; department_manager_user_ids?: string[];
  version: number; identity_timing: "creation" | "conversion" | null; cad_require_received: boolean | null; cad_require_progress_100: boolean | null;
  assignment_user_ids: string[]; unassigned_visibility: "owner" | "all_authorized" | null;
  production: { require_advance: boolean; minimum_advance_amount?: string | null; minimum_advance_percent?: number | null; require_confirmation_document: boolean; require_manager_approval: boolean; manager_user_ids: string[] } | null;
  closure: { require_manager_approval: boolean; manager_user_ids: string[] } | null;
  exceptions: { allow_hold: boolean; allow_cancel: boolean; allow_reopen: boolean; allow_return_to_design: boolean; manager_user_ids: string[] } | null;
  metrics: { hold_is_active: boolean; overdue_date: "next_action" | "target_completion" | "either"; confirmed_value_include_completed: boolean; confirmed_value_include_cancelled: boolean } | null;
  files: { allowed_types: string[]; max_bytes: number; single_request_max_bytes?: number; chunk_bytes?: number } | null; required_fields?: Record<string, string[]> | null; history_corrections?: unknown; unconfigured?: string[];
};
export type KitchenDashboard = { stage_counts?: Record<KitchenStage, number>; workload?: { assignee_id: string | null; assignee_name: string | null; project_count: number }[]; configured: boolean; on_hold_projects?: number | null; next_action_overdue_projects?: number | null; completion_overdue_projects?: number | null; active_order_value?: string | null; active_projects: number | null; pending_approvals: number | null; overdue_projects: number | null; confirmed_order_value: string | null; notice?: string; definitions?: KitchenPolicy["metrics"] };
export type KitchenProject = {
  id: string; reference: string; project_reference?: string | null; customer_id: string; customer: KitchenCustomer;
  version: number; stage: KitchenStage; lead: KitchenLead; visit: KitchenVisit; cad: KitchenCad;
  current_design?: Pick<KitchenVersion, "requirements" | "budget_discussion" | "id" | "number" | "response" | "shared_date" | "handoff_date" | "presentation_date" | "received_date" | "amount" | "design_version_id" | "workflow_cycle"> | null;
  current_quotation?: Pick<KitchenVersion, "id" | "number" | "response" | "shared_date" | "handoff_date" | "presentation_date" | "received_date" | "amount" | "design_version_id" | "workflow_cycle"> | null;
  current_order?: Omit<KitchenOrder, "amendments" | "notes"> | null;
  assignments: Partial<Record<KitchenStage, string | null>>; assigned_to?: string | null; assigned_to_name?: string | null;
  next_action?: string | null; deadline?: string | null; target_completion_date?: string | null;
  design_revision_count: number | null; site_visit_count: number | null; known_design_revision_count?: number; known_site_visit_count?: number;
  lifecycle_status?: "On Hold" | "Cancelled" | null; is_legacy?: boolean; source_reference?: string | null; commercial_basis_invalidated?: boolean; workflow_cycle?: number;
  duplicate_review?: { status: "pending" | "cleared" | "duplicate"; candidate_ids?: string[]; reason?: string; reviewed_by?: string; reviewed_at?: string };
  work_history?: { id?: string; reason?: string; at?: string; from_stage?: KitchenStage; workflow_cycle?: number; production?: KitchenWork; installation?: KitchenWork; completion_date?: string | null }[];
  order_amount?: string | null; final_order_amount?: string | null;
  duplicate_candidates?: { id: string; reference: string; stage: KitchenStage }[];
  permissions?: { can_update: boolean; can_assign: boolean; can_configure: boolean; can_approve_production?: boolean; can_approve_closure?: boolean; can_approve_exceptions?: boolean; can_review_duplicate?: boolean };
  status?: string; completion_date?: string | null; closure_pending_reason?: string | null; design_revision_pending?: boolean;
  design_versions?: KitchenVersion[]; quotation_versions?: KitchenVersion[]; orders?: KitchenOrder[]; production?: KitchenWork; installation?: KitchenWork;
  site_visits?: { id: string; date: string; actual: boolean; notes?: string | null }[]; revision_events?: { id: string; reason: string; version_id: string }[];
  approvals?: { id: string; scope: string; decision: string; subject_id: string; policy_version?: number; actor_id: string; at: string; reason?: string; notes?: string }[];
  attachments?: KitchenAttachment[];
  approval_subjects?: Record<string, string | null>;
  exceptions?: { id: string; action: string; status?: string; reason: string; actor_id: string; at: string }[];
  blocked_transitions?: { target_stage: KitchenStage; reason: string }[];
  activity?: KitchenActivity[]; created_at?: string; updated_at?: string;
};
export type KitchenPage<T> = { rows: T[]; total: number; page: number; limit: number };
export type KitchenQuery = {
  attention?: "active" | "on_hold" | "pending_approval" | "completion_overdue" | "active_order";
  search?: string; stage?: string; status?: string; assignee?: string; date_from?: string; date_to?: string;
  date_field?: string; sort?: string; direction?: "asc" | "desc"; page?: number; limit?: number; completed?: string; duplicate_review?: "pending";
};
export type KitchenFileTransfer = { transfer_id: string; size_bytes: number; chunk_bytes: number; part_count: number; state: "open" | "finishing" | "completed"; expires_at: string };
export type KitchenCreate = { assigned_to?: string | null; customer_id?: string; customer?: Omit<KitchenCustomer, "id"> & { phone: string }; idempotency_key: string; lead: KitchenLead };
export type KitchenCommand = "assign" | "move_stage" | "review_duplicate" | "edit_lead" | "convert" | "save_visit" | "save_cad" | "advance_stage" | "metadata" | "design_present" | "design_update" | "design_share" | "design_response" | "design_revision" | "design_handoff" | "quotation_receive" | "quotation_share" | "quotation_response" | "order_confirm" | "order_update" | "order_document" | "order_advance" | "order_amend" | "order_status" | "exception" | "production_update" | "installation_update" | "site_visit" | "approval";
const options = { floorId: KITCHEN_FLOOR_ID, cacheMs: 0 };
const query = (values: Record<string, string | number | undefined>) => {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== "");
  return entries.length ? `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}` : "";
};
export function kitchenRequestKey() {
  return `kitchen:${globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`}`;
}
export const kitchenProjectsApi = {
  configuration: (signal?: AbortSignal) => api.get<KitchenPolicy>("/kitchen-projects/configuration", { ...options, signal }),
  configure: (body: { decision_contract: typeof KITCHEN_DECISION_CONTRACT; department_manager_user_ids: string[]; expected_version: number }) => api.put<KitchenPolicy>("/kitchen-projects/configuration", body, options),
  dashboard: (signal?: AbortSignal) => api.get<KitchenDashboard>("/kitchen-projects/dashboard", { ...options, signal }),
  upload: (id: string, form: FormData) => api.upload<KitchenProject>(`/kitchen-projects/${encodeURIComponent(id)}/attachments`, form, options),
  ownTransfer: (id: string) => api.get<{ transfer: (KitchenFileTransfer & { project_id: string }) | null }>(`/kitchen-projects/${encodeURIComponent(id)}/file-transfers`, options),
  beginTransfer: (id: string, body: { expected_version: number; idempotency_key: string; filename: string; content_type: string; size_bytes: number; sha256?: string }) => api.post<KitchenFileTransfer>(`/kitchen-projects/${encodeURIComponent(id)}/file-transfers`, body, options),
  uploadPart: (id: string, transfer: string, index: number, data_base64: string) => api.put<{ index: number; sha256: string }>(`/kitchen-projects/${encodeURIComponent(id)}/file-transfers/${encodeURIComponent(transfer)}/parts/${index}`, { data_base64 }, options),
  finishTransfer: (id: string, transfer: string, expected_version: number) => api.post<KitchenProject>(`/kitchen-projects/${encodeURIComponent(id)}/file-transfers/${encodeURIComponent(transfer)}/finish`, { expected_version }, options),
  cancelTransfer: (id: string, transfer: string) => api.delete<{ discarded: boolean }>(`/kitchen-projects/${encodeURIComponent(id)}/file-transfers/${encodeURIComponent(transfer)}`, options),
  downloadPart: (id: string, attachment: string, index: number) => api.get<{ index: number; data_base64: string; sha256: string; file_sha256: string; size_bytes: number }>(`/kitchen-projects/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment)}/parts/${index}`, options),
  attachmentPath: (id: string, attachmentId: string) => `/kitchen-projects/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
  exportPath: (values: Pick<KitchenQuery, "search" | "assignee" | "date_from" | "date_to">) => `/kitchen-projects/export${query(values)}`,
  duplicates: (customerId: string, signal?: AbortSignal) => api.get<{ rows: { id: string; reference: string; stage: KitchenStage }[] }>(`/kitchen-projects/duplicate-candidates?customer_id=${encodeURIComponent(customerId)}`, { ...options, signal }),
  list: (values: KitchenQuery, signal?: AbortSignal) => api.get<KitchenPage<KitchenProject>>(`/kitchen-projects${query(values)}`, { ...options, signal }),
  get: (id: string, signal?: AbortSignal) => api.get<KitchenProject>(`/kitchen-projects/${encodeURIComponent(id)}`, { ...options, signal }),
  create: (body: KitchenCreate) => api.post<KitchenProject>("/kitchen-projects", body, options),
  command: (id: string, expectedVersion: number, key: string, command: KitchenCommand, payload: Record<string, unknown>) =>
    api.post<KitchenProject>(`/kitchen-projects/${encodeURIComponent(id)}/commands`, { expected_version: expectedVersion, idempotency_key: key, command, payload }, options),
  customers: (search: string, page = 1, signal?: AbortSignal) => api.get<KitchenPage<KitchenCustomer>>(`/kitchen-projects/customers${query({ search, page, limit: 20 })}`, { ...options, signal }),
  assignees: (signal?: AbortSignal) => api.get<{ rows: KitchenAssignee[] }>("/kitchen-projects/assignees", { ...options, signal }),
};
