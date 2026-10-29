import { ConfirmDialog, FilterBar, MobileFilterSection } from "@/src/components/ds";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { canManageDestructiveData } from "@/src/constants/roles";
import { filterValues } from "@/src/utils/filters";
// Quotation Tiles — single tab listing every Ground Floor tiles Selection
// and Quotation, any stage, with two entry points to start a new one. See
// docs/superpowers/specs/2026-07-27-quotation-tiles-workflow-design.md.
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button, EmptyState, ErrorState, PageHeader, SearchField, IconButton } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { useRequireFloorAccessState } from "@/src/hooks/use-floor-access";
import { useBp } from "@/src/design/responsive";
import { colors, money, radius, spacing, type } from "@/src/theme/tokens";
import { tilesStageLabel } from "@/src/components/tiles/tilesStage";

type TilesDoc = {
  id: string; number: string; doc_type: "tiles_selection" | "tiles_quotation";
  doc_number?: string | null; doc_date?: string | null;
  purchase_completion_status?: "active" | "completed";
  status: string; customer_name: string; grand_total: number; updated_at: string;
};
const PAGE_SIZE = 30;
const DOC_TYPES: TilesDoc["doc_type"][] = ["tiles_selection", "tiles_quotation"];

export default function QuotationTilesList() {
  const floor = useRequireFloorAccessState("ground-floor");
  const router = useRouter();
  const { staff } = useAuth();
  const canDelete = useActionAccess("tiles", "delete", canManageDestructiveData(staff?.role));
  const [deleteTarget, setDeleteTarget] = useState<TilesDoc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteInFlight = useRef(false);
  const { view } = useLocalSearchParams<{ view?: string }>();
  const completed = view === "completed" || view === "fulfilled";
  const [documents, setDocuments] = useState<Partial<Record<TilesDoc["doc_type"], TilesDoc[]>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErrors, setLoadErrors] = useState<Partial<Record<TilesDoc["doc_type"], string>>>({});
  const [pages, setPages] = useState<Partial<Record<TilesDoc["doc_type"], { skip: number; hasMore: boolean }>>>({});
  const [loadingMore, setLoadingMore] = useState<Partial<Record<TilesDoc["doc_type"], boolean>>>({});
  const [pageErrors, setPageErrors] = useState<Partial<Record<TilesDoc["doc_type"], string>>>({});
  const moreRequests = useRef(new Map<TilesDoc["doc_type"], symbol>());
  const controllerRef = useRef<AbortController | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const searching = query !== search.trim();
  const scope = `${staff?.id}:${completed}:${floor.ready}:${query}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const requestIdRef = useRef(0);
  const documentScopeRef = useRef<string | null>(null);
  const [documentType, setDocumentType] = useState<string>("all");
  const { isPhone, isTablet } = useBp();
  // The tablet shell reserves a 64px navigation rail. At a 768px viewport the
  // page itself is only about 704px wide, which is not enough for this title
  // and both labelled actions on one line. Stack the actions before they can
  // squeeze the title out of the header.
  const compact = isPhone || isTablet;

  const load = useCallback(async () => {
    if (!floor.ready || scopeRef.current !== scope) return;
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const current = () => requestId === requestIdRef.current && scopeRef.current === scope;
    setLoading(true);
    setLoadErrors({});
    setPages({});
    setPageErrors({});
    setLoadingMore({});
    moreRequests.current.clear();
    const loadType = async (docType: TilesDoc["doc_type"]) => {
      try {
        const result = await api.get<TilesDoc[]>(`/quotations?doc_type=${docType}&view=${completed ? "completed" : "pending"}&summary=true&q=${encodeURIComponent(query)}&skip=0&limit=${PAGE_SIZE + 1}`, { floorId: "ground-floor", signal: controller.signal });
        if (!current()) return;
        documentScopeRef.current = scope;
        const rows = result.slice(0, PAGE_SIZE);
        setDocuments((previous) => ({ ...previous, [docType]: rows }));
        setPages(previous => ({ ...previous, [docType]: { skip: rows.length, hasMore: result.length > PAGE_SIZE } }));
      } catch (error: any) {
        if (!current()) return;
        documentScopeRef.current = scope;
        setLoadErrors((previous) => ({ ...previous, [docType]: error?.detail || `Couldn't load ${docType === "tiles_selection" ? "selections" : "quotations"}.` }));
      }
    };
    await Promise.all(DOC_TYPES.map(loadType));
    if (current()) setLoading(false);
  }, [completed, floor.ready, query, scope]);

  const loadMore = async (docType: TilesDoc["doc_type"]) => {
    const page = pages[docType];
    if (!floor.ready || loading || searching || !page?.hasMore || scopeRef.current !== scope || moreRequests.current.has(docType)) return;
    const requestId = requestIdRef.current;
    const token = Symbol();
    moreRequests.current.set(docType, token);
    const current = () => requestId === requestIdRef.current && scopeRef.current === scope;
    setLoadingMore(previous => ({ ...previous, [docType]: true }));
    setPageErrors(previous => ({ ...previous, [docType]: undefined }));
    try {
      const result = await api.get<TilesDoc[]>(`/quotations?doc_type=${docType}&view=${completed ? "completed" : "pending"}&summary=true&q=${encodeURIComponent(query)}&skip=${page.skip}&limit=${PAGE_SIZE + 1}`, { floorId: "ground-floor", signal: controllerRef.current?.signal });
      if (!current()) return;
      const rows = result.slice(0, PAGE_SIZE);
      setDocuments(previous => {
        const existing = previous?.[docType] || [];
        const ids = new Set(existing.map(doc => doc.id));
        return { ...previous, [docType]: [...existing, ...rows.filter(doc => !ids.has(doc.id))] };
      });
      setPages(previous => ({ ...previous, [docType]: { skip: page.skip + rows.length, hasMore: result.length > PAGE_SIZE } }));
    } catch (error: any) {
      if (current()) setPageErrors(previous => ({ ...previous, [docType]: error?.detail || "More documents couldn’t load. Try again." }));
    } finally {
      if (moreRequests.current.get(docType) === token) moreRequests.current.delete(docType);
      if (current()) setLoadingMore(previous => ({ ...previous, [docType]: false }));
    }
  };

  useFocusEffect(useCallback(() => {
    setDeleteTarget(null);
    setDeleteError(null);
    setDocuments(null);
    setLoadErrors({});
    if (floor.ready) void load();
    return () => { requestIdRef.current += 1; controllerRef.current?.abort(); moreRequests.current.clear(); };
  }, [floor.ready, load]));

  const deleteDocument = async () => {
    if (!deleteTarget || deleteInFlight.current || !canDelete || !floor.ready) return;
    const target = deleteTarget;
    const deletionScope = scope;
    deleteInFlight.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete(`/quotations/${encodeURIComponent(target.id)}`, { floorId: "ground-floor" });
      if (scopeRef.current !== deletionScope) return;
      setDocuments(current => current ? { ...current, [target.doc_type]: (current[target.doc_type] || []).filter(doc => doc.id !== target.id) } : current);
      setPages(current => current[target.doc_type] ? { ...current, [target.doc_type]: { ...current[target.doc_type]!, skip: Math.max(0, current[target.doc_type]!.skip - 1) } } : current);
      if (moreRequests.current.has(target.doc_type)) void load();
      setDeleteTarget(null);
    } catch (error: any) {
      if (scopeRef.current === deletionScope) setDeleteError(error?.detail || "Document could not be deleted. Try again.");
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
    }
  };

  const openDoc = (doc: TilesDoc) => {
    const route = doc.doc_type === "tiles_selection" ? "selection" : "quotation";
    router.push(`/(admin)/tiles/${route}?id=${doc.id}` as any);
  };
  const displayNumber = (doc: TilesDoc) => doc.doc_number || doc.number;
  const docs = !searching && documentScopeRef.current === scope && documents ? [...(documents.tiles_selection || []), ...(documents.tiles_quotation || [])].filter(doc => !filterValues(documentType).length || filterValues(documentType).includes(doc.doc_type)) : null;
  const label = documentType === "tiles_selection" ? "selections" : documentType === "tiles_quotation" ? "quotations" : "documents";

  const selectedTypes = filterValues(documentType);
  const visibleTypes = DOC_TYPES.filter(docType => !selectedTypes.length || selectedTypes.includes(docType));
  const selectedLoading = searching || documentScopeRef.current !== scope || loading && visibleTypes.some(docType => !documents?.[docType] && !loadErrors[docType]);
  const loadError = Object.entries(loadErrors).filter(([key]) => !selectedTypes.length || selectedTypes.includes(key)).map(([, message]) => message).join(" ");
  if (floor.error) return <ErrorState title="Couldn’t open Ground Floor" subtitle={floor.error} onRetry={() => void floor.retry()} />;
  if (!floor.ready) return <View accessibilityLabel="Opening Ground Floor quotations" style={styles.loading}><ActivityIndicator color={colors.brand} /></View>;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <FlatList
        data={docs || []}
        keyExtractor={(d) => d.id}
        contentContainerStyle={{ padding: spacing.lg, gap: 8 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={<View style={{ gap: spacing.md }}>
          {deleteError ? <View accessibilityRole="alert"><Text style={{ color: colors.error }}>{deleteError}</Text></View> : null}
          {loadError ? <ErrorState title="Some tile documents couldn’t load" subtitle={loadError} onRetry={() => void load()} /> : null}
      <PageHeader title={completed ? "Completed tile documents" : "Tile quotations"} overline="Ground Floor · Tiles" embedded actions={
        <View style={[styles.headerActions, compact && styles.headerActionsCompact]}>
          <Button
            label={completed ? "Drafts" : "Completed"}
            variant="secondary"
            icon={compact ? undefined : completed ? "clock" : "check-circle"}
            onPress={() => router.push(`/(admin)/tiles?view=${completed ? "pending" : "completed"}` as any)}
            testID="tiles-lifecycle-toggle"
            style={compact ? styles.compactAction : undefined}
          />
          {!completed ? <Button
            label="New selection"
            variant="ghost"
            icon={compact ? undefined : "grid"}
            onPress={() => router.push("/(admin)/tiles/selection" as any)}
            testID="tiles-create-selection"
            style={compact ? styles.compactAction : undefined}
          /> : null}
          {!completed ? <Button
            label="New quotation"
            icon={compact ? undefined : "layout"}
            onPress={() => router.push("/(admin)/tiles/quotation" as any)}
            testID="tiles-create-quotation"
            style={compact ? styles.compactAction : undefined}
          /> : null}
        </View>
      } />

      <MobileFilterSection testID="tiles-filters">
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}><SearchField value={search} onChangeText={setSearch} onClear={() => setSearch("")} placeholder="Search customer or document number" /></View>
      <View style={styles.filterBar}>
        <FilterBar
          value={documentType}
          onChange={setDocumentType}
          testID="tiles-document-filter"
          options={[
            { value: "all", label: "All documents" },
            { value: "tiles_selection", label: "Selection", icon: "grid" },
            { value: "tiles_quotation", label: "Quotation", icon: "file-text" },
          ]}
        />
      </View>
      </MobileFilterSection>

        </View>}
        ListEmptyComponent={selectedLoading && !docs?.length ? (
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.brand} />
          <Text style={type.bodyMuted}>{searching ? "Searching tile documents…" : "Loading quotation tiles…"}</Text>
        </View>
      ) : !loadError && docs?.length === 0 ? (
        <EmptyState icon="layers" title={search ? "No matching documents" : `No ${completed ? "completed " : ""}${label} yet`} subtitle={search ? "Try a different customer or document number." : completed ? "Ordered documents and earlier approved documents appear here." : `Create a new ${label.slice(0, -1)} to get started.`} />
      ) : null}
        renderItem={({ item }) => (
            <View style={styles.row}>
            <Pressable
              style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}
              onPress={() => openDoc(item)}
              testID={`tiles-doc-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.doc_type === "tiles_selection" ? "selection" : "quotation"} ${displayNumber(item)} for ${item.customer_name || "unnamed customer"}`}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: colors.onSurface }} numberOfLines={1}>
                  {item.customer_name || "Unnamed customer"}
                </Text>
                <Text style={type.caption} numberOfLines={1}>{displayNumber(item)}{item.doc_date ? ` · ${item.doc_date}` : ""} · {tilesStageLabel(item.doc_type, item.status)}</Text>
                {item.purchase_completion_status === "completed" ? <Text style={[type.caption, { color: colors.success }]}>100% completed</Text> : null}
              </View>
              <Text style={[type.mono, { fontSize: 13, fontWeight: "600" }]}>{money(item.grand_total || 0)}</Text>
              <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
            </Pressable>
            {canDelete ? <IconButton icon="trash-2" tone="danger" size={44}
              onPress={() => { setDeleteError(null); setDeleteTarget(item); }}
              accessibilityLabel={`Delete ${item.doc_type === "tiles_selection" ? "selection" : "quotation"} ${displayNumber(item)}`}
              testID={`tiles-delete-${item.id}`} /> : null}
            </View>
          )}
        ListFooterComponent={<View style={{ gap: spacing.sm }}>
          {!searching && documentScopeRef.current === scope ? visibleTypes.map(docType => pageErrors[docType]
            ? <ErrorState key={docType} title={pageErrors[docType]} onRetry={() => void loadMore(docType)} />
            : pages[docType]?.hasMore ? <Button key={docType} variant="ghost" label={`Load more ${docType === "tiles_selection" ? "selections" : "quotations"}`} loading={!!loadingMore[docType]} onPress={() => void loadMore(docType)} testID={`tiles-load-more-${docType}`} /> : null) : null}
        </View>}
      />
      <ConfirmDialog visible={!!deleteTarget} onClose={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => { void deleteDocument(); }}
        title={`Delete this ${deleteTarget?.doc_type === "tiles_selection" ? "selection" : "quotation"}?`}
        description={deleteError || (deleteTarget ? `${displayNumber(deleteTarget)} will be removed. Linked orders and completed payments are protected.` : undefined)}
        confirmLabel="Delete" tone="danger" loading={deleting} testID="confirm-delete-tiles-list" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  headerCompact: { alignItems: "stretch" },
  headerActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", flexShrink: 1 },
  headerActionsCompact: { flexDirection: "row", alignItems: "stretch", width: "100%" },
  compactAction: { alignSelf: "stretch", flexBasis: "45%", flexGrow: 1 },
  filterBar: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.lg },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
});
