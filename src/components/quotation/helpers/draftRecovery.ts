import type { BuilderState } from "./types";

export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export type BuilderDraft = {
  version: 1;
  accountId: string;
  floorId: string;
  at: number;
  quotationId: string | null;
  quotationNumber: string | null;
  serverSavedAt: string | null;
  state: BuilderState;
};

/** Treat local storage as untrusted input; never restore another user's scope. */
export function parseBuilderDraft(raw: string | null, accountId: string, floorId: string, now = Date.now()): BuilderDraft | null {
  try {
    const draft = JSON.parse(raw || "null");
    if (!draft || draft.version !== 1 || draft.accountId !== accountId || draft.floorId !== floorId
      || !Number.isFinite(draft.at) || draft.at > now + 60_000 || now - draft.at > DRAFT_TTL_MS) return null;
    const s = draft.state;
    if (!s || !s.header || !Array.isArray(s.lines) || !Array.isArray(s.rooms) || !s.rooms.length
      || !s.rooms.every((r: unknown) => typeof r === "string") || new Set(s.rooms).size !== s.rooms.length
      || typeof s.activeRoom !== "string" || !s.rooms.includes(s.activeRoom)
      || typeof s.notes !== "string" || !Number.isFinite(s.projectDiscount)
      || !s.collapsedRooms || !s.categoryDiscounts || !s.roomDiscounts
      || !["projectName", "phone", "address", "referenceSource", "referrerName"].every(key => typeof s.header[key] === "string")
      || !s.lines.every((l: any) => l && typeof l.id === "string" && typeof l.name === "string"
        && typeof l.sku === "string" && s.rooms.includes(l.room) && Number.isFinite(l.qty) && l.qty >= 1
        && Number.isFinite(l.unit_price) && l.unit_price >= 0)
      || new Set(s.lines.map((l: any) => l.id)).size !== s.lines.length) return null;
    return draft as BuilderDraft;
  } catch { return null; }
}

/** A server edit after our base snapshot must never be silently overwritten. */
export function draftNeedsCopy(draft: BuilderDraft, server: { updated_at?: string; status?: string }): boolean {
  if (server.status && server.status !== "draft") return true;
  const base = Date.parse(draft.serverSavedAt || "");
  const current = Date.parse(server.updated_at || "");
  return !Number.isFinite(base) || !Number.isFinite(current) || current > base + 1000;
}

export function moveWithinRoom<T extends { id: string; room?: string }>(lines: T[], id: string, direction: -1 | 1): T[] {
  const index = lines.findIndex(line => line.id === id);
  if (index < 0) return lines;
  const peers = lines.map((line, i) => line.room === lines[index].room ? i : -1).filter(i => i >= 0);
  const target = peers[peers.indexOf(index) + direction];
  if (target === undefined) return lines;
  const result = [...lines];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}
