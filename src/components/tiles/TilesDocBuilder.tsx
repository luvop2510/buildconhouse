import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useInputActive } from "@/src/hooks/use-input-active";
import { canManageDestructiveData } from "@/src/constants/roles";
import { referrerLabel } from "@/src/utils/referrer";
import { ReferrerField, type ReferrerValue } from "@/src/components/customer/ReferrerField";
// TilesDocBuilder — Ground Floor → Tiles → Selection / Quotation.
// -----------------------------------------------------------------------------
// Each page renders as an editable on-screen replica of its official printed
// document (the PDFs the backend generates from the same record), backed by
// the existing quotation infrastructure: customers, autosave (silent PATCH),
// activity logging, the /quotations PDF endpoint and the Purchase Order
// workflow. Product rows are added manually with the "+" button (max 11) and
// filled through the text-only SKU/name picker; every populated value stays
// editable afterwards.
//
// Recorded design decision (Production readiness audit, 2026-07-23; revised
// 2026-08-03 — see the Production UI/UX Stabilization Milestone): the on-
// screen "paper" (SelectionPaper / QuotationPaper below) deliberately bypasses
// both the shared design-token system (colors.ts / tokens.ts) and the app's
// useBp() breakpoint standard. It renders inside a horizontal ScrollView on
// narrow viewports instead of reflowing, because it is a fixed-size, pixel-
// faithful replica of a specific printed form (see PAPER_W below), not a
// responsive app screen — reflowing it, shrinking it, or scaling it would
// let the on-screen editor drift away from what actually prints. This is
// still true and still intentional for desktop. Tablet screens lose a
// meaningful slice of their width to the navigation rail, so presenting an
// 820px paper there created a nested horizontal viewport. Tablets use the
// same reflowed editor as phones instead, while retaining the exact document
// model and generated PDF.
//
// Phones and tablets are different media, not smaller versions of the same
// one: a pixel-faithful A4 replica is not something anyone can usefully edit
// in the constrained content area beside the navigation. So below the
// phone/tablet breakpoint branches to `MobileTilesEditor` — a genuinely
// separate, application-first
// presentation (cards, sections, a product picker sheet) that calls the
// EXACT SAME `useTilesDoc()` hook as the paper: same document model, same
// autosave, same validation, same pricing/totals math, same backend calls.
// Nothing about persistence or business logic is duplicated — only the
// phone-width presentation differs. Both presentations always produce the
// identical PDF, because they edit the identical document.
import Feather from "@expo/vector-icons/Feather";
import { randomUUID } from "expo-crypto";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ViewStyle } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { WhatsAppQuotationSheet, prepareQuotationWhatsAppDraft, type WhatsAppQuotationDraft } from "@/src/components/quotation/WhatsAppQuotationSheet";
import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { ProductImage } from "@/src/components/ProductImage";
import { productImageList } from "@/src/components/quotation/helpers/media";
import { enqueueQuotationPersist } from "@/src/components/quotation/helpers/autosave";
import { builderDraftEpoch } from "@/src/components/quotation/helpers/draftStorage";
import { computeQuotationTotals } from "@/src/components/quotation/helpers/totals";
import type { Customer, Product } from "@/src/components/quotation/helpers/types";
import { Button, Card, ConfirmDialog, Dropdown, TextField } from "@/src/components/ds";
import { Disclosure } from "@/src/design/Disclosure";
import { BuildConLogo } from "@/src/design/BrandLogo";
import { useBp } from "@/src/design/responsive";
import { colors, font, money, radius, spacing, type } from "@/src/theme/tokens";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { TILES_FLOOR_ID } from "@/src/constants/floors";

import { TilesProductPicker } from "./TilesProductPicker";
import { TILE_IMAGE_ASPECT_RATIO } from "./tilePresentation";
import { canPlaceOrder, nextTilesAction, normalizeTilesStatus, tilesStage } from "./tilesStage";
import { readTileDraft, writeTileDraft, removeTileDraft, tileDraftMatchesServer, type TileDraft } from "./tileDraftStorage";

export type TilesDocType = "tiles_selection" | "tiles_quotation";

const MAX_ROWS = 300; // soft cap only — the PDF auto-paginates, so this just guards against runaway input
const PAPER_W = 820;
const HEAD_GREY = "#D3D3D3";
const ZEBRA = "#F0F0F0";
const GRID = "#8A8A8A";
const SERIF = font.regular; // legacy field alias; document editing uses the app font

function TileImageCell({ uri }: { uri: string }) {
  const [cellWidth, setCellWidth] = useState(0);
  // A numeric size is intentional: percentage sizing in an RN-web table cell
  // can shrink to the source bitmap's intrinsic square. This guarantees every
  // quotation/selection tile is a visible 16:10 landscape strip.
  const imageWidth = cellWidth > 0 ? cellWidth : 144;
  return (
    <View style={{ width: "100%", alignItems: "center", justifyContent: "center" }} onLayout={(event) => setCellWidth(event.nativeEvent.layout.width)}>
      <ProductImage
        source={uri}
        contentFit="contain"
        frameInset={0}
        borderRadius={0}
        disableSkeleton
        frameBackground="#FFFFFF"
        style={{ width: imageWidth, height: imageWidth / TILE_IMAGE_ASPECT_RATIO }}
        accessibilityLabel="Quotation product image"
      />
    </View>
  );
}

type TileRow = {
  key: string;
  lineId: string | null;
  productId: string | null;
  sku: string;
  categoryId: string | null;
  name: string;
  image: string | null;
  mrp: number | null;
  area: string;
  size: string;
  rateSqft: string;
  boxSqft: string;
  offerRate: string;
  // True when Offer Rate is merely mirroring Rate/SQ.FT rather than a
  // customer-specific offer. This lets later rate edits continue to price
  // correctly without requiring the user to clear the displayed fallback.
  offerRateIsFallback: boolean;
  rateBox: string;
  totalBox: string;
  pcsBox: string;
  quantityUnit: "Box" | "Pieces";
  total: string;
  totalEdited: boolean;
  // Transient catalog data for a size picker. It is deliberately not sent in
  // quotation items: the selected sibling product is the persisted truth.
  availableSizes?: string[];
};

type TilesHeader = {
  customerName: string;
  phone: string;
  reference: string;
  docDate: string;
  attendedBy: string;
  preparedBy: string;
  address: string;
  docNumber: string;
  transportationFee: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function defaultDocDate(docType: TilesDocType): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  if (docType === "tiles_selection") {
    return `${dd}-${MONTHS[now.getMonth()]}-${String(now.getFullYear()).slice(2)}`;
  }
  return `${dd}-${String(now.getMonth() + 1).padStart(2, "0")}-${now.getFullYear()}`;
}

function parseDocDate(raw: string): Date | null {
  const text = (raw || "").trim();
  let m = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = text.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{2,4})$/);
  if (m) {
    const month = MONTHS.findIndex((x) => m![2].toLowerCase().startsWith(x.toLowerCase()));
    if (month >= 0) {
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return new Date(year, month, Number(m[1]));
    }
  }
  return null;
}

function pdfFilename(customerName: string, docDate: string): string {
  const d = parseDocDate(docDate) || new Date();
  const stamp = `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
  const name = (customerName || "Customer").trim().replace(/[\\/:*?"<>|]/g, "");
  return `${name} ${stamp}.pdf`;
}

function emptyRow(): TileRow {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    lineId: null, productId: null, sku: "", categoryId: null,
    name: "", image: null, mrp: null,
    area: "", size: "", rateSqft: "", boxSqft: "", offerRate: "", offerRateIsFallback: true, rateBox: "",
    totalBox: "", pcsBox: "", quantityUnit: "Box", total: "",
    totalEdited: false,
  };
}

function validTileSizes(sizes: unknown): string[] {
  return [...new Set(Array.isArray(sizes) ? sizes.map((size) => String(size || "").trim()).filter(Boolean) : [])];
}

const num = (text: string): number => {
  const value = parseFloat(String(text).replace(/,/g, ""));
  return Number.isFinite(value) ? value : 0;
};

// Offer rate is the selling rate. Per-piece products use it directly; boxed
// products use it as a per-square-foot rate before converting to rate/box.
function effectiveTileRate(row: TileRow): number {
  return row.offerRate.trim() !== "" ? num(row.offerRate) : num(row.rateSqft);
}

function derivedTileBoxRate(row: TileRow): number | null {
  if (row.quantityUnit === "Pieces") return null;
  const sqft = num(row.boxSqft);
  return sqft > 0 ? Math.round(effectiveTileRate(row) * sqft * 100) / 100 : null;
}

// A line total is normally derived from its quantity and rate. Keeping this
// calculation in one place means the editor's visible per-product amount and
// the quotation subtotal cannot drift apart. A typed total remains an explicit
// override, matching the value persisted by buildItems().
function resolvedLineTotal(row: TileRow): number {
  const manualTotal = num(row.total);
  if (row.totalEdited && manualTotal > 0) return manualTotal;

  const quantity = num(row.totalBox);
  const unitRate = (derivedTileBoxRate(row) ?? num(row.rateBox)) || effectiveTileRate(row);
  return quantity * unitRate;
}

function lineTotalInputValue(row: TileRow): string {
  // Preserve what the user is typing, including an in-progress blank value.
  if (row.totalEdited) return row.total;
  const total = resolvedLineTotal(row);
  return total > 0 ? String(Math.round(total * 100) / 100) : "";
}

function quantityUnitLabel(unit: TileRow["quantityUnit"]): "Box" | "Piece" {
  return unit === "Pieces" ? "Piece" : "Box";
}

function restoredQuantityUnit(value: unknown): TileRow["quantityUnit"] {
  return ["piece", "pieces", "pc", "pcs"].includes(String(value || "").trim().toLowerCase()) ? "Pieces" : "Box";
}

// ---------------------------------------------------------------------------
// Document state + persistence
// ---------------------------------------------------------------------------
function useTilesDoc(docType: TilesDocType, initialProductId?: string | null, initialQuotationId?: string | null) {
  const router = useRouter();
  const { staff } = useAuth();
  const accountId = staff?.id || "";
  const { id, quotationId } = useLocalSearchParams<{ id?: string; quotationId?: string }>();
  const routeId = initialQuotationId || id || quotationId;
  const documentScope = `${accountId}:${docType}:${routeId || "new"}`;
  const documentScopeRef = useRef(documentScope);
  const documentGenerationRef = useRef(0);
  if (documentScopeRef.current !== documentScope) documentGenerationRef.current += 1;
  documentScopeRef.current = documentScope;
  const documentGeneration = documentGenerationRef.current;
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const [docId, setDocId] = useState<string | null>(null);
  const [docNumberServer, setDocNumberServer] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("draft");
  const [completionSnapshot, setCompletionSnapshot] = useState<{ id: string; customerId: string; completed: boolean } | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const customerIdRef = useRef<string | null>(null);
  const [customerSnapshot, setCustomerSnapshot] = useState<{ name: string; phone: string }>({ name: "", phone: "" });
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerLookupOwner, setCustomerLookupOwner] = useState<object | null>(null);
  const customerLookupActive = customerLookupOwner !== null;
  const setCustomerLookupActive = useCallback((active: boolean, owner: object) => {
    setCustomerLookupOwner(current => active ? owner : current === owner ? null : current);
  }, []);
  const [partner, setPartner] = useState<ReferrerValue>(null);
  const [legacyPartnerLabel, setLegacyPartnerLabel] = useState("");
  const [partnerEditVersion, setPartnerEditVersion] = useState(0);
  const partnerSavedVersion = useRef(0);
  const [header, setHeader] = useState<TilesHeader>({
    customerName: "", phone: "", reference: "", docDate: defaultDocDate(docType),
    attendedBy: "", preparedBy: "", address: "", docNumber: "", transportationFee: "0",
  });
  const [rows, setRows] = useState<TileRow[]>([emptyRow()]);
  const [saveState, setSaveState] = useState<"idle" | "local" | "saving" | "saved" | "error">("idle");
  const [serverTotals, setServerTotals] = useState<{ subtotal: number; grandTotal: number; transportation: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [whatsappDraft, setWhatsappDraft] = useState<WhatsAppQuotationDraft | null>(null);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(routeId));
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [localReady, setLocalReady] = useState(false);
  const [recoveryDraft, setRecoveryDraft] = useState<TileDraft<TilesHeader, TileRow, ReferrerValue> | null>(null);
  const draftEpoch = useRef(builderDraftEpoch());
  const serverSavedAtRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);
  const persistRef = useRef<() => Promise<string | null>>(async () => null);
  const persistQueue = useRef<Promise<string | null>>(Promise.resolve(null));
  const persistedIdRef = useRef<string | null>(null);
  const createdDocumentRef = useRef<{ id: string; docType: TilesDocType } | null>(null);
  const seededProductRef = useRef<string | null>(null);
  const deletingScopes = useRef(new Set<string>());
  const clientDraftIdRef = useRef<string | null>(null);
  if (!clientDraftIdRef.current) clientDraftIdRef.current = randomUUID();
  const localSnapshot = {
    version: 1 as const, accountId, docType, routeId: routeId || null, at: Date.now(),
    documentId: persistedIdRef.current || docId, number: docNumberServer, serverSavedAt: serverSavedAtRef.current,
    customerId: customerIdRef.current || customerId, customerSnapshot, header, rows, partner, legacyPartnerLabel,
    partnerEdited: partnerEditVersion > partnerSavedVersion.current, clientDraftId: clientDraftIdRef.current,
  };
  const localSnapshotRef = useRef(localSnapshot);
  localSnapshotRef.current = localSnapshot;

  const applyLocalDraft = useCallback((draft: TileDraft<TilesHeader, TileRow, ReferrerValue>, asCopy = false) => {
    clientDraftIdRef.current = asCopy ? randomUUID() : draft.clientDraftId;
    setHeader(draft.header); setRows(asCopy ? draft.rows.map(row => ({ ...row, lineId: null })) : draft.rows);
    setCustomerId(draft.customerId); customerIdRef.current = draft.customerId;
    setCustomerSnapshot(draft.customerSnapshot); setPartner(draft.partner); setLegacyPartnerLabel(draft.legacyPartnerLabel);
    setPartnerEditVersion(draft.partnerEdited ? 1 : 0); partnerSavedVersion.current = 0;
    serverSavedAtRef.current = asCopy ? null : draft.serverSavedAt;
    const restoredId = asCopy ? null : draft.documentId;
    persistedIdRef.current = restoredId; setDocId(restoredId); setDocNumberServer(asCopy ? null : draft.number);
    dirtyRef.current = true; editRevisionRef.current += 1; setSaveState("idle");
    if (!routeId && restoredId) { createdDocumentRef.current = { id: restoredId, docType }; router.setParams({ id: restoredId }); }
  }, [routeId, router, docType]);


  // Restore a saved document.
  useEffect(() => {
    // First autosave adds the new id to this same route. Its current draft
    // may include edits made while POST was pending; fetching that older
    // server snapshot would erase them before the next autosave.
    if (createdDocumentRef.current && createdDocumentRef.current.id === routeId && createdDocumentRef.current.docType === docType) {
      createdDocumentRef.current = null;
      setLoading(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setLocalReady(false); setRecoveryDraft(null); setBusy(null);
    draftEpoch.current = builderDraftEpoch();
    const local = accountId ? readTileDraft(accountId, docType, routeId || null) : Promise.resolve(null);
    if (!routeId) {
      // Reusing this route for a fresh document must not carry the previous
      // document's customer, ID or rows into the new draft scope.
      dirtyRef.current = false; persistedIdRef.current = null; customerIdRef.current = null;
      serverSavedAtRef.current = null; clientDraftIdRef.current = randomUUID();
      setDocId(null); setDocNumberServer(null); setCustomerId(null); setCustomerSnapshot({ name: "", phone: "" });
      setHeader({ customerName: "", phone: "", reference: "", docDate: defaultDocDate(docType), attendedBy: "", preparedBy: "", address: "", docNumber: "", transportationFee: "0" });
      setRows([emptyRow()]); setPartner(null); setLegacyPartnerLabel(""); setPartnerEditVersion(0); partnerSavedVersion.current = 0;
      setStatus("draft"); setSaveState("idle");
      void local.then(draft => {
        if (!alive || documentScopeRef.current !== documentScope) return;
        if (draft && !dirtyRef.current) {
          // A first-save response may have acquired an ID immediately before
          // interruption. Verify its current revision before resuming edits.
          if (draft.documentId) {
            setRecoveryDraft(draft);
          } else applyLocalDraft(draft);
        }
        setLocalReady(true);
      });
      return () => { alive = false; };
    }
    dirtyRef.current = false;
    persistedIdRef.current = null;
    setLoading(true);
    setSaveState("idle");
    setRestoreError(null);
    setPartner(null); setLegacyPartnerLabel(""); setPartnerEditVersion(0); partnerSavedVersion.current = 0;
    (async () => {
      try {
        const [doc, draft] = await Promise.all([
          api.get<any>(`/quotations/${routeId}?with_completion=true`, { floorId: TILES_FLOOR_ID, signal: controller.signal }), local,
        ]);
        if (!alive || documentScopeRef.current !== documentScope) return;
        if (doc.doc_type !== docType) {
          const canonicalRoute = doc.doc_type === "tiles_selection" ? "selection" : doc.doc_type === "tiles_quotation" ? "quotation" : null;
          toast.error(canonicalRoute ? "Opening this document in its correct workspace" : "That document is not a tile document");
          router.replace((canonicalRoute ? `/(admin)/tiles/${canonicalRoute}?id=${doc.id}` : "/(admin)/tiles") as any);
          return;
        }
        persistedIdRef.current = doc.id;
        serverSavedAtRef.current = doc.updated_at || null;
        setDocId(doc.id);
        setDocNumberServer(doc.number || null);
        setStatus(normalizeTilesStatus(doc.status || "draft"));
        setCompletionSnapshot({ id: doc.id, customerId: doc.customer_id, completed: doc.purchase_completion_status === "completed" });
        setServerTotals({
          subtotal: Number(doc.subtotal || 0),
          grandTotal: Number(doc.grand_total || 0),
          transportation: Number(doc.transportation_fee || 0),
        });
        setCustomerId(doc.customer_id || null);
        customerIdRef.current = doc.customer_id || null;
        setCustomerSnapshot({ name: doc.customer_name || "", phone: doc.phone_snapshot || "" });
        setLegacyPartnerLabel(referrerLabel(doc));
        setPartner(doc.referrer_id && doc.referrer_type ? { id: doc.referrer_id, type: doc.referrer_type, name: doc.referrer_name || "", company: doc.referrer_company } : null);
        setHeader({
          customerName: doc.customer_name || "",
          phone: doc.phone_snapshot || "",
          reference: doc.reference_source || "",
          docDate: doc.doc_date || defaultDocDate(docType),
          attendedBy: doc.attended_by || "",
          preparedBy: doc.prepared_by || "",
          address: doc.address_snapshot || "",
          docNumber: doc.doc_number || doc.number || "",
          transportationFee: doc.transportation_fee != null ? String(doc.transportation_fee) : "0",
        });
        const restored: TileRow[] = (doc.items || []).map((it: any): TileRow => ({
          key: it.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          lineId: it.id || null,
          productId: it.product_id || null,
          sku: it.sku || "",
          categoryId: it.category_id || null,
          name: it.name || "",
          image: it.image || null,
          mrp: it.mrp ?? null,
          area: it.room || "",
          size: it.size || "",
          rateSqft: it.rate_sqft != null ? String(it.rate_sqft) : "",
          boxSqft: it.box_sqft != null ? String(it.box_sqft) : "",
          offerRate: it.offer_rate != null ? String(it.offer_rate) : (it.rate_sqft != null ? String(it.rate_sqft) : ""),
          offerRateIsFallback: it.offer_rate == null || it.offer_rate === it.rate_sqft,
          rateBox: it.rate_box != null ? String(it.rate_box) : (it.unit_price != null ? String(it.unit_price) : ""),
          totalBox: it.qty ? String(it.qty) : "",
          pcsBox: it.pcs_per_box || "",
          quantityUnit: restoredQuantityUnit(it.quantity_unit),
          total: it.net_amount != null ? String(it.net_amount) : "",
          totalEdited: false,
        }));
        setRows(restored.length ? restored : [emptyRow()]);
        if (draft) {
          if (tileDraftMatchesServer(draft, doc)) applyLocalDraft(draft);
          else setRecoveryDraft(draft);
        }
      } catch (e: any) {
        const message = e?.detail || "Couldn't open that document";
        if (alive && documentScopeRef.current === documentScope) {
          setRestoreError(message);
          toast.error(message);
        }
      } finally {
        if (alive) { setLoading(false); setLocalReady(true); }
      }
    })();
    return () => { alive = false; controller.abort(); };
  }, [routeId, docType, documentScope, router, restoreAttempt, accountId, applyLocalDraft]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    editRevisionRef.current += 1;
    setSaveState("idle");
  }, []);

  // Store every rendered edit immediately, including incomplete names,
  // quantities and photo URLs. The network debounce never owns the only copy.
  useEffect(() => {
    if (!accountId || !localReady || loading || restoreError || recoveryDraft || !dirtyRef.current || deletingScopes.current.has(documentScope)) return;
    let current = true;
    void writeTileDraft(localSnapshotRef.current, draftEpoch.current).then(() => {
      if (current) setSaveState(value => value === "idle" ? "local" : value);
    }).catch(() => { if (current) setSaveState("error"); });
    return () => { current = false; };
  }, [accountId, localReady, loading, restoreError, recoveryDraft, header, rows, partner, partnerEditVersion, customerId, customerSnapshot, docId, routeId, documentScope]);

  const setHeaderField = useCallback((field: keyof TilesHeader, value: string) => {
    setHeader((cur) => ({ ...cur, [field]: value }));
    markDirty();
  }, [markDirty]);

  const updateRow = useCallback((key: string, patch: Partial<TileRow>) => {
    setRows((cur) => cur.map((row) => {
      if (row.key !== key) return row;
      const next = { ...row, ...patch };
      if ("offerRate" in patch) next.offerRateIsFallback = !(patch.offerRate ?? "").trim();
      if ("rateSqft" in patch && row.offerRateIsFallback) {
        next.offerRate = patch.rateSqft ?? "";
        next.offerRateIsFallback = true;
      }
      // Recalculate immediately when the selling rate or box coverage changes
      // so the on-screen total never lags behind the edited offer.
      if (next.quantityUnit === "Box" && ("offerRate" in patch || "boxSqft" in patch || ("rateSqft" in patch && row.offerRateIsFallback))) {
        const derived = derivedTileBoxRate(next);
        if (derived !== null) next.rateBox = String(derived);
      }
      // The catalog provides the initial unit, but the quotation author may
      // explicitly switch it. Re-entering Box mode restores the normal
      // rate-per-square-foot × box-coverage calculation; Pieces continues to
      // use the editable rate per unit without guessing a conversion.
      if (patch.quantityUnit === "Box") {
        const derived = derivedTileBoxRate(next);
        if (derived !== null) next.rateBox = String(derived);
      }
      // Editable values are sent to the backend pricing engine. The
      // presentation layer does not derive prices or line totals.
      if ("total" in patch) next.totalEdited = true;
      return next;
    }));
    markDirty();
  }, [markDirty]);

  const addRow = useCallback(() => {
    setRows((cur) => (cur.length >= MAX_ROWS ? cur : [...cur, emptyRow()]));
    markDirty();
  }, [markDirty]);

  const removeRow = useCallback((key: string) => {
    setRows((cur) => {
      const next = cur.filter((row) => row.key !== key);
      return next.length ? next : [emptyRow()];
    });
    markDirty();
  }, [markDirty]);

  const loadRowSizes = useCallback(async (key: string, productId: string) => {
    try {
      const result = await api.get<{ available_sizes?: string[] }>(`/products/${productId}/size-variants`, { floorId: TILES_FLOOR_ID });
      const availableSizes = validTileSizes(result.available_sizes);
      setRows((current) => current.map((row) => row.key === key && row.productId === productId ? { ...row, availableSizes } : row));
    } catch {
      // A missing/legacy family endpoint means this is simply not a
      // size-switchable style. The row remains read-only until a real size
      // list is available; linked catalog sizes must not become free text.
      setRows((current) => current.map((row) => row.key === key && row.productId === productId ? { ...row, availableSizes: [] } : row));
    }
  }, []);

  const applyProduct = useCallback((key: string, product: Product, history?: { size: string | null; rate_sqft: number | null; rate_box: number | null; pcs_per_box: string | null; box_sqft?: number | null }) => {
    const image = productImageList(product)[0] || null;
    if (!image) {
      toast.error("This product has no image. Add a product image before including it in a tile selection.");
      return;
    }
    const specs = product.specs || {};
    const specNum = (...keys: string[]): string => {
      for (const k of keys) {
        const v = (specs as any)[k];
        if (v != null && v !== "" && Number.isFinite(parseFloat(String(v)))) return String(v);
      }
      return "";
    };
    const specText = (...keys: string[]): string => {
      for (const k of keys) {
        const v = (specs as any)[k];
        if (v != null && String(v).trim()) return String(v);
      }
      return "";
    };
    setRows((cur) => cur.map((row) => {
      if (row.key !== key) return row;
      const isPerPiece = String((specs as any).price_unit || "").trim().toLowerCase() === "per piece";
      // Size siblings are separate catalog products. Do not carry coverage,
      // rate or box metadata across a change: the selected sibling owns it.
      const boxSqft = isPerPiece ? "" : (history?.box_sqft != null ? String(history.box_sqft) : specNum("sqft_per_box", "box_sqft"));
      const rateSqft = isPerPiece ? "" : (history?.rate_sqft != null ? String(history.rate_sqft) : (product.price ? String(product.price) : ""));
      const derivedRateBox = num(rateSqft) > 0 && num(boxSqft) > 0
        ? String(Math.round(num(rateSqft) * num(boxSqft) * 100) / 100)
        : "";
      const next: TileRow = {
        ...row,
        productId: product.id,
        sku: product.sku,
        categoryId: product.category_id || null,
        name: product.name,
        image,
        mrp: product.mrp ?? null,
        size: history?.size || product.size || product.dimensions || row.size,
        rateSqft,
        boxSqft,
        rateBox: isPerPiece ? String(product.price || product.mrp || 0) : (history?.rate_box != null ? String(history.rate_box) : (specNum("rate_per_box", "rate_box", "box_rate") || derivedRateBox)),
        offerRate: isPerPiece ? String(product.price || product.mrp || 0) : (history?.rate_sqft != null ? String(history.rate_sqft) : rateSqft),
        offerRateIsFallback: true,
        pcsBox: isPerPiece ? "" : (history?.pcs_per_box || specText("pcs_per_box", "pcs_box", "pcs")),
        // A newly selected product starts at one unit, but a user-cleared
        // quantity must stay blank until they enter their intended amount.
        totalBox: row.totalBox === "" ? "1" : row.totalBox,
        quantityUnit: isPerPiece ? "Pieces" : "Box",
        totalEdited: false,
        availableSizes: validTileSizes(product.available_sizes),
      };
      return next;
    }));
    if (history) toast.show(`Used ${customerId ? "this customer's" : ""} last rate for ${product.name}`.replace("  ", " "));
    markDirty();
    // The full product response may already include the metadata; querying
    // this canonical endpoint also covers catalog pages that omit it.
    if (!validTileSizes(product.available_sizes).length) void loadRowSizes(key, product.id);
  }, [markDirty, customerId, loadRowSizes]);

  // Catalog's Ground Floor CTA deep-links here with a concrete product. Seed
  // only an unsaved document: an existing document URL always remains the
  // source of truth, even if a stale productId query parameter is present.
  const initialEmptyRowKey = rows.find((row) => !row.productId)?.key || rows[0]?.key;
  useEffect(() => {
    if (!localReady || recoveryDraft || !initialProductId || routeId || !initialEmptyRowKey || seededProductRef.current === initialProductId) return;
    seededProductRef.current = initialProductId;
    let alive = true;
    api.get<Product>(`/products/${initialProductId}`, { floorId: TILES_FLOOR_ID })
      .then((product) => {
        if (alive) applyProduct(initialEmptyRowKey, product);
      })
      .catch((error: any) => {
        if (alive) toast.error(error?.detail || "Couldn't add this tile to the quotation");
      });
    return () => { alive = false; };
  }, [applyProduct, initialEmptyRowKey, initialProductId, routeId, localReady, recoveryDraft]);

  const selectRowSize = useCallback(async (key: string, size: string) => {
    const row = rows.find((item) => item.key === key);
    if (!row?.productId || size === row.size) return;
    try {
      // Resolve by size on the backend so the current style/finish rules are
      // applied consistently. The returned sibling is a complete product.
      const resolution = await api.get<{ product: Product }>(`/products/${row.productId}/size-variants?size=${encodeURIComponent(size)}`, { floorId: TILES_FLOOR_ID });
      applyProduct(key, resolution.product);
    } catch (e: any) {
      toast.error(e?.detail || "Couldn't change tile size");
    }
  }, [applyProduct, rows]);

  // ---- Persistence -------------------------------------------------------
  const buildItems = useCallback(() => {
    return rows
      .filter((row) => row.productId && row.name.trim())
      .map((row, index) => {
        const qty = num(row.totalBox);
        const manualTotal = num(row.total);
        const derivedRateBox = derivedTileBoxRate(row);
        const baseRateBox = (derivedRateBox ?? num(row.rateBox)) || effectiveTileRate(row);
        const rateBox = row.totalEdited && manualTotal > 0 && qty > 0
          ? Math.round(manualTotal / qty * 100) / 100
          : baseRateBox;
        // The rate is per selected quantity unit: per box for boxed tiles and
        // per piece for individually sold tiles. The backend validates the
        // same rule, so a quantity of 10 at ₹200/piece persists as ₹2,000.
        const unitPrice = rateBox;
        const item: any = {
          product_id: row.productId, sku: row.sku, name: row.name.trim(),
          image: row.image, category_id: row.categoryId,
          room: row.area.trim() || null,
          qty, unit_price: unitPrice, rate_box: rateBox,
          mrp: row.mrp,
          size: row.size.trim() || null,
          rate_sqft: row.rateSqft.trim() ? num(row.rateSqft) : null,
          box_sqft: row.boxSqft.trim() ? num(row.boxSqft) : null,
          offer_rate: row.offerRate.trim() ? num(row.offerRate) : (row.rateSqft.trim() ? num(row.rateSqft) : unitPrice),
          pcs_per_box: row.pcsBox.trim() || null,
          quantity_unit: row.quantityUnit,
          sort_order: index,
        };
        if (row.lineId) item.id = row.lineId;
        return item;
      });
  }, [rows]);

  // Show the same subtotal/transport/grand-total relationship immediately
  // while the debounced autosave round-trip is in flight.
  const previewTotals = useMemo(() => {
    const lines = rows.flatMap((row) => {
      if (!row.productId || !row.name.trim()) return [];
      return [{ qty: 1, unitPrice: resolvedLineTotal(row) }];
    });
    const transportation = docType === "tiles_quotation" ? num(header.transportationFee) : 0;
    const totals = computeQuotationTotals(lines, transportation);
    return {
      subtotal: totals.subtotal,
      transportation: totals.transportation,
      grandTotal: totals.grandTotal,
    };
  }, [rows, header.transportationFee, docType]);

  const persist = useCallback(async ({ silent = true }: { silent?: boolean } = {}): Promise<string | null> => {
    const savingRevision = editRevisionRef.current;
    const run = async (): Promise<string | null> => {
      const current = () => mountedRef.current && documentScopeRef.current === documentScope && documentGenerationRef.current === documentGeneration;
      if (loading || !localReady || restoreError || recoveryDraft || deletingScopes.current.has(documentScope) || !current() || (routeId && docId !== routeId)) return null;
      let id = persistedIdRef.current || docId;
      const name = header.customerName.trim();
      if (!name) {
        if (!silent) toast.show("Enter the customer name first");
        return null;
      }
      if (!silent && docType === "tiles_quotation" && !header.address.trim()) {
        toast.show("Enter the address before saving or generating the quotation");
        return null;
      }
      const hasInvalidQuantity = rows.some((row) => row.productId && (!Number.isFinite(Number(row.totalBox)) || Number(row.totalBox) <= 0));
      if (hasInvalidQuantity) {
        // Do not silently convert a cleared/zero quantity into one box. This
        // preserves the user's input and makes Box/Piece quantities explicit.
        if (!silent) toast.show("Enter a quantity greater than zero for every product.");
        return null;
      }
      setSaveState("saving");
      try {
      // 1. Resolve the customer — reuse an explicit pick, else create one.
      let cid = customerIdRef.current || customerId;
      if (!cid) {
        if (accountId) await writeTileDraft(localSnapshotRef.current, draftEpoch.current);
        if (!current()) return null;
        const created = await api.post<Customer>("/customers", { name, phone: header.phone.trim() || null, client_draft_id: clientDraftIdRef.current }, { floorId: TILES_FLOOR_ID });
        if (!current()) return null;
        cid = created.id;
        customerIdRef.current = created.id;
        setCustomerId(created.id);
        // A lost first response can replay the original contact after the
        // user corrected its name/phone. Save those corrections before the
        // quotation takes its customer snapshot; retain the ID on failure.
        if (created.name !== name || (created.phone || "") !== header.phone.trim()) {
          await api.patch(`/customers/${cid}`, { name, phone: header.phone.trim() || null }, { floorId: TILES_FLOOR_ID });
          if (!current()) return null;
        }
        setCustomerSnapshot({ name, phone: header.phone.trim() });
        setCustomers((cur) => [{ ...created, name, phone: header.phone.trim() }, ...cur]);
      } else if (name !== customerSnapshot.name || header.phone.trim() !== customerSnapshot.phone) {
        // Header edits correct the customer record (typo fixes stay in sync).
        await api.patch(`/customers/${cid}`, { name, phone: header.phone.trim() || null }, { floorId: TILES_FLOOR_ID });
        if (!current()) return null;
        setCustomerSnapshot({ name, phone: header.phone.trim() });
      }

      const payload: any = {
        customer_id: cid,
        items: buildItems(),
        rooms: [],
        phone_snapshot: header.phone.trim() || null,
        reference_source: header.reference.trim() || null,
        attended_by: header.attendedBy.trim() || null,
        prepared_by: header.preparedBy.trim() || null,
        address_snapshot: header.address.trim() || null,
        doc_date: header.docDate.trim() || null,
        doc_number: header.docNumber.trim() || null,
        transportation_fee: docType === "tiles_quotation" ? num(header.transportationFee) : 0,
      };
      const referenceEdited = partnerEditVersion > partnerSavedVersion.current;
      if (referenceEdited) { payload.referrer_id = partner?.id || ""; payload.referrer_type = partner?.type || null; }
      if (!current()) return null;
      if (!id) {
        // Persist the stable create identity before POST, including when the
        // user taps an action before the next local-storage effect runs.
        if (accountId) await writeTileDraft({ ...localSnapshotRef.current, customerId: cid, customerSnapshot: { name, phone: header.phone.trim() } }, draftEpoch.current);
        if (!current()) return null;
        const created = await api.post<{ id: string; number: string; updated_at?: string; status?: string; doc_type?: string; create_replayed?: boolean; create_original_updated_at?: string }>("/quotations", { ...payload, doc_type: docType, client_draft_id: clientDraftIdRef.current }, { floorId: TILES_FLOOR_ID });
        if (!current()) return null;
        if (created.create_replayed && (!created.create_original_updated_at || created.updated_at !== created.create_original_updated_at || created.status !== "draft" || created.doc_type !== docType)) {
          // Another session may have edited, converted or ordered this draft
          // while its original response was lost. Never overwrite that state.
          const recovered = { ...localSnapshotRef.current, documentId: created.id, number: created.number, serverSavedAt: created.create_original_updated_at || null };
          if (accountId) await writeTileDraft(recovered, draftEpoch.current);
          if (!current()) return null;
          setRecoveryDraft(recovered); setSaveState("local");
          toast.show("The saved document changed while the response was interrupted. Your draft is preserved for recovery.");
          return null;
        }
        id = created.id;
        persistedIdRef.current = created.id;
        serverSavedAtRef.current = created.updated_at || null;
        createdDocumentRef.current = { id: created.id, docType };
        setDocId(created.id);
        setDocNumberServer(created.number);
        // Persist the assigned ID before the optional reference patch. A
        // reload following that secondary failure must update this same draft.
        if (accountId) await writeTileDraft({ ...localSnapshotRef.current, documentId: created.id, number: created.number, serverSavedAt: serverSavedAtRef.current }, draftEpoch.current);
        if (!current()) return null;
        if (docType === "tiles_quotation" && !header.docNumber.trim()) {
          setHeader((cur) => ({ ...cur, docNumber: created.number }));
        }
        // POST may replay a prior committed create after a lost response.
        // Apply this captured payload before declaring either case saved.
        {
          const fresh = await api.patch<any>(`/quotations/${id}`, { ...payload, silent: true, expected_updated_at: created.updated_at }, { floorId: TILES_FLOOR_ID });
          if (!current()) return null;
          serverSavedAtRef.current = fresh?.updated_at || serverSavedAtRef.current;
        }
      } else {
        const fresh = await api.patch<any>(`/quotations/${id}`, { ...payload, silent, expected_updated_at: serverSavedAtRef.current || undefined, reason: silent ? undefined : "Saved from tiles builder" }, { floorId: TILES_FLOOR_ID });
        if (!current()) return null;
        serverSavedAtRef.current = fresh.updated_at || null;
        setServerTotals({
          subtotal: Number(fresh.subtotal || 0),
          grandTotal: Number(fresh.grand_total || 0),
          transportation: Number(fresh.transportation_fee || 0),
        });
      }
      if (referenceEdited) partnerSavedVersion.current = partnerEditVersion;
      if (editRevisionRef.current === savingRevision) {
        dirtyRef.current = false;
        if (accountId) {
          await removeTileDraft(accountId, docType, routeId || null);
          if (id !== routeId) await removeTileDraft(accountId, docType, id);
        }
      } else if (accountId) {
        await writeTileDraft({ ...localSnapshotRef.current, documentId: id, serverSavedAt: serverSavedAtRef.current }, draftEpoch.current);
      }
      if (!current()) return null;
      // User input can advance during local cleanup, too. Re-store that newer
      // snapshot before reporting the acknowledged revision.
      if (editRevisionRef.current !== savingRevision && accountId) {
        dirtyRef.current = true;
        await writeTileDraft({ ...localSnapshotRef.current, documentId: id, serverSavedAt: serverSavedAtRef.current }, draftEpoch.current);
        if (!current()) return null;
      }
      setSaveState(editRevisionRef.current === savingRevision && !dirtyRef.current ? "saved" : "local");
      if (!deletingScopes.current.has(documentScope) && !routeId && createdDocumentRef.current?.id === id) router.setParams({ id });
      return id;
      } catch (e: any) {
        if (!current()) return null;
        setSaveState("error");
        if (e?.status === 409 && id) setRecoveryDraft({ ...localSnapshotRef.current, documentId: id, serverSavedAt: serverSavedAtRef.current });
        if (!silent) toast.error(e?.detail || "Save failed. Your draft is kept on this device.");
        return null;
      }
    };
    return enqueueQuotationPersist(persistQueue, run);
  }, [header, partner, partnerEditVersion, customerId, customerSnapshot, docId, docType, buildItems, router, rows, loading, localReady, recoveryDraft, restoreError, documentScope, documentGeneration, routeId, accountId]);
  persistRef.current = () => persist({ silent: true });

  // Autosave: create the document on the first meaningful edit, then silently
  // persist every subsequent edit. A new Tiles document used to wait for an
  // explicit workflow/PDF action before it acquired an id, which made the
  // Save-free editor lose a first draft if the tab was closed early.
  useEffect(() => {
    if (customerLookupActive || loading || !localReady || recoveryDraft || restoreError || (routeId && docId !== routeId) || !dirtyRef.current || !header.customerName.trim()) return;
    const timer = setTimeout(() => { void persistRef.current(); }, 400);
    return () => clearTimeout(timer);
  }, [header, partner, partnerEditVersion, rows, docId, loading, localReady, recoveryDraft, restoreError, routeId, customerLookupActive]);

  const generatePdf = useCallback(async () => {
    if (rows.some((row) => row.productId && !row.image?.trim())) {
      toast.error("Every selected tile needs a product image before generating the PDF.");
      return;
    }
    setBusy("pdf");
    try {
      const id = await persist({ silent: false });
      if (!id) return;
      await downloadApiFile(`/quotations/${id}/pdf`, pdfFilename(header.customerName, header.docDate), "PDF", TILES_FLOOR_ID);
    } finally {
      setBusy(null);
    }
  }, [persist, header.customerName, header.docDate, rows]);

  const prepareWhatsApp = useCallback(async () => {
    if (busy) return;
    setBusy("whatsapp"); setWorkflowError(null);
    try {
      const id = await persist({ silent: false });
      if (!id) return;
      setWhatsappDraft(await prepareQuotationWhatsAppDraft(id, TILES_FLOOR_ID));
    } catch (error: any) {
      const message = error?.detail || "Could not prepare the PDF for sharing.";
      setWorkflowError(message); toast.error(message);
    } finally { setBusy(null); }
  }, [busy, persist]);

  const placeOrder = useCallback(async () => {
    if (busy) return;
    setBusy("order");
    const id = await persist({ silent: false });
    setBusy(null);
    if (!id) return;
    if (!buildItems().length) {
      toast.show("Add at least one product first");
      return;
    }
    if (!canPlaceOrder(docType, status)) {
      toast.show("This quotation already has an order");
      return;
    }
    router.push(`/(admin)/tiles/place-order/${id}` as any);
  }, [busy, persist, buildItems, router, docType, status]);

  const workflowAction = nextTilesAction(docType, status);

  const runWorkflowAction = useCallback(async () => {
    const action = nextTilesAction(docType, status);
    if (!action) return;
    if (busy) return;
    setWorkflowError(null);
    setBusy("workflow");
    try {
      if (action.kind === "move_to_quotation") {
        const id = await persist({ silent: false });
        if (!id) return;
      const updated = await api.post<{ id: string; doc_type: string; status: string }>(`/quotations/${id}/move-to-quotation`, undefined, { floorId: TILES_FLOOR_ID });
        toast.success("Moved to Quotation");
        // Move-to-Quotation changes doc_type; the route file (selection.tsx
        // vs quotation.tsx) is what picks Selection vs Quotation paper, so
        // navigate to the sibling route for the same id.
        router.replace(`/(admin)/tiles/quotation?id=${updated.id}` as any);
        return;
      }
    } catch (e: any) {
      const message = e?.detail || e?.message || "Couldn't update the workflow stage";
      setWorkflowError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }, [busy, docType, status, persist, router]);

  const deleteDocument = useCallback(async () => {
    if (busy || deletingScopes.current.has(documentScope)) return false;
    const targetId = persistedIdRef.current || docId;
    const targetDraftId = clientDraftIdRef.current;
    const current = () => mountedRef.current && documentScopeRef.current === documentScope && documentGenerationRef.current === documentGeneration;
    deletingScopes.current.add(documentScope);
    setBusy("delete");
    try {
      const savedId = await persistQueue.current;
      const id = targetId || savedId;
      if (id) await api.delete(`/quotations/${id}`, { floorId: TILES_FLOOR_ID });
      else await api.delete(`/quotations/client-draft/${targetDraftId}?doc_type=${docType}`, { floorId: TILES_FLOOR_ID });
      if (accountId) {
        await removeTileDraft(accountId, docType, routeId || null);
        if (id && id !== routeId) await removeTileDraft(accountId, docType, id);
      }
      if (!current()) return true;
      dirtyRef.current = false;
      toast.success(docType === "tiles_selection" ? "Selection deleted" : "Quotation deleted");
      router.replace("/(admin)/tiles" as any);
      return true;
    } catch (e: any) {
      if (current()) toast.error(e?.detail || "Document could not be deleted");
      return false;
    } finally { deletingScopes.current.delete(documentScope); if (current()) setBusy(null); }
  }, [docId, docType, busy, router, accountId, routeId, documentScope, documentGeneration]);

  const recoverDraft = useCallback(async () => {
    if (!recoveryDraft || busy) return;
    setBusy("recover");
    try {
      let asCopy = false;
      if (recoveryDraft.documentId) {
        try {
          const server = await api.get<any>(`/quotations/${recoveryDraft.documentId}`, { floorId: TILES_FLOOR_ID });
          asCopy = !tileDraftMatchesServer(recoveryDraft, server);
        } catch (error: any) { if (error?.status === 404) asCopy = true; else throw error; }
      }
      if (asCopy && routeId) {
        const copy = { ...recoveryDraft, routeId: null, documentId: null, number: null, serverSavedAt: null, clientDraftId: randomUUID(), rows: recoveryDraft.rows.map(row => ({ ...row, lineId: null })) };
        await writeTileDraft(copy, draftEpoch.current);
        await removeTileDraft(accountId, docType, routeId);
      } else applyLocalDraft(recoveryDraft, asCopy);
      setRecoveryDraft(null);
      if (asCopy) {
        setStatus("draft");
        router.replace(`/(admin)/tiles/${docType === "tiles_selection" ? "selection" : "quotation"}` as any);
        toast.show("Recovered as a new draft because the saved document changed.");
      }
    } catch (error: any) { toast.error(error?.detail || "Could not check the saved document. Your draft is preserved."); }
    finally { setBusy(null); }
  }, [recoveryDraft, busy, applyLocalDraft, router, docType, routeId, accountId]);

  const pickCustomer = useCallback((customer: Customer) => {
    setCustomerId(customer.id);
    customerIdRef.current = customer.id;
    setCustomerSnapshot({ name: customer.name, phone: customer.phone || "" });
    setLegacyPartnerLabel(referrerLabel(customer));
    setPartner(customer.referrer_id && customer.referrer_type ? { id: customer.referrer_id, type: customer.referrer_type, name: customer.referrer_name || "", company: customer.referrer_company } : null);
    setHeader((cur) => ({ ...cur, customerName: customer.name, phone: customer.phone || "", address: customer.address || "", reference: referrerLabel(customer) }));
    markDirty();
  }, [markDirty]);

  return {
    docId, docNumberServer, loading, restoreError, retryRestore: () => setRestoreAttempt((value) => value + 1), header, setHeaderField, rows,
    hasDraft: Boolean(docId || header.customerName || header.address || header.phone || rows.some(row => row.productId)),
    updateRow, addRow, removeRow, applyProduct, selectRowSize, loadRowSizes,
    customers, customerId, pickCustomer, setCustomerId, setCustomerLookupActive, partner, legacyPartnerLabel, referenceScope: documentScope,
    pickPartner: (value: ReferrerValue) => { setPartner(value); setLegacyPartnerLabel(""); setPartnerEditVersion(version => version + 1); markDirty(); },
    saveState, retrySave: () => persist({ silent: true }), busy, generatePdf, placeOrder, serverTotals, previewTotals,
    recoveryDraft, recoverDraft,
    dismissRecovery: () => { setRecoveryDraft(null); if (accountId) void removeTileDraft(accountId, docType, routeId || null); },
    whatsappDraft, closeWhatsApp: () => setWhatsappDraft(null), prepareWhatsApp,
    customerCompleted: Boolean(!loading && completionSnapshot?.completed && completionSnapshot.id === docId && completionSnapshot.customerId === customerId),
    status, stage: tilesStage(docType, status), workflowAction, runWorkflowAction, workflowError, deleteDocument,
  };
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------
function CellInput({
  value, onChangeText, style, placeholder, red, bold, serif, multiline, testID, align = "center",
}: {
  value: string; onChangeText: (t: string) => void;
  style?: any; placeholder?: string; red?: boolean; bold?: boolean; serif?: boolean;
  multiline?: boolean; testID?: string; align?: "left" | "center" | "right";
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#777777"
      multiline={multiline}
      testID={testID}
      style={[
        cellStyles.input,
        { textAlign: align },
        serif ? { fontFamily: SERIF } : null,
        bold ? { fontWeight: "700" } : null,
        red ? { color: "#E00000" } : null,
        style,
      ]}
    />
  );
}

function TileSizeField({
  row, onChangeText, onSelect, onLoad, testID, mobile = false,
}: {
  row: TileRow; onChangeText: (value: string) => void; onSelect: (size: string) => void;
  onLoad: () => void; testID: string; mobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sizes = row.availableSizes;
  useEffect(() => {
    if (row.productId && sizes === undefined) onLoad();
  }, [onLoad, row.productId, sizes]);

  // Unlinked/custom rows retain the legacy editable field. Once a catalog
  // product has been chosen, size is an attribute of that product and is
  // shown read-only unless the style has genuine alternate sizes.
  if (!row.productId) {
    return mobile
      ? <TextField label="Size" value={row.size} onChangeText={onChangeText} testID={testID} />
      : <CellInput value={row.size} onChangeText={onChangeText} bold testID={testID} />;
  }
  if (sizes === undefined) return <Text style={mobile ? mobileStyles.sizeLoading : sizeStyles.loading}>Loading…</Text>;
  if (sizes.length < 2) return <Text style={mobile ? mobileStyles.sizeValue : sizeStyles.value}>{row.size || "—"}</Text>;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={mobile ? mobileStyles.sizeButton : sizeStyles.button}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={`Change size. ${sizes.length} sizes available. Current size ${row.size || "not selected"}`}
      >
        <Text style={mobile ? mobileStyles.sizeButtonText : sizeStyles.buttonText} numberOfLines={1}>{row.size || "Choose size"}</Text>
        <Feather name="chevron-down" size={mobile ? 15 : 11} color={mobile ? colors.brand : "#444"} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={sizeStyles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={sizeStyles.sheet} onPress={(event) => event.stopPropagation()} accessibilityViewIsModal>
            <Text style={sizeStyles.sheetTitle}>Choose tile size</Text>
            <Text style={sizeStyles.sheetHint}>{sizes.length} sizes available for this style</Text>
            {sizes.map((size) => {
              const selected = size === row.size;
              return (
                <Pressable
                  key={size}
                  onPress={() => { setOpen(false); onSelect(size); }}
                  style={[sizeStyles.option, selected && sizeStyles.optionSelected]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  testID={`${testID}-${size}`}
                >
                  <Text style={[sizeStyles.optionText, selected && sizeStyles.optionTextSelected]}>{size}</Text>
                  {selected ? <Feather name="check" size={16} color={colors.onBrand} /> : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const sizeStyles = StyleSheet.create({
  loading: { fontSize: 10, color: "#666", textAlign: "center" },
  value: { fontSize: 12, color: "#111", textAlign: "center" },
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2, maxWidth: "100%", paddingVertical: 3 },
  buttonText: { flexShrink: 1, fontSize: 11, color: "#111", fontWeight: "700", textAlign: "center" },
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: { width: "100%", maxWidth: 360, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.surface },
  sheetTitle: { fontSize: 17, fontWeight: "700", color: colors.onSurface },
  sheetHint: { fontSize: 12, color: colors.onSurfaceSecondary, marginBottom: spacing.xs },
  option: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary },
  optionSelected: { backgroundColor: colors.brand },
  optionText: { fontSize: 14, fontWeight: "600", color: colors.onSurface },
  optionTextSelected: { color: colors.onBrand },
});

const cellStyles = StyleSheet.create({
  input: {
    // Each input owns its own column. RN Web otherwise lets an intrinsic
    // input paint into adjacent columns, making taps focus the wrong field.
    width: "100%", minWidth: 0, alignSelf: "stretch",
    fontSize: 12.5, color: "#111", paddingVertical: 2, paddingHorizontal: 3,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}),
  },
});

function CustomerNameField({
  value, onChangeText, customerId, onPickCustomer, onLookupActive, inputStyle, testID,
}: {
  value: string; onChangeText: (t: string) => void;
  customers: Customer[]; customerId: string | null;
  onPickCustomer: (c: Customer) => void;
  onLookupActive: (active: boolean, owner: object) => void;
  inputStyle?: any; testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  const lookupOwner = useRef<object>({}).current;
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelBlur = useCallback(() => {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    blurTimer.current = null;
  }, []);
  useEffect(() => () => {
    cancelBlur();
    onLookupActive(false, lookupOwner);
  }, [cancelBlur, lookupOwner, onLookupActive]);
  const { staff } = useAuth();
  const [results, setResults] = useState<{ scope: object; rows: Customer[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [lookupError, setLookupError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const query = value.trim();
  const lookupKey = JSON.stringify([staff?.id, query, focused]);
  const lookupRef = useRef({ key: lookupKey });
  if (lookupRef.current.key !== lookupKey) lookupRef.current = { key: lookupKey };
  const generation = lookupRef.current;
  useEffect(() => {
    setResults(null); setLookupError(false); setSearching(false);
    if (!focused || query.length < 2) return;
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void api.get<Customer[]>(`/customers?search=${encodeURIComponent(query)}&limit=20`, { floorId: TILES_FLOOR_ID, signal: controller.signal }).then(rows => {
        if (!controller.signal.aborted && lookupRef.current === generation) setResults({ scope: generation, rows });
      }).catch(() => {
        if (!controller.signal.aborted && lookupRef.current === generation) setLookupError(true);
      }).finally(() => {
        if (!controller.signal.aborted && lookupRef.current === generation) setSearching(false);
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, focused, generation, attempt]);
  const matches = query.length >= 2 && results?.scope === generation ? results.rows : [];
  const exactPicked = customerId && matches.length === 1 && matches[0].id === customerId;
  const show = focused && query.length >= 2 && !exactPicked;
  return (
    <View style={{ flex: 1, zIndex: 400 }}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => { cancelBlur(); setFocused(true); onLookupActive(true, lookupOwner); }}
        onBlur={() => { cancelBlur(); blurTimer.current = setTimeout(() => { blurTimer.current = null; setFocused(false); onLookupActive(false, lookupOwner); }, 180); }}
        accessibilityLabel="Customer name"
        placeholder="Search customer name or phone"
        placeholderTextColor="#999"
        testID={testID}
        style={[cellStyles.input, { textAlign: "left" }, inputStyle]}
      />
      {show ? (
        <View style={suggestStyles.panel}>
          {searching ? <Text role="status" style={suggestStyles.hint}>Finding customers…</Text> : null}
          {lookupError ? <Button label="Retry customer search" variant="secondary" onPress={() => setAttempt(n => n + 1)} /> : null}
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 240 }}>
          {matches.map((c) => (
            <Pressable
              key={c.id}
              accessibilityRole="button"
              accessibilityLabel={`Use ${c.name}, ${c.phone || "no phone"}, ${c.address || "no address"}`}
              testID={`tiles-customer-option-${c.id}`}
              // Both handlers on purpose: onPressIn beats the TextInput's
              // delayed blur-hide for real pointers, while web click events
              // (keyboard, assistive tech, automation) arrive as onPress.
              // Picking twice is idempotent.
              onPressIn={() => { cancelBlur(); onPickCustomer(c); setFocused(false); onLookupActive(false, lookupOwner); }}
              onPress={() => { cancelBlur(); onPickCustomer(c); setFocused(false); onLookupActive(false, lookupOwner); }}
              style={({ hovered }: any) => [suggestStyles.row, hovered && { backgroundColor: colors.brandTint }]}
            >
              <Text style={suggestStyles.name}>{c.name}</Text>
              <Text style={suggestStyles.phone}>{[c.phone, c.address].filter(Boolean).join(" · ") || "No contact details saved"}</Text>
            </Pressable>
          ))}
          </ScrollView>
          {!searching && !lookupError && !matches.length ? <Text style={suggestStyles.hint}>No matching customers. Keep typing to create a new customer.</Text> : null}
          <Text style={suggestStyles.hint}>Pick to reuse an existing customer — or keep typing; changes save automatically.</Text>
        </View>
      ) : null}
    </View>
  );
}

const suggestStyles = StyleSheet.create({
  panel: {
    marginTop: 8,
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    zIndex: 100, overflow: "hidden",
    ...(Platform.OS === "web" ? { boxShadow: "0 10px 28px rgba(0,0,0,0.18)" } as any : {}),
  },
  row: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, gap: 4 },
  name: { fontSize: 16, fontWeight: "600", color: colors.onSurface, flexShrink: 1 },
  phone: { fontSize: 14, color: colors.onSurfaceSecondary, fontVariant: ["tabular-nums"] },
  hint: {
    fontSize: 10, color: colors.onSurfaceMuted, paddingHorizontal: 10, paddingVertical: 5,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.divider,
  },
});

function ProductCell({
  row, onOpenPicker, onChangeName, bold, testID,
}: {
  row: TileRow; onOpenPicker: () => void; onChangeName: (t: string) => void; bold?: boolean; testID?: string;
}) {
  if (!row.productId) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Select a product" onPress={onOpenPicker} style={productStyles.pickTarget} testID={testID}>
        <Feather name="search" size={13} color="#555" />
        <Text style={productStyles.pickLabel}>Select product…</Text>
      </Pressable>
    );
  }
  return (
    <View style={{ flex: 1, alignSelf: "stretch", justifyContent: "center" }}>
      <CellInput value={row.name} onChangeText={onChangeName} bold={bold} multiline testID={testID ? `${testID}-name` : undefined} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Change product from ${row.name}`} onPress={onOpenPicker} hitSlop={8} style={productStyles.swapBtn} testID={testID ? `${testID}-swap` : undefined}>
        <Feather name="refresh-cw" size={11} color="#666" />
      </Pressable>
    </View>
  );
}

const productStyles = StyleSheet.create({
  pickTarget: {
    flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center",
    flexDirection: "row", gap: 6,
  },
  pickLabel: { fontSize: 12, color: "#555", fontStyle: "italic" },
  swapBtn: {
    position: "absolute", right: 2, bottom: 2, width: 28, height: 28,
    alignItems: "center", justifyContent: "center", borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.65)",
  },
});

function RowSideControls({
  isLast, canAdd, onAdd, onRemove, showRemove,
}: {
  isLast: boolean; canAdd: boolean; onAdd: () => void; onRemove: () => void; showRemove: boolean;
}) {
  return (
    <View style={sideStyles.wrap}>
      {/*
        Add/remove sit 8px apart in a 40px rail. Their hitSlop is deliberately
        asymmetric rather than a uniform ~44px pad on both: expanding evenly
        would make the two tap zones overlap in the gap between them, which
        turns "reach for add, land on remove" from a risk into a certainty.
        Each button's hitSlop is generous on the sides that face empty space
        and small on the side that faces the other button.
      */}
      {isLast && canAdd ? (
        <Pressable
          onPress={onAdd}
          style={sideStyles.addBtn}
          hitSlop={{ top: 12, left: 0, right: 8, bottom: 3 }}
          testID="tiles-add-row"
          accessibilityRole="button"
          accessibilityLabel="Add product row"
        >
          <Feather name="plus" size={16} color="#fff" />
        </Pressable>
      ) : null}
      {showRemove ? (
        <Pressable
          onPress={onRemove}
          style={sideStyles.removeBtn}
          hitSlop={{ top: 3, left: 0, right: 10, bottom: 14 }}
          testID="tiles-remove-row"
          accessibilityRole="button"
          accessibilityLabel="Remove row"
        >
          <Feather name="x" size={12} color="#8A3333" />
        </Pressable>
      ) : null}
    </View>
  );
}

const sideStyles = StyleSheet.create({
  wrap: {
    position: "absolute", right: -44, top: 0, bottom: 0,
    alignItems: "center", justifyContent: "center", gap: 8, width: 40,
  },
  addBtn: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: colors.brand,
    alignItems: "center", justifyContent: "center",
    ...(Platform.OS === "web" ? { boxShadow: "0 3px 10px rgba(0,0,0,0.25)" } as any : {}),
  },
  removeBtn: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: "#F6E3E3",
    alignItems: "center", justifyContent: "center",
  },
});

// ---------------------------------------------------------------------------
// Shared page-1 building blocks — identical on Selection & Quotation, and
// mirror backend/pdf_tiles.py's _meta_grid / _brand_terms_signature_block /
// _price_summary_table so the on-screen replica and the generated PDF never
// drift apart. Both papers now render the SAME layout the business supplied
// (logo+title header, 4x2 form grid, brand partners, 12 terms, signature),
// then a PRODUCT DETAILS grid that grows without a row cap — the PDF
// auto-paginates once it overflows a page.
// ---------------------------------------------------------------------------
const BRAND_PARTNERS: [string, string][][] = [
  [["GROHE", "Pure Freude an Wasser"], ["hansgrohe", "Life is Waterful"], ["VitrA", "Design Meets Life"], ["NEXION", "The Surface Experience"], ["QUTONE", "Let's Build Together"]],
  [["DIMORE", "Reflection of Your Style"], ["Oyster", "Indulge in Luxury"], ["GEBERIT", "Engineered for Hygiene"], ["MCM ITTIMI", "Innovation into Inspiration"], ["VERANTES LIVING", "Kitchens & Wardrobes"], ["IMPORTED FURNITURE", "Crafted Beyond Borders"]],
];

const TILES_TERMS = [
  "Prices quoted are based on the current NET prices at the time of selection.",
  "Prices are subject to revision by any brand without prior notice.",
  "100% advance payment is required to confirm orders.",
  "Freight and unloading charges will be applicable as per actuals.",
  "Delivery timelines are subject to the manufacturer's schedule.",
  "Rates are valid for 5 days, unless stated otherwise in writing.",
  "Above rates are inclusive of GST @18%, unless stated otherwise.",
  "All orders and deliveries are subject to material availability.",
  "Prices are subject to change in case of changes in government levy.",
  "Cheques should be written in favour of Buildcon House.",
  "On confirmation of purchase order, material will be delivered within 15 days.",
  "Labour cost is extra and not included in this quotation.",
];

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginTop: 22 }}>
      <BuildConLogo height={40} />
      <View style={{ alignItems: "flex-end" }}>
        <Text style={sectionStyles.headerTitle}>{title}</Text>
        <Text style={sectionStyles.headerSub}>{subtitle}</Text>
      </View>
    </View>
  );
}

function MetaGrid({ doc }: { doc: ReturnType<typeof useTilesDoc> }) {
  const row2 = [
    { label: "REFERENCE", value: doc.header.reference, onChange: (t: string) => doc.setHeaderField("reference", t) },
    { label: "ATTENDED BY", value: doc.header.attendedBy, onChange: (t: string) => doc.setHeaderField("attendedBy", t) },
    { label: "PREPARED BY", value: doc.header.preparedBy, onChange: (t: string) => doc.setHeaderField("preparedBy", t) },
    { label: "ADDRESS", value: doc.header.address, onChange: (t: string) => doc.setHeaderField("address", t) },
  ];
  return (
    <View style={metaStyles.grid}>
      {!doc.partner && doc.legacyPartnerLabel ? <Text style={type.caption}>Recorded reference: {doc.legacyPartnerLabel}</Text> : null}
      <View style={{ marginBottom: 20 }}><ReferrerField key={doc.referenceScope} label="Architect / interior designer" floorId={TILES_FLOOR_ID} value={doc.partner} onChange={doc.pickPartner} /></View>
      <View style={metaStyles.row}>
        <View style={metaStyles.cell}>
          <Text style={metaStyles.label}>CUSTOMER NAME</Text>
          <CustomerNameField
            value={doc.header.customerName}
            onChangeText={(t) => doc.setHeaderField("customerName", t)}
            customers={doc.customers}
            customerId={doc.customerId}
            onPickCustomer={doc.pickCustomer}
            onLookupActive={doc.setCustomerLookupActive}
            inputStyle={metaStyles.value}
            testID="tiles-customer-name"
          />
        </View>
        <View style={metaStyles.cell}>
          <Text style={metaStyles.label}>CONTACT NO.</Text>
          <CellInput value={doc.header.phone} onChangeText={(t) => doc.setHeaderField("phone", t)} style={metaStyles.value} testID="tiles-phone" />
        </View>
        <View style={metaStyles.cell}>
          <Text style={metaStyles.label}>SELECTION / QUOTATION DATE</Text>
          <CellInput value={doc.header.docDate} onChangeText={(t) => doc.setHeaderField("docDate", t)} style={metaStyles.value} testID="tiles-date" />
        </View>
        <View style={metaStyles.cell}>
          <Text style={metaStyles.label}>QUOTATION NO.</Text>
          <CellInput value={doc.header.docNumber} onChangeText={(t) => doc.setHeaderField("docNumber", t)} style={metaStyles.value} testID="tiles-doc-number" />
        </View>
      </View>
      <View style={[metaStyles.row, metaStyles.rowSpacing]}>
        {row2.map((f) => (
          <View key={f.label} style={metaStyles.cell}>
            <Text style={metaStyles.label}>{f.label}</Text>
            <CellInput value={f.value} onChangeText={f.onChange} style={metaStyles.value} testID={`tiles-meta-${f.label}`} />
          </View>
        ))}
      </View>
    </View>
  );
}

function BrandPartnersGrid() {
  return (
    <View style={{ marginTop: 4 }}>
      {BRAND_PARTNERS.map((row, ri) => (
        <View key={ri} style={{ flexDirection: "row" }}>
          {row.map(([name, tagline]) => (
            <View key={name} style={brandStyles.cell}>
              <Text style={brandStyles.name}>{name}</Text>
              <Text style={brandStyles.tagline}>{tagline}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function TermsAndSignatureBlock() {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={sectionStyles.title}>OUR BRAND PARTNERS</Text>
      <BrandPartnersGrid />
      <Text style={[sectionStyles.title, { marginTop: 14 }]}>TERMS &amp; CONDITIONS</Text>
      <View style={{ marginTop: 4, gap: 2 }}>
        {TILES_TERMS.map((term, i) => (
          <Text key={i} style={sectionStyles.term}>{i + 1}. {term}</Text>
        ))}
      </View>
      <Text style={sectionStyles.contact}>
        For general enquiries: <Text style={{ fontWeight: "700" }}>M: +91 99099 06652</Text>  |  <Text style={{ fontWeight: "700" }}>Email: buildconhouse10@gmail.com</Text>
      </Text>
      <View style={sectionStyles.signature}>
        <Text style={sectionStyles.sigNote}>I/We have reviewed and agree to the terms and conditions mentioned in this quotation.</Text>
        <Text style={sectionStyles.sigLabel}>CUSTOMER SIGNATURE &amp; DATE</Text>
      </View>
    </View>
  );
}

function PriceSummary({ totals, doc }: { totals: { boxes: number; subtotal: number; grandTotal: number; transportation: number }; doc: ReturnType<typeof useTilesDoc> }) {
  return (
    <View style={{ marginTop: 14 }}>
      <Text style={sectionStyles.title}>PRICE SUMMARY</Text>
      <View style={priceStyles.table}>
        <View style={priceStyles.row}>
          <Text style={priceStyles.label}>TOTAL QUANTITY</Text>
          <Text style={priceStyles.value}>{totals.boxes ? `${Math.round(totals.boxes * 100) / 100}` : ""}</Text>
        </View>
        <View style={priceStyles.row}>
          <Text style={priceStyles.label}>SUBTOTAL (Rs.)</Text>
          <Text style={priceStyles.value}>{money(totals.subtotal)}</Text>
        </View>
        <View style={priceStyles.row}>
          <Text style={priceStyles.label}>TRANSPORTATION</Text>
          <CellInput
            value={doc.header.transportationFee}
            onChangeText={(value) => doc.setHeaderField("transportationFee", value)}
            style={priceStyles.input}
            testID="tiles-transportation-fee"
          />
        </View>
        <View style={[priceStyles.row, priceStyles.totalRow]}>
          <Text style={[priceStyles.label, priceStyles.totalText]}>TOTAL QUOTE (Rs.)</Text>
          <Text style={[priceStyles.value, priceStyles.totalText]}>{money(totals.grandTotal)}</Text>
        </View>
      </View>
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  headerTitle: { fontSize: 19, fontWeight: "700", color: "#111" },
  headerSub: { fontSize: 11, color: "#444" },
  title: { fontSize: 13, fontWeight: "700", color: "#111", textAlign: "center", marginBottom: 6 },
  term: { fontSize: 10.5, color: "#3A3A3A", textAlign: "center", lineHeight: 15 },
  contact: { fontSize: 11, color: "#111", textAlign: "center", marginTop: 12 },
  signature: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    borderWidth: 1, borderColor: GRID, marginTop: 10, padding: 10, gap: 16,
  },
  sigNote: { fontSize: 10.5, color: "#111", flex: 1 },
  sigLabel: { fontSize: 10.5, fontWeight: "700", color: "#111" },
});

const metaStyles = StyleSheet.create({
  grid: { marginTop: 16 },
  row: { flexDirection: "row" },
  rowSpacing: { marginTop: 10 },
  cell: { flex: 1, paddingHorizontal: 6 },
  label: { fontSize: 10, fontWeight: "700", color: "#111", textAlign: "center", marginBottom: 4 },
  value: { fontSize: 13, color: "#111", textAlign: "center", borderBottomWidth: 1, borderColor: "#333", paddingBottom: 4 },
});

const brandStyles = StyleSheet.create({
  cell: {
    flex: 1, borderWidth: 1, borderColor: GRID, alignItems: "center", justifyContent: "center",
    paddingVertical: 8, paddingHorizontal: 4,
  },
  name: { fontSize: 11, fontWeight: "700", color: "#111", textAlign: "center" },
  tagline: { fontSize: 9, fontStyle: "italic", color: "#111", textAlign: "center", marginTop: 1 },
});

const priceStyles = StyleSheet.create({
  table: { borderWidth: 1, borderColor: GRID, marginTop: 4, alignSelf: "center", width: "70%" },
  row: { flexDirection: "row", borderTopWidth: 1, borderColor: GRID, backgroundColor: HEAD_GREY },
  totalRow: { backgroundColor: "#DADADA" },
  label: { flex: 1.7, fontSize: 11.5, fontWeight: "700", color: "#111", textAlign: "center", paddingVertical: 6 },
  value: { flex: 1, fontSize: 11.5, color: "#111", textAlign: "center", paddingVertical: 6, borderLeftWidth: 1, borderColor: GRID },
  input: { flex: 1, fontSize: 11.5, color: "#111", paddingVertical: 4, borderLeftWidth: 1, borderColor: GRID },
  totalText: { color: "#E00000" },
});

const paperStyles = StyleSheet.create({
  paper: {
    // The preview must use the available editor width. Forcing an A4-like
    // minimum here made desktop overflow horizontally and captured scrolling
    // in the nested scroll view.
    width: "100%", alignSelf: "stretch",
    backgroundColor: "#fff", paddingHorizontal: 30, paddingVertical: 26,
    borderRadius: 2,
    ...(Platform.OS === "web" ? { boxShadow: "0 10px 34px rgba(20,20,20,0.16)" } as any : {}),
  },
  ruleThick: { height: 2, backgroundColor: "#111", marginTop: 8, marginBottom: 2 },
  intro: { fontSize: 12, color: "#111", textAlign: "center", marginTop: 12, lineHeight: 17 },
});

// ---------------------------------------------------------------------------
// SELECTION paper
// ---------------------------------------------------------------------------
// Matches backend/pdf_tiles.py's _SEL_COLS, normalized here as proportions.
// Keeping one column map prevents the editor and generated document drifting.
const SEL_COLS = [11, 70, 35, 74, 32, 59]; // SR / IMAGE / AREA / DETAIL / SIZE / RATE-SQFT
const SEL_COL_TOTAL = SEL_COLS.reduce((total, width) => total + width, 0);

function SelectionPaper(doc: ReturnType<typeof useTilesDoc>) {
  const [pickerRow, setPickerRow] = useState<string | null>(null);
  // Explicit percentage tracks keep every independently-rendered row on the
  // same column geometry, including when a field contains long editable text.
  const flex = (index: number): ViewStyle => ({
    width: `${(SEL_COLS[index] / SEL_COL_TOTAL) * 100}%` as `${number}%`, flexGrow: 0, flexShrink: 0,
  });
  const itemCount = doc.rows.filter((r) => r.productId).length;
  return (
    <View style={{ gap: spacing.lg }}>
      <View style={paperStyles.paper}>
      <SectionHeader title="PRODUCT SELECTION" subtitle="Tiles & Sanitaryware Solutions" />
      <View style={paperStyles.ruleThick} />
      <MetaGrid doc={doc} />
      <Text style={paperStyles.intro}>
        Dear Sir/Madam, thank you for your interest in our products. Please find below the products shortlisted as
        per your selection, for your review and confirmation.
      </Text>
      <TermsAndSignatureBlock />
      </View>

      <View style={paperStyles.paper}>
      <SectionHeader title="PRODUCT DETAILS" subtitle={itemCount ? `Items 1–${itemCount}` : "No items yet"} />
      <View style={paperStyles.ruleThick} />
      <View style={selStyles.table}>
        <View style={[selStyles.tr, { backgroundColor: HEAD_GREY, minHeight: 34 }]}>
          <View style={[selStyles.td, flex(0)]}><Text style={selStyles.th}>{"SR.\nNO."}</Text></View>
          <View style={[selStyles.td, flex(1)]}><Text style={selStyles.th}>PRODUCT IMAGE</Text></View>
          <View style={[selStyles.td, flex(2)]}><Text style={selStyles.th}>AREA</Text></View>
          <View style={[selStyles.td, flex(3)]}><Text style={selStyles.th}>PRODUCT DETAIL</Text></View>
          <View style={[selStyles.td, flex(4)]}><Text style={selStyles.th}>SIZE</Text></View>
          <View style={[selStyles.td, flex(5), { borderRightWidth: 0 }]}>
            <Text style={[selStyles.th, { color: "#E00000" }]}>{"RATE/\nSQ.FT"}</Text>
          </View>
        </View>
        {doc.rows.map((row, index) => (
          <View key={row.key} style={[
            selStyles.tr,
            { minHeight: 92 },
            index === doc.rows.length - 1 && selStyles.lastRow,
            index % 2 === 1 && { backgroundColor: ZEBRA },
          ]}>
            <View style={[selStyles.td, flex(0)]}><Text style={selStyles.cellText}>{index + 1}</Text></View>
            <View style={[selStyles.td, flex(1), { padding: 2 }]}>
              {row.image ? <TileImageCell uri={row.image} /> : null}
            </View>
            <View style={[selStyles.td, flex(2)]}>
              <CellInput value={row.area} onChangeText={(t) => doc.updateRow(row.key, { area: t })} placeholder="Area" multiline testID={`tiles-area-${index}`} />
            </View>
            <View style={[selStyles.td, flex(3)]}>
              <ProductCell
                row={row}
                onOpenPicker={() => setPickerRow(row.key)}
                onChangeName={(t) => doc.updateRow(row.key, { name: t })}
                testID={`tiles-product-${index}`}
              />
            </View>
            <View style={[selStyles.td, flex(4)]}>
              <TileSizeField
                row={row}
                onChangeText={(size) => doc.updateRow(row.key, { size })}
                onSelect={(size) => void doc.selectRowSize(row.key, size)}
                onLoad={() => void doc.loadRowSizes(row.key, row.productId!)}
                testID={`tiles-size-${index}`}
              />
            </View>
            <View style={[selStyles.td, flex(5), { borderRightWidth: 0 }]}>
              <CellInput value={row.rateSqft} onChangeText={(t) => doc.updateRow(row.key, { rateSqft: t })} red bold testID={`tiles-rate-${index}`} />
            </View>
            <RowSideControls
              isLast={index === doc.rows.length - 1}
              canAdd={doc.rows.length < MAX_ROWS}
              onAdd={doc.addRow}
              onRemove={() => doc.removeRow(row.key)}
              showRemove={doc.rows.length > 1}
            />
          </View>
        ))}
      </View>
      </View>

      <TilesProductPicker
        open={pickerRow !== null}
        onClose={() => setPickerRow(null)}
        onPick={(product, history) => { if (pickerRow) doc.applyProduct(pickerRow, product, history); }}
        customerId={doc.customerId}
      />
    </View>
  );
}

const selStyles = StyleSheet.create({
  // Keep every rule on the same physical-pixel grid. Fractional border widths
  // are rounded independently by react-native-web, which lets row dividers
  // and column dividers appear to drift from one another.
  table: { marginTop: 14, borderWidth: 1, borderColor: "#111" },
  tr: { position: "relative", flexDirection: "row", borderBottomWidth: 1, borderColor: "#111", alignItems: "stretch", minWidth: 0 },
  lastRow: { borderBottomWidth: 0 },
  td: {
    borderRightWidth: 1, borderColor: "#111",
    alignItems: "center", justifyContent: "center", paddingHorizontal: 4, paddingVertical: 5,
    // Content must stay inside its allocated flex column; otherwise a long
    // product name or web input can widen one row and misplace its dividers.
    minWidth: 0, overflow: "hidden",
  },
  th: { fontSize: 11, fontWeight: "700", color: "#111", textAlign: "center" },
  cellText: { fontSize: 12.5, color: "#111" },
});

// ---------------------------------------------------------------------------
// QUOTATION paper
// ---------------------------------------------------------------------------
// SR / PRODUCT IMAGE / AREA / PRODUCT DETAIL / SIZE / RATE-SQFT / OFFER RATE /
// RATE-UNIT / QUANTITY / UNIT / TOTAL — mirrors pdf_tiles.py's _QUO_COLS.
// Matches backend/pdf_tiles.py's _QUO_COLS, normalized here as proportions.
const QUO_COLS = [10, 50, 20, 46, 21, 21, 21, 21, 19, 18, 34];
const QUO_COL_TOTAL = QUO_COLS.reduce((total, width) => total + width, 0);

function QuotationPaper(doc: ReturnType<typeof useTilesDoc>) {
  const [pickerRow, setPickerRow] = useState<string | null>(null);
  // Rows are separate flex containers, so the tracks must be explicit rather
  // than inferred from each row's content. This preserves exact divider
  // positions across the header, product rows, and the totals row.
  const flex = (index: number): ViewStyle => ({
    width: `${(QUO_COLS[index] / QUO_COL_TOTAL) * 100}%` as `${number}%`, flexGrow: 0, flexShrink: 0,
  });
  const totals = {
    boxes: 0,
    transportation: doc.previewTotals.transportation,
    subtotal: doc.previewTotals.subtotal,
    grandTotal: doc.previewTotals.grandTotal,
  };
  const itemCount = doc.rows.filter((r) => r.productId).length;

  const headLabels = [
    "SR.\nNO.", "PRODUCT IMAGE", "AREA", "PRODUCT DETAIL", "SIZE",
    "RATE/\nSQ.FT", "OFFER\nRATE", "RATE/\nUNIT", "QUANTITY", "UNIT", "TOTAL\n(Rs.)",
  ];
  return (
    <View style={{ gap: spacing.lg }}>
      <View style={paperStyles.paper}>
      <SectionHeader title="PRODUCT QUOTATION" subtitle="Tiles & Sanitaryware Solutions" />
      <View style={paperStyles.ruleThick} />
      <MetaGrid doc={doc} />
      <Text style={paperStyles.intro}>
        Dear Sir/Madam, thank you for your interest in our products. We are pleased to offer our most competitive
        rates for premium tiles and sanitaryware, prepared as per your selection.
      </Text>
      <PriceSummary totals={totals} doc={doc} />
      <TermsAndSignatureBlock />
      </View>

      <View style={paperStyles.paper}>
      <SectionHeader title="PRODUCT DETAILS" subtitle={itemCount ? `Items 1–${itemCount}` : "No items yet"} />
      <View style={paperStyles.ruleThick} />
      <View style={quoStyles.table}>
        <View style={[quoStyles.tr, { backgroundColor: HEAD_GREY, minHeight: 34 }]}>
          {headLabels.map((h, i) => (
            <View key={h} style={[quoStyles.td, flex(i), i === headLabels.length - 1 && { borderRightWidth: 0 }]}>
              <Text style={[quoStyles.th, i === 5 && { color: "#E00000" }]}>{h}</Text>
            </View>
          ))}
        </View>
        {doc.rows.map((row, index) => (
          <View key={row.key} style={[
            quoStyles.tr,
            { minHeight: 96 },
            index % 2 === 1 && { backgroundColor: ZEBRA },
          ]}>
            <View style={[quoStyles.td, flex(0)]}><Text style={quoStyles.cellText}>{index + 1}</Text></View>
            <View style={[quoStyles.td, flex(1), { padding: 2 }]}>
              {row.image ? <TileImageCell uri={row.image} /> : null}
            </View>
            <View style={[quoStyles.td, flex(2)]}>
              <CellInput value={row.area} onChangeText={(t) => doc.updateRow(row.key, { area: t })} placeholder="Area" multiline testID={`tiles-area-${index}`} />
            </View>
            <View style={[quoStyles.td, flex(3)]}>
              <ProductCell
                row={row}
                bold
                onOpenPicker={() => setPickerRow(row.key)}
                onChangeName={(t) => doc.updateRow(row.key, { name: t })}
                testID={`tiles-product-${index}`}
              />
            </View>
            <View style={[quoStyles.td, flex(4)]}>
              <TileSizeField
                row={row}
                onChangeText={(size) => doc.updateRow(row.key, { size })}
                onSelect={(size) => void doc.selectRowSize(row.key, size)}
                onLoad={() => void doc.loadRowSizes(row.key, row.productId!)}
                testID={`tiles-size-${index}`}
              />
            </View>
            <View style={[quoStyles.td, flex(5)]}>
              <CellInput value={row.rateSqft} onChangeText={(t) => doc.updateRow(row.key, { rateSqft: t })} red bold testID={`tiles-rate-sqft-${index}`} />
            </View>
            <View style={[quoStyles.td, flex(6)]}>
              <CellInput value={row.offerRate} onChangeText={(t) => doc.updateRow(row.key, { offerRate: t })} bold testID={`tiles-offer-rate-${index}`} />
            </View>
            <View style={[quoStyles.td, flex(7)]}>
              <CellInput value={row.rateBox} onChangeText={(t) => doc.updateRow(row.key, { rateBox: t })} testID={`tiles-rate-box-${index}`} />
            </View>
            <View style={[quoStyles.td, flex(8)]}>
              <CellInput value={row.totalBox} onChangeText={(t) => doc.updateRow(row.key, { totalBox: t })} bold testID={`tiles-total-box-${index}`} />
            </View>
            <View style={[quoStyles.td, flex(9)]}>
              <Dropdown
                label={quantityUnitLabel(row.quantityUnit)}
                variant="ghost"
                testID={`tiles-quantity-unit-${index}`}
                items={[
                  { label: "Box", onPress: () => doc.updateRow(row.key, { quantityUnit: "Box" }) },
                  { label: "Piece", onPress: () => doc.updateRow(row.key, { quantityUnit: "Pieces" }) },
                ]}
              />
            </View>
            <View style={[quoStyles.td, flex(10), { borderRightWidth: 0 }]}>
              <CellInput value={lineTotalInputValue(row)} onChangeText={(t) => doc.updateRow(row.key, { total: t })} testID={`tiles-total-${index}`} />
            </View>
            <RowSideControls
              isLast={index === doc.rows.length - 1}
              canAdd={doc.rows.length < MAX_ROWS}
              onAdd={doc.addRow}
              onRemove={() => doc.removeRow(row.key)}
              showRemove={doc.rows.length > 1}
            />
          </View>
        ))}
        <View style={[quoStyles.tr, quoStyles.lastRow, { backgroundColor: HEAD_GREY, minHeight: 30 }]}>
          <View style={[quoStyles.td, flex(0)]} />
          <View style={[quoStyles.td, flex(1)]} />
          <View style={[quoStyles.td, flex(2)]} />
          <View style={[quoStyles.td, flex(3)]}><Text style={[quoStyles.cellText, { fontWeight: "700" }]}>TOTAL</Text></View>
          <View style={[quoStyles.td, flex(4)]} />
          <View style={[quoStyles.td, flex(5)]} />
          <View style={[quoStyles.td, flex(6)]} />
          <View style={[quoStyles.td, flex(7)]} />
          <View style={[quoStyles.td, flex(8)]} />
          <View style={[quoStyles.td, flex(9)]} />
          <View style={[quoStyles.td, flex(10), { borderRightWidth: 0 }]}>
            <Text style={[quoStyles.cellText, { fontWeight: "700" }]}>{money(totals.subtotal)}</Text>
          </View>
        </View>
      </View>
      </View>

      <TilesProductPicker
        open={pickerRow !== null}
        onClose={() => setPickerRow(null)}
        onPick={(product, history) => { if (pickerRow) doc.applyProduct(pickerRow, product, history); }}
        customerId={doc.customerId}
      />
    </View>
  );
}

const quoStyles = StyleSheet.create({
  // Use whole-pixel rules throughout the grid. Mixed 1.25px internal lines
  // and 1.5px outer borders created browser rounding seams between rows.
  table: { marginTop: 14, borderWidth: 1, borderColor: "#111" },
  // Product entries are deliberately horizontal rows: the same flex column
  // proportions are used by the header, each product and the total row.
  tr: { position: "relative", flexDirection: "row", borderBottomWidth: 1, borderColor: "#111", alignItems: "stretch", backgroundColor: "#fff", minWidth: 0 },
  lastRow: { borderBottomWidth: 0 },
  td: {
    borderRightWidth: 1, borderColor: "#111",
    alignItems: "center", justifyContent: "center", paddingHorizontal: 6, paddingVertical: 8,
    minWidth: 0, overflow: "hidden",
  },
  th: { fontSize: 10.2, fontWeight: "700", color: "#111", textAlign: "center" },
  cellText: { fontSize: 12, color: "#111" },
});

// ---------------------------------------------------------------------------
// MOBILE EDITOR (phone widths only) — application-first presentation of the
// exact same `doc` returned by useTilesDoc() above. See the file header for
// why this exists as a genuinely separate presentation rather than a
// reflowed/scaled paper. Every handler called below (updateRow, addRow,
// removeRow, applyProduct, setHeaderField, generatePdf,
// placeOrder, runWorkflowAction, pickCustomer) is the identical function the
// paper views call — one document model, one autosave path, one set of
// backend calls.
// ---------------------------------------------------------------------------
type MobileFieldKey = "area" | "size" | "rateSqft" | "offerRate" | "rateBox" | "totalBox" | "quantityUnit" | "total";
type MobileFieldDef = { key: MobileFieldKey; label: string; numeric?: boolean; suffix?: string };

// Mirrors SEL_COLS / QUO_COLS above — Selection intentionally carries only
// the fields the printed selection sheet has (no pricing beyond rate/sqft);
// Quotation carries the full pricing grid. Keeping this list in sync with
// the paper's own column set is a manual but small surface (3 vs 9 fields).
const MOBILE_FIELDS: Record<TilesDocType, MobileFieldDef[]> = {
  tiles_selection: [
    { key: "area", label: "Area / Room" },
    { key: "size", label: "Size" },
    { key: "rateSqft", label: "Rate / Sq.Ft", numeric: true, suffix: "per sq.ft" },
  ],
  tiles_quotation: [
    { key: "area", label: "Area / Room" },
    { key: "size", label: "Size" },
    { key: "rateSqft", label: "Rate / Sq.Ft", numeric: true },
    { key: "offerRate", label: "Offer Rate", numeric: true },
    { key: "rateBox", label: "Rate / Unit", numeric: true },
    { key: "totalBox", label: "Quantity", numeric: true },
    { key: "quantityUnit", label: "Unit" },
    { key: "total", label: "Line Total (Rs.)", numeric: true },
  ],
};

function SaveStatusPill({ state, onRetry }: { state: "idle" | "local" | "saving" | "saved" | "error"; onRetry: () => void }) {
  if (state === "idle") return null;
  const meta = {
    local: { label: "Draft saved on this device", tone: colors.onSurfaceMuted, icon: "save" as const },
    saving: { label: "Saving…", tone: colors.onSurfaceMuted, icon: "loader" as const },
    saved: { label: "All changes saved", tone: colors.success, icon: "check-circle" as const },
    error: { label: "Could not sync this draft. Retry save.", tone: colors.error, icon: "alert-circle" as const },
  }[state];
  return (
    <View role={state === "error" ? "alert" : "status"} style={[mobileStyles.savePill, { flexWrap: "wrap" }]}>
      <Feather name={meta.icon} size={12} color={meta.tone} />
      <Text style={[mobileStyles.savePillText, { color: meta.tone }]}>{meta.label}</Text>
      {state === "error" ? <Button label="Retry save" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

function SummaryLine({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={mobileStyles.summaryLine}>
      <Text style={[mobileStyles.summaryLabel, bold && mobileStyles.summaryBold]}>{label}</Text>
      <Text style={[mobileStyles.summaryValue, bold && mobileStyles.summaryBold]}>{value}</Text>
    </View>
  );
}

function MobileRowCard({
  doc, row, index, docType, onOpenPicker, fieldColumns, isPhone,
}: {
  doc: ReturnType<typeof useTilesDoc>; row: TileRow; index: number; docType: TilesDocType; onOpenPicker: () => void; fieldColumns: number; isPhone: boolean;
}) {
  const fields = MOBILE_FIELDS[docType];
  const compact = fieldColumns > 1;
  return (
    <View style={mobileStyles.rowCard} testID={`mobile-row-${index}`}>
      <View style={mobileStyles.productHeader}>
      {row.productId ? (
      <Pressable accessibilityRole="button" onPress={onOpenPicker} style={mobileStyles.productImage} testID={`mobile-thumb-${index}`} accessibilityLabel={row.productId ? "Change product image" : "Select product image"}>
          {row.image ? (
            <ProductImage source={row.image} contentFit="contain" frameInset={0} borderRadius={radius.md} disableSkeleton frameBackground={colors.surface} style={{ width: "100%", height: "100%" }} accessibilityLabel="Quotation product image" />
          ) : (
            <Feather name="image" size={18} color={colors.onSurfaceMuted} />
          )}
      </Pressable>
      ) : null}
      <View style={mobileStyles.rowHeading}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={mobileStyles.rowIndex}>Item {index + 1}</Text>
          {row.productId ? (
            <>
              <TextInput
                value={row.name}
                onChangeText={(t) => doc.updateRow(row.key, { name: t })}
                multiline
                accessibilityLabel={`Product name for item ${index + 1}`}
                style={mobileStyles.rowTitleInput}
                testID={`mobile-name-${index}`}
              />
              <Pressable accessibilityRole="button" accessibilityLabel={`Change product from ${row.name}`} onPress={onOpenPicker} style={mobileStyles.swapRow} testID={`mobile-swap-${index}`}>
                <Feather name="refresh-cw" size={11} color={colors.brand} />
                <Text style={mobileStyles.swapLabel}>Change product</Text>
              </Pressable>
            </>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel="Select a product" onPress={onOpenPicker} style={mobileStyles.selectBtn} testID={`mobile-select-product-${index}`}>
              <Feather name="search" size={14} color={colors.brand} />
              <Text style={mobileStyles.selectLabel}>Select product…</Text>
            </Pressable>
          )}
        </View>
        {index > 0 || doc.rows.length > 1 ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${row.name || `product row ${index + 1}`}`} onPress={() => doc.removeRow(row.key)} style={mobileStyles.deleteBtn} testID={`mobile-remove-row-${index}`}>
            <Feather name="trash-2" size={15} color={colors.error} />
          </Pressable>
        ) : null}
      </View>
      </View>

      <View style={[mobileStyles.fieldStack, compact && mobileStyles.fieldGrid]}>
        {fields.map((f) => (
          <View key={f.key} style={compact && !(isPhone && f.key === "area") ? { width: fieldColumns === 3 ? "32%" : "49%", minWidth: 0 } : mobileStyles.fieldFull}>
            {f.key === "size" ? (
              <View style={{ gap: spacing.sm }}>
                {row.productId ? <Text style={type.label}>Size</Text> : null}
                <TileSizeField
                  row={row}
                  onChangeText={(size) => doc.updateRow(row.key, { size })}
                  onSelect={(size) => void doc.selectRowSize(row.key, size)}
                  onLoad={() => void doc.loadRowSizes(row.key, row.productId!)}
                  testID={`mobile-${f.key}-${index}`}
                  mobile
                />
              </View>
            ) : f.key === "quantityUnit" ? (
              <>
                <Text style={type.label}>Unit</Text>
                <Dropdown
                  label={quantityUnitLabel(row.quantityUnit)}
                  variant="secondary"
                  testID={`mobile-quantity-unit-${index}`}
                  items={[
                    { label: "Box", onPress: () => doc.updateRow(row.key, { quantityUnit: "Box" }) },
                    { label: "Piece", onPress: () => doc.updateRow(row.key, { quantityUnit: "Pieces" }) },
                  ]}
                />
              </>
            ) : (
              <TextField
                label={f.key === "rateBox" ? `Rate / ${quantityUnitLabel(row.quantityUnit)}` : f.key === "totalBox" ? "Quantity" : f.label}
                value={f.key === "total" ? lineTotalInputValue(row) : (row as any)[f.key]}
                onChangeText={(t: string) => doc.updateRow(row.key, { [f.key]: t } as Partial<TileRow>)}
                keyboardType={f.numeric ? "decimal-pad" : "default"}
                testID={`mobile-${f.key}-${index}`}
                helper={f.suffix}
              />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

function MobileTilesEditor({
  docType, doc, router, onDelete, canDelete, workspaceWidth,
}: { docType: TilesDocType; doc: ReturnType<typeof useTilesDoc>; router: ReturnType<typeof useRouter>; onDelete: () => void; canDelete: boolean; workspaceWidth: number }) {
  const { isPhone } = useBp();
  const { fontScale } = useWindowDimensions();
  // Pair short fields where they fit; larger accessibility text reclaims a column.
  const fieldWidth = workspaceWidth / Math.max(1, fontScale);
  const fieldColumns = fieldWidth >= 720 ? 3 : fieldWidth >= 360 ? 2 : 1;
  const splitCustomerFields = !isPhone && fieldColumns > 1;
  const insets = useSafeAreaInsets();
  const inputActive = useInputActive();
  const [pickerRow, setPickerRow] = useState<string | null>(null);
  const isSelection = docType === "tiles_selection";
  const title = isSelection ? "Tiles Selection" : "Tiles Quotation";
  const itemCount = doc.rows.filter((r) => r.productId).length;

  // Identical math to QuotationPaper's totals useMemo above — same inputs,
  // same result, just computed again here since the paper components aren't
  // mounted on phone. Kept deliberately tiny (a for-loop over `doc.rows`) so
  // a future refactor that hoists this into useTilesDoc() has almost nothing
  // to move.
  const totals = useMemo(() => {
    const boxes = doc.rows.reduce((sum, row) => sum + (row.productId ? num(row.totalBox) : 0), 0);
    return {
      boxes,
      subtotal: doc.previewTotals.subtotal,
      grandTotal: doc.previewTotals.grandTotal,
      transportation: isSelection ? 0 : doc.previewTotals.transportation,
    };
  }, [doc.rows, doc.previewTotals, isSelection]);

  // Keep the workflow CTA in the sticky mobile action bar even when a saved
  // quotation has reached the order step. This prevents the action from
  // disappearing below the paper/editor on narrow screens.
  const primaryAction = doc.workflowAction
    ? { label: doc.workflowAction.label, onPress: doc.runWorkflowAction, loading: doc.busy === "workflow", icon: doc.workflowAction.kind === "move_to_quotation" ? "arrow-right-circle" as const : "check-circle" as const }
    : !isSelection
      ? { label: "Place Order", onPress: doc.placeOrder, loading: doc.busy === "order", icon: "shopping-cart" as const }
      : null;

  return (
    <SafeAreaView style={{ flex: 1, minHeight: 0, overflow: "hidden", backgroundColor: colors.surfaceSecondary }} edges={isPhone ? [] : ["top"]}>
      <View style={mobileStyles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={shellStyles.backBtn} testID="tiles-back">
          <Feather name="chevron-left" size={20} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={type.overline}>Ground Floor · Tiles</Text>
          <Text style={[type.titleMd, { marginTop: 1 }]} numberOfLines={1}>
            {title}{doc.docNumberServer ? `  ·  ${doc.docNumberServer}` : ""}
          </Text>
          {doc.customerCompleted ? <Text testID="quotation-customer-completed" style={[type.caption, { color: colors.success }]}>100% completed</Text> : null}
        </View>
        {doc.hasDraft && canDelete ? <Dropdown
          testID="tiles-mobile-menu"
          label="More"
          icon="more-vertical"
          variant="ghost"
          items={[
            { label: doc.docId ? isSelection ? "Delete selection" : "Delete quotation" : "Discard draft", icon: "trash-2" as const, onPress: onDelete },
          ]}
        /> : null}
      </View>

      {doc.loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <KeyboardAvoidingView style={{ flex: 1, minHeight: 0 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}>
          <ScrollView
            testID="tiles-mobile-editor-scroll"
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
            keyboardShouldPersistTaps="handled"
          >
            <SaveStatusPill state={doc.saveState} onRetry={() => void doc.retrySave()} />
            {doc.workflowError ? <Text role="alert" style={{ color: colors.error, fontSize: 13 }}>{doc.workflowError}</Text> : null}

            <Card padding={spacing.md} style={{ gap: spacing.md }}>
              <Text style={mobileStyles.sectionTitle}>CUSTOMER &amp; DETAILS</Text>
              <View style={[mobileStyles.fieldStack, splitCustomerFields && mobileStyles.fieldGrid]}>
                <View style={splitCustomerFields ? mobileStyles.halfField : mobileStyles.fieldFull}><FormFieldCustomerName doc={doc} /></View>
                <View style={splitCustomerFields ? mobileStyles.halfField : mobileStyles.fieldFull}><TextField label="Contact no." value={doc.header.phone} onChangeText={(t: string) => doc.setHeaderField("phone", t)} keyboardType="phone-pad" testID="mobile-phone" /></View>
              </View>
              <Disclosure title="Document details">
                <View style={mobileStyles.fieldFull}>
                  <TextField label="Date" value={doc.header.docDate} onChangeText={(t: string) => doc.setHeaderField("docDate", t)} testID="mobile-date" />
                </View>
                <View style={mobileStyles.fieldFull}>
                  <TextField label={isSelection ? "Selection no." : "Quotation no."} value={doc.header.docNumber} onChangeText={(t: string) => doc.setHeaderField("docNumber", t)} testID="mobile-doc-number" />
                </View>
                <View style={mobileStyles.fieldFull}>
                  {!doc.partner && doc.legacyPartnerLabel ? <Text style={type.caption}>Recorded reference: {doc.legacyPartnerLabel}</Text> : null}
      <ReferrerField key={doc.referenceScope} label="Architect / interior designer" floorId={TILES_FLOOR_ID} value={doc.partner} onChange={doc.pickPartner} />
                  <TextField label="Reference" value={doc.header.reference} onChangeText={(t: string) => doc.setHeaderField("reference", t)} testID="mobile-reference" />
                </View>
                <View style={mobileStyles.fieldFull}>
                  <TextField label="Attended by" value={doc.header.attendedBy} onChangeText={(t: string) => doc.setHeaderField("attendedBy", t)} testID="mobile-attended-by" />
                </View>
                <View style={mobileStyles.fieldFull}>
                  <TextField label="Prepared by" value={doc.header.preparedBy} onChangeText={(t: string) => doc.setHeaderField("preparedBy", t)} testID="mobile-prepared-by" />
                </View>
              </Disclosure>
              <TextField label={isSelection ? "Address" : "Address (required)"} value={doc.header.address} onChangeText={(t: string) => doc.setHeaderField("address", t)} multiline testID="mobile-address" />
            </Card>

            <View style={{ gap: spacing.sm }}>
              <Text style={mobileStyles.sectionTitle}>PRODUCTS{itemCount ? ` (${itemCount})` : ""}</Text>
              {doc.rows.map((row, index) => (
                <MobileRowCard key={row.key} doc={doc} row={row} index={index} docType={docType} fieldColumns={fieldColumns} isPhone={isPhone} onOpenPicker={() => setPickerRow(row.key)} />
              ))}
              <Button
                label="Add product" icon="plus" variant="secondary" fullWidth
                onPress={doc.addRow} disabled={doc.rows.length >= MAX_ROWS}
                testID="mobile-add-row"
              />
            </View>

            {!isSelection ? (
              <Card padding={spacing.md} style={{ gap: 2 }}>
                <Text style={[mobileStyles.sectionTitle, { marginBottom: 6 }]}>PRICE SUMMARY</Text>
                <TextField label="Transportation fee" value={doc.header.transportationFee} onChangeText={(t: string) => doc.setHeaderField("transportationFee", t)} keyboardType="decimal-pad" testID="mobile-transportation-fee" />
                <SummaryLine label="Total boxes" value={totals.boxes ? String(Math.round(totals.boxes * 100) / 100) : "—"} />
                <SummaryLine label="Subtotal" value={money(totals.subtotal)} />
                <SummaryLine label="Transportation" value={money(totals.transportation)} />
                <SummaryLine label="Total quote" value={money(totals.grandTotal)} bold />
              </Card>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      {/* Keep actions mounted, but reclaim their entire height while editing.
          The shared focus hook also waits for blur-triggering presses to settle.
          Android already resizes the app for its keyboard; another height
          adjustment or a measured absolute footer would shrink/cover the form. */}
      <View
        testID="tiles-mobile-workflow-dock"
        pointerEvents={inputActive ? "none" : "auto"}
        accessibilityElementsHidden={inputActive}
        importantForAccessibility={inputActive ? "no-hide-descendants" : "auto"}
        aria-hidden={inputActive}
        style={[mobileStyles.bottomBar, { paddingBottom: Math.max(spacing.md, insets.bottom + spacing.sm) }, inputActive && mobileStyles.bottomBarHidden]}
      >
        <Button label="Share PDF" icon="message-circle" onPress={doc.prepareWhatsApp} loading={doc.busy === "whatsapp"} disabled={!!doc.busy} variant="secondary" testID="tiles-mobile-whatsapp-draft" />
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <Button
            label="Download PDF" icon="download" onPress={doc.generatePdf}
            loading={doc.busy === "pdf"} variant={primaryAction ? "secondary" : "primary"} size="lg"
            style={{ flex: 1 }} testID="tiles-mobile-download-pdf"
          />
          {primaryAction ? (
            <Button
              label={primaryAction.label} icon={primaryAction.icon} onPress={primaryAction.onPress}
              loading={primaryAction.loading} variant="primary" size="lg"
              style={{ flex: 1 }} testID="tiles-mobile-primary-action"
            />
          ) : null}
        </View>
      </View>

      <TilesProductPicker
        open={pickerRow !== null}
        onClose={() => setPickerRow(null)}
        onPick={(product, history) => { if (pickerRow) doc.applyProduct(pickerRow, product, history); }}
        customerId={doc.customerId}
      />
    </SafeAreaView>
  );
}

// Customer name field needs the same autocomplete-against-existing-customers
// behavior as the paper's CustomerNameField, styled for a full-width mobile
// TextField instead of an underlined paper cell.
function FormFieldCustomerName({ doc }: { doc: ReturnType<typeof useTilesDoc> }) {
  return <View style={{ zIndex: 200, gap: spacing.sm }}>
    <Text style={type.bodyStrong}>Customer name</Text>
    <CustomerNameField value={doc.header.customerName} onChangeText={value => doc.setHeaderField("customerName", value)}
      customers={doc.customers} customerId={doc.customerId} onPickCustomer={doc.pickCustomer} onLookupActive={doc.setCustomerLookupActive}
      inputStyle={{ minHeight: 48, fontSize: 16, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md }}
      testID="mobile-customer-name" />
  </View>;
}

const mobileStyles = StyleSheet.create({
  header: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sectionTitle: { ...type.overline, color: colors.onSurfaceMuted },
  savePill: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  savePillText: { fontSize: 12, fontFamily: type.body.fontFamily, fontWeight: "600" },
  fieldStack: { gap: spacing.sm },
  fieldGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: spacing.sm, columnGap: 0 },
  halfField: { width: "49%", minWidth: 0 },
  fieldFull: { width: "100%" },
  sizeLoading: { minHeight: 46, paddingHorizontal: spacing.md, paddingVertical: 14, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, color: colors.onSurfaceMuted, fontSize: 13 },
  sizeValue: { minHeight: 46, paddingHorizontal: spacing.md, paddingVertical: 14, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, color: colors.onSurface, fontSize: 14 },
  sizeButton: { minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.brand, backgroundColor: colors.brandTint },
  sizeButtonText: { flex: 1, minWidth: 0, color: colors.onSurface, fontSize: 14, fontWeight: "600" },
  rowCard: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    padding: spacing.md, gap: spacing.md,
  },
  productHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  productImage: {
    width: 88, minHeight: 44, flexShrink: 0, aspectRatio: TILE_IMAGE_ASPECT_RATIO, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary,
    alignItems: "center", justifyContent: "center", overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  rowHeading: { flex: 1, minWidth: 0, flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  rowIndex: { ...type.overline, color: colors.onSurfaceMuted, marginBottom: 2 },
  rowTitleInput: {
    fontSize: 16, fontFamily: type.titleMd.fontFamily, fontWeight: "600", color: colors.onSurface,
    minHeight: 44, padding: 0, ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}),
  },
  swapRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 4 },
  swapLabel: { fontSize: 12, color: colors.brand, fontWeight: "600" },
  selectBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md,
    backgroundColor: colors.brandTint, minHeight: 44,
  },
  selectLabel: { fontSize: 13, color: colors.brand, fontWeight: "600" },
  deleteBtn: {
    width: 44, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surfaceSecondary,
  },
  summaryLine: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  summaryLabel: { fontSize: 13, color: colors.onSurfaceSecondary },
  summaryValue: { fontSize: 13, color: colors.onSurface, fontVariant: ["tabular-nums"] },
  summaryBold: { fontWeight: "700", color: colors.onSurface, fontSize: 14 },
  bottomBar: {
    flexShrink: 0, gap: spacing.sm,
    padding: spacing.md, paddingBottom: spacing.lg, backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  bottomBarHidden: {
    opacity: 0, position: "absolute", top: "100%", left: 0, right: 0,
    ...(Platform.OS === "web" ? { visibility: "hidden" } as ViewStyle : {}),
  },
  suggestPanel: {
    marginTop: 8, zIndex: 300,
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: "hidden",
    ...(Platform.OS === "web" ? { boxShadow: "0 10px 28px rgba(0,0,0,0.18)" } as any : {}),
  },
  suggestRow: { paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", justifyContent: "space-between", gap: 8 },
  suggestName: { fontSize: 13, fontWeight: "600", color: colors.onSurface, flexShrink: 1 },
  suggestPhone: { fontSize: 12, color: colors.onSurfaceSecondary, fontVariant: ["tabular-nums"] },
});

// ---------------------------------------------------------------------------
// Page shell — topbar with the action buttons + scrollable paper
// ---------------------------------------------------------------------------
export function TilesDocBuilder({ docType, initialProductId, initialQuotationId }: { docType: TilesDocType; initialProductId?: string | null; initialQuotationId?: string | null }) {
  const router = useRouter();
  const doc = useTilesDoc(docType, initialProductId, initialQuotationId);
  const { isPhone, isTablet } = useBp();
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const isSelection = docType === "tiles_selection";
  const title = isSelection ? "Tiles Selection" : "Tiles Quotation";
  const { staff } = useAuth();
  const canDelete = useActionAccess("tiles", "delete", canManageDestructiveData(staff?.role));
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const currentDeleteId = doc.docId || "local-draft";
  const confirmDelete = () => { if (doc.hasDraft && canDelete && !doc.busy) setDeleteTargetId(currentDeleteId); };

  // Device width is not the usable document width: the admin sidebar/rail
  // occupies part of the viewport. Do not mount an 820px paper unless the
  // actual workspace can contain it plus its gutters; otherwise use the
  // reflowed editor and avoid a nested horizontal scroll.
  const useResponsiveEditor = isPhone
    || isTablet
    || (workspaceWidth > 0 && workspaceWidth < PAPER_W + spacing.lg + 64);

  // Keep this measured host mounted across restore/error/retry. Replacing
  // it with an unmeasured loading View can leave the hydrated tablet editor
  // at width zero, permanently selecting its one-column phone geometry.
  return (
    <View style={{ flex: 1, minWidth: 0, minHeight: 0 }} onLayout={(event) => setWorkspaceWidth(event.nativeEvent.layout.width)}>
      <ConfirmDialog visible={!!deleteTargetId && deleteTargetId === currentDeleteId} onClose={() => { if (doc.busy !== "delete") setDeleteTargetId(null); }}
        onConfirm={() => { if (deleteTargetId === currentDeleteId && canDelete) void doc.deleteDocument().then(deleted => { if (deleted) setDeleteTargetId(null); }); }}
        title={`Delete this ${isSelection ? "selection" : "quotation"}?`}
        description={doc.docId ? "Linked follow-ups and unpaid payment records will be removed. Completed payments and purchase orders are protected." : "The draft saved on this device will be removed."}
        confirmLabel="Delete" tone="danger" loading={doc.busy === "delete"} testID="confirm-delete-tiles-document" />
      {doc.recoveryDraft ? <View style={{ padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surface }}>
        <Text style={type.body}>Unsaved tile changes were recovered. Restore them to continue; newer saved changes will be protected.</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          <Button label="Restore draft" onPress={doc.recoverDraft} loading={doc.busy === "recover"} testID="tiles-restore-local-draft" />
          <Button label="Discard recovered draft" onPress={doc.dismissRecovery} variant="secondary" disabled={!!doc.busy} testID="tiles-discard-local-draft" />
        </View>
      </View> : null}
      {doc.loading ? (
        <View accessibilityLabel="Loading tile document" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.brand} /></View>
      ) : doc.restoreError ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md }}>
          <Feather name="alert-circle" size={28} color={colors.error} />
          <Text style={[type.titleMd, { textAlign: "center" }]}>Couldn&apos;t open this tile document</Text>
          <Text style={{ color: colors.onSurfaceSecondary, textAlign: "center" }}>{doc.restoreError}</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <ActionBtn label="Back" icon="chevron-left" onPress={() => router.back()} testID="tiles-restore-back" />
            <ActionBtn label="Retry" icon="refresh-cw" primary onPress={doc.retryRestore} testID="tiles-restore-retry" />
          </View>
        </View>
      ) : <>
      <WhatsAppQuotationSheet draft={doc.whatsappDraft} onClose={doc.closeWhatsApp} />
      {useResponsiveEditor ? <MobileTilesEditor docType={docType} doc={doc} router={router} onDelete={confirmDelete} canDelete={canDelete} workspaceWidth={workspaceWidth} /> : (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surfaceSecondary }} edges={["top"]}>
      <View style={shellStyles.topbar}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={shellStyles.backBtn} testID="tiles-back">
            <Feather name="chevron-left" size={20} color={colors.onSurface} />
          </Pressable>
          <View style={{ minWidth: 0, flex: 1 }}>
            <Text style={type.overline}>Ground Floor · Tiles</Text>
            <Text style={[type.titleMd, { marginTop: 1 }]} numberOfLines={1}>
              {title}{doc.docNumberServer ? `  ·  ${doc.docNumberServer}` : ""}
            </Text>
            {doc.customerCompleted ? <Text testID="quotation-customer-completed" style={[type.caption, { color: colors.success }]}>100% completed</Text> : null}
          </View>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "flex-end", flexShrink: 1 }}>
          {doc.workflowAction ? (
            <ActionBtn
              label={doc.workflowAction.label}
              icon={doc.workflowAction.kind === "move_to_quotation" ? "arrow-right-circle" : "check-circle"}
              onPress={doc.runWorkflowAction}
              loading={doc.busy === "workflow"}
              testID="tiles-workflow-action"
            />
          ) : null}
          <ActionBtn label="Share PDF" icon="message-circle" onPress={doc.prepareWhatsApp} loading={doc.busy === "whatsapp"} testID="tiles-whatsapp-draft" />
          <ActionBtn
            label={isSelection ? "Generate selection PDF" : "Generate quotation PDF"}
            icon="file-text"
            primary
            onPress={doc.generatePdf}
            loading={doc.busy === "pdf"}
            testID="tiles-generate-pdf"
          />
          {!isSelection ? (
            <ActionBtn label="Place Order" icon="shopping-cart" onPress={doc.placeOrder} loading={doc.busy === "order"} testID="tiles-place-order" />
          ) : null}
          {doc.hasDraft && canDelete ? <ActionBtn label={doc.docId ? "Delete" : "Discard draft"} icon="trash-2" onPress={confirmDelete} loading={doc.busy === "delete"} testID="tiles-delete" /> : null}
        </View>
      </View>

      {doc.loading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, paddingBottom: 80 }}>
          <SaveStatusPill state={doc.saveState} onRetry={() => void doc.retrySave()} />
          {doc.workflowError ? <Text role="alert" style={{ color: colors.error }}>{doc.workflowError}</Text> : null}
          {isSelection ? <SelectionPaper {...doc} /> : <QuotationPaper {...doc} />}
        </ScrollView>
      )}
    </SafeAreaView>
      )}
      </>}
    </View>
  );
}

function ActionBtn({
  label, icon, onPress, primary, loading, testID,
}: {
  label: string; icon: any; onPress: () => void; primary?: boolean; loading?: boolean; testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!loading, busy: !!loading }}
      onPress={onPress}
      disabled={loading}
      testID={testID}
      style={({ pressed }) => [
        shellStyles.actionBtn,
        primary && { backgroundColor: colors.brand, borderColor: colors.brand },
        { opacity: pressed || loading ? 0.75 : 1 },
      ]}
    >
      {loading
        ? <ActivityIndicator size="small" color={primary ? "#fff" : colors.brand} />
        : <Feather name={icon} size={13} color={primary ? "#fff" : colors.onSurface} />}
      <Text style={[shellStyles.actionLabel, primary && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const shellStyles = StyleSheet.create({
  topbar: {
    flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: spacing.lg, paddingVertical: 10, gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  backBtn: {
    width: 44, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface,
  },
  actionBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, height: 44, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  actionLabel: { fontSize: 13, fontFamily: type.titleMd.fontFamily, fontWeight: "600", color: colors.onSurface },
});
