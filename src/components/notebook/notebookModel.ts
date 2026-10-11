import type { CellKey, CellPosition, NotebookColumn, NotebookField, NotebookFilter, NotebookRow, NotebookView } from "./notebookTypes";

const KITCHEN_FLOOR_ID = "second-floor";

export const NOTEBOOK_COLUMNS: readonly NotebookColumn[] = [
  { key: "customer_name", label: "Customer Name", minWidth: 190, editable: true },
  { key: "customer_phone", label: "Mobile Number", minWidth: 145, editable: true },
  { key: "address", label: "Address", minWidth: 220, editable: true },
  { key: "kitchen_type", label: "Kitchen Type", minWidth: 125, editable: true },
  { key: "referred_by", label: "Referred By", minWidth: 155, editable: true },
  { key: "architect_interior_designer", label: "Architect / Interior Designer", minWidth: 220, editable: true },
  { key: "status", label: "Status", minWidth: 110, editable: true },
  { key: "notes", label: "Notes", minWidth: 260, editable: true },
];

export const QUOTATION_COLUMNS: readonly NotebookColumn[] = [
  { key: "quotation_price", label: "Quotation Price", minWidth: 155, editable: true, quotationOnly: true },
];

/** Filters that apply to the Follow-ups page. Quotation follow-ups are a
 * separate workspace, not a filter on this page. */
export const FOLLOWUP_FILTERS: readonly Exclude<NotebookFilter, "quotation">[] = ["all", "pending", "won", "lost", "new"];

/** @deprecated Use FOLLOWUP_FILTERS. Kept to avoid breaking existing imports. */
export const NOTEBOOK_FILTERS: readonly NotebookFilter[] = [...FOLLOWUP_FILTERS, "quotation"];

export function columnsForView(view: NotebookView, floorId: string = KITCHEN_FLOOR_ID): readonly NotebookColumn[] {
  const followupColumns = floorId === KITCHEN_FLOOR_ID
    ? NOTEBOOK_COLUMNS
    : NOTEBOOK_COLUMNS.filter((column) => column.key !== "kitchen_type");
  return view === "quotation" ? [...followupColumns, ...QUOTATION_COLUMNS] : followupColumns;
}

const SEARCH_FIELDS: readonly NotebookField[] = [
  "customer_name", "customer_phone", "address", "architect_interior_designer", "referred_by", "notes",
];

export function searchNotebookRows(rows: readonly NotebookRow[], query: string): NotebookRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => SEARCH_FIELDS.some((field) => String(row[field] ?? "").toLocaleLowerCase().includes(needle)));
}

export function nextCell(position: CellPosition, key: CellKey, rowCount: number, columnCount: number): CellPosition | null {
  if (key === "Enter") return position;
  if (key === "Escape") return null;
  let row = position.row;
  let column = position.column;
  if (key === "Tab") column += 1;
  if (key === "Shift+Tab") column -= 1;
  if (key === "ArrowDown") row += 1;
  if (key === "ArrowUp") row -= 1;
  if (key === "ArrowRight") column += 1;
  if (key === "ArrowLeft") column -= 1;
  if (column >= columnCount) { column = 0; row += 1; }
  if (column < 0) { column = columnCount - 1; row -= 1; }
  if (row < 0 || row >= rowCount) return null;
  return { row, column };
}

export function applyCellPatch(row: NotebookRow, field: NotebookField, value: unknown): NotebookRow {
  return { ...row, [field]: value } as NotebookRow;
}

/** Preserve the meaning of entered prices; never turn negatives or text into money. */
export function parseQuotationPrice(input: string): number | null {
  const normalized = input.trim().replace(/^₹\s*/, "").replace(/,/g, "");
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function formatRupees(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value)}`;
}

export function formatIndianDate(value: string | null | undefined): string {
  if (!value) return "—";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}
