import { useEffect, useId, useRef, type ReactNode } from "react";
import { Linking, Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Alert, Button, TextField } from "@/src/components/ds";
import { STAGE_LABELS, type KitchenCommand, type KitchenProject, type KitchenStage, type KitchenWork } from "@/src/api/kitchenProjects";
import { Choice, displayDate, KitchenPanel, historicalCount, rupees } from "./shared";
import { KitchenDateField } from "./KitchenFilters";
import { DocumentChoice } from "./KitchenDocuments";
import { useKitchenDraft } from "./KitchenProjectState";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

export type StageCommand = (command: KitchenCommand, payload: Record<string, unknown>) => Promise<boolean>;
export function CommercialStages({ project, stage, disabled, command, hasUnsavedChanges = false, mode = "task" }: { project: KitchenProject; stage: KitchenStage; disabled: boolean; command: StageCommand; hasUnsavedChanges?: boolean; mode?: "task" | "amendment" }) {
  const latestDesign = project.design_versions?.at(-1);
  const design = (latestDesign?.workflow_cycle ?? 1) === (project.workflow_cycle ?? 1) ? latestDesign : undefined;
  const latestQuote = project.quotation_versions?.at(-1);
  const quote = latestQuote?.design_version_id === design?.id ? latestQuote : undefined;
  const latestOrder = project.orders?.at(-1);
  const order = !project.commercial_basis_invalidated && latestOrder?.quotation_version_id === quote?.id ? latestOrder : undefined;
  const draftCycle = `commercial.cycle.${project.workflow_cycle ?? 1}`;
  const responseScope = stage === "design" ? `design.${design?.id || "new"}` : `quotation.${quote?.id || "new"}`;
  const [presentationDate, setPresentationDate] = useKitchenDraft(`${draftCycle}.design.date`, "");
  const [designFile, setDesignFile] = useKitchenDraft(`${draftCycle}.design.file`, "");
  const [designUrl, setDesignUrl] = useKitchenDraft(`${draftCycle}.design.url`, "");
  const [designNotes, setDesignNotes] = useKitchenDraft(`${draftCycle}.design.notes`, "");
  const [shareDate, setShareDate] = useKitchenDraft(`${draftCycle}.${responseScope}.shareDate`, "");
  const [handoffDate, setHandoffDate] = useKitchenDraft(`${draftCycle}.design.${design?.id || "new"}.handoffDate`, "");
  const [response, setResponse] = useKitchenDraft(`${draftCycle}.${responseScope}.response`, "Pending");
  const [responseNotes, setResponseNotes] = useKitchenDraft(`${draftCycle}.${responseScope}.responseNotes`, "");
  const [revisionReason, setRevisionReason] = useKitchenDraft(`${draftCycle}.design.${design?.id || "new"}.revisionReason`, "");
  const [quoteDate, setQuoteDate] = useKitchenDraft(`${draftCycle}.quotation.date`, "");
  const [quoteAmount, setQuoteAmount] = useKitchenDraft(`${draftCycle}.quotation.amount`, "");
  const [quoteFile, setQuoteFile] = useKitchenDraft(`${draftCycle}.quotation.file`, "");
  const [quoteUrl, setQuoteUrl] = useKitchenDraft(`${draftCycle}.quotation.url`, "");
  const [quoteNotes, setQuoteNotes] = useKitchenDraft(`${draftCycle}.quotation.notes`, "");
  const [orderDate, setOrderDate] = useKitchenDraft(`${draftCycle}.order.date`, "");
  const [orderFile, setOrderFile] = useKitchenDraft(`${draftCycle}.order.file`, "");
  const [orderNotes, setOrderNotes] = useKitchenDraft(`${draftCycle}.order.notes`, "");
  const [advanceReceived, setAdvanceReceived] = useKitchenDraft(`${draftCycle}.order.advanceReceived`, "Not recorded");
  const [advanceAmount, setAdvanceAmount] = useKitchenDraft(`${draftCycle}.order.advanceAmount`, "");
  const [advanceDate, setAdvanceDate] = useKitchenDraft(`${draftCycle}.order.advanceDate`, "");
  const [amendAmount, setAmendAmount] = useKitchenDraft(`${draftCycle}.order.amendAmount`, "");
  const [amendDate, setAmendDate] = useKitchenDraft(`${draftCycle}.order.amendDate`, "");
  const [amendReason, setAmendReason] = useKitchenDraft(`${draftCycle}.order.amendReason`, "");
  const [amendApproved, setAmendApproved] = useKitchenDraft(`${draftCycle}.order.amendApproved`, "Not recorded");
  const [production, setProduction] = useKitchenDraft<KitchenWork>(`${draftCycle}.production`, project.production || { status: "Not Started" });
  const [installation, setInstallation] = useKitchenDraft<KitchenWork>(`${draftCycle}.installation`, project.installation || { status: "Not Started" });
  const [siteDate, setSiteDate] = useKitchenDraft(`${draftCycle}.site.date`, "");
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
  const locked = disabled || !active;
  const next: Partial<Record<KitchenStage, KitchenStage>> = { design: "quotation", quotation: "order", order: "production", production: "installation", installation: "completed" };
  const target = next[stage];
  const reason = project.blocked_transitions?.find(row => row.target_stage === target)?.reason;
  const dateField = (label: string, value: string, onChange: (value: string) => void, id: string) => <KitchenDateField label={label} value={value} onChange={onChange} disabled={locked} testID={id} />;
  const responseForm = (isDesign: boolean) => {
    const version = isDesign ? design : quote;
    if (!active || !version || (isDesign && project.design_revision_pending)) return null;
    return !version.shared_date ? <KitchenPanel title="Share with the customer">
      <Text style={type.bodyMuted}>Record when you actually shared version {version.number}. This does not send a message.</Text>
      {dateField("Date shared with customer", shareDate, setShareDate, "kitchen-version-share-date")}
      <Button label="Record shared with customer" disabled={locked || !shareDate} onPress={() => command(isDesign ? "design_share" : "quotation_share", { version_id: version.id, date: shareDate })} testID="kitchen-version-share" />
    </KitchenPanel> : version.response !== "Approved" ? <KitchenPanel title="Record the customer’s response">
      <Choice label="Customer response" value={response} values={isDesign ? ["Pending", "Approved", "Changes Required"] : ["Pending", "Approved", "Changes Required", "Rejected"]} onChange={setResponse} disabled={locked} testID="kitchen-version-response" />
      <TextField label="Customer response notes" value={responseNotes} onChangeText={setResponseNotes} editable={!locked} multiline />
      <Button label="Record customer response" disabled={locked} onPress={() => command(isDesign ? "design_response" : "quotation_response", { version_id: version.id, response, notes: responseNotes || null })} testID="kitchen-version-response-save" />
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
      <Text style={type.body}>{lastDecision ? `Last recorded decision: ${lastDecision.decision} · ${displayDate(lastDecision.at)}` : "Awaiting the selected department manager."}</Text>
      <Text style={type.bodyMuted}>The next-stage check verifies approval against the current work and policy. Customer approval is recorded separately.</Text>
      {canApprove ? lastDecision && !reason?.toLowerCase().includes("manager") ? <Disclosure draftKey={`${draftCycle}.${scope}.decision`} label="Record another manager decision" testID={`kitchen-disclose-${scope}-decision`}>{decisionForm}</Disclosure> : decisionForm : <Text style={type.bodyMuted}>Only a manager explicitly selected in the current policy can record this decision.</Text>}
    </KitchenPanel>;
  };

  const designForm = <View style={{ gap: spacing.md }}>
        {dateField("Presentation date", presentationDate, setPresentationDate, "kitchen-design-date")}
        <DocumentChoice project={project} value={designFile} onChange={setDesignFile} disabled={locked} label="Design presentation document" />
        <TextField label="Design presentation HTTPS link" value={designUrl} onChangeText={setDesignUrl} editable={!locked} autoCapitalize="none" testID="kitchen-design-url" />
        <TextField label="Design notes" value={designNotes} onChangeText={setDesignNotes} editable={!locked} multiline />
        <Button label={design ? "Present new design version / internal correction" : project.design_versions?.length ? "Present revised design" : "Present first design"} disabled={locked || (!designFile && !designUrl.trim()) || (design?.response === "Approved" && !project.design_revision_pending)} onPress={() => command("design_present", { presentation_date: presentationDate, attachment_id: designFile || null, url: designUrl || null, notes: designNotes || null })} testID="kitchen-design-present" />
        <Text style={type.caption}>A presentation or internal correction does not increase the customer revision count.</Text>

  </View>;

  const quoteForm = <View style={{ gap: spacing.md }}>
        {dateField("Quotation received date", quoteDate, setQuoteDate, "kitchen-quotation-date")}
        <TextField label="Quotation amount (INR)" value={quoteAmount} onChangeText={setQuoteAmount} keyboardType="decimal-pad" editable={!locked} testID="kitchen-quotation-amount" />
        <DocumentChoice project={project} value={quoteFile} onChange={setQuoteFile} disabled={locked} label="Quotation document" />
        <TextField label="Quotation HTTPS link" value={quoteUrl} onChangeText={setQuoteUrl} autoCapitalize="none" editable={!locked} testID="kitchen-quotation-url" />
        <TextField label="Quotation notes" value={quoteNotes} onChangeText={setQuoteNotes} editable={!locked} multiline />
        <Button label="Record received quotation version" disabled={locked || (!quoteFile && !quoteUrl.trim()) || !design || design.response !== "Approved" || !design.handoff_date || Boolean(project.design_revision_pending)} onPress={() => command("quotation_receive", { design_version_id: design!.id, amount: quoteAmount, received_date: quoteDate, attachment_id: quoteFile || null, url: quoteUrl || null, notes: quoteNotes || null })} testID="kitchen-quotation-receive" />

  </View>;

  const advanceForm = <View style={{ gap: spacing.md }}>
          <Choice label="Advance received" value={advanceReceived} values={["Not recorded", "Yes", "No"]} onChange={setAdvanceReceived} disabled={locked} testID="kitchen-advance-received" />
          <TextField label="Advance amount (INR)" value={advanceAmount} onChangeText={setAdvanceAmount} editable={!locked} keyboardType="decimal-pad" testID="kitchen-advance-amount" />
          {dateField("Advance receipt date", advanceDate, setAdvanceDate, "kitchen-advance-date")}
          <Button label="Record advance payment" disabled={locked || advanceReceived === "Not recorded"} onPress={() => command("order_advance", { received: advanceReceived === "Yes", amount: advanceReceived === "No" ? "0.00" : advanceAmount, date: advanceReceived === "No" ? null : advanceDate || null })} testID="kitchen-advance-save" />
  </View>;

  if (mode === "amendment" && !project.permissions?.can_approve_exceptions) return <Alert tone="info" title="Owner authorization required" description="Only the owner can record restricted changes to approved commercial terms." />;
  if (mode === "amendment" && project.stage !== "order") return <KitchenPanel title="Preserved order terms">
    <Text style={type.bodyStrong}>{latestOrder ? `Original ${rupees(latestOrder.original_amount)} · Final approved ${rupees(latestOrder.final_amount)}` : "No order recorded"}</Text>
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
    {!active && stage !== "completed" ? <Alert tone="info" title="Stage record" description="Review the saved stage record here. Use the current stage for ongoing work; previous versions are in History." /> : null}
    {stage === "design" ? <>
      <KitchenPanel title="Design presentation"><Text style={type.bodyStrong}>{design ? `Current design · Version ${design.number}` : "No current design recorded"}</Text><Text style={type.body}>Customer-requested revisions: {historicalCount(project.design_revision_count, project.known_design_revision_count)}</Text>
        <Text style={type.body}>Customer approval: {design?.response || "Pending"} · Shared: {displayDate(design?.shared_date)}</Text>
        <Text style={type.body}>Presented: {displayDate(design?.presentation_date)}</Text>
        {design?.attachment_id ? <Text style={type.bodyMuted}>Document: {project.attachments?.find(file => file.id === design.attachment_id)?.filename || "Saved project attachment"}</Text> : null}
        {design?.notes ? <Text style={type.bodyMuted}>{design.notes}</Text> : null}
        {design?.response_notes ? <Text style={type.bodyMuted}>Customer response notes: {design.response_notes}</Text> : null}
        {design?.url ? <Button label="Open current design reference" variant="secondary" onPress={() => void Linking.openURL(design.url!)} /> : null}
        <Text style={type.body}>Company handoff: {design?.handoff_date ? displayDate(design.handoff_date) : "Not recorded"}</Text>
        {project.design_revision_pending ? <Alert tone="warning" title="Revised design required" description="Present a new version before recording customer approval." /> : null}
        {active && (!design || project.design_revision_pending) ? designForm : active && design?.response !== "Approved" ? <Disclosure draftKey={`${draftCycle}.design.newVersion`} label="Present a new version or correction" testID="kitchen-disclose-design-version">{designForm}</Disclosure> : null}
      </KitchenPanel>
      {responseForm(true)}
      {active && design?.response === "Approved" && !project.design_revision_pending && !design.handoff_date ? <KitchenPanel title="Send the approved design to the company">
        {dateField("Date sent to company", handoffDate, setHandoffDate, "kitchen-design-handoff-date")}
        <Button label="Mark approved design sent to company" disabled={locked || !design || design.response !== "Approved" || Boolean(project.design_revision_pending) || Boolean(design.handoff_date)} onPress={() => command("design_handoff", { version_id: design!.id, date: handoffDate })} testID="kitchen-design-handoff" />
      </KitchenPanel> : null}
      {active && design && !project.design_revision_pending ? <KitchenPanel title="Customer changes"><Disclosure draftKey={`${draftCycle}.design.${design.id}.revision`} label="Record a customer revision request" testID="kitchen-disclose-design-revision">
        {design.response === "Approved" ? <Text style={type.bodyMuted}>Only the owner can authorize a change to an approved design. Its previous approval remains in History.</Text> : null}
        <TextField label="Customer-requested revision reason" value={revisionReason} onChangeText={setRevisionReason} editable={!locked} multiline testID="kitchen-design-revision-reason" />
        <Button label="Record customer revision request (+1)" disabled={locked || !design || Boolean(project.design_revision_pending) || (design?.response === "Approved" && !project.permissions?.can_approve_exceptions) || !revisionReason.trim()} onPress={() => { void command("design_revision", { version_id: design!.id, reason: revisionReason }).then(saved => { if (saved) setRevisionReason(""); }); }} testID="kitchen-design-revision" />
      </Disclosure></KitchenPanel> : null}
    </> : stage === "quotation" ? <>
      <KitchenPanel title="Company quotation"><Text style={type.bodyStrong}>{quote ? `Current quotation · Version ${quote.number} · ${rupees(quote.amount)}` : "No current quotation recorded"}</Text><Text style={type.bodyMuted}>Based on current approved design {design ? `version ${design.number}` : "—"}. Each new quotation requires its own sharing and customer approval.</Text>
        <Text style={type.body}>Received: {displayDate(quote?.received_date)}</Text>
        {quote?.attachment_id ? <Text style={type.bodyMuted}>Document: {project.attachments?.find(file => file.id === quote.attachment_id)?.filename || "Saved project attachment"}</Text> : null}
        {quote?.notes ? <Text style={type.bodyMuted}>{quote.notes}</Text> : null}
        {quote?.response_notes ? <Text style={type.bodyMuted}>Customer response notes: {quote.response_notes}</Text> : null}
        {quote?.url ? <Button label="Open current quotation reference" variant="secondary" onPress={() => void Linking.openURL(quote.url!)} /> : null}
        <Text style={type.body}>Quotation received: {quote ? "Yes" : "No"} · Quotation sent to customer: {quote?.shared_date ? "Yes" : "No"}</Text>
        <Text style={type.body}>Date sent to customer: {displayDate(quote?.shared_date)} · Customer response: {quote?.response || "Pending"}</Text>
        {active ? !quote ? quoteForm : <Disclosure draftKey={`${draftCycle}.quotation.newVersion`} label="Record a revised company quotation" testID="kitchen-disclose-quotation-version">{quoteForm}</Disclosure> : null}
      </KitchenPanel>
      {responseForm(false)}
    </> : stage === "order" ? <>
      <KitchenPanel title="Order confirmation">
        <Text style={type.body}>Customer order confirmation: {order?.confirmed ? "Yes" : "No"} · Order status: {order?.status || "Pending"}</Text>
        <Text style={type.body}>Current approved quotation: {quote ? `Version ${quote.number} · ${rupees(quote.amount)}` : "None"}</Text>
        {order ? <><Text style={type.bodyStrong}>{order.status} · {displayDate(order.order_date)}</Text><Text style={type.body}>Original amount {rupees(order.original_amount)} · Approved final amount {rupees(order.final_amount)}</Text><Text style={type.body}>{order.notes}</Text></> : active ? <>
          {dateField("Order date", orderDate, setOrderDate, "kitchen-order-date")}
          <DocumentChoice project={project} value={orderFile} onChange={setOrderFile} disabled={locked} label="Order confirmation document" />
          <TextField label="Order notes" value={orderNotes} onChangeText={setOrderNotes} editable={!locked} multiline />
          <Button label="Confirm customer order" disabled={locked || !quote || quote.response !== "Approved" || !quote.shared_date} onPress={() => command("order_confirm", { quotation_version_id: quote!.id, order_date: orderDate, confirmation_document_id: orderFile || null, notes: orderNotes || null })} testID="kitchen-order-confirm" />
        </> : <Text style={type.bodyMuted}>No current order recorded.</Text>}
        {active && order && !order.confirmation_document_id ? <Disclosure draftKey={`${draftCycle}.order.document`} label="Add an order confirmation document (optional)" testID="kitchen-disclose-order-document"><DocumentChoice project={project} value={orderFile} onChange={setOrderFile} disabled={locked} label="Order confirmation document" /><Button label="Attach missing order confirmation" disabled={locked || !orderFile} onPress={() => command("order_document", { attachment_id: orderFile })} testID="kitchen-order-document" /></Disclosure> : order?.confirmation_document_id ? <Text style={type.body}>Confirmation document: {project.attachments?.find(file => file.id === order.confirmation_document_id)?.filename || "Saved project attachment"}</Text> : null}
      </KitchenPanel>
      {order ? <>
        <KitchenPanel title="Advance payment"><Text style={type.body}>Saved: {order.advance.received ? `${rupees(order.advance.amount)} received ${displayDate(order.advance.date)}` : "Not received"}</Text>
        {active ? order.advance.received ? <Disclosure draftKey={`${draftCycle}.order.advanceEdit`} label="Update the advance payment record" testID="kitchen-disclose-advance">{advanceForm}</Disclosure> : advanceForm : null}
        </KitchenPanel>
{active && order.advance.received ? approval("production") : null}
      </> : null}
    </> : stage === "production" || stage === "installation" ? <>
      <KitchenPanel title={STAGE_LABELS[stage]}>
        <Text style={type.body}>Saved status: {(stage === "production" ? project.production : project.installation)?.status || "Not Started"}</Text>
        <Text style={type.body}>Saved start: {displayDate((stage === "production" ? project.production : project.installation)?.start_date)} · Saved completion: {displayDate((stage === "production" ? project.production : project.installation)?.completion_date)}</Text>
        {(stage === "production" ? project.production : project.installation)?.notes ? <Text style={type.body}>{(stage === "production" ? project.production : project.installation)?.notes}</Text> : null}
        {active && (stage === "production" ? project.production : project.installation)?.status !== "Completed" ? <View style={{ gap: spacing.md }}>        <WorkForm value={stage === "production" ? production : installation} onChange={stage === "production" ? setProduction : setInstallation} production={stage === "production"} disabled={locked} />
        <Button label={`Save ${stage}`} disabled={locked || (stage === "production" ? project.production : project.installation)?.status === "Completed"} onPress={() => {
          const work = stage === "production" ? production : installation;
          return command(stage === "production" ? "production_update" : "installation_update", {
            status: work.status, start_date: work.start_date ?? null,
            completion_date: work.completion_date ?? null, notes: work.notes ?? null,
          });
        }} testID={`kitchen-${stage}-save`} /></View> : null}
      </KitchenPanel>
      {stage === "installation" ? <><KitchenPanel title="Installation site visits"><Text style={type.bodyStrong}>Actual site visits: {historicalCount(project.site_visit_count, project.known_site_visit_count)}</Text>
        {active ? <Disclosure draftKey={`${draftCycle}.site.newVisit`} label="Record a site visit" testID="kitchen-disclose-site-visit">        {dateField("Site visit date", siteDate, setSiteDate, "kitchen-site-date")}
        <Choice label="Visit actually took place" value={siteActual} values={["Not recorded", "Yes — actual visit", "No — scheduled only"]} onChange={setSiteActual} disabled={locked} testID="kitchen-site-actual" />
        <TextField label="Site visit notes" value={siteNotes} onChangeText={setSiteNotes} editable={!locked} multiline />
        <Button label="Record site visit" disabled={locked || siteActual === "Not recorded" || !siteDate} onPress={() => { void command("site_visit", { date: siteDate, actual: siteActual === "Yes — actual visit", notes: siteNotes || null }).then(saved => { if (saved) { setSiteDate(""); setSiteActual("Not recorded"); setSiteNotes(""); } }); }} testID="kitchen-site-save" />
        <Text style={type.caption}>Scheduled visits do not increase the actual counter. Record each distinct real visit once.</Text>
</Disclosure> : null}
      </KitchenPanel>{active && project.installation?.status === "Completed" ? approval("closure") : null}</> : null}
    </> : stage === "completed" ? <KitchenPanel title="Completed project"><Text style={type.body}>Installation completion: {displayDate(project.completion_date)}</Text><Text style={type.body}>Final order amount: {rupees(project.order_amount)}</Text><Text style={type.body}>Total design revisions: {historicalCount(project.design_revision_count, project.known_design_revision_count)}</Text><Text style={type.body}>Actual site visits: {historicalCount(project.site_visit_count, project.known_site_visit_count)}</Text><Text style={type.caption}>Review previous versions, orders and approvals in History.</Text></KitchenPanel> : null}
    {active && target ? <View style={{ gap: spacing.md }}>
      {hasUnsavedChanges ? <Text accessibilityLiveRegion="polite" style={type.bodyMuted} testID="kitchen-advance-unsaved">Save or clear your unsaved task changes before continuing. The next stage uses saved, approved records.</Text> : null}
      {reason || project.closure_pending_reason ? <Alert tone="info" title="Prerequisites" description={reason || project.closure_pending_reason || undefined} /> : null}
      <Button label={`Continue to ${STAGE_LABELS[target]}`} disabled={disabled || hasUnsavedChanges || Boolean(reason)} onPress={() => command("advance_stage", { target_stage: target })} testID={`kitchen-advance-${target}`} />
    </View> : null}
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
    <KitchenDateField label="Start date" value={value.start_date || ""} onChange={start_date => onChange({ ...value, start_date: start_date || null })} disabled={disabled} testID={`kitchen-${production ? "production" : "installation"}-start`} />
    <KitchenDateField label="Completion date" value={value.completion_date || ""} onChange={completion_date => onChange({ ...value, completion_date: completion_date || null })} disabled={disabled} testID={`kitchen-${production ? "production" : "installation"}-complete`} />
    <TextField label={production ? "Production notes" : "Installation notes"} value={value.notes || ""} onChangeText={notes => onChange({ ...value, notes })} editable={!disabled} multiline />
  </View>;
}
