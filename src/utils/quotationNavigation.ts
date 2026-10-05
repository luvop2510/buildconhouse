/** Canonical document routes shared by cross-floor payment entry points. */
export type QuotationDestination = { id: string; doc_type?: string | null; floor_id?: string | null };

export function quotationDestination(document: QuotationDestination, edit = false): string {
  const id = encodeURIComponent(document.id);
  if (document.doc_type?.startsWith("tiles_") || document.floor_id === "ground-floor") {
    if (!edit) return `/(admin)/tiles/orders/${id}`;
    const page = document.doc_type === "tiles_selection" ? "selection" : "quotation";
    return `/(admin)/tiles/${page}?id=${id}`;
  }
  return edit ? `/(admin)/quotations/new?quotationId=${id}` : `/(admin)/quotations/${id}`;
}
