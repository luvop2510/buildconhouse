import Feather from "@expo/vector-icons/Feather";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { api, subscribeApiCacheInvalidation } from "@/src/api/client";
import { useAuth } from "@/src/state/auth";
import { setSelectedFloorId, useFloorAccess } from "@/src/hooks/use-floor-access";
import { Button, EmptyState, ErrorState, LoadingState, SearchField, Sheet } from "@/src/components/ds";
import { Surface, Txt } from "@/src/design/components";
import { KITCHEN_WORKSPACE_PAGES } from "@/src/kitchen-workspace-pages";
import { color, radius, space } from "@/src/design/tokens";

interface Match { kind: string; id: string; floor_id: string; customer_id?: string; name: string; phone?: string; reference: string; stage?: string; status?: string; doc_type?: string }
interface Result { rows: Match[]; total: number; page: number; limit: number }
interface RecordView { kind: string; summary: Match; data: Record<string, unknown> }
interface Profile { customer: Match; records: RecordView[] }
const label = (key: string) => key.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
const stageLabel = (stage: string) => KITCHEN_WORKSPACE_PAGES.find(page => page.stage === stage)?.label || label(stage);
const OMIT = new Set(["permissions", "blocked_transitions", "duplicate_candidates", "can_update", "can_assign", "can_configure", "access_scoped"]);

function SavedValues({ value, name }: { value: unknown; name?: string }) {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return <View style={{ gap: space.x2 }}>{name ? <Txt v="bodyMid">{label(name)}</Txt> : null}{value.map((item, index) => <View key={index} style={{ paddingLeft: space.x2, borderLeftWidth: 1, borderLeftColor: color.line, gap: space.x1 }}><Txt v="caption" tone="soft">{label(name || "Record")} {index + 1}</Txt><SavedValues value={item} /></View>)}</View>;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([key, item]) => !OMIT.has(key) && item != null && item !== "" && !(Array.isArray(item) && !item.length));
    if (!entries.length) return null;
    return <View style={{ gap: space.x2 }}>{name ? <Txt v="bodyMid">{label(name)}</Txt> : null}{entries.map(([key, item]) => <SavedValues key={key} name={key} value={item} />)}</View>;
  }
  return <Txt v="sub" selectable>{name ? `${label(name)}: ` : ""}{typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</Txt>;
}

function SourceRecord({ record, open }: { record: RecordView; open: () => void }) {
  const [expanded, setExpanded] = useState(record.kind === "kitchen" || record.kind === "customer");
  return <Surface style={{ gap: space.x3 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${label(record.kind)} ${record.summary.reference}`} onPress={() => setExpanded(value => !value)} style={{ minHeight: 44, justifyContent: "center", gap: space.x1 }}>
      <View style={{ flexDirection: "row", gap: space.x2, alignItems: "center" }}><Feather name={expanded ? "chevron-down" : "chevron-right"} size={18} color={color.inkSoft} accessible={false} /><Txt v="bodyMid">{label(record.kind)} · {record.summary.reference}</Txt></View>
      <Txt v="sub" tone="soft">{[record.summary.stage && stageLabel(record.summary.stage), record.summary.status].filter(Boolean).join(" · ")}</Txt>
    </Pressable>
    {expanded ? <><SavedValues value={record.data} /><Button label="Open saved record" variant="secondary" onPress={open} /></> : null}
  </Surface>;
}

function CustomerTimeline({ records }: { records: RecordView[] }) {
  const events = records.flatMap(record => {
    const activity = [record.data.activity, record.data.history].flatMap(value => Array.isArray(value) ? value : []);
    const interactions = Array.isArray(record.data.follow_ups) ? record.data.follow_ups : [];
    return [
      ...activity.map((row: any, index: number) => ({ key: `${record.kind}:${record.summary.id}:event:${index}`, date: row.at || row.created_at || row.date || "", title: label(row.type || row.event_type || "Saved activity"), stage: row.payload?.to_stage || row.stage, notes: row.summary || row.notes })),
      ...interactions.map((row: any) => ({ key: `${record.summary.id}:followup:${row.id}`, date: row.date || "", title: `Follow-Up ${row.number} · ${row.interaction_type}`, stage: row.stage, notes: row.notes })),
    ];
  }).sort((first, second) => first.date.localeCompare(second.date) || first.key.localeCompare(second.key));
  if (!events.length) return null;
  return <Surface style={{ gap: space.x3 }}><Txt v="heading">Customer timeline</Txt>{events.map(event => <View key={event.key} style={{ borderLeftWidth: 1, borderLeftColor: color.line, paddingLeft: space.x3, gap: space.x1 }}>
    <Txt v="bodyMid">{event.title}</Txt><Txt v="caption" tone="soft">{[event.date, event.stage && stageLabel(event.stage)].filter(Boolean).join(" · ")}</Txt>{event.notes ? <Txt v="sub">{event.notes}</Txt> : null}
  </View>)}</Surface>;
}

/** The Home lookup searches every permitted floor, independent of Today filters. */
export function HomeCustomerSearch() {
  const { staff } = useAuth();
  const { floors, selectedFloorId } = useFloorAccess();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Match | null>(null);
  const [response, setResponse] = useState<{ key: string; value: Result } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [profile, setProfile] = useState<{ key: string; value: Profile } | null>(null);
  const [profileError, setProfileError] = useState<{ key: string; message: string } | null>(null);
  const term = search.trim();
  const accessKey = JSON.stringify([staff?.id, staff?.role, staff?.custom_access, staff?.access_profile, staff?.access_grants, selectedFloorId, revision]);
  const queryKey = JSON.stringify([accessKey, term, page]);
  const selectedKey = JSON.stringify([accessKey, selected]);
  const result = response?.key === queryKey ? response.value : null;
  const detail = profile?.key === selectedKey ? profile.value : null;
  const error = failure?.key === queryKey ? failure.message : null;
  const detailError = profileError?.key === selectedKey ? profileError.message : null;
  const floorNames = useMemo(() => Object.fromEntries((floors || []).map(floor => [floor.id, floor.name])), [floors]);
  useEffect(() => subscribeApiCacheInvalidation(() => { setRevision(value => value + 1); }), []);
  useEffect(() => {
    const controller = new AbortController();
    if (!term || !staff?.id) return () => controller.abort();
    const timer = setTimeout(() => {
      void api.get<Result>(`/customer-search?search=${encodeURIComponent(term)}&page=${page}&limit=20`, { cacheMs: 0, signal: controller.signal })
        .then(value => { if (!controller.signal.aborted) setResponse({ key: queryKey, value }); })
        .catch(cause => { if (!controller.signal.aborted) setFailure({ key: queryKey, message: cause?.detail || cause?.message || "Please try again." }); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [queryKey, term, page, staff?.id]);
  useEffect(() => {
    const controller = new AbortController();
    if (!selected) return () => controller.abort();
    void api.get<Profile>(`/customer-search/profile?kind=${selected.kind}&id=${encodeURIComponent(selected.id)}&floor_id=${encodeURIComponent(selected.floor_id)}`, { cacheMs: 0, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setProfile({ key: selectedKey, value }); })
      .catch(cause => { if (!controller.signal.aborted) setProfileError({ key: selectedKey, message: cause?.detail || cause?.message || "Please try again." }); });
    return () => controller.abort();
  }, [selectedKey, selected]);
  const open = async (match: Match) => {
    const id = encodeURIComponent(match.id);
    const href = match.kind === "kitchen" ? `/kitchen/${id}/stages/${match.stage}?details=1`
      : match.kind === "customer" ? `/customers/${id}` : match.kind === "walkin" ? `/walkins/${id}`
        : match.kind === "quotation" ? match.floor_id === "ground-floor" ? `/tiles/${match.doc_type === "tiles_selection" ? "selection" : "quotation"}?id=${id}` : `/quotations/${id}`
          : match.kind === "order" ? `/tiles/orders/${id}` : match.kind === "furniture" ? "/notebook/furniture-quotations" : "/followups";
    try {
      await setSelectedFloorId(match.floor_id);
      setSelected(null);
      router.push(`/(admin)${href}` as never);
    } catch (cause: any) {
      setProfileError({ key: selectedKey, message: cause?.message || "Could not open this floor. Please retry." });
    }
  };
  return <View testID="home-customer-search"><Surface style={{ gap: space.x3 }}>
    <Txt v="heading">Find a customer</Txt>
    <SearchField accessibilityLabel="Search customers across all permitted floors" testID="home-customer-search-input" placeholder="Customer name or phone number" maxLength={200} value={search} onChangeText={value => { setSearch(value); setPage(1); }} onClear={() => { setSearch(""); setPage(1); }} />
    <Txt v="caption" tone="soft">Search all your permitted floors and stages. Select a record to see its saved customer history.</Txt>
    {!term ? null : error ? <ErrorState title="Customer search unavailable" subtitle={error} onRetry={() => setRevision(value => value + 1)} /> : !result ? <LoadingState label="Searching customers…" /> : <>
      <View accessibilityLiveRegion="polite"><Txt v="caption" tone="soft">{result.total} matching records{result.total > 20 ? ` · Page ${page}` : ""}</Txt></View>
      {!result.rows.length ? <EmptyState title="No matching customers" subtitle="Try another name or part of a phone number." /> : result.rows.map(match => <Pressable key={`${match.kind}:${match.floor_id}:${match.id}`} accessibilityRole="button" accessibilityLabel={`View ${match.name}, ${floorNames[match.floor_id] || match.floor_id}, ${match.reference}`} testID={`home-customer-result-${match.kind}-${match.id}`} onPress={() => { setSelected(match); setProfile(null); setProfileError(null); }} style={({ pressed }) => ({ minHeight: 72, padding: space.x3, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: pressed ? color.hoverWash : color.surface, gap: space.x1 })}>
        <Txt v="bodyMid">{match.name}</Txt><Txt v="sub">{[match.phone, floorNames[match.floor_id] || match.floor_id].filter(Boolean).join(" · ")}</Txt>
        <Txt v="caption" tone="soft">{[label(match.kind), match.reference, match.stage && stageLabel(match.stage), match.status].filter(Boolean).join(" · ")}</Txt>
      </Pressable>)}
      {result.total > 20 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.x2 }}><Button label="Previous results" variant="secondary" disabled={page <= 1} onPress={() => setPage(value => value - 1)} /><Button label="Next results" variant="secondary" disabled={page * 20 >= result.total} onPress={() => setPage(value => value + 1)} /></View> : null}
    </>}
    <Sheet scroll visible={!!selected} title={selected?.name || "Customer history"} onClose={() => setSelected(null)} testID="home-customer-profile">
      {selected ? <View style={{ gap: space.x4 }}>{detailError ? <ErrorState title="Customer history unavailable" subtitle={detailError} onRetry={() => setRevision(value => value + 1)} /> : !detail ? <LoadingState label="Loading saved customer history…" /> : <>
        <Txt v="sub">{[detail.customer.phone, floorNames[detail.customer.floor_id] || detail.customer.floor_id, detail.customer.reference].filter(Boolean).join(" · ")}</Txt>
        <Txt v="caption" tone="soft">Saved details, documents and history for this customer’s linked records. Separate customer identities sharing a phone remain separate.</Txt>
        <CustomerTimeline records={detail.records} />
        {detail.records.map(record => <SourceRecord key={`${record.kind}:${record.summary.id}`} record={record} open={() => void open(record.summary)} />)}
      </>}</View> : null}
    </Sheet>
  </Surface></View>;
}
