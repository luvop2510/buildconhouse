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
  // Directory reads require a concrete floor. Union authorized directories,
  // deduplicating shared IDs without exposing another floor's private contacts.
  const floorKey = floorId === "all" ? floors.map(floor => floor.id).sort().join(",") : floorId;
  const [directory, setDirectory] = useState<{ scope: string; contacts: ReferenceContact[] }>({ scope: "", contacts: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ReferenceKind | "all">(kind || "all");
  const [visibleCount, setVisibleCount] = useState(25);
  const [editing, setEditing] = useState<ReferenceContact | null | undefined>(undefined);
  const [editorScope, setEditorScope] = useState("");
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    if (!floorKey) return;
    const version = ++generation.current;
    controller.current?.abort();
    const nextController = new AbortController(); controller.current = nextController;
    setLoading(true); setError(null);
    void Promise.all(floorKey.split(",").map(id => api.get<ReferenceContact[]>("/referrers", { floorId: id, signal: nextController.signal }))).then(results => {
      if (version === generation.current) setDirectory({ scope: floorKey, contacts: [...new Map(results.flat().map(row => [row.id, row])).values()] });
    }).catch((cause: unknown) => {
      if (version !== generation.current || nextController.signal.aborted) return;
      const detail = (cause as { detail?: unknown })?.detail;
      setError(typeof detail === "string" ? detail : "Could not load references. Retry to load the directory.");
    }).finally(() => { if (version === generation.current) setLoading(false); });
  }, [floorKey]);
  useEffect(() => {
    setEditing(undefined); load();
    return () => { generation.current += 1; controller.current?.abort(); };
  }, [load]);
  useEffect(() => { setFilter(kind || "all"); }, [kind]);
  useEffect(() => { setVisibleCount(25); }, [filter, search, floorKey]);

  const rows = useMemo(() => mergeReferences(directory.scope === floorKey ? directory.contacts : [], performance || []), [directory, floorKey, performance]);
  const needle = search.trim().toLocaleLowerCase();
  const visible = rows.filter(({ contact }) => (filter === "all" || contact.type === filter) && [contact.name, contact.company, contact.phone, referrerCode(contact.id, contact.type)].some(value => value?.toLocaleLowerCase().includes(needle)));
  const startEditing = (contact: ReferenceContact | null) => { setEditorScope(floorKey); setEditing(contact); };
  const editorFloor = floorId !== "all" ? floorId : selectedFloorId || floorKey.split(",")[0];
  const saved = (contact: ReferenceContact) => {
    if (editorScope !== floorKey) return;
    setDirectory(current => ({ scope: floorKey, contacts: [...(current.scope === floorKey ? current.contacts.filter(row => row.id !== contact.id) : []), contact] }));
    // Creation can resolve an existing private identity; its sharing change
    // still needs an explicit owner save with that record's current version.
    setEditing(undefined);
    onSaved?.();
  };
  return <Card variant="flat" padding={spacing.s16}><View style={{ gap: spacing.s16 }} testID="sales-reference-directory">
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: spacing.s8 }}>
      <Text accessibilityRole="header" aria-level={2} style={type.titleSm}>Reference directory</Text>
      {staff?.role === "owner" ? <Button label="Add reference" icon="plus" disabled={!editorFloor} onPress={() => startEditing(null)} /> : null}
    </View>
    <PillTabs value={filter} onChange={setFilter} testID="references-type" options={[
      { value: "all", label: "All" }, { value: "interior_designer", label: "Interior designers" }, { value: "architect", label: "Architects" },
    ]} />
    <TextField placeholderTextColor={colors.onSurfaceMuted} label="Search references" placeholder="Name, studio, phone or reference code" value={search} onChangeText={setSearch} testID="references-search" />
    {loading || directory.scope !== floorKey ? error ? <ErrorState subtitle={error} onRetry={load} /> : <LoadingState label="Loading references…" /> : <>
      {error ? <ErrorState subtitle={error} onRetry={load} /> : null}
      <Text style={[type.bodySm, { color: colors.onSurfaceMuted }]}>{visible.length.toLocaleString("en-IN")} {visible.length === 1 ? "reference" : "references"}{search || filter !== "all" ? " matching your filters" : ""}</Text>
      {!visible.length ? <Text style={type.body}>{search ? "No matching references. Try a name, studio or reference code." : "No references yet. Add an architect or interior designer to start tracking referrals."}</Text> : null}
      {!compact && visible.length ? <View style={{ flexDirection: "row", gap: spacing.s16, alignItems: "center" }}>
        <Text style={[type.bodySm, { flex: 3, minWidth: 0, color: colors.onSurfaceMuted }]}>Reference</Text>
        {performance ? <><Text style={[type.bodySm, { flex: 1, textAlign: "right", color: colors.onSurfaceMuted }]}>Clients brought</Text><Text style={[type.bodySm, { flex: 1, textAlign: "right", color: colors.onSurfaceMuted }]}>Sales</Text></> : null}
        {staff?.role === "owner" ? <View style={{ width: 44 }} /> : null}
      </View> : null}
      <View>{visible.slice(0, visibleCount).map(row => <DirectoryRow key={row.contact.id} row={row} compact={compact} showPerformance={performance !== undefined} canEdit={staff?.role === "owner" && !row.historical} floorId={floorId} period={period} onEdit={() => startEditing(row.contact)} />)}</View>
      {visible.length > visibleCount ? <Button label={`Show more (${visibleCount} of ${visible.length})`} variant="secondary" onPress={() => setVisibleCount(count => count + 25)} /> : null}
      {performance ? <Text style={[type.bodySm, { color: colors.onSurfaceMuted }]}>Clients brought includes people referred before an order. Figures cover {period?.label || "the selected period"}. Furniture sales stay in RNB; — means a figure is unavailable.</Text> : null}
    </>}
    {editing !== undefined && editorScope === floorKey && editorFloor ? <ReferencesEditor key={`${floorKey}:${editing?.id || "new"}`} item={editing} initialKind={filter === "all" ? "interior_designer" : filter} floorId={editorFloor} onSaved={saved} onClose={() => setEditing(undefined)} /> : null}
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
