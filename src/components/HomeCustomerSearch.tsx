import React, { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { api, subscribeApiCacheInvalidation } from "@/src/api/client";
import { useAuth } from "@/src/state/auth";
import { setSelectedFloorId, useFloorAccess } from "@/src/hooks/use-floor-access";
import { Button, EmptyState, ErrorState, LoadingState, SearchField, Sheet } from "@/src/components/ds";
import { Surface, Txt } from "@/src/design/components";
import { KITCHEN_WORKSPACE_PAGES } from "@/src/kitchen-workspace-pages";
import { Disclosure } from "@/src/design/Disclosure";
import { color, radius, space } from "@/src/design/tokens";
import { formatDepartmentPhone } from "@/src/utils/phone";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";

export interface CustomerMatch { kind: string; id: string; floor_id: string; customer_id?: string; floor_ids?: string[]; name: string; phone?: string; reference?: string; address?: string; stage?: string; status?: string; doc_type?: string }
type ProfileSource = Pick<CustomerMatch, "kind" | "id" | "floor_id"> & Partial<Pick<CustomerMatch, "name">>;
interface Result { rows: CustomerMatch[]; total: number; page: number; limit: number }
interface RecordView { kind: string; summary: CustomerMatch; data: Record<string, unknown> }
interface PaymentBalance { id: string; floor_id: string; number?: string; outstanding: number | null; currency: string }
interface Profile { customer: CustomerMatch; records: RecordView[]; workflows: { floor_id: string; records: RecordView[] }[]; departments?: string[]; history?: RecordView[]; payments?: PaymentBalance[] }
// The universal lookup historically shows Kitchen's raw contact value.
const displayPhone = (match: CustomerMatch) => match.floor_id === KITCHEN_FLOOR_ID
  ? match.phone : formatDepartmentPhone(match.phone, match.floor_id);
const label = (key: string) => key.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
const stageLabel = (stage: string) => stage === "followup" ? "Follow-up" : KITCHEN_WORKSPACE_PAGES.find(page => page.stage === stage)?.label || label(stage);
const cleanReference = (value?: string) => value && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value) ? value : "";
const floorLabel = (id: string, names: Record<string, string>) => names[id] || ({ "ground-floor": "Ground Floor", "first-floor": "Sanitary Floor", "second-floor": "Kitchen Floor", "third-floor": "Furniture Floor" }[id]) || "Department";
const amountLabel = (amount: number, currency = "INR") => currency === "RNB"
  ? `${amount.toLocaleString("en-IN")} RNB` : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(amount);
const recordStage = (summary: CustomerMatch) => summary.stage ? stageLabel(summary.stage) : ({
  quotation: "Quotation", order: "Order", furniture: "Furniture ledger", walkin: "Walk-in", followup: "Follow-up", kitchen: "Kitchen project",
}[summary.kind] || "Record");
const fieldLabels: Record<string, string> = {
  response: "Status", received_status: "Quotation received", sent_status: "Sent to customer", received_date: "Received", shared_date: "Shared",
  kitchen_type: "Kitchen type", confirmed: "Confirmed", order_date: "Order date", final_amount: "Order amount", amount: "Amount",
  site_location: "Site", scheduled_date: "Scheduled", visit_date: "Visit", percentage: "Progress", start_date: "Started", completed_date: "Completed",
  notes: "Notes", doc_date: "Date", grand_total: "Total", overall_status: "Status", total_products: "Products", total_value: "Order value",
  due_at: "Follow-up due", snoozed_until: "Rescheduled to", next_action: "Next action", next_followup_at: "Next contact", followup_date: "Next contact", notebook_status: "Status", total_payable_rmb: "Total (RNB)", balance_rmb: "Balance (RNB)",
};

function CurrentRecord({ record, open }: { record: RecordView; open: () => void }) {
  const stage = recordStage(record.summary);
  const fields = Object.entries(record.data).filter(([key, value]) => fieldLabels[key] && value !== null && value !== undefined && value !== "" && typeof value !== "object");
  return <View style={{ gap: space.x2 }} testID={`current-workflow-${record.summary.kind}-${record.summary.id}`}>
    <Txt v="bodyMid">{stage}{cleanReference(record.summary.reference) ? ` · ${cleanReference(record.summary.reference)}` : ""}</Txt>
    {record.summary.status ? <Txt v="sub" tone="soft">{label(record.summary.status)}</Txt> : null}
    {fields.filter(([key]) => !["overall_status", "response", "notebook_status"].includes(key) || !record.summary.status).map(([key, value]) => <Txt key={key} v="sub">{fieldLabels[key]}: {typeof value === "boolean" ? value ? "Yes" : "No"
      : typeof value === "number" && ["total_payable_rmb", "balance_rmb", "total_value", "grand_total", "final_amount", "amount"].includes(key)
        ? amountLabel(value, key.endsWith("_rmb") ? "RNB" : "INR") : String(value)}</Txt>)}
    {record.kind === "kitchen" && record.data.number ? <Txt v="sub">{stage} {String(record.data.number)}</Txt> : null}
    <Button label={`Open ${stage.toLowerCase()}`} variant="secondary" onPress={open} />
  </View>;
}

/** The Home lookup searches every permitted floor, independent of Today filters. */
export function HomeCustomerSearch() {
  const { staff } = useAuth();
  const { floors, selectedFloorId } = useFloorAccess();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<CustomerMatch | null>(null);
  const [response, setResponse] = useState<{ key: string; value: Result } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const term = search.trim();
  const accessKey = JSON.stringify([staff?.id, staff?.role, staff?.custom_access, staff?.access_profile, staff?.access_grants, selectedFloorId, revision]);
  const queryKey = JSON.stringify([accessKey, term, page]);
  const result = response?.key === queryKey ? response.value : null;
  const error = failure?.key === queryKey ? failure.message : null;
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
  return <View testID="home-customer-search"><Surface style={{ gap: space.x3 }}>
<Txt v="heading">Find a customer</Txt>
    <SearchField accessibilityLabel="Search customers across all permitted floors" testID="home-customer-search-input" placeholder="Customer name or phone number" maxLength={200} value={search} onChangeText={value => { setSearch(value); setPage(1); }} onClear={() => { setSearch(""); setPage(1); }} />
    <Txt v="caption" tone="soft">Find customer details and their current work across your permitted departments.</Txt>
    {!term ? null : error ? <ErrorState title="Customer search unavailable" subtitle={error} onRetry={() => setRevision(value => value + 1)} /> : !result ? <LoadingState label="Searching customers…" /> : <>
      <View accessibilityLiveRegion="polite"><Txt v="caption" tone="soft">{result.total} matching customers{result.total > 20 ? ` · Page ${page}` : ""}</Txt></View>
      {!result.rows.length ? <EmptyState title="No matching customers" subtitle="Try another name or part of a phone number." /> : result.rows.map(match => <Pressable key={`${match.kind}:${match.floor_id}:${match.id}`} accessibilityRole="button" accessibilityLabel={`View ${match.name}, ${floorLabel(match.floor_id, floorNames)}`} testID={`home-customer-result-${match.kind}-${match.id}`} onPress={() => setSelected(match)} style={({ pressed }) => ({ minHeight: 72, padding: space.x3, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, backgroundColor: pressed ? color.hoverWash : color.surface, gap: space.x1 })}>
        <Txt v="bodyMid">{match.name}</Txt><Txt v="sub">{[displayPhone(match), ...(match.floor_ids || [match.floor_id]).map(id => floorLabel(id, floorNames))].filter(Boolean).join(" · ")}</Txt>
      </Pressable>)}
      {result.total > 20 ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.x2 }}><Button label="Previous results" variant="secondary" disabled={page <= 1} onPress={() => setPage(value => value - 1)} /><Button label="Next results" variant="secondary" disabled={page * 20 >= result.total} onPress={() => setPage(value => value + 1)} /></View> : null}
    </>}
    <Sheet scroll visible={!!selected} title={selected?.name || "Customer profile"} onClose={() => setSelected(null)} testID="home-customer-profile">
      {selected ? <CustomerProfile selected={selected} onOpen={() => setSelected(null)} /> : null}
    </Sheet>
  </Surface></View>;
}

export function CustomerProfile({ selected, onOpen }: { selected: ProfileSource; onOpen?: () => void }) {
  const { staff } = useAuth();
  const router = useRouter();
  const { floors, selectedFloorId } = useFloorAccess();
  const { kind, id, floor_id } = selected;
  const [revision, setRevision] = useState(0);
  const [profile, setProfile] = useState<{ key: string; value: Profile } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [navigationError, setNavigationError] = useState("");
  const selectedKey = JSON.stringify([staff?.id, staff?.role, staff?.access_grants, selectedFloorId, kind, id, floor_id, revision]);
  const detail = profile?.key === selectedKey ? profile.value : null;
  const detailError = failure?.key === selectedKey ? failure.message : null;
  const floorNames = Object.fromEntries(floors.map(floor => [floor.id, floor.name]));

  useEffect(() => subscribeApiCacheInvalidation(() => setRevision(value => value + 1)), []);
  useEffect(() => {
    if (!staff?.id) return;
    const controller = new AbortController();
    const path = `/customer-search/profile?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}&floor_id=${encodeURIComponent(floor_id)}`;
    void api.get<Profile>(path, { cacheMs: 0, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setProfile({ key: selectedKey, value }); })
      .catch(cause => { if (!controller.signal.aborted) setFailure({ key: selectedKey, message: cause?.detail || cause?.message || "Please try again." }); });
    return () => controller.abort();
  }, [selectedKey, kind, id, floor_id, staff?.id]);

  const open = async (floor: string, href: string) => {
    try {
      await setSelectedFloorId(floor);
      onOpen?.();
      router.push(`/(admin)${href}` as never);
    } catch (cause: any) {
      setNavigationError(cause?.message || "Could not open this department. Please retry.");
    }
  };
  const openRecord = (match: CustomerMatch) => {
    const recordId = encodeURIComponent(match.id);
    const href = match.kind === "kitchen" ? `/kitchen/${recordId}/stages/${match.stage}?details=1`
      : match.kind === "customer" ? `/customers/${recordId}` : match.kind === "walkin" ? `/walkins/${recordId}`
        : match.kind === "quotation" ? match.floor_id === "ground-floor" ? `/tiles/${match.doc_type === "tiles_selection" ? "selection" : "quotation"}?id=${recordId}` : `/quotations/${recordId}`
          : match.kind === "order" ? `/tiles/orders/${recordId}` : match.kind === "furniture" ? `/notebook/furniture-quotations?id=${recordId}` : `/followups?id=${recordId}`;
    return open(match.floor_id, href);
  };

  if (detailError) return <ErrorState title="Customer details unavailable" subtitle={detailError} onRetry={() => setRevision(value => value + 1)} />;
  if (!detail) return <LoadingState label="Loading customer details…" />;
  const departments = detail.departments || [...new Set([detail.customer.floor_id, ...detail.workflows.map(workflow => workflow.floor_id)])];
  const records = [...detail.records, ...(detail.history || [])];
  const quotations = records.filter(record => record.kind === "quotation" && record.summary.doc_type !== "tiles_selection");
  const orders = records.filter(record => record.kind === "order" ||
    (record.kind === "quotation" && record.summary.floor_id === "first-floor" && record.summary.status === "ordered"));
  const activityCount = detail.records.length;
  const summary = [
    `${activityCount} active ${activityCount === 1 ? "activity" : "activities"}`,
    quotations.length ? `${quotations.length} saved ${quotations.length === 1 ? "quotation" : "quotations"}` : null,
    orders.length ? `${orders.length} catalogue ${orders.length === 1 ? "order" : "orders"}` : null,
  ].filter(Boolean).join(" · ");
  return <View style={{ gap: space.x4 }}>
    <View style={{ gap: space.x2 }}>
      <Txt v="heading">{detail.customer.name}</Txt>
      {detail.customer.phone ? <Txt v="body" selectable>{displayPhone(detail.customer)}</Txt> : null}
      {detail.customer.address ? <Txt v="sub" selectable>{detail.customer.address}</Txt> : null}
      <Txt v="sub" tone="soft">{departments.map(floor => floorLabel(floor, floorNames)).join(" · ")}</Txt>
      <Txt v="sub">{summary}</Txt>
    </View>
    {navigationError ? <View accessibilityRole="alert"><Txt>{navigationError}</Txt></View> : null}
    {!!detail.payments?.length && <Surface style={{ gap: space.x2 }}>
      <Txt v="heading">Outstanding payments</Txt>
      {detail.payments.map(row => <View key={`${row.floor_id}:${row.id}`} style={{ gap: space.x1 }}>
        <Txt v="bodyMid">{row.outstanding === null ? "Balance unavailable" : amountLabel(row.outstanding, row.currency)}</Txt>
        <Txt v="sub">{[row.number, floorLabel(row.floor_id, floorNames)].filter(Boolean).join(" · ")}</Txt>
        <Button label="Open payment" variant="secondary" onPress={() => void open(row.floor_id, `/payments?id=${encodeURIComponent(row.id)}`)} />
      </View>)}
    </Surface>}
    {!detail.workflows.length ? <EmptyState title="No active workflow" subtitle="There is no current work for this customer in your permitted departments." /> : detail.workflows.map(workflow => <Surface key={workflow.floor_id} style={{ gap: space.x3 }}>
      <Txt v="heading">{floorLabel(workflow.floor_id, floorNames)}</Txt>
      {workflow.records.map(record => <CurrentRecord key={`${record.kind}:${record.summary.id}`} record={record} open={() => void openRecord(record.summary)} />)}
    </Surface>)}
    {!!detail.history?.length && <Disclosure title="Activity history" summary={`${detail.history.length} records`}>
      {detail.history.map(record => <Surface key={`${record.kind}:${record.summary.floor_id}:${record.summary.id}`} style={{ gap: space.x2 }}>
        <Txt v="caption" tone="soft">{floorLabel(record.summary.floor_id, floorNames)}</Txt>
        <CurrentRecord record={record} open={() => void openRecord(record.summary)} />
      </Surface>)}
    </Disclosure>}
  </View>;
}
