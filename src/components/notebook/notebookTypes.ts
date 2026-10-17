export type NotebookStatus = "new" | "pending" | "won" | "lost";
export type NotebookView = "followups" | "quotation";
export type NotebookFilter = "all" | "pending" | "won" | "lost" | "new" | "quotation";
export type NotebookField =
  | "customer_name"
  | "customer_phone"
  | "address"
  | "kitchen_type"
  | "referred_by"
  | "architect_interior_designer"
  | "status"
  | "notes"
  | "quotation_price";

export type NotebookRow = {
  id: string;
  floor_id?: string;
  interested_floor_ids?: string[];
  assignments?: import("@/src/api/leads").LeadAssignment[];
  reference_source?: string | null;
  customer_name: string;
  customer_phone: string;
  address: string;
  kitchen_type: "GI" | "SS" | "";
  referred_by: string;
  referrer_id: string | null;
  referrer_name: string;
  referrer_type: "architect" | "interior_designer" | null;
  architect_interior_designer: string;
  status: NotebookStatus;
  notes: string;
  lost_reason: string;
  is_converted: boolean;
  converted_at: string | null;
  last_contacted_at: string | null;
  contact_attempts: number;
  updated_at: string;
  quotation_price?: number | null;
  quotation_number?: string | null;
};

export type NotebookColumn = {
  key: NotebookField;
  label: string;
  minWidth: number;
  editable: boolean;
  quotationOnly?: boolean;
};

export type CellPosition = { row: number; column: number };
export type CellKey = "Enter" | "Tab" | "Shift+Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
