export type QuotationCompletion = {
  purchase_completion_status: "active" | "completed";
};

export type QuotationLineMedia = {
  id: string;
  image?: string | null;
  image_candidates?: string[];
};

export function quotationLoadMessage(error: unknown, document = "quotation"): string {
  const { status, requestId } = (error ?? {}) as { status?: number; requestId?: string };
  let message = "Check your connection and retry in a moment.";
  if (status === 404) message = `This ${document} could not be found.`;
  if (status === 401) message = "Sign in again to open this record.";
  if (status === 403) message = `You don't have access to open this ${document}.`;
  if (requestId && /^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) message += ` Support reference ${requestId}.`;
  return message;
}

export type QuotationMedia = { updated_at: string; items: QuotationLineMedia[] };
