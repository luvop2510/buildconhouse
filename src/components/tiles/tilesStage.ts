// Ground Floor workflow, mirrored in backend/services/tiles_stage.py.
// Legacy approval states remain readable; they require no approval actions.
export type TilesStage = "selection_draft" | "quotation_draft" | "ordered";
const EDITABLE_TILES_STATUSES = new Set(["draft", "pending_approval", "approved", "sent", "won"]);
export function tilesStage(docType: string, status: string): TilesStage {
  if (docType === "tiles_selection") return "selection_draft";
  if (docType === "tiles_quotation") return status === "ordered" ? "ordered" : "quotation_draft";
  throw new Error(`tilesStage() called with non-tiles docType ${JSON.stringify(docType)}`);
}
export const TILES_STAGE_LABELS: Record<TilesStage, string> = {
  selection_draft: "Selection — Draft", quotation_draft: "Quotation — Draft", ordered: "Order placed",
};
export function tilesStageLabel(docType: string, status: string) {
  const stage = tilesStage(docType, status);
  return ["approved", "won"].includes(status)
    ? `${docType === "tiles_selection" ? "Selection" : "Quotation"} — Approved`
    : TILES_STAGE_LABELS[stage];
}
export const canMoveToQuotation = (docType: string, status: string) => docType === "tiles_selection" && EDITABLE_TILES_STATUSES.has(status);
export function canPlaceOrder(docType: string, status: string) {
  if (docType === "tiles_selection") return false;
  return docType !== "tiles_quotation" || EDITABLE_TILES_STATUSES.has(status);
}
export function normalizeTilesStatus(status: string) {
  if (status === "sent") return "pending_approval";
  if (status === "won") return "approved";
  return status;
}
export type NextTilesAction = { label: string; kind: "move_to_quotation"; nextStatus: null };
export function nextTilesAction(docType: string, status: string): NextTilesAction | null {
  return canMoveToQuotation(docType, status) ? { label: "Move to Quotation", kind: "move_to_quotation", nextStatus: null } : null;
}
