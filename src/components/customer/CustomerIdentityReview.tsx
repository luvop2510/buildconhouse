import { useState } from "react";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { api } from "@/src/api/client";
import { Button, TextField } from "@/src/components/ui";
import { Disclosure } from "@/src/design/Disclosure";
import { Text } from "@/src/components/AppText";
import { spacing, type } from "@/src/theme/tokens";
import { Choice, Empty, FLOOR_NAMES, Panel, ReadState } from "@/src/components/salesAnalytics/AnalyticsParts";
import { Pagination } from "@/src/components/salesAnalytics/AnalyticsEntities";
import { useAnalyticsRead } from "@/src/components/salesAnalytics/useAnalytics";

type Decision = "same" | "distinct" | "review";
type Review = { decision: Decision; note: string; actor_name: string; reviewed_at: string; revision: number };
type Candidate = { id: string; evidence: string; customers: { id: string; floor_id: string; name: string; phone?: string; address?: string }[]; review?: Review };
type ReviewPage = { rows: Candidate[]; total: number; revision: number };
const choices: { value: Decision; label: string }[] = [
  { value: "same", label: "Confirmed same person" },
  { value: "distinct", label: "Confirmed separate people" },
  { value: "review", label: "Needs review" },
];

function CandidateReview({ row, revision, refresh }: { row: Candidate; revision: number; refresh: () => void }) {
  const router = useRouter();
  const [ids, setIds] = useState(() => row.customers.length === 2 ? row.customers.map(customer => customer.id) : []);
  const [decision, setDecision] = useState<Decision>(row.review?.decision || "review");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = (id: string) => setIds(current => current.includes(id) ? current.filter(candidate => candidate !== id) : [...current, id].slice(-2));
  const save = async () => {
    if (ids.length !== 2 || !note.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.post("/customer-search/identity-review", { customer_ids: ids, decision, note: note.trim(), expected_revision: revision });
      setNote("");
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the decision.");
    } finally {
      setBusy(false);
    }
  };
  const detail = row.evidence === "phone" ? "Matching phone" : row.evidence === "name" ? "Matching name"
    : row.evidence === "confirmed source" ? "Existing source link" : "Owner decision";
  return <Panel title={[...new Set(row.customers.map(customer => customer.name))].join(" / ")} testID={`customer-identity-review-${row.id}`}>
    <Text style={type.caption}>{detail} · {row.customers.length} profiles</Text>
    <Disclosure title="Compare profiles">
      {row.customers.map(customer => <View key={customer.id} style={{ gap: spacing.s4 }}>
        <Text style={type.bodyStrong}>{customer.name}</Text>
        <Text style={type.bodySm}>{[FLOOR_NAMES[customer.floor_id] || customer.floor_id, customer.phone, customer.address].filter(Boolean).join(" · ")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.s8 }}>
          <Button label={ids.includes(customer.id) ? "Selected" : "Select profile"} variant="secondary" disabled={busy} onPress={() => toggle(customer.id)} />
          <Button label="Open profile" variant="ghost" onPress={() => router.push(`/(admin)/customer-profile?kind=customer&id=${encodeURIComponent(customer.id)}&floorId=${encodeURIComponent(customer.floor_id)}` as never)} />
        </View>
      </View>)}
      {row.review ? <View style={{ gap: spacing.s4 }}>
        <Text style={type.bodyStrong}>{choices.find(choice => choice.value === row.review?.decision)?.label}</Text>
        <Text style={type.bodySm}>{row.review.note}</Text>
        <Text style={type.caption}>{row.review.actor_name} · {new Date(row.review.reviewed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · Revision {row.review.revision}</Text>
      </View> : null}
      <Choice label="Decision" testID="customer-identity-decision" value={decision} options={choices} onChange={value => setDecision(value as Decision)} />
      <TextField label="Reason for decision" value={note} onChangeText={setNote} editable={!busy} maxLength={500} multiline />
      {error ? <Text accessibilityRole="alert" style={type.bodySm}>{error}</Text> : null}
      <Button label="Save identity decision" loading={busy} disabled={ids.length !== 2 || !note.trim() || busy} onPress={() => void save()} />
    </Disclosure>
  </Panel>;
}

export function CustomerIdentityReview() {
  const [page, setPage] = useState(1);
  const limit = 20;
  const read = useAnalyticsRead(`customer-identity-review:${page}`,
    signal => api.get<ReviewPage>(`/customer-search/identity-review?page=${page}&limit=${limit}`, { signal, cacheMs: 0 }), true);
  return <View style={{ gap: spacing.s12 }}>
    <Text style={type.bodyMuted}>Review likely matches across all floors. Confirm a link only after verifying the person. Every quotation, order, file and follow-up keeps its original record.</Text>
    <ReadState variant="quality" loading={read.loading && !read.data} refreshing={read.loading && !!read.data} error={read.error} retry={read.refresh} />
    {read.data ? <>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: spacing.s8 }}>
        <Text style={type.bodySm}>{read.data.total.toLocaleString("en-IN")} review groups</Text>
        <Button label="Refresh" variant="ghost" onPress={read.refresh} disabled={read.loading} />
      </View>
      {read.data.rows.length ? read.data.rows.map(row => <CandidateReview key={row.id} row={row} revision={read.data!.revision} refresh={read.refresh} />)
        : <Empty text="No matching customer names or phones were found." />}
      <Pagination total={read.data.total} page={page} size={limit} update={next => setPage(Number(next.page) || 1)} />
    </> : null}
  </View>;
}
