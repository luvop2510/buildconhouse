/** Quotations awaiting a customer response are displayed as Pending. */
export function quotationDisplayStatus(status: string): string {
  return status === "sent" ? "pending" : status;
}
