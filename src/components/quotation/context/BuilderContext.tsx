// BuilderContext
// -----------------------------------------------------------------------------
// The single source of truth for the Quotation Builder. Every mutation flows
// through this provider so undo/redo, autosave, and derived views stay in sync.
//
// Consumers grab whichever slice they need via the exported hooks:
//   * useBuilder()          full API (mutations, sheets, refs)
//   * useBuilderState()     just the undoable state
//   * useBuilderTotals()    memoised totals
//   * useBuilderRows()      flat DnD rows
//   * useHistoryApi()       history-only view
//
// Presentation components remain stateless and pluggable.
// -----------------------------------------------------------------------------
import * as Haptics from "expo-haptics";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform, TextInput } from "react-native";

import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { useHistory, useUndoRedoShortcuts } from "@/src/hooks/useHistory";
import { useAuth } from "@/src/state/auth";
import { builderDraftEpoch, readBuilderDraft, writeBuilderDraft, removeBuilderDraft } from "../helpers/draftStorage";
import { draftNeedsCopy, moveWithinRoom, type BuilderDraft } from "../helpers/draftRecovery";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import type { HistoryApi } from "@/src/hooks/useHistory";
import { playAddProductSound } from "@/src/services/soundService";
import { catalogReferences, CATALOG_PAGE_SIZE, fetchCatalogPage } from "@/src/services/catalogService";
import { downloadApiFile } from "@/src/utils/downloadFile";

import { computeTotals, computeLineBreakdown, type LineBreakdown } from "../helpers/pricing";
import { enqueueQuotationPersist } from "../helpers/autosave";
import { productImageList } from "../helpers/media";
import { addProductAndConcealedPart, syncDefaultIncludedParts } from "../helpers/concealedParts";
import {
  Brand, BuilderRow, BuilderState, Category, Customer, DEFAULT_ROOMS, DescSheetState, DiscountSheetState,
  INITIAL_BUILDER_STATE, Line, PickerTab, Product, ProductVariant,
  RecentQuotation, Referrer, RoomDiscount, RoomSheetState, SaveState, SwapSheetState,
} from "../helpers/types";


type SortKey = "popular" | "recent" | "price_asc" | "price_desc" | "name";

type CatalogFamily = {
  family_key?: string | null; family_name?: string | null; brand_id: string; category_id: string;
  min_price?: number; max_price?: number; sample_image?: string | null;
  variants: (ProductVariant & { colour?: string | null; variant_label?: string | null })[];
  configuration_options?: Product["configuration_options"];
};

// The catalog family endpoint deliberately returns one record per product
// family. Adapt that compact API shape at the boundary so every picker, modal
// and variant chip still works with the existing Product contract.
function familyCardToProduct(family: CatalogFamily): Product | null {
  const variants = family.variants.map((variant) => ({
    ...variant,
    color: variant.color ?? variant.colour ?? null,
  }));
  const representative = variants[0];
  if (!representative?.id || !representative.sku) return null;
  return {
    id: representative.id,
    sku: representative.sku,
    name: family.family_name || representative.sku,
    price: Number(representative.price ?? family.min_price ?? 0),
    mrp: Number(representative.mrp ?? representative.price ?? family.min_price ?? 0),
    category_id: family.category_id,
    brand_id: family.brand_id,
    family_key: family.family_key || null,
    images: family.sample_image ? [family.sample_image] : representative.image ? [representative.image] : [],
    finish: representative.finish ?? null,
    finish_code: representative.finish_code ?? null,
    variant_label: representative.variant_label ?? null,
    colour: representative.colour ?? representative.color ?? null,
    size: representative.size ?? null,
    stock: representative.stock ?? 0,
    dimensions: representative.dimensions ?? null,
    material: representative.material ?? null,
    warranty: representative.warranty ?? null,
    specs: representative.specs ?? null,
    description: representative.description ?? null,
    configuration_options: family.configuration_options ?? [],
    variants,
  };
}

// -----------------------------------------------------------------------------
// Assistant selection — which line/product is currently focused in the right pane.
// -----------------------------------------------------------------------------
export type AssistantFocus =
  | { kind: "line"; line_id: string }
  | { kind: "product"; product_id: string; product: Product }
  | null;

// -----------------------------------------------------------------------------
// Context shape
// -----------------------------------------------------------------------------
export type BuilderApi = {
  // History
  history: HistoryApi<BuilderState>;
  s: BuilderState;

  // Reference data
  customers: Customer[];
  referrers: Referrer[];
  categories: Category[];
  categoryById: Record<string, string>;
  referenceLoading: boolean;
  referenceError: string | null;
  retryReferenceData: () => void;

  // Product picker
  q: string;
  setQ: (v: string) => void;
  pickerTab: PickerTab;
  setPickerTab: (t: PickerTab) => void;
  pickerList: Product[];
  products: Product[];
  productTotal: number;
  productLoading: boolean;
  productError: string | null;
  retryProducts: () => void;
  productHasMore: boolean;
  productLoadingMore: boolean;
  loadMoreProducts: () => void;
  recent: Product[];
  frequent: Product[];
  searchRef: React.MutableRefObject<TextInput | null>;

  // V4 rail + explorer state
  brands: Brand[];
  categoriesForRail: Category[];       // filtered by selectedBrandId if set
  selectedBrandId: string | null;
  setSelectedBrandId: (id: string | null) => void;
  selectedCategoryId: string | null;
  setSelectedCategoryId: (id: string | null) => void;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
  favouriteIds: string[];
  toggleFavourite: (id: string) => void;

  // V4 header fields
  setProjectName: (v: string) => void;
  setPhone: (v: string) => void;
  setAddress: (v: string) => void;
  setReferenceSource: (v: string) => void;

  // V4 sheets
  productModal: Product | null;
  openProductModal: (p: Product) => void;
  closeProductModal: () => void;
  /** Merge a partial product update (from the shared ProductEditor) into
   * both the open detail modal AND the in-memory picker grid, so an edit
   * saved mid-quotation reflects immediately without refetching the whole
   * product list. The backend is the real source of truth — this is purely
   * a same-tick UI mirror of what it just confirmed saving. */
  patchProduct: (id: string, updates: Record<string, unknown>) => void;
  customProductSheetOpen: boolean;
  setCustomProductSheetOpen: (v: boolean) => void;

  // V4 recent-quotation panel
  recentQuotations: RecentQuotation[];
  refreshRecentQuotations: () => Promise<void>;
  restoreQuotation: (id: string) => Promise<void>;
  deleteQuotation: (id?: string | null) => Promise<boolean>;
  startNewQuotation: () => void;

  // Derived
  totals: { subtotal: number; discount: number; grand: number };
  usedCategoryIds: string[];
  flatRows: BuilderRow[];
  lineBreakdownById: Record<string, LineBreakdown>;
  recoveryDraft: BuilderDraft | null;
  recoveryBusy: boolean;
  recoveryError: string | null;
  restoreLocalDraft: () => Promise<void>;
  dismissRecovery: () => void;

  // Autosave
  quotationId: string | null;
  quotationNumber: string | null;
  saveState: SaveState;
  savedAt: Date | null;
  saveLabel: string;
  persist: () => Promise<string | null>;
  finalize: () => Promise<void>;
  workflowBusy: boolean;
  generateOfficialQuotation: () => Promise<void>;
  placeOrder: () => Promise<void>;

  // Mutations — customers/lines
  setCustomer: (id: string) => void;
  createCustomer: (data: { name: string; phone?: string; project?: string; address?: string }) => Promise<string | null>;
  importCustomerFromGround: (sourceCustomerId: string) => Promise<boolean>;
  customerSwitcherOpen: boolean; setCustomerSwitcherOpen: (v: boolean) => void;
  setReferrer: (type: "architect" | "interior_designer", id: string, name: string) => void;
  clearReferrer: () => void;
  createReferrer: (data: { name: string; type: "architect" | "interior_designer" }) => Promise<string | null>;
  referrerSwitcherOpen: boolean; setReferrerSwitcherOpen: (v: boolean) => void;
  addFromProduct: (p: Product, variant?: ProductVariant) => void;
  updateLine: (id: string, patch: Partial<Line>, coalesceKey?: string) => void;
  removeLine: (id: string) => void;
  /** Cancel a product with an auditable order-line adjustment when saved. */
  cancelLine: (id: string) => Promise<boolean>;
  duplicateLine: (id: string) => void;
  moveLineToNextRoom: (id: string) => void;
  moveLine: (id: string, direction: -1 | 1) => void;
  moveRoom: (room: string, direction: -1 | 1) => void;

  // Rooms
  addRoom: (name: string) => void;
  renameRoom: (from: string, to: string) => void;
  duplicateRoom: (name: string) => void;
  deleteRoom: (name: string) => void;
  toggleCollapse: (name: string) => void;
  setActiveRoom: (name: string) => void;
  onRoomDragEnd: (payload: { data: string[] }) => void;
  onLinesDragEnd: (payload: { data: BuilderRow[] }) => void;

  // Discounts / notes
  setProjectDiscount: (n: number) => void;
  setCategoryDiscount: (cid: string, pct: number | null) => void;
  setRoomDiscount: (room: string, cfg: RoomDiscount | null) => void;
  setNotes: (n: string) => void;

  // Swap
  swapItems: Product[];
  swapLoading: boolean;
  openSwap: (l: Line) => Promise<void>;
  commitSwap: (target: Product, variant?: ProductVariant) => void;
  closeSwap: () => void;

  // Sheets — modal state
  discountSheet: DiscountSheetState; setDiscountSheet: (v: DiscountSheetState) => void;
  roomSheet: RoomSheetState; setRoomSheet: (v: RoomSheetState) => void;
  roomInput: string; setRoomInput: (v: string) => void;
  descSheet: DescSheetState; setDescSheet: (v: DescSheetState) => void;
  swapSheet: SwapSheetState;

  // Mobile-only sheets (Full-screen product picker & Assistant sheet)
  pickerSheetOpen: boolean; setPickerSheetOpen: (v: boolean) => void;
  quickAddProduct: Product | null; setQuickAddProduct: (p: Product | null) => void;

  // Inline room rename
  inlineRenameRoom: string | null; setInlineRenameRoom: (v: string | null) => void;
  inlineRenameValue: string; setInlineRenameValue: (v: string) => void;

  // Assistant pane focus (right pane / mobile bottom sheet)
  assistantFocus: AssistantFocus;
  setAssistantFocus: (f: AssistantFocus) => void;
  assistantOpenMobile: boolean;
  setAssistantOpenMobile: (v: boolean) => void;
};

const Ctx = createContext<BuilderApi | null>(null);

export function useBuilder(): BuilderApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useBuilder must be used inside BuilderProvider");
  return c;
}

// -----------------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------------
export function BuilderProvider({ onFinalize, initialProductId, initialGodownStockId, initialQuotationId, children }: {
  onFinalize?: (quotationId: string) => void;
  /** Seed the new quotation with this product on mount — used when
   *  navigating here from Catalog's "Add to quotation" CTA (product detail
   *  page / product cards) so that action actually adds the product instead
   *  of just dropping the user on an empty builder. */
  initialProductId?: string | null;
  /** A lot selected on the Godown Stock page. It is claimed on first save. */
  initialGodownStockId?: string | null;
  /** Restore this existing quotation instead of starting a new document. */
  initialQuotationId?: string | null;
  children: React.ReactNode;
}) {
  const { selectedFloorId, floors } = useFloorAccess();
  const { staff } = useAuth();
  const accountId = staff?.id || "";
  // The selected floor is published synchronously by the app shell. The
  // fallback only covers the brief initial storage-read window.
  const activeFloorId = selectedFloorId || floors[0]?.id || "";
  // Reference data — not part of undoable state.
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productTotal, setProductTotal] = useState(0);
  const [productError, setProductError] = useState<string | null>(null);
  const [productRetry, setProductRetry] = useState(0);
  const retryProducts = useCallback(() => setProductRetry(value => value + 1), []);
  const [productLoading, setProductLoading] = useState(false);
  const [productHasMore, setProductHasMore] = useState(false);
  const [productLoadingMore, setProductLoadingMore] = useState(false);
  const [recent, setRecent] = useState<Product[]>([]);
  const [frequent, setFrequent] = useState<Product[]>([]);
  const [pickerTab, setPickerTabState] = useState<PickerTab>("search");
  const [q, setQ] = useState("");
  const searchRef = useRef<TextInput | null>(null);

  // V4 rail + explorer
  const [brands, setBrands] = useState<Brand[]>([]);
  const [selectedBrandId, setSelectedBrandIdState] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryIdState] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("popular");
  const [categoriesForRail, setCategoriesForRail] = useState<Category[]>([]);
  const [favouriteIds, setFavouriteIds] = useState<string[]>([]);
  const [recentQuotations, setRecentQuotations] = useState<RecentQuotation[]>([]);
  const [productModal, setProductModal] = useState<Product | null>(null);
  const [customProductSheetOpen, setCustomProductSheetOpen] = useState(false);

  // Undo/redo document state
  const history = useHistory<BuilderState>(INITIAL_BUILDER_STATE, { max: 200, coalesceMs: 800 });
  const s = history.state;
  const stateRef = useRef(s);
  stateRef.current = s;
  const lastSavedStateRef = useRef<BuilderState | null>(null);
  const documentGeneration = useRef(0);
  const restoreRequest = useRef(0);
  const draftEpoch = useRef(builderDraftEpoch());
  const [recoveryDraft, setRecoveryDraft] = useState<BuilderDraft | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const restoredInitialQuotationRef = useRef<string | null>(null);
  useUndoRedoShortcuts(history as any, true);

  // Autosave metadata (not undoable)
  const [quotationId, setQuotationId] = useState<string | null>(null);
  const [quotationNumber, setQuotationNumber] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Autosave requests must be serialized. Without a queue, a slow PATCH from
  // an earlier edit can finish after a newer edit and overwrite the server
  // with stale quotation state.
  const persistQueue = useRef<Promise<string | null>>(Promise.resolve(null));
  const persistedIdRef = useRef<string | null>(null);
  const serverSavedAtRef = useRef<string | null>(null);

  // Sheets
  const [discountSheet, setDiscountSheet] = useState<DiscountSheetState>(null);
  const [roomSheet, setRoomSheet] = useState<RoomSheetState>(null);
  const [roomInput, setRoomInput] = useState("");
  const [descSheet, setDescSheet] = useState<DescSheetState>(null);
  const [swapSheet, setSwapSheet] = useState<SwapSheetState>(null);
  const [swapItems, setSwapItems] = useState<Product[]>([]);
  const [swapLoading, setSwapLoading] = useState(false);

  // Mobile-only sheets
  const [pickerSheetOpen, setPickerSheetOpen] = useState(false);
  const [quickAddProduct, setQuickAddProduct] = useState<Product | null>(null);

  // Inline room rename
  const [inlineRenameRoom, setInlineRenameRoom] = useState<string | null>(null);
  const [inlineRenameValue, setInlineRenameValue] = useState("");

  // Assistant pane focus
  const [assistantFocus, setAssistantFocus] = useState<AssistantFocus>(null);
  const [assistantOpenMobile, setAssistantOpenMobile] = useState(false);

  // Customer switcher sheet
  const [customerSwitcherOpen, setCustomerSwitcherOpen] = useState(false);

  // Referrer reference data + switcher sheet
  const [referrers, setReferrers] = useState<Referrer[]>([]);
  const [referrerSwitcherOpen, setReferrerSwitcherOpen] = useState(false);
  const [referenceLoading, setReferenceLoading] = useState(true);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [referenceRetry, setReferenceRetry] = useState(0);
  const retryReferenceData = useCallback(() => setReferenceRetry((value) => value + 1), []);

// ---------- Load reference data ----------
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setReferenceLoading(true);
    setReferenceError(null);
    (async () => {
      try {
        if (!activeFloorId) return;
        const request = { floorId: activeFloorId, signal: controller.signal, cacheMs: 60_000 };
        // These three datasets are needed to render and edit the quotation.
        // Everything else is fetched only when its corresponding panel is used,
        // keeping the first mobile screen from competing with seven requests.
        const [cs, cats, brs] = await Promise.all([
          api.get<Customer[]>("/customers", request),
          catalogReferences.categories<Category[]>(null, request),
          catalogReferences.brands<Brand[]>(request),
        ]);
        if (!current) return;
        setCustomers(cs);
        setCategories(cats);
        setBrands(brs);
        setCategoriesForRail(cats);
      } catch (e: any) {
        if (!current) return;
        // In React StrictMode the first mount is intentionally torn down.
        // The API client may briefly deduplicate the replacement mount onto
        // that just-aborted promise; schedule one fresh generation rather
        // than leaving the builder empty.
        if (e?.name === "AbortError") {
          setTimeout(() => { if (current) retryReferenceData(); }, 0);
          return;
        }
        setReferenceError(e?.detail || e?.message || "Could not load quotation data");
        console.warn("Failed to load builder reference data", e);
      } finally {
        if (current) setReferenceLoading(false);
      }
    })();
    // Load favourites from localStorage (web) — safe no-op elsewhere.
    if (Platform.OS === "web" && typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem("forge.favourites.v1");
        if (raw) setFavouriteIds(JSON.parse(raw));
      } catch {}
    }
    return () => {
      current = false;
      controller.abort();
    };
    // history is intentionally not a dependency: reference retries must not
    // restart just because the undoable quotation document changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceRetry, activeFloorId]);

  // Product shortcuts are useful but non-essential. Fetch them on first use
  // rather than making every builder launch pay for both endpoints.
  useEffect(() => {
    if (pickerTab === "search") return;
    const controller = new AbortController();
    const endpoint = pickerTab === "recent" ? "/products/recent" : "/products/frequent";
    if (!activeFloorId) return;
    api.get<Product[]>(endpoint, { floorId: activeFloorId, signal: controller.signal, cacheMs: 60_000 })
      .then((items) => {
        if (pickerTab === "recent") setRecent(items);
        else setFrequent(items);
      })
      .catch((error: any) => {
        if (error?.name !== "AbortError") console.warn(`Failed to load ${pickerTab} products`, error);
      });
    return () => controller.abort();
  }, [pickerTab, activeFloorId]);

  // The recent-quotation rail is intentionally deferred until the first frame
  // has painted. It remains available immediately afterwards, without
  // delaying the builder's primary controls on a slow mobile connection.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (!activeFloorId) return;
      api.get<RecentQuotation[]>("/quotations/recent?limit=10", {
        floorId: activeFloorId, signal: controller.signal, cacheMs: 30_000,
      }).then(setRecentQuotations).catch((error: any) => {
        if (error?.name !== "AbortError") console.warn("Failed to load recent quotations", error);
      });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [referenceRetry, activeFloorId]);

  // Referrers are only needed when their sheet opens, so defer their list
  // until that user intent instead of including it in builder bootstrap.
  useEffect(() => {
    if (!referrerSwitcherOpen) return;
    const controller = new AbortController();
    if (!activeFloorId) return;
    api.get<Referrer[]>("/referrers", { floorId: activeFloorId, signal: controller.signal, cacheMs: 5 * 60_000 })
      .then(setReferrers)
      .catch((error: any) => {
        if (error?.name !== "AbortError") console.warn("Failed to load referrers", error);
      });
    return () => controller.abort();
  }, [referrerSwitcherOpen, activeFloorId]);

  // ---------- Re-fetch categories when brand changes ----------
  useEffect(() => {
    if (!selectedBrandId) {
      setCategoriesForRail(categories);
      return;
    }
    const controller = new AbortController();
    let current = true;
    (async () => {
      try {
        const cats = await catalogReferences.categories<Category[]>(selectedBrandId, {
          floorId: activeFloorId, signal: controller.signal,
        });
        if (current) setCategoriesForRail(cats);
      } catch (e: any) {
        if (current && e?.name !== "AbortError") {
          console.warn("Failed to load brand categories", e);
        }
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [selectedBrandId, categories, activeFloorId]);

  const setSelectedBrandId = useCallback((id: string | null) => {
    setSelectedBrandIdState(id);
    setSelectedCategoryIdState(null); // reset category when brand changes
  }, []);
  const setSelectedCategoryId = useCallback((id: string | null) => {
    setSelectedCategoryIdState(id);
  }, []);
  const setPickerTab = useCallback((tab: PickerTab) => setPickerTabState(tab), []);

  const toggleFavourite = useCallback((id: string) => {
    setFavouriteIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      if (Platform.OS === "web" && typeof window !== "undefined") {
        try { window.localStorage.setItem("forge.favourites.v1", JSON.stringify(next)); } catch {}
      }
      return next;
    });
  }, []);

  // ---------- Product explorer fetch (page 1 on filter/search/sort change) ----------
  const productRequestGeneration = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!activeFloorId) {
      setProducts([]); setProductTotal(0); setProductHasMore(false);
      return;
    }
    const generation = ++productRequestGeneration.current;
    const controller = new AbortController();
    let cancelled = false;
    setProductLoading(true);
    setProductError(null);
    const t = setTimeout(async () => {
      // Safety net — never let the grid spin forever even if something
      // upstream (network, backend) genuinely stalls. 12s is generous.
      const safety = setTimeout(() => { if (!cancelled) { setProductLoading(false); setProductError("Product search is taking longer than expected. Please retry."); controller.abort(); } }, 12000);
      try {
        const res = await fetchCatalogPage<CatalogFamily>({
          mode: "families", q, brandId: selectedBrandId, categoryId: selectedCategoryId, sort: sortKey,
        }, 0, CATALOG_PAGE_SIZE, { floorId: activeFloorId, signal: controller.signal });
        if (cancelled || generation !== productRequestGeneration.current) return;
        const items = (res.items || []).map(familyCardToProduct).filter((item): item is Product => item !== null);
        setProducts(items);
        setProductTotal(res.total || 0);
        setProductHasMore(items.length < (res.total || 0));
      } catch (e) {
        if (!cancelled && generation === productRequestGeneration.current && (e as any)?.name !== "AbortError") {
          setProductError((e as any)?.detail || "Could not load products. Check your connection and retry.");
          setProducts([]); setProductTotal(0); setProductHasMore(false);
        }
      } finally {
        clearTimeout(safety);
        if (!cancelled) setProductLoading(false);
      }
    }, q.trim() ? 300 : 0);
    return () => {
      cancelled = true;
      controller.abort();
      loadMoreController.current?.abort();
      clearTimeout(t);
    };
  }, [q, selectedBrandId, selectedCategoryId, sortKey, activeFloorId, productRetry]);

  // ---------- Infinite scroll — fetch the next page and append ----------
  const loadingMoreRef = useRef(false);
  const loadMoreProducts = useCallback(() => {
    if (loadingMoreRef.current || productLoading || !productHasMore) return;
    loadingMoreRef.current = true;
    setProductLoadingMore(true);
    const skipAt = products.length;
    const generation = productRequestGeneration.current;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    (async () => {
      try {
        const res = await fetchCatalogPage<CatalogFamily>({
          mode: "families", q, brandId: selectedBrandId, categoryId: selectedCategoryId, sort: sortKey,
        }, skipAt, CATALOG_PAGE_SIZE, { floorId: activeFloorId, signal: controller.signal });
        if (controller.signal.aborted || generation !== productRequestGeneration.current) return;
        const items = (res.items || []).map(familyCardToProduct).filter((item): item is Product => item !== null);
        setProducts((cur) => {
          const seen = new Set(cur.map((p) => p.id));
          return [...cur, ...items.filter((p) => !seen.has(p.id))];
        });
        setProductTotal(res.total || 0);
        setProductHasMore(skipAt + items.length < (res.total || 0));
      } catch (e) {
        if ((e as any)?.name !== "AbortError") console.warn("Load more products failed", e);
      } finally {
        if (loadMoreController.current === controller) {
          loadMoreController.current = null;
          loadingMoreRef.current = false;
          setProductLoadingMore(false);
        }
      }
    })();
  }, [productLoading, productHasMore, products.length, q, selectedBrandId, selectedCategoryId, sortKey, activeFloorId]);

  // ---------- Autosave ----------
  const persist = useCallback(async (): Promise<string | null> => {
    const generation = documentGeneration.current;
    const run = async (): Promise<string | null> => {
      if (generation !== documentGeneration.current || !s.customerId) return null;
      if (lastSavedStateRef.current === s && persistedIdRef.current) return persistedIdRef.current;
      const payload = {
        customer_id: s.customerId,
        items: s.lines,
        rooms: s.rooms,
        notes: s.notes,
        project_name: s.header.projectName || null,
        phone_snapshot: s.header.phone || null,
        address_snapshot: s.header.address.trim() || null,
        reference_source: s.header.referenceSource || null,
        referrer_type: s.header.referrerType,
        referrer_id: s.header.referrerId,
        ui_state: {
          activeRoom: s.activeRoom,
          collapsedRooms: s.collapsedRooms,
          selectedBrandId, selectedCategoryId, sortKey,
        },
        project_discount_pct: s.projectDiscount,
        category_discounts: s.categoryDiscounts,
        room_discounts: s.roomDiscounts,
      };
      try {
        setSaveState("saving");
        let persistedId = persistedIdRef.current || quotationId;
        if (!persistedId) {
          const created = await api.post<{ id: string; number: string; updated_at?: string }>("/quotations", payload, { floorId: activeFloorId });
          if (generation !== documentGeneration.current) return null;
          serverSavedAtRef.current = created.updated_at || null;
          setQuotationId(created.id);
          setQuotationNumber(created.number);
          persistedIdRef.current = created.id;
          persistedId = created.id;
        } else {
          const upd: any = { ...payload, silent: true, collapsed_rooms: Object.keys(s.collapsedRooms).filter((k) => s.collapsedRooms[k]) };
          const updated = await api.patch<{ updated_at?: string }>(`/quotations/${persistedId}`, upd, { floorId: activeFloorId });
          if (generation !== documentGeneration.current) return null;
          serverSavedAtRef.current = updated.updated_at || null;
        }
        lastSavedStateRef.current = s;
        setSaveState(stateRef.current === s ? "saved" : "idle");
        setSavedAt(new Date());
        if (stateRef.current === s) void removeBuilderDraft(accountId, activeFloorId);
        return persistedId;
      } catch (e: any) {
        if (generation !== documentGeneration.current) return null;
        setSaveState("error");
        toast.error(e?.detail || "Save failed");
        return null;
      }
    };
    return enqueueQuotationPersist(persistQueue, run);
  }, [s, quotationId, selectedBrandId, selectedCategoryId, sortKey, activeFloorId, accountId]);

  useEffect(() => {
    if (lastSavedStateRef.current === s) return;
    setSaveState("idle");
    if (!s.customerId) return;
    if (s.lines.length === 0 && !quotationId && s.projectDiscount === 0 && Object.keys(s.categoryDiscounts).length === 0 && Object.keys(s.roomDiscounts).length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { persist(); }, 900);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [s, quotationId, persist]);

  // Recovery is account/floor scoped on web and native, and never replaces
  // a document without an explicit choice. Only unacknowledged edits remain.
  useEffect(() => {
    // An explicit customer-quotation edit must never be interrupted by an
    // unrelated local draft recovery prompt. The requested server document is
    // authoritative for this workflow.
    if (initialQuotationId) {
      setRecoveryDraft(null);
      setRecoveryReady(true);
      return;
    }
    let current = true;
    void readBuilderDraft(accountId, activeFloorId).then((draft) => {
      if (current) { setRecoveryDraft(draft); setRecoveryReady(true); }
    });
    return () => { current = false; documentGeneration.current += 1; restoreRequest.current += 1; };
  }, [accountId, activeFloorId, initialQuotationId]);

  useEffect(() => {
    if (!recoveryReady || recoveryDraft || !accountId || !activeFloorId || lastSavedStateRef.current === s) return;
    if (!s.customerId && !s.lines.length && !s.header.projectName && !s.notes) return;
    const timer = setTimeout(() => {
      void writeBuilderDraft({ version: 1, accountId, floorId: activeFloorId, at: Date.now(),
        quotationId, quotationNumber, serverSavedAt: serverSavedAtRef.current, state: s }, draftEpoch.current);
    }, 250);
    return () => clearTimeout(timer);
  }, [s, quotationId, quotationNumber, accountId, activeFloorId, recoveryReady, recoveryDraft]);

  const dismissRecovery = useCallback(() => {
    setRecoveryError(null);
    setRecoveryDraft(null);
    void removeBuilderDraft(accountId, activeFloorId);
  }, [accountId, activeFloorId]);

  const restoreLocalDraft = useCallback(async () => {
    if (!recoveryDraft || recoveryBusy) return;
    const draft = recoveryDraft;
    setRecoveryError(null);
    setRecoveryBusy(true);
    try {
      let copy = false;
      if (draft.quotationId) {
        try {
          const server = await api.get<{ updated_at?: string; status?: string }>(`/quotations/${draft.quotationId}`, { floorId: activeFloorId });
          copy = draftNeedsCopy(draft, server);
        } catch (error: any) {
          // An unavailable/deleted source cannot authorize overwriting it.
          // Restore locally as a separate draft, preserving every entered line.
          if (error?.status !== 404) throw error;
          copy = true;
        }
      }
      documentGeneration.current += 1;
      restoreRequest.current += 1;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      lastSavedStateRef.current = null;
      persistedIdRef.current = copy ? null : draft.quotationId;
      serverSavedAtRef.current = copy ? null : draft.serverSavedAt;
      setQuotationId(copy ? null : draft.quotationId);
      setQuotationNumber(copy ? null : draft.quotationNumber);
      history.replace(draft.state);
      setSaveState("idle");
      setSavedAt(null);
      setRecoveryDraft(null);
      toast.success(copy ? "Recovered as a new draft; the saved quotation has newer changes" : "Unsaved changes recovered");
    } catch (error: any) {
      const message = typeof error?.detail === "string" ? error.detail : "Could not verify the saved quotation. Retry when connected; your recovery is retained.";
      setRecoveryError(message);
      toast.error(message);
    } finally { setRecoveryBusy(false); }
  }, [recoveryDraft, recoveryBusy, activeFloorId, history]);

  // ---------- Restore an existing quotation ----------
  const refreshRecentQuotations = useCallback(async () => {
    try {
      const rq = await api.get<RecentQuotation[]>("/quotations/recent?limit=10", { floorId: activeFloorId });
      setRecentQuotations(rq);
    } catch {}
  }, [activeFloorId]);

  const restoreQuotation = useCallback(async (id: string, announce = true) => {
    const request = ++restoreRequest.current;
    try {
      const doc = await api.get<any>(`/quotations/${id}`, { floorId: activeFloorId });
      if (request !== restoreRequest.current) return;
      documentGeneration.current += 1;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const collapsed: Record<string, boolean> = {};
      for (const r of doc.collapsed_rooms || []) collapsed[r] = true;
      const ui: any = doc.ui_state || {};
      const restored: BuilderState = {
        customerId: doc.customer_id,
        header: {
          projectName: doc.project_name || "",
          phone: doc.phone_snapshot || "",
          address: doc.address_snapshot || "",
          referenceSource: doc.reference_source || "",
          referrerType: doc.referrer_type || null,
          referrerId: doc.referrer_id || null,
          referrerName: doc.referrer_name || "",
        },
        lines: (doc.items || []).map((it: any) => ({
          id: it.id, product_id: it.product_id, sku: it.sku, name: it.name,
          image: it.image, category_id: it.category_id, room: it.room,
          qty: it.qty, unit_price: it.unit_price, mrp: it.mrp ?? null,
          discount_pct: it.discount_pct ?? null,
          description: it.description, notes: it.notes,
          finish: it.finish ?? null, family_key: it.family_key ?? null,
          // Preserve immutable godown allocation provenance when reopening a
          // confirmed quotation. Omitting these fields would make a later
          // unrelated edit look like a stock-source swap to the backend.
          godown_stock_id: it.godown_stock_id ?? null,
          godown_allocation_id: it.godown_allocation_id ?? null,
          godown_source_customer_name: it.godown_source_customer_name ?? null,
          godown_source_purchased_at: it.godown_source_purchased_at ?? null,
          godown_transferred_at: it.godown_transferred_at ?? null,
          godown_allocated_at: it.godown_allocated_at ?? null,
        })),
        rooms: doc.rooms && doc.rooms.length ? doc.rooms : [DEFAULT_ROOMS[0]],
        collapsedRooms: collapsed,
        activeRoom: ui.activeRoom || (doc.rooms?.[0] || DEFAULT_ROOMS[0]),
        notes: doc.notes || "",
        projectDiscount: doc.project_discount_pct || 0,
        categoryDiscounts: doc.category_discounts || {},
        roomDiscounts: doc.room_discounts || {},
      };
      lastSavedStateRef.current = restored;
      serverSavedAtRef.current = doc.updated_at || null;
      history.replace(restored);
      setQuotationId(doc.id);
      persistedIdRef.current = doc.id;
      setQuotationNumber(doc.number);
      setSaveState("saved");
      setSavedAt(new Date(doc.updated_at || Date.now()));
      // Restore UI filter state too
      if (ui.selectedBrandId !== undefined) setSelectedBrandIdState(ui.selectedBrandId);
      if (ui.selectedCategoryId !== undefined) setSelectedCategoryIdState(ui.selectedCategoryId);
      if (ui.sortKey) setSortKey(ui.sortKey);
      if (announce) toast.success(`Restored ${doc.number}`);
    } catch (e: any) {
      toast.error(e?.detail || "Could not restore quotation");
    }
  }, [history, activeFloorId]);

  // Customer and quotation detail pages enter this route with an explicit
  // quotation id. Reuse the builder's normal restore path so edits, swaps,
  // additions and removals all use the same autosave/PATCH contract.
  useEffect(() => {
    if (!initialQuotationId || !activeFloorId || restoredInitialQuotationRef.current === initialQuotationId) return;
    restoredInitialQuotationRef.current = initialQuotationId;
    void restoreQuotation(initialQuotationId);
  }, [initialQuotationId, activeFloorId, restoreQuotation]);

  const deleteQuotation = useCallback(async (id = quotationId) => {
    if (!id) return false;
    try {
      await api.delete(`/quotations/${id}`, { floorId: activeFloorId });
      setRecentQuotations((current) => current.filter((q) => q.id !== id));
      if (id === quotationId) {
        documentGeneration.current += 1;
        restoreRequest.current += 1;
        lastSavedStateRef.current = INITIAL_BUILDER_STATE;
        void removeBuilderDraft(accountId, activeFloorId);
        history.replace(INITIAL_BUILDER_STATE);
        setQuotationId(null);
        persistedIdRef.current = null;
        setQuotationNumber(null);
        setSaveState("idle");
        setSavedAt(null);
      }
      toast.success("Quotation deleted");
      return true;
    } catch (e: any) {
      toast.error(e?.detail || "Could not delete quotation");
      return false;
    }
  }, [history, quotationId, activeFloorId, accountId]);

  const startNewQuotation = useCallback(() => {
    documentGeneration.current += 1;
    restoreRequest.current += 1;
    lastSavedStateRef.current = INITIAL_BUILDER_STATE;
    serverSavedAtRef.current = null;
    void removeBuilderDraft(accountId, activeFloorId);
    history.replace(INITIAL_BUILDER_STATE);
    setQuotationId(null);
    persistedIdRef.current = null;
    setQuotationNumber(null);
    setSaveState("idle");
    setSavedAt(null);
    setSelectedBrandIdState(null);
    setSelectedCategoryIdState(null);
    setQ("");
  }, [history, accountId, activeFloorId]);

  // Product modal helpers
  const openProductModal = useCallback((p: Product) => setProductModal(p), []);
  const closeProductModal = useCallback(() => setProductModal(null), []);
  const patchProduct = useCallback((id: string, updates: Record<string, unknown>) => {
    setProductModal((cur) => (cur && cur.id === id ? ({ ...cur, ...updates } as Product) : cur));
    setProducts((cur) => cur.map((p) => (p.id === id ? ({ ...p, ...updates } as Product) : p)));
  }, []);

  // ---------- Derived ----------
  const totals = useMemo(
    () => computeTotals(s.lines, s.projectDiscount, s.categoryDiscounts, s.roomDiscounts),
    [s.lines, s.projectDiscount, s.categoryDiscounts, s.roomDiscounts],
  );

  const lineBreakdownById = useMemo(() => Object.fromEntries(
    computeLineBreakdown(s.lines, s.projectDiscount, s.categoryDiscounts, s.roomDiscounts).map(row => [row.line.id, row]),
  ), [s.lines, s.projectDiscount, s.categoryDiscounts, s.roomDiscounts]);

  const categoryById: Record<string, string> = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  const usedCategoryIds = useMemo(
    () => Array.from(new Set(s.lines.map((l) => l.category_id).filter(Boolean))) as string[],
    [s.lines],
  );

  const pickerList: Product[] = pickerTab === "recent" ? recent : pickerTab === "frequent" ? frequent : products;

  const flatRows: BuilderRow[] = useMemo(() => {
    const rows: BuilderRow[] = [];
    // Build the room groups once. Besides avoiding an O(rooms × lines) series
    // of filters while a quotation grows, this keeps legacy/orphaned lines
    // visible rather than silently dropping them from the right panel.
    const linesByRoom = new Map<string, Line[]>(s.rooms.map((room) => [room, []] as [string, Line[]]));
    const fallbackRoom = s.rooms[0];
    for (const line of s.lines) {
      const targetRoom = linesByRoom.has(line.room || "") ? line.room! : fallbackRoom;
      if (targetRoom) linesByRoom.get(targetRoom)?.push(line);
    }
    for (const room of s.rooms) {
      const roomLines = linesByRoom.get(room) || [];
      const roomSub = roomLines.reduce((sum, l) => {
        return sum + (lineBreakdownById[l.id]?.net || 0);
      }, 0);
      const collapsed = !!s.collapsedRooms[room];
      const roomDiscount = s.roomDiscounts[room] || null;
      rows.push({ kind: "room-header", id: `hdr-${room}`, roomName: room, itemCount: roomLines.length, subtotal: roomSub, collapsed, roomDiscount });
      if (!collapsed) for (const l of roomLines) rows.push({ kind: "line", id: l.id, line: l });
    }
    return rows;
  }, [s, lineBreakdownById]);

  // ---------- Mutations ----------
  const setCustomer = useCallback((id: string) => {
    if (id === history.state.customerId) return;
    Haptics.selectionAsync();
    const customer = customers.find((item) => item.id === id);
    history.apply((cur) => ({
      ...cur,
      customerId: id,
      header: {
        ...cur.header,
        phone: customer?.phone || "",
        // A selected customer supplies the default, but the draft owns this
        // snapshot after that so customer-profile edits cannot rewrite a quote.
        address: customer?.address || "",
        referrerId: customer?.referrer_id || null,
        referrerName: customer?.referrer_name || "",
        referrerType: customer?.referrer_type || null,
      },
    }));
    // Persist the customer change immediately (not the 900ms debounce) so a
    // switch is never lost and the change is visible in activity/version
    // history right away — products/rooms/notes are untouched, as required.
    if (quotationId) {
      api.patch(`/quotations/${quotationId}`, {
        customer_id: id, address_snapshot: customer?.address || null, silent: false,
      }, { floorId: activeFloorId })
        .then(() => { setSaveState("saved"); setSavedAt(new Date()); toast.success("Customer updated"); })
        .catch((e: any) => toast.error(e?.detail || "Could not change customer"));
    }
  }, [history, quotationId, customers, activeFloorId]);

  const createCustomer = useCallback(async (data: { name: string; phone?: string; project?: string; address?: string }) => {
    try {
      const created = await api.post<Customer>("/customers", {
        name: data.name, phone: data.phone || null, project: data.project || null, address: data.address || null,
      }, { floorId: activeFloorId });
      setCustomers((cur) => [created, ...cur]);
      setCustomer(created.id);
      // React has not applied setCustomers yet, so setCustomer cannot see the
      // new profile in its closure. Preserve the created contact snapshot.
      history.apply((current) => ({ ...current, header: {
        ...current.header, phone: created.phone || current.header.phone, address: created.address || "",
      } }));
      toast.success(`${created.name} added`);
      return created.id;
    } catch (e: any) {
      toast.error(e?.detail || "Could not create customer");
      return null;
    }
  }, [setCustomer, activeFloorId, history]);

  const importCustomerFromGround = useCallback(async (sourceCustomerId: string) => {
    try {
      const result = await api.post<{ customer: Customer; defaults?: { phone?: string; project_name?: string; notes?: string } }>(
        "/customers/import-from-floor", { source_customer_id: sourceCustomerId, target_floor_id: activeFloorId }, { floorId: activeFloorId },
      );
      setCustomers((current) => current.some((customer) => customer.id === result.customer.id)
        ? current : [result.customer, ...current]);
      history.apply((current) => ({
        ...current,
        customerId: result.customer.id,
        notes: result.defaults?.notes || current.notes,
        header: {
          ...current.header,
          phone: result.defaults?.phone || current.header.phone,
          address: result.customer.address || current.header.address,
          projectName: result.defaults?.project_name || current.header.projectName,
        },
      }));
      toast.success(result.defaults?.project_name ? `Customer and ${result.defaults.project_name} details applied` : "Customer details applied");
      return true;
    } catch (e: any) {
      toast.error(e?.detail || "Could not import Ground Floor customer");
      return false;
    }
  }, [history, activeFloorId]);

  const setReferrer = useCallback((type: "architect" | "interior_designer", id: string, name: string) => {
    history.apply((cur) => ({ ...cur, header: { ...cur.header, referrerType: type, referrerId: id, referrerName: name } }));
    if (quotationId) {
      api.patch(`/quotations/${quotationId}`, { referrer_type: type, referrer_id: id }, { floorId: activeFloorId })
        .then(() => { setSaveState("saved"); setSavedAt(new Date()); })
        .catch((e: any) => toast.error(e?.detail || "Could not set referrer"));
    }
  }, [history, quotationId, activeFloorId]);

  const clearReferrer = useCallback(() => {
    history.apply((cur) => ({ ...cur, header: { ...cur.header, referrerType: null, referrerId: null, referrerName: "" } }));
    if (quotationId) {
      // referrer_id: "" (not null) — the backend's update_quotation gates on
      // `if body.referrer_id is not None`, and JSON null deserializes to
      // Python None, which would make that check False and silently no-op
      // the clear. An empty string passes the `is not None` gate and then
      // hits the existing falsy-string branch that already clears all three
      // referrer fields (see Task 2, update_quotation).
      api.patch(`/quotations/${quotationId}`, { referrer_type: null, referrer_id: "" }, { floorId: activeFloorId })
        .then(() => { setSaveState("saved"); setSavedAt(new Date()); })
        .catch((e: any) => toast.error(e?.detail || "Could not clear referrer"));
    }
  }, [history, quotationId, activeFloorId]);

  const createReferrer = useCallback(async (data: { name: string; type: "architect" | "interior_designer" }) => {
    try {
      const created = await api.post<Referrer>("/referrers", data, { floorId: activeFloorId });
      setReferrers((cur) => [...cur, created].sort((a, b) => a.name.localeCompare(b.name)));
      setReferrer(created.type, created.id, created.name);
      toast.success(`${created.name} added`);
      return created.id;
    } catch (e: any) {
      toast.error(e?.detail || "Could not create referrer");
      return null;
    }
  }, [setReferrer, activeFloorId]);

  const addFromProduct = useCallback((p: Product, variant?: ProductVariant) => {
    Haptics.selectionAsync();
    playAddProductSound();
    history.apply((cur) => {
      return {
        ...cur,
        // One history transaction adds both the visible product and its
        // configured rough-in. Repeated adds increment each matching line,
        // so staff never need to type the conceal SKU again.
        lines: addProductAndConcealedPart(
          cur.lines, p, variant, cur.activeRoom,
          (productId) => `${productId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          productImageList(p)[0] ?? null,
        ),
      };
    });
  }, [history]);

  // ---------- Seed from Catalog's "Add to quotation" CTA ----------
  const appliedInitialProductRef = useRef(false);
  useEffect(() => {
    if (!initialProductId || !activeFloorId || appliedInitialProductRef.current) return;
    appliedInitialProductRef.current = true;
    (async () => {
      try {
        const prod = await api.get<Product>(`/products/${initialProductId}`, { floorId: activeFloorId });
        addFromProduct(prod);
        toast.success(`${prod.name} added to quotation`);
      } catch {
        toast.error("Could not add that product automatically — search for it below");
      }
    })();
  }, [initialProductId, addFromProduct, activeFloorId]);

  const appliedInitialGodownRef = useRef(false);
  useEffect(() => {
    if (!initialGodownStockId || !activeFloorId || appliedInitialGodownRef.current) return;
    appliedInitialGodownRef.current = true;
    (async () => {
      try {
        const lot = await api.get<any>(`/godown-stock/${initialGodownStockId}`, { floorId: activeFloorId });
        if (!Number(lot.available_qty)) throw new Error("This lot is no longer available");
        history.apply(cur => ({ ...cur, lines: [...cur.lines, {
          id: `godown-${lot.id}-${Date.now()}`, product_id: lot.product_id, sku: lot.sku, name: lot.name,
          image: lot.image || null, category_id: null, room: cur.activeRoom, qty: 1, unit_price: 0,
          mrp: null, discount_pct: null, finish: lot.finish || null, godown_stock_id: lot.id,
          godown_source_customer_name: lot.source_customer_name || null,
          godown_source_purchased_at: lot.source_purchased_at || null,
          godown_transferred_at: lot.transferred_at || null,
        }] }));
        toast.success(`${lot.name} added from godown stock — select a customer to reserve it`);
      } catch (e: any) { toast.error(e?.detail || "That godown lot is no longer available"); }
    })();
  }, [initialGodownStockId, activeFloorId, history]);

  const updateLine = useCallback((id: string, patch: Partial<Line>, coalesceKey?: string) =>
    history.apply(
      (cur) => {
        const parent = cur.lines.find((line) => line.id === id);
        if (!parent || parent.included_for_line_id) return cur;
        const nextParent = { ...parent, ...patch };
        return {
          ...cur,
          lines: cur.lines.map((line) => {
            if (line.id === id) return nextParent;
            if (line.included_for_line_id === id && patch.qty != null) {
              return { ...line, qty: nextParent.qty * (line.included_qty_per_parent || 1) };
            }
            return line;
          }),
        };
      },
      { coalesceKey: coalesceKey ? `${coalesceKey}:${id}` : undefined },
    ),
  [history]);

  const removeLine = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    history.apply((cur) => {
      const target = cur.lines.find((line) => line.id === id);
      if (!target || target.included_for_line_id) return cur;
      return { ...cur, lines: cur.lines.filter((line) => line.id !== id && line.included_for_line_id !== id) };
    });
  }, [history]);

  // Cancellation is deliberately distinct from a normal draft-line delete.
  // For a saved customer order the backend also cancels the unfulfilled
  // purchase line and reconciles payment/follow-up records, preserving the
  // reason in its audit trail. A local draft has no downstream records yet.
  const cancelLine = useCallback(async (id: string) => {
    const target = history.state.lines.find((line) => line.id === id);
    if (target?.included_for_line_id) {
      toast.error("This included part follows its selected product");
      return false;
    }
    if (!quotationId) {
      removeLine(id);
      toast.success("Product removed from the draft");
      return true;
    }
    try {
      await api.post(
        `/quotations/${quotationId}/items/${id}/cancel`,
        { reason: "Cancelled from the customer quotation workspace" },
        { floorId: activeFloorId },
      );
      await restoreQuotation(quotationId, false);
      toast.success("Product cancelled and customer balance refreshed");
      return true;
    } catch (error: any) {
      // A fulfilled purchase line or completed-payment reconciliation needs a
      // purchasing/refund adjustment. Surface the API's concrete instruction
      // rather than locally changing the quotation and losing that context.
      toast.error(error?.detail || "Could not cancel this product");
      return false;
    }
  }, [quotationId, activeFloorId, removeLine, restoreQuotation, history.state.lines]);

  const duplicateLine = useCallback((id: string) => {
    Haptics.selectionAsync();
    history.apply((cur) => {
      const idx = cur.lines.findIndex((l) => l.id === id);
      if (idx < 0) return cur;
      const original = cur.lines[idx];
      if (original.included_for_line_id) return cur;
      const copy = { ...original, id: `${original.product_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, included_for_line_id: null, included_qty_per_parent: null };
      const includedCopies = cur.lines.filter((line) => line.included_for_line_id === original.id)
        .map((line, itemIdx) => ({ ...line, id: `${line.product_id}-${Date.now()}-included-copy-${itemIdx}`, included_for_line_id: copy.id }));
      const next = [...cur.lines]; next.splice(idx + 1, 0, copy);
      next.splice(idx + 2, 0, ...includedCopies);
      return { ...cur, lines: next };
    });
  }, [history]);

  const moveLineToNextRoom = useCallback((id: string) => {
    history.apply((cur) => {
      const l = cur.lines.find((x) => x.id === id);
      if (!l) return cur;
      const rootId = l.included_for_line_id || l.id;
      const root = cur.lines.find((line) => line.id === rootId) || l;
      const idx = cur.rooms.indexOf(root.room || "");
      const nextRoom = cur.rooms[(idx + 1) % cur.rooms.length];
      return { ...cur, lines: cur.lines.map((x) => (x.id === rootId || x.included_for_line_id === rootId ? { ...x, room: nextRoom } : x)) };
    });
    Haptics.selectionAsync();
  }, [history]);

  const moveLine = useCallback((id: string, direction: -1 | 1) => {
    history.apply(cur => ({ ...cur, lines: moveWithinRoom(cur.lines, id, direction) }));
  }, [history]);

  const moveRoom = useCallback((room: string, direction: -1 | 1) => {
    history.apply(cur => {
      const from = cur.rooms.indexOf(room), to = from + direction;
      if (from < 0 || to < 0 || to >= cur.rooms.length) return cur;
      const rooms = [...cur.rooms];
      [rooms[from], rooms[to]] = [rooms[to], rooms[from]];
      return { ...cur, rooms };
    });
  }, [history]);

  // Rooms
  const addRoom = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    history.apply((cur) => {
      if (cur.rooms.includes(trimmed)) return cur;
      return { ...cur, rooms: [...cur.rooms, trimmed], activeRoom: trimmed };
    });
  }, [history]);

  const renameRoom = useCallback((from: string, to: string) => {
    const trimmed = to.trim();
    if (!trimmed || trimmed === from) return;
    history.apply((cur) => {
      if (cur.rooms.includes(trimmed)) return cur;
      const rooms = cur.rooms.map((r) => (r === from ? trimmed : r));
      const lines = cur.lines.map((l) => (l.room === from ? { ...l, room: trimmed } : l));
      const collapsed = { ...cur.collapsedRooms };
      if (collapsed[from]) { collapsed[trimmed] = true; delete collapsed[from]; }
      const activeRoom = cur.activeRoom === from ? trimmed : cur.activeRoom;
      return { ...cur, rooms, lines, collapsedRooms: collapsed, activeRoom };
    });
  }, [history]);

  const duplicateRoom = useCallback((name: string) => {
    history.apply((cur) => {
      let copyName = `${name} (copy)`; let i = 2;
      while (cur.rooms.includes(copyName)) copyName = `${name} (copy ${i++})`;
      const sourceLines = cur.lines.filter((line) => line.room === name);
      const idMap = new Map(sourceLines.map((line, index) => [line.id, `${line.product_id}-${Date.now()}-room-copy-${index}`]));
      const clones = sourceLines.map((line) => ({
        ...line, id: idMap.get(line.id)!, room: copyName,
        included_for_line_id: line.included_for_line_id ? idMap.get(line.included_for_line_id) ?? null : null,
      }));
      return { ...cur, rooms: [...cur.rooms, copyName], lines: [...cur.lines, ...clones], activeRoom: copyName };
    });
  }, [history]);

  const deleteRoom = useCallback((name: string) => {
    if (history.state.rooms.length <= 1) {
      toast.error("Keep at least one room");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    history.apply((cur) => {
      if (cur.rooms.length <= 1) return cur;
      const rooms = cur.rooms.filter((r) => r !== name);
      const lines = cur.lines.filter((l) => l.room !== name);
      const activeRoom = cur.activeRoom === name ? (rooms[0] || DEFAULT_ROOMS[0]) : cur.activeRoom;
      const { [name]: _dropped, ...collapsed } = cur.collapsedRooms;
      return { ...cur, rooms, lines, activeRoom, collapsedRooms: collapsed };
    });
  }, [history]);

  const toggleCollapse = useCallback((name: string) =>
    history.apply((cur) => ({ ...cur, collapsedRooms: { ...cur.collapsedRooms, [name]: !cur.collapsedRooms[name] } }), { skipHistory: true }),
  [history]);

  const setActiveRoom = useCallback((name: string) =>
    history.apply((cur) => (cur.activeRoom === name ? cur : { ...cur, activeRoom: name }), { skipHistory: true }),
  [history]);

  const setProjectDiscount = useCallback((n: number) =>
    history.apply((cur) => ({ ...cur, projectDiscount: Math.max(0, Math.min(100, n)) })),
  [history]);

  const setCategoryDiscount = useCallback((cid: string, pct: number | null) =>
    history.apply((cur) => {
      const next = { ...cur.categoryDiscounts };
      if (pct == null) delete next[cid]; else next[cid] = Math.max(0, Math.min(100, pct));
      return { ...cur, categoryDiscounts: next };
    }),
  [history]);

  const setRoomDiscount = useCallback((room: string, cfg: RoomDiscount | null) =>
    history.apply((cur) => {
      const next = { ...cur.roomDiscounts };
      if (!cfg || cfg.value <= 0) delete next[room];
      else next[room] = { type: cfg.type, value: cfg.type === "percent" ? Math.max(0, Math.min(100, cfg.value)) : Math.max(0, cfg.value) };
      return { ...cur, roomDiscounts: next };
    }),
  [history]);

  const setNotes = useCallback((n: string) =>
    history.apply((cur) => ({ ...cur, notes: n }), { coalesceKey: "notes" }),
  [history]);

  const setProjectName = useCallback((v: string) =>
    history.apply((cur) => ({ ...cur, header: { ...cur.header, projectName: v } }), { coalesceKey: "hdr-project" }),
  [history]);
  const setPhone = useCallback((v: string) =>
    history.apply((cur) => ({ ...cur, header: { ...cur.header, phone: v } }), { coalesceKey: "hdr-phone" }),
  [history]);
  const setAddress = useCallback((v: string) =>
    history.apply((cur) => ({ ...cur, header: { ...cur.header, address: v } }), { coalesceKey: "hdr-address" }),
  [history]);
  const setReferenceSource = useCallback((v: string) =>
    history.apply((cur) => ({ ...cur, header: { ...cur.header, referenceSource: v } }), { coalesceKey: "hdr-ref" }),
  [history]);

  const onRoomDragEnd = useCallback(({ data }: { data: string[] }) =>
    history.apply((cur) => ({ ...cur, rooms: data })),
  [history]);

  const onLinesDragEnd = useCallback(({ data }: { data: BuilderRow[] }) => {
    history.apply((cur) => {
      const newLines: Line[] = [];
      let curRoom = cur.rooms[0];
      for (const row of data) {
        if (row.kind === "room-header") curRoom = row.roomName;
        else newLines.push({ ...row.line, room: curRoom });
      }
      const roomByParent = new Map(newLines.map((line) => [line.id, line.room]));
      for (const line of newLines) {
        if (line.included_for_line_id) line.room = roomByParent.get(line.included_for_line_id) || line.room;
      }
      return { ...cur, lines: newLines };
    });
  }, [history]);

  // Swap alternates
  const openSwap = useCallback(async (l: Line) => {
    if (l.included_for_line_id) return;
    setSwapSheet({ line_id: l.id, product_id: l.product_id });
    setSwapLoading(true); setSwapItems([]);
    try {
      const res = await api.get<{ items: Product[] }>(`/products/${l.product_id}/alternates?limit=20`, { floorId: activeFloorId });
      setSwapItems(res.items || []);
    } catch (e: any) {
      toast.error(e?.detail || "Could not load alternates");
    } finally {
      setSwapLoading(false);
    }
  }, [activeFloorId]);

  const commitSwap = useCallback((target: Product, variant?: ProductVariant) => {
    const cur = swapSheet;
    if (!cur) return;
    Haptics.selectionAsync();
    history.apply((c) => {
      const idx = c.lines.findIndex((l) => l.id === cur.line_id);
      if (idx < 0) return c;
      const src = c.lines[idx];
      const variantColour = variant?.colour ?? variant?.color;
      const finish = variant?.finish ?? variantColour ?? variant?.size ?? target.finish ?? target.colour ?? null;
      const displayName = variant && (variant.finish || variantColour || variant.size)
        ? `${target.name} · ${variant.finish || variantColour || variant.size}`
        : target.name;
      const next = [...c.lines];
      const selectedProductId = variant?.id ?? target.id;
      next[idx] = {
        ...src,
        product_id: selectedProductId,
        sku: variant?.sku ?? target.sku,
        name: displayName,
        // Do not retain the old line image or the representative card image
        // when a selected variant has no own media.
        image: variant ? variant.image ?? null : productImageList(target)[0] ?? null,
        category_id: target.category_id,
        unit_price: variant?.price ?? target.price,
        mrp: variant?.mrp ?? target.mrp,
        finish,
        family_key: target.family_key ?? src.family_key ?? null,
        // A godown allocation is for one exact SKU. Never carry its source
        // identifiers to a swapped product, otherwise the replacement could
        // be fulfilled from unrelated returned stock.
        godown_stock_id: null,
        godown_allocation_id: null,
        godown_source_customer_name: null,
        godown_source_purchased_at: null,
        godown_transferred_at: null,
        godown_allocated_at: null,
      };
      const replacement = next[idx];
      const selectedForDefaults: ProductVariant | undefined = variant;
      return {
        ...c,
        lines: syncDefaultIncludedParts(
          next, replacement, target, selectedForDefaults,
          (productId) => `${productId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ),
      };
    });
    setSwapSheet(null); setSwapItems([]);
  }, [history, swapSheet]);

  const closeSwap = useCallback(() => { setSwapSheet(null); setSwapItems([]); }, []);

  // Finalize
  const finalize = useCallback(async () => {
    const persistedId = await persist();
    if (!persistedId) return;
    onFinalize?.(persistedId);
  }, [persist, onFinalize]);

  // Builder controls issue commands only. The backend commits an EventOutbox
  // record and dispatches QuotationGenerated / OrderPlaced after commit.
  const generateOfficialQuotation = useCallback(async () => {
    const persistedId = await persist();
    if (!persistedId) return;
    setWorkflowBusy(true);
    try {
      const customerName = customers.find((customer) => customer.id === s.customerId)?.name || "Customer";
      const safeCustomerName = customerName.replace(/[\\\\/:*?\"<>|]/g, "").trim().replace(/\s+/g, " ") || "Customer";
      const filename = `${safeCustomerName}.pdf`;
      await downloadApiFile(`/quotations/${persistedId}/pdf`, filename, "quotation PDF");
    } finally {
      setWorkflowBusy(false);
    }
  }, [persist, customers, s.customerId]);

  const placeOrder = useCallback(async () => {
    const persistedId = await persist();
    if (!persistedId) return;
    setWorkflowBusy(true);
    try {
      const result = await api.post<{ count?: number; idempotent?: boolean }>(`/quotations/${persistedId}/place-order/confirm`, {
        project_name: s.header.projectName || null,
      }, { floorId: activeFloorId });
      await refreshRecentQuotations();
      toast.success(result.idempotent ? "Existing order opened safely" : `Order placed · ${result.count || 0} purchase order(s)`);
      onFinalize?.(persistedId);
    } catch (e: any) {
      toast.error(e?.detail || "Could not place order");
    } finally {
      setWorkflowBusy(false);
    }
  }, [persist, s.header.projectName, refreshRecentQuotations, onFinalize, activeFloorId]);

  // Web-only: cmd/ctrl+K focuses search
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Save label string
  const saveLabel = saveState === "saving" ? "Saving…"
    : saveState === "error" ? "Save failed"
    : s !== lastSavedStateRef.current && (s.customerId || s.lines.length) ? (s.customerId ? "Unsaved changes" : "Choose a customer to save")
    : savedAt ? `Saved · ${savedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`
    : "Draft — no changes yet";

  // Memoized: without this, every add-product/state change built a brand-new
  // object here, which re-rendered EVERY useBuilder() consumer in the tree —
  // including closed sheets rendering null — producing the visible flicker
  // right after adding a product. Each field below is itself stable
  // (useCallback/useState setters) or a real state value that should trigger
  // a refresh, so this only produces a new reference when something the UI
  // actually depends on changes.
  const value: BuilderApi = useMemo(() => ({
    history, s,
    customers, referrers, categories, categoryById, referenceLoading, referenceError, retryReferenceData,
    q, setQ, pickerTab, setPickerTab, pickerList, products, productTotal, productLoading, productError, retryProducts,
    productHasMore, productLoadingMore, loadMoreProducts, recent, frequent, searchRef,
    brands, categoriesForRail, selectedBrandId, setSelectedBrandId, selectedCategoryId, setSelectedCategoryId,
    sortKey, setSortKey, favouriteIds, toggleFavourite,
    setProjectName, setPhone, setAddress, setReferenceSource,
    productModal, openProductModal, closeProductModal, patchProduct,
    customProductSheetOpen, setCustomProductSheetOpen,
    recentQuotations, refreshRecentQuotations, restoreQuotation, deleteQuotation, startNewQuotation,
    totals, usedCategoryIds, flatRows, lineBreakdownById, recoveryDraft, recoveryBusy, recoveryError, restoreLocalDraft, dismissRecovery,
    quotationId, quotationNumber, saveState, savedAt, saveLabel, persist, finalize,
    workflowBusy, generateOfficialQuotation, placeOrder,
    setCustomer, createCustomer, importCustomerFromGround, customerSwitcherOpen, setCustomerSwitcherOpen,
    setReferrer, clearReferrer, createReferrer, referrerSwitcherOpen, setReferrerSwitcherOpen,
    addFromProduct, updateLine, removeLine, cancelLine, duplicateLine, moveLineToNextRoom, moveLine, moveRoom,
    addRoom, renameRoom, duplicateRoom, deleteRoom, toggleCollapse, setActiveRoom, onRoomDragEnd, onLinesDragEnd,
    setProjectDiscount, setCategoryDiscount, setRoomDiscount, setNotes,
    swapItems, swapLoading, openSwap, commitSwap, closeSwap,
    discountSheet, setDiscountSheet,
    roomSheet, setRoomSheet, roomInput, setRoomInput,
    descSheet, setDescSheet,
    swapSheet,
    pickerSheetOpen, setPickerSheetOpen,
    quickAddProduct, setQuickAddProduct,
    inlineRenameRoom, setInlineRenameRoom, inlineRenameValue, setInlineRenameValue,
    assistantFocus, setAssistantFocus, assistantOpenMobile, setAssistantOpenMobile,
  }), [
    history, s,
    customers, referrers, categories, categoryById, referenceLoading, referenceError, retryReferenceData,
    q, setQ, pickerTab, setPickerTab, pickerList, products, productTotal, productLoading, productError, retryProducts,
    productHasMore, productLoadingMore, loadMoreProducts, recent, frequent, searchRef,
    brands, categoriesForRail, selectedBrandId, setSelectedBrandId, selectedCategoryId, setSelectedCategoryId,
    sortKey, setSortKey, favouriteIds, toggleFavourite,
    setProjectName, setPhone, setAddress, setReferenceSource,
    productModal, openProductModal, closeProductModal, patchProduct,
    customProductSheetOpen, setCustomProductSheetOpen,
    recentQuotations, refreshRecentQuotations, restoreQuotation, deleteQuotation, startNewQuotation,
    totals, usedCategoryIds, flatRows, lineBreakdownById, recoveryDraft, recoveryBusy, recoveryError, restoreLocalDraft, dismissRecovery,
    quotationId, quotationNumber, saveState, savedAt, saveLabel, persist, finalize,
    workflowBusy, generateOfficialQuotation, placeOrder,
    setCustomer, createCustomer, importCustomerFromGround, customerSwitcherOpen, setCustomerSwitcherOpen,
    setReferrer, clearReferrer, createReferrer, referrerSwitcherOpen, setReferrerSwitcherOpen,
    addFromProduct, updateLine, removeLine, cancelLine, duplicateLine, moveLineToNextRoom, moveLine, moveRoom,
    addRoom, renameRoom, duplicateRoom, deleteRoom, toggleCollapse, setActiveRoom, onRoomDragEnd, onLinesDragEnd,
    setProjectDiscount, setCategoryDiscount, setRoomDiscount, setNotes,
    swapItems, swapLoading, openSwap, commitSwap, closeSwap,
    discountSheet, setDiscountSheet,
    roomSheet, setRoomSheet, roomInput, setRoomInput,
    descSheet, setDescSheet,
    swapSheet,
    pickerSheetOpen, setPickerSheetOpen,
    quickAddProduct, setQuickAddProduct,
    inlineRenameRoom, setInlineRenameRoom, inlineRenameValue, setInlineRenameValue,
    assistantFocus, setAssistantFocus, assistantOpenMobile, setAssistantOpenMobile,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
