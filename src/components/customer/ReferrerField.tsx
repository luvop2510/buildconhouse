import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { referrerCode } from "@/src/utils/referrer";
import { api } from "@/src/api/client";
import { Alert, Button, Sheet } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

type Referrer = { customers_acquired?: number | null; id: string; name: string; company?: string | null; type: "architect" | "interior_designer" };
type ReferrerValue = Pick<Referrer, "id" | "name" | "type" | "company"> | null;

export function ReferrerField({ value, onChange, floorId, label = "Referred By", allowCreate = true, disabled = false }: { value: ReferrerValue; onChange: (value: ReferrerValue) => void; floorId?: string; label?: string; allowCreate?: boolean; disabled?: boolean }) {
  const { isPhone } = useBp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Referrer[]>([]);
  const [kind, setKind] = useState<Referrer["type"]>("architect");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useRef(0);
  useEffect(() => {
    lifecycle.current += 1;
    setAdding(false); setName(""); setCompany(""); setError(null);
    return () => { lifecycle.current += 1; };
  }, [floorId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null); setItems([]);
    void api.get<Referrer[]>("/referrers?include_counts=true", floorId ? { floorId } : undefined)
      .then((result) => { if (alive) setItems(result); })
      .catch(() => { if (alive) setError("Could not load architects and interior designers. Close and reopen to retry."); });
    return () => { alive = false; };
  }, [open, floorId]);
  const filtered = useMemo(() => items.filter((item) => item.type === kind), [items, kind]);
  const close = () => {
    // Creating a partner may finish after dismissal. Keep that response from
    // selecting a partner in a newer draft or closing a reopened picker.
    lifecycle.current += 1;
    setAdding(false);
    setOpen(false);
  };
  const choose = (item: Referrer | null) => { if (!disabled) onChange(item); close(); };
  const add = async () => {
    if (disabled || !allowCreate || adding || !name.trim()) return;
    const version = lifecycle.current;
    setAdding(true); setError(null);
    try {
      const created = await api.post<Referrer>("/referrers", { name: name.trim(), type: kind, company: company.trim() || null }, floorId ? { floorId } : undefined);
      if (version !== lifecycle.current) return;
      setItems((current) => [...current, created]);
      choose(created);
    } catch (cause: any) {
      if (version === lifecycle.current) setError(typeof cause?.detail === "string" ? cause.detail : "Could not add this partner. Your entry is preserved; retry when ready.");
    } finally { if (version === lifecycle.current) setAdding(false); }
  };

  return <View style={{ gap: 6 }}>
    <Text style={type.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ expanded: open, disabled }} aria-haspopup="dialog" onPress={() => setOpen(true)} style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, justifyContent: "center" }}>
      <Text style={type.body}>{value ? [value.name, value.company, referrerCode(value.id, value.type)].filter(Boolean).join(" · ") : "Select architect or interior designer"}</Text>
    </Pressable>
    <Sheet visible={open} onClose={close} title="Referred By" variant="bottom" testID="customer-referrer-sheet">
      <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.md : spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }} keyboardShouldPersistTaps="handled">
        {error ? <Alert tone="error" title={error} /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {(["architect", "interior_designer"] as const).map((option) => <Button key={option} label={option === "architect" ? "Architect" : "Interior designer"} variant={kind === option ? "primary" : "secondary"} onPress={() => setKind(option)} />)}
        </View>
        <Pressable accessibilityRole="button" onPress={() => choose(null)} style={{ minHeight: 44, justifyContent: "center", paddingVertical: spacing.sm }}><Text style={type.body}>No referrer</Text></Pressable>
        {filtered.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.name} onPress={() => choose(item)} style={{ minHeight: 44, justifyContent: "center", paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border }}><Text style={type.body}>{[item.name, item.company, referrerCode(item.id, item.type), item.customers_acquired == null ? null : `${item.customers_acquired} customers brought`].filter(Boolean).join(" · ")}</Text></Pressable>)}
        {allowCreate ? <>
        <Text style={[type.label, { marginTop: spacing.md }]}>Add new {kind === "architect" ? "architect" : "interior designer"}</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Designer / architect name" accessibilityLabel="Designer / architect name" style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md }} />
        <TextInput value={company} onChangeText={setCompany} placeholder="Interior / studio name (optional)" accessibilityLabel="Interior / studio name" style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md }} testID="lead-interior-company" />
        <Button label={adding ? "Adding…" : "Add and select"} disabled={adding || !name.trim()} onPress={add} />
        </> : null}
      </ScrollView>
    </Sheet>
  </View>;
}
