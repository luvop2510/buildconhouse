import { formatPhone } from "@/src/utils/phone";
import { MobileFilterSection, MultiSelectFilterBar } from "@/src/components/ds";
import { filterValues, toggleFilterValue } from "@/src/utils/filters";
import { WALKIN_SUMMARY_LABELS, walkinSummaryFilters, type WalkinSummary } from "@/src/utils/walkinSummary";
import { Disclosure } from "@/src/design/Disclosure";
import { ExcelExportButton } from "@/src/components/ExcelExportButton";
// Walk-ins — Phase 4 (2026-07-30). Company-wide CRM entry point:
// Walk-in -> Customer -> Selection -> Quotation -> Order -> Dispatch -> Payment.
// Dedicated workspace: KPI dashboard + filterable list, matching the same
// premium design language as Follow-ups / Tile Orders (Card/Chip/StatTile).
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { walkinsApi, type WalkIn, type WalkInCursor, type WalkInsDashboard } from "@/src/api/walkins";
import { toast } from "@/src/components/Toast";
import { Button, Chip, EmptyState, ErrorState, LoadingState, PageHeader, SearchField, StatTile } from "@/src/components/ui";
import { WalkInCard } from "@/src/components/walkins/WalkInCard";
import { setSelectedFloorId, useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { hasGrantAccess } from "@/src/team-delegation";
import { useModuleAccess } from "@/src/hooks/use-permissions";
import { useBp } from "@/src/design/responsive";
import { spacing, type } from "@/src/theme/tokens";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" }, { value: "new", label: "New" }, { value: "contacted", label: "Contacted" },
  { value: "selection_scheduled", label: "Selection Scheduled" }, { value: "converted", label: "Converted" },
  { value: "lost", label: "Lost" },
];
const WALKIN_EXPORT_LIMIT = 2000;

async function openUrl(url: string) {
  if (Platform.OS === "web") {
    // @ts-ignore — web only
    window.open(url, "_blank");
  } else {
    await Linking.openURL(url);
  }
}

export default function WalkInsScreen({
  fixedFloorId, title = "Walk-ins", quotationFollowup = false, enableQuotationTransfer = false,
}: { fixedFloorId?: string; title?: string; quotationFollowup?: boolean; enableQuotationTransfer?: boolean } = {}) {
  const router = useRouter();
  const { isPhone } = useBp();
  const { floors: assignedFloors, selectedFloorId } = useFloorAccess();
  const { staff } = useAuth();
  const hasModuleAccess = useModuleAccess();
  const floors = staff?.custom_access ? assignedFloors.filter(floor => hasGrantAccess(staff.access_grants, floor.id, "walkins")) : assignedFloors;
  const canCreate = !staff?.custom_access || hasGrantAccess(staff.access_grants, fixedFloorId || selectedFloorId, "walkins", "create");
  const canUpdate = (record: WalkIn) => !staff?.custom_access || hasGrantAccess(staff.access_grants, record.floor_id, "walkins", "update");
  const canDelete = (record: WalkIn) => ["first-floor", "ground-floor"].includes(record.floor_id) && !!staff && (staff.custom_access
    ? hasGrantAccess(staff.access_grants, record.floor_id, "walkins", "delete")
    : ["owner", "admin", "manager"].includes(staff.role));
  const deleting = useRef(new Set<string>());
  const [pendingDeletes, setPendingDeletes] = useState(new Map<string, object>());
  const [summaryError, setSummaryError] = useState(false);
  const [summaryRevision, setSummaryRevision] = useState(0);
  const [savingSelections, setSavingSelections] = useState<string[]>([]);
  const selectionWrites = useRef(new Map<string, { scope: object; previousStatus: WalkIn["status"] }>());
  const refreshList = useRef<((background?: boolean) => Promise<void>) | null>(null);
  const activeRead = useRef<{ query: object; controller: AbortController; append: boolean } | null>(null);
  const mounted = useRef(true);
  const [dashboard, setDashboard] = useState<WalkInsDashboard | null>(null);
  const [confirmedItems, setItems] = useState<WalkIn[]>([]);
  const [status, setStatus] = useState("");
  const [summaryView, setSummaryView] = useState<WalkinSummary | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState<{ query: object; cursor: WalkInCursor | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [floorId, setFloorId] = useState(fixedFloorId || selectedFloorId);
  const [floorFilterReady, setFloorFilterReady] = useState(Boolean(fixedFloorId || selectedFloorId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const previousActiveFloor = useRef(selectedFloorId);
  const [loading, setLoading] = useState(true);

  const accessibleFloorIds = floors.map(floor => floor.id).join(",");
  const followingFloorId = !fixedFloorId && selectedFloorId && selectedFloorId !== previousActiveFloor.current && (!floorId || floorId === previousActiveFloor.current) ? selectedFloorId : floorId;
  const filterFloorIds = fixedFloorId || followingFloorId || (floorFilterReady ? accessibleFloorIds : "");

  // Reject old callbacks before passive effects clean up a previous floor/query.
  const scopeKey = JSON.stringify([staff?.id, fixedFloorId, selectedFloorId, filterFloorIds]);
  const scopeRef = useRef({ key: scopeKey });
  if (scopeRef.current.key !== scopeKey) scopeRef.current = { key: scopeKey };
  const activeScope = scopeRef.current;
  const items = confirmedItems.filter(item => pendingDeletes.get(item.id) !== activeScope);
  const queryKey = JSON.stringify([scopeKey, quotationFollowup, status, summaryView, sourceFilter, searchQuery]);
  const queryRef = useRef({ key: queryKey });
  if (queryRef.current.key !== queryKey) queryRef.current = { key: queryKey };
  const activeQuery = queryRef.current;
  const currentPage = page?.query === activeQuery;
  const nextCursor = currentPage ? page.cursor : null;
  const listFilters = useMemo(() => ({
    status: summaryView ? undefined : quotationFollowup ? "converted" : status || undefined,
    ...walkinSummaryFilters(summaryView), floor_ids: filterFloorIds,
    source: sourceFilter || undefined, search: searchQuery || undefined,
  }), [summaryView, quotationFollowup, status, filterFloorIds, sourceFilter, searchQuery]);

  // The cursor is based on server ordering, so removing a confirmed row can
  // keep previously loaded pages and continue from the same boundary.
  const reconcileListRead = () => {
    const read = activeRead.current;
    if (!read) return;
    if (!read.append) {
      void refreshList.current?.(true);
      return;
    }
    read.controller.abort();
    activeRead.current = null;
    setLoadingMore(false);
  };

  const deleteWalkin = async (record: WalkIn) => {
    if (!mounted.current || scopeRef.current !== activeScope || !canDelete(record)
        || deleting.current.has(record.id) || selectionWrites.current.has(record.id)) return;
    deleting.current.add(record.id);
    setPendingDeletes(previous => new Map(previous).set(record.id, activeScope));
    try {
      await walkinsApi.remove(record.id, record.floor_id);
      if (mounted.current && scopeRef.current === activeScope) {
        reconcileListRead();
        setItems(current => current.filter(item => item.id !== record.id));
        setSummaryRevision(value => value + 1);
      }
    } catch (error: any) {
      if (mounted.current && scopeRef.current === activeScope) toast.error(`${error?.detail || "Could not confirm deletion"}. The walk-in has been restored; refresh to check or try again.`);
    } finally {
      deleting.current.delete(record.id);
      if (mounted.current) setPendingDeletes(previous => { const next = new Map(previous); next.delete(record.id); return next; });
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; activeRead.current?.controller.abort(); };
  }, []);

  useEffect(() => {
    if (fixedFloorId) {
      setFloorId(fixedFloorId);
      setFloorFilterReady(true);
      return;
    }
    if (!selectedFloorId || selectedFloorId === previousActiveFloor.current) return;
    const wasFollowingActiveFloor = !floorId || floorId === previousActiveFloor.current;
    previousActiveFloor.current = selectedFloorId;
    if (wasFollowingActiveFloor) setFloorId(selectedFloorId);
    setFloorFilterReady(true);
  }, [fixedFloorId, floorId, selectedFloorId]);

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const loadSummary = useCallback(async (signal?: AbortSignal) => {
    if (!filterFloorIds || !mounted.current || scopeRef.current !== activeScope) return;
    setSummaryError(false);
    setDashboard(null);
    try {
      const dash = await walkinsApi.dashboard({ floorId: fixedFloorId || undefined, signal }, filterFloorIds);
      if (!signal?.aborted && mounted.current && scopeRef.current === activeScope) setDashboard(dash);
    } catch {
      if (!signal?.aborted && mounted.current && scopeRef.current === activeScope) setSummaryError(true);
    }
  }, [fixedFloorId, filterFloorIds, activeScope]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSummary(controller.signal);
    return () => controller.abort();
  }, [loadSummary, summaryRevision]);

  const load = useCallback(async (background = false, cursor?: WalkInCursor) => {
    if (!filterFloorIds || !mounted.current || queryRef.current !== activeQuery) return;
    if (cursor && activeRead.current?.query === activeQuery) return;
    activeRead.current?.controller.abort();
    const read = { query: activeQuery, controller: new AbortController(), append: Boolean(cursor) };
    activeRead.current = read;
    const signal = read.controller.signal;
    const isCurrent = () => !signal.aborted && mounted.current && queryRef.current === activeQuery && activeRead.current === read;
    setLoadError(null);
    setPageError(null);
    setLoadingMore(read.append);
    if (!background) setLoading(true);
    try {
      const result = await walkinsApi.page(listFilters, cursor, { floorId: fixedFloorId || undefined, signal });
      if (!isCurrent()) return;
      const received = result.items.map(item => {
        const pending = selectionWrites.current.get(item.id);
        if (pending?.scope !== activeScope) return item;
        pending.previousStatus = item.status;
        return { ...item, status: "selection_scheduled" as const };
      });
      if (cursor) {
        setItems(current => {
          const loaded = new Set(current.map(item => item.id));
          return [...current, ...received.filter(item => !loaded.has(item.id))];
        });
      } else {
        setItems(received);
      }
      // Advance by the raw server page even if a row was already displayed.
      setPage({ query: activeQuery, cursor: result.next_cursor });
    } catch (e: any) {
      if (!isCurrent()) return;
      const message = e?.detail || "Could not load walk-ins";
      if (cursor) setPageError(message);
      else setLoadError(message);
    } finally {
      if (isCurrent()) {
        activeRead.current = null;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [fixedFloorId, filterFloorIds, listFilters, activeQuery, activeScope]);
  refreshList.current = load;

  const loadMore = () => { if (nextCursor) void load(true, nextCursor); };

  useEffect(() => { walkinsApi.listSources().then(result => setSources(result.sources)).catch(() => {}); }, []);
  useEffect(() => {
    void load();
    return () => {
      if (activeRead.current?.query === activeQuery) activeRead.current.controller.abort();
    };
  }, [load, activeQuery]);

  const openSummary = (view: WalkinSummary) => {
    setSummaryView(view);
    setStatus("");
    setSourceFilter("");
    setSearch("");
  };

  const callCustomer = (w: WalkIn) => {
    if (!w.customer_phone) { toast.error("No phone number on file"); return; }
    openUrl(`tel:${w.customer_phone}`);
  };
  const whatsAppCustomer = async (w: WalkIn) => {
    try {
      const res = await walkinsApi.contact(w.id, "whatsapp", { floorId: w.floor_id });
      if (res.wa_url) await openUrl(res.wa_url);
      toast.success("WhatsApp opened");
    } catch (e: any) {
      toast.error(e?.detail || "Could not open WhatsApp");
    }
  };
  const scheduleSelection = async (w: WalkIn) => {
    if (w.floor_id !== "ground-floor" || !mounted.current || scopeRef.current !== activeScope || selectionWrites.current.has(w.id) || deleting.current.has(w.id)) return;
    const pending = { scope: activeScope, previousStatus: w.status };
    selectionWrites.current.set(w.id, pending);
    setSavingSelections(current => [...current, w.id]);
    const optimistic = { ...w, status: "selection_scheduled" as const };
    setItems(current => current.map(item => item.id === w.id ? optimistic : item));
    try {
      const saved = await walkinsApi.update(w.id, { status: "selection_scheduled" }, { floorId: w.floor_id });
      if (!mounted.current || scopeRef.current !== activeScope) return;
      setItems(current => current.map(item => item.id === w.id ? saved : item));
      // Supersede pre-write reads; the new response applies current server filters.
      void refreshList.current?.(true);
      setSummaryRevision(current => current + 1);
      toast.success("Marked as Selection Scheduled");
    } catch (e: any) {
      if (!mounted.current || scopeRef.current !== activeScope) return;
      setItems(current => current.map(item => item.id === w.id && item.status === "selection_scheduled" ? { ...item, status: pending.previousStatus } : item));
      toast.error(e?.detail || "Could not save selection schedule. Previous status restored.");
    } finally {
      selectionWrites.current.delete(w.id);
      if (mounted.current) setSavingSelections(current => current.filter(id => id !== w.id));
    }
  };
  const visitShowroom = async (w: WalkIn) => {
    try {
      const transfer = await walkinsApi.visitShowroom(w.id, { floorId: w.floor_id });
      if (!mounted.current || scopeRef.current !== activeScope) return;
      reconcileListRead();
      setItems(current => current.filter(item => item.id !== w.id));
      toast.success("Transferred to Visit Showroom follow-ups");
      // Navigate before the new floor selection triggers the shell's floor
      // routing effect. The follow-ups inbox is shared and filtered by the
      // record's floor, so it remains the destination for this transfer.
      if (!hasModuleAccess("followups")) return;
      void setSelectedFloorId(w.floor_id).catch(() => {});
      router.push(`/(admin)/followups?workspace=visit_showroom&showroom_followup=${encodeURIComponent(transfer.followup_id)}` as any);
    } catch (e: any) { toast.error(e?.detail || "Could not transfer to follow-ups"); }
  };
  const saveQuotationPrice = async (w: WalkIn, quotationPrice: number | null) => {
    try {
      await walkinsApi.update(w.id, { quotation_price: quotationPrice }, { floorId: w.floor_id });
      if (!mounted.current || scopeRef.current !== activeScope) return;
      reconcileListRead();
      setItems((current) => current.map((item) => item.id === w.id ? { ...item, quotation_price: quotationPrice } : item));
      toast.success("Price saved");
    } catch (e: any) {
      toast.error(e?.detail || "Could not save price");
      throw e;
    }
  };
  const transferToQuotationFollowup = async (w: WalkIn) => {
    try {
      await walkinsApi.update(w.id, { status: "converted" }, { floorId: w.floor_id });
      if (!mounted.current || scopeRef.current !== activeScope) return;
      reconcileListRead();
      setItems((current) => current.filter((item) => item.id !== w.id));
      toast.success("Transferred to Quotation Follow-up");
    } catch (e: any) {
      toast.error(e?.detail || "Could not transfer customer");
    }
  };
  const exportRows = async (signal: AbortSignal) => {
    const rows = await walkinsApi.list(listFilters, { floorId: fixedFloorId || undefined, signal, cacheMs: 0 });
    if (rows.length >= WALKIN_EXPORT_LIMIT) throw new Error("This list reached the 2,000-walk-in limit. Narrow the filters before exporting.");
    return [
      ["Customer", "Phone", "Walk-in", "Visited", "Status", "Salesperson", "Floor", "Source", "Interested products", "Next follow-up"],
      ...rows.map(item => [item.customer_name, formatPhone(item.customer_phone), item.number, item.visited_at, item.status.replace(/_/g, " "), item.salesperson_name || "Unassigned", item.floor_id, item.source, item.interested_products.join(", "), item.next_followup_at]),
    ];
  };
  const pageHeader = <PageHeader
    title={title} overline={quotationFollowup ? "QUOTATION FOLLOW-UP" : "CRM"}
    subtitle="Every customer journey starts here"
    actions={<View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {canCreate ? <Button label="Log Walk-in" size="sm" icon="user-plus" onPress={() => router.push((fixedFloorId ? `/(admin)/walkins/new?floor_id=${fixedFloorId}` : "/(admin)/walkins/new") as any)} testID="walkin-new-btn" /> : null}
      <ExcelExportButton resource="walkins" page={title} section="Filtered walk-ins" filename="walk-ins.xlsx" floorId={filterFloorIds} scopeKey={queryKey} disabled={!currentPage || loading || Boolean(loadError) || !items.length} testID="walkins-export-excel" loadRows={exportRows} />
    </View>}
    embedded={isPhone}
  />;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={isPhone ? [] : ["top"]}>
      {!isPhone ? pageHeader : null}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, paddingBottom: isPhone ? spacing.xl : spacing.xxxl, gap: spacing.lg }}>
        {isPhone ? pageHeader : null}
        <Disclosure title="Walk-in summary">
        {summaryError ? <Text role="status" style={[type.bodyMuted, { marginBottom: spacing.sm }]}>Summary unavailable. Your walk-in register is still available below.</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.lg }}>
          <StatTile onPress={() => openSummary("today")} label="Today" value={dashboard?.today_walkins ?? "—"} icon="user-plus" tone="brand" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile onPress={() => openSummary("week")} label="This Week" value={dashboard?.this_week ?? "—"} icon="calendar" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile onPress={() => openSummary("pending")} label="Pending Follow-ups" value={dashboard?.pending_followups ?? "—"} icon="clock" tone="warning" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile onPress={() => openSummary("scheduled")} label="Selections Scheduled" value={dashboard?.selections_scheduled ?? "—"} icon="calendar" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile onPress={() => openSummary("converted")} label="Converted" value={dashboard?.converted ?? "—"} icon="check-circle" tone="success" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile onPress={() => openSummary("lost")} label="Lost" value={dashboard?.lost ?? "—"} icon="x-circle" tone="danger" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile onPress={() => openSummary("conversion")} label="Conversion Rate" value={dashboard ? `${dashboard.conversion_rate}%` : "—"} icon="trending-up" tone="brand" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
          <StatTile onPress={() => openSummary("average")} label="Avg. Conversion" value={dashboard ? `${dashboard.avg_conversion_days}d` : "—"} icon="activity" style={{ minWidth: isPhone ? 120 : 140, flex: 1 }} />
        </View>

        </Disclosure>
        <MobileFilterSection testID="walkins-filters" style={{ gap: spacing.sm }}>
        {summaryView ? <Chip label={`${WALKIN_SUMMARY_LABELS[summaryView]} · Clear`} active onPress={() => setSummaryView(null)} /> : null}
        <SearchField
          placeholder="Search customer, phone, salesperson, source, notes…"
          value={search} onChangeText={setSearch} onClear={() => setSearch("")}
          testID="walkins-search"
        />
        {!quotationFollowup ? <View style={{ gap: spacing.sm }}>
          <Text style={type.captionStrong}>STATUS</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((s) => (
            <Chip key={s.value} label={s.label} active={s.value ? filterValues(status, "").includes(s.value) : !status} onPress={() => { setSummaryView(null); setStatus(current => toggleFilterValue(current, s.value, "")); }} />
          ))}
          </View>
        </View> : null}
        {floors.length > 1 && !fixedFloorId ? (
          <View style={{ gap: spacing.sm }}>
            <Text style={type.captionStrong}>DEPARTMENT</Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
            <Chip label="All departments" active={!floorId} onPress={() => setFloorId("")} />
            {floors.map((f) => (
              <Chip key={f.id} testID={`walkins-floor-${f.id}`} label={f.name} active={filterValues(floorId, "").includes(f.id)} onPress={() => setFloorId(current => toggleFilterValue(current, f.id, ""))} />
            ))}
            </View>
          </View>
        ) : null}

        <MultiSelectFilterBar label="LEAD SOURCE" values={filterValues(sourceFilter, "")} onChange={next => setSourceFilter(next.join(","))} options={[{ value: "all", label: "All sources" }, ...sources.map(source => ({ value: source, label: source }))]} testID="walkins-source-filters" />
        </MobileFilterSection>

        {savingSelections.some(id => selectionWrites.current.get(id)?.scope === activeScope) ? <Text role="status" style={type.bodyMuted}>Saving selection schedule…</Text> : null}
        {loadError ? <ErrorState title="Could not load walk-ins" subtitle={loadError} onRetry={() => void load()} /> : loading || !currentPage ? <LoadingState label="Loading walk-ins…" /> : (
          <>
          {items.length === 0 && !nextCursor ? <EmptyState icon="user-plus" title="No walk-ins yet" subtitle="Log your first walk-in to start the pipeline." /> : null}
          {items.map((w) => (
            <WalkInCard
              key={w.id} w={w}
              onPress={() => router.push(`/(admin)/walkins/${w.id}?floor_id=${w.floor_id}` as any)}
              onCall={() => callCustomer(w)}
              onWhatsApp={canUpdate(w) ? () => { void whatsAppCustomer(w); } : undefined}
              onDelete={canDelete(w) ? () => { void deleteWalkin(w); } : undefined}
              onScheduleSelection={canUpdate(w) && w.floor_id === "ground-floor" ? () => scheduleSelection(w) : undefined}
              onVisitShowroom={!quotationFollowup && canUpdate(w) ? () => visitShowroom(w) : undefined}
              quotationFollowup={quotationFollowup}
              onSaveQuotationPrice={quotationFollowup ? (price) => saveQuotationPrice(w, price) : undefined}
              onTransferToQuotation={enableQuotationTransfer ? () => { void transferToQuotationFollowup(w); } : undefined}
            />
          ))}
          {pageError ? <ErrorState title="Could not load more walk-ins" subtitle={pageError} onRetry={loadMore} /> : nextCursor ? (
            <Button label="Show more" variant="secondary" loading={loadingMore} onPress={loadMore} testID="walkins-show-more" />
          ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
