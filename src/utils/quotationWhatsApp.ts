/** wa.me drafts carry a downloadable PDF link; delivery is confirmed in WhatsApp. */
export function defaultQuotationMessage(customerName: string): string {
  return `Hey ${customerName.trim() || "Customer"}, here is your quotation.`;
}

export function quotationWhatsAppUrl(phone: string, message: string, pdfUrl: string): string {
  if (!/^[1-9][0-9]{7,14}$/.test(phone)) throw new Error("A valid international WhatsApp phone number is required.");
  const parsed = new URL(pdfUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("The quotation PDF link is invalid.");
  if (!message.trim()) throw new Error("Enter a message before opening WhatsApp.");
  return `https://wa.me/${phone}?text=${encodeURIComponent(`${message.trim()}\n\n${pdfUrl}`)}`;
}
