import { useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Alert } from "@/src/components/ds";
import type { KitchenProject, KitchenVersion } from "@/src/api/kitchenProjects";
import type { StageCommand } from "./CommercialStages";
import { Choice, KitchenPanel, KitchenDetails, displayDate } from "./shared";
import { KitchenSelect, KitchenDateField } from "./KitchenFilters";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { DocumentChoice } from "./KitchenDocuments";
import { kitchenDesignApproval, kitchenApprovalDate, kitchenProductionStarted } from "./KitchenVersions";
import { KitchenButton as Button, KitchenTextField as TextField, kitchenType as type } from "./KitchenPrimitives";
import { spacing } from "@/src/theme/tokens";

export function DesignStage({ project, disabled, command }: { project: KitchenProject; disabled: boolean; command: StageCommand }) {
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const versions = project.design_versions || [];
  const design = creating ? undefined : versions.find(row => row.id === selected) || versions.at(-1);
  const nextNumber = Math.max(0, ...versions.map(row => row.number)) + 1;
  const active = project.stage === "design";
  const historical = Boolean(design && (design.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const started = kitchenProductionStarted(project);
  const locked = disabled || !active || historical || started || Boolean(project.design_revision_pending && design);
  return <KitchenPanel title="Design">
    {versions.length ? <KitchenSelect label="Design version" value={design?.id || ""} options={[...(creating ? [{ value: "", label: `Design v${nextNumber} · Unsaved` }] : []), ...versions.map(row => ({ value: row.id, label: `Design v${row.number} · ${row.response}` }))]} onChange={id => { setSelected(id); setCreating(!id); }} testID="kitchen-design-version" /> : null}
    <Text style={type.bodyStrong}>{`Design v${design?.number || nextNumber}${!design ? " · Unsaved" : ""}`}</Text>
    <Text style={type.caption}>The first save creates Design v1. Create the next version when the design changes. Selecting a saved version only opens that version.</Text>
    {active && versions.length && !creating ? <Button label={`Create Design v${nextNumber}`} variant="secondary" disabled={disabled || started || versions.at(-1)?.response === "Approved" && !project.permissions?.can_approve_exceptions} onPress={() => setCreating(true)} testID="kitchen-design-new-version" /> : null}
    {creating ? <Button label="Back to saved design" variant="secondary" onPress={() => setCreating(false)} testID="kitchen-design-cancel-new" /> : null}
    {started ? <Alert tone="info" title="Production has started" description="Use the owner-authorized Return to Design action to change the design for production." /> : null}
    {project.design_revision_pending && design ? <Text style={type.bodyMuted}>Create Design v{nextNumber} for the requested revision. Earlier versions remain in History.</Text> : null}
    {historical ? <Text style={type.bodyMuted}>This design belongs to an earlier work cycle. Its details are preserved.</Text> : null}
    <DesignForm key={design?.id || "new"} project={project} design={design} number={design?.number || nextNumber} disabled={locked} command={command} onCreated={() => { setSelected(undefined); setCreating(false); }} />
    <Text testID="kitchen-design-edit-revisions" style={type.caption}>Customer-requested revisions: {project.design_revision_count ?? project.known_design_revision_count ?? "Unknown"} · counted from revision requests</Text>
    <Text style={type.caption}>Related quotation revisions: {(project.quotation_versions || []).filter(row => row.design_version_id === design?.id).map(row => `r${row.number} · ${row.response}`).join("; ") || "None"}</Text>
    {design?.attachment_id ? <KitchenDetails items={[{ label: "Design document", value: project.attachments?.find(row => row.id === design.attachment_id)?.filename || "Saved project attachment" }]} /> : null}
    {design?.response_notes ? <KitchenDetails items={[{ label: "Historical internal response notes", value: design.response_notes }]} /> : null}
  </KitchenPanel>;
}
function DesignForm({ project, design, number, disabled, command, onCreated }: { project: KitchenProject; design?: KitchenVersion; number: number; disabled: boolean; command: StageCommand; onCreated: () => void }) {
  const prefix = `commercial.cycle.${project.workflow_cycle ?? 1}.design.${design?.id || "new"}.edit`;
  const { resetDraftValue } = useKitchenProject();
  const source = JSON.stringify(design || null);
  const initial = { source, file: "", requirements: design ? design.requirements ?? "" : project.visit.requirements ?? "", budget_discussion: design ? design.budget_discussion ?? "" : project.visit.budget_discussion ?? "", shared_date: design?.shared_date || "", response: design?.response || "Pending", approval_date: design?.approval_date || "", handoff_date: design?.handoff_date || "", notes: design?.notes || "" };
  const [draft, setDraft] = useKitchenDraft(prefix, initial);
  const update = (key: keyof typeof initial, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const stale = draft.source !== source;
  const locked = disabled || design?.response === "Approved" && !project.permissions?.can_approve_exceptions;
  const recorded = kitchenApprovalDate(kitchenDesignApproval(project, design)?.at);
  const approval = draft.approval_date || (draft.response === "Approved" ? recorded : undefined);
  const problem = draft.response !== "Pending" && !draft.shared_date ? "Enter Date shared with customer before recording the customer’s response." : draft.approval_date && draft.response !== "Approved" ? "Clear the approval date when customer approval is not Approved." : draft.approval_date && draft.shared_date && draft.approval_date < draft.shared_date ? "Customer approval cannot precede sharing." : draft.handoff_date && (draft.response !== "Approved" || !approval || draft.handoff_date < approval) ? "Company handoff requires approval and cannot precede its date." : null;
  return <View style={{ gap: spacing.md }}>
    {stale ? <><Text style={type.bodyMuted}>Saved details changed while you were editing. Your entries are kept.</Text><Button label="Replace draft with latest design details" onPress={() => resetDraftValue(prefix)} variant="secondary" testID="kitchen-design-edit-reload" /></> : null}
    <TextField label="Customer requirements" value={draft.requirements} onChangeText={value => update("requirements", value)} editable={!locked} multiline testID="kitchen-design-edit-requirements" />
    <TextField label="Budget discussion" value={draft.budget_discussion} onChangeText={value => update("budget_discussion", value)} editable={!locked} multiline testID="kitchen-design-edit-budget" />
    {!design ? <DocumentChoice project={project} value={draft.file} onChange={value => update("file", value)} disabled={locked} label="Design document (optional)" /> : null}
    <KitchenDateField label="Date shared with customer" value={draft.shared_date} onChange={value => update("shared_date", value)} disabled={locked} testID="kitchen-design-edit-shared" />
    <Choice label="Customer approval" value={draft.response} values={["Pending", "Approved", "Changes Required"]} onChange={value => update("response", value)} disabled={locked} testID="kitchen-design-edit-response" />
    <KitchenDateField label="Customer approval date" value={draft.approval_date} onChange={value => update("approval_date", value)} min={draft.shared_date || undefined} disabled={locked} testID="kitchen-design-edit-approval-date" />
    {design?.response === "Approved" && !design.approval_date ? <Text style={type.caption}>Actual approval date not entered. {recorded ? `Approval was recorded on ${displayDate(recorded)}.` : "Historical approval date is unknown."} Existing dates are preserved.</Text> : null}
    <KitchenDateField label="Date sent to company" value={draft.handoff_date} onChange={value => update("handoff_date", value)} min={approval} disabled={locked} testID="kitchen-design-edit-handoff" />
    <TextField label="Internal notes" value={draft.notes} onChangeText={value => update("notes", value)} editable={!locked} multiline testID="kitchen-design-edit-notes" />
    {problem ? <Text accessibilityRole="alert" style={type.bodyMuted}>{problem}</Text> : null}
    {project.stage === "design" ? <Button label={design ? "Save design details" : `Save Design v${number}`} disabled={locked || stale || Boolean(problem)} onPress={async () => { const { source: _source, file, ...fields } = draft; const saved = await command(design ? "design_update" : "design_present", { ...fields, requirements: draft.requirements || null, budget_discussion: draft.budget_discussion || null, notes: draft.notes || null, shared_date: draft.shared_date || null, approval_date: draft.approval_date || null, handoff_date: draft.handoff_date || null, ...(design ? { version_id: design.id } : { attachment_id: file || null }), reason: draft.notes.trim() || (design ? "Updated design details" : "Created new design version") }); if (saved && !design) onCreated(); }} testID={design ? "kitchen-design-edit-save" : "kitchen-design-present"} /> : null}
  </View>;
}
