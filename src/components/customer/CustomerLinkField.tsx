import { formatPhone } from "@/src/utils/phone";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Button, SearchField, Sheet } from "@/src/components/ui";
import { spacing, type } from "@/src/theme/tokens";

type Customer = { id: string; name: string; phone?: string | null };
export function CustomerLinkField({ value, floorId, onChange }: {
  value?: string | null; floorId: string; onChange: (customer: Customer | null) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]), [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(false); setLoading(true); setCustomers([]);
    void api.get<Customer[]>("/customers", { floorId }).then(rows => { if (active) setCustomers(rows); })
      .catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, floorId, attempt]);
  const filtered = useMemo(() => customers.filter(row => `${row.name} ${row.phone || ""}`.toLowerCase().includes(query.toLowerCase())), [customers, query]);
  return <View style={{ gap: spacing.sm }}>
    <Button label={value ? "Change linked customer" : "Link customer profile"} variant="secondary" onPress={() => { setQuery(""); setOpen(true); }} />
    <Text style={type.caption}>{value ? "Linked to a customer profile for unified history and data deletion." : "Link the profile so this ledger appears in customer-wide data deletion."}</Text>
    <Sheet visible={open} title="Link customer profile" onClose={() => setOpen(false)} scroll width={520}>
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search customer name or phone" />
        {loading ? <Text style={type.body}>Loading customers…</Text> : null}
        {error ? <Button label="Retry loading customers" onPress={() => setAttempt(current => current + 1)} /> : null}
        {!loading && !error && !filtered.length ? <Text style={type.body}>No matching customer profiles.</Text> : null}
        {filtered.map(row => <Button key={row.id} label={`${row.name}${row.phone ? ` · ${formatPhone(row.phone)}` : ""}`} variant="secondary" onPress={() => { onChange(row); setOpen(false); }} />)}
        {value ? <Button label="Remove profile link" variant="ghost" onPress={() => { onChange(null); setOpen(false); }} /> : null}
      </View>
    </Sheet>
  </View>;
}
