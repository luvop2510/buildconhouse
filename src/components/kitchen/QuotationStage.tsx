import { useRef } from "react";
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
  const [revisionOf, setRevisionOf] = useKitchenDraft<string | null>(`commercial.cycle.${project.workflow_cycle ?? 1}.quotation.revising`, null);
  const seed = revisionOf ? project.quotation_versions?.find(row => row.id === revisionOf) : undefined;
  const revising = Boolean(seed);
  const bound = Boolean(quote && (quote.order_bound || !project.commercial_basis_invalidated && project.orders?.some(row => row.quotation_version_id === quote.id && !row.authorization_invalidated) || project.access_scoped && quote.order_bound === undefined && kitchenProductionStarted(project)));
  const canRevise = Boolean(quote && project.stage === "quotation" && !project.lifecycle_status && project.permissions?.can_update !== false && (bound || quote.response === "Approved" && !project.permissions?.can_approve_exceptions));
  return <KitchenPanel>
    {canRevise && !revising ? <Button label="Edit quotation" variant="secondary" disabled={disabled} onPress={() => setRevisionOf(quote!.id)} testID="kitchen-quotation-revise" /> : null}
    {revising ? <Text style={type.caption}>This creates a revised quotation. It does not change the confirmed order or carry forward customer approval.</Text> : null}
    <QuotationForm key={revising ? `revision-${seed?.id}` : quote?.id || "new"} project={project} quote={revising ? undefined : quote} seed={seed} revision={revising} disabled={disabled} command={command} onRevisionSaved={() => setRevisionOf(null)} />
  </KitchenPanel>;
}
function QuotationForm({ project, quote, seed, revision = false, disabled, command, onRevisionSaved }: { project: KitchenProject; quote?: KitchenVersion; seed?: KitchenVersion; revision?: boolean; disabled: boolean; command: StageCommand; onRevisionSaved: () => void }) {
  const prefix = `commercial.cycle.${project.workflow_cycle ?? 1}.quotation.${revision ? `revision.${seed?.id}` : quote?.id || "new"}.edit`;
  const saving = useRef(false);
  const { resetDraftValue, documentSubmission } = useKitchenProject();
  const source = JSON.stringify(quote || null);
  const savedDesign = project.design_versions?.find(row => row.id === quote?.design_version_id);
  const savedHistorical = Boolean(savedDesign && (savedDesign.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const boundOrder = Boolean(quote && (quote.order_bound || !project.commercial_basis_invalidated && project.orders?.some(row => row.quotation_version_id === quote.id && !row.authorization_invalidated) || project.access_scoped && quote.order_bound === undefined && kitchenProductionStarted(project)));
  const readOnly = project.stage !== "quotation" || Boolean(project.lifecycle_status) || boundOrder && kitchenProductionStarted(project) || savedHistorical || project.permissions?.can_update === false || quote?.response === "Approved" && !project.permissions?.can_approve_exceptions;
  const locked = disabled || readOnly;
  // An upload temporarily disables controls; it must not clear a proposed date.
  const defaultDate = readOnly ? "" : kitchenToday();
  const initial = quote || seed;
  const initialFile = project.attachments?.find(file => file.id === initial?.final_attachment_id);
  const [draft, setDraft] = useKitchenDraft(prefix, { source, pdf_options: initial?.pdf_options || [] as KitchenPdfOption[], final_attachment_id: initial?.final_attachment_id || "", upload_date: initial?.upload_date || initialFile?.upload_date || kitchenApprovalDate(initialFile?.uploaded_at) || "", sent_status: revision ? "No" : quote?.sent_status === "No" ? "No" : quote?.sent_status === "Yes" || quote?.shared_date ? "Yes" : "No", shared_date: revision ? defaultDate : quote?.shared_date || defaultDate, response: revision ? "Pending" : quote?.response || "Pending" });
  const update = (key: "sent_status" | "shared_date" | "response" | "upload_date", value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  // A working quotation follows the explicit final design. Recorded order chains
  // retain their original IDs until an authorized order change is confirmed.
  const designId = boundOrder || savedHistorical ? quote?.design_version_id || "" : project.final_design_version_id || "";
  const design = project.design_versions?.find(row => row.id === designId);
  const historical = Boolean(design && (design.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const requirement = !design ? "Choose the finalized design in Design." : historical || project.design_revision_pending ? "Choose an approved design from the current work cycle." : !kitchenHasFinalDesign(design) ? "Select a finalized design PDF, record customer approval and choose Yes for Sent to company in Design." : null;
  const stale = draft.source !== source;
  const displayedDesign = design;
  const finalizedDesignFile = project.attachments?.find(file => file.id === displayedDesign?.final_attachment_id && file.content_type === "application/pdf");
  const finalOption = draft.pdf_options.find(option => option.attachment_id === draft.final_attachment_id);
  const finalFile = project.attachments?.find(file => file.id === finalOption?.attachment_id && file.content_type === "application/pdf");
  const uploadDate = draft.upload_date ?? (finalFile?.upload_date || kitchenApprovalDate(finalFile?.uploaded_at) || "");
  const sharedDate = draft.sent_status === "Yes" ? draft.shared_date : "";
  const problem = !draft.pdf_options.length ? "Upload at least one GI, SS or Mix quotation PDF." : !finalOption || !finalFile ? "Select one finalized PDF and its kitchen type." : !uploadDate ? "Enter the PDF upload date." : draft.response !== "Pending" && (draft.sent_status !== "Yes" || !sharedDate) ? "Record sent to customer and its date before a customer response." : null;
  return <View style={{ gap: spacing.md }}>
    <Text style={type.bodyStrong}>Finalized design{displayedDesign ? ` · Design ${displayedDesign.number}` : ""}</Text>
    {finalizedDesignFile ? <KitchenPdfFile project={project} file={finalizedDesignFile} selected testID="kitchen-quotation-final-design" /> : <Text style={type.bodyMuted}>No finalized design PDF selected.</Text>}
    {quote && !boundOrder && savedDesign?.id !== designId ? <Text style={type.caption}>This quotation was saved against Design {savedDesign?.number ?? "unavailable"}. Saving quotation details applies the current finalized design{design ? `, Design ${design.number}` : ""}.</Text> : null}
    {boundOrder ? <Text style={type.caption}>This finalized quotation is used by an order. Its recorded PDF and kitchen type are preserved.</Text> : null}
    {stale ? <><Text style={type.bodyMuted}>This quotation changed while you were editing. Your entries are kept.</Text><Button label="Replace draft with latest quotation details" variant="secondary" onPress={() => resetDraftValue(prefix)} testID="kitchen-quotation-edit-reload" /></> : null}
    {(["GI", "SS", "Mix"] as const).map(kitchenType => <KitchenPdfFiles key={kitchenType} project={project} attachmentIds={draft.pdf_options.filter(option => option.kitchen_type === kitchenType).map(option => option.attachment_id)} finalId={draft.final_attachment_id} onAdd={id => setDraft(previous => ({ ...previous, pdf_options: [...previous.pdf_options.filter(option => option.attachment_id !== id), { attachment_id: id, kitchen_type: kitchenType }] }))} onSelect={id => setDraft(previous => { const file = project.attachments?.find(item => item.id === id); return { ...previous, final_attachment_id: id, upload_date: id === previous.final_attachment_id ? previous.upload_date : file?.upload_date || kitchenApprovalDate(file?.uploaded_at) || "" }; })} disabled={locked} selectionDisabled={boundOrder} label={kitchenType} testID={`kitchen-quotation-${kitchenType}-pdf`} draftKey={`${prefix}.pdf.${kitchenType}`} />)}
    <KitchenDetails items={[{ label: "Final kitchen type", value: finalOption?.kitchen_type || "Select one finalized PDF" }]} testID="kitchen-quotation-final-selection" />
    <KitchenDateField label="PDF upload date" value={uploadDate} onChange={value => update("upload_date", value)} disabled={locked || !finalFile} defaultToToday={false} testID="kitchen-quotation-upload-date" />
    <Choice label="Quotation sent to customer" value={draft.sent_status} values={["Yes", "No"]} onChange={value => update("sent_status", value)} disabled={locked} testID="kitchen-quotation-sent" />
    <KitchenDateField label="Quotation date sent to customer" value={draft.shared_date} onChange={value => update("shared_date", value)} disabled={locked} testID="kitchen-quotation-shared-date" />
    {draft.response === "Rejected" ? <Text style={type.caption}>Saved customer response: Rejected. Select a choice to change it.</Text> : null}
    {revision ? <Text style={type.caption}>Save this revision first; customer response starts as Pending.</Text> : null}
    <Choice label="Customer response" value={draft.response} values={["Pending", "Approved", "Changes Required"]} onChange={value => update("response", value)} disabled={locked || revision} testID="kitchen-version-response" />
    {problem ? <Text accessibilityRole="alert" style={type.bodyMuted}>{problem}</Text> : null}
    {quote?.response === "Approved" && !project.permissions?.can_approve_exceptions ? <Text style={type.caption}>Only the owner can correct an approved quotation.</Text> : null}
    {project.stage === "quotation" ? <Button label={"Save quotation details"} disabled={locked || documentSubmission.busy || stale || Boolean(requirement) || Boolean(problem)} onPress={async () => { if (saving.current) return; saving.current = true; try { const { source: _source, ...fields } = draft; const saved = await command(quote ? "quotation_update" : "quotation_receive", { ...fields, design_version_id: designId, ...(quote ? { version_id: quote.id } : {}), upload_date: uploadDate || null, shared_date: sharedDate || null }); if (saved && revision) onRevisionSaved(); } finally { saving.current = false; } }} testID={quote ? "kitchen-quotation-edit-save" : "kitchen-quotation-receive"} /> : null}
  </View>;
}
