import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Linking, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { Alert, ErrorState, LoadingState, Sheet } from "@/src/components/ds";
import { Menu } from "@/src/design/navigationControls";
import { NavigationLink } from "@/src/design/NavigationLink";
import { useBp } from "@/src/design/responsive";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { KITCHEN_STAGES, STAGE_LABELS, type KitchenCad, type KitchenLead, type KitchenProject, type KitchenStage, type KitchenVisit } from "@/src/api/kitchenProjects";
import { Choice, displayDate, ErrorNotice, KitchenFloor, KitchenPage, KitchenPanel, rupees } from "./shared";
import { KitchenDateField } from "./KitchenFilters";
import { kitchenToday } from "./KitchenDates";
import { LeadFields } from "./KitchenLeadFields";
import { spacing } from "@/src/theme/tokens";
import { KitchenButton as Button, KitchenTextField as TextField, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";
import { CommercialStages } from "./CommercialStages";
import { KitchenDocuments } from "./KitchenDocuments";
import { kitchenProjectPath, kitchenStage, useKitchenDraft, useKitchenProject } from "./KitchenProjectState";

type ProjectPage = "overview" | "stage" | "documents" | "history" | "assignments" | "exceptions";

export function KitchenProjectDetail({ page = "stage" }: { page?: ProjectPage }) {
  const canEditCustomer = useActionAccess("customers", "update", false);
  const state = useKitchenProject();
  const { project, loading, failure, policy, policyError, reload, updateProject, submission, command, returnTo, retainedDraft } = state;
  const { stage: parameter } = useLocalSearchParams<{ stage?: string }>();
  const router = useRouter();
  const [panel, setPanel] = useState<ProjectPage | "workflow" | null>(["documents", "history", "assignments", "exceptions"].includes(page) ? page : null);
  const lastStage = useRef(project?.stage);
  useEffect(() => { if (lastStage.current && project?.stage !== lastStage.current) setPanel(null); lastStage.current = project?.stage; }, [project?.stage]);
  const selected = kitchenStage(parameter) || project?.stage || "lead";
  const future = Boolean(project && KITCHEN_STAGES.indexOf(selected) > KITCHEN_STAGES.indexOf(project.stage));
  const path = (suffix = "") => kitchenProjectPath(state.id, suffix, returnTo);
  const canUpdate = project?.permissions?.can_update === true;
  const held = project?.lifecycle_status === "On Hold" || project?.lifecycle_status === "Cancelled";
  const back = () => { if (router.canGoBack()) router.back(); else router.replace(returnTo as any); };
  const actionLabel = project ? currentTaskLabel(project) : "Open current task";
  const disabled = !canUpdate || submission.busy || loading || Boolean(failure);
  if (parameter && !kitchenStage(parameter)) return <KitchenFloor><KitchenPage title="Kitchen" back={back}><ErrorState title="Stage unavailable" subtitle="Choose one of the nine Kitchen stages." /></KitchenPage></KitchenFloor>;
  return <KitchenFloor><KitchenPage title={STAGE_LABELS[selected]} overline={project ? project.project_reference || project.reference : "Kitchen"} back={back}
    right={project ? <Button label="Stage history" icon="list" variant="secondary" onPress={() => setPanel("workflow")} testID="kitchen-open-workflow" /> : undefined}
    contentStyle={{ width: "100%", maxWidth: 1000, alignSelf: "center" }}>
    {failure ? <ErrorState title="Project unavailable" subtitle={failure} onRetry={reload} /> : null}
    {loading && !project ? <LoadingState label="Loading project…" /> : null}
    {project ? <View style={{ gap: spacing.lg }} testID="kitchen-project-detail">
      <View testID={!loading && !failure ? "kitchen-project-ready" : "kitchen-project-loading"} />
      <ProjectSummary project={project} selected={selected} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }} testID="kitchen-project-tools">
        {canEditCustomer ? <Button label="Edit customer" icon="edit-2" variant="secondary" onPress={() => router.push(`/customers/${project.customer_id}/edit` as any)} testID="kitchen-edit-customer" /> : null}
        <Button label="Documents" icon="paperclip" variant="secondary" onPress={() => setPanel("documents")} testID="kitchen-project-nav-documents" />
        <Button label="History" icon="clock" variant="secondary" onPress={() => setPanel("history")} testID="kitchen-project-nav-history" />
        <Button label="Completion date" icon="calendar" variant="secondary" onPress={() => setPanel("assignments")} testID="kitchen-project-nav-assignments" />
        <Menu triggerLabel="Project actions" triggerTestID="kitchen-project-actions" items={[{ label: "Reload saved project", icon: "refresh-cw", onPress: reload }, ...(project.permissions?.can_approve_exceptions ? [{ label: "Hold, cancel or revise project", icon: "settings" as const, onPress: () => setPanel("exceptions") }] : [])]}><View style={{ padding: spacing.sm }}><Feather name="more-horizontal" size={20} color={colors.onSurfaceSecondary} /></View></Menu>
      </View>
      {loading ? <Text style={type.caption}>Refreshing saved project…</Text> : null}
      <Text accessibilityLiveRegion="polite" style={[type.caption, { minHeight: 19 }]} testID={state.dirty ? "kitchen-unsaved-notice" : undefined}>{state.dirty ? "Unsaved changes · save before leaving this project." : " "}</Text>
      {retainedDraft ? <Alert tone="info" title="Drafts retained" description="The latest saved record is loaded. Your unsaved entries are kept for review." /> : null}
      <ErrorNotice error={submission.error} stale={submission.stale} onReload={reload} />
      {held ? <Alert tone="warning" title={`Project ${project.lifecycle_status}`} description="The owner must resume the project before routine work can continue." /> : null}
      <View testID="kitchen-current-task-region" style={{ gap: spacing.lg, width: "100%", minWidth: 0 }}>
        <Text style={type.caption}>{selected === project.stage ? "CURRENT WORK" : "SAVED STAGE RECORD"}</Text>
        {selected !== project.stage ? <Alert tone="info" title="Stage records" description={future ? `Preview of ${STAGE_LABELS[selected]}. Complete ${STAGE_LABELS[project.stage]} before entering this stage.` : `This project is now in ${STAGE_LABELS[project.stage]}. Earlier records are read only.`} action={<Button label={actionLabel} variant="secondary" onPress={() => router.replace(path(`/stages/${project.stage}`) as any)} testID="kitchen-open-current-stage" />} /> : null}
        {!canUpdate ? <View testID="kitchen-read-only-notice"><Alert tone="info" title="View only" description="Changes and uploads require permission for this project's current stage." /></View> : null}
        {project.commercial_basis_invalidated ? <Alert tone="warning" title="Fresh commercial approvals required" description="Present and approve a new design, then renew the quotation and order approvals. Earlier records remain in History." /> : null}
        {selected === "lead" ? <DuplicateReview project={project} disabled={disabled || Boolean(held)} /> : null}
        <EarlyStage project={project} stage={selected} disabled={disabled || Boolean(held)} />
        {future ? <StagePreview stage={selected} /> : null}
        <CommercialStages project={project} stage={selected} disabled={disabled || Boolean(held)} command={command} hasUnsavedChanges={state.currentTaskDirty} />
      </View>
      <Sheet scroll visible={panel === "documents"} onClose={() => setPanel(null)} title="Project documents" testID="kitchen-documents-sheet">{policyError ? <Alert tone="warning" title="Upload settings unavailable" action={<Button label="Reload" variant="secondary" onPress={reload} />} /> : null}<KitchenDocuments project={project} policy={policy} disabled={disabled || Boolean(held)} onUpdated={updateProject} onReload={reload} /></Sheet>
      <Sheet scroll visible={panel === "history"} onClose={() => setPanel(null)} title="Project history" testID="kitchen-history-sheet"><ProjectHistory project={project} /></Sheet>
      <Sheet scroll visible={panel === "assignments"} onClose={() => setPanel(null)} title="Target completion" testID="kitchen-assignment-sheet"><ProjectPlan project={project} disabled={disabled || Boolean(held)} /></Sheet>
      <Sheet scroll visible={panel === "exceptions"} onClose={() => setPanel(null)} title="Project changes" testID="kitchen-exceptions-sheet"><ProjectExceptions project={project} disabled={disabled} /></Sheet>
      <Sheet scroll visible={panel === "workflow"} onClose={() => setPanel(null)} title="Project stages" testID="kitchen-workflow-sheet"><WorkflowRows project={project} path={path} onNavigate={() => setPanel(null)} /></Sheet>
    </View> : null}
  </KitchenPage></KitchenFloor>;
}

function ProjectSummary({ project, selected }: { project: KitchenProject; selected: KitchenStage }) {
  const { isPhone } = useBp();
  const { returnTo } = useKitchenProject();
  const current = KITCHEN_STAGES.indexOf(project.stage);
  return <KitchenPanel>
    <View style={{ gap: spacing.lg }}>
      <View style={{ flexDirection: isPhone ? "column" : "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.md }}>
        <View style={{ flex: isPhone ? undefined : 1, minWidth: 0, maxWidth: "100%", gap: spacing.sm }}>
          <Text accessibilityRole="header" style={[type.titleLg, isPhone ? { fontSize: 22, lineHeight: 30 } : null]}>{project.customer.name}</Text>
          <Text style={type.bodyMuted}>{project.customer.phone || "Phone not recorded"}</Text>
          <Text style={type.bodyMuted}>{project.lead.site_location || project.customer.address || "Site not recorded"}</Text>
        </View>
        <View style={{ flexDirection: isPhone ? "row" : "column", flexWrap: "wrap", alignItems: isPhone ? "center" : "flex-start", gap: spacing.sm }}><Text style={type.bodyStrong}>{project.lifecycle_status || project.status || STAGE_LABELS[project.stage]}</Text><Text style={type.caption}>Stage {current + 1} of {KITCHEN_STAGES.length} · {STAGE_LABELS[project.stage]}</Text>{project.target_completion_date ? <Text style={type.caption}>Target {displayDate(project.target_completion_date)}</Text> : null}</View>
      </View>
      <View accessibilityLabel={`Project progress: ${STAGE_LABELS[project.stage]}, stage ${current + 1} of ${KITCHEN_STAGES.length}`} style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {KITCHEN_STAGES.map((stage, index) => <NavigationLink key={stage} href={kitchenProjectPath(project.id, `/stages/${stage}`, returnTo) as any} accessibilityRole="link" accessibilityLabel={`${index + 1}. ${STAGE_LABELS[stage]}${stage === project.stage ? ", current stage" : ""}`} testID={`kitchen-progress-${stage}`} style={{ flexGrow: 1, flexBasis: isPhone ? "28%" : 70, minWidth: 0, minHeight: 48, gap: 8 }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: index <= current ? colors.brand : colors.border }} />
          <Text style={[type.caption, stage === selected ? { color: colors.brand, fontWeight: "600" } : null]}>{index + 1}. {STAGE_LABELS[stage]}</Text>
        </NavigationLink>)}
      </View>
      {selected !== project.stage ? <Text style={type.caption}>Reviewing {STAGE_LABELS[selected]} · the project remains in {STAGE_LABELS[project.stage]}</Text> : null}
      {project.is_legacy ? <Text style={type.caption}>Legacy project · unknown historical dates and counts remain unavailable.</Text> : null}
    </View>
  </KitchenPanel>;
}

function RouteRow({ title, subtitle, href, testID, trailing, onNavigate }: { title: string; subtitle?: string; href: string; testID?: string; trailing?: string; onNavigate?: () => void }) {
  return <NavigationLink href={href as any} accessibilityRole="link" onPress={onNavigate} testID={testID} style={({ pressed, hovered }: any) => ({ minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: pressed || hovered ? colors.surfaceTertiary : "transparent" })}>
    <View style={{ flex: 1, gap: spacing.xs }}><Text style={type.bodyStrong}>{title}</Text>{subtitle ? <Text style={type.caption}>{subtitle}</Text> : null}</View>
    {trailing ? <Text style={type.caption}>{trailing}</Text> : null}<Feather name="chevron-right" size={18} color={colors.onSurfaceMuted} />
  </NavigationLink>;
}

function currentTaskLabel(project: KitchenProject) {
  if (project.duplicate_review?.status === "pending" && project.permissions?.can_review_duplicate) return "Review duplicate";
  if (project.stage === "completed") return "Review completed project";
  if (project.stage === "installation" && project.installation?.status === "Completed") return "Review closure";
  return ({ lead: "Review lead", visit: "Record showroom visit", cad: "Update CAD progress", design: "Review design", quotation: "Review quotation", order: "Review order", production: "Update production", installation: "Update installation", completed: "Review completed project" })[project.stage];
}

function WorkflowRows({ project, path, onNavigate }: { project: KitchenProject; path: (suffix?: string) => string; onNavigate?: () => void }) {
  const current = KITCHEN_STAGES.indexOf(project.stage);
  return <View>{KITCHEN_STAGES.map((stage, index) => <RouteRow key={stage} title={`${index + 1}. ${STAGE_LABELS[stage]}`} subtitle={index > current ? "Preview upcoming stage" : stage === project.stage ? "Current stage" : "Review earlier records"} href={path(`/stages/${stage}`)} trailing={stage === project.stage ? project.status : undefined} testID={`kitchen-stage-${stage}`} onNavigate={onNavigate} />)}</View>;
}

const STAGE_PREVIEW: Record<KitchenStage, string> = {
  lead: "Customer details, reference, site address and lead date.",
  visit: "Visit date, showroom visit status, display model (GI, SS, Other or Wardrobe), and visit notes.",
  cad: "CAD received, design progress and completion status. CAD must be received and design progress completed before Design.",
  design: "Customer requirements, budget discussion, presentation date, revision count, customer sharing and approval, and company handoff. Project PDFs are available under Documents.",
  quotation: "Company quotation amount, received date, PDF or HTTPS reference, customer sharing date and approval. Customer approval enables Order.",
  order: "Order confirmation and date, optional confirmation document, advance amount and receipt date, then selected department manager approval for Production.",
  production: "Production status, start date, completion date and notes. Completing production enables Installation.",
  installation: "Installation status and dates, site visits and notes, then selected department manager approval to complete the project.",
  completed: "Installation completion date, final order value, design revision and site visit totals, with documents and history retained.",
};
function StagePreview({ stage }: { stage: KitchenStage }) {
  return <KitchenPanel title={`${STAGE_LABELS[stage]} preview`}><Text style={type.body}>{STAGE_PREVIEW[stage]}</Text><Text style={type.caption}>Viewing this stage does not move the project or create records.</Text></KitchenPanel>;
}

function DuplicateReview({ project, disabled }: { project: KitchenProject; disabled: boolean }) {
  const { command } = useKitchenProject();
  const [reason, setReason] = useKitchenDraft("duplicate.reason", "");
  if (project.duplicate_review?.status !== "pending") return null;
  return <KitchenPanel title="Review possible duplicate">
    <Text style={type.bodyMuted}>Confirm this is a separate project before converting. Records are preserved; nothing is merged.</Text>
    {project.duplicate_candidates?.length ? <Text style={type.caption}>Possible matches: {project.duplicate_candidates.map(row => row.reference).join(", ")}</Text> : null}
    {project.permissions?.can_review_duplicate ? <><TextField label="Review reason" value={reason} onChangeText={setReason} editable={!disabled} multiline testID="kitchen-duplicate-reason" />
      <Button label="Confirm distinct project" disabled={disabled || !reason.trim()} onPress={() => command("review_duplicate", { decision: "distinct_project", reason })} testID="kitchen-duplicate-distinct" />
      <Button label="Mark duplicate lead Lost" variant="secondary" disabled={disabled || !reason.trim()} onPress={() => command("review_duplicate", { decision: "duplicate", reason })} testID="kitchen-duplicate-confirm" />
    </> : <Text style={type.bodyMuted}>The owner must review this lead.</Text>}
  </KitchenPanel>;
}

function EarlyStage({ project, stage, disabled }: { project: KitchenProject; stage: KitchenStage; disabled: boolean }) {
  const { command, submission } = useKitchenProject();
  const [lead, setLead] = useKitchenDraft<KitchenLead>("lead.value", project.lead);
  const today = kitchenToday();
  const [visit, setVisit] = useKitchenDraft<KitchenVisit>("visit.value", { ...project.visit, ...(!project.visit.visit_date && stage === "visit" && project.stage === "visit" && !project.is_legacy ? { visit_date: today } : {}) });
  const [cad, setCad] = useKitchenDraft<KitchenCad>("cad.value", project.cad);
  const [progress, setProgress] = useKitchenDraft("cad.progress", String(project.cad.progress));
  const active = stage === project.stage;
  const locked = disabled || !active;
  const dirty = stage === "lead" ? JSON.stringify(lead) !== JSON.stringify(project.lead) : stage === "visit" ? JSON.stringify(visit) !== JSON.stringify(project.visit) : JSON.stringify(cad) !== JSON.stringify(project.cad) || progress !== String(project.cad.progress);
  const target = stage === "visit" ? "cad" : stage === "cad" ? "design" : undefined;
  const reason = project.blocked_transitions?.find(item => item.target_stage === target)?.reason;
  if (!["lead", "visit", "cad"].includes(stage)) return null;
  return <>
    <KitchenPanel title={stage === "lead" ? "Lead details" : stage === "visit" ? "Showroom visit" : "CAD progress"}>
      {stage === "lead" ? <><LeadFields value={lead} onChange={setLead} disabled={locked} />{active && project.permissions?.can_update ? <Button label="Save lead" disabled={locked} loading={submission.busy} onPress={() => command("edit_lead", lead)} testID="kitchen-lead-save" /> : null}</> : stage === "visit" ? <>
        <Text style={type.bodyMuted}>Record the showroom visit and preferred display model. Requirements and budget discussion are recorded in Design. The date starts at today in India and can be changed.</Text>
        <KitchenDateField label="Visit date" value={visit.visit_date || ""} onChange={visit_date => setVisit({ ...visit, visit_date: visit_date || null })} disabled={locked} testID="kitchen-visit-date" />
        <Choice label="Showroom visit status" value={visit.status} values={["Scheduled", "Visited", "Follow-up Required"]} onChange={status => setVisit({ ...visit, status })} disabled={locked} testID="kitchen-visit-status" />
        <Choice label="Display / model interested in" value={visit.display_model || ""} values={["GI", "SS", "Other", "Wardrobe"]} onChange={display_model => setVisit({ ...visit, display_model })} disabled={locked} testID="kitchen-visit-display" />
        {visit.display_model && !["GI", "SS", "Other", "Wardrobe"].includes(visit.display_model) ? <Text style={type.caption}>Previously recorded: {visit.display_model}</Text> : null}
        <TextField label="Visit notes" value={visit.notes || ""} onChangeText={notes => setVisit({ ...visit, notes })} editable={!locked} multiline testID="kitchen-visit-notes" />
        {active && project.permissions?.can_update ? <Button label="Save showroom visit" disabled={locked} loading={submission.busy} onPress={() => command("save_visit", { status: visit.status, visit_date: visit.visit_date, display_model: visit.display_model, notes: visit.notes })} testID="kitchen-visit-save" /> : null}
      </> : <>
        <Choice label="CAD file received" value={cad.received ? "Yes" : "No"} values={["Yes", "No"]} onChange={value => setCad({ ...cad, received: value === "Yes" })} disabled={locked} testID="kitchen-cad-received" />
        <TextField label="Design progress (%)" value={progress} onChangeText={setProgress} editable={!locked} keyboardType="numeric" testID="kitchen-cad-progress" />
        <Choice label="Design status" value={cad.status} values={["Not Started", "In Progress", "Completed"]} onChange={status => setCad({ ...cad, status })} disabled={locked} testID="kitchen-cad-status" />
        <Text style={type.bodyMuted} testID="kitchen-cad-readiness">Ready for presentation: {cad.received && Number(progress) === 100 && cad.status === "Completed" ? "Yes" : "No"}</Text>
        <TextField label="CAD notes" value={cad.notes || ""} onChangeText={notes => setCad({ ...cad, notes })} editable={!locked} multiline testID="kitchen-cad-notes" />
        {active && project.permissions?.can_update ? <Button label="Save CAD progress" disabled={locked} loading={submission.busy} testID="kitchen-cad-save" onPress={() => { if (!/^\d{1,3}$/.test(progress) || Number(progress) > 100) { submission.setError("Design progress must be a whole number from 0 to 100."); return; } void command("save_cad", { ...cad, progress: Number(progress) }); }} /> : null}
      </>}
    </KitchenPanel>
    {active && project.permissions?.can_update ? <View style={{ gap: spacing.md }}>
      {dirty ? <Text style={type.caption}>Save changes before continuing.</Text> : null}
      {reason ? <Text style={type.bodyMuted}>{reason}</Text> : null}
      <Button label={stage === "lead" ? "Convert to project" : `Continue to ${STAGE_LABELS[target!]}`} disabled={locked || dirty || Boolean(reason) || (stage === "lead" && project.duplicate_review?.status === "pending")} onPress={() => command(stage === "lead" ? "convert" : "advance_stage", stage === "lead" ? {} : { target_stage: target })} testID={stage === "lead" ? "kitchen-convert" : `kitchen-advance-${target}`} />
    </View> : null}
  </>;
}

function ProjectPlan({ project, disabled }: { project: KitchenProject; disabled: boolean }) {
  const { command, submission } = useKitchenProject();
  const [targetDate, setTargetDate] = useKitchenDraft("plan.target", project.target_completion_date || "");
  return <KitchenPanel title="Target completion">
    <Text style={type.bodyMuted}>Keep one expected completion date for the whole project. Actual installation completion is recorded in Installation.</Text>
    <KitchenDateField label="Target completion date" value={targetDate} onChange={setTargetDate} disabled={disabled} testID="kitchen-target-date" />
    {project.permissions?.can_update ? <Button label="Save completion date" disabled={disabled} loading={submission.busy} onPress={() => command("metadata", { target_completion_date: targetDate || null })} testID="kitchen-metadata-save" /> : <Text style={type.bodyMuted}>Current stage permission is required to change this date.</Text>}
  </KitchenPanel>;
}

function ProjectExceptions({ project, disabled }: { project: KitchenProject; disabled: boolean }) {
  const { command } = useKitchenProject();
  const [reason, setReason] = useKitchenDraft("exception.reason", "");
  const [status, setStatus] = useKitchenDraft("exception.status", "On Hold");
  if (!project.permissions?.can_approve_exceptions) return <ErrorState title="Owner access required" subtitle="Only the owner can record exceptional project or commercial changes." />;
  const act = (name: "order_status" | "exception", payload: Record<string, unknown>) => { void command(name, payload).then(saved => { if (saved) setReason(""); }); };
  return <View style={{ gap: spacing.lg, width: "100%", maxWidth: 780, alignSelf: "center" }}>
    <Alert tone="warning" title="Owner actions" description="These changes affect the project workflow. Every change requires a reason and remains in its history." />
    <KitchenPanel title="Change project status">
      <TextField label="Reason for change" value={reason} onChangeText={setReason} editable={!disabled} multiline testID="kitchen-exception-reason" />
      {project.stage !== "completed" ? <><Choice label="Project status" value={status} values={["On Hold", "Cancelled", "Confirmed"]} onChange={setStatus} disabled={disabled} testID="kitchen-exception-status" /><Text style={type.caption}>Confirmed resumes a held or cancelled project. It does not confirm a customer order.</Text><Button label="Record status change" variant="danger" disabled={disabled || !reason.trim()} onPress={() => act("order_status", { status, reason })} testID="kitchen-order-status-save" /></> : <Button label="Reopen installation" variant="danger" disabled={disabled || !reason.trim()} onPress={() => act("exception", { action: "reopen", reason })} testID="kitchen-exception-save" />}
      {["design", "quotation", "order", "production", "installation", "completed"].includes(project.stage) ? <Button label="Return to Design for fresh approval" variant="danger" disabled={disabled || !reason.trim()} onPress={() => act("exception", { action: "return_to_design", reason })} testID="kitchen-return-design" /> : null}
      <Text style={type.caption}>Returning to Design preserves earlier records and requires new design, quotation, order and manager approvals.</Text>
    </KitchenPanel>
    <CommercialStages project={project} stage={project.stage} disabled={disabled || Boolean(project.lifecycle_status)} command={command} mode="amendment" />
  </View>;
}

const historyCategories = { activity: "Activity", designs: "Design versions", quotations: "Quotation versions", revisions: "Customer revisions", orders: "Orders", visits: "Site visits", approvals: "Approvals", work: "Earlier work cycles", exceptions: "Owner changes & review" };
function ProjectHistory({ project }: { project: KitchenProject }) {
  const params = useLocalSearchParams<{ category?: string }>();
  const { policy } = useKitchenProject();
  const [category, setCategory] = useState<keyof typeof historyCategories>(params.category && Object.prototype.hasOwnProperty.call(historyCategories, params.category) ? params.category as keyof typeof historyCategories : "activity");
  const [limit, setLimit] = useState(30);
  const actor = (id?: string) => !id ? "Not recorded" : [...(project.activity || [])].reverse().find(event => event.actor_id === id && event.actor_name)?.actor_name || `Staff member ${id}`;
  const documentName = (id?: string | null) => id ? project.attachments?.find(file => file.id === id)?.filename || "Saved project attachment" : "Not attached";
  const versionName = (id: string) => { const design = project.design_versions?.find(row => row.id === id); const quote = project.quotation_versions?.find(row => row.id === id); return design ? `Design version ${design.number}` : quote ? `Quotation version ${quote.number}` : null; };
  let entries: { id: string; title: string; lines: string[]; url?: string }[] = [];
  if (category === "activity") entries = [...(project.activity || [])].reverse().map(event => {
    const payload = event.payload || {};
    const stageNames = (stage: unknown) => KITCHEN_STAGES.includes(stage as KitchenStage) ? STAGE_LABELS[stage as KitchenStage] : String(stage);
    const subject = typeof payload.subject_id === "string" ? versionName(payload.subject_id) : null;
    return { id: event.id, title: event.type.replaceAll("_", " "), lines: [`${event.actor_name || actor(event.actor_id)} · ${displayDate(event.at)}${event.at ? ` · ${new Date(event.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : ""}`,
      ...(payload.from_stage && payload.to_stage && payload.from_stage !== payload.to_stage ? [`${stageNames(payload.from_stage)} → ${stageNames(payload.to_stage)}`] : []), ...(subject ? [subject] : []), ...(typeof payload.reason === "string" ? [payload.reason] : []), ...auditChangeLines(payload.changes, actor)] };
  });
  if (category === "designs" || category === "quotations") entries = [...(category === "designs" ? project.design_versions || [] : project.quotation_versions || [])].reverse().map(version => ({ id: version.id, title: `Version ${version.number} · ${version.response}`, lines: [
    `${displayDate(version.presentation_date || version.received_date)}${version.amount ? ` · ${rupees(version.amount)}` : ""}`,
    `Recorded by ${actor(version.actor_id)}`,
    `Shared ${displayDate(version.shared_date)}${version.shared_by ? ` · ${actor(version.shared_by)}` : ""}`,
    ...(category === "designs" ? [`Sent to company ${displayDate(version.handoff_date)}${version.handoff_by ? ` · ${actor(version.handoff_by)}` : ""}`] : version.design_version_id ? [`Based on ${versionName(version.design_version_id) || "recorded design"}`] : []),
    ...(version.attachment_id ? [`Document: ${documentName(version.attachment_id)}`] : []), ...(version.notes ? [version.notes] : []), ...(version.response_notes ? [`Customer response: ${version.response_notes}`] : []),
  ], url: version.url || undefined }));
  if (category === "revisions") entries = [...(project.revision_events || [])].reverse().map(event => ({ id: event.id, title: "Customer revision request", lines: [event.reason, `Design version ${project.design_versions?.find(version => version.id === event.version_id)?.number || "not recorded"}`] }));
  if (category === "visits") entries = [...(project.site_visits || [])].reverse().map(event => ({ id: event.id, title: event.actual ? "Actual site visit" : "Scheduled site visit", lines: [displayDate(event.date), ...(event.notes ? [event.notes] : [])] }));
  if (category === "orders") entries = [...(project.orders || [])].reverse().map(order => ({ id: order.id, title: `${order.authorization_invalidated ? "Historical order" : "Order"} · ${order.status}`, lines: [`${displayDate(order.order_date)} · Original ${rupees(order.original_amount)} · Final ${rupees(order.final_amount)}`, `Advance ${rupees(order.advance?.amount)} · ${displayDate(order.advance?.date)}`, `Confirmation document: ${documentName(order.confirmation_document_id)}`, versionName(order.quotation_version_id) || "Recorded quotation", ...(order.notes ? [order.notes] : []), ...order.amendments.map(row => `${displayDate(row.date)} · ${rupees(row.amount)} · ${row.reason}`)] }));
  if (category === "approvals") entries = [...(project.approvals || [])].reverse().map(event => {
    const version = versionName(event.subject_id);
    const order = project.orders?.find(row => row.id === event.subject_id || row.approval_identity === event.subject_id || row.amendments.some(amendment => amendment.id === event.subject_id));
    const association = version || (order ? `Order confirmed ${displayDate(order.order_date)}` : event.scope === "closure" ? "Installation closure" : event.scope.replaceAll("_", " "));
    const current = project.approval_subjects?.[event.scope] === event.subject_id && event.policy_version === policy?.version;
    return { id: event.id, title: `${event.scope.replaceAll("_", " ")} · ${event.decision}`, lines: [`${actor(event.actor_id)} · ${displayDate(event.at)}`, association,
      ...(event.policy_version ? [`${current ? "Current approval" : "Earlier approval"} · Operating rules version ${event.policy_version}`] : []), ...(event.reason || event.notes ? [event.reason || event.notes || ""] : [])] };
  });
  if (category === "work") entries = [...(project.work_history || [])].reverse().map((cycle, index) => ({ id: cycle.id || String(index), title: `Earlier work cycle ${cycle.workflow_cycle ?? index + 1}`, lines: [cycle.reason || "", displayDate(cycle.at), `Production: ${cycle.production?.status || "Not recorded"} · ${displayDate(cycle.production?.start_date)} – ${displayDate(cycle.production?.completion_date)}`, `Installation: ${cycle.installation?.status || "Not recorded"} · ${displayDate(cycle.installation?.start_date)} – ${displayDate(cycle.installation?.completion_date)}`, cycle.production?.notes || "", cycle.installation?.notes || ""].filter(Boolean) }));
  if (category === "exceptions") {
    entries = [...(project.exceptions || [])].reverse().map(event => ({ id: event.id, title: `${event.action.replaceAll("_", " ")}${event.status ? ` · ${event.status}` : ""}`, lines: [event.reason, `${actor(event.actor_id)} · ${displayDate(event.at)}`] }));
    if (project.duplicate_review?.reason) entries.push({ id: "duplicate-review", title: `Duplicate review · ${project.duplicate_review.status}`, lines: [project.duplicate_review.reason, `${actor(project.duplicate_review.reviewed_by)} · ${displayDate(project.duplicate_review.reviewed_at)}`] });
  }
  return <View style={{ gap: spacing.lg, width: "100%", maxWidth: 860, alignSelf: "center" }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md }}>
      <Menu triggerLabel="Choose history category" triggerTestID="kitchen-history-category" align="left" items={Object.entries(historyCategories).map(([key, label]) => ({ label, onPress: () => { setLimit(30); setCategory(key as keyof typeof historyCategories); } }))}><Text style={type.titleMd}>{historyCategories[category]} ▾</Text></Menu><Text style={type.caption}>{entries.length} records</Text>
    </View>
    <KitchenPanel>{!entries.length ? <Text style={type.bodyMuted}>No {historyCategories[category].toLowerCase()} recorded.</Text> : entries.slice(0, limit).map(entry => <View key={entry.id} style={{ gap: spacing.sm, paddingVertical: spacing.md, borderBottomWidth: 1, borderColor: colors.border }}>
      <Text style={type.bodyStrong}>{entry.title}</Text>{entry.lines.map((line, index) => <Text key={index} style={type.bodyMuted}>{line}</Text>)}
      {entry.url ? <Button label="Open reference" variant="secondary" onPress={() => void Linking.openURL(entry.url!)} /> : null}
    </View>)}</KitchenPanel>
    {entries.length > limit ? <Button label="Show earlier records" variant="secondary" onPress={() => setLimit(value => value + 30)} /> : null}
  </View>;
}
function auditChangeLines(changes: unknown, actor: (id?: string) => string) {
  if (!changes || typeof changes !== "object") return [];
  const lines: string[] = [];
  const label = (value: string) => value.replaceAll("_", " ");
  const text = (value: unknown, key: string): string => value == null || value === "" ? "Not recorded" : typeof value === "boolean" ? value ? "Yes" : "No" : key === "assignments" && typeof value === "string" ? actor(value) : typeof value === "object" ? "Updated" : String(value);
  for (const [key, entry] of Object.entries(changes)) {
    if (!entry || typeof entry !== "object") continue;
    const { before, after } = entry as { before?: unknown; after?: unknown };
    if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
      for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const old = (before as Record<string, unknown>)[field], next = (after as Record<string, unknown>)[field];
        if (JSON.stringify(old) !== JSON.stringify(next)) lines.push(`${label(key)} · ${label(field)}: ${text(old, key)} → ${text(next, key)}`);
      }
    } else lines.push(`${label(key)}: ${text(before, key)} → ${text(after, key)}`);
  }
  return lines;
}
