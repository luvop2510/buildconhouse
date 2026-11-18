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
import { formatDepartmentPhone } from "@/src/utils/phone";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";

interface Match { kind: string; id: string; floor_id: string; customer_id?: string; name: string; phone?: string; reference?: string; address?: string; stage?: string; status?: string; doc_type?: string }
interface Result { rows: Match[]; total: number; page: number; limit: number }
interface RecordView { kind: string; summary: Match; data: Record<string, unknown> }
interface Profile { customer: Match; records: RecordView[]; workflows: { floor_id: string; records: RecordView[] }[] }
// The universal lookup historically shows Kitchen's raw contact value.
const displayPhone = (match: Match) => match.floor_id === KITCHEN_FLOOR_ID
  ? match.phone : formatDepartmentPhone(match.phone, match.floor_id);
const label = (key: string) => key.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
const stageLabel = (stage: string) => KITCHEN_WORKSPACE_PAGES.find(page => page.stage === stage)?.label || label(stage);
const cleanReference = (value?: string) => value && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value) ? value : "";
const floorLabel = (id: string, names: Record<string, string>) => names[id] || ({ "ground-floor": "Ground Floor", "first-floor": "Sanitary Floor", "second-floor": "Kitchen Floor", "third-floor": "Furniture Floor" }[id]) || "Department";
const fieldLabels: Record<string, string> = {
  response: "Status", received_status: "Quotation received", sent_status: "Sent to customer", received_date: "Received", shared_date: "Shared",
  kitchen_type: "Kitchen type", confirmed: "Confirmed", order_date: "Order date", final_amount: "Order amount", amount: "Amount",
  site_location: "Site", scheduled_date: "Scheduled", visit_date: "Visit", percentage: "Progress", start_date: "Started", completed_date: "Completed",
  notes: "Notes", doc_date: "Date", grand_total: "Total", overall_status: "Status", total_products: "Products", total_value: "Order value",
  next_followup_at: "Next contact", followup_date: "Next contact", notebook_status: "Status", total_payable_rmb: "Total (RNB)", balance_rmb: "Balance (RNB)",
};

function CurrentRecord({ record, open }: { record: RecordView; open: () => void }) {
  const stage = record.summary.stage || "lead";
  const products = Array.isArray(record.data.products) ? record.data.products as Record<string, unknown>[] : [];
  const fields = Object.entries(record.data).filter(([key, value]) => fieldLabels[key] && value !== null && value !== undefined && value !== "" && typeof value !== "object");
  return <View style={{ gap: space.x2 }} testID={`current-workflow-${record.summary.kind}-${record.summary.id}`}>
    <Txt v="bodyMid">{stageLabel(stage)}{cleanReference(record.summary.reference) ? ` · ${cleanReference(record.summary.reference)}` : ""}</Txt>
    {record.summary.status ? <Txt v="sub" tone="soft">{label(record.summary.status)}</Txt> : null}
    {fields.filter(([key]) => !["overall_status", "response", "notebook_status"].includes(key) || !record.summary.status).map(([key, value]) => <Txt key={key} v="sub">{fieldLabels[key]}: {typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</Txt>)}
    {record.kind === "kitchen" && record.data.number ? <Txt v="sub">{stageLabel(stage)} {String(record.data.number)}</Txt> : null}
    {products.slice(0, 3).map((product, index) => <View key={index} style={{ gap: space.x1 }}>
      <Txt v="sub">{String(product.name || "Product")}{product.size || product.finish ? ` · ${[product.size, product.finish].filter(Boolean).join(" · ")}` : ""}</Txt>
      <Txt v="caption" tone="soft">Quantity: {String(product.qty ?? "—")}{product.quantity_unit ? ` ${String(product.quantity_unit).toLowerCase()}` : ""}</Txt>
    </View>)}
    {products.length > 3 ? <Txt v="caption" tone="soft">{products.length - 3} more products in this {stageLabel(stage).toLowerCase()}</Txt> : null}
    <Button label={`Open ${stageLabel(stage).toLowerCase()}`} onPress={open} />
  </View>;
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
    const href = match.kind === "kitchen" ? `/kitchen/${id}/stages/${match.stage}`
      : match.kind === "customer" ? `/customers/${id}` : match.kind === "walkin" ? `/walkins/${id}`
        : match.kind === "quotation" ? match.floor_id === "ground-floor" ? `/tiles/${match.doc_type === "tiles_selection" ? "selection" : "quotation"}?id=${id}` : `/quotations/${id}`
          : match.kind === "order" ? `/tiles/orders/${id}` : match.kind === "furniture" ? `/notebook/furniture-quotations?id=${id}` : `/followups?id=${id}`;
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
    <Txt v="caption" tone="soft">Find customer details and their current work across your permitted departments.</Txt>
    {!term ? null : error ? <ErrorState title="Customer search unavailable" subtitle={error} onRetry={() => setRevision(value => value + 1)} /> : !result ? <LoadingState label="Searching customers…" /> : <>
      <View accessibilityLiveRegion="polite"><Txt v="caption" tone="soft">{result.total} matching customers{result.total > 20 ? ` · Page ${page}` : ""}</Txt></View>
      {!result.rows.length ? <EmptyState title="No matching customers" subtitle="Try another name or part of a phone number." /> : result.rows.map(match => <Pressable key={`${match.kind}:${match.floor_id}:${match.id}`} accessibilityRole="button" accessibilityLabel={`View ${match.name}, ${floorLabel(match.floor_id, floorNames)}`} testID={`home-customer-result-${match.kind}-${match.id}`} onPress={() => { setSelected(match); setProfile(null); setProfileError(null); }} style={({ pressed }) => ({ minHeight: 72, padding: space.x3, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: pressed ? color.hoverWash : color.surface, gap: space.x1 })}>
        <Txt v="bodyMid">{match.name}</Txt><Txt v="sub">{[displayPhone(match), floorLabel(match.floor_id, floorNames)].filter(Boolean).join(" · ")}</Txt>
      </Pressable>)}
      {result.total > 20 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.x2 }}><Button label="Previous results" variant="secondary" disabled={page <= 1} onPress={() => setPage(value => value - 1)} /><Button label="Next results" variant="secondary" disabled={page * 20 >= result.total} onPress={() => setPage(value => value + 1)} /></View> : null}
    </>}
    <Sheet scroll visible={!!selected} title={detail?.customer.name || selected?.name || "Customer details"} onClose={() => setSelected(null)} testID="home-customer-profile">
      {selected ? <View style={{ gap: space.x4 }}>{detailError ? <ErrorState title="Customer details unavailable" subtitle={detailError} onRetry={() => setRevision(value => value + 1)} /> : !detail ? <LoadingState label="Loading customer details…" /> : <>
        <View style={{ gap: space.x2 }}>
          {detail.customer.phone ? <Txt v="body" selectable>{displayPhone(detail.customer)}</Txt> : null}
          <Txt v="sub" tone="soft">{[...new Set([detail.customer.floor_id, ...detail.workflows.map(workflow => workflow.floor_id)])].map(id => floorLabel(id, floorNames)).join(" · ")}</Txt>
          {detail.customer.address ? <Txt v="sub" selectable>{detail.customer.address}</Txt> : null}
          <Txt v="sub">{detail.records.length ? [...new Set(detail.records.map(record => stageLabel(record.summary.stage || "lead")))].join(" · ") : "No active workflow"}</Txt>
        </View>
        {!detail.workflows.length ? <EmptyState title="No active workflow" subtitle="There is no current work for this customer in your permitted departments." /> : detail.workflows.map(workflow => <Surface key={workflow.floor_id} style={{ gap: space.x3 }}>
          <Txt v="heading">{floorLabel(workflow.floor_id, floorNames)}</Txt>
          {workflow.records.map(record => <CurrentRecord key={`${record.kind}:${record.summary.id}`} record={record} open={() => void open(record.summary)} />)}
        </Surface>)}
      </>}</View> : null}
    </Sheet>
  </Surface></View>;
}
