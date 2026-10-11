import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import { Alert, Button, Sheet } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

type Referrer = { id: string; name: string; type: "architect" | "interior_designer" };
type ReferrerValue = Pick<Referrer, "id" | "name" | "type"> | null;

export function ReferrerField({ value, onChange, floorId, label = "Referred By", allowCreate = true }: { value: ReferrerValue; onChange: (value: ReferrerValue) => void; floorId?: string; label?: string; allowCreate?: boolean }) {
  const { isPhone } = useBp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Referrer[]>([]);
  const [kind, setKind] = useState<Referrer["type"]>("architect");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useRef(0);
  useEffect(() => {
    lifecycle.current += 1;
    setAdding(false); setName(""); setError(null);
    return () => { lifecycle.current += 1; };
  }, [floorId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null); setItems([]);
    void api.get<Referrer[]>("/referrers", floorId ? { floorId } : undefined)
      .then((result) => { if (alive) setItems(result); })
      .catch(() => { if (alive) setError("Could not load architects and interior designers. Close and reopen to retry."); });
    return () => { alive = false; };
  }, [open, floorId]);
  const filtered = useMemo(() => items.filter((item) => item.type === kind), [items, kind]);
  const choose = (item: Referrer | null) => { onChange(item); setOpen(false); };
  const add = async () => {
    if (!allowCreate || adding || !name.trim()) return;
    const version = lifecycle.current;
    setAdding(true); setError(null);
    try {
      const created = await api.post<Referrer>("/referrers", { name: name.trim(), type: kind }, floorId ? { floorId } : undefined);
      if (version !== lifecycle.current) return;
      setItems((current) => [...current, created]);
      choose(created);
    } catch (cause: any) {
      if (version === lifecycle.current) setError(typeof cause?.detail === "string" ? cause.detail : "Could not add this partner. Your entry is preserved; retry when ready.");
    } finally { if (version === lifecycle.current) setAdding(false); }
  };

  return <View style={{ gap: 6 }}>
    <Text style={type.label}>{label}</Text>
    <Pressable onPress={() => setOpen(true)} style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, justifyContent: "center" }}>
      <Text style={type.body}>{value?.name || "Select architect or interior designer"}</Text>
    </Pressable>
    <Sheet visible={open} onClose={() => setOpen(false)} title="Referred By" variant="bottom" testID="customer-referrer-sheet">
      <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.md : spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }} keyboardShouldPersistTaps="handled">
        {error ? <Alert tone="error" title={error} /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {(["architect", "interior_designer"] as const).map((option) => <Button key={option} label={option === "architect" ? "Architect" : "Interior designer"} variant={kind === option ? "primary" : "secondary"} onPress={() => setKind(option)} />)}
        </View>
        <Pressable onPress={() => choose(null)} style={{ paddingVertical: spacing.sm }}><Text style={type.body}>No referrer</Text></Pressable>
        {filtered.map((item) => <Pressable key={item.id} onPress={() => choose(item)} style={{ paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border }}><Text style={type.body}>{item.name}</Text></Pressable>)}
        {allowCreate ? <>
        <Text style={[type.label, { marginTop: spacing.md }]}>Add new {kind === "architect" ? "architect" : "interior designer"}</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Name or studio" style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md }} />
        <Button label={adding ? "Adding…" : "Add and select"} disabled={adding || !name.trim()} onPress={add} />
        </> : null}
      </ScrollView>
    </Sheet>
  </View>;
}
