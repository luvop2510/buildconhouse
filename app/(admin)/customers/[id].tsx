import { LeadScopeFields } from "@/src/components/leads/LeadScopeFields";
import type { LeadScope } from "@/src/api/leads";
import { referrerLabel } from "@/src/utils/referrer";
import { filterValues, toggleFilterValue } from "@/src/utils/filters";
import { Disclosure } from "@/src/design/Disclosure";
import { NavigationTabs } from "@/src/design/NavigationTabs";
// Customer profile with full activity timeline across quotations, purchases,
// and future payments. DS-aligned rebuild: PageHeader, StatTile, SegmentedControl,
// unified list row, Avatar. Business logic preserved.
import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { ActivityTimeline, TimelineEvent } from "@/src/components/ActivityTimeline";
import { useBp } from "@/src/design/responsive";
import {
  Avatar, Badge, Button, Card, Chip, EmptyState, FormField, PageHeader,
 Sheet, StatTile, StatusBadge, TextField,
} from "@/src/components/ui";
import { MobileFilterSection } from "@/src/components/ds";
import { api } from "@/src/api/client";
import { returnPurchaseLoan } from "@/src/api/purchases";
import { getCustomerStockTransfers, returnCustomerStockTransfer, type CustomerStockTransfer } from "@/src/api/godownStock";
import { ProductImage } from "@/src/components/ProductImage";
import { PoFinal } from "@/src/components/customers/PoFinal";
import { tilesStageLabel } from "@/src/components/tiles/tilesStage";
import { SANITARY_FLOOR_ID, TILES_FLOOR_ID } from "@/src/constants/floors";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { toast } from "@/src/components/Toast";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { colors, icon as iconSize, money, moneyShort, PRODUCT_IMAGE_ASPECT_RATIO, radius, spacing, type } from "@/src/theme/tokens";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";
import {
  HistorySheet, MovableItem, MoveStageSheet, STAGE_TONE, TransferSheet,
} from "@/src/components/purchases/MovementEngine";

type Customer = {
  id: string; name: string; company?: string | null; email: string;
  phone?: string | null; city?: string | null; purchase_completion_status?: "active" | "completed";
  address?: string | null;
  property_name?: string | null;
  referrer_id?: string | null; referrer_name?: string | null; referrer_type?: string | null;
  referrer_company?: string | null; referrer_customers_acquired?: number | null;
};
type Quotation = { id: string; number: string; status: string; doc_type?: string; grand_total: number; created_at: string; items: any[] };
type PO = { id: string; number: string; brand_name?: string | null; status: string; grand_total: number; created_at: string };

type WorkspaceProduct = {
  item_id: string; po_id: string; po_number: string; sku: string; name: string; image?: string | null;
  brand_name?: string | null; supplier_name?: string | null; stage: string; stage_label: string;
  qty: number; unit_cost: number; blocked: boolean; age_days: number; customer_id: string; customer_name: string;
  loaned_qty?: number; loan_transfer_id?: string | null; lent_to_customer_name?: string | null;
  customer_loan_history?: { transfer_id: string; qty: number; destination_customer_id?: string | null; destination_customer_name?: string | null; created_at?: string | null; status?: string | null }[];
  borrowed_from_customer_id?: string | null; borrowed_from_customer_name?: string | null;
  loan_return_status?: "awaiting_return" | "return_due" | "returned" | null; loan_return_due?: boolean; return_due_on_replenishment?: boolean;
};
type WorkspaceShortage = {
  id: string; sku: string; name: string; image?: string | null;
  committed_qty: number; allocated_qty: number; shortage_qty: number;
  reason: string; transferred_to_customer_name?: string | null; status: string;
};
type Workspace = {
  customer: Customer;
  summary: {
    total_items: number; total_value: number; order_value?: number; outstanding_value: number; outstanding_count: number;
    open_pos: number; blocked_count: number; delivered_count: number; shortage_count: number; refund_due?: number;
  };
  shortages: WorkspaceShortage[];
  products: WorkspaceProduct[];
  brands: { id: string | null; name: string; count: number }[];
  stages: { key: string; label: string; count: number }[];
  purchase_orders: { id: string; number: string; status: string; brand_name?: string | null; supplier_name?: string | null; grand_total: number; current_order_value?: number; created_at: string; expected_delivery_at?: string | null; item_count: number }[];
  outstanding_items: WorkspaceProduct[];
  recent_activity: TimelineEvent[];
  expected_delivery: { next_at: string | null; purchase_orders: { po_id: string; po_number: string; expected_delivery_at: string }[] };
};

type Tab = "overview" | "quotations" | "po_final" | "purchases" | "timeline";
type WorkspaceServerFilters = {
  productSearch: string;
  brandFilter: string | null;
  stageFilter: string | null;
};

const WALK_IN_DAY_OPTIONS = [2, 4, 7, 14];

function WalkInFollowupSheet({ visible, onClose, customer, onCreate }: {
  visible: boolean; onClose: () => void; customer: Customer; onCreate: (payload: any) => Promise<void>;
}) {
  const { selectedFloorId } = useFloorAccess();
  const [scope, setScope] = useState<LeadScope>({ interested_floor_ids: [], assignments: [] });
  const [reason, setReason] = useState("Walk-in visit — no quotation yet.");
  const [days, setDays] = useState(4);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) { setReason("Walk-in visit — no quotation yet."); setDays(4); setScope({ interested_floor_ids: selectedFloorId ? [selectedFloorId] : [], assignments: [] }); }
  }, [visible, selectedFloorId]);

  const submit = async () => {
    if (!reason.trim()) { toast.error("Add a reason"); return; }
    if (!scope.interested_floor_ids.length || scope.interested_floor_ids.some(floor => !scope.assignments.some(a => a.floor_id === floor && a.user_id))) { toast.error("Select a team member for each interested floor"); return; }
    setSaving(true);
    try {
      const dueIso = new Date(Date.now() + days * 86400000).toISOString();
      await onCreate({ customer_id: customer.id, category: "walk_in", channel: "call", reason: reason.trim(), due_at: dueIso, ...scope });
    } finally { setSaving(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Add to Follow-ups" subtitle={customer.company || customer.name} width={420}
      footer={<>
        <Button label="Cancel" variant="secondary" onPress={onClose} size="md" />
        <View style={{ flex: 1 }} />
        <Button label="Add Reminder" variant="primary" icon="plus" loading={saving} onPress={submit} size="md" testID="walkin-followup-save" />
      </>}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
        <FormField label="Reason" required helper="What should the salesperson do and why?">
          <TextField value={reason} onChangeText={setReason} placeholder="e.g. Browsed tile samples, wants a quote next week" testID="walkin-followup-reason" />
        </FormField>
        <FormField label="Remind me in" helper="Defaults to 4 days — change it if the customer asked for something different">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, width: "100%" }}>
            {WALK_IN_DAY_OPTIONS.map((d) => (
              <Chip key={d} label={`${d} days`} active={days === d} onPress={() => setDays(d)} />
            ))}
          </View>
        </FormField>
        <LeadScopeFields assignmentsRequired reference={false} customerId={customer.id} value={scope} onChange={setScope} />
      </ScrollView>
    </Sheet>
  );
}

export default function CustomerDetail() {
  const { id: rawId, q: rawQ, brand: rawBrand, stage: rawStage } = useLocalSearchParams<{
    id?: string | string[];
    q?: string | string[];
    brand?: string | string[];
    stage?: string | string[];
  }>();
  const router = useRouter();
  const { staff } = useAuth();
  const canDeleteCustomers = useActionAccess("customers", "delete", staff?.role === "owner") && staff?.role === "owner";
  const { isDesktop, isPhone } = useBp();
  const { selectedFloorId } = useFloorAccess();
  const isTilesFloor = selectedFloorId === TILES_FLOOR_ID;
  const isSanitaryFloor = selectedFloorId === SANITARY_FLOOR_ID;
  const id = firstParam(rawId) || "";
  const routeSearch = firstParam(rawQ) || "";
  const routeBrand = firstParam(rawBrand);
  const routeStage = firstParam(rawStage);

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [purchases, setPurchases] = useState<PO[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [stockTransfers, setStockTransfers] = useState<CustomerStockTransfer[]>([]);
  const [returningTransferId, setReturningTransferId] = useState<string | null>(null);
  const [returningPurchaseLoanId, setReturningPurchaseLoanId] = useState<string | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [relatedErrors, setRelatedErrors] = useState(false);
  const [relatedLoading, setRelatedLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [availableBrands, setAvailableBrands] = useState<Workspace["brands"]>([]);
  const [availableStages, setAvailableStages] = useState<Workspace["stages"]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [revenueOnly, setRevenueOnly] = useState(false);
  const [openOrdersVisible, setOpenOrdersVisible] = useState(false);
  const [productFilter, setProductFilter] = useState<string>("all");
  const [productSearch, setProductSearch] = useState(routeSearch);
  const [brandFilter, setBrandFilter] = useState<string | null>(routeBrand || null);
  const [stageFilter, setStageFilter] = useState<string | null>(routeStage || null);
  const [moveItem, setMoveItem] = useState<WorkspaceProduct | null>(null);
  const [transferItem, setTransferItem] = useState<WorkspaceProduct | null>(null);
  const [historyItemId, setHistoryItemId] = useState<string | null>(null);
  const [walkInSheet, setWalkInSheet] = useState(false);
  const workspaceRequestIdRef = useRef(0);
  const scheduledWorkspaceRequestIdRef = useRef<number | null>(null);
  const coreRequestRef = useRef(0);
  const coreAbortRef = useRef<AbortController | null>(null);
  const coreActiveRef = useRef(false);
  const coreContextRef = useRef("");
  const coreContext = `${selectedFloorId}:${id}`;
  coreContextRef.current = coreContext;

  const workspaceFilters = useMemo<WorkspaceServerFilters>(() => ({
    productSearch: productSearch.trim(),
    brandFilter,
    stageFilter,
  }), [brandFilter, productSearch, stageFilter]);

  const loadCore = useCallback(async () => {
    if (!coreActiveRef.current || !id || !selectedFloorId || coreContextRef.current !== coreContext) return;
    coreAbortRef.current?.abort();
    const controller = new AbortController();
    coreAbortRef.current = controller;
    const requestId = ++coreRequestRef.current;
    const isCurrent = () => !controller.signal.aborted && requestId === coreRequestRef.current && coreContextRef.current === coreContext;
    const options = { floorId: selectedFloorId, signal: controller.signal };
    setLoadError(null);
    setRelatedErrors(false);
    setRelatedLoading(true);
    const customerId = encodeURIComponent(id);
    // The profile is usable as soon as its own read completes. Activity or
    // purchase history must not add their latency to the whole page's spinner.
    const primary = api.get<Customer>(`/customers/${customerId}?with_completion=true`, options)
      .then(value => { if (isCurrent()) setCustomer(value); })
      .catch((e: any) => { if (isCurrent()) setLoadError(e?.detail || "Could not load this customer. Check your connection and try again."); });
    const related = <T,>(path: string, publish: (value: T) => void) => api.get<T>(path, options)
      .then(value => { if (isCurrent()) publish(value); })
      .catch(() => { if (isCurrent()) setRelatedErrors(true); });
    const history = Promise.all([
      related<Quotation[]>(`/quotations?customer_id=${customerId}`, setQuotations),
      isSanitaryFloor && related<PO[]>(`/purchase-orders?customer_id=${customerId}`, setPurchases),
      related<TimelineEvent[]>(`/activity/customer/${customerId}`, setTimeline),
    ]).finally(() => { if (isCurrent()) setRelatedLoading(false); });
    await Promise.all([primary, history]);
  }, [id, selectedFloorId, coreContext, isSanitaryFloor]);

  const loadStockTransfers = useCallback(async () => {
    if (!id || !isSanitaryFloor) { setStockTransfers([]); return; }
    try {
      const result = await getCustomerStockTransfers(id);
      setStockTransfers((result.transfers || []).filter((transfer) =>
        transfer.recipient_customer_id === id || (transfer.transfer_type !== "godown_stock" && transfer.status !== "completed")
      ));
    } catch { setStockTransfers([]); }
  }, [id, isSanitaryFloor]);

  const markLegacyStockReturned = useCallback(async (transferId: string) => {
    setReturningTransferId(transferId);
    try {
      await returnCustomerStockTransfer(transferId);
      toast.success("Borrowed stock marked returned");
      await loadStockTransfers();
    } catch (error: any) { toast.error(error?.detail || "Could not mark borrowed stock returned"); }
    finally { setReturningTransferId(null); }
  }, [loadStockTransfers]);

  const invalidateWorkspace = useCallback(() => {
    const requestId = ++workspaceRequestIdRef.current;
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    setWorkspace(null);
    return requestId;
  }, []);

  const syncInvalidateWorkspace = useCallback(() => {
    scheduledWorkspaceRequestIdRef.current = invalidateWorkspace();
  }, [invalidateWorkspace]);

  const setProductSearchFilter = useCallback((value: string) => {
    syncInvalidateWorkspace();
    setProductSearch(value);
  }, [syncInvalidateWorkspace]);

  const setBrandWorkspaceFilter = useCallback((value: string | null | ((current: string | null) => string | null)) => {
    syncInvalidateWorkspace();
    setBrandFilter(value);
  }, [syncInvalidateWorkspace]);

  const setStageWorkspaceFilter = useCallback((value: string | null | ((current: string | null) => string | null)) => {
    syncInvalidateWorkspace();
    setStageFilter(value);
  }, [syncInvalidateWorkspace]);

  useLayoutEffect(() => {
    syncInvalidateWorkspace();
    setProductSearch(routeSearch);
  }, [routeSearch, syncInvalidateWorkspace]);

  useLayoutEffect(() => {
    const nextBrand = routeBrand || null;
    syncInvalidateWorkspace();
    setBrandFilter(nextBrand);
  }, [routeBrand, syncInvalidateWorkspace]);

  useLayoutEffect(() => {
    const nextStage = routeStage || null;
    syncInvalidateWorkspace();
    setStageFilter(nextStage);
  }, [routeStage, syncInvalidateWorkspace]);

  const loadWorkspace = useCallback(async (filters: WorkspaceServerFilters, requestId = invalidateWorkspace()) => {
    if (!id) return;
    // Purchasing is exclusive to Sanitary Bathroom. Ground Floor uses its
    // independent Tile Orders workflow; the other floors have no tracker.
    if (!isSanitaryFloor) {
      setWorkspace(null);
      setWorkspaceLoading(false);
      return;
    }
    try {
      const params = new URLSearchParams();
      if (filters.productSearch) params.set("q", filters.productSearch);
      if (filters.brandFilter) params.set("brand", filters.brandFilter);
      if (filters.stageFilter) params.set("stage", filters.stageFilter);
      const query = params.toString();
      const nextWorkspace = await api.get<Workspace>(
        `/purchases/customers/${id}/workspace${query ? `?${query}` : ""}`,
        { floorId: SANITARY_FLOOR_ID },
      );
      if (requestId !== workspaceRequestIdRef.current) return;
      setWorkspace(nextWorkspace);
      setAvailableBrands(nextWorkspace.brands);
      setAvailableStages(nextWorkspace.stages);
    } catch (e: any) {
      if (requestId !== workspaceRequestIdRef.current) return;
      setWorkspace(null);
      setWorkspaceError(e?.detail || "Could not load these purchase filters. Try again.");
    } finally {
      if (requestId === workspaceRequestIdRef.current) setWorkspaceLoading(false);
    }
  }, [id, invalidateWorkspace, isSanitaryFloor]);

  const markPurchaseLoanReturned = useCallback(async (transferId: string) => {
    setReturningPurchaseLoanId(transferId);
    try {
      await returnPurchaseLoan(transferId);
      toast.success("Borrowed product marked returned");
      await loadWorkspace(workspaceFilters);
    } catch (error: any) { toast.error(error?.detail || "Could not mark product returned"); }
    finally { setReturningPurchaseLoanId(null); }
  }, [loadWorkspace, workspaceFilters]);

  const reloadAll = useCallback(async () => {
    await Promise.all([
      loadCore(),
      loadWorkspace(workspaceFilters),
      loadStockTransfers(),
    ]);
  }, [loadCore, loadWorkspace, loadStockTransfers, workspaceFilters]);

  useEffect(() => {
    coreActiveRef.current = true;
    setCustomer(null); setQuotations([]); setPurchases([]); setTimeline([]);
    void loadCore();
    return () => { coreActiveRef.current = false; coreRequestRef.current += 1; coreAbortRef.current?.abort(); };
  }, [loadCore]);
  useEffect(() => { void loadStockTransfers(); }, [loadStockTransfers]);
  useEffect(() => {
    if (!id) return;
    const requestId = scheduledWorkspaceRequestIdRef.current ?? invalidateWorkspace();
    scheduledWorkspaceRequestIdRef.current = null;
    const t = setTimeout(() => { void loadWorkspace(workspaceFilters, requestId); }, 220);
    return () => clearTimeout(t);
  }, [id, invalidateWorkspace, loadWorkspace, workspaceFilters]);

  const createWalkInFollowup = useCallback(async (payload: any) => {
    try {
      await api.post("/followups", payload);
      toast.success("Follow-up added");
      setWalkInSheet(false);
    } catch (e: any) {
      toast.error(e?.detail || "Could not add follow-up");
    }
  }, []);


  const toMovable = useCallback((p: WorkspaceProduct): MovableItem => ({
    item_id: p.item_id, sku: p.sku, name: p.name, image: p.image, qty: p.qty, loaned_qty: p.loaned_qty,
    stage: p.stage as any, customer_id: p.customer_id, customer_name: p.customer_name,
    po_number: p.po_number, brand_name: p.brand_name, supplier_name: p.supplier_name,
  }), []);

  const [shortageBusy, setShortageBusy] = useState<string | null>(null);
  const createPoForShortage = async (s: WorkspaceShortage) => {
    setShortageBusy(s.id);
    try {
      const r = await api.post<{ po_number: string }>(`/purchases/shortages/${s.id}/create-po`);
      toast.success(`Reorder PO ${r.po_number} created`);
      await reloadAll();
    } catch (e: any) {
      toast.error(e?.detail || "Could not create PO");
    } finally { setShortageBusy(null); }
  };
  const dismissShortage = async (s: WorkspaceShortage) => {
    setShortageBusy(s.id);
    try {
      await api.post(`/purchases/shortages/${s.id}/dismiss`, {});
      toast.success("Shortage dismissed");
      await reloadAll();
    } catch (e: any) {
      toast.error(e?.detail || "Could not dismiss");
    } finally { setShortageBusy(null); }
  };

  const visibleProducts = useMemo(() => {
    if (!workspace) return [];
    const selected = filterValues(productFilter);
    const outstanding = new Set(workspace.outstanding_items.map(p => p.item_id));
    return workspace.products.filter(p => !selected.length || (selected.includes("outstanding") && outstanding.has(p.item_id)) || (selected.includes("blocked") && p.blocked));
  }, [workspace, productFilter]);
  const exportDetail = async (section: "quotations" | "products" | "orders" | "timeline") => {
    const rows = section === "quotations"
      ? [["Quotation", "Status", "Items", "Total (INR)", "Created"], ...quotations.map(row => [row.number, row.status, row.items.length, row.grand_total, row.created_at])]
      : section === "products"
        ? [["PO", "SKU", "Product", "Brand", "Stage", "Quantity", "Unit cost (INR)", "Blocked"], ...visibleProducts.map(row => [row.po_number, row.sku, row.name, row.brand_name, row.stage_label, row.qty, row.unit_cost, row.blocked ? "Yes" : "No"])]
        : section === "orders"
          ? [["PO", "Status", "Brand", "Supplier", "Items", "Total (INR)", "Created"], ...(workspace?.purchase_orders || []).map(row => [row.number, row.status, row.brand_name, row.supplier_name, row.item_count, row.grand_total, row.created_at])]
          : [["Date", "Event", "Summary", "Recorded by"], ...timeline.map(row => [row.created_at, row.event_type, row.summary, row.actor_name])];
    try {
      await downloadSectionExcel({ resource: "customers", page: `Customer ${customer?.company || customer?.name || id}`, section: `Customer ${section}`, rows, filename: `customer-${id}-${section}.xlsx`, floorId: selectedFloorId });
    } catch (error: any) { toast.error(error?.message || `Could not export ${section}`); }
  };

  const hasServerFilters = useMemo(
    () => Boolean(workspaceFilters.productSearch || workspaceFilters.brandFilter || workspaceFilters.stageFilter),
    [workspaceFilters],
  );
  const selectedBrand = useMemo(
    () => availableBrands.filter((brand) => !!brand.id && filterValues(brandFilter).includes(brand.id)).map(brand => brand.name).join(", "),
    [availableBrands, brandFilter],
  );
  const selectedStage = useMemo(
    () => availableStages.filter((stage) => filterValues(stageFilter).includes(stage.key)).map(stage => stage.label).join(", "),
    [availableStages, stageFilter],
  );
  const clearServerFilters = useCallback(() => {
    syncInvalidateWorkspace();
    setProductSearch("");
    setBrandFilter(null);
    setStageFilter(null);
  }, [syncInvalidateWorkspace]);
  const brandOptions = useMemo(
    () => availableBrands.filter((brand) => !!brand.id),
    [availableBrands],
  );
  const stageOptions = useMemo(
    () => availableStages.filter((stage) => stage.count > 0 || filterValues(stageFilter).includes(stage.key)),
    [availableStages, stageFilter],
  );
  const hasServerFilteredEmpty = Boolean(workspace && hasServerFilters && workspace.products.length === 0);
  const hasClientFilteredEmpty = Boolean(workspace && workspace.products.length > 0 && visibleProducts.length === 0);

  const totalRevenue = useMemo(
    () => quotations.filter((q) => ["won", "ordered"].includes(q.status)).reduce((s, q) => s + q.grand_total, 0),
    [quotations],
  );

  const visibleQuotations = quotations.filter(q => !revenueOnly || q.status === "won" || q.status === "ordered");

  const tilesHistory = useMemo(
    () => quotations.filter((q) => q.doc_type === "tiles_selection" || q.doc_type === "tiles_quotation"),
    [quotations],
  );

  // A tile document is owned by the Ground Floor editor. Sending it through
  // the standard quotation routes mounts their first-floor access guard,
  // which switches the active workspace and then fails to find the document.
  // Keep both open and Manage on the document's own floor/editor instead.
  const openQuotation = (quotation: Quotation) => {
    if (quotation.doc_type === "tiles_selection" || quotation.doc_type === "tiles_quotation") {
      router.push(`/(admin)/tiles/${quotation.doc_type === "tiles_selection" ? "selection" : "quotation"}?id=${quotation.id}` as any);
      return;
    }
    router.push(`/(admin)/quotations/${quotation.id}` as any);
  };
  const manageQuotation = (quotation: Quotation) => {
    if (quotation.doc_type === "tiles_selection" || quotation.doc_type === "tiles_quotation") {
      router.push(`/(admin)/tiles/${quotation.doc_type === "tiles_selection" ? "selection" : "quotation"}?id=${quotation.id}` as any);
      return;
    }
    router.push(`/(admin)/quotations/new?quotationId=${encodeURIComponent(quotation.id)}` as any);
  };

  if (loadError) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md }}>
          <EmptyState icon="alert-triangle" title="Couldn't load this customer" subtitle={loadError} />
          <Button label="Try again" icon="refresh-cw" onPress={() => { setLoadError(null); void loadCore(); }} testID="customer-detail-retry" />
          <Button label="Back" variant="ghost" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }
  if (!customer) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" }} edges={isPhone ? [] : ["top"]}>
        <ActivityIndicator color={colors.onSurfaceMuted} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.md : spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxxl }}>
      <PageHeader
        title={customer.company || customer.name}
        subtitle={`${customer.email}${customer.city ? ` · ${customer.city}` : ""}`}
        overline={customer.purchase_completion_status === "completed" ? "CUSTOMER · 100% COMPLETED" : "CUSTOMER"}
        back={() => router.back()}
        actions={
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, maxWidth: "100%" }}>
            <Button
              icon="phone-call"
              label={isPhone ? "Follow-up" : "Add to Follow-ups"}
              variant="secondary"
              size="md"
              onPress={() => setWalkInSheet(true)}
              testID="add-to-followups-btn"
            />
            <Button
              icon="edit-2"
              label="Edit"
              variant="secondary"
              size="md"
              onPress={() => router.push(`/(admin)/customers/${customer.id}/edit` as any)}
            />
            {canDeleteCustomers ? (
              <Button
                icon="settings"
                label="Manage customer data"
                variant="secondary"
                size="md"
                onPress={() => router.push("/(admin)/customers" as any)}
                testID="delete-customer-detail"
              />
            ) : null}
          </View>
        }
      />

        {/* Identity row */}
        <Card>
          <View style={{ flexDirection: "row", gap: spacing.lg, alignItems: "center", flexWrap: "wrap" }}>
            <Avatar name={customer.company || customer.name} size={64} tone="brand" />
            <View style={{ flex: 1, minWidth: isDesktop ? 240 : 0, gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
                <Text style={[type.titleLg, { flexShrink: 1 }]} numberOfLines={isDesktop ? 1 : 3}>
                  {customer.company || customer.name}
                </Text>
                {customer.purchase_completion_status === "completed" ? <Badge label="100% completed" tone="success" /> : null}
              </View>
              <View style={{ gap: 6, marginTop: 4 }}>
                <Row icon="mail" text={customer.email} />
                {customer.phone ? <Row icon="phone" text={customer.phone} /> : null}
                {customer.address ? <Row icon="map-pin" text={customer.address} /> : null}
              </View>
            </View>
          </View>
        </Card>

        {relatedErrors ? <View accessibilityRole="alert" style={{ gap: 8 }}><Text style={type.bodyMuted}>Some related records could not be loaded. Counts may be incomplete.</Text><Button label="Retry related records" variant="secondary" onPress={() => void loadCore()} /></View> : null}
        <Disclosure title="Customer summary">
        {/* Stats */}
        <View style={[styles.statsRow, !isDesktop && styles.statsRowMobile]}>
          <StatTile onPress={() => { setRevenueOnly(true); setTab("quotations"); }} label="Lifetime Revenue" value={relatedLoading ? "Loading…" : relatedErrors ? "Unavailable" : moneyShort(totalRevenue)} icon="trending-up" tone="success" sub="Won + ordered" />
          <StatTile onPress={() => { setRevenueOnly(false); setTab("quotations"); }} label="Quotations" value={relatedLoading || relatedErrors ? "—" : String(quotations.length)} icon="file-text" tone="brand" sub="All statuses" />
          {isSanitaryFloor ? <StatTile onPress={() => setTab("purchases")} label="Purchase Orders" value={relatedLoading || relatedErrors ? "—" : String(purchases.length)} icon="shopping-cart" tone="brand" sub="Across brands" /> : null}
          <StatTile onPress={() => setTab("timeline")} label="Activity" value={relatedLoading || relatedErrors ? "—" : String(timeline.length)} icon="activity" tone="neutral" sub="Events logged" />
        </View>

        </Disclosure>
        {/* Tabs */}
        <NavigationTabs<Tab> value={tab} onChange={value => { setRevenueOnly(false); setTab(value); }} testID="customer-tab" options={[
          { value: "overview", label: "Overview" }, { value: "quotations", label: "Quotations" },
          { value: "po_final", label: "PO Final" }, ...((isSanitaryFloor || isTilesFloor) ? [{ value: "purchases" as const, label: isTilesFloor ? "Tile Orders" : "Purchases" }] : []), { value: "timeline", label: "Timeline" },
        ]} />
        {tab === "quotations" || tab === "purchases" || tab === "timeline" ? <View style={styles.exportActions}>
          {tab === "quotations" ? <Button label="Export quotations .xlsx" icon="download" variant="secondary" size="sm" disabled={!quotations.length} onPress={() => void exportDetail("quotations")} testID="customer-export-quotations" /> : null}
          {tab === "purchases" && isSanitaryFloor ? <><Button label="Export products .xlsx" icon="download" variant="secondary" size="sm" disabled={!visibleProducts.length} onPress={() => void exportDetail("products")} testID="customer-export-products" /><Button label="Export orders .xlsx" icon="download" variant="secondary" size="sm" disabled={!workspace?.purchase_orders.length} onPress={() => void exportDetail("orders")} testID="customer-export-orders" /></> : null}
          {tab === "timeline" ? <Button label="Export activity .xlsx" icon="download" variant="secondary" size="sm" disabled={!timeline.length} onPress={() => void exportDetail("timeline")} testID="customer-export-activity" /> : null}
        </View> : null}

        {tab === "quotations" && revenueOnly ? <Chip label="Won + ordered · Show all quotations" active onPress={() => setRevenueOnly(false)} /> : null}
        {/* Body */}
        {tab === "overview" ? (
          <>
            <Card>
              <Text style={[type.overline, { marginBottom: spacing.md }]}>Property & site</Text>
              <View style={{ gap: spacing.sm }}>
                <Text style={type.bodyStrong}>{customer.property_name || "No property/project recorded"}</Text>
                <Text style={type.bodyMuted}>{customer.address || "Add an address to give the team a clear site view."}</Text>
                {customer.address ? <Button label="View on map" icon="map-pin" variant="secondary" size="sm" onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customer.address || "")}`)} /> : null}
              </View>
            </Card>
            {customer.referrer_id || customer.referrer_name ? <Card testID="customer-referrer-detail">
              <Text style={[type.overline, { marginBottom: spacing.md }]}>Architect / interior designer</Text>
              <Text style={type.bodyStrong}>{referrerLabel(customer)}</Text>
              {customer.referrer_company ? <Text style={type.body}>{customer.referrer_company}</Text> : null}
              {customer.referrer_customers_acquired != null ? <Text style={type.caption}>{customer.referrer_customers_acquired} customers brought to this floor</Text> : null}
            </Card> : null}
            <Card>
              <Text style={[type.overline, { marginBottom: spacing.md }]}>Latest activity</Text>
              <ActivityTimeline events={timeline.slice(0, 8)} dense emptyLabel={relatedLoading ? "Loading activity…" : "No activity yet"} />
            </Card>
            {tilesHistory.length > 0 ? (
              <Card>
                <Text style={[type.overline, { marginBottom: spacing.md }]}>Tile history</Text>
                {tilesHistory.map((doc, i) => (
                  <Pressable
                    key={doc.id}
                    onPress={() => router.push(`/(admin)/tiles/${doc.doc_type === "tiles_selection" ? "selection" : "quotation"}?id=${doc.id}` as any)}
                    style={({ pressed, hovered }: any) => [
                      styles.listRow,
                      !isDesktop && styles.listRowMobile,
                      {
                        borderTopWidth: i > 0 ? StyleSheet.hairlineWidth : 0,
                        borderTopColor: colors.divider,
                        backgroundColor: pressed ? colors.surfaceTertiary : hovered ? colors.surfaceSubtle : "transparent",
                      },
                    ]}
                  >
                    <Text style={[type.mono, { width: isDesktop ? 120 : undefined, flexShrink: 1 }]} numberOfLines={1}>{doc.number}</Text>
                    <Text style={{ flex: 1, minWidth: 0 }} numberOfLines={isDesktop ? 1 : 3}>{tilesStageLabel(doc.doc_type!, doc.status)}</Text>
                    <Text style={[type.mono, { width: isDesktop ? 110 : undefined, textAlign: isDesktop ? "right" : "left", fontWeight: "700" }]} numberOfLines={1}>
                      {money(doc.grand_total)}
                    </Text>
                  </Pressable>
                ))}
              </Card>
            ) : null}
          </>
        ) : tab === "quotations" ? (
          visibleQuotations.length === 0 ? (
            <Card>
              <EmptyState icon="file-text" title={relatedLoading ? "Loading quotations…" : relatedErrors ? "Quotation records unavailable" : "No quotations yet"} subtitle={relatedLoading ? "Fetching this customer's quotations." : relatedErrors ? "Retry related records to see this customer’s quotations." : "This customer hasn't received a quotation."} />
            </Card>
          ) : (
            <Card padding={0}>
              {visibleQuotations.map((q, i) => (
                <View
                  key={q.id}
                  style={[
                    styles.listRow,
                    !isDesktop && styles.listRowMobile,
                    { borderTopWidth: i > 0 ? StyleSheet.hairlineWidth : 0, borderTopColor: colors.divider },
                  ]}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open quotation ${q.number}`}
                    onPress={() => openQuotation(q)}
                    style={({ pressed, hovered }: any) => [styles.quotationOpen, isPhone && styles.quotationOpenPhone, {
                      backgroundColor: pressed ? colors.surfaceTertiary : hovered ? colors.surfaceSubtle : "transparent",
                    }]}
                    testID={`customer-quotation-${q.id}`}
                  >
                    {isPhone ? (
                      <>
                        <View style={styles.mobileQuotationHeading}>
                          <Text style={[type.mono, { flex: 1, minWidth: 0 }]} numberOfLines={1}>{q.number}</Text>
                          <StatusBadge status={q.status} />
                        </View>
                        <View style={styles.mobileQuotationMeta}>
                          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                            <Text style={type.titleSm} numberOfLines={1}>{q.items.length} items</Text>
                            <Text style={type.caption}>{fmtDate(q.created_at)}</Text>
                          </View>
                          <Text style={[type.mono, styles.mobileQuotationTotal]} numberOfLines={1}>
                            {money(q.grand_total)}
                          </Text>
                        </View>
                      </>
                    ) : (
                      <>
                        <Text style={[type.mono, { width: 120, flexShrink: 1 }]} numberOfLines={1}>{q.number}</Text>
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <Text style={type.titleSm} numberOfLines={1}>{q.items.length} items</Text>
                          <Text style={type.caption}>{fmtDate(q.created_at)}</Text>
                        </View>
                        <Text style={[type.mono, { width: 110, textAlign: "right", fontWeight: "700" }]} numberOfLines={1}>
                          {money(q.grand_total)}
                        </Text>
                        <StatusBadge status={q.status} />
                      </>
                    )}
                  </Pressable>
                  <View style={isPhone ? styles.mobileQuotationActions : undefined}>
                    <Button
                      label={isPhone ? "Manage" : "Manage products"}
                      icon="edit-3"
                      variant="secondary"
                      size="sm"
                      onPress={() => manageQuotation(q)}
                      testID={`manage-quotation-products-${q.id}`}
                    />
                  </View>
                </View>
              ))}
            </Card>
          )
        ) : tab === "po_final" ? (
          <PoFinal key={`${selectedFloorId}:${id}`} customerId={id} />
        ) : tab === "purchases" ? (
          <View style={{ gap: spacing.lg }}>
            {isTilesFloor ? (
              <Card>
                <EmptyState
                  icon="grid"
                  title="Ground Floor tile movement"
                  subtitle="Tile orders use Released, Godown, Dispatch, and Delivered. Open Tile Orders to move this customer's products through the correct workflow."
                  action={<Button label="Open Tile Orders" icon="grid" onPress={() => router.push("/(admin)/tiles/orders" as any)} testID="customer-ground-floor-tile-orders" />}
                />
              </Card>
            ) : <>
            <Card>
              <View style={{ gap: spacing.md }}>
                <Text style={type.overline}>Purchase filters</Text>
                <TextField
                  value={productSearch}
                  onChangeText={setProductSearchFilter}
                  placeholder="Search product, SKU, PO, or brand"
                  leftIcon="search"
                  rightIcon={productSearch ? "x" : undefined}
                  onRightPress={productSearch ? () => setProductSearchFilter("") : undefined}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="customer-workspace-search"
                />
                <MobileFilterSection testID="customer-purchase-filters">
                <View style={{ gap: spacing.sm }}>
                  <Text style={type.caption}>Brands</Text>
                  <View style={styles.serverFilterWrap}>
                    {brandOptions.map((brand) => (
                      <Chip
                        key={brand.id}
                        label={brand.name}
                        count={brand.count}
                        active={!!brand.id && filterValues(brandFilter).includes(brand.id)}
                        onPress={() => setBrandWorkspaceFilter((current) => toggleFilterValue(current, brand.id || "", "") || null)}
                        testID={`customer-workspace-brand-${brand.id}`}
                      />
                    ))}
                  </View>
                </View>
                <View style={{ gap: spacing.sm }}>
                  <Text style={type.caption}>Stages</Text>
                  <View style={styles.serverFilterWrap}>
                    {stageOptions.map((stage) => (
                      <Chip
                        key={stage.key}
                        label={stage.label}
                        count={stage.count}
                        active={filterValues(stageFilter).includes(stage.key)}
                        onPress={() => setStageWorkspaceFilter((current) => toggleFilterValue(current, stage.key, "") || null)}
                        testID={`customer-workspace-stage-${stage.key}`}
                      />
                    ))}
                  </View>
                </View>
                {hasServerFilters ? (
                  <View style={styles.serverFilterWrap}>
                    {workspaceFilters.productSearch ? (
                      <Chip
                        label={`Search: ${workspaceFilters.productSearch}`}
                        active
                        icon="x"
                        onPress={() => setProductSearchFilter("")}
                        testID="customer-workspace-clear-search"
                      />
                    ) : null}
                    {brandFilter ? (
                      <Chip
                        label={`Brands: ${selectedBrand || brandFilter}`}
                        active
                        icon="x"
                        onPress={() => setBrandWorkspaceFilter(null)}
                        testID="customer-workspace-clear-brand"
                      />
                    ) : null}
                    {stageFilter ? (
                      <Chip
                        label={`Stages: ${selectedStage || stageFilter}`}
                        active
                        icon="x"
                        onPress={() => setStageWorkspaceFilter(null)}
                        testID="customer-workspace-clear-stage"
                      />
                    ) : null}
                    <Button
                      label="Clear filters"
                      variant="ghost"
                      size="sm"
                      onPress={clearServerFilters}
                      testID="customer-workspace-clear-all"
                    />
                  </View>
                ) : null}
                </MobileFilterSection>
              </View>
            </Card>

            {workspaceLoading ? (
              <Card>
                <EmptyState
                  icon="refresh-cw"
                  title="Loading filtered purchases"
                  subtitle="Refreshing products, facets, and totals for these filters."
                />
              </Card>
            ) : workspaceError ? (
              <Card>
                <EmptyState
                  icon="alert-triangle"
                  title="Couldn’t refresh these purchases"
                  subtitle={workspaceError}
                  action={<Button label="Retry" variant="secondary" icon="refresh-cw" onPress={() => { void loadWorkspace(workspaceFilters); }} testID="customer-workspace-retry" />}
                />
              </Card>
            ) : !workspace ? (
              <Card>
                <EmptyState icon="shopping-cart" title="No purchase activity" subtitle="Orders will appear here after placement." />
              </Card>
            ) : (
              <>
              {stockTransfers.length > 0 ? <Card style={{ gap: spacing.sm }}>
                <Text style={type.overline}>GoDown stock transfers</Text>
                <Text style={type.caption}>Stock allocated directly to this customer, including quantity and transfer price. Earlier borrowed stock retains its return status.</Text>
                {stockTransfers.map((transfer) => {
                  const legacyLoan = transfer.transfer_type !== "godown_stock" && transfer.status !== "completed";
                  const legacySource = legacyLoan && transfer.source_customer_id === id;
                  return <View key={transfer.id} style={{ paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: 3 }}>
                    <Text style={type.body}>{transfer.name} · {transfer.qty} {transfer.qty === 1 ? "unit" : "units"}</Text>
                    <Text style={type.caption}>{legacyLoan ? legacySource ? `Lent to ${transfer.recipient_customer_name}` : `Borrowed from ${transfer.source_customer_name || "GoDown stock"}` : `From GoDown stock${transfer.source_customer_name ? ` · originally from ${transfer.source_customer_name}` : ""}${transfer.recipient_purchase_item_id ? " · PO Final quantity moved to In Box" : ""}`}</Text>
                    {legacyLoan ? <Text style={type.caption}>{transfer.status === "returned" ? "Returned" : transfer.return_due ? "Return due" : "Return when ordered stock arrives"}</Text> : <Text style={type.caption}>MRP {money(transfer.mrp ?? transfer.unit_price ?? 0)} · Selling price {money(transfer.unit_price ?? 0)} · Discount {transfer.discount_pct ?? 0}% · Net {money(transfer.net_unit_price ?? transfer.unit_price ?? 0)} per unit · Total {money(transfer.total ?? (transfer.net_unit_price ?? transfer.unit_price ?? 0) * transfer.qty)}</Text>}
                    {transfer.reason ? <Text style={type.caption}>Note: {transfer.reason}</Text> : null}
                    {legacyLoan && transfer.status === "awaiting_return" && (transfer.return_due || !transfer.recipient_purchase_item_id) ? <Pressable accessibilityRole="button" accessibilityLabel={`Mark borrowed ${transfer.name} returned`} disabled={returningTransferId === transfer.id} onPress={() => void markLegacyStockReturned(transfer.id)} style={[styles.itemActionBtn, { alignSelf: "flex-start", paddingHorizontal: spacing.md }]}><Text style={type.caption}>{returningTransferId === transfer.id ? "Saving…" : "Mark returned"}</Text></Pressable> : null}
                  </View>;
                })}
              </Card> : null}
              {/* Shortage / reorder alerts — raised automatically when a transfer left this
                  customer under-fulfilled against their original order. */}
              {workspace.shortages.length > 0 ? (
                <View style={{ gap: spacing.sm }}>
                  {workspace.shortages.map((s) => (
                    <Card key={s.id} style={{ backgroundColor: "#FBEAEA", borderColor: "#EFC2C2" }}>
                      <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "flex-start" }}>
                        <Feather name="alert-triangle" size={16} color={colors.error} style={{ marginTop: 2 }} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={{ fontSize: 13, fontWeight: "700", color: "#8A2C2C" }}>
                            Product transferred · {s.name}
                          </Text>
                          <Text style={{ fontSize: 12.5, color: "#8A2C2C", marginTop: 2 }}>
                            {s.reason}
                          </Text>
                          <View style={styles.awaitingReorderPill}>
                            <Text style={{ fontSize: 10.5, fontWeight: "700", color: "#8A2C2C" }}>
                              STATUS: AWAITING REORDER
                            </Text>
                          </View>
                        </View>
                        <View style={{ gap: 6 }}>
                          <Button
                            label="Create PO"
                            size="sm"
                            icon="plus"
                            loading={shortageBusy === s.id}
                            onPress={() => createPoForShortage(s)}
                            testID={`shortage-create-po-${s.id}`}
                          />
                          <Button
                            label="Dismiss"
                            size="sm"
                            variant="ghost"
                            loading={shortageBusy === s.id}
                            onPress={() => dismissShortage(s)}
                            testID={`shortage-dismiss-${s.id}`}
                          />
                        </View>
                      </View>
                    </Card>
                  ))}
                </View>
              ) : null}

              {/* Expected delivery banner */}
              {workspace.expected_delivery.next_at ? (
                <Card style={{ backgroundColor: "#FBF0DD", borderColor: "#E7C77A" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                    <View style={styles.deliveryIcon}>
                      <Feather name="truck" size={16} color="#8A6116" />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 13, fontWeight: "700", color: "#5C4008" }}>
                        Next expected delivery · {fmtDate(workspace.expected_delivery.next_at)}
                      </Text>
                      <Text style={type.caption} numberOfLines={1}>
                        {workspace.expected_delivery.purchase_orders.map((p) => p.po_number).join(", ")}
                      </Text>
                    </View>
                  </View>
                </Card>
              ) : null}

              {/* Purchase summary */}
              <View style={[styles.statsRow, !isDesktop && styles.statsRowMobile]}>
                <StatTile onPress={() => setProductFilter("all")} label="Order Value" value={moneyShort(workspace.summary.order_value ?? workspace.summary.total_value)} icon="shopping-bag" tone="brand" sub={`${workspace.summary.total_items} products`} />
                <StatTile onPress={() => setProductFilter("outstanding")} label="Outstanding" value={moneyShort(workspace.summary.outstanding_value)} icon="clock" tone="warning" sub={`${workspace.summary.outstanding_count} pending`} />
                <StatTile onPress={() => setOpenOrdersVisible(true)} label="Open POs" value={String(workspace.summary.open_pos)} icon="file-text" tone="brand" sub={`${purchases.length} total`} />
                <StatTile onPress={() => setProductFilter("blocked")} label="Delayed" value={String(workspace.summary.blocked_count)} icon="alert-triangle" tone={workspace.summary.blocked_count > 0 ? "danger" : "success"} sub="Past SLA" />
              </View>
              {(workspace.summary.refund_due || 0) > 0 ? <Card style={{ backgroundColor: colors.errorBg, borderColor: colors.errorBorder }}>
                <Text style={type.bodyStrong}>Refund due · {money(workspace.summary.refund_due || 0)}</Text>
                <Text style={type.caption}>Cash received exceeds the final order value after products moved to godown. Check Payments before settling the customer.</Text>
              </Card> : null}

              {/* Brands + Stages breakdown */}
              <View style={{ flexDirection: isDesktop ? "row" : "column", gap: spacing.lg }}>
                <Card style={{ flex: 1 }}>
                  <Text style={[type.overline, { marginBottom: spacing.sm }]}>Brands ordered</Text>
                  {workspace.brands.length === 0 ? (
                    <Text style={type.caption}>No brand data yet</Text>
                  ) : (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {workspace.brands.map((b) => (
                        <View key={b.id || "unbranded"} style={styles.chip}>
                          <Text style={styles.chipText}>{b.name}</Text>
                          <View style={styles.chipCount}><Text style={styles.chipCountText}>{b.count}</Text></View>
                        </View>
                      ))}
                    </View>
                  )}
                </Card>
                <Card style={{ flex: 1 }}>
                  <Text style={[type.overline, { marginBottom: spacing.sm }]}>Current stages</Text>
                  <View style={{ gap: 6 }}>
                    {workspace.stages.filter((s) => s.count > 0).length === 0 ? (
                      <Text style={type.caption}>No items in flight</Text>
                    ) : workspace.stages.filter((s) => s.count > 0).map((s) => {
                      const tone = STAGE_TONE[s.key as keyof typeof STAGE_TONE];
                      const pct = workspace.summary.total_items > 0 ? (s.count / workspace.summary.total_items) * 100 : 0;
                      return (
                        <View key={s.key} style={{ gap: 3 }}>
                          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                            <Text style={{ fontSize: 12.5, color: colors.onSurface, fontWeight: "600" }}>{s.label}</Text>
                            <Text style={{ fontSize: 12.5, color: colors.onSurfaceMuted }}>{s.count}</Text>
                          </View>
                          <View style={styles.barTrack}>
                            <View style={[styles.barFill, { width: `${Math.max(4, pct)}%`, backgroundColor: tone?.fg || colors.onSurfaceMuted }]} />
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </Card>
              </View>

              {/* Products ordered */}
              <Card padding={0}>
                <View style={{ padding: spacing.lg, paddingBottom: spacing.sm, flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <View style={{ flex: 1, minWidth: isDesktop ? 220 : 0, gap: 4 }}>
                    <Text style={type.overline}>Products ordered</Text>
                    <Text style={type.caption}>
                      {hasServerFilters ? "Server filters are applied before the chips below." : "Use All, Outstanding, or Delayed on the filtered workspace."}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: isPhone ? "wrap" : "nowrap", gap: 6, maxWidth: "100%" }}>
                    <FilterChip label={`All ${workspace.products.length}`} active={productFilter === "all"} onPress={() => setProductFilter("all")} />
                    <FilterChip label={`Outstanding ${workspace.outstanding_items.length}`} active={filterValues(productFilter).includes("outstanding")} onPress={() => setProductFilter(current => toggleFilterValue(current, "outstanding"))} />
                    <FilterChip label={`Delayed ${workspace.summary.blocked_count}`} active={filterValues(productFilter).includes("blocked")} onPress={() => setProductFilter(current => toggleFilterValue(current, "blocked"))} />
                  </View>
                </View>
                {visibleProducts.length === 0 ? (
                  <View style={{ padding: spacing.lg, paddingTop: 0 }}>
                    <EmptyState
                      icon={hasServerFilteredEmpty ? "search" : productFilter === "all" ? "shopping-cart" : "filter"}
                      title={
                        hasServerFilteredEmpty
                          ? "No products match these filters"
                          : productFilter === "all"
                            ? "No products ordered yet"
                            : "No products in this view"
                      }
                      subtitle={
                        hasServerFilteredEmpty
                          ? "Try removing search, brand, or stage filters to widen the workspace."
                          : productFilter === "all"
                            ? "Products will appear here once purchase orders are created for this customer."
                            : "Outstanding and Delayed only narrow the current workspace. Switch back to All to see every filtered product."
                      }
                      action={hasServerFilteredEmpty ? (
                        <Button
                          label="Clear filters"
                          variant="secondary"
                          onPress={clearServerFilters}
                          testID="customer-workspace-empty-clear"
                        />
                      ) : hasClientFilteredEmpty ? (
                        <Button
                          label="Show all"
                          variant="secondary"
                          onPress={() => setProductFilter("all")}
                          testID="customer-workspace-empty-show-all"
                        />
                      ) : undefined}
                    />
                  </View>
                ) : visibleProducts.map((p, i) => (
                  <View
                    key={p.item_id}
                    style={{
                      flexDirection: "row", flexWrap: isDesktop ? "nowrap" : "wrap", alignItems: "center", gap: 10, padding: spacing.md,
                      borderTopWidth: i > 0 ? StyleSheet.hairlineWidth : 0, borderTopColor: colors.divider,
                      backgroundColor: p.blocked ? "#FBEAEA" : "transparent",
                    }}
                  >
                    <Pressable onPress={() => router.push(`/(admin)/purchase-orders/${p.po_id}` as any)} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <ProductImage
                        source={p.image}
                        style={[styles.prodThumb, !isDesktop ? styles.prodThumbMobile : {}]}
                        contentFit="contain"
                        disableSkeleton
                        fallbackLabel={p.sku}
                        borderRadius={6}
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 13, fontWeight: "600", color: colors.onSurface }} numberOfLines={isDesktop ? 1 : 2}>{p.name}</Text>
                        <Text style={type.caption} numberOfLines={isDesktop ? 1 : 2}>
                          {p.sku} · {p.brand_name || "—"}{p.supplier_name ? ` · via ${p.supplier_name}` : ""} · Qty {p.qty}
                        </Text>
                        {(p.customer_loan_history || []).map((loan) => <Text key={loan.transfer_id} style={type.caption}>We have lent {loan.qty} {loan.qty === 1 ? "unit" : "units"} to {loan.destination_customer_name || "another customer"} · {loan.status === "returned" ? "returned" : "available again when the replacement reaches In Box"}. This order remains visible.</Text>)}
                        {!p.customer_loan_history?.length && (p.loaned_qty || 0) > 0 ? <Text style={type.caption}>We have lent {p.loaned_qty} {p.loaned_qty === 1 ? "unit" : "units"} to another customer. This order remains visible until the replacement reaches In Box.</Text> : null}
                        {p.borrowed_from_customer_name ? <Text style={type.caption}>Received from {p.borrowed_from_customer_name} · {p.loan_return_status === "returned" ? "returned" : "return when your ordered product arrives"}</Text> : null}
                      </View>
                    </Pressable>
                    {p.loan_transfer_id && p.loan_return_due && (p.loan_return_status === "awaiting_return" || p.loan_return_status === "return_due") ? <Pressable accessibilityRole="button" accessibilityLabel={`Mark borrowed ${p.name} returned to ${p.borrowed_from_customer_name || "original customer"}`} disabled={returningPurchaseLoanId === p.loan_transfer_id} onPress={() => void markPurchaseLoanReturned(p.loan_transfer_id!)} style={[styles.itemActionBtn, { paddingHorizontal: spacing.sm }]}><Text style={type.caption}>{returningPurchaseLoanId === p.loan_transfer_id ? "Saving…" : "Mark returned"}</Text></Pressable> : null}
                    <View style={[styles.stagePillSm, { backgroundColor: STAGE_TONE[p.stage as keyof typeof STAGE_TONE]?.bg || colors.surfaceTertiary }]}>
                      <Text style={{ fontSize: 11, fontWeight: "600", color: STAGE_TONE[p.stage as keyof typeof STAGE_TONE]?.fg || colors.onSurfaceMuted }}>
                        {p.stage_label}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", gap: 6, width: isDesktop ? undefined : "100%", justifyContent: isDesktop ? "flex-start" : "flex-end" }}>
                      <Pressable testID={`ws-history-${p.item_id}`} onPress={() => setHistoryItemId(p.item_id)} style={styles.itemActionBtn} hitSlop={6}>
                        <Feather name="clock" size={12} color={colors.onSurface} />
                      </Pressable>
                      <Pressable testID={`ws-move-${p.item_id}`} onPress={() => setMoveItem(p)} style={styles.itemActionBtn} hitSlop={6}>
                        <Feather name="arrow-right" size={12} color={colors.onSurface} />
                      </Pressable>
                      {p.stage === "in_box" ? <Pressable testID={`ws-transfer-${p.item_id}`} accessibilityLabel={`Transfer ${p.name} to another customer`} onPress={() => setTransferItem(p)} style={styles.itemActionBtn} hitSlop={6}>
                        <Feather name="repeat" size={12} color={colors.onSurface} />
                      </Pressable> : null}
                    </View>
                  </View>
                ))}
              </Card>

              {/* Purchase Orders */}
              <Card padding={0}>
                <Text style={[type.overline, { padding: spacing.lg, paddingBottom: spacing.sm }]}>Purchase orders</Text>
                {workspace.purchase_orders.length === 0 ? (
                  <View style={{ padding: spacing.lg, paddingTop: 0 }}><Text style={type.caption}>None yet.</Text></View>
                ) : workspace.purchase_orders.map((p, i) => (
                  <Pressable
                    key={p.id}
                    onPress={() => router.push(`/(admin)/purchase-orders/${p.id}` as any)}
                    style={({ pressed, hovered }: any) => [
                      styles.listRow,
                      !isDesktop && styles.listRowMobile,
                      {
                        borderTopWidth: i > 0 ? StyleSheet.hairlineWidth : 0,
                        borderTopColor: colors.divider,
                        backgroundColor: pressed ? colors.surfaceTertiary : hovered ? colors.surfaceSubtle : "transparent",
                      },
                    ]}
                  >
                      <Text style={[type.mono, { width: isDesktop ? 120 : undefined, flexShrink: 1 }]} numberOfLines={1}>{p.number}</Text>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={type.titleSm} numberOfLines={1}>{p.brand_name || "—"} · {p.item_count} items</Text>
                      <Text style={type.caption}>{fmtDate(p.created_at)}{p.expected_delivery_at ? ` · ETA ${fmtDate(p.expected_delivery_at)}` : ""}</Text>
                    </View>
                      <Text style={[type.mono, { width: isDesktop ? 110 : undefined, textAlign: isDesktop ? "right" : "left", fontWeight: "700" }]}>
                      {money(p.current_order_value ?? p.grand_total)}
                    </Text>
                    <StatusBadge status={p.status} />
                  </Pressable>
                ))}
              </Card>

              {/* Recent activity */}
              <Card>
                <Text style={[type.overline, { marginBottom: spacing.md }]}>Recent activity</Text>
                <ActivityTimeline events={workspace.recent_activity} dense emptyLabel="No activity yet" />
              </Card>
              </>
            )}
            </>}
          </View>
        ) : (
          <Card>
            <ActivityTimeline events={timeline} emptyLabel={relatedLoading ? "Loading activity…" : relatedErrors ? "Activity unavailable. Retry related records." : "Nothing yet"} />
          </Card>
        )}
      </ScrollView>

      <Sheet scroll visible={openOrdersVisible} onClose={() => setOpenOrdersVisible(false)} title="Open purchase orders">
        <View style={{ gap: spacing.sm }}>
          {(workspace?.purchase_orders || []).filter(order => order.status !== "cancelled").map(order => (
            <Button key={order.id} label={`${order.number} · ${money(order.current_order_value ?? order.grand_total)}`} variant="secondary" onPress={() => { setOpenOrdersVisible(false); router.push(`/(admin)/purchase-orders/${order.id}` as any); }} />
          ))}
          {!workspace?.purchase_orders.some(order => order.status !== "cancelled") ? <Text style={type.caption}>No open purchase orders.</Text> : null}
        </View>
      </Sheet>
      <MoveStageSheet
        visible={!!moveItem}
        item={moveItem ? toMovable(moveItem) : null}
        onClose={() => setMoveItem(null)}
        onMoved={async () => { await reloadAll(); }}
      />
      <TransferSheet
        visible={!!transferItem}
        item={transferItem ? toMovable(transferItem) : null}
        onClose={() => setTransferItem(null)}
        onSuccess={async () => { await reloadAll(); }}
      />
      <HistorySheet
        visible={!!historyItemId}
        itemId={historyItemId}
        onClose={() => setHistoryItemId(null)}
      />
      <WalkInFollowupSheet
        visible={walkInSheet}
        onClose={() => setWalkInSheet(false)}
        customer={customer}
        onCreate={createWalkInFollowup}
      />

    </SafeAreaView>
  );
}

function Row({ icon, text }: { icon: keyof typeof Feather.glyphMap; text: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
      <Feather name={icon} size={iconSize.sm} color={colors.onSurfaceMuted} />
      <Text style={[type.bodySm, { color: colors.onSurfaceSecondary, flex: 1, minWidth: 0 }]} numberOfLines={1}>{text}</Text>
    </View>
  );
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.filterChip,
        active && { backgroundColor: colors.brand, borderColor: colors.brand },
      ]}
    >
      <Text style={{ fontSize: 11.5, fontWeight: "600", color: active ? colors.onBrand : colors.onSurfaceSecondary }}>
        {label}
      </Text>
    </Pressable>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return "—"; }
}

function firstParam(value?: string | string[]): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] || null;
  return null;
}

const styles = StyleSheet.create({
  exportActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  statsRow: { flexDirection: "row", gap: spacing.md },
  statsRowMobile: { flexWrap: "wrap" },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  listRowMobile: {
    flexWrap: "wrap",
    alignItems: "flex-start",
    paddingHorizontal: spacing.md,
  },
  quotationOpen: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.md, borderRadius: radius.sm },
  quotationOpenPhone: { width: "100%", flexBasis: "100%", flexGrow: 1, flexDirection: "column", alignItems: "stretch", justifyContent: "center" },
  mobileQuotationHeading: { width: "100%", minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  mobileQuotationMeta: { width: "100%", minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  mobileQuotationTotal: { maxWidth: "48%", textAlign: "right", fontWeight: "700" },
  mobileQuotationActions: { width: "100%", alignItems: "flex-end" },
  deliveryIcon: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: "#F3DFA3",
    alignItems: "center", justifyContent: "center",
  },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: colors.surfaceTertiary,
  },
  chipText: { fontSize: 12.5, fontWeight: "600", color: colors.onSurface },
  chipCount: {
    minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.surface,
    alignItems: "center", justifyContent: "center", paddingHorizontal: 4,
  },
  chipCountText: { fontSize: 10.5, fontWeight: "700", color: colors.onSurfaceMuted },
  barTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3 },
  prodThumb: {
    width: 36, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: 6, backgroundColor: colors.surfaceTertiary,
    alignItems: "center", justifyContent: "center", overflow: "hidden",
  },
  prodThumbMobile: { width: 52, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO },
  stagePillSm: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  itemActionBtn: {
    width: 44, height: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  filterChip: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  serverFilterWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  awaitingReorderPill: {
    alignSelf: "flex-start", marginTop: 6,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    backgroundColor: "#F5D5D5",
  },
});
