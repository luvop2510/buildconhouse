import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Alert } from "@/src/components/ds";
import { KITCHEN_STAGES, STAGE_LABELS, type KitchenCommand, type KitchenProject, type KitchenStage, type KitchenWork } from "@/src/api/kitchenProjects";
import { Choice, displayDate, KitchenPanel, KitchenDetails, historicalCount, rupees } from "./shared";
import { KitchenSelect, KitchenDateField } from "./KitchenFilters";
import { kitchenToday } from "./KitchenDates";
import { kitchenOrderContext, kitchenProductionStarted, kitchenOrderQuotations } from "./KitchenVersions";
import { DesignStage } from "./DesignStage";
import { QuotationStage } from "./QuotationStage";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";
import { radius, spacing } from "@/src/theme/tokens";
import { KitchenButton as Button, KitchenTextField as TextField, KitchenFieldRow, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";

export type StageCommand = (command: KitchenCommand, payload: Record<string, unknown>) => Promise<boolean>;
type CommercialProps = { project: KitchenProject; stage: KitchenStage; disabled: boolean; command: StageCommand; mode?: "task" | "amendment" };
export function CommercialStages(props: CommercialProps) {
  return props.mode === "amendment" ? <OrderAmendment {...props} /> : <StageForms {...props} />;
}
function StageForms({ project, stage, disabled, command }: CommercialProps) {
  const { submission, loading, failure } = useKitchenProject();
  const savingWorkAndStage = useRef(false);
  const [quoteView, setQuoteView] = useState<string>();
  const savedContext = kitchenOrderContext(project);
  const latestDesign = project.design_versions?.at(-1);
  const currentDesign = (latestDesign?.workflow_cycle ?? 1) === (project.workflow_cycle ?? 1) ? latestDesign : undefined;
  const order = savedContext.order;
  const productionStarted = kitchenProductionStarted(project);
  const design = stage === "order" && order ? savedContext.design : currentDesign;
  const validOrderQuotes = kitchenOrderQuotations(project);
  const designQuotes = project.quotation_versions?.filter(row => row.design_version_id === design?.id) || [];
  const quote = project.quotation_versions?.find(row => row.id === quoteView && (stage === "order" || row.design_version_id === design?.id)) || (stage === "order" && order ? savedContext.quotation : stage === "order" ? validOrderQuotes.at(-1) || designQuotes.at(-1) : designQuotes.at(-1));
  const quoteDesign = project.design_versions?.find(row => row.id === quote?.design_version_id);
  const draftCycle = `commercial.cycle.${project.workflow_cycle ?? 1}`;
  const today = kitchenToday();
  const [orderDate, setOrderDate] = useKitchenDraft(`${draftCycle}.order.date`, order?.order_date || "");
  const [orderNotes, setOrderNotes] = useKitchenDraft(`${draftCycle}.order.notes`, order?.notes || "");
  const [finalAmount, setFinalAmount] = useKitchenDraft(`${draftCycle}.order.finalAmount.${quote?.id || "new"}`, "");
  const [amountApproved, setAmountApproved] = useKitchenDraft(`${draftCycle}.order.amountApproved`, "Not recorded");
  const changedAmount = Boolean(quote?.amount != null && Number(finalAmount) !== Number(quote.amount));
  const savedConfirmation = project.customer_order_confirmation || (order?.confirmed ? "Yes" : order ? "No" : "Not recorded");
  const [orderConfirmed, setOrderConfirmed] = useKitchenDraft(`${draftCycle}.order.confirmed`, savedConfirmation);
  const [orderStatus, setOrderStatus] = useKitchenDraft(`${draftCycle}.order.status`, order?.status || "Confirmed");
  const [orderStatusReason, setOrderStatusReason] = useKitchenDraft(`${draftCycle}.order.statusReason`, "");
  const [advanceReceived, setAdvanceReceived] = useKitchenDraft(`${draftCycle}.order.advanceReceived`, order?.advance.status || (order?.advance.received ? "Yes" : order ? "No" : "Not recorded"));
  const [advanceAmount, setAdvanceAmount] = useKitchenDraft(`${draftCycle}.order.advanceAmount`, order?.advance.received ? order.advance.amount : "");
  const [advanceDate, setAdvanceDate] = useKitchenDraft(`${draftCycle}.order.advanceDate`, order?.advance.date || "");
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
  const locked = disabled || !active;
  const next: Partial<Record<KitchenStage, KitchenStage>> = { design: "quotation", quotation: "order", order: "production", production: "installation", installation: "completed" };
  const target = next[stage];
  const reason = project.blocked_transitions?.find(row => row.target_stage === target)?.reason;
  const validAmount = (value: string, positive = false) => /^\d+(?:\.\d{1,2})?$/.test(value.trim()) && value.trim().length <= 32 && Number(value) <= 1_000_000_000_000 && (positive ? Number(value) > 0 : Number(value) >= 0);
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

  const advanceForm = <View style={{ gap: spacing.md }}>
          <Choice label="Advance received" value={advanceReceived} values={["Not recorded", "Yes", "No"]} onChange={setAdvanceReceived} disabled={locked} testID="kitchen-advance-received" />
          <TextField label="Advance amount (INR)" value={advanceAmount} onChangeText={setAdvanceAmount} editable={!locked} keyboardType="decimal-pad" testID="kitchen-advance-amount" />
          {dateField("Advance receipt date", advanceDate, setAdvanceDate, "kitchen-advance-date")}
          {!order ? <Text style={type.caption}>Confirm the customer order above before saving an advance. Pending is the normal status before confirmation.</Text> : advanceReceived !== "Yes" && Boolean(Number(advanceAmount) || advanceDate) ? <Text style={type.caption}>An amount or receipt date requires Yes. Edit the status or clear those entries.</Text> : advanceReceived === "Yes" && (!validAmount(advanceAmount, true) || !advanceDate) ? <Text style={type.caption}>Enter a positive amount received and its receipt date.</Text> : null}
          <Button label="Save advance details" disabled={locked || !order || (advanceReceived === "Yes" ? !validAmount(advanceAmount, true) || !advanceDate : Boolean(Number(advanceAmount) || advanceDate))} onPress={() => command("order_advance", { status: advanceReceived, received: advanceReceived === "Yes", amount: advanceAmount.trim() || "0.00", date: advanceDate || null })} testID="kitchen-advance-save" />
  </View>;

  return <View style={{ gap: spacing.lg, display: ["lead", "visit", "cad"].includes(stage) ? "none" : "flex" }}>
    {!active && !preview && stage !== "completed" ? <Alert tone="info" title="Stage record" description="Review the saved stage record here. Use the current stage for ongoing work; previous versions are in History." /> : null}
    {stage === "design" ? <DesignStage project={project} disabled={disabled} command={command} /> : stage === "quotation" ? <QuotationStage project={project} disabled={disabled} command={command} /> : stage === "order" ? <>
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
          <TextField label="Final order amount (INR)" value={finalAmount} onChangeText={setFinalAmount} keyboardType="decimal-pad" editable={!locked} testID="kitchen-order-amount" />
          {changedAmount ? <Choice label="Customer approved changed final amount" value={amountApproved} values={["Not recorded", "Yes", "No"]} onChange={setAmountApproved} disabled={locked} testID="kitchen-order-amount-approved" /> : null}
          <TextField label="Internal notes" value={orderNotes} onChangeText={setOrderNotes} editable={!locked} multiline testID="kitchen-order-notes" />
          {!validAmount(finalAmount) && !orderRequirement ? <Text style={type.caption}>Enter the final order amount in INR, with up to two decimal places.</Text> : null}
          {orderConfirmed !== "Yes" ? <Text style={type.caption}>Select Yes once the customer has confirmed the order.</Text> : null}
          {changedAmount ? <Text style={type.caption}>A changed amount requires owner authorization and the customer’s explicit approval.</Text> : null}
          <Button label="Confirm customer order" disabled={locked || !validAmount(finalAmount) || !orderDate || changedAmount && (!project.permissions?.can_approve_exceptions || amountApproved !== "Yes") || orderConfirmed !== "Yes" || Boolean(orderRequirement)} onPress={() => command("order_confirm", { final_amount: finalAmount, amount_customer_approved: amountApproved === "Yes", quotation_version_id: quote!.id, order_date: orderDate, notes: orderNotes || null })} testID="kitchen-order-confirm" />
        </View> : null}
        {active && order && project.permissions?.can_approve_exceptions ? <View style={{ gap: spacing.md }}>
          <Choice label="Order status" value={orderStatus} values={["Confirmed", "On Hold", "Cancelled"]} onChange={setOrderStatus} disabled={statusLocked} testID="kitchen-order-status" />
          <TextField label="Internal notes" value={orderStatusReason} onChangeText={setOrderStatusReason} multiline editable={!statusLocked} helper="Explain the status change for the internal history." testID="kitchen-order-status-notes" />
          <Button label="Save order status" disabled={statusLocked || !orderStatusReason.trim()} onPress={() => command("order_status", { status: orderStatus, reason: orderStatusReason })} testID="kitchen-order-status-save" />
        </View> : null}
        {active && order ? <OrderEditor project={project} order={order} disabled={locked} command={command} /> : null}
      </KitchenPanel>
      {active && order && project.permissions?.can_approve_exceptions ? <CommercialStages project={project} stage={stage} disabled={disabled} command={command} mode="amendment" /> : null}
      {preview || active && !order ? <KitchenPanel title="Advance payment">{advanceForm}</KitchenPanel> : null}
      {preview ? approval("production") : null}
      {order ? <>
        <KitchenPanel title="Advance payment"><KitchenDetails testID="kitchen-advance-details" items={[
          { label: "Advance payment received", value: order.advance.status || (order.advance.received ? "Yes" : "No") },
          { label: "Advance amount", value: order.advance.received ? rupees(order.advance.amount) : "—" },
          { label: "Advance date", value: displayDate(order.advance.date) },
        ]} />
        {active ? advanceForm : null}
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
        {(active || preview) ? <View style={{ gap: spacing.md }}>        <WorkForm value={stage === "production" ? production : installation} onChange={stage === "production" ? setProduction : setInstallation} production={stage === "production"} disabled={locked} />
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
  const [draft, setDraft] = useKitchenDraft(prefix, { source, order_date: order.order_date, notes: order.notes || "", quotation_version_id: order.quotation_version_id, amount_customer_approved: "Not recorded" });
  const stale = draft.source !== source;
  return <View style={{ gap: spacing.md }}>
    {stale ? <><Text style={type.bodyMuted}>These order details changed after you started editing. Your draft is kept until you replace it with the latest saved values.</Text><Button label="Replace draft with latest order details" variant="secondary" onPress={() => resetDraftValue(prefix)} testID="kitchen-order-edit-reload" /></> : null}
    <KitchenDateField label="Order date" value={draft.order_date} onChange={order_date => setDraft(previous => ({ ...previous, order_date }))} disabled={disabled} testID="kitchen-order-edit-date" />
    {!productionStarted && !disabled ? <KitchenSelect label="Quotation revision used for order" value={draft.quotation_version_id} options={validQuotes.map(quote => ({ value: quote.id, label: `Quotation r${quote.number} · Design v${project.design_versions?.find(design => design.id === quote.design_version_id)?.number ?? "unavailable"}` }))} onChange={quotation_version_id => setDraft(previous => ({ ...previous, quotation_version_id }))} testID="kitchen-order-edit-quotation" /> : <Text style={type.caption}>Order versions are fixed after production starts. The owner can use Return to Design for changes.</Text>}
    {draft.quotation_version_id !== order.quotation_version_id ? <Choice label="Customer approved retained final amount" value={draft.amount_customer_approved} values={["Not recorded", "Yes", "No"]} onChange={value => setDraft(previous => ({ ...previous, amount_customer_approved: value }))} disabled={disabled} /> : null}
    <TextField label="Internal notes" value={draft.notes} onChangeText={notes => setDraft(previous => ({ ...previous, notes }))} editable={!disabled} multiline testID="kitchen-order-edit-notes" />
    <Button label="Save order details" disabled={disabled || stale || !draft.order_date} onPress={() => command("order_update", { order_date: draft.order_date, notes: draft.notes || null, ...(draft.quotation_version_id !== order.quotation_version_id ? { quotation_version_id: draft.quotation_version_id, amount_customer_approved: draft.amount_customer_approved === "Yes" } : {}) })} testID="kitchen-order-edit-save" />
  </View>;
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
    <Choice label={production ? "Production status" : "Installation status"} value={value.status} values={production ? ["Not Started", "In Production", "Completed"] : ["Not Started", "In Progress", "Completed"]} onChange={status => onChange({ ...value, status })} disabled={disabled} testID={`kitchen-${production ? "production" : "installation"}-status`} />
    <KitchenFieldRow><View style={{ flex: 1, minWidth: 180 }}><KitchenDateField label="Start date" value={value.start_date || ""} onChange={start_date => onChange({ ...value, start_date: start_date || null })} disabled={disabled} testID={`kitchen-${production ? "production" : "installation"}-start`} /></View>
    <View style={{ flex: 1, minWidth: 180 }}><KitchenDateField label="Completion date" value={value.completion_date || ""} onChange={completion_date => onChange({ ...value, completion_date: completion_date || null })} min={value.start_date || undefined} disabled={disabled} testID={`kitchen-${production ? "production" : "installation"}-complete`} /></View></KitchenFieldRow>
    <TextField label="Internal notes" testID={`kitchen-${production ? "production" : "installation"}-notes`} value={value.notes || ""} onChangeText={notes => onChange({ ...value, notes })} editable={!disabled} multiline />
  </View>;
}

function OrderAmendment({ project, disabled, command }: CommercialProps) {
  const draftCycle = `commercial.cycle.${project.workflow_cycle ?? 1}`;
  const order = kitchenOrderContext(project).order;
  const latestOrder = project.orders?.at(-1);
  const [amendAmount, setAmendAmount] = useKitchenDraft(`${draftCycle}.order.amendAmount`, order?.final_amount || "");
  const [amendDate, setAmendDate] = useKitchenDraft(`${draftCycle}.order.amendDate`, "");
  const [amendReason, setAmendReason] = useKitchenDraft(`${draftCycle}.order.amendReason`, "");
  const [amendApproved, setAmendApproved] = useKitchenDraft(`${draftCycle}.order.amendApproved`, "Not recorded");
  if (!project.permissions?.can_approve_exceptions) return <Alert tone="info" title="Owner authorization required" description="Only the owner can record restricted changes to approved commercial terms." />;
  if (project.stage !== "order") return <KitchenPanel title="Preserved order terms">
    <KitchenDetails items={[
      { label: "Original amount", value: rupees(latestOrder?.original_amount) },
      { label: "Final approved amount", value: rupees(latestOrder?.final_amount) },
    ]} />
    <Text style={type.bodyMuted}>Commercial amendments are available during Order. To change the approved design or commercial basis at this stage, use Return to Design above with a reason. Earlier orders, work and approvals stay in History.</Text>
  </KitchenPanel>;
  return order ? <KitchenPanel title="Approved order amendment"><Text style={type.caption}>The original order remains preserved. Changed commercial terms require explicit customer approval.</Text>
          <TextField label="Amended final amount (INR)" value={amendAmount} onChangeText={setAmendAmount} editable={!disabled} keyboardType="decimal-pad" testID="kitchen-amend-amount" />
          <KitchenDateField label="Amendment approval date" value={amendDate} onChange={setAmendDate} disabled={disabled} testID="kitchen-amend-date" />
          <TextField label="Internal notes" value={amendReason} onChangeText={setAmendReason} editable={!disabled} multiline testID="kitchen-amend-reason" />
          <Choice label="Customer approved amended terms" value={amendApproved} values={["Not recorded", "Yes", "No"]} onChange={setAmendApproved} disabled={disabled} testID="kitchen-amend-approved" />
          <Button label="Record approved amendment" disabled={disabled || !project.permissions?.can_approve_exceptions || amendApproved !== "Yes" || !amendReason.trim() || !amendDate || !/^\d+(?:\.\d{1,2})?$/.test(amendAmount)} onPress={() => command("order_amend", { amount: amendAmount, date: amendDate, reason: amendReason, customer_approved: true })} testID="kitchen-amend-save" />
        </KitchenPanel> : <KitchenPanel title="Approved order amendment"><Text style={type.bodyMuted}>No current order to amend. Confirm an order against the current approved quotation first.</Text></KitchenPanel>;

}
