import { useRef, useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Alert } from "@/src/components/ds";
import type { KitchenProject, KitchenVersion } from "@/src/api/kitchenProjects";
import type { StageCommand } from "./CommercialStages";
import { Choice, KitchenPanel, displayDate } from "./shared";
import { KitchenSelect, KitchenDateField, KitchenOption } from "./KitchenFilters";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { kitchenToday } from "./KitchenDates";
import { KitchenPdfFile, KitchenPdfFiles } from "./KitchenPdfFiles";
import { kitchenDesignApproval, kitchenApprovalDate, kitchenProductionStarted } from "./KitchenVersions";
import { KitchenButton as Button, kitchenType as type } from "./KitchenPrimitives";
import { spacing } from "@/src/theme/tokens";

export function DesignStage({ project, disabled, command }: { project: KitchenProject; disabled: boolean; command: StageCommand }) {
  const [selected, setSelected] = useState<string>();
  const adding = useRef(false);
  const [addingPdf, setAddingPdf] = useState(false);
  const versions = project.design_versions || [];
  const design = versions.find(row => row.id === selected || selected === `file:${row.final_attachment_id}`) || versions.find(row => row.id === project.final_design_version_id) || versions.at(-1);
  const active = project.stage === "design";
  const historical = Boolean(design && (design.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const started = kitchenProductionStarted(project);
  const locked = disabled || !active || historical || started || Boolean(project.design_revision_pending && design);
  const usedIds = versions.flatMap(row => row.attachment_ids || (row.attachment_id ? [row.attachment_id] : []));
  const addPdf = async (id: string) => {
    if (adding.current) return;
    adding.current = true; setAddingPdf(true);
    try {
      const saved = await command("design_present", { attachment_ids: [id], final_attachment_id: id, handoff_status: "No" });
      if (saved) setSelected(`file:${id}`);
    } finally { adding.current = false; setAddingPdf(false); }
  };
  return <KitchenPanel>
    <Text style={type.caption}>Each uploaded PDF creates one numbered design. Choose the customer’s approved design, finalize it and record Yes for Sent to company.</Text>
    <KitchenPdfFiles project={project} attachmentIds={[]} finalId="" onAdd={addPdf} onSelect={() => {}} excludedIds={usedIds} disabled={disabled || !active || started || addingPdf} label="Design" testID="kitchen-design-pdf" draftKey={`commercial.cycle.${project.workflow_cycle ?? 1}.design.upload`} />
    {versions.length ? <KitchenSelect label="Design" value={design?.id || ""} options={versions.map(row => ({ value: row.id, label: `Design ${row.number} · ${row.response}${row.id === project.final_design_version_id ? " · Finalize PDF" : ""}` }))} onChange={setSelected} testID="kitchen-design-version" /> : <Text style={type.bodyMuted}>Upload a PDF to add Design 1.</Text>}
    {started ? <Alert tone="info" title="Production has started" description="Use the owner-authorized Return to Design action to change the design for production." /> : null}
    {project.design_revision_pending && design ? <Text style={type.bodyMuted}>Upload the revised design PDF. Earlier designs remain in History.</Text> : null}
    {historical ? <Text style={type.bodyMuted}>This design belongs to an earlier work cycle. Its details are preserved.</Text> : null}
    {design ? <DesignForm key={design.id} project={project} design={design} disabled={locked || addingPdf} command={command} /> : null}
    <Text testID="kitchen-design-edit-revisions" style={type.caption}>Customer-requested revisions: {project.design_revision_count ?? project.known_design_revision_count ?? "Unknown"} · counted from revision requests</Text>
    {design ? <Text style={type.caption}>Linked quotations: {(project.quotation_versions || []).filter(row => row.design_version_id === design.id).map(row => `Quotation ${row.number} · ${row.response}`).join("; ") || "None"}</Text> : null}
  </KitchenPanel>;
}
function DesignForm({ project, design, disabled, command }: { project: KitchenProject; design: KitchenVersion; disabled: boolean; command: StageCommand }) {
  const prefix = `commercial.cycle.${project.workflow_cycle ?? 1}.design.${design.id}.edit`;
  const { resetDraftValue, documentSubmission } = useKitchenProject();
  const source = JSON.stringify([design, project.final_design_version_id ?? null]);
  const locked = disabled || design.response === "Approved" && !project.permissions?.can_approve_exceptions;
  const defaultDate = locked ? "" : kitchenToday();
  const initial = { source, finalize: project.final_design_version_id === design.id, shared_date: design.shared_date || defaultDate, response: design.response || "Pending", approval_date: design.approval_date || (design.response === "Approved" ? defaultDate : ""), handoff_status: design.handoff_status === "No" ? "No" : design.handoff_status === "Yes" || design.handoff_date ? "Yes" : "No" };
  const [draft, setDraft] = useKitchenDraft(prefix, initial);
  const update = (key: "shared_date" | "approval_date", value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const stale = draft.source !== source;
  const recorded = kitchenApprovalDate(kitchenDesignApproval(project, design)?.at);
  const approval = draft.approval_date || (draft.response === "Approved" ? recorded : undefined);
  const fileId = design.final_attachment_id || design.attachment_id;
  const file = project.attachments?.find(row => row.id === fileId && row.content_type === "application/pdf");
  const problem = !file ? "This historical design has no uploaded PDF. Upload a new design PDF." : draft.response !== "Pending" && !draft.shared_date ? "Enter Date shared with customer before recording the customer’s response." : draft.approval_date && draft.response !== "Approved" ? "Clear the approval date when customer approval is not Approved." : draft.approval_date && draft.shared_date && draft.approval_date < draft.shared_date ? "Customer approval cannot precede sharing." : draft.handoff_status === "Yes" && (draft.response !== "Approved" || !approval) ? "Customer approval is required before sending the finalized design to the company." : draft.finalize && (draft.response !== "Approved" || draft.handoff_status !== "Yes") ? "Approve this design and choose Yes for Sent to company before finalizing it." : null;
  return <View style={{ gap: spacing.md }}>
    <Text style={type.bodyStrong}>Design {design.number}</Text>
    {stale ? <><Text style={type.bodyMuted}>Saved details changed while you were editing. Your entries are kept.</Text><Button label="Replace draft with latest design details" onPress={() => resetDraftValue(prefix)} variant="secondary" testID="kitchen-design-edit-reload" /></> : null}
    {file ? <KitchenPdfFile project={project} file={file} selected={project.final_design_version_id === design.id} testID={`kitchen-design-pdf-${file.id}`} /> : null}
    <KitchenOption label={draft.finalize ? "Finalize design · Selected" : "Finalize design"} accessibilityLabel={`Finalize Design ${design.number}`} active={draft.finalize} disabled={locked} onPress={() => setDraft(previous => ({ ...previous, finalize: !previous.finalize }))} testID="kitchen-design-finalize" />
    <KitchenDateField defaultToToday label="Date shared with customer" value={draft.shared_date} onChange={value => update("shared_date", value)} disabled={locked} testID="kitchen-design-edit-shared" />
    <Choice label="Customer approval" value={draft.response} values={["Pending", "Approved", "Changes Required"]} onChange={value => setDraft(previous => ({ ...previous, response: value, approval_date: value === "Approved" ? previous.approval_date || kitchenToday() : "" }))} disabled={locked} testID="kitchen-design-edit-response" />
    {draft.response === "Approved" ? <KitchenDateField defaultToToday label="Customer approval date" value={draft.approval_date} onChange={value => update("approval_date", value)} min={draft.shared_date || undefined} disabled={locked} testID="kitchen-design-edit-approval-date" /> : null}
    {design.response === "Approved" && !design.approval_date ? <Text style={type.caption}>Actual approval date not entered. {recorded ? `Approval was recorded on ${displayDate(recorded)}.` : "Historical approval date is unknown."} Existing dates are preserved.</Text> : null}
    <Choice label="Sent to company" value={draft.handoff_status} values={["Yes", "No"]} onChange={value => setDraft(previous => ({ ...previous, handoff_status: value }))} disabled={locked} testID="kitchen-design-sent" />
    {problem ? <Text accessibilityRole="alert" style={type.bodyMuted}>{problem}</Text> : null}
    {project.stage === "design" ? <Button label="Save design details" disabled={locked || documentSubmission.busy || stale || Boolean(problem)} onPress={() => { const { source: _source, ...fields } = draft; return command("design_update", { ...fields, version_id: design.id, shared_date: draft.shared_date || null, approval_date: draft.approval_date || null, ...(draft.handoff_status === "No" ? { handoff_date: null } : {}), reason: "Updated selected design" }); }} testID="kitchen-design-edit-save" /> : null}
  </View>;
}
