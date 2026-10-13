import { useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { leadsApi, type LeadAssignee, type LeadScope } from "@/src/api/leads";
import { Alert, Button, Chip, TextField } from "@/src/components/ui";
import { ReferrerField } from "@/src/components/customer/ReferrerField";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { spacing, type } from "@/src/theme/tokens";

export type LeadPartner = { id: string; name: string; company?: string | null; type: "architect" | "interior_designer" } | null;
/** The server returns eligible workers for each floor, including area grants. */
export function LeadScopeFields({ value, onChange, partner, onPartnerChange, reference = true, requiredFloorId, converted = false, sourceId, customerId, customerPhone, sourceFloorId }: {
  value: LeadScope; onChange: (value: LeadScope) => void; partner?: LeadPartner;
  onPartnerChange?: (partner: LeadPartner) => void; reference?: boolean; requiredFloorId?: string; converted?: boolean; sourceId?: string; customerId?: string; customerPhone?: string; sourceFloorId?: string;
}) {
  const { floors } = useFloorAccess();
  const [workers, setWorkers] = useState<LeadAssignee[]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const floorKey = [...value.interested_floor_ids].sort().join(",");
  useEffect(() => {
    let active = true;
    setWorkers([]); setError(false);
    if (!floorKey) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      void leadsApi.assignees(floorKey.split(","), converted, sourceId, customerId, customerPhone, sourceFloorId).then(rows => { if (active) setWorkers(rows); })
        .catch(() => { if (active) setError(true); })
        .finally(() => { if (active) setLoading(false); });
    }, customerPhone && !sourceId && !customerId ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [floorKey, retry, converted, sourceId, customerId, customerPhone, sourceFloorId]);
  const changeFloors = (ids: string[]) => {
    const selected = requiredFloorId && !ids.includes(requiredFloorId) ? [requiredFloorId, ...ids] : ids;
    onChange({ ...value, interested_floor_ids: selected, assignments: value.assignments.filter(a => selected.includes(a.floor_id)) });
  };
  return <View style={{ gap: spacing.md }}>
    <Text style={type.label}>Interested floors *</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      <Chip label="Select all floors" active={floors.length > 0 && floors.every(f => value.interested_floor_ids.includes(f.id))} onPress={() => changeFloors(floors.map(f => f.id))} testID="lead-floors-all" />
      {floors.map(f => <Chip key={f.id} label={f.name} active={value.interested_floor_ids.includes(f.id)} testID={`lead-floor-${f.id}`} onPress={() => changeFloors(value.interested_floor_ids.includes(f.id) ? value.interested_floor_ids.filter(id => id !== f.id) : [...value.interested_floor_ids, f.id])} />)}
    </View>
    <Text style={type.label}>Assign team members by floor</Text>
    {loading ? <Text style={type.caption}>Loading eligible team members…</Text> : null}
    {error ? <Alert tone="error" title="Could not load eligible team members" action={<Button label="Retry" variant="secondary" onPress={() => setRetry(n => n + 1)} />} /> : null}
    {!loading && !error ? value.interested_floor_ids.map(floorId => <View key={floorId} style={{ gap: spacing.sm }}>
      <Text style={type.bodyStrong}>{floors.find(f => f.id === floorId)?.name || floorId}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {workers.filter(w => w.floor_ids.includes(floorId)).map(w => {
          const selected = value.assignments.some(a => a.floor_id === floorId && a.user_id === w.id);
          return <Chip key={w.id} label={w.full_name} active={selected} testID={`lead-assign-${floorId}-${w.id}`} onPress={() => onChange({ ...value, assignments: selected ? value.assignments.filter(a => a.floor_id !== floorId || a.user_id !== w.id) : [...value.assignments, { floor_id: floorId, user_id: w.id, user_name: w.full_name }] })} />;
        })}
      </View>
      {!workers.some(w => w.floor_ids.includes(floorId)) ? <Text style={type.caption}>No eligible team members on this floor.</Text> : null}
    </View>) : null}
    {reference ? <TextField label="Lead source / reference" value={value.reference_source || ""} onChangeText={reference_source => onChange({ ...value, reference_source })} placeholder="Walk-in, referral, campaign or reference contact" testID="lead-reference-source" /> : null}
    {onPartnerChange ? <ReferrerField value={partner || null} onChange={p => { onPartnerChange(p); onChange({ ...value, referrer_id: p?.id || null }); }} floorId={value.interested_floor_ids[0]} label="Interior designer / architect / studio" /> : null}
  </View>;
}
