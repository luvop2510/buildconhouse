import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import type { KitchenPdfOption, KitchenProject, KitchenVersion } from "@/src/api/kitchenProjects";
import type { StageCommand } from "./CommercialStages";
import { Choice, KitchenPanel, KitchenDetails } from "./shared";
import { KitchenDateField } from "./KitchenFilters";
import { kitchenToday } from "./KitchenDates";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { kitchenProductionStarted, kitchenHasFinalDesign, kitchenApprovalDate } from "./KitchenVersions";
import { KitchenPdfFile, KitchenPdfFiles } from "./KitchenPdfFiles";
import { KitchenButton as Button, kitchenType as type } from "./KitchenPrimitives";
import { spacing } from "@/src/theme/tokens";

export function QuotationStage({ project, disabled, command }: { project: KitchenProject; disabled: boolean; command: StageCommand }) {
  const latest = project.quotation_versions?.at(-1);
  const basis = project.design_versions?.find(row=>row.id===latest?.design_version_id);
  const quote = basis && (basis.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1) ? undefined : latest;
  return <KitchenPanel><QuotationForm key={quote?.id || "new"} project={project} quote={quote} disabled={disabled} command={command} /></KitchenPanel>;
}
function QuotationForm({ project, quote, disabled, command }: { project: KitchenProject; quote?: KitchenVersion; disabled: boolean; command: StageCommand }) {
  const prefix = `commercial.cycle.${project.workflow_cycle ?? 1}.quotation.${quote?.id || "new"}.edit`;
  const { resetDraftValue, documentSubmission } = useKitchenProject();
  const source = JSON.stringify(quote || null);
  const savedDesign = project.design_versions?.find(row => row.id === quote?.design_version_id);
  const savedHistorical = Boolean(savedDesign && (savedDesign.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const boundOrder = Boolean(quote && project.orders?.some(row => row.quotation_version_id === quote.id && !row.authorization_invalidated) && !project.commercial_basis_invalidated);
  const readOnly = project.stage !== "quotation" || Boolean(project.lifecycle_status) || kitchenProductionStarted(project) || savedHistorical || project.permissions?.can_update === false || quote?.response === "Approved" && !project.permissions?.can_approve_exceptions;
  const locked = disabled || readOnly;
  // An upload temporarily disables controls; it must not clear a proposed date.
  const defaultDate = readOnly ? "" : kitchenToday();
  const [draft, setDraft] = useKitchenDraft(prefix, { source, pdf_options: quote?.pdf_options || [] as KitchenPdfOption[], final_attachment_id: quote?.final_attachment_id || "", sent_status: quote?.sent_status === "No" ? "No" : quote?.sent_status === "Yes" || quote?.shared_date ? "Yes" : "No", shared_date: quote?.shared_date || defaultDate, response: quote?.response || "Pending" });
  const update = (key: "sent_status" | "shared_date" | "response", value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  // A working quotation follows the explicit final design. Recorded order chains
  // retain their original IDs until an authorized order change is confirmed.
  const designId = boundOrder || savedHistorical || kitchenProductionStarted(project) ? quote?.design_version_id || "" : project.final_design_version_id || "";
  const design = project.design_versions?.find(row => row.id === designId);
  const historical = Boolean(design && (design.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const requirement = !design ? "Choose the finalized design in Design." : historical || project.design_revision_pending ? "Choose an approved design from the current work cycle." : !kitchenHasFinalDesign(design) ? "Select a finalized design PDF, record customer approval and choose Yes for Sent to company in Design." : null;
  const stale = draft.source !== source;
  const displayedDesign = design;
  const finalizedDesignFile = project.attachments?.find(file => file.id === displayedDesign?.final_attachment_id && file.content_type === "application/pdf");
  const finalOption = draft.pdf_options.find(option => option.attachment_id === draft.final_attachment_id);
  const finalFile = project.attachments?.find(file => file.id === finalOption?.attachment_id && file.content_type === "application/pdf");
  const uploadDate = finalFile?.upload_date || kitchenApprovalDate(finalFile?.uploaded_at) || "";
  const sharedDate = draft.sent_status === "Yes" ? draft.shared_date : "";
  const problem = !draft.pdf_options.length ? "Upload at least one GI, SS or Mix quotation PDF." : !finalOption || !finalFile ? "Select one finalized PDF and its kitchen type." : draft.response !== "Pending" && (draft.sent_status !== "Yes" || !sharedDate) ? "Record sent to customer and its date before a customer response." : sharedDate && design?.handoff_date && sharedDate < design.handoff_date ? "The sent date cannot precede design company handoff." : sharedDate && uploadDate && sharedDate < uploadDate ? "The sent date cannot precede the PDF upload date." : null;
  return <View style={{ gap: spacing.md }}>
    <Text style={type.bodyStrong}>Finalized design{displayedDesign ? ` · Design ${displayedDesign.number}` : ""}</Text>
    {finalizedDesignFile ? <KitchenPdfFile project={project} file={finalizedDesignFile} selected testID="kitchen-quotation-final-design" /> : <Text style={type.bodyMuted}>No finalized design PDF selected.</Text>}
    {quote && !boundOrder && savedDesign?.id !== designId ? <Text style={type.caption}>This quotation was saved against Design {savedDesign?.number ?? "unavailable"}. Saving quotation details applies the current finalized design{design ? `, Design ${design.number}` : ""}.</Text> : null}
    {boundOrder ? <Text style={type.caption}>This finalized quotation is used by an order. Its recorded PDF and kitchen type are preserved.</Text> : null}
    {stale ? <><Text style={type.bodyMuted}>This quotation changed while you were editing. Your entries are kept.</Text><Button label="Replace draft with latest quotation details" variant="secondary" onPress={() => resetDraftValue(prefix)} testID="kitchen-quotation-edit-reload" /></> : null}
    {(["GI", "SS", "Mix"] as const).map(kitchenType => <KitchenPdfFiles key={kitchenType} project={project} attachmentIds={draft.pdf_options.filter(option => option.kitchen_type === kitchenType).map(option => option.attachment_id)} finalId={draft.final_attachment_id} onAdd={id => setDraft(previous => ({ ...previous, pdf_options: [...previous.pdf_options.filter(option => option.attachment_id !== id), { attachment_id: id, kitchen_type: kitchenType }] }))} onSelect={id => setDraft(previous => ({ ...previous, final_attachment_id: id }))} disabled={locked} selectionDisabled={boundOrder} label={kitchenType} testID={`kitchen-quotation-${kitchenType}-pdf`} draftKey={`${prefix}.pdf.${kitchenType}`} />)}
    <KitchenDetails items={[{ label: "Final kitchen type", value: finalOption?.kitchen_type || "Select one finalized PDF" }, { label: "PDF upload date", value: uploadDate || "Recorded automatically on upload" }]} testID="kitchen-quotation-final-selection" />
    <Choice label="Quotation sent to customer" value={draft.sent_status} values={["Yes", "No"]} onChange={value => update("sent_status", value)} disabled={locked} testID="kitchen-quotation-sent" />
    <KitchenDateField label="Quotation date sent to customer" value={draft.shared_date} onChange={value => update("shared_date", value)} disabled={locked} testID="kitchen-quotation-shared-date" />
    {draft.response === "Rejected" ? <Text style={type.caption}>Saved customer response: Rejected. Select a choice to change it.</Text> : null}
    <Choice label="Customer response" value={draft.response} values={["Pending", "Approved", "Changes Required"]} onChange={value => update("response", value)} disabled={locked} testID="kitchen-version-response" />
    {problem ? <Text accessibilityRole="alert" style={type.bodyMuted}>{problem}</Text> : null}
    {quote?.response === "Approved" && !project.permissions?.can_approve_exceptions ? <Text style={type.caption}>Only the owner can correct an approved quotation.</Text> : null}
    {project.stage === "quotation" ? <Button label={"Save quotation details"} disabled={locked || documentSubmission.busy || stale || Boolean(requirement) || Boolean(problem)} onPress={async () => { const { source: _source, ...fields } = draft; await command(quote ? "quotation_update" : "quotation_receive", { ...fields, design_version_id: designId, ...(quote ? { version_id: quote.id } : {}), shared_date: sharedDate || null });  }} testID={quote ? "kitchen-quotation-edit-save" : "kitchen-quotation-receive"} /> : null}
  </View>;
}
