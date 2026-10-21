import { useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Linking, Pressable, View, useWindowDimensions } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { AdminPage } from "@/src/components/AdminPage";
import { Alert, Button, Chip, ErrorState, LoadingState, Sheet, TextField } from "@/src/components/ds";
import { Menu } from "@/src/design/navigationControls";
import { NavigationLink } from "@/src/design/NavigationLink";
import { useBp } from "@/src/design/responsive";
import { KITCHEN_STAGES, STAGE_LABELS, type KitchenCad, type KitchenLead, type KitchenProject, type KitchenStage, type KitchenVisit } from "@/src/api/kitchenProjects";
import { Choice, displayDate, ErrorNotice, KitchenFloor, KitchenPanel, historicalCount, rupees } from "./shared";
import { KitchenDateField } from "./KitchenFilters";
import { LeadFields } from "./KitchenLeadFields";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { CommercialStages } from "./CommercialStages";
import { KitchenDocuments } from "./KitchenDocuments";
import { kitchenProjectPath, kitchenStage, useKitchenDraft, useKitchenProject } from "./KitchenProjectState";

type ProjectPage = "overview" | "stage" | "documents" | "history" | "assignments" | "exceptions";
const pageLabels = { overview: "Project overview", stage: "Current task", documents: "Documents", history: "History", assignments: "Plan & assignment", exceptions: "Owner actions" };

export function KitchenProjectDetail({ page = "overview" }: { page?: ProjectPage }) {
  const state = useKitchenProject();
  const { project, loading, failure, policy, policyError, workers, workerError, retryWorkers, reload, updateProject, submission, command, returnTo, retainedDraft } = state;
  const { stage: parameter } = useLocalSearchParams<{ stage?: string }>();
  const router = useRouter();
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const selected = kitchenStage(parameter) || project?.stage || "lead";
  const title = page === "overview" ? project?.customer.name || "Kitchen project" : page === "stage" ? STAGE_LABELS[selected] : pageLabels[page];
  const path = (suffix = "") => kitchenProjectPath(state.id, suffix, returnTo);
  const canUpdate = project?.permissions?.can_update === true;
  const held = project?.lifecycle_status === "On Hold" || project?.lifecycle_status === "Cancelled";
  const back = () => { if (router.canGoBack()) router.back(); else router.replace((page === "overview" ? returnTo : path()) as any); };
  const actionLabel = project ? currentTaskLabel(project) : "Open current task";
  const disabled = !canUpdate || submission.busy || loading || Boolean(failure);
  if (page === "stage" && parameter && !kitchenStage(parameter)) return <KitchenFloor><AdminPage title="Workflow" back={back}><ErrorState title="Stage unavailable" subtitle="Choose a stage from this project's workflow." /></AdminPage></KitchenFloor>;
  return <KitchenFloor><AdminPage title={title} overline={project ? `${project.project_reference || project.reference}${page === "overview" ? "" : ` · ${project.customer.name}`}` : "Kitchen"}
    back={back}
    right={project && page === "overview" ? <Button label={actionLabel} onPress={() => router.push(path(`/stages/${project.stage}`) as any)} testID="kitchen-open-current-stage" /> : project && page === "stage" ? <Button label="Workflow" icon="list" variant="secondary" onPress={() => setWorkflowOpen(true)} testID="kitchen-open-workflow" /> : undefined}
    contentStyle={{ width: "100%", maxWidth: 1160, alignSelf: "center" }}>
    {failure ? <ErrorState title="Project unavailable" subtitle={failure} onRetry={reload} /> : null}
    {loading && !project ? <LoadingState label="Loading project…" /> : null}
    {project ? <View style={{ gap: spacing.lg }} testID="kitchen-project-detail">
      <View testID={!loading && !failure ? "kitchen-project-ready" : "kitchen-project-loading"} />
      <ProjectNavigation page={page} project={project} path={path} selected={selected} />
      {loading ? <Text style={type.caption}>Refreshing saved project…</Text> : null}
      {policyError && page === "documents" ? <Alert tone="warning" title="Upload settings unavailable" description="Reload the project to check the upload settings." action={<Button label="Reload" variant="secondary" onPress={reload} />} /> : null}
      {state.dirty ? <Text accessibilityLiveRegion="polite" style={type.caption} testID="kitchen-unsaved-notice">Unsaved changes · kept while you move between this project’s pages. Save before leaving.</Text> : null}
      {retainedDraft ? <Alert tone="info" title="Drafts retained" description="The latest saved record is loaded. Your unsaved entries are kept for review." /> : null}
      <ErrorNotice error={submission.error} stale={submission.stale} onReload={reload} />
      {held ? <Alert tone="warning" title={`Project ${project.lifecycle_status}`} description="The owner must resume the project before routine work can continue." /> : null}
      {page === "overview" ? <ProjectOverview project={project} path={path} /> : null}
      {page === "stage" ? <View testID="kitchen-current-task-region" style={{ gap: spacing.lg, width: "100%", maxWidth: 780, alignSelf: "center" }}>
        <View style={{ flexDirection: "row", gap: spacing.md, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
          <Text style={type.bodyMuted}>{selected === project.stage ? `Current task · ${project.status || STAGE_LABELS[selected]}` : "Reviewing stage records"}</Text>
          <Text style={type.caption}>Assigned to {workers.find(worker => worker.id === project.assignments[selected])?.full_name || "Unassigned"}</Text>
        </View>
        {selected !== project.stage ? <Alert tone="info" title="Stage records" description={`The project is currently in ${STAGE_LABELS[project.stage]}. This stage is read only. Use Current task to continue assigned work.`} action={<Button label={actionLabel} variant="secondary" onPress={() => router.push(path(`/stages/${project.stage}`) as any)} />} /> : null}
        {!canUpdate ? <View testID="kitchen-read-only-notice"><Alert tone="info" title="View only" description="You can review the project history. Changes and uploads require permission for the current task." /></View> : null}
        {project.commercial_basis_invalidated ? <Alert tone="warning" title="Fresh commercial approvals required" description="Present and approve a new design, then renew the quotation and order approvals. Earlier records remain in History." /> : null}
        {selected === "lead" ? <DuplicateReview project={project} disabled={disabled || Boolean(held)} /> : null}
        <EarlyStage project={project} stage={selected} disabled={disabled || Boolean(held)} />
        <CommercialStages project={project} stage={selected} disabled={disabled || Boolean(held)} command={command} hasUnsavedChanges={state.currentTaskDirty} />
      </View> : null}
      {page === "documents" ? <View style={{ width: "100%", maxWidth: 780, alignSelf: "center" }}><KitchenDocuments project={project} policy={policy} disabled={disabled || Boolean(held)} onUpdated={updateProject} onReload={reload} /></View> : null}
      {page === "history" ? <ProjectHistory project={project} /> : null}
      {page === "assignments" ? <ProjectPlan project={project} disabled={disabled || Boolean(held)} workers={workers} workerError={workerError} onRetryWorkers={retryWorkers} /> : null}
      {page === "exceptions" ? <ProjectExceptions project={project} disabled={disabled} /> : null}
    </View> : null}
    <Sheet visible={workflowOpen} onClose={() => setWorkflowOpen(false)} title="Project workflow" testID="kitchen-workflow-sheet">
      {project ? <WorkflowRows project={project} path={path} onNavigate={() => setWorkflowOpen(false)} /> : null}
    </Sheet>
  </AdminPage></KitchenFloor>;
}

function ProjectNavigation({ page, project, path, selected }: { page: ProjectPage; project: KitchenProject; path: (suffix?: string) => string; selected: KitchenStage }) {
  const links: { page: ProjectPage; label: string; suffix: string }[] = [
    { page: "overview", label: "Overview", suffix: "" }, { page: "stage", label: "Current task", suffix: `/stages/${project.stage}` },
    { page: "documents", label: "Documents", suffix: "/documents" }, { page: "history", label: "History", suffix: "/history" },
    { page: "assignments", label: "Plan", suffix: "/assignments" },
  ];
  const router = useRouter();
  const { isPhone } = useBp();
  const { reload } = useKitchenProject();
  const [pagesOpen, setPagesOpen] = useState(false);
  const [contentWidth, setContentWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const compact = isPhone || contentWidth < 680 * fontScale;
  const currentLink = (target: ProjectPage) => page === target && (target !== "stage" || selected === project.stage);
  const actions = <Menu triggerLabel="Project actions" triggerTestID="kitchen-project-actions" items={[
    { label: "Reload saved project", icon: "refresh-cw", onPress: reload },
    ...(project.permissions?.can_approve_exceptions ? [{ label: "Owner actions", icon: "settings" as const, onPress: () => router.push(path("/exceptions") as any) }] : []),
  ]}><View style={{ padding: spacing.sm }}><Feather name="more-horizontal" size={20} color={colors.onSurfaceSecondary} /></View></Menu>;
  return <View onLayout={event => setContentWidth(event.nativeEvent.layout.width)} style={{ width: "100%" }}>
    {compact ? <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md }}>
      <Button label={page === "stage" && selected !== project.stage ? `${STAGE_LABELS[selected]} records` : pageLabels[page]} icon="chevron-down" variant="secondary" onPress={() => setPagesOpen(true)} testID="kitchen-project-pages" />{actions}
    </View> : <View style={{ flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderColor: colors.border }}>
      <View style={{ flex: 1, flexDirection: "row", gap: spacing.lg }}>
        {links.map(link => <NavigationLink key={link.page} href={path(link.suffix) as any} accessibilityRole="link" accessibilityState={{ selected: currentLink(link.page) }} testID={`kitchen-project-nav-${link.page}`}
          style={{ minHeight: 48, justifyContent: "center", borderBottomWidth: 2, borderBottomColor: currentLink(link.page) ? colors.brand : "transparent", paddingHorizontal: spacing.xs }}>
          <Text style={[type.bodyStrong, { color: currentLink(link.page) ? colors.brand : colors.onSurfaceSecondary }]}>{link.label}</Text>
        </NavigationLink>)}
      </View>{actions}
    </View>}
    <Sheet visible={compact && pagesOpen} onClose={() => setPagesOpen(false)} title="Project pages" testID="kitchen-project-pages-sheet">
      {links.map(link => <RouteRow key={link.page} title={link.label} subtitle={currentLink(link.page) ? "Current page" : undefined} href={path(link.suffix)} testID={`kitchen-project-nav-${link.page}`} onNavigate={() => setPagesOpen(false)} />)}
      {project.permissions?.can_approve_exceptions ? <RouteRow title="Owner actions" href={path("/exceptions")} testID="kitchen-project-nav-exceptions" onNavigate={() => setPagesOpen(false)} /> : null}
    </Sheet>
  </View>;
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

function ProjectOverview({ project, path }: { project: KitchenProject; path: (suffix?: string) => string }) {
  const { isPhone } = useBp();
  const { workers } = useKitchenProject();
  const nextStage = KITCHEN_STAGES[KITCHEN_STAGES.indexOf(project.stage) + 1];
  const blocker = project.blocked_transitions?.find(row => row.target_stage === nextStage)?.reason;
  const [workflowOpen, setWorkflowOpen] = useState(!isPhone);
  return <View style={{ gap: spacing.lg }}>
    <KitchenPanel title={STAGE_LABELS[project.stage]}>
      <Text style={type.bodyMuted}>{project.status || "Pending"}{project.lifecycle_status ? ` · ${project.lifecycle_status}` : ""}</Text>
      <Text style={type.bodyStrong}>{project.next_action || currentTaskLabel(project)}</Text>
      <Text style={type.bodyMuted}>Responsible: {workers.find(worker => worker.id === project.assignments[project.stage])?.full_name || "Unassigned — the owner or selected manager can assign this task in Plan."}</Text>
      {blocker ? <Text style={type.bodyMuted}>Before continuing: {blocker}</Text> : null}
      <Text style={type.bodyMuted}>{project.lead.site_location || project.customer.address || "Site not recorded"}</Text>
      <Text style={type.body}>{project.customer.phone || "Phone not recorded"}</Text>
      {project.deadline ? <Text style={type.caption}>Next action due {displayDate(project.deadline)}</Text> : null}
      {project.target_completion_date ? <Text style={type.caption}>Target completion {displayDate(project.target_completion_date)}</Text> : null}
      {project.commercial_basis_invalidated ? <Alert tone="warning" title="New approval cycle" description="Earlier commercial approvals are retained in History. Current work needs renewed approvals." /> : null}
      {project.duplicate_review?.status === "pending" ? <Alert tone="warning" title="Owner duplicate review pending" description="Review this lead in the current task before conversion." /> : null}
    </KitchenPanel>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.lg }}>
      {[{ label: "Order value", value: rupees(project.commercial_basis_invalidated ? null : project.order_amount) },
        { label: "Design revisions", value: historicalCount(project.design_revision_count, project.known_design_revision_count) },
        { label: "Actual site visits", value: historicalCount(project.site_visit_count, project.known_site_visit_count) }].map(item => <View key={item.label} style={{ flex: 1, minWidth: 160, gap: spacing.xs, paddingVertical: spacing.sm }}><Text style={type.caption}>{item.label}</Text><Text style={type.titleMd}>{item.value}</Text></View>)}
    </View>
    {project.is_legacy ? <Text style={type.caption}>Legacy project{project.source_reference ? ` · ${project.source_reference}` : ""}. Unknown historical dates and counts remain unavailable.</Text> : null}
    <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.lg, alignItems: "flex-start" }}>
      <View style={{ flex: 1, width: "100%", gap: spacing.sm }}>
        <RouteRow title="Documents" subtitle={`${project.attachments?.length || 0} private files`} href={path("/documents")} testID="kitchen-summary-documents" />
        <RouteRow title="History" subtitle="Versions, approvals and recorded changes" href={path("/history")} />
        <RouteRow title="Plan & assignment" subtitle="Responsible person, next action and dates" href={path("/assignments")} />
      </View>
      <View style={{ flex: 1, width: "100%", borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.lg, backgroundColor: colors.surfaceSecondary }}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: workflowOpen }} onPress={() => setWorkflowOpen(value => !value)} style={{ minHeight: 44, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}><Text style={type.titleMd}>Project workflow</Text><Feather name={workflowOpen ? "chevron-up" : "chevron-down"} size={18} color={colors.onSurfaceSecondary} /></Pressable>
        {workflowOpen ? <WorkflowRows project={project} path={path} /> : null}
      </View>
    </View>
  </View>;
}
function WorkflowRows({ project, path, onNavigate }: { project: KitchenProject; path: (suffix?: string) => string; onNavigate?: () => void }) {
  return <View>{KITCHEN_STAGES.map((stage, index) => <RouteRow key={stage} title={`${index + 1}. ${STAGE_LABELS[stage]}`} subtitle={stage === project.stage ? "Current task" : KITCHEN_STAGES.indexOf(stage) < KITCHEN_STAGES.indexOf(project.stage) ? "Review earlier records" : "Upcoming stage"} href={path(`/stages/${stage}`)} trailing={stage === project.stage ? project.status : undefined} testID={`kitchen-stage-${stage}`} onNavigate={onNavigate} />)}</View>;
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
  const [visit, setVisit] = useKitchenDraft<KitchenVisit>("visit.value", project.visit);
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
        <KitchenDateField label="Visit date" value={visit.visit_date || ""} onChange={visit_date => setVisit({ ...visit, visit_date: visit_date || null })} disabled={locked} testID="kitchen-visit-date" />
        <Choice label="Showroom visit status" value={visit.status} values={["Scheduled", "Visited", "Follow-up Required"]} onChange={status => setVisit({ ...visit, status })} disabled={locked} testID="kitchen-visit-status" />
        <TextField label="Display / model interested in" value={visit.display_model || ""} onChangeText={display_model => setVisit({ ...visit, display_model })} editable={!locked} testID="kitchen-visit-display" />
        <TextField label="Customer requirements" value={visit.requirements || ""} onChangeText={requirements => setVisit({ ...visit, requirements })} editable={!locked} multiline testID="kitchen-visit-requirements" />
        <TextField label="Budget discussion" value={visit.budget_discussion || ""} onChangeText={budget_discussion => setVisit({ ...visit, budget_discussion })} editable={!locked} multiline testID="kitchen-visit-budget" />
        <Choice label="Customer interested in proceeding" value={visit.interested == null ? "Not recorded" : visit.interested ? "Yes" : "No"} values={["Not recorded", "Yes", "No"]} onChange={value => setVisit({ ...visit, interested: value === "Not recorded" ? null : value === "Yes" })} disabled={locked} testID="kitchen-visit-interested" />
        <TextField label="Visit notes" value={visit.notes || ""} onChangeText={notes => setVisit({ ...visit, notes })} editable={!locked} multiline testID="kitchen-visit-notes" />
        <TextField label="Next action" value={visit.next_action || ""} onChangeText={next_action => setVisit({ ...visit, next_action })} editable={!locked} testID="kitchen-visit-next-action" />
        {active && project.permissions?.can_update ? <Button label="Save showroom visit" disabled={locked} loading={submission.busy} onPress={() => command("save_visit", visit)} testID="kitchen-visit-save" /> : null}
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

function ProjectPlan({ project, disabled, workers, workerError, onRetryWorkers }: { project: KitchenProject; disabled: boolean; workers: ReturnType<typeof useKitchenProject>["workers"]; workerError: boolean; onRetryWorkers: () => void }) {
  const { command, submission, loading, failure } = useKitchenProject();
  const [stage, setStage] = useKitchenDraft<KitchenStage>("assignment.stage", project.stage);
  const [assignedTo, setAssignedTo] = useKitchenDraft(`assignment.person.${stage}`, project.assignments[stage] || "");
  const [nextAction, setNextAction] = useKitchenDraft("plan.nextAction", project.next_action || "");
  const [deadline, setDeadline] = useKitchenDraft("plan.deadline", project.deadline || "");
  const [targetDate, setTargetDate] = useKitchenDraft("plan.target", project.target_completion_date || "");
  return <View style={{ gap: spacing.lg, width: "100%", maxWidth: 780, alignSelf: "center" }}>
    <KitchenPanel title="Next action">
      <TextField label="Next action" value={nextAction} onChangeText={setNextAction} editable={!disabled} testID="kitchen-next-action" />
      <KitchenDateField label="Next action deadline (India time)" value={deadline} onChange={setDeadline} disabled={disabled} kind="datetime" testID="kitchen-deadline" />
      <KitchenDateField label="Target completion date" value={targetDate} onChange={setTargetDate} disabled={disabled} testID="kitchen-target-date" />
      {project.permissions?.can_update ? <Button label="Save plan" disabled={disabled} onPress={() => command("metadata", { next_action: nextAction || null, deadline: deadline || null, target_completion_date: targetDate || null })} testID="kitchen-metadata-save" /> : <Text style={type.bodyMuted}>Current task permission is required to change the plan.</Text>}
    </KitchenPanel>
    <KitchenPanel title="Stage assignment">
      <Menu triggerLabel="Choose assignment stage" triggerTestID="kitchen-assignment-stage" align="left" items={KITCHEN_STAGES.map(value => ({ label: STAGE_LABELS[value], onPress: () => setStage(value) }))}><Text style={type.bodyStrong}>{STAGE_LABELS[stage]} ▾</Text></Menu>
      <Text style={type.bodyMuted}>Saved assignment: {workers.find(worker => worker.id === project.assignments[stage])?.full_name || "Unassigned"}</Text>
      {project.permissions?.can_assign ? workerError ? <ErrorState title="Team unavailable" onRetry={onRetryWorkers} /> : <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><Chip label="Unassigned" active={!assignedTo} onPress={() => setAssignedTo("")} />{workers.map(worker => <Chip key={worker.id} label={worker.full_name} active={assignedTo === worker.id} onPress={() => setAssignedTo(worker.id)} testID={`kitchen-assign-${worker.id}`} />)}</View>
        <Button label="Save assignment" variant="secondary" disabled={submission.busy || loading || Boolean(failure)} onPress={() => command("assign", { stage, user_id: assignedTo || null })} testID="kitchen-assign-save" />
      </> : <Text style={type.bodyMuted}>The owner or selected department manager assigns work.</Text>}
    </KitchenPanel>
  </View>;
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
  const router = useRouter();
  const { workers, policy } = useKitchenProject();
  const category = params.category && Object.prototype.hasOwnProperty.call(historyCategories, params.category) ? params.category as keyof typeof historyCategories : "activity";
  const [limit, setLimit] = useState(30);
  const actor = (id?: string) => !id ? "Not recorded" : [...(project.activity || [])].reverse().find(event => event.actor_id === id && event.actor_name)?.actor_name || workers.find(worker => worker.id === id)?.full_name || `Staff member ${id}`;
  const documentName = (id?: string | null) => id ? project.attachments?.find(file => file.id === id)?.filename || "Saved project attachment" : "Not attached";
  const versionName = (id: string) => { const design = project.design_versions?.find(row => row.id === id); const quote = project.quotation_versions?.find(row => row.id === id); return design ? `Design version ${design.number}` : quote ? `Quotation version ${quote.number}` : null; };
  let entries: { id: string; title: string; lines: string[]; url?: string }[] = [];
  if (category === "activity") entries = [...(project.activity || [])].reverse().map(event => {
    const payload = event.payload || {};
    const stageNames = (stage: unknown) => KITCHEN_STAGES.includes(stage as KitchenStage) ? STAGE_LABELS[stage as KitchenStage] : String(stage);
    const subject = typeof payload.subject_id === "string" ? versionName(payload.subject_id) : null;
    return { id: event.id, title: event.type.replaceAll("_", " "), lines: [`${event.actor_name || actor(event.actor_id)} · ${displayDate(event.at)}${event.at ? ` · ${new Date(event.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}` : ""}`,
      ...(payload.from_stage && payload.to_stage && payload.from_stage !== payload.to_stage ? [`${stageNames(payload.from_stage)} → ${stageNames(payload.to_stage)}`] : []), ...(subject ? [subject] : []), ...auditChangeLines(payload.changes, actor)] };
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
      <Menu triggerLabel="Choose history category" triggerTestID="kitchen-history-category" align="left" items={Object.entries(historyCategories).map(([key, label]) => ({ label, onPress: () => { setLimit(30); router.setParams({ category: key }); } }))}><Text style={type.titleMd}>{historyCategories[category]} ▾</Text></Menu><Text style={type.caption}>{entries.length} records</Text>
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
