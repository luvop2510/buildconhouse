import { ReferrerField } from "@/src/components/customer/ReferrerField";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import { useState } from "react";
import { View } from "react-native";
import { KitchenButton as Button, KitchenTextField as TextField } from "./KitchenPrimitives";
import type { KitchenLead } from "@/src/api/kitchenProjects";
import { KitchenDateField } from "./KitchenFilters";
import { Choice } from "./shared";
import { spacing } from "@/src/theme/tokens";
const leadStatuses = ["New", "Contacted", "Qualified", "Lost"] as const;
export function LeadFields({ value, onChange, disabled, prefix = "kitchen-lead" }: { value: KitchenLead; onChange: (lead: KitchenLead) => void; disabled?: boolean; prefix?: string }) {
  const [showDetails, setShowDetails] = useState(Boolean(value.lead_source || value.kitchen_type || value.budget || value.notes));
  return <View style={{ gap: 24 }}>
    <TextField label="Site location (required)" value={value.site_location || ""} onChangeText={site_location => onChange({ ...value, site_location })} editable={!disabled} testID={`${prefix}-site_location`} />
    <KitchenDateField label="Lead date" value={value.lead_date || ""} onChange={lead_date => onChange({ ...value, lead_date: lead_date || null })} disabled={disabled} testID={`${prefix}-date`} />
    <ReferrerField label="Reference · architect / interior designer" floorId={KITCHEN_FLOOR_ID} disabled={disabled} allowCreate={!disabled} value={value.referrer_id && value.referrer_type ? { id: value.referrer_id, name: value.referrer_name || "", type: value.referrer_type, company: value.referrer_company } : null} onChange={referrer => onChange({ ...value, referrer_id: referrer?.id || null, referrer_name: referrer?.name || null, referrer_type: referrer?.type || null, referrer_company: referrer?.company || null })} />
    <Choice label="Lead status" value={value.status} values={leadStatuses} onChange={status => onChange({ ...value, status })} disabled={disabled} testID={`${prefix}-status`} />
    {value.status === "Lost" ? <TextField label="Lost reason (required)" value={value.lost_reason || ""} onChangeText={lost_reason => onChange({ ...value, lost_reason })} editable={!disabled} multiline testID={`${prefix}-lost-reason`} /> : null}
    <Button label={showDetails ? "Hide enquiry details" : "Add enquiry details"} variant="secondary" onPress={() => setShowDetails(value => !value)} testID={`${prefix}-details-toggle`} />
    <View style={{ gap: spacing.md, display: showDetails ? "flex" : "none" }}>
    <TextField label="Lead source" placeholder="Instagram, referral, showroom walk-in" value={value.lead_source || ""} onChangeText={lead_source => onChange({ ...value, lead_source })} editable={!disabled} testID={`${prefix}-source`} />
    <Choice label="Kitchen type" value={value.kitchen_type || ""} values={["", "New kitchen", "Renovation", "Other"]} onChange={kitchen_type => onChange({ ...value, kitchen_type: kitchen_type || null })} disabled={disabled} testID={`${prefix}-type`} />
    <TextField label="Budget (INR)" placeholder="e.g. 250000.00" value={value.budget || ""} onChangeText={budget => onChange({ ...value, budget: budget || null })} editable={!disabled} keyboardType="decimal-pad" testID={`${prefix}-budget`} />
    <TextField label="Lead notes" value={value.notes || ""} onChangeText={notes => onChange({ ...value, notes })} editable={!disabled} multiline testID={`${prefix}-notes`} />
    </View>
  </View>;
}
