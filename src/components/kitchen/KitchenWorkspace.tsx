import { useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { AdminPage } from "@/src/components/AdminPage";
import { Alert, Button, EmptyState, ErrorState, LoadingState, SearchField, Sheet, Table, TableCell, TableHeader, TableRow } from "@/src/components/ds";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useBp } from "@/src/design/responsive";
import { NavigationLink } from "@/src/design/NavigationLink";
import { Menu } from "@/src/design/navigationControls";
import { KITCHEN_STAGES, STAGE_LABELS, kitchenProjectsApi, type KitchenAssignee, type KitchenCustomer, type KitchenLead, type KitchenPage, type KitchenProject, type KitchenQuery, type KitchenStage, type KitchenDashboard, type KitchenPolicy } from "@/src/api/kitchenProjects";
import { displayDate, ErrorNotice, errorText, KitchenFloor, KitchenPanel, historicalCount, rupees, useKitchenSubmission } from "./shared";
import { LeadFields } from "./KitchenLeadFields";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { useAuth } from "@/src/state/auth";
import { KitchenDateField, KitchenSelect as SelectFilter, KitchenOption, KITCHEN_STAGE_STATUSES, KITCHEN_ATTENTION_LABELS } from "./KitchenFilters";
import { useKitchenExitGuard } from "./KitchenExitGuard";
import { KitchenPolicyEditor } from "./KitchenPolicy";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
export { LeadFields } from "./KitchenLeadFields";

const LIMIT = 25;
export type KitchenWorkspacePage = "overview" | "projects" | "workflow" | "stage" | "completed" | "review" | "settings" | "new";
type WorkspaceProps = { page?: KitchenWorkspacePage; stage?: KitchenStage };
const titles: Record<KitchenWorkspacePage, string> = { overview: "Kitchen", projects: "Projects", workflow: "Workflow", stage: "Stage", completed: "Completed", review: "Duplicate review", settings: "Kitchen settings", new: "New lead" };
const stageDescriptions: Record<KitchenStage, string> = { lead: "Capture the enquiry and confirm the customer.", visit: "Record showroom visits and requirements.", cad: "Track CAD receipt and design progress.", design: "Present, revise and approve the design.", quotation: "Receive and share company quotations.", order: "Confirm the order and record the advance.", production: "Track production dates and progress.", installation: "Track installation and actual site visits.", completed: "Review completed projects and their history." };
const filterKeys = ["stage", "status", "assignee", "date_from", "date_to", "date_field", "sort", "direction", "attention"] as const;
const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
const url = (path: string, values: Record<string, string | number | undefined>) => { const query = Object.entries(values).filter(([, value]) => value !== "" && value !== undefined).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&"); return `${path}${query ? `?${query}` : ""}`; };
export function KitchenWorkspace(props: WorkspaceProps) { return <KitchenFloor><Workspace {...props} /></KitchenFloor>; }

function Workspace({ page = "overview", stage }: WorkspaceProps) {
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const { isPhone } = useBp();
  const { staff } = useAuth();
  const createAccess = useActionAccess("kitchen_projects", "create", true);
  const canExport = useActionAccess("kitchen_projects", "export", true);
  const [policy, setPolicy] = useState<KitchenPolicy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [workers, setWorkers] = useState<KitchenAssignee[]>([]);
  const [workerError, setWorkerError] = useState(false);
  const [workersLoading, setWorkersLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const canAssign = staff?.role === "owner" || Boolean(staff && policy?.department_manager_user_ids?.includes(staff.id));
  const canCreate = createAccess && canAssign;
  const owner = staff?.role === "owner";
  const path = page === "overview" ? "/kitchen" : page === "stage" ? `/kitchen/stages/${stage}` : `/kitchen/${page}`;
  const values = Object.fromEntries(["search", ...filterKeys, "page", "view", "board_stage"].map(key => [key, one(params[key])])) as Record<string, string>;
  if (page === "stage") values.stage = ""; // The dynamic route owns stage; never shadow it with a query parameter.
  if (page === "completed" || page === "review") values.status = "";
  const returnTo = url(path, values);
  const setValues = (patch: Record<string, string>) => {
    const next = { ...patch };
    if (page === "stage") delete next.stage;
    router.setParams(next);
  };
  const [search, setSearch] = useState(values.search);
  useEffect(() => { setSearch(values.search); }, [values.search]);
  useEffect(() => {
    if (search === values.search) return;
    const timer = setTimeout(() => router.setParams({ search, page: "1" }), 250);
    return () => clearTimeout(timer);
  }, [search, values.search, router]);
  useEffect(() => {
    const controller = new AbortController();
    kitchenProjectsApi.configuration(controller.signal).then(value => { if (!controller.signal.aborted) { setPolicy(value); setPolicyError(null); } }).catch(error => { if (!controller.signal.aborted) setPolicyError(errorText(error)); });
    setWorkersLoading(true);
    kitchenProjectsApi.assignees(controller.signal).then(value => { if (!controller.signal.aborted) { setWorkers(value.rows); setWorkerError(false); } }).catch(() => { if (!controller.signal.aborted) setWorkerError(true); }).finally(() => { if (!controller.signal.aborted) setWorkersLoading(false); });
    return () => controller.abort();
  }, [retry]);
  const title = page === "stage" && stage ? STAGE_LABELS[stage] : titles[page];
  const subtitles: Partial<Record<KitchenWorkspacePage, string>> = { overview: "Every kitchen, from first enquiry to final installation.", projects: "One project record, across every stage.", workflow: "Choose a stage to see the work waiting there.", completed: "Finished installations, with their full history.", review: "Review possible duplicate leads before conversion.", new: "Link the customer once. Their details follow the project.", settings: "Department managers and the approved operating rules." };
  const primary = canCreate && (["overview", "projects"].includes(page) || page === "stage" && stage === "lead") ? <NavigationLink href={"/kitchen/new" as any} testID="kitchen-create" accessibilityLabel="Add lead" style={{ minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: radius.md, justifyContent: "center", backgroundColor: colors.brand }}><Text style={[type.label, { color: colors.onBrand }]}>Add lead</Text></NavigationLink> : undefined;
  return <AdminPage title={title} subtitle={page === "stage" && stage ? stageDescriptions[stage] : subtitles[page]} overline={page !== "overview" ? "Kitchen" : undefined} right={primary} back={page === "overview" ? undefined : () => { if (router.canGoBack()) router.back(); else router.replace((page === "stage" ? "/kitchen/workflow" : "/kitchen") as any); }}>
    {page === "overview" ? <Overview owner={owner} retry={retry} onRetry={() => setRetry(value => value + 1)} /> : null}
    {page === "workflow" ? <Workflow retry={retry} onRetry={() => setRetry(value => value + 1)} /> : null}
    {["projects", "stage", "completed", "review"].includes(page) ? page === "review" && !owner ? <ErrorState title="Owner access required" subtitle="Only the owner can review duplicate leads." /> : <ProjectList page={page} stage={stage} values={values} setValues={setValues} returnTo={returnTo} search={search} setSearch={setSearch} workers={workers} workerError={workerError} retry={retry} onRetry={() => setRetry(value => value + 1)} canExport={canExport} isPhone={isPhone} /> : null}
    {page === "settings" ? !owner ? <ErrorState title="Owner access required" subtitle="The owner manages department managers and policy adoption." /> : policyError ? <ErrorState title="Settings unavailable" subtitle={policyError} onRetry={() => setRetry(value => value + 1)} /> : policy ? <View style={{ width: "100%", maxWidth: 840 }}><KitchenPolicyEditor policy={policy} workers={workers} workerError={workerError || workersLoading} onSaved={value => { setPolicy(value); setRetry(current => current + 1); }} onReload={() => setRetry(value => value + 1)} /></View> : <LoadingState label="Loading settings…" /> : null}
    {page === "new" ? !createAccess ? <ErrorState title="Lead creation access required" /> : policyError && !owner ? <ErrorState title="Creation authority unavailable" subtitle={policyError} onRetry={() => setRetry(value => value + 1)} /> : !policy && !owner ? <LoadingState label="Checking creation authority…" /> : !canCreate ? <Alert tone="info" title="Ask the owner or a department manager" description="Only the owner or an explicitly selected department manager may create and assign a new lead." /> : <CreateLead onClose={() => { if (router.canGoBack()) router.back(); else router.replace("/kitchen/projects" as any); }} onCreated={project => router.replace(url(`/kitchen/${project.id}`, { returnTo: "/kitchen/projects" }) as any)} workers={workers} workerError={workerError} canAssign={canAssign} /> : null}
  </AdminPage>;
}

function Destination({ href, title, subtitle, testID }: { href: string; title: string; subtitle?: string; testID?: string }) {
  return <NavigationLink href={href as any} accessibilityLabel={title} testID={testID} style={({ hovered, pressed }) => ({ minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: hovered || pressed ? colors.surfaceTertiary : colors.surfaceSecondary })}><View style={{ flex: 1, gap: spacing.xs }}><Text style={type.bodyStrong}>{title}</Text>{subtitle ? <Text style={type.bodyMuted}>{subtitle}</Text> : null}</View><Feather name="chevron-right" size={20} color={colors.onSurfaceMuted} /></NavigationLink>;
}
function Overview({ owner, retry, onRetry }: { owner: boolean; retry: number; onRetry: () => void }) {
  const { isPhone } = useBp();
  const [dashboard, setDashboard] = useState<KitchenDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); kitchenProjectsApi.dashboard(controller.signal).then(value => { if (!controller.signal.aborted) { setDashboard(value); setError(null); } }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); }); return () => controller.abort(); }, [retry]);
  return <View style={{ width: "100%", maxWidth: 1120, gap: spacing.xl }}>
    <View style={{ gap: spacing.md }} testID="kitchen-overview-totals">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
        {[["Active projects", dashboard?.active_projects, "active"], ["On Hold", dashboard?.on_hold_projects, "on_hold"], ["Pending manager approvals", dashboard?.pending_approvals, "pending_approval"], ["Next action overdue", dashboard?.next_action_overdue_projects, "next_action_overdue"], ["Completion overdue", dashboard?.completion_overdue_projects, "completion_overdue"], ["Active order value", dashboard ? rupees(dashboard.active_order_value) : undefined, "active_order"]].map(([label, value, attention]) => {
          const contents = <><Text style={type.bodyMuted}>{label}</Text><Text style={type.titleLg}>{value ?? (error ? "Unavailable" : "…")}</Text><Text style={type.caption}>{dashboard ? "View projects →" : error ? "Totals unavailable" : "Loading totals…"}</Text></>;
          const tile = { flexBasis: isPhone ? "44%" : "28%", minWidth: isPhone ? 140 : 220, flexGrow: 1, gap: spacing.sm, padding: spacing.lg, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md } as const;
          return dashboard ? <NavigationLink key={String(label)} href={url("/kitchen/projects", { attention: String(attention) }) as any} testID={`kitchen-metric-${attention}`} accessibilityLabel={`View ${label}: ${value ?? "Unavailable"}`} style={({ hovered, pressed }) => ({ ...tile, backgroundColor: hovered || pressed ? colors.surfaceTertiary : colors.surfaceSecondary })}>{contents}</NavigationLink> : <View key={String(label)} style={tile}>{contents}</View>;
        })}
      </View><Text style={type.caption}>Your accessible projects only. Active excludes Completed, Lost, Cancelled and On Hold. Missing deadlines are never overdue; dates use India time.</Text>
      {error ? <ErrorState title="Overview unavailable" subtitle={error} onRetry={onRetry} /> : null}
    </View>
    <View style={{ gap: spacing.md }}><Text style={type.titleMd}>Your workspace</Text><Destination href="/kitchen/projects" title="Projects" subtitle="Find a customer or browse the board and table." testID="kitchen-section-projects" /><Destination href="/kitchen/workflow" title="Workflow" subtitle="Open the queue for a stage, from Lead to Installation." testID="kitchen-section-workflow" /><Destination href="/kitchen/completed" title="Completed" subtitle="Search finished installations and export the archive." testID="kitchen-section-completed" /></View>
    {owner ? <View style={{ gap: spacing.md }}><Text style={type.titleMd}>Owner workspace</Text><Destination href="/kitchen/review" title="Duplicate review" subtitle="Decide whether matching leads are distinct projects." testID="kitchen-section-duplicates" /><Destination href="/kitchen/settings" title="Department settings" subtitle="Select managers and adopt the approved policy." testID="kitchen-section-policy" /></View> : null}
  </View>;
}
function Workflow({ retry, onRetry }: { retry: number; onRetry: () => void }) {
  const [dashboard, setDashboard] = useState<KitchenDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); kitchenProjectsApi.dashboard(controller.signal).then(value => { if (!controller.signal.aborted) { setDashboard(value); setError(null); } }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); }); return () => controller.abort(); }, [retry]);
  return <View style={{ width: "100%", maxWidth: 840, gap: spacing.xl }}>
    {error ? <ErrorState title="Workload unavailable" subtitle={error} onRetry={onRetry} /> : !dashboard ? <LoadingState label="Loading department workload…" /> : <>
      <View style={{ gap: spacing.md }}><Text accessibilityRole="header" style={type.titleMd}>Needs attention</Text>{["pending_approval", "next_action_overdue", "completion_overdue"].map((attention, index) => <Destination key={attention} href={url("/kitchen/projects", { attention })} title={KITCHEN_ATTENTION_LABELS[attention]} subtitle={`${[dashboard.pending_approvals, dashboard.next_action_overdue_projects, dashboard.completion_overdue_projects][index] ?? "Unavailable"} projects · current authorized totals`} testID={`kitchen-workflow-${attention}`} />)}</View>
      <View style={{ gap: spacing.md }}><Text accessibilityRole="header" style={type.titleMd}>Active workload</Text><Text style={type.bodyMuted}>Current stage assignments across active projects.</Text>{dashboard.workload?.length ? dashboard.workload.map(worker => <Destination key={worker.assignee_id || "unassigned"} href={url("/kitchen/projects", { attention: "active", assignee: worker.assignee_id || "unassigned" })} title={worker.assignee_name || "Unassigned"} subtitle={`${worker.project_count} active ${worker.project_count === 1 ? "project" : "projects"}`} testID={`kitchen-workload-${worker.assignee_id || "unassigned"}`} />) : <Text style={type.bodyMuted}>No active assigned work.</Text>}</View>
    </>}
    <View style={{ gap: spacing.md }}><Text accessibilityRole="header" style={type.titleMd}>Stage queues</Text><Text style={type.bodyMuted}>Counts include all accessible projects in each stage, including held projects.</Text>{KITCHEN_STAGES.map((stage, index) => <Destination key={stage} href={stage === "completed" ? "/kitchen/completed" : `/kitchen/stages/${stage}`} title={`${index + 1}. ${STAGE_LABELS[stage]}${dashboard?.stage_counts ? ` · ${dashboard.stage_counts[stage]}` : ""}`} subtitle={stageDescriptions[stage]} testID={`kitchen-workflow-${stage}`} />)}</View>
  </View>;
}

function ProjectList({ page, stage, values, setValues, returnTo, search, setSearch, workers, workerError, retry, onRetry, canExport, isPhone }: { page: KitchenWorkspacePage; stage?: KitchenStage; values: Record<string, string>; setValues: (patch: Record<string, string>) => void; returnTo: string; search: string; setSearch: (value: string) => void; workers: KitchenAssignee[]; workerError: boolean; retry: number; onRetry: () => void; canExport: boolean; isPhone: boolean }) {
  const [contentWidth, setContentWidth] = useState(0);
  const [result, setResult] = useState<KitchenPage<KitchenProject> | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const currentPage = /^\d+$/.test(values.page) ? Math.max(1, Number(values.page)) : 1;
  const query: KitchenQuery = { search: values.search, stage: page === "completed" ? "completed" : page === "review" ? "lead" : page === "stage" ? stage : values.stage, status: values.status, attention: values.attention as KitchenQuery["attention"], duplicate_review: page === "review" ? "pending" : undefined, assignee: values.assignee, date_from: values.date_from, date_to: values.date_to, date_field: page === "completed" ? "completion_date" : values.date_field || "target_completion_date", sort: values.sort || "updated_at", direction: values.direction === "asc" ? "asc" : "desc", page: currentPage, limit: LIMIT };
  const queryKey = JSON.stringify(query);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setFailure(null); setResult(null); kitchenProjectsApi.list(JSON.parse(queryKey), controller.signal).then(value => { if (!controller.signal.aborted) setResult(value); }).catch(error => { if (!controller.signal.aborted) setFailure(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [queryKey, retry]);
  const view = ["board", "table", "list"].includes(values.view) ? values.view : isPhone ? "list" : "table";
  const activeFilters = filterKeys.filter(key => values[key] && !["sort", "direction", "date_field"].includes(key)).length;
  const rows = result?.rows || [];
  const projectHref = (project: KitchenProject) => url(`/kitchen/${project.id}`, { returnTo });
  const clear = () => setValues(Object.fromEntries([...filterKeys, "search"].map(key => [key, ""]).concat([["page", "1"]])));
  return <View onLayout={event => setContentWidth(event.nativeEvent.layout.width)} style={{ gap: spacing.lg }}>
    {page === "review" ? <Text style={type.bodyMuted}>Confirm a distinct project or mark a duplicate lead Lost. The original record and customer stay intact.</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, alignItems: "center" }}>
      <View style={{ flex: 1, minWidth: Math.min(220, contentWidth || 220) }}><SearchField placeholder={page === "completed" ? "Search completed projects" : "Search project or customer"} accessibilityLabel="Search Kitchen projects" value={search} onChangeText={setSearch} onClear={() => setSearch("")} testID="kitchen-search" /></View>
      <Button label={`Filters${activeFilters ? ` (${activeFilters})` : ""}`} icon="sliders" variant="secondary" onPress={() => setFiltersOpen(true)} testID="kitchen-filters-open" />
      {page === "projects" ? <Menu triggerLabel="Project view" triggerTestID="kitchen-view-menu" items={[{ label: "Compact list", onPress: () => setValues({ view: "list" }) }, { label: "Board", onPress: () => setValues({ view: "board" }) }, { label: "Table", onPress: () => setValues({ view: "table" }) }]}><View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md }}><Text style={type.label}>{view === "list" ? "List" : view === "board" ? "Board" : "Table"}</Text><Feather name="chevron-down" size={16} color={colors.onSurfaceMuted} /></View></Menu> : null}
      {page === "completed" && canExport ? <Button label="Export" icon="download" variant="secondary" loading={exporting} onPress={() => { setExporting(true); void downloadApiFile(kitchenProjectsApi.exportPath({ search: values.search, date_from: values.date_from, date_to: values.date_to, assignee: values.assignee }), "kitchen-completed.csv", "completed projects CSV", KITCHEN_FLOOR_ID).finally(() => setExporting(false)); }} testID="kitchen-completed-export" /> : null}
    </View>
    {activeFilters || values.search ? <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}><Text style={[type.bodyMuted, { flex: 1 }]}>{[KITCHEN_ATTENTION_LABELS[values.attention] || "", page === "projects" && values.stage ? STAGE_LABELS[values.stage as KitchenStage] || values.stage : "", values.status, values.assignee === "unassigned" ? "Unassigned" : workers.find(worker => worker.id === values.assignee)?.full_name, (values.date_from || values.date_to) ? `${page === "completed" ? "Completion date" : ({ created_at: "Lead creation", deadline: "Next action deadline", target_completion_date: "Target completion" } as Record<string, string>)[values.date_field || "target_completion_date"] || "Date"} · India time` : "", values.date_from ? `From ${values.date_from}` : "", values.date_to ? `To ${values.date_to}` : ""].filter(Boolean).join(" · ") || "Search results"}</Text><Button label="Clear" variant="ghost" onPress={clear} /></View> : null}
    {loading ? <LoadingState label="Loading Kitchen projects…" /> : failure ? <ErrorState title="Projects unavailable" subtitle={failure} onRetry={onRetry} /> : result ? <>
      <Text accessibilityLiveRegion="polite" style={type.caption}>{result.total} {result.total === 1 ? "project" : "projects"}{result.total > LIMIT ? ` · Page ${result.page} of ${Math.ceil(result.total / LIMIT)}` : ""}</Text>
      {!rows.length ? <EmptyState title={page === "review" ? "No duplicate reviews waiting" : page === "completed" ? "No completed projects match" : activeFilters || values.search ? "No matching projects" : "No projects in this queue"} subtitle={activeFilters || values.search ? "Try changing the search or filters." : page === "completed" ? "Projects appear after installation is completed and the manager approves closure." : page === "review" ? "Possible matching leads appear here before conversion." : "Projects appear here when they reach this stage."} action={activeFilters || values.search ? <Button label="Clear filters" variant="secondary" onPress={clear} /> : undefined} /> : page === "completed" ? <View style={{ gap: spacing.md, maxWidth: 1000 }}>{rows.map(project => <NavigationLink key={project.id} href={projectHref(project) as any} testID={`kitchen-project-${project.id}`} accessibilityLabel={`Open ${project.reference}, ${project.customer.name}`} style={{ backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.lg, gap: spacing.sm }}><Text style={type.bodyStrong}>{project.customer.name}</Text><Text style={type.body}>{project.project_reference || project.reference} · {rupees(project.order_amount)}</Text><Text style={type.bodyMuted}>Completed {displayDate(project.completion_date)}</Text><Text style={type.caption}>Design revisions {historicalCount(project.design_revision_count, project.known_design_revision_count)} · Actual site visits {historicalCount(project.site_visit_count, project.known_site_visit_count)}</Text></NavigationLink>)}</View> : page === "projects" && view === "table" ? <ProjectTable rows={rows} projectHref={projectHref} compact={contentWidth > 0 && contentWidth < 740} /> : page === "projects" && view === "board" ? <ProjectBoard rows={rows} projectHref={projectHref} compact={contentWidth > 0 ? contentWidth < 740 : isPhone} selectedStage={values.board_stage} onStageChange={board_stage => setValues({ board_stage })} /> : <View style={{ gap: spacing.md, maxWidth: 1000 }}>{rows.map(project => <ProjectCard key={project.id} project={project} href={projectHref(project)} />)}</View>}
      {result.total > LIMIT ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><Button label="Previous page" variant="secondary" disabled={currentPage <= 1} onPress={() => setValues({ page: String(currentPage - 1) })} /><Button label="Next page" variant="secondary" disabled={currentPage * LIMIT >= result.total} onPress={() => setValues({ page: String(currentPage + 1) })} /></View> : null}
    </> : null}
    {filtersOpen ? <ProjectFilters key={queryKey} visible onClose={() => setFiltersOpen(false)} page={page} stage={stage} values={values} workers={workers} workerError={workerError} onRetry={onRetry} onApply={patch => { setValues({ ...patch, page: "1" }); setFiltersOpen(false); }} /> : null}
  </View>;
}
function ProjectFilters({ visible, onClose, page, stage, values, workers, workerError, onRetry, onApply }: { visible: boolean; onClose: () => void; page: KitchenWorkspacePage; stage?: KitchenStage; values: Record<string, string>; workers: KitchenAssignee[]; workerError: boolean; onRetry: () => void; onApply: (value: Record<string, string>) => void }) {
  const [draft, setDraft] = useState(values);
  const change = (key: string, value: string) => setDraft(current => ({ ...current, [key]: value, ...(key === "stage" ? { status: "" } : {}) }));
  const selectedStage = page === "stage" ? stage : draft.stage as KitchenStage;
  const statuses = selectedStage && KITCHEN_STAGE_STATUSES[selectedStage] || [...new Set(Object.values(KITCHEN_STAGE_STATUSES).flat())];
  const invalidDates = Boolean(draft.date_from && draft.date_to && draft.date_from > draft.date_to);
  return <Sheet visible={visible} onClose={onClose} title="Filter projects" variant="drawer" testID="kitchen-filters"><View style={{ gap: spacing.lg }}>
    {page === "projects" ? <SelectFilter label="Stage" value={draft.stage} options={[{ value: "", label: "All stages" }, ...KITCHEN_STAGES.map(value => ({ value, label: STAGE_LABELS[value] }))]} onChange={value => change("stage", value)} testID="kitchen-stage-filter" /> : null}
    {page !== "completed" && page !== "review" ? <SelectFilter label={selectedStage ? `${STAGE_LABELS[selectedStage]} status` : "Status across stages"} value={draft.status} options={[{ value: "", label: "Any status" }, ...statuses.map(value => ({ value, label: value }))]} onChange={value => change("status", value)} testID="kitchen-status-filter" /> : null}
    {page !== "completed" && page !== "review" ? <SelectFilter label="Needs attention" value={draft.attention} options={[{ value: "", label: "All projects" }, ...Object.entries(KITCHEN_ATTENTION_LABELS).map(([value, label]) => ({ value, label }))]} onChange={value => change("attention", value)} testID="kitchen-attention-filter" /> : null}
    {workerError ? <ErrorState title="Team filters unavailable" onRetry={onRetry} /> : <SelectFilter label="Assigned person" value={draft.assignee} options={[{ value: "", label: "Anyone" }, { value: "unassigned", label: "Unassigned" }, ...workers.map(worker => ({ value: worker.id, label: worker.full_name }))]} onChange={value => change("assignee", value)} />}
    {page !== "completed" ? <SelectFilter label="Date to filter" value={draft.date_field || "target_completion_date"} options={[{ value: "created_at", label: "Lead creation" }, { value: "deadline", label: "Next action deadline" }, { value: "target_completion_date", label: "Target completion" }]} onChange={value => change("date_field", value)} /> : null}
    <KitchenDateField label={page === "completed" ? "Completion date from" : "Date from"} value={draft.date_from} onChange={value => change("date_from", value)} max={draft.date_to || undefined} testID="kitchen-date-from" />
    <KitchenDateField label={page === "completed" ? "Completion date to" : "Date to"} value={draft.date_to} onChange={value => change("date_to", value)} min={draft.date_from || undefined} testID="kitchen-date-to" />
    <Text style={type.caption}>Dates use India time. {invalidDates ? "Choose an end date on or after the start date." : "Missing dates do not match a date range."}</Text>
    <SelectFilter label="Sort by" value={draft.sort || "updated_at"} options={[["updated_at", "Last updated"], ["reference", "Project ID"], ["customer", "Customer"], ["stage", "Stage"], ["status", "Status"], ["assignee", "Assigned person"], ["order_amount", "Order amount"], ["target_completion_date", "Target completion"], ["next_action", "Next action"]].map(([value, label]) => ({ value, label }))} onChange={value => change("sort", value)} />
    <SelectFilter label="Direction" value={draft.direction || "desc"} options={[{ value: "desc", label: "Descending" }, { value: "asc", label: "Ascending" }]} onChange={value => change("direction", value)} />
    <Button label="Apply filters" disabled={invalidDates} onPress={() => onApply(Object.fromEntries(filterKeys.map(key => [key, draft[key] || ""])))} testID="kitchen-filters-apply" />
    <Button label="Reset filters" variant="secondary" onPress={() => setDraft(Object.fromEntries(filterKeys.map(key => [key, ""])))} /><Button label="Cancel" variant="ghost" onPress={onClose} />
  </View></Sheet>;
}
function projectStatus(project: KitchenProject) { return project.status || (project.stage === "lead" ? project.lead.status : project.stage === "visit" ? project.visit.status : project.stage === "cad" ? project.cad.status : STAGE_LABELS[project.stage]); }
function ProjectCard({ project, href }: { project: KitchenProject; href: string }) { return <NavigationLink href={href as any} accessibilityLabel={`Open ${project.reference}, ${project.customer.name}`} testID={`kitchen-project-${project.id}`} style={({ hovered, pressed }) => ({ gap: spacing.sm, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: hovered || pressed ? colors.surfaceTertiary : colors.surfaceSecondary })}><View style={{ flexDirection: "row", gap: spacing.sm, justifyContent: "space-between", alignItems: "center" }}><View style={{ flex: 1, gap: spacing.xs }}><Text style={type.bodyStrong}>{project.customer.name}</Text><Text style={type.caption}>{project.project_reference || project.reference}</Text></View><Feather name="chevron-right" size={20} color={colors.onSurfaceMuted} /></View><Text style={type.bodyMuted}>{projectStatus(project) === STAGE_LABELS[project.stage] ? STAGE_LABELS[project.stage] : `${STAGE_LABELS[project.stage]} · ${projectStatus(project)}`}</Text><Text style={type.caption}>Assigned to: {project.assigned_to_name || "Unassigned"}</Text><Text style={type.body}>{project.next_action || "No next action recorded"}</Text>{project.deadline ? <Text style={type.caption}>Due {displayDate(project.deadline)}</Text> : null}{project.duplicate_review?.status === "pending" ? <Text style={type.bodyStrong}>Owner duplicate review pending</Text> : null}</NavigationLink>; }
function ProjectBoard({ rows, projectHref, compact, selectedStage, onStageChange }: { rows: KitchenProject[]; projectHref: (project: KitchenProject) => string; compact: boolean; selectedStage: string; onStageChange: (stage: string) => void }) {
  const selected = KITCHEN_STAGES.includes(selectedStage as KitchenStage) ? selectedStage as KitchenStage : "";
  const stages = selected ? [selected] : KITCHEN_STAGES;
  const column = (stage: KitchenStage) => <View key={stage} testID={`kitchen-board-group-${stage}`} style={{ ...(compact ? {} : { width: 290 }), gap: spacing.md }}><Text accessibilityRole="header" style={type.bodyStrong}>{STAGE_LABELS[stage]} · {rows.filter(project => project.stage === stage).length}</Text>{rows.filter(project => project.stage === stage).map(project => <ProjectCard key={project.id} project={project} href={projectHref(project)} />)}{!rows.some(project => project.stage === stage) ? <Text style={type.caption}>No cards on this page</Text> : null}</View>;
  return <View testID="kitchen-board" style={{ gap: spacing.lg }}><Text style={type.caption}>{compact ? "Compact board, grouped by stage. " : ""}Cards and column counts show this page of results. Use the stage queues for full department totals.</Text>{compact ? <><SelectFilter label="Board stage" value={selected} options={[{ value: "", label: "All stages, grouped" }, ...KITCHEN_STAGES.map(stage => ({ value: stage, label: STAGE_LABELS[stage] }))]} onChange={onStageChange} testID="kitchen-board-stage" /><View testID="kitchen-board-compact" style={{ gap: spacing.xl }}>{stages.map(column)}</View></> : <ScrollView horizontal showsHorizontalScrollIndicator keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.md }} testID="kitchen-board-columns">{stages.map(column)}</ScrollView>}</View>;
}
function ProjectTable({ rows, projectHref, compact }: { rows: KitchenProject[]; projectHref: (project: KitchenProject) => string; compact: boolean }) {
  if (compact) return <View testID="kitchen-table" style={{ gap: spacing.md }}><Text style={type.caption}>Table details, stacked to fit the available width. Every column remains visible.</Text>{rows.map(project => <View key={project.id} role="row" style={{ gap: spacing.sm, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary }}><NavigationLink href={projectHref(project) as any} testID={`kitchen-project-${project.id}`} accessibilityLabel={`Open ${project.reference}, ${project.customer.name}`} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[type.bodyStrong, { color: colors.brand }]}>{project.customer.name} · {project.project_reference || project.reference}</Text></NavigationLink><Text style={type.body}>Stage / status: {projectStatus(project) === STAGE_LABELS[project.stage] ? STAGE_LABELS[project.stage] : `${STAGE_LABELS[project.stage]} · ${projectStatus(project)}`}</Text><Text style={type.body}>Assigned to: {project.assigned_to_name || "Unassigned"}</Text><Text style={type.body}>Order amount: {rupees(project.commercial_basis_invalidated ? null : project.final_order_amount || project.order_amount)}</Text><Text style={type.body}>Target completion: {displayDate(project.target_completion_date)}</Text><Text style={type.body}>Next action: {project.next_action || "—"}</Text></View>)}</View>;
  return <ScrollView horizontal testID="kitchen-table" showsHorizontalScrollIndicator><View style={{ width: 1280 }}><Table><TableHeader columns={[{ label: "Project ID", width: 160 }, { label: "Customer", width: 190 }, { label: "Stage / status", width: 190 }, { label: "Assigned to", width: 150 }, { label: "Order amount", width: 140 }, { label: "Target completion", width: 160 }, { label: "Next action", flex: 1 }]} />{rows.map(project => <TableRow key={project.id}><TableCell width={160}><NavigationLink href={projectHref(project) as any} testID={`kitchen-project-${project.id}`} accessibilityLabel={`Open ${project.reference}, ${project.customer.name}`} style={{ minHeight: 44, justifyContent: "center" }}><Text style={[type.bodyStrong, { color: colors.brand }]}>{project.project_reference || project.reference}</Text></NavigationLink></TableCell><TableCell width={190}><Text style={type.body}>{project.customer.name}</Text></TableCell><TableCell width={190}><Text style={type.body}>{projectStatus(project) === STAGE_LABELS[project.stage] ? STAGE_LABELS[project.stage] : `${STAGE_LABELS[project.stage]} · ${projectStatus(project)}`}</Text></TableCell><TableCell width={150}><Text style={type.body}>{project.assigned_to_name || "Unassigned"}</Text></TableCell><TableCell width={140}><Text style={type.body}>{rupees(project.commercial_basis_invalidated ? null : project.final_order_amount || project.order_amount)}</Text></TableCell><TableCell width={160}><Text style={type.body}>{displayDate(project.target_completion_date)}</Text></TableCell><TableCell><Text style={type.body}>{project.next_action || "—"}</Text></TableCell></TableRow>)}</Table></View></ScrollView>; }
function CreateLead({ onClose, onCreated, workers, workerError, canAssign }: { onClose: () => void; onCreated: (project: KitchenProject) => void; workers: KitchenAssignee[]; workerError: boolean; canAssign: boolean }) {
  const [customer, setCustomer] = useState<KitchenCustomer | null>(null);
  const [duplicates, setDuplicates] = useState<{ reference: string }[]>([]);
  const [duplicateError, setDuplicateError] = useState(false);
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<KitchenPage<KitchenCustomer> | null>(null);
  const [customerPage, setCustomerPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [assignedTo, setAssignedTo] = useState("");
  const [lead, setLead] = useState<KitchenLead>({ status: "New" });
  const submission = useKitchenSubmission();
  const { allowLeave } = useKitchenExitGuard({ dirty: Boolean(customer || query || assignedTo || Object.entries(lead).some(([key, value]) => key === "status" ? value !== "New" : Boolean(value))), scope: "/kitchen/new" });
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
    setLoading(true); setCustomerError(null); setCustomers(null);
    const timer = setTimeout(() => { kitchenProjectsApi.customers(query, customerPage, controller.signal)
      .then(value => { if (!controller.signal.aborted) setCustomers(value); })
      .catch(error => { if (!controller.signal.aborted) setCustomerError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); }); }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, customerPage, retry]);
  const save = () => {
    if (!customer) { submission.setError("Select an existing customer."); return; }
    if (!customer.name.trim() || !customer.phone?.trim()) { submission.setError("Customer name and phone are required. Update the existing customer in the customer directory, then select it again."); return; }
    if (!lead.site_location?.trim()) { submission.setError("Enter the site location before creating the lead."); return; }
    const body = { customer_id: customer.id, lead, ...(canAssign && assignedTo ? { assigned_to: assignedTo } : {}) };
    void submission.submit(body, key => kitchenProjectsApi.create({ ...body, idempotency_key: key }), project => {
      allowLeave(); setCustomer(null); setLead({ status: "New" }); setQuery(""); setAssignedTo(""); onCreated(project);
    });
  };
  return <View testID="kitchen-create-page" style={{ width: "100%", maxWidth: 760 }}>
    <View style={{ gap: spacing.lg }}>
      <Text style={type.bodyMuted}>Select the existing customer. The same customer will stay linked throughout this project.</Text>
      {customer ? <KitchenPanel title={customer.name}><Text style={type.body}>{customer.phone || "No phone recorded"}</Text><Text style={type.body}>{customer.address || "No address recorded"}</Text><Button label="Choose another customer" variant="secondary" disabled={submission.busy} onPress={() => setCustomer(null)} /></KitchenPanel> : <>
        <SearchField placeholder="Search customer name or phone" accessibilityLabel="Choose customer" value={query} onChangeText={value => { setQuery(value); setCustomerPage(1); }} testID="kitchen-customer" />
        {loading ? <LoadingState label="Loading customers…" /> : customerError ? <ErrorState title="Customer directory unavailable" subtitle={customerError} onRetry={() => setRetry(value => value + 1)} /> : !customers?.rows.length ? <Text style={type.bodyMuted}>No customers match. Add the customer in the customer directory, then retry.</Text> : <>
          {customers.rows.map(value => <Button key={value.id} label={`${value.name}${value.phone ? ` · ${value.phone}` : ""}`} variant="secondary" testID={`kitchen-customer-${value.id}`} onPress={() => setCustomer(value)} />)}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><Button label="Previous customers" variant="ghost" disabled={customerPage <= 1} onPress={() => setCustomerPage(value => value - 1)} /><Button label="More customers" variant="ghost" disabled={customerPage * 20 >= customers.total} onPress={() => setCustomerPage(value => value + 1)} /></View>
        </>}
      </>}
      {duplicates.length ? <Alert tone="warning" title="Possible matching projects" description={`Review ${duplicates.map(row => row.reference).join(", ")}. The lead will require owner review before conversion, even if it is a legitimate separate project.`} /> : null}
      {duplicateError ? <Alert tone="warning" title="Matching projects could not be checked" description="The server will check for possible duplicates when the lead is created. Any matches require owner review before conversion." /> : null}
      {customer && (!customer.name.trim() || !customer.phone?.trim()) ? <Alert tone="warning" title="Customer name and phone required" description="Update the existing customer in the customer directory, then select it again. This form does not overwrite shared customer details." /> : null}
      {customer ? <>
      <Text style={type.titleMd}>Lead details</Text>
      <LeadFields value={lead} onChange={setLead} disabled={submission.busy} prefix="kitchen-create-lead" />
      {canAssign ? <View style={{ gap: spacing.sm }}><Text style={type.label}>Assigned person</Text><Text style={type.caption}>Assignment is manual. You can change it for each stage.</Text>
        {workerError ? <Text style={type.bodyMuted}>Team choices unavailable. Leave unassigned or retry the workspace.</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}><KitchenOption label="Unassigned" disabled={submission.busy} active={!assignedTo} onPress={() => setAssignedTo("")} />{workers.map(worker => <KitchenOption key={worker.id} label={worker.full_name} disabled={submission.busy} active={assignedTo === worker.id} onPress={() => setAssignedTo(worker.id)} testID={`kitchen-create-assign-${worker.id}`} />)}</View>
      </View> : <Text style={type.bodyMuted}>Only an authorized assigner can choose staff. Ask the owner or a selected department manager to assign the lead before staff can open it.</Text>}
      <ErrorNotice error={submission.error} />
      <Button label="Create lead" onPress={save} loading={submission.busy} disabled={!customer.name.trim() || !customer.phone?.trim() || !lead.site_location?.trim() || submission.busy} testID="kitchen-create-submit" />
      </> : null}
      <Button label="Cancel" variant="secondary" disabled={submission.busy} onPress={onClose} />
    </View>
  </View>;
}
