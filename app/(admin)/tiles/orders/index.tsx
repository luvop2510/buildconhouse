import { filterValues, toggleFilterValue } from "@/src/utils/filters";
// frontend/app/(admin)/tiles/orders/index.tsx
// Ground Floor → Tiles → Tile Orders — four tabs matching how BuildCon
// staff actually think about this workflow (redesigned 2026-08, replacing
// the old Customer/Company/Dispatch List purchase-order-centric layout):
//   - Customer               — one row per CustomerOrder.
//   - Brands                 — one row per BRAND (Qutone, Dimore,
//     Kajaria…), not per dealer/supplier company. "I need to release
//     Kajaria" is a brand lookup, not a company lookup.
//   - Dispatch List          — the logistics queue.
//   - Material Movement Register — the permanent, chronological audit
//     trail of every box's journey (Order Created → Release → Move to
//     Godown → Dispatch from Released/Godown → Delivered).
//
// Every table on this screen is a <DataTable/>: a column declares its width
// and alignment once and both the header and the body cell read from that
// declaration, which is what stops labels drifting off their columns.
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Feather from "@expo/vector-icons/Feather";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import {
  tileOrdersApi,
  type BrandLandingCard,
  type CompletedTileOrder,
  type CustomerOrderCard,
  type DispatchListRow,
  type GodownInventoryRow,
  type MaterialMovementRow,
} from "@/src/api/tileOrders";
import { toast } from "@/src/components/Toast";
import { CreateDispatchSheet } from "@/src/components/tiles/CreateDispatchSheet";
import { DispatchRecordSheet, openChalanPdf } from "@/src/components/tiles/DispatchRecordSheet";
import {
  Button, ButtonGroup, FilterChip, PageShell,
  SearchField,
} from "@/src/components/tiles/TileLayout";
import { NavigationTabs } from "@/src/design/NavigationTabs";
import { TileOrdersExcelButton } from "@/src/components/tiles/TileOrdersExcelButton";
import { StatusPill } from "@/src/components/tiles/TileOrderStatusUI";
import { tileIdentityMeta } from "@/src/components/tiles/tilePresentation";
import {
  CellChevron, CellLink, CellMono, CellNumber, CellStack, CellText, CellTitle, DataTable,
  ProgressCell, type Column,
} from "@/src/components/tiles/TileTable";
import { Sheet } from "@/src/components/ui";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type TabKey = "customer" | "brands" | "history" | "inventory" | "dispatch-list" | "material-register";

// These four label strings are pinned by scripts/verify-tile-orders-contract.mjs
// — they are the operator-facing vocabulary for the module and must not be
// abbreviated for layout reasons.
const TABS: [TabKey, string][] = [
  ["customer", "Customer"],
  ["brands", "Brands"],
  ["history", "History"],
  ["inventory", "Go-down Inventory"],
  ["dispatch-list", "Dispatch List"],
  ["material-register", "Material Movement Register"],
];

const WORK_QUEUES: { key: Extract<TabKey, "customer" | "brands" | "dispatch-list">; label: string; description: string; icon: keyof typeof Feather.glyphMap }[] = [
  { key: "customer", label: "Customer orders", description: "See every order and its current fulfilment state.", icon: "users" },
  { key: "brands", label: "Release queue", description: "Release material brand by brand, without supplier hunting.", icon: "package" },
  { key: "dispatch-list", label: "Dispatch board", description: "Open chalans and confirm what is leaving today.", icon: "truck" },
];

const RECORDS: { key: Extract<TabKey, "history" | "inventory" | "material-register">; label: string; description: string; icon: keyof typeof Feather.glyphMap }[] = [
  { key: "inventory", label: "Go-down stock", description: "Material received and waiting at the go-down.", icon: "archive" },
  { key: "history", label: "Completed", description: "Delivered orders and final values.", icon: "check-circle" },
  { key: "material-register", label: "Movement register", description: "The permanent audit trail for every box.", icon: "activity" },
];

// "At Godown" and "Delivered" became reachable once the Dispatch record
// sheet exposed Mark received at Godown / Mark Delivered — until then
// nothing ever set godown_received_at or delivered_at, so both chips would
// have been permanently dead options.
const DISPATCH_STATUS_FILTERS = ["All", "Dispatched", "At Godown", "Delivered"] as const;
const CUSTOMER_STATUS_FILTERS = [
  ["All", "All active"],
  ["Pending", "Awaiting release"],
  ["Ready", "Released"],
  ["Partially Dispatched", "Partially dispatched"],
] as const;

const MOVEMENT_LABEL: Record<string, string> = {
  order_created: "Order Created",
  release: "Release",
  move_to_godown: "Move to Godown",
  dispatch_from_released: "Dispatch from Released",
  dispatch_from_godown: "Dispatch from Godown",
  delivered: "Delivered",
};

function dispatchRowKey(row: DispatchListRow, index: number) {
  // A Dispatch/Chalan may legitimately contain multiple lines with the
  // same product name, so the render index is required as a final stable
  // per-response discriminator.
  return `${row.dispatch_id}-${row.chalan_id}-${row.tile_name}-${index}`;
}

function timestamp(value: string | undefined | null) {
  return value ? value.slice(0, 16).replace("T", " ") : "—";
}

function quantityLabel(value: number | string, unit?: "Box" | "Pieces") {
  return `${value} ${unit === "Pieces" ? "pieces" : "boxes"}`;
}

function TileOrdersNavigator({ value, onChange }: {
  value: TabKey;
  onChange: (key: TabKey) => void;
}) {
  return <NavigationTabs
    testID="tile-orders-tab"
    accessibilityLabel="Tile order views"
    value={value}
    onChange={onChange}
    options={[...WORK_QUEUES, ...RECORDS].map(item => ({ value: item.key, label: item.label, icon: item.icon }))}
  />;
}

/** Search stays in reach; secondary filters disclose without clearing drafts. */
function QueueToolbar({ search, filters, actions, filterCount = 0 }: { search?: ReactNode; filters?: ReactNode; actions?: ReactNode; filterCount?: number }) {
  const { isPhone } = useBreakpoint();
  const [expanded, setExpanded] = useState(!isPhone);
  const contentId = useId();
  return <View style={styles.queueToolbar}>
    <View style={styles.queueSearchRow}>
      {search ? <View style={styles.queueSearch}>{search}</View> : null}
      {filters ? <Pressable
        testID="tile-table-filters-toggle"
        accessibilityRole="button"
        accessibilityLabel={filterCount ? `Filters, ${filterCount} active` : "Filters"}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        aria-controls={contentId}
        onPress={() => setExpanded(value => !value)}
        style={({ pressed }) => [styles.queueFilterToggle, (expanded || filterCount > 0) && styles.queueFilterToggleActive, pressed && styles.queueFilterTogglePressed]}
      ><Feather accessible={false} name="sliders" size={18} color={expanded || filterCount > 0 ? colors.brand : colors.onSurfaceSecondary} />{filterCount > 0 ? <Text style={styles.activeFilterCount}>{filterCount}</Text> : null}</Pressable> : null}
      {actions ? <View style={styles.queueActions}>{actions}</View> : null}
    </View>
    {filters ? <View nativeID={contentId} testID="tile-table-filters-content" style={{ display: expanded ? "flex" : "none" }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.queueFilterScroller} contentContainerStyle={styles.queueFilters}>{filters}</ScrollView>
    </View> : null}
  </View>;
}

export default function TileOrdersScreen() {
  useRequireFloorAccess("ground-floor");
  const { staff } = useAuth();
  const readOnlyDeliveryLookup = staff?.access_profile === "ground_tile_quotations_followups";
  const router = useRouter();
  const { isPhone, isTablet } = useBreakpoint();
  // Deep-link params let the Customer workspace jump straight here with the
  // right tab already selected and pre-filtered to that order — "View
  // Register"/"View Dispatches" on a customer order are navigations INTO
  // this screen, not separate screens.
  const params = useLocalSearchParams<{ tab?: string; search?: string; customer_id?: string }>();
  const initialTab = (TABS.find(([key]) => key === params.tab)?.[0] as TabKey | undefined) ?? "customer";

  const [tab, setTab] = useState<TabKey>(initialTab);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customerOrders, setCustomerOrders] = useState<CustomerOrderCard[]>([]);
  const [brands, setBrands] = useState<BrandLandingCard[]>([]);
  const [customerSearch, setCustomerSearch] = useState(params.search ?? "");
  const [customerSearchDraft, setCustomerSearchDraft] = useState(params.search ?? "");
  const [customerStatus, setCustomerStatus] = useState<string>("All");
  const [brandSearch, setBrandSearch] = useState(params.search ?? "");
  const [brandSearchDraft, setBrandSearchDraft] = useState(params.search ?? "");
  const [history, setHistory] = useState<CompletedTileOrder[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<CompletedTileOrder | null>(null);
  const [inventory, setInventory] = useState<GodownInventoryRow[]>([]);
  const [historySearch, setHistorySearch] = useState(params.search ?? "");
  const [historySearchDraft, setHistorySearchDraft] = useState(params.search ?? "");
  const [historyDateRange, setHistoryDateRange] = useState<"All" | "30d" | "year">("All");
  const [inventorySearch, setInventorySearch] = useState(params.search ?? "");
  const [inventorySearchDraft, setInventorySearchDraft] = useState(params.search ?? "");
  const [movements, setMovements] = useState<MaterialMovementRow[]>([]);
  const [movementSearch, setMovementSearch] = useState(params.search ?? "");
  const [movementSearchDraft, setMovementSearchDraft] = useState(params.search ?? "");
  const [selectedMovement, setSelectedMovement] = useState<MaterialMovementRow | null>(null);
  const [dispatchRows, setDispatchRows] = useState<DispatchListRow[]>([]);
  const [dispatchSearch, setDispatchSearch] = useState(params.search ?? "");
  const [dispatchSearchDraft, setDispatchSearchDraft] = useState(params.search ?? "");
  const [dispatchStatus, setDispatchStatus] = useState<string>("All");
  const [openDispatchId, setOpenDispatchId] = useState<string | null>(null);
  const [creatingDispatch, setCreatingDispatch] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const requestId = useRef(0);
  const requestController = useRef<AbortController | null>(null);

  // Searching should not depend on spotting the phone keyboard's Submit key.
  // A small delay prevents a request per keystroke while still making the
  // result list feel directly connected to what the operator is typing.
  useEffect(() => {
    const timer = setTimeout(() => setCustomerSearch(customerSearchDraft.trim()), 300);
    return () => clearTimeout(timer);
  }, [customerSearchDraft]);
  useEffect(() => {
    const timer = setTimeout(() => setBrandSearch(brandSearchDraft.trim()), 300);
    return () => clearTimeout(timer);
  }, [brandSearchDraft]);
  useEffect(() => {
    const timer = setTimeout(() => setDispatchSearch(dispatchSearchDraft.trim()), 300);
    return () => clearTimeout(timer);
  }, [dispatchSearchDraft]);
  useEffect(() => {
    const timer = setTimeout(() => setHistorySearch(historySearchDraft.trim()), 300);
    return () => clearTimeout(timer);
  }, [historySearchDraft]);
  useEffect(() => {
    const timer = setTimeout(() => setInventorySearch(inventorySearchDraft.trim()), 300);
    return () => clearTimeout(timer);
  }, [inventorySearchDraft]);
  useEffect(() => {
    const timer = setTimeout(() => setMovementSearch(movementSearchDraft.trim()), 300);
    return () => clearTimeout(timer);
  }, [movementSearchDraft]);

  const load = useCallback(async (nextPage = 1, pageNavigation = false) => {
    // Page controls retain the current 30-row result while their replacement
    // is in flight. A fresh query still owns the full-screen loading state.
    if (pageNavigation && loadingMoreRef.current) return;
    loadingMoreRef.current = pageNavigation;
    setLoadingMore(pageNavigation);
    const currentRequest = ++requestId.current;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (!pageNavigation) setLoading(true);
    setLoadError(null);
    try {
      if (tab === "customer") {
        const result = await tileOrdersApi.listCustomerOrders({
          page: nextPage, page_size: 30, customer_id: params.customer_id,
          search: customerSearch || undefined,
          status: customerStatus === "All" ? undefined : customerStatus,
        }, controller.signal);
        if (currentRequest !== requestId.current) return;
        setCustomerOrders(result.orders);
        setHasMore(result.has_more);
      } else if (tab === "brands") {
        const result = await tileOrdersApi.listBrands({ page: nextPage, page_size: 30, search: brandSearch || undefined }, controller.signal);
        if (currentRequest !== requestId.current) return;
        setBrands(result.brands);
        setHasMore(result.has_more);
      } else if (tab === "history") {
        const dateFrom = historyDateRange === "year" ? `${new Date().getFullYear()}-01-01` : historyDateRange === "30d" ? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) : undefined;
        const result = await tileOrdersApi.listHistory({ search: historySearch || undefined, date_from: dateFrom, page: nextPage, page_size: 30 }, controller.signal);
        if (currentRequest !== requestId.current) return;
        setHistory(result.rows);
        setHasMore(result.has_more);
      } else if (tab === "inventory") {
        const result = await tileOrdersApi.listInventory({ search: inventorySearch || undefined, page: nextPage, page_size: 30 }, controller.signal);
        if (currentRequest !== requestId.current) return;
        setInventory(result.rows);
        setHasMore(result.has_more);
      } else if (tab === "dispatch-list") {
        const result = await tileOrdersApi.listDispatchList({
          search: dispatchSearch || undefined,
          status: dispatchStatus === "All" ? undefined : dispatchStatus,
          page: nextPage, page_size: 30,
        }, controller.signal);
        if (currentRequest !== requestId.current) return;
        setDispatchRows(result.rows);
        setHasMore(result.has_more);
      } else {
        const result = await tileOrdersApi.listMovements({
          search: movementSearch || undefined,
          page: nextPage, page_size: 30,
        }, controller.signal);
        if (currentRequest !== requestId.current) return;
        setMovements(result.rows);
        setHasMore(result.has_more);
      }
      if (currentRequest === requestId.current) setPage(nextPage);
    } catch (e: any) {
      if (currentRequest !== requestId.current) return;
      const message = e?.detail || "Could not load orders";
      setLoadError(message);
      toast.error(message);
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
      }
    }
  }, [tab, movementSearch, dispatchSearch, dispatchStatus, historySearch, historyDateRange, inventorySearch, customerSearch, customerStatus, brandSearch, params.customer_id]);

  // The customer-order screen can mutate go-down stock while this tab stays
  // mounted in the navigation stack. Re-fetch whenever the screen becomes
  // visible so returning to Go-down Inventory cannot show a stale snapshot.
  useFocusEffect(useCallback(() => {
    void load(1);
    return () => { requestId.current += 1; requestController.current?.abort(); };
  }, [load]));

  const openCustomerOrder = (id: string) => router.push(`/(admin)/tiles/orders/${id}` as any);
  const openBrand = (brandId: string | null) =>
    router.push(`/(admin)/tiles/orders/brands/${brandId || "unassigned"}` as any);

  // Show loading immediately on a workspace switch. Without this, the prior
  // tab's data could flash for a frame while the new query was scheduled.
  const changeTab = (nextTab: TabKey) => {
    if (nextTab === tab) return;
    requestId.current += 1;
    requestController.current?.abort();
    setLoading(true);
    setTab(nextTab);
  };

  // ── Column definitions ────────────────────────────────────────────────────
  // Names and descriptions `grow` so a wide monitor is filled by the columns
  // that benefit from width; counters, statuses and action clusters stay at a
  // fixed width so they line up vertically no matter the viewport.

  // Widths are chosen so the whole row fits the content area of a 1512px
  // window beside the 240px app sidebar (≈1208px) without horizontal
  // scrolling — this is the module's landing table and an operator should
  // never have to scroll sideways to see an order's status. Wider monitors
  // spend the surplus on the two `grow` columns.
  const customerColumns = useMemo<Column<CustomerOrderCard>[]>(() => [
    {
      key: "customer", label: "CUSTOMER", grow: 2, minWidth: 200, mobile: "primary",
      render: (order) => isPhone ? <View style={{ gap: spacing.xs }}><CellStack title={order.customer_name} subtitle={order.number} /><Text numberOfLines={2} style={type.bodyMuted}>{order.brands.map(brand => brand.brand_name).join(", ") || "Brand not recorded"}</Text></View> : <CellTitle>{order.customer_name}</CellTitle>,
    },
    {
      // An order number is an identifier an operator reads aloud and types
      // into a search box — it gets the width to render in full
      // ("TORD-2026-0003"), where a customer name may ellipsize.
      key: "number", label: "ORDER NO.", width: 164, mobile: "hidden",
      render: (order) => <CellMono>{order.number}</CellMono>,
    },
    {
      key: "brands", label: "BRANDS", grow: 2, minWidth: 160, mobile: "hidden",
      render: (order) => <CellText muted>{order.brands.map((b) => b.brand_name).join(", ") || "—"}</CellText>,
    },
    {
      // 110 is the floor for this column: it is set by the header word
      // "PRODUCTS", not by the one- or two-digit count underneath it.
      key: "products", label: "PRODUCTS", width: 110, align: "right",
      render: (order) => <CellNumber value={order.total_products} />,
    },
    {
      key: "boxes", label: "QTY", width: 84, align: "right",
      render: (order) => <CellNumber value={order.total_boxes} />,
    },
    {
      // 180px is the narrowest this column can be before the longest pill
      // ("Partially Dispatched") starts to truncate.
      key: "status", label: "STATUS", width: 180, align: "center",
      render: (order) => <StatusPill status={order.overall_status} />,
    },
    {
      key: "waiting", label: "WAITING", width: 90, align: "right", mobile: "hidden",
      render: (order) => <CellNumber value={`${order.waiting_days}d`} dim />,
    },
    {
      key: "progress", label: "PROGRESS", width: 150, mobile: "hidden",
      render: (order) => <ProgressCell percent={order.completion_percentage} />,
    },
    {
      // The row itself is the affordance; this is just the visual cue that
      // says so, so it stays as narrow as a chevron needs to be.
      key: "action", label: "", width: 56, align: "right", mobile: "hidden",
      render: () => <CellChevron />,
    },
  ], [isPhone]);

  const brandColumns = useMemo<Column<BrandLandingCard>[]>(() => [
    {
      key: "brand", label: "BRAND", grow: 3, minWidth: 260, mobile: "primary",
      render: (brand) => <CellTitle>{brand.brand_name}</CellTitle>,
    },
    {
      key: "orders", label: "ACTIVE ORDERS", width: 160, align: "right",
      render: (brand) => <CellNumber value={brand.active_orders} />,
    },
    {
      key: "wait", label: "OLDEST WAIT", width: 160, align: "right",
      render: (brand) => (
        <CellNumber value={brand.max_supplier_silent_days ? `${brand.max_supplier_silent_days}d` : "—"} dim />
      ),
    },
    {
      key: "action", label: "", width: 180, align: "right", mobile: "action",
      render: () => <CellLink>Release queue →</CellLink>,
    },
  ], []);

  const dispatchColumns = useMemo<Column<DispatchListRow>[]>(() => [
    {
      // Number over date, rather than a separate CREATED column. A dispatch's
      // date is an attribute of the dispatch, not an independent axis to scan,
      // and folding it here buys ~110px back for a table that must otherwise
      // scroll to reach its own data.
      key: "number", label: "DISPATCH NO.", width: 176, mobile: "hidden",
      render: (row) => (
        <CellStack title={row.dispatch_number} subtitle={row.dispatch_date?.slice(0, 10) || "—"} />
      ),
    },
    {
      key: "customer", label: "CUSTOMER", grow: 2, minWidth: 180,
      render: (row) => <CellTitle>{row.customer_name}</CellTitle>,
    },
    {
      key: "product", label: "BRAND / TILE", grow: 3, minWidth: 220, mobile: "primary",
      render: (row) => <CellStack title={row.tile_name} subtitle={tileIdentityMeta([row.brand_name], row.sku)} />,
    },
    {
      key: "boxes", label: "QTY", width: 88, align: "right",
      render: (row) => <CellNumber value={quantityLabel(row.boxes, row.quantity_unit)} />,
    },
    {
      // Was two columns, SOURCE and DESTINATION — but a dispatch on this list
      // always terminates at the customer, so DESTINATION rendered the literal
      // word "Customer" on every row of every page. One route column carries
      // the same information and gives ~80px back to the columns that vary.
      // Fits "Released → Customer", the longer of the two possible routes.
      key: "route", label: "ROUTE", width: 180, mobile: "hidden",
      render: (row) => <CellText muted>{row.source} → Customer</CellText>,
    },
    {
      key: "vehicle", label: "VEHICLE / DRIVER", grow: 1, minWidth: 190, mobile: "hidden",
      render: (row) => (
        <CellStack title={row.vehicle_number || "—"} subtitle={row.driver_name || "Driver not recorded"} />
      ),
    },
    {
      key: "status", label: "STATUS", width: 144, align: "center",
      render: (row) => (
        <View style={styles.plainStatus}>
          <Text numberOfLines={1} style={styles.plainStatusText}>{row.status}</Text>
        </View>
      ),
    },
    {
      // Wide enough to hold all four full-length labels on one line — the
      // contract fixes the wording, so the column is sized to the words
      // rather than the words trimmed to fit the column.
      key: "actions", label: "ACTIONS", width: 468, mobile: "action",
      render: (row) => (
        <ButtonGroup>
          <Button
            label="View Dispatch" size="sm" variant="primary"
            testID={`tile-orders-open-dispatch-${row.dispatch_id}`}
            onPress={() => setOpenDispatchId(row.dispatch_id)}
          />
          <Button
            label="View Chalan" size="sm"
            testID={`tile-orders-view-chalan-${row.chalan_id}`}
            onPress={() => openChalanPdf(row.chalan_id)}
          />
          <Button
            label="Print Chalan" size="sm"
            testID={`tile-orders-print-chalan-${row.chalan_id}`}
            onPress={() => openChalanPdf(row.chalan_id, "print")}
          />
          {row.customer_order_id ? (
            <Button
              label="Order" size="sm"
              testID={`tile-orders-dispatch-order-${row.dispatch_id}`}
              onPress={() => router.push(`/(admin)/tiles/orders/${row.customer_order_id}` as any)}
            />
          ) : null}
        </ButtonGroup>
      ),
    },
  ], [router]);

  const movementColumns = useMemo<Column<MaterialMovementRow>[]>(() => [
    {
      key: "time", label: "TIMESTAMP", width: 164, mobile: "hidden",
      render: (row) => <CellMono>{timestamp(row.created_at)}</CellMono>,
    },
    {
      key: "customer", label: "CUSTOMER", grow: 2, minWidth: 170,
      render: (row) => <CellTitle>{row.customer_name}</CellTitle>,
    },
    {
      key: "product", label: "BRAND / TILE", grow: 3, minWidth: 220, mobile: "primary",
      render: (row) => <CellStack title={row.tile_name} subtitle={tileIdentityMeta([row.brand_name], row.sku)} />,
    },
    {
      // Sized to render the longest movement label, "Dispatch from Released",
      // in full. Movement names are a closed vocabulary, so unlike a customer
      // or product name they must never ellipsize.
      key: "movement", label: "MOVEMENT", width: 192,
      render: (row) => <CellText>{MOVEMENT_LABEL[row.movement_type] || row.movement_type}</CellText>,
    },
    {
      key: "qty", label: "QTY", width: 96, align: "right",
      render: (row) => <CellNumber value={quantityLabel(row.boxes, row.quantity_unit)} />,
    },
    {
      // FROM is always a short location word ("Released", "Godown"); TO is
      // usually a customer name, so only TO needs room to grow. Fixing both at
      // 132 truncated every delivery destination by ~77px.
      key: "from", label: "FROM", width: 128, mobile: "hidden",
      render: (row) => <CellText muted>{row.source || "—"}</CellText>,
    },
    {
      key: "to", label: "TO", grow: 1, minWidth: 200, mobile: "hidden",
      render: (row) => <CellText muted>{row.destination || "—"}</CellText>,
    },
    {
      key: "reference", label: "REFERENCE", width: 168, mobile: "hidden",
      render: (row) => <CellMono>{row.chalan_number || row.dispatch_number || "—"}</CellMono>,
    },
    {
      key: "user", label: "USER", grow: 1, minWidth: 156, mobile: "hidden",
      render: (row) => <CellText muted>{row.performed_by_name}</CellText>,
    },
    {
      key: "action", label: "", width: 108, align: "right", mobile: "hidden",
      render: () => <CellLink>Open →</CellLink>,
    },
  ], []);

  const historyColumns = useMemo<Column<CompletedTileOrder>[]>(() => [
    { key: "customer", label: "CUSTOMER", grow: 2, minWidth: 190, mobile: "primary", render: (row) => <CellTitle>{row.customer}</CellTitle> },
    { key: "order", label: "ORDER NO.", width: 160, render: (row) => <CellMono>{row.order_number}</CellMono> },
    { key: "brands", label: "BRANDS", grow: 2, minWidth: 180, mobile: "hidden", render: (row) => <CellText muted>{row.brands.join(", ")}</CellText> },
    { key: "date", label: "COMPLETED", width: 150, render: (row) => <CellMono>{timestamp(row.completion_date)}</CellMono> },
    { key: "products", label: "PRODUCTS", width: 100, align: "right", mobile: "hidden", render: (row) => <CellNumber value={row.products.length} /> },
    { key: "amount", label: "FINAL AMOUNT", width: 140, align: "right", mobile: "hidden", render: (row) => <CellNumber value={row.final_amount} /> },
    { key: "status", label: "STATUS", width: 130, align: "center", render: (row) => <StatusPill status={row.delivery_status as any} /> },
    { key: "action", label: "", width: 56, align: "right", mobile: "hidden", render: () => <CellChevron /> },
  ], []);

  const inventoryColumns = useMemo<Column<GodownInventoryRow>[]>(() => [
    { key: "customer", label: "CUSTOMER", grow: 2, minWidth: 180, mobile: "hidden", render: (row) => <CellTitle>{row.customer}</CellTitle> },
    { key: "name", label: "TILE NAME", grow: 3, minWidth: 220, mobile: "primary", render: (row) => <CellText>{row.name}</CellText> },
    { key: "brand", label: "BRAND", grow: 2, minWidth: 150, render: (row) => <CellText muted>{row.brand}</CellText> },
    { key: "product", label: "SKU", grow: 2, minWidth: 150, mobile: "hidden", render: (row) => <CellMono>{row.product || "—"}</CellMono> },
    { key: "size", label: "SIZE", width: 130, render: (row) => <CellText muted>{row.size || "—"}</CellText> },
    { key: "arrival", label: "ARRIVED", width: 160, mobile: "hidden", render: (row) => <CellMono>{timestamp(row.arrival_date)}</CellMono> },
  ], []);

  const renderBody = () => {
    if (loading) {
      return (
        <View testID="tile-orders-loading" accessibilityLiveRegion="polite" accessibilityState={{ busy: true }} style={styles.stateBlock}>
          <ActivityIndicator color={colors.brand} />
          <Text style={type.bodyMuted}>Loading {[...WORK_QUEUES, ...RECORDS].find(view => view.key === tab)?.label.toLowerCase()}…</Text>
        </View>
      );
    }

    if (loadError) {
      return (
        <View style={styles.stateBlock}>
          <Text style={type.titleSm}>{loadError}</Text>
          <Button label="Retry" variant="primary" testID="tile-orders-retry" onPress={() => load()} />
        </View>
      );
    }

    if (tab === "customer") {
      if (isPhone || isTablet) return <View testID="tile-orders-customer-table" style={styles.customerList}>
        {customerOrders.length === 0 ? <View style={styles.stateBlock}><Text style={type.bodyMuted}>No tile orders yet.</Text></View> : customerOrders.map(order => <Pressable
          key={order.id}
          testID={`tile-orders-customer-${order.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Open tile order ${order.number} for ${order.customer_name}, ${order.overall_status}, ${order.total_products} products, quantity ${order.total_boxes}`}
          accessibilityHint="Opens order details and movement actions"
          onPress={() => openCustomerOrder(order.id)}
          style={({ pressed }) => [styles.customerRow, isTablet && styles.customerRowTablet, pressed && styles.customerRowPressed]}
        >
          <View style={[styles.customerRecord, isTablet && styles.customerRecordTablet]}>
            <View style={styles.customerIdentity}>
              <View style={styles.customerNameBlock}>
                <Text style={styles.customerName}>{order.customer_name}</Text>
                <View style={styles.customerQuantity}>
                  {isTablet ? <Text style={styles.customerFactLabel}>ORDER NO.</Text> : null}
                  <Text style={styles.customerReference}>{order.number}</Text>
                </View>
              </View>
              {!isTablet ? <Feather accessible={false} name="chevron-right" size={16} color={colors.onSurfaceMuted} /> : null}
            </View>
            <View style={styles.customerBrandLine}>
              {isTablet ? <Text style={styles.customerFactLabel}>BRANDS</Text> : null}
              <Text numberOfLines={1} style={styles.customerBrands}>{order.brands.map(brand => brand.brand_name).join(", ") || "Brand not recorded"}</Text>
            </View>
          </View>
          <View style={[styles.customerFacts, isTablet && styles.customerFactsTablet]}>
            <View style={styles.customerQuantity}><Text style={styles.customerFactLabel}>PRODUCTS</Text><Text style={styles.customerFactValue}>{order.total_products}</Text></View>
            <View style={styles.customerQuantity}><Text style={styles.customerFactLabel}>QTY</Text><Text style={styles.customerFactValue}>{order.total_boxes}</Text></View>
            <View style={[styles.customerStatus, isTablet && styles.customerStatusTablet]}><Text style={styles.customerFactLabel}>STATUS</Text><Text style={styles.customerStatusValue}>{order.overall_status}</Text></View>
            {isTablet ? <View style={styles.customerQuantity}><Text style={styles.customerFactLabel}>WAITING</Text><Text style={styles.customerFactValue}>{order.waiting_days}d</Text></View> : null}
            {isTablet ? <Text style={styles.customerReference}>{order.completion_percentage}% complete</Text> : null}
          </View>
          {isTablet ? <Feather accessible={false} name="chevron-right" size={16} color={colors.onSurfaceMuted} /> : null}
        </Pressable>)}
      </View>;
      return (
        <DataTable
          testID="tile-orders-customer-table"
          scrollOwner="parent"
          columns={customerColumns}
          data={customerOrders}
          rowMinHeight={60}
          keyExtractor={(order) => order.id}
          rowTestID={(order) => `tile-orders-customer-${order.id}`}
          rowAccessibilityLabel={(order) => `Open tile order ${order.number} for ${order.customer_name}, ${order.overall_status}, ${order.completion_percentage}% complete`}
          onRowPress={(order) => openCustomerOrder(order.id)}
          emptyMessage="No tile orders yet."
        />
      );
    }

    if (tab === "brands") {
      return (
        <DataTable
          testID="tile-orders-brands-table"
          scrollOwner="parent"
          columns={brandColumns}
          data={brands}
          rowMinHeight={60}
          keyExtractor={(brand) => brand.brand_id || "unassigned"}
          rowTestID={(brand) => `tile-orders-brand-${brand.brand_id || "unassigned"}`}
          rowAccessibilityLabel={(brand) => `Open ${brand.brand_name} release queue, ${brand.active_orders} active orders`}
          onRowPress={(brand) => openBrand(brand.brand_id)}
          emptyMessage="No brands with active orders yet."
        />
      );
    }

    if (tab === "history") {
      return <DataTable testID="tile-orders-history-table" scrollOwner="parent" columns={historyColumns} data={history} rowMinHeight={60} keyExtractor={(row) => row.id} rowTestID={(row) => `tile-orders-history-${row.id}`} rowAccessibilityLabel={(row) => `Open completed order ${row.order_number} for ${row.customer}`} onRowPress={(row) => setSelectedHistory(row)} emptyMessage="No completed tile deliveries yet." />;
    }

    if (tab === "inventory") {
      return <DataTable testID="tile-orders-inventory-table" scrollOwner="parent" columns={inventoryColumns} data={inventory} rowMinHeight={60} keyExtractor={(row) => row.id} emptyMessage="No stock is currently recorded in the go-down." />;
    }

    if (tab === "dispatch-list") {
      return (
        <DataTable
          testID="tile-orders-dispatch-table"
          scrollOwner="parent"
          columns={dispatchColumns}
          data={dispatchRows}
          rowMinHeight={64}
          keyExtractor={dispatchRowKey}
          emptyMessage="No dispatches match this filter. Use “Create dispatch” above to raise one."
        />
      );
    }

    return (
      <DataTable
        testID="tile-orders-movement-table"
        scrollOwner="parent"
        columns={movementColumns}
        data={movements}
        rowMinHeight={56}
        keyExtractor={(row) => row.id}
        rowTestID={(row) => `tile-orders-movement-${row.id}`}
        rowAccessibilityLabel={(row) => `Open ${MOVEMENT_LABEL[row.movement_type] || row.movement_type} movement for ${row.customer_name}`}
        onRowPress={(row) => setSelectedMovement(row)}
        emptyMessage="No material movements recorded yet."
      />
    );
  };

  const exportParams = tab === "customer" ? { search: customerSearch || undefined, status: customerStatus === "All" ? undefined : customerStatus, customer_id: params.customer_id }
    : tab === "brands" ? { search: brandSearch || undefined }
    : tab === "dispatch-list" ? { search: dispatchSearch || undefined, status: dispatchStatus === "All" ? undefined : dispatchStatus }
    : tab === "history" ? { search: historySearch || undefined, date_from: historyDateRange === "year" ? `${new Date().getFullYear()}-01-01` : historyDateRange === "30d" ? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) : undefined }
    : tab === "inventory" ? { search: inventorySearch || undefined }
    : { search: movementSearch || undefined };
  const exportAction = <TileOrdersExcelButton
    section={tab}
    params={exportParams}
    testID={tab === "history" ? "tile-orders-history-export" : `tile-orders-${tab}-export`}
  />;

  return (
    <>
      <PageShell testID="tile-orders-screen">
        <View style={[styles.orderHeader, isPhone && styles.orderHeaderPhone]}>
          <View style={styles.orderHeading}>
            {!isPhone ? <Text style={styles.orderEyebrow}>GROUND FLOOR · TILES</Text> : null}
            <Text accessibilityRole="header" aria-level={1} style={[styles.orderTitle, isPhone && styles.orderTitlePhone]}>Tile Orders</Text>
            {!isPhone ? <Text style={type.bodyMuted}>{[...WORK_QUEUES, ...RECORDS].find(view => view.key === tab)?.description}</Text> : null}
          </View>
          {exportAction}
        </View>

        <View style={styles.stageNavigation}>
          <TileOrdersNavigator value={tab} onChange={changeTab} />
        </View>

        <View testID="tile-orders-body">
          {tab === "customer" ? (
            <QueueToolbar
              search={<SearchField testID="tile-orders-customer-search" value={customerSearchDraft} onChangeText={setCustomerSearchDraft} onSubmit={() => setCustomerSearch(customerSearchDraft.trim())} placeholder="Search customer, phone or order number…" accessibilityLabel="Search active tile orders" />}
              filterCount={customerStatus === "All" ? 0 : filterValues(customerStatus, "All").length}
              filters={CUSTOMER_STATUS_FILTERS.map(([value, label]) => (
                <FilterChip
                  key={value}
                  label={label}
                  active={value === "All" ? customerStatus === "All" : filterValues(customerStatus, "All").includes(value)}
                  testID={`tile-orders-customer-status-${value.toLowerCase().replaceAll(" ", "-")}`}
                  onPress={() => setCustomerStatus(current => toggleFilterValue(current, value, "All"))}
                />
              ))}
            />
          ) : null}

          {tab === "brands" ? (
            <QueueToolbar
              search={<SearchField testID="tile-orders-brand-search" value={brandSearchDraft} onChangeText={setBrandSearchDraft} onSubmit={() => setBrandSearch(brandSearchDraft.trim())} placeholder="Search active brands…" accessibilityLabel="Search tile brands" />}
            />
          ) : null}

          {tab === "dispatch-list" ? (
            <QueueToolbar
              search={
                <SearchField
                  testID="tile-orders-dispatch-search"
                  value={dispatchSearchDraft}
                  onChangeText={setDispatchSearchDraft}
                  onSubmit={() => setDispatchSearch(dispatchSearchDraft.trim())}
                  placeholder="Search customer, brand, product, dispatch, chalan…"
                />
              }
              filterCount={dispatchStatus === "All" ? 0 : filterValues(dispatchStatus, "All").length}
              filters={DISPATCH_STATUS_FILTERS.map((status) => (
                <FilterChip
                  key={status}
                  label={status}
                  active={status === "All" ? dispatchStatus === "All" : filterValues(dispatchStatus, "All").includes(status)}
                  testID={`tile-orders-dispatch-status-${status.toLowerCase().replaceAll(" ", "-")}`}
                  onPress={() => setDispatchStatus(current => toggleFilterValue(current, status, "All"))}
                />
              ))}
              actions={!readOnlyDeliveryLookup ? (
                <Button
                  label="Create dispatch"
                  variant="primary"
                  testID="tile-orders-create-dispatch"
                  onPress={() => setCreatingDispatch(true)}
                />
              ) : undefined}
            />
          ) : null}

          {tab === "material-register" ? (
            <QueueToolbar
              search={
                <SearchField
                  testID="tile-orders-movement-search"
                  value={movementSearchDraft}
                  onChangeText={setMovementSearchDraft}
                  onSubmit={() => setMovementSearch(movementSearchDraft.trim())}
                  placeholder="Search customer, brand, tile, chalan, dispatch…"
                />
              }
            />
          ) : null}

          {tab === "history" ? (
            <QueueToolbar
              search={<SearchField testID="tile-orders-history-search" value={historySearchDraft} onChangeText={setHistorySearchDraft} onSubmit={() => setHistorySearch(historySearchDraft.trim())} placeholder="Search customer, order or brand…" />}
              filterCount={historyDateRange === "All" ? 0 : 1}
              filters={[
                ...(["All", "30d", "year"] as const).map((value) => <FilterChip key={`date-${value}`} label={value === "All" ? "All dates" : value === "30d" ? "Last 30 days" : "This year"} active={historyDateRange === value} onPress={() => setHistoryDateRange(value)} />),
              ]}
            />
          ) : null}

          {tab === "inventory" ? (
            <QueueToolbar
              search={<SearchField testID="tile-orders-inventory-search" value={inventorySearchDraft} onChangeText={setInventorySearchDraft} onSubmit={() => setInventorySearch(inventorySearchDraft.trim())} placeholder="Search customer, name, brand, product or size…" />}
            />
          ) : null}

          {renderBody()}
          {(hasMore || page > 1) && !loading ? (
            <View style={styles.loadMore}>
              {page > 1 ? (
                <Button label="Previous page" disabled={loadingMore} onPress={() => void load(page - 1, true)} testID="tile-orders-previous-page" />
              ) : null}
              <Text style={styles.pageLabel}>Page {page}</Text>
              {hasMore ? (
                <Button label={loadingMore ? "Loading page…" : "Next page"} disabled={loadingMore} onPress={() => void load(page + 1, true)} testID="tile-orders-load-more" />
              ) : null}
            </View>
          ) : null}
        </View>
      </PageShell>

      {openDispatchId ? (
        <DispatchRecordSheet
          dispatchId={openDispatchId}
          onClose={() => setOpenDispatchId(null)}
          onChanged={() => load()}
          readOnly={readOnlyDeliveryLookup}
        />
      ) : null}

      {creatingDispatch ? (
        <CreateDispatchSheet onClose={() => setCreatingDispatch(false)} onCreated={() => load()} />
      ) : null}

      {/* Material Movement Register — every row opens the record behind it,
          with a link to each thing that row touched: the Chalan PDF, the
          Dispatch record, and the customer order/timeline it belongs to. */}
      <Sheet
        scroll
        visible={selectedMovement !== null}
        onClose={() => setSelectedMovement(null)}
        title={selectedMovement ? MOVEMENT_LABEL[selectedMovement.movement_type] || selectedMovement.movement_type : "Movement"}
        subtitle={selectedMovement ? `${timestamp(selectedMovement.created_at)} · ${selectedMovement.performed_by_name}` : undefined}
        testID="tile-orders-movement-sheet"
      >
        {selectedMovement ? (
          <View style={styles.sheetBody}>
            <View style={styles.sheetFacts}>
              <SheetFact label="Customer" value={selectedMovement.customer_name} />
              <SheetFact label="Product" value={tileIdentityMeta([selectedMovement.brand_name, selectedMovement.tile_name], selectedMovement.sku)} />
              <SheetFact label="Quantity" value={quantityLabel(selectedMovement.boxes, selectedMovement.quantity_unit)} />
              <SheetFact
                label="Route"
                value={`${selectedMovement.source || "—"} → ${selectedMovement.destination || "—"}`}
              />
              <SheetFact
                label="Reference"
                value={
                  [
                    selectedMovement.dispatch_number && `Dispatch ${selectedMovement.dispatch_number}`,
                    selectedMovement.chalan_number && `Chalan ${selectedMovement.chalan_number}`,
                  ].filter(Boolean).join(" · ") || "No dispatch or chalan attached"
                }
              />
            </View>

            <ButtonGroup>
              {selectedMovement.chalan_id ? (
                <Button
                  label="View Chalan" variant="primary"
                  testID="tile-orders-movement-chalan"
                  onPress={() => openChalanPdf(selectedMovement.chalan_id!)}
                />
              ) : null}
              {selectedMovement.dispatch_id ? (
                <Button
                  label="Open dispatch"
                  testID="tile-orders-movement-dispatch"
                  onPress={() => { setOpenDispatchId(selectedMovement.dispatch_id); setSelectedMovement(null); }}
                />
              ) : null}
              {selectedMovement.customer_order_id ? (
                <Button
                  label="Open customer order"
                  testID="tile-orders-movement-order"
                  onPress={() => {
                    const id = selectedMovement.customer_order_id!;
                    setSelectedMovement(null);
                    openCustomerOrder(id);
                  }}
                />
              ) : null}
              {selectedMovement.customer_order_id ? (
                <Button
                  label="Open timeline"
                  testID="tile-orders-movement-timeline"
                  onPress={() => {
                    const id = selectedMovement.customer_order_id!;
                    setSelectedMovement(null);
                    router.push(`/(admin)/tiles/orders/${id}?timeline=1` as any);
                  }}
                />
              ) : null}
            </ButtonGroup>
          </View>
        ) : null}
      </Sheet>

      <Sheet
        scroll
        visible={selectedHistory !== null}
        onClose={() => setSelectedHistory(null)}
        title={selectedHistory ? `${selectedHistory.customer} · ${selectedHistory.order_number}` : "Completed delivery"}
        subtitle={selectedHistory ? `Completed ${timestamp(selectedHistory.completion_date)}` : undefined}
        testID="tile-orders-history-sheet"
      >
        {selectedHistory ? (
          <View style={styles.sheetBody}>
            <View style={styles.sheetFacts}>
              <SheetFact label="Customer" value={selectedHistory.customer} />
              <SheetFact label="Brand" value={selectedHistory.brands.join(", ")} />
              <SheetFact label="Delivery status" value={selectedHistory.delivery_status} />
              <SheetFact label="Final amount" value={String(selectedHistory.final_amount)} />
              <SheetFact label="Delivery notes" value={selectedHistory.delivery_notes || "—"} />
              <SheetFact label="Chalans" value={selectedHistory.chalan_references.map((ref) => ref.number).join(", ") || "—"} />
              <SheetFact label="Dispatches" value={selectedHistory.dispatch_references.map((ref) => ref.number).join(", ") || "—"} />
              <SheetFact label="Products" value={selectedHistory.products.map((product) => `${tileIdentityMeta([product.product, product.size], product.sku)} · ${quantityLabel(product.boxes, product.quantity_unit)}${product.pieces == null ? "" : ` · ${product.pieces} pieces`}`).join("; ") || "—"} />
            </View>
            <ButtonGroup>
              <Button label="Open original order" variant="primary" testID="tile-orders-history-open-original" onPress={() => { const id = selectedHistory.id; setSelectedHistory(null); openCustomerOrder(id); }} />
            </ButtonGroup>
          </View>
        ) : null}
      </Sheet>
    </>
  );
}

function SheetFact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={type.body}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  orderHeader: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.md, paddingVertical: spacing.sm },
  orderHeaderPhone: { gap: spacing.sm, paddingVertical: 0 },
  orderHeading: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: spacing.s4 },
  orderEyebrow: { ...type.caption, color: colors.onSurfaceMuted },
  orderTitle: { ...type.titleMd, fontSize: 24, lineHeight: 32 },
  orderTitlePhone: { fontSize: 20, lineHeight: 28 },
  stageNavigation: { marginTop: spacing.sm, marginBottom: spacing.md },
  queueToolbar: { gap: spacing.sm, marginBottom: spacing.md },
  queueSearchRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  queueSearch: { flex: 1, minWidth: 180 },
  queueActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  queueFilterToggle: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.controlBorder, borderRadius: radius.sm, backgroundColor: colors.surfaceSecondary },
  queueFilterToggleActive: { backgroundColor: colors.brandTint, borderColor: colors.brandBorder },
  queueFilterTogglePressed: { opacity: 0.7 },
  activeFilterCount: { ...type.captionStrong, fontSize: 11, lineHeight: 12, color: colors.brand, position: "absolute", top: spacing.s4, right: spacing.s4 },
  queueFilterScroller: { flexGrow: 0, maxWidth: "100%" },
  queueFilters: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  customerList: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surfaceSecondary },
  customerRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.s4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, minHeight: 88 },
  customerRowTablet: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  customerRowPressed: { backgroundColor: colors.brandTint },
  customerRecord: { gap: spacing.s4, minWidth: 0 },
  customerRecordTablet: { flex: 1 },
  customerBrandLine: { flexDirection: "row", alignItems: "center", gap: spacing.s4, minWidth: 0 },
  customerIdentity: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  customerNameBlock: { flex: 1, minWidth: 0 },
  customerName: { ...type.bodyStrong, fontSize: 15, lineHeight: 20 },
  customerReference: { ...type.caption, fontSize: 12, lineHeight: 16, color: colors.onSurfaceMuted },
  customerBrands: { ...type.caption, fontSize: 12, lineHeight: 16, color: colors.onSurfaceMuted, flexShrink: 1 },
  customerFacts: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: spacing.md, rowGap: spacing.s4 },
  customerFactsTablet: { width: "46%", columnGap: spacing.md },
  customerQuantity: { flexDirection: "row", alignItems: "center", gap: spacing.s4 },
  customerFactLabel: { ...type.caption, fontSize: 11, lineHeight: 16, color: colors.onSurfaceMuted },
  customerFactValue: { ...type.captionStrong, fontSize: 12, lineHeight: 16 },
  customerStatus: { flexDirection: "row", alignItems: "center", gap: spacing.s4, flexShrink: 1 },
  customerStatusTablet: { width: "100%" },
  customerStatusValue: { ...type.captionStrong, fontSize: 12, lineHeight: 16, flexShrink: 1 },
  stateBlock: { paddingVertical: spacing.s48, alignItems: "center", gap: spacing.lg },
  loadMore: { paddingTop: spacing.lg, alignItems: "center", flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.md },
  pageLabel: { ...type.body, color: colors.onSurfaceMuted },
  // The Dispatch List's status is a free-text backend string rather than one
  // of the StatusPill ladder values, so it gets a neutral chip of the same
  // height as a pill instead of pretending to be one.
  plainStatus: {
    height: 24,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  plainStatusText: { ...type.captionStrong, fontSize: 12 },
  sheetBody: { padding: spacing.s24, gap: spacing.s24 },
  sheetFacts: { gap: spacing.lg },
  fact: { gap: spacing.s4 },
  factLabel: { ...type.overline, color: colors.onSurfaceMuted },
});
