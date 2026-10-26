import { useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import type { KitchenProject, KitchenVersion } from "@/src/api/kitchenProjects";
import type { StageCommand } from "./CommercialStages";
import { Choice, KitchenPanel, KitchenDetails } from "./shared";
import { KitchenSelect, KitchenDateField } from "./KitchenFilters";
import { kitchenToday } from "./KitchenDates";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { kitchenProductionStarted } from "./KitchenVersions";
import { KitchenButton as Button, KitchenTextField as TextField, kitchenType as type } from "./KitchenPrimitives";
import { spacing } from "@/src/theme/tokens";

export function QuotationStage({ project, disabled, command }: { project: KitchenProject; disabled: boolean; command: StageCommand }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [newDesignId, setNewDesignId] = useState<string>();
  const versions = project.quotation_versions || [];
  const quote = creating ? undefined : versions.find(row => row.id === selectedId) || versions.at(-1);
  const next = Math.max(0, ...versions.map(row => row.number)) + 1;
  const active = project.stage === "quotation";
  const currentDesigns = (project.design_versions || []).filter(row => (row.workflow_cycle ?? 1) === (project.workflow_cycle ?? 1));
  const sourceDesign = currentDesigns.find(row => row.id === quote?.design_version_id) || currentDesigns.at(-1);
  const newDesign = newDesignId || sourceDesign?.id;
  return <KitchenPanel>
    {versions.length ? <KitchenSelect label="Saved quotation" value={quote?.id || ""} options={[...(creating ? [{ value: "", label: `New quotation ${next} · Unsaved` }] : []), ...versions.map(row => ({ value: row.id, label: `Quotation ${row.number} · ${row.response}` }))]} onChange={value => { setSelectedId(value); setCreating(!value); }} testID="kitchen-quotation-revision" /> : null}
    <Text style={type.bodyStrong}>{quote ? `Quotation ${quote.number}` : `New quotation ${next} · Unsaved`}</Text>
    <Text style={type.caption}>Each quotation belongs to one design version. A design can have multiple quotations.</Text>
    {active ? <Button label="New quotation" variant="secondary" disabled={disabled || kitchenProductionStarted(project)} onPress={() => { setNewDesignId(sourceDesign?.id); setCreating(true); }} testID="kitchen-quotation-new-version" /> : null}
    {creating && versions.length ? <Button label="Back to saved quotation" variant="secondary" onPress={() => setCreating(false)} testID="kitchen-quotation-cancel-new" /> : null}
    <QuotationForm key={quote?.id || "new"} project={project} quote={quote} initialDesignId={newDesign} disabled={disabled || !active || kitchenProductionStarted(project)} command={command} onCreated={() => { setSelectedId(undefined); setCreating(false); }} />
    {quote?.attachment_id ? <KitchenDetails items={[{ label: "Historical document", value: project.attachments?.find(row => row.id === quote.attachment_id)?.filename || "Saved project attachment" }]} /> : null}
    {quote?.response_notes ? <KitchenDetails items={[{ label: "Historical internal response notes", value: quote.response_notes }]} /> : null}
  </KitchenPanel>;
}
function QuotationForm({ project, quote, initialDesignId, disabled, command, onCreated }: { project: KitchenProject; quote?: KitchenVersion; initialDesignId?: string; disabled: boolean; command: StageCommand; onCreated: () => void }) {
  const prefix = `commercial.cycle.${project.workflow_cycle ?? 1}.quotation.${quote?.id || "new"}.edit`;
  const { resetDraftValue } = useKitchenProject();
  const source = JSON.stringify(quote || null);
  const savedDesign = project.design_versions?.find(row => row.id === quote?.design_version_id);
  const savedHistorical = Boolean(savedDesign && (savedDesign.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const locked = disabled || Boolean(quote && savedHistorical) || quote?.response === "Approved" && !project.permissions?.can_approve_exceptions;
  const defaultDate = locked ? "" : kitchenToday();
  const [draft, setDraft] = useKitchenDraft(prefix, { source, design_version_id: quote?.design_version_id || initialDesignId || "", amount: quote?.amount || "", received_status: quote?.received_status || (quote?.received_date ? "Yes" : "Not recorded"), received_date: quote?.received_date || defaultDate, sent_status: quote?.sent_status || (quote?.shared_date ? "Yes" : "Not recorded"), shared_date: quote?.shared_date || defaultDate, response: quote?.response || "Pending", notes: quote?.notes || "" });
  const update = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const design = project.design_versions?.find(row => row.id === draft.design_version_id);
  const historical = Boolean(design && (design.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const requirement = !design ? "Save a design in Design first." : historical || project.design_revision_pending ? "Choose an approved design from the current work cycle." : design.response !== "Approved" || !design.handoff_date ? "Record customer approval and company handoff in Design first." : null;

  const boundOrder = Boolean(quote && project.orders?.some(row => row.quotation_version_id === quote.id && !row.authorization_invalidated) && !project.commercial_basis_invalidated);
  const stale = draft.source !== source || Boolean(boundOrder && draft.design_version_id !== quote?.design_version_id);
  const displayedDesign = boundOrder ? project.design_versions?.find(row => row.id === quote?.design_version_id) : design;
  const validAmount = !draft.amount.trim() || /^\d+(?:\.\d{1,2})?$/.test(draft.amount.trim()) && draft.amount.trim().length <= 32 && Number(draft.amount) <= 1_000_000_000_000;
  // Calendar defaults are proposed dates. Only explicit Yes records receipt/sharing.
  const receivedDate = draft.received_status === "Yes" ? draft.received_date : "";
  const sharedDate = draft.sent_status === "Yes" ? draft.shared_date : "";
  const problem = !validAmount ? "Enter a valid amount, or leave it blank." : draft.response !== "Pending" && (draft.sent_status !== "Yes" || !sharedDate) ? "Record sent to customer and its date before a customer response." : receivedDate && design?.handoff_date && receivedDate < design.handoff_date ? "The received date cannot precede design company handoff." : sharedDate && design?.handoff_date && sharedDate < design.handoff_date ? "The sent date cannot precede design company handoff." : sharedDate && receivedDate && sharedDate < receivedDate ? "The sent date cannot precede the received date." : null;
  return <View style={{ gap: spacing.md }}>
    {!locked && !boundOrder ? <KitchenSelect label="Related design" value={draft.design_version_id} options={[{ value: "", label: "Choose a design version" }, ...(project.design_versions || []).map(row => ({ value: row.id, label: `Design v${row.number} · ${row.response}` }))]} onChange={value => update("design_version_id", value)} testID="kitchen-quotation-design-version" /> : <KitchenDetails items={[{ label: "Related design", value: displayedDesign ? `Design v${displayedDesign.number}` : "Not recorded" }]} />}
    {boundOrder ? <Text style={type.caption}>This quotation is used by an order. To change its design, select a different quotation in Order.</Text> : null}
    {requirement ? <View style={{ gap: spacing.sm }}><Text style={type.bodyMuted}>{requirement}</Text>{project.stage === "quotation" ? <Button label="Go to Design" variant="secondary" disabled={disabled} onPress={() => command("move_stage", { target_stage: "design" })} testID="kitchen-complete-design" /> : null}</View> : null}
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
    {project.stage === "quotation" ? <Button label={quote ? "Save quotation details" : "Save new quotation"} disabled={locked || stale || Boolean(requirement) || Boolean(problem)} onPress={async () => { const { source: _source, ...fields } = draft; const saved = await command(quote ? "quotation_update" : "quotation_receive", { ...fields, ...(quote ? { version_id: quote.id } : {}), amount: draft.amount.trim() || null, received_date: receivedDate || null, shared_date: sharedDate || null, notes: draft.notes || null }); if (saved && !quote) onCreated(); }} testID={quote ? "kitchen-quotation-edit-save" : "kitchen-quotation-receive"} /> : null}
  </View>;
}
