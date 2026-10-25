import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Alert, Button, Card, LoadingState, TextField } from "@/src/components/ui";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { spacing, type } from "@/src/theme/tokens";
import { referrerCode } from "@/src/utils/referrer";

type ReferenceKind = "architect" | "interior_designer";
type Reference = { id: string; name: string; type: ReferenceKind; company?: string | null; phone?: string | null; email?: string | null; address?: string | null; shared_across_floors: boolean; updated_at: string };
const blank = { name: "", company: "", phone: "", email: "", address: "" };

export function ReferrerDirectory({ kind }: { kind: ReferenceKind }) {
  const { staff } = useAuth();
  const router = useRouter();
  const { selectedFloorId } = useFloorAccess();
  const [items, setItems] = useState<Reference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Reference | null | undefined>(undefined);
  const [draft, setDraft] = useState(blank);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const savePending = useRef(false);
  const load = useCallback(() => {
    const version = ++generation.current;
    setLoading(true); setError("");
    void api.get<Reference[]>(`/referrers?type=${kind}`, selectedFloorId ? { floorId: selectedFloorId } : undefined).then(result => {
      if (version === generation.current) setItems(result);
    }).catch(cause => { if (version === generation.current) setError(typeof cause?.detail === "string" ? cause.detail : "Could not load references. Retry to load the directory."); }).finally(() => { if (version === generation.current) setLoading(false); });
  }, [kind, selectedFloorId]);
  useEffect(() => { setItems([]); setEditing(undefined); load(); return () => { generation.current += 1; }; }, [load]);
  const edit = (item: Reference | null) => {
    setEditing(item); setError("");
    setDraft(item ? { name: item.name, company: item.company || "", phone: item.phone || "", email: item.email || "", address: item.address || "" } : blank);
  };
  const save = async () => {
    if (savePending.current || staff?.role !== "owner" || !draft.name.trim() || editing === undefined) return;
    const version = generation.current;
    savePending.current = true; setSaving(true); setError("");
    const body = { ...draft, name: draft.name.trim(), email: draft.email.trim() || null, type: kind };
    try {
      const item = editing
        ? await api.put<Reference>(`/referrers/${editing.id}`, { ...body, shared_across_floors: true, updated_at: editing.updated_at }, selectedFloorId ? { floorId: selectedFloorId } : undefined)
        : await api.post<Reference>("/referrers", body, selectedFloorId ? { floorId: selectedFloorId } : undefined);
      if (version !== generation.current) return;
      setItems(current => [...current.filter(row => row.id !== item.id), item].sort((a, b) => a.name.localeCompare(b.name)));
      // A matching legacy entry is returned rather than creating a duplicate.
      if (!item.shared_across_floors) edit(item); else setEditing(undefined);
    } catch (cause: any) {
      if (version === generation.current) setError(typeof cause?.detail === "string" ? cause.detail : "Could not save the reference. Your entries have been kept.");
    } finally { savePending.current = false; setSaving(false); }
  };
  const visible = items.filter(item => [item.name, item.company, item.phone].some(value => value?.toLowerCase().includes(search.trim().toLowerCase())));
  return <Card padding={spacing.md}><View style={{ gap: spacing.md }} testID="sales-reference-directory">
    <Text style={type.titleSm}>Reference directory</Text>
    <Text style={type.body}>Save contact and company details once and select the same reference on every floor. Referred clients and sales remain linked in the reports below.</Text>
    {error ? <Alert tone="error" title={error} /> : null}
    {editing !== undefined ? <View style={{ gap: spacing.sm }}>
      <Text style={type.bodyStrong}>{editing ? "Edit reference" : "Add reference"}</Text>
      {([ ["name", "Name"], ["company", "Company / studio"], ["phone", "Phone"], ["email", "Email"], ["address", "Address"] ] as const).map(([key, label]) => <TextField key={key} label={label} value={draft[key]} onChangeText={value => setDraft(current => ({ ...current, [key]: value }))} editable={!saving} maxLength={key === "address" ? 1000 : key === "company" ? 250 : key === "phone" ? 100 : 200} keyboardType={key === "phone" ? "phone-pad" : key === "email" ? "email-address" : "default"} autoCapitalize={key === "email" ? "none" : "sentences"} testID={`reference-${key}`} />)}
      <Text style={type.caption}>Saving makes this contact available across all floors and keeps its existing reference ID.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><Button label={saving ? "Saving…" : "Save reference"} disabled={saving || !draft.name.trim()} onPress={() => void save()} /><Button label="Cancel" variant="secondary" disabled={saving} onPress={() => setEditing(undefined)} /></View>
    </View> : staff?.role === "owner" ? <Button label="Add reference" onPress={() => edit(null)} /> : null}
    <TextField label="Search references" value={search} onChangeText={setSearch} />
    {loading ? <LoadingState label="Loading references…" /> : <>
      {!visible.length ? <Text style={type.body}>No matching references.</Text> : null}
      {visible.map(item => <View key={item.id} style={{ gap: spacing.xs, paddingVertical: spacing.sm }}>
        <Text style={type.bodyStrong}>{[item.name, item.company].filter(Boolean).join(" · ")}</Text>
        <Text style={type.caption}>{[referrerCode(item.id, item.type), item.shared_across_floors ? "All floors" : "This floor", item.phone, item.email, item.address].filter(Boolean).join(" · ")}</Text>
        <Button label={`View clients referred by ${item.name}`} variant="secondary" onPress={() => router.push(`/(admin)/sales-data/referrer/${item.id}?floorId=${selectedFloorId || "all"}&preset=all_time` as never)} />
        {staff?.role === "owner" ? <Button label={`Edit ${item.name}`} variant="secondary" disabled={saving} onPress={() => edit(item)} /> : null}
      </View>)}
    </>}
    {error && !editing ? <Button label="Retry directory" variant="secondary" onPress={load} /> : null}
  </View></Card>;
}
