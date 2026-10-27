import type { WorkspaceData } from "@/src/api/salesWorkspaces";
import type { SelectedPeriod } from "./useSalesPeriod";

export type ReferenceKind = "architect" | "interior_designer";
export type ReferenceContact = {
  id: string; name: string; type: ReferenceKind; company?: string | null;
  phone?: string | null; email?: string | null; address?: string | null;
  shared_across_floors: boolean; updated_at: string; floor_id?: string;
};
export type ReferencePerformance = NonNullable<WorkspaceData["relationships"]>[number];
export type ReferenceRow = { contact: ReferenceContact; performance?: ReferencePerformance; historical: boolean };

/** A directory contact outside the bounded result has unknown metrics, never a fabricated zero. */
export function mergeReferences(contacts: ReferenceContact[], performance: ReferencePerformance[]): ReferenceRow[] {
  const byId = new Map<string, ReferenceRow>();
  for (const contact of contacts) byId.set(contact.id, { contact, historical: false });
  for (const row of performance) {
    if (row.type !== "architect" && row.type !== "interior_designer") continue;
    const existing = byId.get(row.id);
    if (existing) existing.performance = row;
    else byId.set(row.id, { contact: {
      id: row.id, name: row.name, type: row.type, company: row.company,
      shared_across_floors: false, updated_at: "",
    }, historical: true, performance: row });
  }
  return [...byId.values()].sort((a, b) => a.contact.name.localeCompare(b.contact.name));
}

export function referenceDestination(id: string, floorId: string, period?: SelectedPeriod | null) {
  const query = new URLSearchParams({ floorId: floorId || "all", preset: period?.preset || "all" });
  if (period?.preset === "custom") {
    if (period.dateFrom) query.set("dateFrom", period.dateFrom);
    if (period.dateTo) query.set("dateTo", period.dateTo);
  }
  return `/(admin)/sales-data/referrer/${encodeURIComponent(id)}?${query}`;
}
