import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { validPhone } from "@/src/utils/phone";
import { referrerCode } from "@/src/utils/referrer";
import { api } from "@/src/api/client";
import { Alert, Button, LoadingState, Sheet, TextField } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

type Referrer = { customers_acquired?: number | null; id: string; name: string; company?: string | null; type: "architect" | "interior_designer" };
export type ReferrerValue = Pick<Referrer, "id" | "name" | "type" | "company"> | null;

export function ReferrerField({ value, onChange, floorId, label = "Referred By", allowCreate = true, disabled = false }: { value: ReferrerValue; onChange: (value: ReferrerValue) => void; floorId?: string; label?: string; allowCreate?: boolean; disabled?: boolean }) {
  const { isPhone } = useBp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Referrer[]>([]);
  const [kind, setKind] = useState<Referrer["type"] | "all">("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [visibleCount, setVisibleCount] = useState(25);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [company, setCompany] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useRef(0);
  const pending = useRef(false);
  const scope = `${floorId || ""}:${value?.id || ""}:${disabled}:${allowCreate}`;
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) { lifecycle.current += 1; scopeRef.current = scope; }
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    lifecycle.current += 1;
    setAdding(false); setName(""); setPhone(""); setAddress(""); setCompany(""); setError(null);
    return () => { lifecycle.current += 1; };
  }, [floorId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null); setItems([]); setLoading(true);
    void api.get<Referrer[]>("/referrers?include_counts=true", floorId ? { floorId } : undefined)
      .then((result) => { if (alive) setItems(result); })
      .catch(() => { if (alive) setError("Could not load architects and interior designers. Retry to load the reference directory."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, floorId, retry]);
  const filtered = useMemo(() => items.filter((item) => (kind === "all" || item.type === kind) && [item.name, item.company, referrerCode(item.id, item.type, item.name)].some(text => text?.toLowerCase().includes(search.trim().toLowerCase()))), [items, kind, search]);
  useEffect(() => { setVisibleCount(25); }, [kind, search, open]);
  const close = () => {
    // Creating a partner may finish after dismissal. Keep that response from
    // selecting a partner in a newer draft or closing a reopened picker.
    lifecycle.current += 1;
    setAdding(false);
    setOpen(false);
  };
  const choose = (item: Referrer | null) => { if (!disabledRef.current) onChange(item); close(); };
  const add = async () => {
    if (disabled || !allowCreate || pending.current || kind === "all" || !name.trim() || !validPhone(phone)) return;
    const version = lifecycle.current;
    pending.current = true; setAdding(true); setError(null);
    try {
      const created = await api.post<Referrer>("/referrers", { name: name.trim(), phone: phone.trim(), type: kind, company: company.trim() || null, address: address.trim() || null }, floorId ? { floorId } : undefined);
      if (version !== lifecycle.current) return;
      setItems((current) => [...current.filter(item => item.id !== created.id), created]);
      choose(created);
    } catch (cause: any) {
      if (version === lifecycle.current) setError(typeof cause?.detail === "string" ? cause.detail : "Could not add this partner. Your entry is preserved; retry when ready.");
    } finally { pending.current = false; setAdding(false); }
  };

  return <View style={{ gap: 6 }}>
    <Text style={type.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} accessibilityState={{ expanded: open, disabled }} aria-haspopup="dialog" onPress={() => { setSearch(""); setKind("all"); setOpen(true); }} style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, justifyContent: "center" }}>
      <Text style={type.body}>{value ? [value.name, value.company, referrerCode(value.id, value.type, value.name)].filter(Boolean).join(" · ") : "Select architect or interior designer"}</Text>
    </Pressable>
    <Sheet visible={open} onClose={close} title="Referred By" variant="bottom" testID="customer-referrer-sheet">
      <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.md : spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl }} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={type.titleSm}>Choose an existing reference</Text>
        {error ? <><Alert tone="error" title={error} /><Button label="Retry references" variant="secondary" onPress={() => setRetry(value => value + 1)} /></> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {(["all", "architect", "interior_designer"] as const).map((option) => <Button key={option} label={option === "all" ? "All references" : option === "architect" ? "Architect" : "Interior designer"} variant={kind === option ? "primary" : "secondary"} onPress={() => setKind(option)} />)}
        </View>
        <TextField label="Search references" placeholder="Name, studio or reference code" value={search} onChangeText={setSearch} />
        {loading ? <LoadingState label="Loading references…" /> : !error && !filtered.length ? <Text style={type.body}>{search.trim() ? "No matching references. Try another name, studio or reference code." : "No existing references in this category."}</Text> : null}
        <Pressable accessibilityRole="button" onPress={() => choose(null)} style={{ minHeight: 44, justifyContent: "center", paddingVertical: spacing.sm }}><Text style={type.body}>No referrer</Text></Pressable>
        {filtered.slice(0, visibleCount).map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.name} onPress={() => choose(item)} style={{ minHeight: 44, justifyContent: "center", paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border }}><Text style={type.body}>{[item.name, item.company, referrerCode(item.id, item.type, item.name), item.customers_acquired == null ? null : `${item.customers_acquired} customers brought`].filter(Boolean).join(" · ")}</Text></Pressable>)}
        {filtered.length > visibleCount ? <Button label="Show more references" variant="secondary" onPress={() => setVisibleCount(count => count + 25)} /> : null}
        {allowCreate && kind === "all" ? <Text style={type.caption}>To add a contact, choose Architect or Interior designer above.</Text> : null}
        {allowCreate && kind !== "all" ? <>
        <Text style={[type.label, { marginTop: spacing.md }]}>Add new {kind === "architect" ? "architect" : "interior designer"}</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Designer / architect name (required)" accessibilityLabel="Designer / architect name (required)" style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md }} />
        <TextField label="Phone (required)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="990-995-57-55" testID="lead-interior-phone" />
        <TextField label="Address (optional)" value={address} onChangeText={setAddress} />
        <TextInput value={company} onChangeText={setCompany} placeholder="Interior / studio name (optional)" accessibilityLabel="Interior / studio name" style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md }} testID="lead-interior-company" />
        <Button label={adding ? "Adding…" : "Add and select"} disabled={adding || !name.trim() || !validPhone(phone)} onPress={add} />
        </> : null}
      </ScrollView>
    </Sheet>
  </View>;
}
