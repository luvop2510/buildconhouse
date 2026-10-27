import { storage } from "@/src/utils/storage";
import { DRAFT_TTL_MS } from "@/src/components/quotation/helpers/draftRecovery";
import { removeRegisteredBuilderDraft, writeRegisteredBuilderDraft } from "@/src/components/quotation/helpers/draftStorage";

export type TileDraft<Header = any, Row = any, Partner = any> = {
  version: 1; accountId: string; docType: string; routeId: string | null; at: number;
  documentId: string | null; number: string | null; serverSavedAt: string | null; clientDraftId: string;
  customerId: string | null; customerSnapshot: { name: string; phone: string };
  header: Header; rows: Row[]; partner: Partner; legacyPartnerLabel: string; partnerEdited: boolean;
};
const keyFor = (accountId: string, docType: string, routeId: string | null) => `forge.builder.draft.v1.tiles.${encodeURIComponent(accountId)}.${encodeURIComponent(docType)}.${encodeURIComponent(routeId || "new")}`;

export function parseTileDraft(raw: string | null, accountId: string, docType: string, routeId: string | null, now = Date.now()): TileDraft | null {
  try {
    const draft = JSON.parse(raw || "null");
    if (!draft || draft.version !== 1 || draft.accountId !== accountId || draft.docType !== docType || draft.routeId !== routeId
      || !Number.isFinite(draft.at) || draft.at > now + 60_000 || now - draft.at > DRAFT_TTL_MS
      || typeof draft.clientDraftId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draft.clientDraftId)
      || !draft.header || !["customerName", "phone", "reference", "docDate", "attendedBy", "preparedBy", "address", "docNumber", "transportationFee"].every(key => typeof draft.header[key] === "string")
      || !Array.isArray(draft.rows) || !draft.rows.length || draft.rows.length > 300
      || !draft.rows.every((row: any) => row && typeof row.key === "string" && (row.productId === null || typeof row.productId === "string")
        && (row.image === null || typeof row.image === "string") && ["name", "sku", "area", "size", "rateSqft", "boxSqft", "offerRate", "rateBox", "totalBox", "pcsBox", "total"].every(key => typeof row[key] === "string")
        && ["Box", "Pieces"].includes(row.quantityUnit))
      || new Set(draft.rows.map((row: any) => row.key)).size !== draft.rows.length
      || !draft.customerSnapshot || typeof draft.customerSnapshot.name !== "string" || typeof draft.customerSnapshot.phone !== "string"
      || typeof draft.legacyPartnerLabel !== "string" || typeof draft.partnerEdited !== "boolean"
      || ![draft.documentId, draft.number, draft.serverSavedAt, draft.customerId].every(value => value === null || typeof value === "string")
      || (draft.partner !== null && (!draft.partner || typeof draft.partner.id !== "string" || typeof draft.partner.name !== "string" || !["architect", "interior_designer"].includes(draft.partner.type)))) return null;
    return draft;
  } catch { return null; }
}

export async function readTileDraft(accountId: string, docType: string, routeId: string | null) {
  const key = keyFor(accountId, docType, routeId);
  const raw = await storage.getItem<string | null>(key, null);
  const draft = parseTileDraft(raw, accountId, docType, routeId);
  if (raw && !draft) await removeRegisteredBuilderDraft(key);
  return draft;
}
export const writeTileDraft = async (draft: TileDraft, epoch: number) => {
  if (await writeRegisteredBuilderDraft(keyFor(draft.accountId, draft.docType, draft.routeId), draft, epoch) === false) throw new Error("Could not save the draft on this device");
};
export const removeTileDraft = (accountId: string, docType: string, routeId: string | null) => removeRegisteredBuilderDraft(keyFor(accountId, docType, routeId));

/** Only edits based on this exact server revision can automatically replace it. */
export function tileDraftMatchesServer(draft: TileDraft, server: { id: string; updated_at?: string; status?: string }) {
  return draft.documentId === server.id && !!draft.serverSavedAt && draft.serverSavedAt === server.updated_at
    && !["ordered", "cancelled"].includes(server.status || "draft");
}
