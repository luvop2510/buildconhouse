import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Alert } from "@/src/components/ds";
import { KITCHEN_STAGES, STAGE_LABELS, type KitchenCommand, type KitchenProject, type KitchenStage, type KitchenWork, type KitchenVersion } from "@/src/api/kitchenProjects";
import { Choice, displayDate, KitchenPanel, KitchenDetails, historicalCount, rupees } from "./shared";
import { KitchenSelect, KitchenDateField } from "./KitchenFilters";
import { kitchenToday } from "./KitchenDates";
import { kitchenOrderContext, kitchenDesignApproval, kitchenApprovalDate, kitchenProductionStarted, kitchenOrderQuotations } from "./KitchenVersions";
import { DocumentChoice } from "./KitchenDocuments";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { radius, spacing } from "@/src/theme/tokens";
import { KitchenButton as Button, KitchenTextField as TextField, KitchenFieldRow, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";

export type StageCommand = (command: KitchenCommand, payload: Record<string, unknown>) => Promise<boolean>;
export function CommercialStages({ project, stage, disabled, command, mode = "task" }: { project: KitchenProject; stage: KitchenStage; disabled: boolean; command: StageCommand; mode?: "task" | "amendment" }) {
  const { submission, loading, failure } = useKitchenProject();
  const savingWorkAndStage = useRef(false);
  const [designView, setDesignView] = useState<string>();
  const [quoteView, setQuoteView] = useState<string>();
  const savedContext = kitchenOrderContext(project);
  const latestDesign = project.design_versions?.at(-1);
  const currentDesign = (latestDesign?.workflow_cycle ?? 1) === (project.workflow_cycle ?? 1) ? latestDesign : undefined;
  const latestOrder = project.orders?.at(-1);
  const order = savedContext.order;
  const productionStarted = kitchenProductionStarted(project);
  const design = project.design_versions?.find(row => row.id === designView) || (stage === "order" && order ? savedContext.design : currentDesign);
  const validOrderQuotes = kitchenOrderQuotations(project);
  const designQuotes = project.quotation_versions?.filter(row => row.design_version_id === design?.id) || [];
  const quote = project.quotation_versions?.find(row => row.id === quoteView && (stage === "order" || row.design_version_id === design?.id)) || (stage === "order" && order ? savedContext.quotation : stage === "order" ? validOrderQuotes.at(-1) || designQuotes.at(-1) : designQuotes.at(-1));
  const quoteDesign = project.design_versions?.find(row => row.id === quote?.design_version_id);
  const approvalRecord = kitchenDesignApproval(project, design);
  const recordedApprovalDate = kitchenApprovalDate(approvalRecord?.at);
  const approvalDate = design?.approval_date || recordedApprovalDate;
  const historyCycle = Boolean(design && (design.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1));
  const chooseDesign = (id: string) => { setDesignView(id); setQuoteView(undefined); };
  const draftCycle = `commercial.cycle.${project.workflow_cycle ?? 1}`;
  const responseScope = stage === "design" ? `design.${design?.id || "new"}` : `quotation.${quote?.id || "new"}`;
  const today = kitchenToday();
  const [presentationDate, setPresentationDate] = useKitchenDraft(`${draftCycle}.design.date`, today);
  const [requirements, setRequirements] = useKitchenDraft(`${draftCycle}.design.requirements`, design?.requirements ?? project.visit.requirements ?? "");
  const [budgetDiscussion, setBudgetDiscussion] = useKitchenDraft(`${draftCycle}.design.budget`, design?.budget_discussion ?? project.visit.budget_discussion ?? "");
  const [designFile, setDesignFile] = useKitchenDraft(`${draftCycle}.design.file`, "");
  const [designNotes, setDesignNotes] = useKitchenDraft(`${draftCycle}.design.notes`, "");
  const [shareDate, setShareDate] = useKitchenDraft(`${draftCycle}.${responseScope}.shareDate`, today);
  const [handoffDate, setHandoffDate] = useKitchenDraft(`${draftCycle}.design.${design?.id || "new"}.handoffDate`, today);
  const [response, setResponse] = useKitchenDraft(`${draftCycle}.${responseScope}.response`, "Pending");
  const [responseNotes, setResponseNotes] = useKitchenDraft(`${draftCycle}.${responseScope}.responseNotes`, "");
  const [quoteDate, setQuoteDate] = useKitchenDraft(`${draftCycle}.quotation.date`, today);
  const [quoteAmount, setQuoteAmount] = useKitchenDraft(`${draftCycle}.quotation.amount`, "");
  const [quoteNotes, setQuoteNotes] = useKitchenDraft(`${draftCycle}.quotation.notes`, "");
  const [orderDate, setOrderDate] = useKitchenDraft(`${draftCycle}.order.date`, order?.order_date || today);
  const [orderNotes, setOrderNotes] = useKitchenDraft(`${draftCycle}.order.notes`, order?.notes || "");
  const [finalAmount, setFinalAmount] = useKitchenDraft(`${draftCycle}.order.finalAmount.${quote?.id || "new"}`, quote?.amount || "");
  const [amountApproved, setAmountApproved] = useKitchenDraft(`${draftCycle}.order.amountApproved`, "No");
  const changedAmount = Boolean(quote?.amount != null && Number(finalAmount) !== Number(quote.amount));
  const savedConfirmation = project.customer_order_confirmation || (order?.confirmed ? "Yes" : order ? "No" : "Not recorded");
  const [orderConfirmed, setOrderConfirmed] = useKitchenDraft(`${draftCycle}.order.confirmed`, savedConfirmation);
  const [orderStatus, setOrderStatus] = useKitchenDraft(`${draftCycle}.order.status`, order?.status || "Confirmed");
  const [orderStatusReason, setOrderStatusReason] = useKitchenDraft(`${draftCycle}.order.statusReason`, "");
  const [customerApprovalDate, setCustomerApprovalDate] = useKitchenDraft(`${draftCycle}.design.${design?.id || "new"}.approvalDate`, design?.approval_date || today);
  const [advanceReceived, setAdvanceReceived] = useKitchenDraft(`${draftCycle}.order.advanceReceived`, "Not recorded");
  const [advanceAmount, setAdvanceAmount] = useKitchenDraft(`${draftCycle}.order.advanceAmount`, "");
  const [advanceDate, setAdvanceDate] = useKitchenDraft(`${draftCycle}.order.advanceDate`, today);
  const [amendAmount, setAmendAmount] = useKitchenDraft(`${draftCycle}.order.amendAmount`, "");
  const [amendDate, setAmendDate] = useKitchenDraft(`${draftCycle}.order.amendDate`, today);
  const [amendReason, setAmendReason] = useKitchenDraft(`${draftCycle}.order.amendReason`, "");
  const [amendApproved, setAmendApproved] = useKitchenDraft(`${draftCycle}.order.amendApproved`, "Not recorded");
  const [production, setProduction] = useKitchenDraft<KitchenWork>(`${draftCycle}.production`, project.production || { status: "Not Started" });
  const [installation, setInstallation] = useKitchenDraft<KitchenWork>(`${draftCycle}.installation`, project.installation || { status: "Not Started" });
  const [siteDate, setSiteDate] = useKitchenDraft(`${draftCycle}.site.date`, today);
  const [siteActual, setSiteActual] = useKitchenDraft(`${draftCycle}.site.actual`, "Not recorded");
  const [siteNotes, setSiteNotes] = useKitchenDraft(`${draftCycle}.site.notes`, "");
  const [approvalReason, setApprovalReason] = useKitchenDraft(`${draftCycle}.${stage}.approvalReason`, "");
  const savedInstallationStatus = useRef(project.installation?.status);
  useEffect(() => {
    // A site visit can reopen completed installation; show its new saved state.
    if (savedInstallationStatus.current === "Completed" && project.installation?.status === "In Progress") setInstallation(project.installation);
    savedInstallationStatus.current = project.installation?.status;
  }, [project.installation, setInstallation]);
  const active = project.stage === stage;
  const preview = KITCHEN_STAGES.indexOf(stage) > KITCHEN_STAGES.indexOf(project.stage);
  const statusLocked = !project.permissions?.can_update || submission.busy || loading || Boolean(failure) || !active;
  const locked = disabled || !active || ((stage === "design" || stage === "quotation") && historyCycle);
  const next: Partial<Record<KitchenStage, KitchenStage>> = { design: "quotation", quotation: "order", order: "production", production: "installation", installation: "completed" };
  const target = next[stage];
  const reason = project.blocked_transitions?.find(row => row.target_stage === target)?.reason;
  const validAmount = (value: string, positive = false) => /^\d+(?:\.\d{1,2})?$/.test(value.trim()) && value.trim().length <= 32 && Number(value) <= 1_000_000_000_000 && (positive ? Number(value) > 0 : Number(value) >= 0);
  const quotationRequirement = historyCycle ? "Choose an approved design from the current work cycle to create a quotation." : !design ? "Record a design presentation in Design first." : project.design_revision_pending ? "Present the customer’s revised design and record its approval in Design first." : design.response !== "Approved" ? "Record the customer’s design approval in Design first." : !design.handoff_date ? "Record the approved design as sent to the company in Design first." : null;
  const orderRequirement = !quote ? "Record the received company quotation in Quotation first." : !quoteDesign || quoteDesign.response !== "Approved" || !quoteDesign.handoff_date || project.design_revision_pending || (quoteDesign.workflow_cycle ?? 1) !== (project.workflow_cycle ?? 1) ? "The selected design needs approval and company handoff before confirming an order. Go to Quotation, then return to Design to complete that record." : !quote.shared_date ? "Record the quotation as shared with the customer in Quotation first." : quote.response !== "Approved" ? "Record the customer’s quotation approval in Quotation first." : null;
  const stageHelp = (description: string, destination: KitchenStage) => <Alert tone="info" title="Complete the earlier record" description={description} action={active ? <Button label={`Go to ${STAGE_LABELS[destination]}`} variant="secondary" disabled={disabled} onPress={() => command("move_stage", { target_stage: destination })} testID={`kitchen-complete-${destination}`} /> : undefined} />;
  const saveWork = async (move = false) => {
    if (savingWorkAndStage.current || stage !== "production" && stage !== "installation") return false;
    savingWorkAndStage.current = true;
    try {
      const work = stage === "production" ? production : installation;
      const saved = await command(stage === "production" ? "production_update" : "installation_update", {
        status: work.status, start_date: work.start_date ?? null,
        completion_date: work.completion_date ?? null, notes: work.notes ?? null,
      });
      if (!saved || !move || !target) return saved;
      const moved = await command("move_stage", { target_stage: target });
      if (!moved) submission.setError(previous => `${STAGE_LABELS[stage]} details were saved. The stage change could not be confirmed; use Next stage to retry. ${previous || ""}`.trim());
      return moved;
    } finally { savingWorkAndStage.current = false; }
  };
  const dateField = (label: string, value: string, onChange: (value: string) => void, id: string) => <KitchenDateField label={label} value={value} onChange={onChange} disabled={locked} testID={id} />;
  const responseForm = (isDesign: boolean) => {
    const version = isDesign ? design : quote;
    if (preview) return <KitchenPanel title="Customer sharing and approval">
      {dateField("Date shared with customer", shareDate, setShareDate, "kitchen-version-share-date")}
      <Choice label="Customer response" value={response} values={isDesign ? ["Pending", "Approved", "Changes Required"] : ["Pending", "Approved", "Changes Required", "Rejected"]} onChange={setResponse} disabled />
    </KitchenPanel>;
    if (!active || !version || (isDesign && project.design_revision_pending)) return null;
    return !version.shared_date ? <KitchenPanel title="Share with the customer">
      <Text style={type.bodyMuted}>Record when you actually shared {isDesign ? `Design v${version.number}` : `Quotation r${version.number}`}. This does not send a message.</Text>
      {dateField("Date shared with customer", shareDate, setShareDate, "kitchen-version-share-date")}
      <Button label="Record shared with customer" disabled={locked || !shareDate} onPress={() => command(isDesign ? "design_share" : "quotation_share", { version_id: version.id, date: shareDate })} testID="kitchen-version-share" />
    </KitchenPanel> : version.response !== "Approved" ? <KitchenPanel title="Record the customer’s response">
      <Choice label="Customer response" value={response} values={isDesign ? ["Pending", "Approved", "Changes Required"] : ["Pending", "Approved", "Changes Required", "Rejected"]} onChange={setResponse} disabled={locked} testID="kitchen-version-response" />
      {isDesign && response === "Approved" ? dateField("Customer approval date", customerApprovalDate, setCustomerApprovalDate, "kitchen-design-approval-date") : null}
      {!isDesign ? <TextField label="Internal notes" value={responseNotes} onChangeText={setResponseNotes} editable={!locked} multiline /> : null}
      <Button label="Record customer response" disabled={locked} onPress={() => command(isDesign ? "design_response" : "quotation_response", { version_id: version.id, response, notes: (isDesign ? design?.notes : responseNotes) || null, ...(isDesign && response === "Approved" ? { approval_date: customerApprovalDate } : {}) })} testID="kitchen-version-response-save" />
    </KitchenPanel> : null;
  };
  const approval = (scope: "production" | "closure") => {
    const lastDecision = project.approvals?.filter(row => row.scope === scope).at(-1);
    const canApprove = project.permissions?.[scope === "production" ? "can_approve_production" : "can_approve_closure"];
    const decisionForm = <View style={{ gap: spacing.md }}>
      <TextField label="Manager decision reason" value={approvalReason} onChangeText={setApprovalReason} multiline editable={!locked} />
      <Button label="Approve as selected manager" disabled={locked} onPress={() => command("approval", { scope, decision: "Approved", reason: approvalReason || null })} testID={`kitchen-approve-${scope}`} />
      <Button label="Reject as selected manager" variant="danger" disabled={locked} onPress={() => command("approval", { scope, decision: "Rejected", reason: approvalReason || null })} />
    </View>;
    return <KitchenPanel title={`${scope === "production" ? "Production entry" : "Closure"} manager approval`}>
      <KitchenDetails items={[
        { label: "Last recorded decision", value: lastDecision?.decision || "Awaiting selected manager" },
        { label: "Decision date", value: displayDate(lastDecision?.at) },
      ]} />
      <Text style={type.bodyMuted}>Approval records are separate from stage navigation. You can move stages whenever needed.</Text>
      {canApprove ? lastDecision && !reason?.toLowerCase().includes("manager") ? <Disclosure draftKey={`${draftCycle}.${scope}.decision`} label="Record another manager decision" testID={`kitchen-disclose-${scope}-decision`}>{decisionForm}</Disclosure> : decisionForm : <Text style={type.bodyMuted}>Only a manager explicitly selected in the current policy can record this decision.</Text>}
    </KitchenPanel>;
  };

  const designForm = <View style={{ gap: spacing.md }}>
        {dateField("Presentation date", presentationDate, setPresentationDate, "kitchen-design-date")}
        <TextField label="Customer requirements" value={requirements} onChangeText={setRequirements} editable={!locked} multiline testID="kitchen-design-requirements" />
        <TextField label="Budget discussion" value={budgetDiscussion} onChangeText={setBudgetDiscussion} editable={!locked} multiline testID="kitchen-design-budget" />
        <DocumentChoice project={project} value={designFile} onChange={setDesignFile} disabled={locked} label="Design presentation document (optional)" />
        <Text style={type.caption}>Company handoff is recorded after customer approval.</Text>
        <TextField label="Internal notes" value={designNotes} onChangeText={setDesignNotes} editable={!locked} multiline testID="kitchen-design-new-notes" />
        <Button label={design ? "Present new design version / internal correction" : project.design_versions?.length ? "Present revised design" : "Present first design"} disabled={locked || !presentationDate || (design?.response === "Approved" && !project.design_revision_pending)} onPress={() => { void command("design_present", { attachment_id: designFile || null, presentation_date: presentationDate, requirements: requirements || null, budget_discussion: budgetDiscussion || null, notes: designNotes || null }).then(saved => { if (saved) chooseDesign(""); }); }} testID="kitchen-design-present" />
        <Text style={type.caption}>A presentation or internal correction does not increase the customer revision count.</Text>

  </View>;

  const quoteForm = <View style={{ gap: spacing.md }}>
        {quotationRequirement ? stageHelp(quotationRequirement, "design") : null}
        {dateField("Quotation received date", quoteDate, setQuoteDate, "kitchen-quotation-date")}
        <TextField label="Quotation amount (INR, optional)" value={quoteAmount} onChangeText={setQuoteAmount} keyboardType="decimal-pad" editable={!locked} testID="kitchen-quotation-amount" />
        <TextField label="Internal notes" value={quoteNotes} onChangeText={setQuoteNotes} editable={!locked} multiline testID="kitchen-quotation-notes" />
        {quoteAmount.trim() && !validAmount(quoteAmount) ? <Text style={type.caption}>Enter the quotation amount in INR, with up to two decimal places.</Text> : null}
        <Button label="Record received quotation version" disabled={locked || !quoteDate || Boolean(quoteAmount.trim() && !validAmount(quoteAmount)) || Boolean(quotationRequirement)} onPress={() => { void command("quotation_receive", { design_version_id: design!.id, amount: quoteAmount.trim() || null, received_date: quoteDate, notes: quoteNotes || null }).then(saved => { if (saved) setQuoteView(undefined); }); }} testID="kitchen-quotation-receive" />

  </View>;

  const advanceForm = <View style={{ gap: spacing.md }}>
          <Choice label="Advance received" value={advanceReceived} values={["Not recorded", "Yes", "No"]} onChange={setAdvanceReceived} disabled={locked} testID="kitchen-advance-received" />
          {advanceReceived === "Yes" ? <><TextField label="Advance amount (INR)" value={advanceAmount} onChangeText={setAdvanceAmount} editable={!locked} keyboardType="decimal-pad" testID="kitchen-advance-amount" />
          {dateField("Advance receipt date", advanceDate, setAdvanceDate, "kitchen-advance-date")}</> : null}
          {!order ? <Text style={type.caption}>Confirm the customer order above before saving an advance. Pending is the normal status before confirmation.</Text> : advanceReceived === "Not recorded" ? <Text style={type.caption}>Choose Yes to record money received, or No to record that no advance has been received.</Text> : advanceReceived === "Yes" && (!validAmount(advanceAmount, true) || !advanceDate) ? <Text style={type.caption}>Enter a positive amount received and its receipt date.</Text> : null}
          <Button label={advanceReceived === "No" ? "Save no advance received" : "Record advance payment"} disabled={locked || !order || advanceReceived === "Not recorded" || advanceReceived === "Yes" && (!validAmount(advanceAmount, true) || !advanceDate)} onPress={() => command("order_advance", { received: advanceReceived === "Yes", amount: advanceReceived === "No" ? "0.00" : advanceAmount, date: advanceReceived === "No" ? null : advanceDate || null })} testID="kitchen-advance-save" />
  </View>;

  if (mode === "amendment" && !project.permissions?.can_approve_exceptions) return <Alert tone="info" title="Owner authorization required" description="Only the owner can record restricted changes to approved commercial terms." />;
  if (mode === "amendment" && project.stage !== "order") return <KitchenPanel title="Preserved order terms">
    <KitchenDetails items={[
      { label: "Original amount", value: rupees(latestOrder?.original_amount) },
      { label: "Final approved amount", value: rupees(latestOrder?.final_amount) },
    ]} />
    <Text style={type.bodyMuted}>Commercial amendments are available during Order. To change the approved design or commercial basis at this stage, use Return to Design above with a reason. Earlier orders, work and approvals stay in History.</Text>
  </KitchenPanel>;
  if (mode === "amendment") return order ? <KitchenPanel title="Approved order amendment"><Text style={type.caption}>The original order remains preserved. Changed commercial terms require explicit customer approval.</Text>
          <TextField label="Amended final amount (INR)" value={amendAmount} onChangeText={setAmendAmount} editable={!disabled} keyboardType="decimal-pad" testID="kitchen-amend-amount" />
          <KitchenDateField label="Amendment approval date" value={amendDate} onChange={setAmendDate} disabled={disabled} testID="kitchen-amend-date" />
          <TextField label="Amendment reason" value={amendReason} onChangeText={setAmendReason} editable={!disabled} multiline testID="kitchen-amend-reason" />
          <Choice label="Customer approved amended terms" value={amendApproved} values={["Not recorded", "Yes", "No"]} onChange={setAmendApproved} disabled={disabled} testID="kitchen-amend-approved" />
          <Button label="Record approved amendment" disabled={disabled || !project.permissions?.can_approve_exceptions || amendApproved !== "Yes" || !amendReason.trim()} onPress={() => command("order_amend", { amount: amendAmount, date: amendDate, reason: amendReason, customer_approved: true })} testID="kitchen-amend-save" />
        </KitchenPanel> : <KitchenPanel title="Approved order amendment"><Text style={type.bodyMuted}>No current order to amend. Confirm an order against the current approved quotation first.</Text></KitchenPanel>;

  return <View style={{ gap: spacing.lg, display: ["lead", "visit", "cad"].includes(stage) ? "none" : "flex" }}>
    {!active && !preview && stage !== "completed" ? <Alert tone="info" title="Stage record" description="Review the saved stage record here. Use the current stage for ongoing work; previous versions are in History." /> : null}
    {stage === "design" ? <>
      <KitchenPanel title="Design presentation">
        {project.design_versions?.length ? <KitchenSelect label="Design version" value={design?.id || ""} options={project.design_versions.map(row => ({ value: row.id, label: `Design v${row.number} · ${row.response}` }))} onChange={chooseDesign} testID="kitchen-design-version" /> : null}
        <KitchenDetails testID="kitchen-design-details" items={[
          { label: "Selected design", value: design ? `Design v${design.number}` : "None" },
          { label: "Customer-requested revisions", value: historicalCount(project.design_revision_count, project.known_design_revision_count) },
          { label: "Customer approval", value: design?.response || "Pending" },
          { label: design?.approval_date ? "Customer approval date" : "Approval recorded", value: displayDate(approvalDate) },
          { label: "Shared with customer", value: displayDate(design?.shared_date) },
          { label: "Presented", value: displayDate(design?.presentation_date) },
          { label: "Company handoff", value: displayDate(design?.handoff_date) },
          ...(design?.attachment_id ? [{ label: "Document", value: project.attachments?.find(file => file.id === design.attachment_id)?.filename || "Saved project attachment" }] : []),
          ...(design?.requirements ? [{ label: "Requirements", value: design.requirements }] : []),
          ...(design?.budget_discussion ? [{ label: "Budget discussion", value: design.budget_discussion }] : []),
          ...(design?.notes ? [{ label: "Internal notes", value: design.notes }] : []),
          ...(design?.response_notes ? [{ label: "Historical internal response notes", value: design.response_notes }] : []),
        ]} />
        {design?.handoff_date && (!approvalDate || design.handoff_date < approvalDate) ? <Alert tone="warning" title="Review historical handoff dates" description={!approvalDate ? "The approval date is unavailable. Existing dates are preserved." : "The saved handoff precedes the approval date. Existing dates are preserved; review before making a correction."} /> : null}
        <Text style={type.caption}>Related quotation revisions: {designQuotes.length ? designQuotes.map(row => `r${row.number} · ${row.response}`).join("; ") : "None"}</Text>
        {design?.url ? <Button label="Open current design reference" variant="secondary" onPress={() => void Linking.openURL(design.url!)} /> : null}
        {active && design && !project.design_revision_pending ? <DesignEditor key={design.id} project={project} design={design} disabled={locked} command={command} /> : null}
        {project.design_revision_pending ? <Alert tone="warning" title="Revised design required" description="Present a new version before recording customer approval." /> : null}
        {(active || preview) && (!design || project.design_revision_pending) ? designForm : active && design?.response !== "Approved" ? <Disclosure draftKey={`${draftCycle}.design.newVersion`} label="Present a new version or correction" testID="kitchen-disclose-design-version">{designForm}</Disclosure> : null}
      </KitchenPanel>
      {responseForm(true)}
      {preview || active && design?.response === "Approved" && !project.design_revision_pending && !design.handoff_date ? <KitchenPanel title="Send the approved design to the company">
        <KitchenDateField label="Date sent to company" value={handoffDate} onChange={setHandoffDate} min={approvalDate} disabled={locked} testID="kitchen-design-handoff-date" />
        <Button label="Mark approved design sent to company" disabled={locked || !design || design.response !== "Approved" || Boolean(project.design_revision_pending) || Boolean(design.handoff_date) || !approvalDate || handoffDate < approvalDate} onPress={() => command("design_handoff", { version_id: design!.id, date: handoffDate })} testID="kitchen-design-handoff" />
      </KitchenPanel> : null}
    </> : stage === "quotation" ? <>
      <KitchenPanel title="Company quotation">{project.design_versions?.length ? <KitchenSelect label="Design version" value={design?.id || ""} options={project.design_versions.map(row => ({ value: row.id, label: `Design v${row.number} · ${row.response}` }))} onChange={chooseDesign} testID="kitchen-quotation-design-version" /> : null}
        {designQuotes.length ? <KitchenSelect label="Quotation revision" value={quote?.id || ""} options={designQuotes.map(row => ({ value: row.id, label: `Quotation r${row.number} · ${row.response}` }))} onChange={setQuoteView} testID="kitchen-quotation-revision" /> : null}
        <Text style={type.bodyStrong}>{quote ? `Quotation r${quote.number} · Design v${quoteDesign?.number ?? "unavailable"} · ${rupees(quote.amount)}` : "No quotation recorded for this design"}</Text><Text style={type.bodyMuted}>New quotations use the selected design version. Each quotation revision requires its own sharing and customer approval.</Text>
        <KitchenDetails testID="kitchen-quotation-details" items={[
          { label: "Selected quotation", value: quote ? `Quotation r${quote.number}` : "None" },
          { label: "Design version", value: quoteDesign ? `Design v${quoteDesign.number}` : "Not recorded" },
          { label: "Quotation received", value: quote ? "Yes" : "No" },
          { label: "Quotation amount", value: rupees(quote?.amount) },
          { label: "Received", value: displayDate(quote?.received_date) },
          { label: "Quotation sent to customer", value: quote?.shared_date ? "Yes" : "No" },
          { label: "Date sent to customer", value: displayDate(quote?.shared_date) },
          { label: "Customer response", value: quote?.response || "Pending" },
          ...(quote?.attachment_id ? [{ label: "Document", value: project.attachments?.find(file => file.id === quote.attachment_id)?.filename || "Saved project attachment" }] : []),
          ...(quote?.notes ? [{ label: "Internal notes", value: quote.notes }] : []),
          ...(quote?.response_notes ? [{ label: "Historical internal response notes", value: quote.response_notes }] : []),
        ]} />
        {active && project.orders?.length && !project.commercial_basis_invalidated ? <Text style={type.bodyMuted}>This quotation belongs to a confirmed order. Record changed order terms through an approved amendment, or start a revised design cycle from Project actions. Stage navigation remains available.</Text> : active || preview ? !quote ? quoteForm : <Disclosure draftKey={`${draftCycle}.quotation.newVersion`} label="Record a revised company quotation" testID="kitchen-disclose-quotation-version">{quoteForm}</Disclosure> : null}
      </KitchenPanel>
      {responseForm(false)}
    </> : stage === "order" ? <>
      <KitchenPanel title="Order confirmation">
        <KitchenDetails testID="kitchen-order-details" items={[
          { label: "Customer order confirmation", value: savedConfirmation },
          { label: "Order status", value: order?.status || "Pending confirmation" },
          { label: "Order quotation", value: savedContext.quotation ? `Quotation r${savedContext.quotation.number} · Design v${savedContext.design?.number ?? "unavailable"}` : "Not yet recorded" },
          { label: "Order date", value: displayDate(order?.order_date) },
          { label: "Original amount", value: rupees(order?.original_amount) },
          { label: "Approved final amount", value: rupees(order?.final_amount) },
          { label: "Confirmation document", value: order?.confirmation_document_id ? project.attachments?.find(file => file.id === order.confirmation_document_id)?.filename || "Saved project attachment" : "Not attached" },
          ...(order?.notes ? [{ label: "Internal notes", value: order.notes }] : []),
        ]} />
        <Choice label="Customer order confirmation" value={orderConfirmed} values={["Not recorded", "Yes", "No"]} onChange={setOrderConfirmed} disabled={locked || productionStarted} testID="kitchen-order-confirmed" />
        {active ? <Button label="Save customer confirmation" disabled={locked || productionStarted} onPress={() => command("order_confirmation", { value: orderConfirmed })} testID="kitchen-order-confirmation-save" /> : null}
        {productionStarted ? <Text style={type.caption}>Production has started. The owner must use Return to Design to change the confirmed basis.</Text> : null}
        {project.quotation_versions?.length ? <KitchenSelect label={order ? "View quotation revision" : "Quotation revision for order"} value={order || validOrderQuotes.some(row => row.id === quote?.id) ? quote?.id || "" : ""} options={(order ? project.quotation_versions : validOrderQuotes.length ? validOrderQuotes : [{ id: "", number: 0, design_version_id: "", response: "Pending" }]).map(row => ({ value: row.id, label: row.id ? `Quotation r${row.number} · Design v${project.design_versions?.find(design => design.id === row.design_version_id)?.number ?? "unavailable"} · ${row.response}` : "No approved quotation available" }))} onChange={setQuoteView} testID="kitchen-order-quotation-revision" /> : null}
        <Text style={type.body}>Selected quotation: {quote ? `Quotation r${quote.number} · Design v${quoteDesign?.number ?? "unavailable"} · ${rupees(quote.amount)} · ${quote.response}` : "Not yet recorded"}</Text>
        {!order && (active || preview) ? <View style={{ gap: spacing.md, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.divider }}>
          <Text accessibilityRole="header" style={type.titleMd}>Record customer confirmation</Text>
          {orderRequirement ? stageHelp(orderRequirement, "quotation") : <Text style={type.caption}>The quotation is approved. Record the confirmation date and confirm the customer order below.</Text>}
          {dateField("Order date", orderDate, setOrderDate, "kitchen-order-date")}
          <TextField label="Final order amount (INR)" value={finalAmount} onChangeText={setFinalAmount} keyboardType="decimal-pad" editable={!locked && (quote?.amount == null || Boolean(project.permissions?.can_approve_exceptions))} testID="kitchen-order-amount" />
          {changedAmount ? <Choice label="Customer approved changed final amount" value={amountApproved} values={["No", "Yes"]} onChange={setAmountApproved} disabled={locked} testID="kitchen-order-amount-approved" /> : null}
          <TextField label="Internal notes" value={orderNotes} onChangeText={setOrderNotes} editable={!locked} multiline testID="kitchen-order-notes" />
          {!validAmount(finalAmount) && !orderRequirement ? <Text style={type.caption}>Enter the final order amount in INR, with up to two decimal places.</Text> : null}
          {orderConfirmed !== "Yes" ? <Text style={type.caption}>Select Yes once the customer has confirmed the order.</Text> : null}
          {changedAmount ? <Text style={type.caption}>A changed amount requires owner authorization and the customer’s explicit approval.</Text> : null}
          <Button label="Confirm customer order" disabled={locked || !validAmount(finalAmount) || !orderDate || changedAmount && (!project.permissions?.can_approve_exceptions || amountApproved !== "Yes") || orderConfirmed !== "Yes" || Boolean(orderRequirement)} onPress={() => command("order_confirm", { final_amount: finalAmount, amount_customer_approved: amountApproved === "Yes", quotation_version_id: quote!.id, order_date: orderDate, notes: orderNotes || null })} testID="kitchen-order-confirm" />
        </View> : null}
        {active && order && project.permissions?.can_approve_exceptions ? <Disclosure draftKey={`${draftCycle}.order.statusEdit`} label="Edit order status" testID="kitchen-disclose-order-status">
          <Choice label="Order status" value={orderStatus} values={["Confirmed", "On Hold", "Cancelled"]} onChange={setOrderStatus} disabled={statusLocked} testID="kitchen-order-status" />
          <TextField label="Internal notes" value={orderStatusReason} onChangeText={setOrderStatusReason} multiline editable={!statusLocked} helper="Explain the status change for the internal history." testID="kitchen-order-status-notes" />
          <Button label="Save order status" disabled={statusLocked || !orderStatusReason.trim()} onPress={() => command("order_status", { status: orderStatus, reason: orderStatusReason })} testID="kitchen-order-status-save" />
        </Disclosure> : null}
        {active && order ? <OrderEditor project={project} order={order} disabled={locked} command={command} /> : null}
      </KitchenPanel>
      {active && order && project.permissions?.can_approve_exceptions ? <CommercialStages project={project} stage={stage} disabled={disabled} command={command} mode="amendment" /> : null}
      {preview || active && !order ? <KitchenPanel title="Advance payment">{advanceForm}</KitchenPanel> : null}
      {preview ? approval("production") : null}
      {order ? <>
        <KitchenPanel title="Advance payment"><KitchenDetails testID="kitchen-advance-details" items={[
          { label: "Advance payment received", value: order.advance.received ? "Yes" : "No" },
          { label: "Advance amount", value: order.advance.received ? rupees(order.advance.amount) : "—" },
          { label: "Advance date", value: displayDate(order.advance.date) },
        ]} />
        {active ? order.advance.received ? <Disclosure draftKey={`${draftCycle}.order.advanceEdit`} label="Update the advance payment record" testID="kitchen-disclose-advance">{advanceForm}</Disclosure> : advanceForm : null}
        </KitchenPanel>
{active && order.advance.received ? approval("production") : null}
      </> : null}
    </> : stage === "production" || stage === "installation" ? <>
      <KitchenPanel title="Order versions">
        <Text style={type.bodyStrong}>{savedContext.order ? `Quotation r${savedContext.quotation?.number ?? "unavailable"} · Design v${savedContext.design?.number ?? "unavailable"}` : "No active order version recorded"}</Text>
        <Text style={type.caption}>These are the saved order versions used for work. Review history in Design or Quotation. A change after production starts requires owner-authorized Return to Design.</Text>
      </KitchenPanel>
      <KitchenPanel title={STAGE_LABELS[stage]}>
        <KitchenDetails testID={`kitchen-${stage}-details`} items={[
          { label: "Current status", value: (stage === "production" ? project.production : project.installation)?.status || "Not Started" },
          { label: "Start date", value: displayDate((stage === "production" ? project.production : project.installation)?.start_date) },
          { label: "Completion date", value: displayDate((stage === "production" ? project.production : project.installation)?.completion_date) },
          ...((stage === "production" ? project.production : project.installation)?.notes ? [{ label: "Notes", value: (stage === "production" ? project.production : project.installation)!.notes! }] : []),
        ]} />
        {(active || preview) && (stage === "production" ? project.production : project.installation)?.status !== "Completed" ? <View style={{ gap: spacing.md }}>        <WorkForm value={stage === "production" ? production : installation} onChange={stage === "production" ? setProduction : setInstallation} production={stage === "production"} disabled={locked} />
        <Text style={type.caption}>Save these details here, or save and move to the next stage in one action.</Text>
        <Button label={`Save ${stage} details`} disabled={locked} onPress={() => saveWork()} testID={`kitchen-${stage}-save`} />
        <Button label={`Save and go to ${STAGE_LABELS[target!]}`} variant="secondary" disabled={locked} onPress={() => saveWork(true)} testID={`kitchen-${stage}-save-next`} /></View> : null}
      </KitchenPanel>
      {stage === "installation" ? <><KitchenPanel title="Installation site visits"><KitchenDetails items={[{ label: "Actual site visits", value: historicalCount(project.site_visit_count, project.known_site_visit_count) }]} />
        {active || preview ? <Disclosure draftKey={`${draftCycle}.site.newVisit`} label="Record a site visit" testID="kitchen-disclose-site-visit">        {dateField("Site visit date", siteDate, setSiteDate, "kitchen-site-date")}
        <Choice label="Visit actually took place" value={siteActual} values={["Not recorded", "Yes — actual visit", "No — scheduled only"]} onChange={setSiteActual} disabled={locked} testID="kitchen-site-actual" />
        <TextField label="Internal notes" value={siteNotes} onChangeText={setSiteNotes} editable={!locked} multiline />
        {siteActual === "Not recorded" ? <Text style={type.caption}>Choose whether this visit actually took place to enable recording.</Text> : null}
        <Button label="Record site visit" disabled={locked || siteActual === "Not recorded" || !siteDate} onPress={() => { void command("site_visit", { date: siteDate, actual: siteActual === "Yes — actual visit", notes: siteNotes || null }).then(saved => { if (saved) { setSiteDate(kitchenToday()); setSiteActual("Not recorded"); setSiteNotes(""); } }); }} testID="kitchen-site-save" />
        <Text style={type.caption}>Scheduled visits do not increase the actual counter. Record each distinct real visit once.</Text>
</Disclosure> : null}
      </KitchenPanel>{preview || active && project.installation?.status === "Completed" ? approval("closure") : null}</> : null}
    </> : stage === "completed" ? <KitchenPanel title="Completed project"><KitchenDetails testID="kitchen-completed-details" items={[
      { label: "Project completion", value: displayDate(project.completion_date) },
      { label: "Final order amount", value: rupees(project.order_amount) },
      { label: "Total design revisions", value: historicalCount(project.design_revision_count, project.known_design_revision_count) },
      { label: "Actual site visits", value: historicalCount(project.site_visit_count, project.known_site_visit_count) },
    ]} /><Text style={type.caption}>Review previous versions, orders and approvals in History.</Text></KitchenPanel> : null}

  </View>;
}
function OrderEditor({ project, order, disabled, command }: { project: KitchenProject; order: NonNullable<KitchenProject["orders"]>[number]; disabled: boolean; command: StageCommand }) {
  const prefix = `commercial.cycle.${project.workflow_cycle ?? 1}.order.${order.id}.edit`;
  const { resetDraftValue } = useKitchenProject();
  const source = JSON.stringify([order.order_date, order.notes, order.quotation_version_id]);
  const productionStarted = kitchenProductionStarted(project);
  const validQuotes = kitchenOrderQuotations(project);
  const [draft, setDraft] = useKitchenDraft(prefix, { source, order_date: order.order_date, notes: order.notes || "", quotation_version_id: order.quotation_version_id, amount_customer_approved: false });
  const stale = draft.source !== source;
  return <Disclosure draftKey={prefix} label="Edit order date and notes" testID="kitchen-disclose-order-edit">
    {stale ? <><Text style={type.bodyMuted}>These order details changed after you started editing. Your draft is kept until you replace it with the latest saved values.</Text><Button label="Replace draft with latest order details" variant="secondary" onPress={() => resetDraftValue(prefix)} testID="kitchen-order-edit-reload" /></> : null}
    <KitchenDateField label="Order date" value={draft.order_date} onChange={order_date => setDraft(previous => ({ ...previous, order_date }))} disabled={disabled} testID="kitchen-order-edit-date" />
    {!productionStarted && !disabled ? <KitchenSelect label="Quotation revision used for order" value={draft.quotation_version_id} options={validQuotes.map(quote => ({ value: quote.id, label: `Quotation r${quote.number} · Design v${project.design_versions?.find(design => design.id === quote.design_version_id)?.number ?? "unavailable"}` }))} onChange={quotation_version_id => setDraft(previous => ({ ...previous, quotation_version_id }))} testID="kitchen-order-edit-quotation" /> : <Text style={type.caption}>Order versions are fixed after production starts. The owner can use Return to Design for changes.</Text>}
    {draft.quotation_version_id !== order.quotation_version_id ? <Choice label="Customer approved retained final amount" value={draft.amount_customer_approved ? "Yes" : "No"} values={["No", "Yes"]} onChange={value => setDraft(previous => ({ ...previous, amount_customer_approved: value === "Yes" }))} disabled={disabled} /> : null}
    <TextField label="Internal notes" value={draft.notes} onChangeText={notes => setDraft(previous => ({ ...previous, notes }))} editable={!disabled} multiline testID="kitchen-order-edit-notes" />
    <Button label="Save order details" disabled={disabled || stale || !draft.order_date} onPress={() => command("order_update", { order_date: draft.order_date, notes: draft.notes || null, ...(draft.quotation_version_id !== order.quotation_version_id ? { quotation_version_id: draft.quotation_version_id, amount_customer_approved: draft.amount_customer_approved } : {}) })} testID="kitchen-order-edit-save" />
  </Disclosure>;
}

function DesignEditor({ project, design, disabled, command }: { project: KitchenProject; design: KitchenVersion; disabled: boolean; command: StageCommand }) {
  const prefix = `commercial.cycle.${project.workflow_cycle ?? 1}.design.${design.id}.edit`;
  const { resetDraftValue } = useKitchenProject();
  const currentSource = JSON.stringify([design, project.design_revision_count]);
  const initial = {
    source: currentSource, presentation_date: design.presentation_date || kitchenToday(), shared_date: design.shared_date || "",
    handoff_date: design.handoff_date || "", response: design.response, response_notes: design.response_notes || "",
    approval_date: design.approval_date || "",
    requirements: design.requirements ?? "", budget_discussion: design.budget_discussion ?? "",
    notes: design.notes || "", revision_count: project.design_revision_count == null ? "" : String(project.design_revision_count), reason: "",
  };
  const [draft, setDraft] = useKitchenDraft(prefix, initial);
  const stale = draft.source !== currentSource;
  const locked = disabled || design.response === "Approved" && !project.permissions?.can_approve_exceptions;
  const update = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const recordedApprovalDate = kitchenApprovalDate(kitchenDesignApproval(project, design)?.at);
  const effectiveApprovalDate = draft.approval_date || recordedApprovalDate;
  const invalidHandoff = Boolean(draft.handoff_date && (draft.response !== "Approved" || !effectiveApprovalDate || draft.handoff_date < effectiveApprovalDate));
  return <Disclosure draftKey={prefix} label="Edit design details" testID="kitchen-disclose-design-edit">
    {stale ? <View style={{ gap: spacing.sm }}><Text style={type.bodyMuted}>This design changed after you started editing. Review the latest saved details before making a correction. Your draft is retained until you choose to replace it.</Text><Button label="Replace draft with latest design details" variant="secondary" onPress={() => resetDraftValue(prefix)} testID="kitchen-design-edit-reload" /></View> : null}
    {locked && !disabled ? <Text style={type.bodyMuted}>Only the owner can correct an approved design.</Text> : null}
    <KitchenDateField label="Presentation date" value={draft.presentation_date} onChange={value => update("presentation_date", value)} disabled={locked} testID="kitchen-design-edit-date" />
    <TextField label="Customer requirements" value={draft.requirements} onChangeText={value => update("requirements", value)} editable={!locked} multiline testID="kitchen-design-edit-requirements" />
    <TextField label="Budget discussion" value={draft.budget_discussion} onChangeText={value => update("budget_discussion", value)} editable={!locked} multiline testID="kitchen-design-edit-budget" />
    <Text style={type.body} testID="kitchen-design-edit-revisions">Customer-requested revisions: {historicalCount(project.design_revision_count, project.known_design_revision_count)} · counted automatically</Text>
    <Choice label="Shared with customer" value={draft.shared_date ? "Yes" : "No"} values={["No", "Yes"]} onChange={value => update("shared_date", value === "Yes" ? kitchenToday() : "")} disabled={locked} />
    {draft.shared_date ? <KitchenDateField label="Date shared with customer" value={draft.shared_date} onChange={value => update("shared_date", value)} disabled={locked} testID="kitchen-design-edit-shared" /> : null}
    <Choice label="Customer approval" value={draft.response} values={["Pending", "Approved", "Changes Required"]} onChange={value => setDraft(previous => ({ ...previous, response: value, ...(value !== "Approved" ? { approval_date: "", handoff_date: "" } : {}) }))} disabled={locked} testID="kitchen-design-edit-response" />
    {draft.response === "Approved" ? <KitchenDateField label="Customer approval date" value={draft.approval_date} onChange={value => update("approval_date", value)} min={draft.shared_date || undefined} disabled={locked} testID="kitchen-design-edit-approval-date" /> : null}
    {!design.approval_date && recordedApprovalDate ? <Text style={type.caption}>Approval was recorded on {displayDate(recordedApprovalDate)}. The actual customer approval date has not been entered.</Text> : null}
    <Choice label="Sent to company" value={draft.handoff_date ? "Yes" : "No"} values={["No", "Yes"]} onChange={value => update("handoff_date", value === "Yes" ? kitchenToday() : "")} disabled={locked || draft.response !== "Approved" || !effectiveApprovalDate} />
    {draft.handoff_date ? <KitchenDateField label="Date sent to company" value={draft.handoff_date} onChange={value => update("handoff_date", value)} min={effectiveApprovalDate} disabled={locked} testID="kitchen-design-edit-handoff" /> : null}
    <TextField label="Internal notes" value={draft.notes} onChangeText={value => update("notes", value)} editable={!locked} multiline testID="kitchen-design-edit-notes" helper="Internal use only. Also records the reason when correcting details or requesting a revision." />
    {invalidHandoff ? <Text accessibilityRole="alert" style={type.bodyMuted}>Company handoff must follow customer approval and cannot precede its date.</Text> : null}
    <Text style={type.caption}>The previous values and your correction remain in History. A new design version is recorded separately.</Text>
    <Button label="Save design details" disabled={locked || stale || invalidHandoff || !draft.presentation_date || !!draft.revision_count && !/^\d+$/.test(draft.revision_count)} onPress={() => { const { source: _source, revision_count: _revisionCount, ...fields } = draft; return command("design_update", { ...fields, version_id: design.id, shared_date: draft.shared_date || null, handoff_date: draft.handoff_date || null, approval_date: draft.approval_date || null, reason: draft.notes.trim() || "Updated design details" }); }} testID="kitchen-design-edit-save" />
    <Button label="Request revised design (+1)" variant="secondary" disabled={disabled || stale || project.design_revision_pending || !draft.notes.trim() || design.id !== project.design_versions?.at(-1)?.id || design.response === "Approved" && !project.permissions?.can_approve_exceptions} onPress={() => command("design_revision", { version_id: design.id, reason: draft.notes.trim() })} testID="kitchen-design-revision" />
  </Disclosure>;
}

/** Controlled disclosure keeps optional task drafts and expansion through sibling navigation. */
function Disclosure({ draftKey, label, testID, children }: { draftKey: string; label: string; testID: string; children: ReactNode }) {
  const [expanded, setExpanded] = useKitchenDraft(`${draftKey}.expanded`, false);
  const contentId = useId();
  return <View style={{ gap: spacing.md }}>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ expanded }} aria-expanded={expanded} aria-controls={contentId}
      onPress={() => setExpanded(value => !value)}
      style={({ pressed, hovered }: any) => ({ minHeight: 44, padding: spacing.md, borderRadius: radius.md,
        backgroundColor: pressed || hovered ? colors.surfaceTertiary : colors.surfaceSecondary,
        borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: spacing.md })}>
      <Text style={[type.bodyStrong, { flex: 1 }]}>{label}</Text>
      <Text style={type.bodyMuted} accessibilityElementsHidden importantForAccessibility="no">{expanded ? "−" : "+"}</Text>
    </Pressable>
    {expanded ? <View nativeID={contentId} style={{ gap: spacing.md }}>{children}</View> : null}
  </View>;
}
function WorkForm({ value, onChange, production, disabled }: { value: KitchenWork; onChange: (value: KitchenWork) => void; production: boolean; disabled: boolean }) {
  return <View style={{ gap: spacing.md }}>
    <Choice label={production ? "Production status" : "Installation status"} value={value.status} values={production ? ["Not Started", "In Production", "Completed"] : ["Not Started", "In Progress", "Completed"]} onChange={status => onChange({ ...value, status,
      start_date: status === "Not Started" ? null : value.start_date || kitchenToday(),
      completion_date: status === "Completed" ? value.completion_date || kitchenToday() : null,
    })} disabled={disabled} testID={`kitchen-${production ? "production" : "installation"}-status`} />
    <KitchenFieldRow><View style={{ flex: 1, minWidth: 180 }}><KitchenDateField label="Start date" value={value.start_date || ""} onChange={start_date => onChange({ ...value, start_date: start_date || null })} disabled={disabled} testID={`kitchen-${production ? "production" : "installation"}-start`} /></View>
    <View style={{ flex: 1, minWidth: 180 }}><KitchenDateField label="Completion date" value={value.completion_date || ""} onChange={completion_date => onChange({ ...value, completion_date: completion_date || null })} min={value.start_date || undefined} disabled={disabled} testID={`kitchen-${production ? "production" : "installation"}-complete`} /></View></KitchenFieldRow>
    <TextField label="Internal notes" testID={`kitchen-${production ? "production" : "installation"}-notes`} value={value.notes || ""} onChangeText={notes => onChange({ ...value, notes })} editable={!disabled} multiline />
  </View>;
}
