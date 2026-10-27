import { useEffect, useRef, useState } from "react";
import { Switch, View } from "react-native";

import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Alert, Button, PillTabs, Sheet, TextField } from "@/src/components/ui";
import { spacing, type } from "@/src/theme/tokens";
import type { ReferenceContact, ReferenceKind } from "./ReferencesModel";

export function ReferencesEditor({ item, initialKind, floorId, onSaved, onClose }: {
  item: ReferenceContact | null; initialKind: ReferenceKind; floorId: string;
  onSaved: (contact: ReferenceContact) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState({ name: item?.name || "", company: item?.company || "", phone: item?.phone || "", email: item?.email || "", address: item?.address || "" });
  const [kind, setKind] = useState<ReferenceKind>(item?.type || initialKind);
  const [shared, setShared] = useState(item?.shared_across_floors ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const save = async () => {
    if (pending.current || !draft.name.trim()) return;
    pending.current = true; setSaving(true); setError(null);
    const body = { ...draft, name: draft.name.trim(), email: draft.email.trim() || null, type: kind };
    try {
      const saved = item
        ? await api.put<ReferenceContact>(`/referrers/${item.id}`, { ...body, shared_across_floors: shared, updated_at: item.updated_at }, { floorId })
        : await api.post<ReferenceContact>("/referrers", body, { floorId });
      if (alive.current) onSaved(saved);
    } catch (cause: unknown) {
      const detail = (cause as { detail?: unknown })?.detail;
      if (alive.current) setError(typeof detail === "string" ? detail : "Could not save the reference. Your entries have been kept.");
    } finally { pending.current = false; if (alive.current) setSaving(false); }
  };
  return <Sheet visible onClose={onClose} dismissable={!saving} scroll title={item ? "Edit reference" : "Add reference"} testID="reference-editor">
    <View style={{ gap: spacing.s16 }}>
      {error ? <Alert tone="error" title={error} /> : null}
      {item ? <Text style={type.body}>{kind === "architect" ? "Architect" : "Interior designer"}</Text> : <PillTabs
        value={kind} onChange={value => { if (!saving) setKind(value); }} testID="reference-kind"
        options={[{ value: "interior_designer", label: "Interior designer" }, { value: "architect", label: "Architect" }]}
      />}
      {([ ["name", "Name (required)"], ["company", "Company / studio"], ["phone", "Phone"], ["email", "Email"], ["address", "Address"] ] as const).map(([key, label]) => <TextField
        key={key} label={label} value={draft[key]} onChangeText={value => setDraft(current => ({ ...current, [key]: value }))}
        editable={!saving} maxLength={key === "address" ? 1000 : key === "company" ? 250 : key === "phone" ? 100 : 200}
        keyboardType={key === "phone" ? "phone-pad" : key === "email" ? "email-address" : "default"}
        autoCapitalize={key === "email" ? "none" : "sentences"} testID={`reference-${key}`}
      />)}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.s12 }}><Text style={[type.body, { flex: 1 }]}>Available across all floors</Text><Switch accessibilityLabel="Available across all floors" value={shared} disabled={saving || !item} onValueChange={setShared} /></View>
      <Text style={type.caption}>{item ? "Sharing changes apply only when you save." : "New references are shared across floors. Existing private contacts keep their current sharing setting."}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.s8 }}>
        <Button label="Save reference" loading={saving} disabled={saving || !draft.name.trim()} onPress={() => void save()} />
        <Button label="Cancel" variant="secondary" disabled={saving} onPress={onClose} />
      </View>
    </View>
  </Sheet>;
}
