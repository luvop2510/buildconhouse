/** Walk-in summary drilldowns use the same status groups and UTC dates as /walkins/dashboard. */
export type WalkinSummary = "today" | "week" | "pending" | "scheduled" | "converted" | "lost" | "conversion" | "average";

export const WALKIN_SUMMARY_LABELS: Record<WalkinSummary, string> = {
  today: "Today", week: "This Week", pending: "Pending Follow-ups", scheduled: "Selections Scheduled",
  converted: "Converted", lost: "Lost", conversion: "Conversion Rate · Converted and Lost", average: "Avg. Conversion · Converted",
};

export function walkinSummaryFilters(summary: WalkinSummary | null, now = new Date()): { status?: string; date_from?: string; date_to?: string } {
  const converted = "selection_completed,quotation_created,converted";
  switch (summary) {
    case "today": {
      const date = now.toISOString().slice(0, 10);
      return { date_from: `${date}T00:00:00`, date_to: `${date}T23:59:59.999999Z` };
    }
    case "week": {
      const monday = new Date(now);
      monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
      return { date_from: `${monday.toISOString().slice(0, 10)}T00:00:00` };
    }
    case "pending": return { status: "new,contacted,selection_scheduled" };
    case "scheduled": return { status: "selection_scheduled" };
    case "converted": case "average": return { status: converted };
    case "lost": return { status: "lost" };
    case "conversion": return { status: `${converted},lost` };
    default: return {};
  }
}
