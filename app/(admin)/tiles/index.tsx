// Quotation Tiles — single tab listing every Ground Floor tiles Selection
// and Quotation, any stage, with two entry points to start a new one. See
// docs/superpowers/specs/2026-07-27-quotation-tiles-workflow-design.md.
import { Feather } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button, EmptyState, ErrorState, PageHeader, SearchField, SegmentedControl } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";
import { useBp } from "@/src/design/responsive";
import { colors, money, radius, spacing, type } from "@/src/theme/tokens";
import { tilesStageLabel } from "@/src/components/tiles/tilesStage";

type TilesDoc = {
  id: string; number: string; doc_type: "tiles_selection" | "tiles_quotation";
  status: string; customer_name: string; grand_total: number; updated_at: string;
};

export default function QuotationTilesList() {
  useRequireFloorAccess("ground-floor");
  const router = useRouter();
  const { view } = useLocalSearchParams<{ view?: string }>();
  const completed = view === "completed";
  const [documents, setDocuments] = useState<Record<TilesDoc["doc_type"], TilesDoc[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const [search, setSearch] = useState("");
  const [documentType, setDocumentType] = useState<TilesDoc["doc_type"]>("tiles_quotation");
  const { isPhone, isTablet } = useBp();
  // The tablet shell reserves a 64px navigation rail. At a 768px viewport the
  // page itself is only about 704px wide, which is not enough for this title
  // and both labelled actions on one line. Stack the actions before they can
  // squeeze the title out of the header.
  const compact = isPhone || isTablet;

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [selections, quotations] = await Promise.all([
        api.get<TilesDoc[]>(`/quotations?doc_type=tiles_selection&view=${completed ? "completed" : "pending"}`, { floorId: "ground-floor" }),
        api.get<TilesDoc[]>(`/quotations?doc_type=tiles_quotation&view=${completed ? "completed" : "pending"}`, { floorId: "ground-floor" }),
      ]);
      if (requestId !== requestIdRef.current) return;
      const newestFirst = (docs: TilesDoc[]) => [...docs].sort(
        (a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""),
      );
      setDocuments({ tiles_selection: newestFirst(selections), tiles_quotation: newestFirst(quotations) });
    } catch (error: any) {
      if (requestId !== requestIdRef.current) return;
      setLoadError(error?.detail || "Couldn't load Ground Floor quotations.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [completed]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { requestIdRef.current += 1; };
  }, [load]));

  const openDoc = (doc: TilesDoc) => {
    const route = doc.doc_type === "tiles_selection" ? "selection" : "quotation";
    router.push(`/(admin)/tiles/${route}?id=${doc.id}` as any);
  };
  const docs = documents?.[documentType]?.filter(doc => !search.trim() || `${doc.customer_name} ${doc.number}`.toLowerCase().includes(search.trim().toLowerCase())) ?? null;
  const label = documentType === "tiles_selection" ? "selections" : "quotations";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <PageHeader title={completed ? "Completed tile documents" : "Tile quotations"} overline="Ground Floor · Tiles" actions={
        <View style={[styles.headerActions, compact && styles.headerActionsCompact]}>
          <Button
            label={completed ? "View pending" : "View completed"}
            variant="secondary"
            icon={completed ? "clock" : "check-circle"}
            onPress={() => router.push(`/(admin)/tiles?view=${completed ? "pending" : "completed"}` as any)}
            testID="tiles-lifecycle-toggle"
            fullWidth={compact}
            style={compact ? styles.compactAction : undefined}
          />
          {!completed ? <Button
            label="Create new selection"
            variant="ghost"
            icon="grid"
            onPress={() => router.push("/(admin)/tiles/selection" as any)}
            testID="tiles-create-selection"
            fullWidth={compact}
            style={compact ? styles.compactAction : undefined}
          /> : null}
          {!completed ? <Button
            label="Create new quotation"
            icon="layout"
            onPress={() => router.push("/(admin)/tiles/quotation" as any)}
            testID="tiles-create-quotation"
            fullWidth={compact}
            style={compact ? styles.compactAction : undefined}
          /> : null}
        </View>
      } />

      <View style={styles.filterBar}>
        <SegmentedControl
          value={documentType}
          onChange={setDocumentType}
          fullWidth
          testID="tiles-document-filter"
          options={[
            { value: "tiles_quotation", label: "Quotation", icon: "file-text" },
            { value: "tiles_selection", label: "Selection", icon: "grid" },
          ]}
        />
      </View>

      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}><SearchField value={search} onChangeText={setSearch} onClear={() => setSearch("")} placeholder="Search customer or document number" /></View>
      {loadError ? (
        <ErrorState title="Couldn't load quotation tiles" subtitle={loadError} onRetry={() => void load()} />
      ) : loading && docs === null ? (
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.brand} />
          <Text style={type.bodyMuted}>Loading quotation tiles…</Text>
        </View>
      ) : docs?.length === 0 ? (
        <EmptyState icon="layers" title={search ? "No matching documents" : `No ${completed ? "completed " : ""}${label} yet`} subtitle={search ? "Try a different customer or document number." : completed ? "Approved and order-placed selections or quotations will appear here." : `Create a new ${label.slice(0, -1)} to get started.`} />
      ) : (
        <FlatList
          data={docs}
          keyExtractor={(d) => d.id}
          contentContainerStyle={{ padding: spacing.lg, gap: 8 }}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => openDoc(item)}
              testID={`tiles-doc-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.doc_type === "tiles_selection" ? "selection" : "quotation"} ${item.number} for ${item.customer_name || "unnamed customer"}`}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: colors.onSurface }} numberOfLines={1}>
                  {item.customer_name || "Unnamed customer"}
                </Text>
                <Text style={type.caption} numberOfLines={1}>{item.number} · {tilesStageLabel(item.doc_type, item.status)}</Text>
              </View>
              <Text style={[type.mono, { fontSize: 13, fontWeight: "600" }]}>{money(item.grand_total || 0)}</Text>
              <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
            </Pressable>
          )}
        />
      )}
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
  headerActionsCompact: { flexDirection: "column", alignItems: "stretch", width: "100%" },
  compactAction: { alignSelf: "stretch" },
  filterBar: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.lg },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10,
    padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
});
