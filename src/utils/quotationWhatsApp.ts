/** Customer messages accompany PDF attachments; never append a share URL. */
export function defaultQuotationMessage(customerName: string): string {
  return `Hey ${customerName.trim() || "Customer"}, here is your quotation.`;
}

export function quotationPdfPath(id: string, includeDimensions = false): string {
  return `/quotations/${encodeURIComponent(id)}/pdf?include_dimensions=${includeDimensions}`;
}
