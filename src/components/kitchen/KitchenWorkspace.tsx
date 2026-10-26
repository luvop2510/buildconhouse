import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert as NativeAlert, Platform, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { Alert, EmptyState, ErrorState, LoadingState, SearchField, Sheet } from "@/src/components/ds";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { NavigationLink } from "@/src/design/NavigationLink";
import { KITCHEN_STAGES, STAGE_LABELS, kitchenProjectsApi, type KitchenAssignee, type KitchenCustomer, type KitchenLead, type KitchenPage, type KitchenProject, type KitchenQuery, type KitchenStage, type KitchenPolicy } from "@/src/api/kitchenProjects";
import { displayDate, ErrorNotice, errorText, KitchenFloor, KitchenPage as KitchenPageFrame, KitchenPanel, historicalCount, rupees, useKitchenSubmission } from "./shared";
import { AssigneeChoice } from "./KitchenAssignment";
import { LeadFields } from "./KitchenLeadFields";
import { radius, spacing } from "@/src/theme/tokens";
import { KitchenButton as Button, KitchenTextField as TextField, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";
import { useAuth } from "@/src/state/auth";
import { KitchenDateField, KitchenSelect as SelectFilter, KitchenOption, KITCHEN_STAGE_STATUSES, KITCHEN_ATTENTION_LABELS } from "./KitchenFilters";
import { kitchenToday } from "./KitchenDates";
import { referrerLabel } from "@/src/utils/referrer";
import { useKitchenExitGuard } from "./KitchenExitGuard";
import { KitchenPolicyEditor } from "./KitchenPolicy";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
export { LeadFields } from "./KitchenLeadFields";

const LIMIT = 25;
export type KitchenWorkspacePage = "overview" | "projects" | "workflow" | "stage" | "completed" | "review" | "settings" | "new";
type WorkspaceProps = { page?: KitchenWorkspacePage; stage?: KitchenStage };
const stageDescriptions: Record<KitchenStage, string> = { lead: "Record the enquiry, then convert it to a showroom visit.", visit: "Record the showroom visit and preferred display model.", cad: "Record CAD receipt and prepare the design for presentation.", design: "Present the design, record revisions and obtain customer approval.", quotation: "Receive the company quotation and record the customer's response.", order: "Confirm the approved quotation and record the advance payment.", production: "Record when production starts and finishes.", installation: "Record installation progress and actual site visits.", completed: "Finished installations, with their complete project history." };
const filterKeys = ["assignee", "stage", "status", "date_from", "date_to", "date_field", "sort", "direction", "attention", "duplicate_review"] as const;
const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
const url = (path: string, values: Record<string, string | number | undefined>) => { const query = Object.entries(values).filter(([, value]) => value !== "" && value !== undefined).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&"); return `${path}${query ? `?${query}` : ""}`; };
export function KitchenWorkspace(props: WorkspaceProps) { return <KitchenFloor><Workspace {...props} /></KitchenFloor>; }

function Workspace({ stage = "lead" }: WorkspaceProps) {
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const { staff } = useAuth();
  const createAccess = useActionAccess("kitchen_projects", "create", true);
  const canExport = useActionAccess("kitchen_projects", "export", true);
  const [policy, setPolicy] = useState<KitchenPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<KitchenAssignee[]>([]);
  const [workerError, setWorkerError] = useState(false);
  const [workersLoading, setWorkersLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const owner = staff?.role === "owner";
  const canCreate = createAccess;
  const page = stage === "completed" ? "completed" : "stage";
  const path = `/kitchen/stages/${stage}`;
  const values = Object.fromEntries(["search", ...filterKeys, "page"].map(key => [key, one(params[key])])) as Record<string, string>;
  // Retired filter bookmarks must not hide projects after workflow controls are removed.
  if (["assignee", "next_action", "deadline"].includes(values.sort)) values.sort = "";
  if (values.date_field === "deadline") values.date_field = "";
  if (values.attention === "next_action_overdue") values.attention = "";
  values.stage = "";
  if (stage === "completed") values.status = "";
  const returnTo = url(path, values);
  const [createOpen, setCreateOpen] = useState(one(params.create) === "1");
  const [settingsOpen, setSettingsOpen] = useState(one(params.settings) === "1");
  useEffect(() => { setCreateOpen(one(params.create) === "1"); }, [params.create]);
  useEffect(() => { setSettingsOpen(one(params.settings) === "1"); }, [params.settings]);
  const setValues = (patch: Record<string, string>) => { const next = { ...patch }; delete next.stage; router.setParams(next); };
  const [search, setSearch] = useState(values.search);
  useEffect(() => { setSearch(values.search); }, [values.search]);
  useEffect(() => { if (search === values.search) return; const timer = setTimeout(() => router.setParams({ search, page: "1" }), 250); return () => clearTimeout(timer); }, [search, values.search, router]);
  useEffect(() => {
    const controller = new AbortController();
    kitchenProjectsApi.configuration(controller.signal).then(value => { if (!controller.signal.aborted) { setPolicy(value); setPolicyError(null); } }).catch(error => { if (!controller.signal.aborted) setPolicyError(errorText(error)); });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!settingsOpen || !owner) return;
    const controller = new AbortController();
    setWorkersLoading(true);
    kitchenProjectsApi.assignees(controller.signal).then(value => { if (!controller.signal.aborted) { setWorkers(value.rows); setWorkerError(false); } }).catch(() => { if (!controller.signal.aborted) setWorkerError(true); }).finally(() => { if (!controller.signal.aborted) setWorkersLoading(false); });
    return () => controller.abort();
  }, [settingsOpen, owner, retry]);
  const requestCreateClose = useRef<(() => void) | null>(null);
  const closeCreate = () => { setCreateOpen(false); router.setParams({ create: "" }); };
  const closeSettings = () => { setSettingsOpen(false); router.setParams({ settings: "" }); };
  return <KitchenPageFrame title={STAGE_LABELS[stage]} subtitle={stageDescriptions[stage]} overline={`Kitchen · Stage ${KITCHEN_STAGES.indexOf(stage) + 1} of 9`}
    right={<View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>{owner ? <Button label="Department settings" icon="settings" variant="ghost" onPress={() => setSettingsOpen(true)} testID="kitchen-settings-open" /> : null}{stage === "lead" && canCreate ? <Button label="Add lead" icon="plus" onPress={() => setCreateOpen(true)} testID="kitchen-create" /> : null}</View>}>
    <View style={{ width: "100%", minWidth: 0, gap: 28 }}>
      <View style={{ maxWidth: 380 }}><SelectFilter label="Kitchen stage" value={stage} options={KITCHEN_STAGES.map((value, index) => ({ value, label: `${index + 1}. ${STAGE_LABELS[value]}` }))} onChange={value => router.push(`/kitchen/stages/${value}` as any)} testID="kitchen-stage-navigation" /></View>
      <ProjectList key={stage} page={page} stage={stage} values={values} setValues={setValues} returnTo={returnTo} search={search} setSearch={setSearch} retry={retry} onRetry={() => setRetry(value => value + 1)} canExport={canExport} />
    </View>
    <Sheet scroll visible={createOpen && stage === "lead"} onClose={() => requestCreateClose.current ? requestCreateClose.current() : closeCreate()} title="Add lead" testID="kitchen-create-sheet">
        {!createAccess ? <ErrorState title="Lead creation access required" /> : policyError ? <ErrorState title="Kitchen setup unavailable" subtitle={policyError} onRetry={() => setRetry(value => value + 1)} /> : !policy ? <LoadingState label="Checking Kitchen setup…" /> : <CreateLead onRegisterClose={handler => { requestCreateClose.current = handler; }} onClose={closeCreate} onCreated={project => { closeCreate(); router.push(url(`/kitchen/${project.id}/stages/lead`, { returnTo: path }) as any); }} />}
    </Sheet>
    <Sheet scroll visible={settingsOpen} onClose={closeSettings} title="Department settings" testID="kitchen-settings-sheet">
      {!owner ? <ErrorState title="Owner access required" /> : policyError ? <ErrorState title="Settings unavailable" subtitle={policyError} onRetry={() => setRetry(value => value + 1)} /> : policy ? <KitchenPolicyEditor policy={policy} workers={workers} workerError={workerError || workersLoading} onSaved={value => { setPolicy(value); setRetry(current => current + 1); }} onReload={() => setRetry(value => value + 1)} /> : <LoadingState label="Loading settings…" />}
    </Sheet>
  </KitchenPageFrame>;
}

function ProjectList({ page, stage, values, setValues, returnTo, search, setSearch, retry, onRetry, canExport }: { page: KitchenWorkspacePage; stage?: KitchenStage; values: Record<string, string>; setValues: (patch: Record<string, string>) => void; returnTo: string; search: string; setSearch: (value: string) => void; retry: number; onRetry: () => void; canExport: boolean }) {
  const [contentWidth, setContentWidth] = useState(0);
  const [result, setResult] = useState<KitchenPage<KitchenProject> | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const currentPage = /^\d+$/.test(values.page) ? Math.max(1, Number(values.page)) : 1;
  const query: KitchenQuery = { search: values.search, stage: page === "completed" ? "completed" : page === "review" ? "lead" : page === "stage" ? stage : values.stage, status: values.status, assignee: values.assignee || undefined, attention: values.attention as KitchenQuery["attention"], duplicate_review: page === "review" ? "pending" : values.duplicate_review === "pending" ? "pending" : undefined, date_from: values.date_from, date_to: values.date_to, date_field: page === "completed" ? "completion_date" : values.date_field || "target_completion_date", sort: values.sort || "updated_at", direction: values.direction === "asc" ? "asc" : "desc", page: currentPage, limit: LIMIT };
  const queryKey = JSON.stringify(query);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setFailure(null); setResult(null); kitchenProjectsApi.list(JSON.parse(queryKey), controller.signal).then(value => { if (!controller.signal.aborted) setResult(value); }).catch(error => { if (!controller.signal.aborted) setFailure(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [queryKey, retry]);
  const activeFilters = filterKeys.filter(key => values[key] && !["sort", "direction", "date_field"].includes(key)).length;
  const rows = result?.rows || [];
  const projectHref = (project: KitchenProject) => url(`/kitchen/${project.id}/stages/${project.stage}`, { returnTo });
  const clear = () => setValues(Object.fromEntries([...filterKeys, "search"].map(key => [key, ""]).concat([["page", "1"]])));
  return <View onLayout={event => setContentWidth(event.nativeEvent.layout.width)} style={{ gap: spacing.lg }}>
    {page === "review" ? <Text style={type.bodyMuted}>Confirm a distinct project or mark a duplicate lead Lost. The original record and customer stay intact.</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, alignItems: "center", paddingBottom: 20, borderBottomWidth: 1, borderColor: colors.divider }}>
      <View style={{ flex: 1, minWidth: Math.min(220, contentWidth || 220) }}><SearchField placeholder={page === "completed" ? "Search completed projects" : "Search project or customer"} accessibilityLabel="Search Kitchen projects" value={search} onChangeText={setSearch} onClear={() => setSearch("")} testID="kitchen-search" /></View>
      <Button label={`Filters${activeFilters ? ` (${activeFilters})` : ""}`} icon="sliders" variant="secondary" onPress={() => setFiltersOpen(true)} testID="kitchen-filters-open" />
      {page === "completed" && canExport ? <Button label="Export" icon="download" variant="secondary" loading={exporting} onPress={() => { setExporting(true); setExportError(null); void downloadApiFile(kitchenProjectsApi.exportPath({ search: values.search, assignee: values.assignee, date_from: values.date_from, date_to: values.date_to }), "kitchen-completed.csv", "completed projects CSV", KITCHEN_FLOOR_ID).catch(error => setExportError(errorText(error))).finally(() => setExporting(false)); }} testID="kitchen-completed-export" /> : null}
    </View>
    {exportError ? <Alert tone="error" title="Export unavailable" description={`${exportError} Try Export again.`} /> : null}
    {activeFilters || values.search ? <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}><Text style={[type.bodyMuted, { flex: 1 }]}>{[KITCHEN_ATTENTION_LABELS[values.attention] || "", page === "projects" && values.stage ? STAGE_LABELS[values.stage as KitchenStage] || values.stage : "", values.status, (values.date_from || values.date_to) ? `${page === "completed" ? "Completion date" : ({ created_at: "Lead creation", target_completion_date: "Target completion" } as Record<string, string>)[values.date_field || "target_completion_date"] || "Date"} · India time` : "", values.date_from ? `From ${values.date_from}` : "", values.date_to ? `To ${values.date_to}` : ""].filter(Boolean).join(" · ") || "Search results"}</Text><Button label="Clear" variant="ghost" onPress={clear} /></View> : null}
    {loading ? <LoadingState label="Loading Kitchen projects…" /> : failure ? <ErrorState title="Projects unavailable" subtitle={failure} onRetry={onRetry} /> : result ? <>
      <Text accessibilityLiveRegion="polite" style={type.caption}>{result.total} {result.total === 1 ? "project" : "projects"}{result.total > LIMIT ? ` · Page ${result.page} of ${Math.ceil(result.total / LIMIT)}` : ""}</Text>
      {!rows.length ? <EmptyState title={page === "review" ? "No duplicate reviews waiting" : page === "completed" ? "No completed projects match" : activeFilters || values.search ? "No matching projects" : "No projects in this queue"} subtitle={activeFilters || values.search ? "Try changing the search or filters." : page === "completed" ? "Projects appear after installation is completed and the manager approves closure." : page === "review" ? "Possible matching leads appear here before conversion." : "Projects appear here when they reach this stage."} action={activeFilters || values.search ? <Button label="Clear filters" variant="secondary" onPress={clear} /> : undefined} /> : <View testID="kitchen-compact-list" style={{ gap: 16 }}>{rows.map(project => <ProjectCard key={project.id} project={project} href={projectHref(project)} />)}</View>}
      {result.total > LIMIT ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><Button label="Previous page" variant="secondary" disabled={currentPage <= 1} onPress={() => setValues({ page: String(currentPage - 1) })} /><Button label="Next page" variant="secondary" disabled={currentPage * LIMIT >= result.total} onPress={() => setValues({ page: String(currentPage + 1) })} /></View> : null}
    </> : null}
    {filtersOpen ? <ProjectFilters key={queryKey} visible onClose={() => setFiltersOpen(false)} page={page} stage={stage} values={values} onApply={patch => { setValues({ ...patch, page: "1" }); setFiltersOpen(false); }} /> : null}
  </View>;
}
function ProjectFilters({ visible, onClose, page, stage, values, onApply }: { visible: boolean; onClose: () => void; page: KitchenWorkspacePage; stage?: KitchenStage; values: Record<string, string>; onApply: (value: Record<string, string>) => void }) {
  const { staff } = useAuth();
  const [draft, setDraft] = useState(values);
  const change = (key: string, value: string) => setDraft(current => ({ ...current, [key]: value, ...(key === "stage" ? { status: "" } : {}) }));
  const selectedStage = page === "stage" ? stage : draft.stage as KitchenStage;
  const statuses = selectedStage && KITCHEN_STAGE_STATUSES[selectedStage] || [...new Set(Object.values(KITCHEN_STAGE_STATUSES).flat())];
  const invalidDates = Boolean(draft.date_from && draft.date_to && draft.date_from > draft.date_to);
  return <Sheet scroll visible={visible} onClose={onClose} title="Filter projects" variant="drawer" testID="kitchen-filters"><View style={{ gap: spacing.lg }}>
    {page === "projects" ? <SelectFilter label="Stage" value={draft.stage} options={[{ value: "", label: "All stages" }, ...KITCHEN_STAGES.map(value => ({ value, label: STAGE_LABELS[value] }))]} onChange={value => change("stage", value)} testID="kitchen-stage-filter" /> : null}
    {page !== "completed" && page !== "review" ? <SelectFilter label={selectedStage ? `${STAGE_LABELS[selectedStage]} status` : "Status across stages"} value={draft.status} options={[{ value: "", label: "Any status" }, ...statuses.map(value => ({ value, label: value }))]} onChange={value => change("status", value)} testID="kitchen-status-filter" /> : null}
    {page !== "completed" && page !== "review" ? <SelectFilter label="Needs attention" value={draft.attention} options={[{ value: "", label: "All projects" }, ...Object.entries(KITCHEN_ATTENTION_LABELS).map(([value, label]) => ({ value, label }))]} onChange={value => change("attention", value)} testID="kitchen-attention-filter" /> : null}
    {staff?.role === "owner" ? <AssigneeChoice filter value={draft.assignee || ""} onChange={value => change("assignee", value)} testID="kitchen-filter-assignee" /> : null}
    {page !== "completed" ? <SelectFilter label="Date to filter" value={draft.date_field || "target_completion_date"} options={[{ value: "created_at", label: "Lead creation" }, { value: "target_completion_date", label: "Target completion" }]} onChange={value => change("date_field", value)} /> : null}
    <KitchenDateField label={page === "completed" ? "Completion date from" : "Date from"} value={draft.date_from} onChange={value => change("date_from", value)} max={draft.date_to || undefined} testID="kitchen-date-from" />
    <KitchenDateField label={page === "completed" ? "Completion date to" : "Date to"} value={draft.date_to} onChange={value => change("date_to", value)} min={draft.date_from || undefined} testID="kitchen-date-to" />
    <Text style={type.caption}>Dates use India time. {invalidDates ? "Choose an end date on or after the start date." : "Missing dates do not match a date range."}</Text>
    <SelectFilter label="Sort by" value={draft.sort || "updated_at"} options={[["updated_at", "Last updated"], ["reference", "Project ID"], ["customer", "Customer"], ["stage", "Stage"], ["status", "Status"], ["order_amount", "Order amount"], ["target_completion_date", "Target completion"]].map(([value, label]) => ({ value, label }))} onChange={value => change("sort", value)} />
    <SelectFilter label="Direction" value={draft.direction || "desc"} options={[{ value: "desc", label: "Descending" }, { value: "asc", label: "Ascending" }]} onChange={value => change("direction", value)} />
    <Button label="Apply filters" disabled={invalidDates} onPress={() => onApply(Object.fromEntries(filterKeys.map(key => [key, draft[key] || ""])))} testID="kitchen-filters-apply" />
    <Button label="Reset filters" variant="secondary" onPress={() => setDraft(Object.fromEntries(filterKeys.map(key => [key, ""])))} /><Button label="Cancel" variant="ghost" onPress={onClose} />
  </View></Sheet>;
}
function projectStatus(project: KitchenProject) { return project.status || (project.stage === "lead" ? project.lead.status : project.stage === "visit" ? project.visit.status : project.stage === "cad" ? project.cad.status : STAGE_LABELS[project.stage]); }
function ProjectCard({ project, href }: { project: KitchenProject; href: string }) {
  return <NavigationLink href={href as any} accessibilityLabel={`Open ${project.reference}, ${project.customer.name}`} testID={`kitchen-project-${project.id}`}
    style={({ hovered, pressed }) => ({ gap: spacing.lg, padding: spacing.lg, borderWidth: 1, borderColor: hovered || pressed ? colors.brand : colors.border, borderRadius: radius.md, backgroundColor: hovered || pressed ? colors.surfaceTertiary : colors.surfaceSecondary })}>
    <View style={{ flexDirection: "row", gap: spacing.md, justifyContent: "space-between", alignItems: "center" }}>
      <View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}><Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{project.project_reference || project.reference}</Text><Text style={[type.titleMd, { flexShrink: 1 }]}>{project.customer.name}</Text></View>
      <Feather name="arrow-up-right" size={20} color={colors.brand} />
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm }}><Text style={type.bodyStrong}>{STAGE_LABELS[project.stage]}</Text><Text style={type.bodyMuted}>{projectStatus(project) !== STAGE_LABELS[project.stage] ? projectStatus(project) : ""}</Text></View>
    {project.duplicate_review?.status === "pending" ? <Text style={[type.bodyStrong, { color: colors.warning }]}>Owner duplicate review pending</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.lg, borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.md }}>
      {stageColumns(project.stage).map(column => <View key={column.label} style={{ flexGrow: 1, flexBasis: 150, minWidth: 0, gap: spacing.xs }}><Text style={type.caption}>{column.label}</Text><Text style={type.body}>{column.value(project)}</Text></View>)}
    </View>
    {project.assigned_to_name ? <Text style={type.caption}>Assigned to · {project.assigned_to_name}</Text> : null}
    {project.stage !== "completed" && project.target_completion_date ? <Text style={type.caption}>Target completion · {displayDate(project.target_completion_date)}</Text> : null}
  </NavigationLink>;
}
function currentDesign(project: KitchenProject) { if (project.design_revision_pending) return undefined; const value = project.current_design || project.design_versions?.at(-1); return (value?.workflow_cycle ?? 1) === (project.workflow_cycle ?? 1) ? value : undefined; }
function currentQuotation(project: KitchenProject) { return project.current_quotation || project.quotation_versions?.at(-1); }
function currentOrder(project: KitchenProject) { const value = project.current_order || project.orders?.at(-1); return !project.commercial_basis_invalidated && !value?.authorization_invalidated && value?.quotation_version_id === currentQuotation(project)?.id ? value : undefined; }
function versionContext(project: KitchenProject) {
  if (["production", "installation", "completed"].includes(project.stage) && !currentOrder(project)) return "No active order recorded";
  const quote = currentQuotation(project);
  const design = project.design_versions?.find(row => row.id === quote?.design_version_id) || (project.current_design?.id === quote?.design_version_id ? project.current_design : undefined);
  return quote ? `Quotation ${quote.number} · Design v${design?.number ?? "unavailable"}` : "Not recorded";
}
type StageColumn = { label: string; value: (project: KitchenProject) => string; width?: number };
function stageColumns(stage?: KitchenStage): StageColumn[] {
  const date = (value?: string | null) => displayDate(value);
  const yes = (value?: boolean | null) => value == null ? "Not recorded" : value ? "Yes" : "No";
  switch (stage) {
    case "lead": return [{ label: "Phone", value: p => p.customer.phone || "—" }, { label: "Site location", value: p => p.lead.site_location || "—" }, { label: "Lead source", value: p => p.lead.lead_source || "—" }, { label: "Reference", value: p => referrerLabel(p.lead) || "—" }, { label: "Kitchen type", value: p => p.lead.kitchen_type || "—" }, { label: "Budget", value: p => rupees(p.lead.budget) }, { label: "Lead date", value: p => date(p.lead.lead_date) }];
    case "visit": return [{ label: "Visit date", value: p => date(p.visit.visit_date) }, { label: "Display / model", value: p => p.visit.display_model || "—" }];
    case "cad": return [{ label: "CAD file received", value: p => yes(p.cad.received) }, { label: "Design progress", value: p => `${p.cad.progress}%` }, { label: "Design status", value: p => p.cad.status }];
    case "design": return [{ label: "Requirements", value: p => currentDesign(p)?.requirements ?? p.visit.requirements ?? "—" }, { label: "Budget discussion", value: p => currentDesign(p)?.budget_discussion ?? p.visit.budget_discussion ?? "—" }, { label: "Customer approval", value: p => currentDesign(p)?.response || "Pending" }, { label: "Design revisions", value: p => historicalCount(p.design_revision_count, p.known_design_revision_count) }, { label: "Sent to company", value: p => currentDesign(p)?.handoff_status || (currentDesign(p)?.handoff_date ? "Yes" : "Not recorded") }, { label: "Date sent", value: p => date(currentDesign(p)?.handoff_date) }];
    case "quotation": return [{ label: "Quotation / design", value: p => versionContext(p) }, { label: "Quotation received", value: p => currentQuotation(p)?.received_status || (currentQuotation(p)?.received_date ? "Yes" : "Not recorded") }, { label: "Quotation amount", value: p => rupees(currentQuotation(p)?.amount) }, { label: "Sent to customer", value: p => currentQuotation(p)?.sent_status || (currentQuotation(p)?.shared_date ? "Yes" : "Not recorded") }, { label: "Date sent", value: p => date(currentQuotation(p)?.shared_date) }, { label: "Customer response", value: p => currentQuotation(p)?.response || "Pending" }];
    case "order": return [{ label: "Quotation / design", value: p => versionContext(p) }, { label: "Order confirmed", value: p => p.customer_order_confirmation || yes(currentOrder(p)?.confirmed) }, { label: "Order date", value: p => date(currentOrder(p)?.order_date) }, { label: "Final order amount", value: p => rupees(p.order_amount) }, { label: "Advance received", value: p => currentOrder(p)?.advance.status || yes(currentOrder(p)?.advance.received) }, { label: "Advance amount", value: p => rupees(currentOrder(p)?.advance.amount) }];
    case "production": return [{ label: "Order versions", value: p => versionContext(p) }, { label: "Production status", value: p => p.production?.status || "Not Started" }, { label: "Start date", value: p => date(p.production?.start_date) }, { label: "Completion date", value: p => date(p.production?.completion_date) }];
    case "installation": return [{ label: "Order versions", value: p => versionContext(p) }, { label: "Installation status", value: p => p.installation?.status || "Not Started" }, { label: "Start date", value: p => date(p.installation?.start_date) }, { label: "Completion date", value: p => date(p.installation?.completion_date) }, { label: "Actual site visits", value: p => historicalCount(p.site_visit_count, p.known_site_visit_count) }];
    case "completed": return [{ label: "Order amount", value: p => rupees(p.order_amount) }, { label: "Completion date", value: p => date(p.completion_date) }, { label: "Total design revisions", value: p => historicalCount(p.design_revision_count, p.known_design_revision_count) }, { label: "Total site visits", value: p => historicalCount(p.site_visit_count, p.known_site_visit_count) }];
    default: return [];
  }
}
const customerDetailFields: [keyof KitchenCustomer, string][] = [["address", "Address"], ["property_name", "Property / site name"], ["city", "City"], ["state", "State"], ["pincode", "PIN code"], ["email", "Email"], ["alternate_phone", "Alternate phone"], ["company", "Company"], ["gstin", "GSTIN"], ["notes", "Customer notes"]];
function CreateLead({ onClose, onRegisterClose, onCreated }: { onClose: () => void; onRegisterClose: (handler: () => void) => void; onCreated: (project: KitchenProject) => void }) {
  const { staff } = useAuth();
  const [assignee, setAssignee] = useState("");
  const [customer, setCustomer] = useState<KitchenCustomer | null>(null);
  const [existingMode, setExistingMode] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerDetails, setCustomerDetails] = useState<Partial<KitchenCustomer>>({});
  const [initialLeadDate, setInitialLeadDate] = useState(kitchenToday);
  const [duplicates, setDuplicates] = useState<{ reference: string }[]>([]);
  const [duplicateError, setDuplicateError] = useState(false);
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<KitchenPage<KitchenCustomer> | null>(null);
  const [customerPage, setCustomerPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [lead, setLead] = useState<KitchenLead>(() => ({ status: "New", lead_date: kitchenToday() }));
  const submission = useKitchenSubmission();
  const dirty = Boolean(assignee || customer || customerName || customerPhone || Object.values(customerDetails).some(Boolean) || query || Object.entries(lead).some(([key, value]) => key === "status" ? value !== "New" : key === "lead_date" ? value !== initialLeadDate : Boolean(value)));
  const { allowLeave } = useKitchenExitGuard({ dirty, scope: "/kitchen/stages/lead" });
  const reset = () => { setAssignee(""); setCustomer(null); setCustomerName(""); setCustomerPhone(""); setCustomerDetails({}); setInitialLeadDate(kitchenToday()); setLead({ status: "New", lead_date: kitchenToday() }); setQuery(""); setExistingMode(false); };
  const close = () => {
    if (submission.busy) return;
    const discard = () => { reset(); allowLeave(); onClose(); };
    if (!dirty) { onClose(); return; }
    if (Platform.OS === "web") { if (window.confirm("Discard this unsaved lead?")) discard(); }
    else NativeAlert.alert("Unsaved lead", "Discard this unsaved lead?", [{ text: "Keep editing", style: "cancel" }, { text: "Discard", style: "destructive", onPress: discard }]);
  };
  onRegisterClose(close);
  useEffect(() => {
    const controller = new AbortController();
    setDuplicates([]); setDuplicateError(false);
    if (customer) kitchenProjectsApi.duplicates(customer.id, controller.signal)
      .then(value => { if (!controller.signal.aborted) setDuplicates(value.rows); })
      .catch(() => { if (!controller.signal.aborted) setDuplicateError(true); });
    return () => controller.abort();
  }, [customer]);
  useEffect(() => {
    const controller = new AbortController();
    if (!existingMode) return () => controller.abort();
    setLoading(true); setCustomerError(null); setCustomers(null);
    const timer = setTimeout(() => { kitchenProjectsApi.customers(query, customerPage, controller.signal)
      .then(value => { if (!controller.signal.aborted) setCustomers(value); })
      .catch(error => { if (!controller.signal.aborted) setCustomerError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); }); }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, customerPage, retry, existingMode]);
  const name = customer?.name || customerName;
  const phone = customer?.phone || customerPhone;
  const save = () => {
    if (existingMode && !customer) { submission.setError("Select an existing customer or choose New customer."); return; }
    if (!name.trim() || !phone.trim()) { submission.setError("Customer name and phone are required."); return; }
    if (!lead.site_location?.trim()) { submission.setError("Enter the site location before creating the lead."); return; }
    const body = { ...(assignee ? { assigned_to: assignee } : {}), ...(customer ? { customer_id: customer.id } : { customer: { ...customerDetails, name: name.trim(), phone: phone.trim() } }), lead };
    void submission.submit(body, key => kitchenProjectsApi.create({ ...body, idempotency_key: key }), project => { allowLeave(); reset(); onCreated(project); });
  };
  return <View testID="kitchen-create-page" style={{ width: "100%", maxWidth: 760 }}>
    <View style={{ gap: 24 }}>
      <Text style={type.bodyMuted}>Enter the customer once. Their details follow this project through all nine stages.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><KitchenOption label="New customer" active={!existingMode} disabled={submission.busy} onPress={() => { setExistingMode(false); setCustomer(null); }} testID="kitchen-new-customer" /><KitchenOption label="Existing customer" active={existingMode} disabled={submission.busy} onPress={() => setExistingMode(true)} testID="kitchen-existing-customer" /></View>
      {!existingMode ? <><TextField label="Customer name (required)" value={customerName} onChangeText={setCustomerName} editable={!submission.busy} testID="kitchen-customer-name" /><TextField label="Phone number (required)" value={customerPhone} onChangeText={setCustomerPhone} keyboardType="phone-pad" editable={!submission.busy} testID="kitchen-customer-phone" />{customerDetailFields.map(([key, label]) => <TextField key={key} label={label} value={String(customerDetails[key] || "")} onChangeText={value => setCustomerDetails(current => ({ ...current, [key]: value || null }))} editable={!submission.busy} multiline={key === "address" || key === "notes"} keyboardType={key === "email" ? "email-address" : key === "alternate_phone" ? "phone-pad" : "default"} autoCapitalize={key === "email" ? "none" : "sentences"} testID={`kitchen-customer-${key}`} />)}<Text style={type.caption}>An existing Kitchen customer with the same phone is reused automatically; saved contact details are preserved.</Text></> : null}
      {existingMode ? customer ? <KitchenPanel title={customer.name}><Text style={type.body}>{customer.phone || "No phone recorded"}</Text>{customerDetailFields.map(([key, label]) => customer[key] ? <Text key={key} style={type.body}>{label}: {customer[key]}</Text> : null)}{!customer.address ? <Text style={type.bodyMuted}>No address recorded</Text> : null}{customer.referrer_id ? <Text style={type.body}>Reference: {referrerLabel(customer)}</Text> : null}<Button label="Choose another customer" variant="secondary" disabled={submission.busy} onPress={() => setCustomer(null)} /></KitchenPanel> : <>
        <SearchField placeholder="Search customer name or phone" accessibilityLabel="Choose customer" value={query} onChangeText={value => { setQuery(value); setCustomerPage(1); }} testID="kitchen-customer" />
        {loading ? <LoadingState label="Loading customers…" /> : customerError ? <ErrorState title="Customer directory unavailable" subtitle={customerError} onRetry={() => setRetry(value => value + 1)} /> : !customers?.rows.length ? <Text style={type.bodyMuted}>No customers match. Choose New customer to record this enquiry here.</Text> : <>
          {customers.rows.map(value => <Button key={value.id} label={`${value.name}${value.phone ? ` · ${value.phone}` : ""}`} variant="secondary" testID={`kitchen-customer-${value.id}`} onPress={() => setCustomer(value)} />)}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><Button label="Previous customers" variant="ghost" disabled={customerPage <= 1} onPress={() => setCustomerPage(value => value - 1)} /><Button label="More customers" variant="ghost" disabled={customerPage * 20 >= customers.total} onPress={() => setCustomerPage(value => value + 1)} /></View>
        </>}
      </> : null}
      {duplicates.length ? <Alert tone="warning" title="Possible matching projects" description={`Review ${duplicates.map(row => row.reference).join(", ")}. The lead will require owner review before conversion, even if it is a legitimate separate project.`} /> : null}
      {duplicateError ? <Alert tone="warning" title="Matching projects could not be checked" description="The server will check for possible duplicates when the lead is created. Any matches require owner review before conversion." /> : null}
      {customer && (!customer.name.trim() || !customer.phone?.trim()) ? <Alert tone="warning" title="Customer name and phone required" description="Update the existing customer in the customer directory, then select it again. This form does not overwrite shared customer details." /> : null}
      <>
      <View style={{ paddingTop: 24, borderTopWidth: 1, borderColor: colors.divider, gap: 6 }}><Text style={type.titleMd}>Project enquiry</Text><Text style={type.caption}>Record the site and the customer’s kitchen requirements.</Text></View>
      {staff?.role === "owner" ? <AssigneeChoice value={assignee} onChange={setAssignee} disabled={submission.busy} testID="kitchen-create-assignee" /> : null}
      <LeadFields value={lead} onChange={setLead} disabled={submission.busy} prefix="kitchen-create-lead" />
      <ErrorNotice error={submission.error} />
      <Button label="Create lead" onPress={save} loading={submission.busy} disabled={!name.trim() || !phone.trim() || (existingMode && !customer) || !lead.site_location?.trim() || submission.busy} testID="kitchen-create-submit" />
      </>
      <Button label="Cancel" variant="secondary" disabled={submission.busy} onPress={close} />
    </View>
  </View>;
}
