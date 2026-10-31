import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { BottomSheet } from "@/src/components/BottomSheet";
import { Button, TextField } from "@/src/components/ds";
import { Text } from "@/src/components/AppText";
import { api } from "@/src/api/client";
import type { Customer } from "@/src/components/quotation/helpers/types";
import { type } from "@/src/theme/tokens";

type Source = { source_kind: "customer" | "walkin" | "followup"; source_id: string; name: string; phone: string; address?: string; floor_id: string };
export function ExistingTileCustomer({ onPick, onLookupActive }: { onPick: (customer: Customer) => void; onLookupActive: (active: boolean, owner: object) => void }) {
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const [rows, setRows] = useState<Source[]>([]), [more, setMore] = useState(false), [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const owner = useRef({}).current, generation = useRef(0), selecting = useRef(false);
  useEffect(() => { onLookupActive(open, owner); return () => onLookupActive(false, owner); }, [open, owner, onLookupActive]);
  useEffect(() => {
    const current = ++generation.current;
    if (!open) return;
    const controller = new AbortController(); setBusy(true); setError(""); setRows([]);
    const timer = setTimeout(() => {
      void api.get<{items: Source[]; has_more: boolean}>(`/quotations/customer-sources?search=${encodeURIComponent(search)}&skip=${offset}&limit=20`, { floorId: "ground-floor", signal: controller.signal, cacheMs: 0 })
        .then(result => { if (generation.current === current) { setRows(result.items); setMore(result.has_more); } })
        .catch(e => { if (!controller.signal.aborted && generation.current === current) setError(e?.detail || "Could not find existing people. Try again."); })
        .finally(() => { if (generation.current === current) setBusy(false); });
    }, 200);
    const invalidate = () => { generation.current++; };
    return () => { controller.abort(); clearTimeout(timer); invalidate(); };
  }, [open, search, offset, attempt]);
  const choose = async (source: Source) => {
    if (selecting.current) return;
    selecting.current = true; const current = generation.current; setBusy(true); setError("");
    try {
      const result = await api.post<{customer: Customer}>("/quotations/customer-sources/reuse", { source_kind: source.source_kind, source_id: source.source_id }, { floorId: "ground-floor" });
      if (generation.current === current) { onPick(result.customer); setOpen(false); }
    } catch (e: any) { if (generation.current === current) setError(e?.detail || "Could not use this person. Try again."); }
    finally { selecting.current = false; if (generation.current === current) setBusy(false); }
  };
  return <>
    <Button label="Existing customer" variant="secondary" size="sm" testID="tiles-existing-customer" onPress={() => { setOffset(0); setOpen(true); }} />
    <BottomSheet visible={open} onClose={() => { if (!selecting.current) setOpen(false); }} title="Existing customer">
      <View style={{ gap: 12 }}>
        <Text style={type.bodyMuted}>Choose from customers, walk-ins and follow-ups on your permitted floors.</Text>
        <TextField label="Search name or phone" value={search} onChangeText={value => { setOffset(0); setSearch(value); }} testID="tiles-existing-search" editable={!selecting.current} />
        {error ? <Text accessibilityRole="alert" style={type.body}>{error}</Text> : null}
        {error ? <Button label="Retry" onPress={() => setAttempt(n => n + 1)} /> : null}
        <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 360 }}>
          {rows.map(row => <View key={`${row.source_kind}:${row.source_id}`} style={{ gap: 4, paddingVertical: 8 }}>
            <Text style={type.bodyStrong}>{row.name}</Text><Text style={type.caption}>{[row.phone, row.address, row.floor_id, row.source_kind].filter(Boolean).join(" · ")}</Text>
            <Button label={`Use ${row.name}`} disabled={busy} onPress={() => void choose(row)} testID={`tiles-existing-${row.source_kind}-${row.source_id}`} />
          </View>)}
        </ScrollView>
        {!busy && !rows.length && !error ? <Text style={type.bodyMuted}>No matching people.</Text> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          {offset > 0 ? <Button label="Previous" disabled={busy} onPress={() => setOffset(n => Math.max(0, n - 20))} /> : null}
          {more ? <Button label="Next" disabled={busy} onPress={() => setOffset(n => n + 20)} /> : null}
        </View>
      </View>
    </BottomSheet>
  </>;
}
