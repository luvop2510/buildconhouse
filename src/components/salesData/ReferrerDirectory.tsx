import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, View } from "react-native";

import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Button, Card, ErrorState, IconButton, LoadingState, PillTabs, TextField } from "@/src/components/ui";
import { NavigationLink } from "@/src/design/NavigationLink";
import { useBp } from "@/src/design/responsive";
import { money } from "./SalesReportParts";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type } from "@/src/theme/tokens";
import { referrerCode } from "@/src/utils/referrer";
import { ReferencesEditor } from "./ReferencesEditor";
import { mergeReferences, referenceDestination, type ReferenceContact, type ReferenceKind, type ReferencePerformance, type ReferenceRow } from "./ReferencesModel";
import type { SelectedPeriod } from "./useSalesPeriod";

export function ReferrerDirectory({ kind, floorId: reportFloor, period, performance, onSaved }: {
  kind?: ReferenceKind; floorId?: string; period?: SelectedPeriod | null;
  performance?: ReferencePerformance[]; onSaved?: () => void;
}) {
  const { staff } = useAuth();
  const { selectedFloorId, floors } = useFloorAccess();
  const { isPhone, isTabletPortrait } = useBp();
  const compact = isPhone || isTabletPortrait;
  const floorId = reportFloor || selectedFloorId;
  const floorKey = floorId === "all" ? floors.map(floor => floor.id).sort().join(",") : floorId;
  const scopeKey = JSON.stringify([staff?.id, floorKey]);
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const mounted = useRef(true);
  const [directory, setDirectory] = useState<{ scope: string; contacts: ReferenceContact[]; total: number; nextOffset: number }>({ scope: "", contacts: [], total: 0, nextOffset: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ scope: string; detail: string; offset: number } | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ReferenceKind | "all">(kind || "all");
  const [historicalCount, setHistoricalCount] = useState(25);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<ReferenceContact | null | undefined>(undefined);
  const [editorScope, setEditorScope] = useState("");
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<{ key: string; offset: number; version: number } | null>(null);
  const needle = search.trim().toLocaleLowerCase();
  const queryKey = JSON.stringify([scopeKey, filter, needle]);
  const queryRef = useRef(queryKey); queryRef.current = queryKey;
  const load = useCallback((offset = 0) => {
    if (!floorKey || !mounted.current || queryRef.current !== queryKey
      || (pending.current?.key === queryKey && pending.current.offset === offset)) return;
    const version = ++generation.current;
    pending.current = { key: queryKey, offset, version };
    controller.current?.abort();
    const nextController = new AbortController(); controller.current = nextController;
    setLoading(true); setError(null);
    const query = new URLSearchParams({ floor_id: floorKey, offset: String(offset), limit: "25", search: needle });
    if (filter !== "all") query.set("type", filter);
    void api.get<{ rows: ReferenceContact[]; total: number; offset: number; limit: number }>(`/referrers/page?${query}`, {
      floorId: floorId === "all" ? selectedFloorId || floorKey.split(",")[0] : floorId,
      signal: nextController.signal,
    }).then(result => {
      if (!mounted.current || version !== generation.current || queryRef.current !== queryKey) return;
      setDirectory(current => ({ scope: queryKey, total: result.total, nextOffset: result.offset + result.rows.length,
        contacts: [...new Map([...(offset && current.scope === queryKey ? current.contacts : []), ...result.rows].map(row => [row.id, row])).values()],
      }));
    }).catch((cause: unknown) => {
      if (!mounted.current || version !== generation.current || queryRef.current !== queryKey || nextController.signal.aborted) return;
      const detail = (cause as { detail?: unknown })?.detail;
      setError({ scope: queryKey, detail: typeof detail === "string" ? detail : "Could not load references. Retry to load the directory.", offset });
    }).finally(() => {
      if (pending.current?.version === version) pending.current = null;
      if (mounted.current && version === generation.current && queryRef.current === queryKey) setLoading(false);
    });
  }, [floorKey, floorId, selectedFloorId, filter, needle, queryKey]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; controller.current?.abort(); pending.current = null; };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => load(), needle ? 200 : 0);
    return () => { clearTimeout(timer); generation.current += 1; controller.current?.abort(); pending.current = null; };
  }, [load, needle, revision]);
  useEffect(() => { setEditing(undefined); }, [scopeKey]);
  useEffect(() => { setFilter(kind || "all"); }, [kind]);
  useEffect(() => { setHistoricalCount(25); }, [filter, search, scopeKey]);

  const current = directory.scope === queryKey;
  const currentError = error?.scope === queryKey ? error : null;
  const rows = useMemo(() => mergeReferences(current ? directory.contacts : [], performance || []), [directory, current, performance]);
  const active = rows.filter(row => !row.historical);
  const historical = rows.filter(({ contact, historical }) => historical && (filter === "all" || contact.type === filter)
    && [contact.name, contact.company, contact.phone, referrerCode(contact.id, contact.type)].some(value => value?.toLocaleLowerCase().includes(needle)));
  const startEditing = (contact: ReferenceContact | null) => { setEditorScope(scopeKey); setEditing(contact); };
  const editorFloor = floorId !== "all" ? floorId : selectedFloorId || floorKey.split(",")[0];
  const saved = () => {
    if (!mounted.current || editorScope !== scopeRef.current) return;
    setEditing(undefined);
    setRevision(value => value + 1);
    onSavedRef.current?.();
  };
  return <Card variant="flat" padding={spacing.s16}><View style={{ gap: spacing.s16 }} testID="sales-reference-directory">
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: spacing.s8 }}>
      <Text accessibilityRole="header" aria-level={2} style={type.titleSm}>Reference directory</Text>
      {staff?.role === "owner" ? <Button label="Add reference" icon="plus" disabled={!editorFloor} onPress={() => startEditing(null)} /> : null}
    </View>
    <PillTabs value={filter} onChange={setFilter} testID="references-type" options={[
      { value: "all", label: "All" }, { value: "interior_designer", label: "Interior designers" }, { value: "architect", label: "Architects" },
    ]} />
    <TextField placeholderTextColor={colors.onSurfaceMuted} label="Search references" placeholder="Name, studio, phone or reference code" maxLength={200} value={search} onChangeText={setSearch} testID="references-search" />
    {!current ? currentError ? <ErrorState subtitle={currentError.detail} onRetry={() => load(currentError.offset)} /> : <LoadingState label="Loading references…" /> : <>
      {currentError ? <ErrorState subtitle={currentError.detail} onRetry={() => load(currentError.offset)} /> : null}
      <Text style={[type.bodySm, { color: colors.onSurfaceMuted }]}>{directory.total.toLocaleString("en-IN")} active {directory.total === 1 ? "reference" : "references"}{search || filter !== "all" ? " matching your filters" : ""}</Text>
      {!active.length && !historical.length ? <Text style={type.body}>{search ? "No matching references. Try a name, studio or reference code." : "No references yet. Add an architect or interior designer to start tracking referrals."}</Text> : null}
      {!compact && active.length ? <View style={{ flexDirection: "row", gap: spacing.s16, alignItems: "center" }}>
        <Text style={[type.bodySm, { flex: 3, minWidth: 0, color: colors.onSurfaceMuted }]}>Reference</Text>
        {performance ? <><Text style={[type.bodySm, { flex: 1, textAlign: "right", color: colors.onSurfaceMuted }]}>Clients brought</Text><Text style={[type.bodySm, { flex: 1, textAlign: "right", color: colors.onSurfaceMuted }]}>Sales</Text></> : null}
        {staff?.role === "owner" ? <View style={{ width: 44 }} /> : null}
      </View> : null}
      <View>{active.map(row => <DirectoryRow key={row.contact.id} row={row} compact={compact} showPerformance={performance !== undefined} canEdit={staff?.role === "owner"} floorId={floorId} period={period} onEdit={() => startEditing(row.contact)} />)}</View>
      {directory.nextOffset < directory.total ? <Button label={loading ? "Loading references…" : `Show more (${directory.nextOffset} of ${directory.total})`} disabled={loading} variant="secondary" onPress={() => load(directory.nextOffset)} /> : null}
    </>}
    {historical.length ? <View testID="sales-historical-references" style={{ gap: spacing.s8 }}>
      <Text accessibilityRole="header" aria-level={3} style={type.titleSm}>Historical references</Text>
      <Text style={[type.bodySm, { color: colors.onSurfaceMuted }]}>{historical.length.toLocaleString("en-IN")} {historical.length === 1 ? "historical reference" : "historical references"}{search || filter !== "all" ? " matching your filters" : ""} in {period?.label || "the selected period"}</Text>
      {historical.slice(0, historicalCount).map(row => <DirectoryRow key={row.contact.id} row={row} compact={compact} showPerformance canEdit={false} floorId={floorId} period={period} onEdit={() => {}} />)}
      {historical.length > historicalCount ? <Button label={`Show more historical references (${historicalCount} of ${historical.length})`} variant="secondary" onPress={() => setHistoricalCount(count => count + 25)} /> : null}
    </View> : null}
    {performance ? <Text style={[type.bodySm, { color: colors.onSurfaceMuted }]}>Clients brought includes people referred before an order. Figures cover {period?.label || "the selected period"}. Furniture sales stay in RNB; — means a figure is unavailable.</Text> : null}
    {editing !== undefined && editorScope === scopeKey && editorFloor ? <ReferencesEditor key={`${floorKey}:${editing?.id || "new"}`} item={editing} initialKind={filter === "all" ? "interior_designer" : filter} floorId={editorFloor} onSaved={saved} onClose={() => setEditing(undefined)} /> : null}
  </View></Card>;
}

function DirectoryRow({ row: { contact, performance, historical }, compact, showPerformance, canEdit, floorId, period, onEdit }: {
  row: ReferenceRow; compact: boolean; showPerformance: boolean; canEdit: boolean; floorId: string;
  period?: SelectedPeriod | null; onEdit: () => void;
}) {
  const count = performance?.customers_acquired;
  const clients = count == null ? "—" : count.toLocaleString("en-IN");
  const revenue = performance ? money(performance.revenue) : "—";
  const showInr = floorId !== "third-floor" || (performance?.revenue || 0) !== 0;
  const furnitureRevenue = performance?.revenue_rnb;
  const showFurniture = floorId === "third-floor" || (furnitureRevenue !== undefined && furnitureRevenue !== 0);
  const furnitureSales = furnitureRevenue === undefined ? "RNB —" : `RNB ${furnitureRevenue.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const scope = historical ? "Historical reference" : contact.shared_across_floors ? "All floors" : "This floor";
  const identity = <View style={{ flex: 3, minWidth: 0, gap: spacing.s4 }}>
    <Text style={type.bodyStrong}>{[contact.name, contact.company].filter(Boolean).join(" · ")}</Text>
    <Text style={[type.bodySm, { color: colors.onSurfaceMuted }, Platform.OS === "web" ? { overflowWrap: "anywhere" } as never : null]}>{[contact.type === "architect" ? "Architect" : "Interior designer", referrerCode(contact.id, contact.type)].join(" · ")}</Text>
    <Text style={[type.bodySm, { color: colors.onSurfaceMuted }]}>{[scope, contact.phone].filter(Boolean).join(" · ")}</Text>
  </View>;
  return <View testID={`reference-row-${contact.id}`} style={{ paddingVertical: spacing.s12, borderTopWidth: 1, borderTopColor: colors.border, gap: spacing.s8 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.s16 }}>
      <NavigationLink href={referenceDestination(contact.id, floorId, period) as never} accessibilityLabel={`View clients referred by ${contact.name}`} style={({ pressed, hovered }) => ({ flex: 1, minWidth: 0, minHeight: 44, flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: spacing.s16, opacity: pressed ? 0.8 : 1, backgroundColor: hovered ? colors.surfaceTertiary : "transparent" })}>
        {identity}
        {showPerformance ? compact ? <View style={{ gap: spacing.s4 }}><Text style={[type.body, { fontVariant: ["tabular-nums"] }]}>{clients} clients brought{showInr ? ` · ${revenue} sales` : ""}</Text>{showFurniture ? <Text style={[type.body, { fontVariant: ["tabular-nums"] }]}>{furnitureSales} Furniture sales</Text> : null}</View> : <>
          <Text style={[type.body, { flex: 1, textAlign: "right", fontVariant: ["tabular-nums"] }]}>{clients}</Text>
          <View style={{ flex: 1, gap: spacing.s4 }}>{showInr ? <Text style={[type.bodyStrong, { textAlign: "right", fontVariant: ["tabular-nums"] }]}>{revenue}</Text> : null}{showFurniture ? <Text style={[type.bodyStrong, { textAlign: "right", fontVariant: ["tabular-nums"] }]}>{furnitureSales}</Text> : null}</View>
        </> : null}
      </NavigationLink>
      {canEdit ? <IconButton icon="edit-2" accessibilityLabel={`Edit ${contact.name}`} tone="ghost" onPress={onEdit} testID={`reference-edit-${contact.id}`} /> : null}
    </View>
  </View>;
}
