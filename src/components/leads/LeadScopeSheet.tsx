import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { leadsApi, type LeadScope } from "@/src/api/leads";
import { Alert, Button, Sheet } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { LeadScopeFields, type LeadPartner } from "./LeadScopeFields";
import { spacing } from "@/src/theme/tokens";

type Lead = Partial<LeadScope> & { id: string; customer_name: string; floor_id?: string; is_converted?: boolean; referrer_name?: string | null; referrer_type?: "architect" | "interior_designer" | null };
export function LeadScopeSheet({ lead, floorId, onClose, onSaved, leadIds, saveScope }: { lead: Lead | null; floorId: string; onClose: () => void; onSaved: () => void; leadIds?: string[]; saveScope?: (value: LeadScope) => Promise<unknown> }) {
  const [value, setValue] = useState<LeadScope>({ interested_floor_ids: [], assignments: [] });
  const [partner, setPartner] = useState<LeadPartner>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!lead) return;
    setValue({ interested_floor_ids: lead.interested_floor_ids?.length ? lead.interested_floor_ids : [lead.floor_id || floorId], assignments: lead.assignments || [], reference_source: lead.reference_source, referrer_id: lead.referrer_id });
    setPartner(lead.referrer_id && lead.referrer_type ? { id: lead.referrer_id, name: lead.referrer_name || "", type: lead.referrer_type } : null);
    setError(null);
  }, [lead, floorId]);
  const save = async () => {
    if (!lead || saving || !value.interested_floor_ids.length) return;
    setSaving(true); setError(null);
    try { if (saveScope) { await saveScope(value); }
      else if (!leadIds?.length) { await leadsApi.interests(lead.id, value, floorId); }
      else {
        const failed: { id: string; detail: string }[] = [];
        for (const id of leadIds) {
          try { await leadsApi.interests(id, { interested_floor_ids: value.interested_floor_ids, assignments: value.assignments }, floorId); }
          catch (cause: any) { failed.push({ id, detail: cause?.detail || cause?.message || "Could not save assignment" }); }
        }
        if (failed.length) { onSaved(); throw new Error(`${failed.length} of ${leadIds.length} assignments failed: ${failed[0].detail}. Your choices are retained; retry to save.`); }
      }
      toast.success("Interested floors and team assignments saved"); onSaved(); onClose(); }
    catch (e: any) { setError(e?.detail || e?.message || "Could not save these assignments"); }
    finally { setSaving(false); }
  };
  return <Sheet visible={!!lead} onClose={onClose} title="Interested floors & team assignment" subtitle={lead?.customer_name} variant="drawer" footer={<Button label="Save assignments" onPress={() => void save()} loading={saving} disabled={!value.interested_floor_ids.length} testID="lead-scope-save" />}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      {error ? <Alert tone="error" title={error} /> : null}
      {lead ? <View><LeadScopeFields value={value} onChange={setValue} converted={lead.is_converted} sourceId={lead.id} sourceFloorId={lead.floor_id || floorId} reference={!leadIds?.length} partner={partner} onPartnerChange={leadIds?.length ? undefined : setPartner} /></View> : null}
    </ScrollView>
  </Sheet>;
}
