import { useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import type { KitchenProject, KitchenVersion } from "@/src/api/kitchenProjects";
import type { StageCommand } from "./CommercialStages";
import { Choice, KitchenPanel, KitchenDetails } from "./shared";
import { KitchenSelect, KitchenDateField } from "./KitchenFilters";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { kitchenProductionStarted } from "./KitchenVersions";
import { KitchenButton as Button, KitchenTextField as TextField, kitchenType as type } from "./KitchenPrimitives";
import { spacing } from "@/src/theme/tokens";

export function QuotationStage({ project, disabled, command }: { project: KitchenProject; disabled: boolean; command: StageCommand }) {
  const [designId, setDesignId] = useState<string>();
  const [revisionId, setRevisionId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const designs = project.design_versions || [];
  const design = designs.find(row => row.id === designId) || designs.at(-1);
  const revisions = (project.quotation_versions || []).filter(row => row.design_version_id === design?.id);
  const quote = creating ? undefined : revisions.find(row => row.id === revisionId) || revisions.at(-1);
  const next = Math.max(0, ...(project.quotation_versions || []).map(row => row.number)) + 1;
  const active = project.stage === "quotation";
  const requirement = !design ? "Save a design in Design first." : (design.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1) || project.design_revision_pending ? "Choose an approved design from the current work cycle." : design.response !== "Approved" || !design.handoff_date ? "Record customer approval and company handoff in Design first." : null;
  return <KitchenPanel title="Company quotation">
    <KitchenSelect label="Design version" value={design?.id || ""} options={designs.map(row => ({ value: row.id, label: `Design v${row.number} · ${row.response}` }))} onChange={value => { setDesignId(value); setRevisionId(undefined); setCreating(false); }} testID="kitchen-quotation-design-version" />
    {revisions.length ? <KitchenSelect label="Quotation revision" value={quote?.id || ""} options={[...(creating ? [{ value: "", label: `Quotation r${next} · Unsaved` }] : []), ...revisions.map(row => ({ value: row.id, label: `Quotation r${row.number} · ${row.response}` }))]} onChange={value => { setRevisionId(value); setCreating(!value); }} testID="kitchen-quotation-revision" /> : null}
    <Text style={type.bodyStrong}>{`Quotation r${quote?.number || next} · Design v${design?.number || "not selected"}${!quote ? " · Unsaved" : ""}`}</Text>
    <Text style={type.caption}>Edit each field, then save. Entering an amount or internal notes does not mark the quotation received or sent. A new revision keeps the previous one.</Text>
    {active && quote ? <Button label={`Create Quotation r${next}`} variant="secondary" disabled={disabled || kitchenProductionStarted(project)} onPress={() => setCreating(true)} testID="kitchen-quotation-new-version" /> : null}
    {creating ? <Button label="Back to saved quotation" variant="secondary" onPress={() => setCreating(false)} /> : null}
    {requirement ? <View style={{ gap: spacing.sm }}><Text style={type.bodyMuted}>{requirement}</Text>{active ? <Button label="Go to Design" variant="secondary" disabled={disabled} onPress={() => command("move_stage", { target_stage: "design" })} testID="kitchen-complete-design" /> : null}</View> : null}
    <QuotationForm key={`${design?.id || "none"}.${quote?.id || "new"}`} project={project} quote={quote} designId={design?.id} handoffDate={design?.handoff_date || undefined} canSave={!requirement} disabled={disabled || !active || Boolean(quote && design && (design.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1)) || kitchenProductionStarted(project)} command={command} onCreated={() => { setRevisionId(undefined); setCreating(false); }} />
    {quote?.attachment_id ? <KitchenDetails items={[{ label: "Historical document", value: project.attachments?.find(row => row.id === quote.attachment_id)?.filename || "Saved project attachment" }]} /> : null}
    {quote?.response_notes ? <KitchenDetails items={[{ label: "Historical internal response notes", value: quote.response_notes }]} /> : null}
  </KitchenPanel>;
}
function QuotationForm({ project, quote, designId, handoffDate, canSave, disabled, command, onCreated }: { handoffDate?: string; canSave: boolean; project: KitchenProject; quote?: KitchenVersion; designId?: string; disabled: boolean; command: StageCommand; onCreated: () => void }) {
  const prefix = `commercial.cycle.${project.workflow_cycle ?? 1}.quotation.${quote?.id || `new.${designId || "none"}`}.edit`;
  const { resetDraftValue } = useKitchenProject();
  const source = JSON.stringify(quote || null);
  const [draft, setDraft] = useKitchenDraft(prefix, { source, amount: quote?.amount || "", received_status: quote?.received_status || (quote?.received_date ? "Yes" : "Not recorded"), received_date: quote?.received_date || "", sent_status: quote?.sent_status || (quote?.shared_date ? "Yes" : "Not recorded"), shared_date: quote?.shared_date || "", response: quote?.response || "Pending", notes: quote?.notes || "" });
  const update = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const stale = draft.source !== source;
  const locked = disabled || quote?.response === "Approved" && !project.permissions?.can_approve_exceptions;
  const validAmount = !draft.amount.trim() || /^\d+(?:\.\d{1,2})?$/.test(draft.amount.trim()) && draft.amount.trim().length <= 32 && Number(draft.amount) <= 1_000_000_000_000;
  const problem = !validAmount ? "Enter a valid amount, or leave it blank." : draft.received_date && draft.received_status !== "Yes" ? "The received date requires Quotation received to be Yes. Edit either field." : draft.shared_date && draft.sent_status !== "Yes" ? "The sent date requires Quotation sent to customer to be Yes. Edit either field." : draft.response !== "Pending" && (draft.sent_status !== "Yes" || !draft.shared_date) ? "Record sent to customer and its date before a customer response." : draft.shared_date && handoffDate && draft.shared_date < handoffDate ? "The sent date cannot precede design company handoff." : draft.shared_date && draft.received_date && draft.shared_date < draft.received_date ? "The sent date cannot precede the received date." : null;
  return <View style={{ gap: spacing.md }}>
    {stale ? <><Text style={type.bodyMuted}>This quotation changed while you were editing. Your entries are kept.</Text><Button label="Replace draft with latest quotation details" variant="secondary" onPress={() => resetDraftValue(prefix)} testID="kitchen-quotation-edit-reload" /></> : null}
    <Choice label="Quotation received" value={draft.received_status} values={["Not recorded", "Yes", "No"]} onChange={value => update("received_status", value)} disabled={locked} testID="kitchen-quotation-received" />
    <KitchenDateField label="Quotation received date" value={draft.received_date} onChange={value => update("received_date", value)} disabled={locked} testID="kitchen-quotation-date" />
    <TextField label="Quotation amount received (INR, optional)" value={draft.amount} onChangeText={value => update("amount", value)} keyboardType="decimal-pad" editable={!locked} testID="kitchen-quotation-amount" />
    <Choice label="Quotation sent to customer" value={draft.sent_status} values={["Not recorded", "Yes", "No"]} onChange={value => update("sent_status", value)} disabled={locked} testID="kitchen-quotation-sent" />
    <KitchenDateField label="Quotation date sent to customer" value={draft.shared_date} onChange={value => update("shared_date", value)} disabled={locked} testID="kitchen-quotation-shared-date" />
    {draft.response === "Rejected" ? <Text style={type.caption}>Saved customer response: Rejected. Select a choice to change it.</Text> : null}
    <Choice label="Customer response" value={draft.response} values={["Pending", "Approved", "Changes Required"]} onChange={value => update("response", value)} disabled={locked} testID="kitchen-version-response" />
    <TextField label="Internal notes" value={draft.notes} onChangeText={value => update("notes", value)} editable={!locked} multiline testID="kitchen-quotation-notes" />
    {problem ? <Text accessibilityRole="alert" style={type.bodyMuted}>{problem}</Text> : null}
    {quote?.response === "Approved" && !project.permissions?.can_approve_exceptions ? <Text style={type.caption}>Only the owner can correct an approved quotation.</Text> : null}
    {project.stage === "quotation" ? <Button label="Save quotation details" disabled={locked || stale || !canSave || !designId || Boolean(problem)} onPress={async () => { const { source: _source, ...fields } = draft; const saved = await command(quote ? "quotation_update" : "quotation_receive", { ...fields, design_version_id: designId, ...(quote ? { version_id: quote.id } : {}), amount: draft.amount.trim() || null, received_date: draft.received_date || null, shared_date: draft.shared_date || null, notes: draft.notes || null }); if (saved && !quote) onCreated(); }} testID={quote ? "kitchen-quotation-edit-save" : "kitchen-quotation-receive"} /> : null}
  </View>;
}
