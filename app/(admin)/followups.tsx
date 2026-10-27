import { referrerLabel } from "@/src/utils/referrer";
// ═══════════════════════════════════════════════════════════════════════════
// Follow-ups · Sales Command Center — Design System V2.
// Superhuman Inbox × Linear. Every card is ranked by a deterministic AI
// Priority Score, carries an explainable Next Best Action, and the whole
// board is summarised by a personalised Today's Mission. Automated cards are
// produced by the backend's idempotent reconciliation engine — this screen
// only orchestrates reads + user actions, never invents data.
// ═══════════════════════════════════════════════════════════════════════════
import { filterValues, matchesFilter, toggleFilterValue } from "@/src/utils/filters";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Linking, Platform, Pressable, RefreshControl, ScrollView, SectionList, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";
import { Swipeable } from "@/src/components/Swipeable";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useBp } from "@/src/design/responsive";
import { Menu } from "@/src/design/navigationControls";
import { ActivityTimeline, TimelineEvent } from "@/src/components/ActivityTimeline";
import {
  Avatar, Badge, Button, Card, Chip, ConfirmDialog, Dropdown, EmptyState, FilterBar,
  FormField, HeroCard, HoverCard, IconButton, Panel, PageHeader, SearchField,
  SegmentedControl, Sheet, Skeleton, SkeletonList, StatTile, MobileFilterSection,
} from "@/src/components/ds";
import { toast } from "@/src/components/Toast";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { colors, elevation, moneyShort, radius, spacing, type } from "@/src/theme/tokens";
import { MANAGER_ROLES } from "./followup-assignments";
import { LeadScopeFields, type LeadPartner } from "@/src/components/leads/LeadScopeFields";
import { LeadScopeSheet } from "@/src/components/leads/LeadScopeSheet";
import { newLeadRequestKey, type LeadScope } from "@/src/api/leads";

type FeatherName = keyof typeof Feather.glyphMap;

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirror backend/models.py Followup + routes/followup_routes.py shapes)
// ─────────────────────────────────────────────────────────────────────────────
type Bucket = "overdue" | "today" | "tomorrow" | "this_week" | "later" | "snoozed" | "completed";
type PriorityLevel = "critical" | "high" | "medium" | "low";
type Channel = "call" | "whatsapp" | "email" | "visit";

type Followup = {
  id: string;
  floor_id?: string;
  interested_floor_ids?: string[];
  assignments?: LeadScope["assignments"];
  reference_source?: string | null;
  referrer_id?: string | null;
  referrer_name?: string | null;
  architect_interior_designer?: string | null;
  referrer_company?: string | null;
  referrer_customers_acquired?: number | null;
  referrer_type?: "architect" | "interior_designer" | null;
  rule_type: string;
  category: string;
  customer_id: string;
  customer_name: string;
  customer_phone?: string | null;
  customer_tier: "retail" | "trade" | "vip";
  quotation_id?: string | null;
  quotation_number?: string | null;
  purchase_id?: string | null;
  purchase_number?: string | null;
  project_name?: string | null;
  value: number;
  reason: string;
  reason_factors: string[];
  next_action: string;
  next_action_reason: string;
  suggested_channel: Channel;
  priority_score: number;
  priority_level: PriorityLevel;
  manual_priority_override?: PriorityLevel | null;
  effective_priority_level?: PriorityLevel;
  due_at: string;
  status: "open" | "snoozed" | "done" | "dismissed";
  snoozed_until?: string | null;
  is_automated: boolean;
  auto_resolved: boolean;
  resolution_note?: string | null;
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  last_contacted_at?: string | null;
  contact_attempts: number;
  tags: string[];
  completed_at?: string | null;
  completed_outcome?: string | null;
  notes?: string | null;
  origin?: string | null;
  walkin_id?: string | null;
  bucket: Bucket;
  created_at: string;
  updated_at: string;
};

type RuleInfo = { rule_type: string; label: string; category: string; description: string; active_count: number };

type Stats = {
  today_tasks: number; today_critical: number;
  overdue: number; overdue_critical: number;
  overdue_payments_count: number; overdue_payments_amount: number; overdue_payments_amount_short: string;
  expiring_quotations_count: number;
  tomorrow: number; this_week: number;
  waiting_for_customer: number;
  completed_today: number; completed_trend: number;
  snoozed: number; later: number;
  rules: RuleInfo[];
  workspace_counts: { selection: number; quotation_tiles: number; payment: number; walk_in: number };
};

type Mission = {
  due_count: number; revenue_at_risk: number; revenue_at_risk_short: string;
  overdue_payments: number; quotations_expiring_today: number; critical_count: number;
  estimated_minutes: number;
  top_priorities: { id: string; customer_name: string; reason: string; priority_score: number }[];
  greeting_name: string;
};

type Detail = {
  followup: Followup;
  customer: {
    id: string; name: string; company?: string | null; phone?: string | null;
    email?: string | null; city?: string | null; address?: string | null; tier: string;
  };
  stats: {
    lifetime_revenue: number; outstanding_total: number; pending_quotations: number; pending_orders: number;
    conversion_rate: number; average_order_value: number; preferred_salesperson?: string | null;
    risk_level: "low" | "medium" | "high";
  };
  quotations: { id: string; number: string; status: string; grand_total: number; valid_until?: string | null; updated_at: string }[];
  payments: { id: string; amount: number; mode: string; paid_at?: string | null }[];
  purchases: { id: string; number: string; status: string; grand_total: number; updated_at: string }[];
  timeline: TimelineEvent[];
};

type Assignee = { id: string; full_name: string; role: string };
type CustomerLite = { id: string; name: string; company?: string | null; phone?: string | null; tier: string };
type SavedView = { id: string; name: string; filters: Record<string, any> };
type BulkRequest = {
  label: string;
  successPatch: Partial<Followup>;
  execute: (id: string) => Promise<unknown>;
};
type BulkResult = {
  request: BulkRequest;
  successCount: number;
  failedIds: string[];
};
type FollowupPage = {
  items: Followup[];
  page: number;
  page_size: number;
  has_more: boolean;
};

type KpiFilter = Bucket | "waiting" | "expiring" | "all";
type FollowupView = "active" | "won" | "lost";
const FOLLOWUP_PAGE_SIZE = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Static meta
// ─────────────────────────────────────────────────────────────────────────────
const BUCKET_META: Record<Bucket, { label: string; icon: FeatherName }> = {
  overdue: { label: "Overdue", icon: "alert-circle" },
  today: { label: "Today", icon: "sun" },
  tomorrow: { label: "Tomorrow", icon: "sunrise" },
  this_week: { label: "This Week", icon: "calendar" },
  later: { label: "Later", icon: "clock" },
  snoozed: { label: "Snoozed", icon: "bell-off" },
  completed: { label: "Completed", icon: "check-circle" },
};
const SECTION_ORDER: Bucket[] = ["overdue", "today", "tomorrow", "this_week", "later", "snoozed", "completed"];

const PRIORITY_TONE: Record<PriorityLevel, { bg: string; fg: string; border: string }> = {
  critical: { bg: colors.errorBg, fg: colors.error, border: colors.errorBorder },
  high: { bg: colors.warningBg, fg: colors.warning, border: colors.warningBorder },
  // Deliberately NEUTRAL (not brand blue) — see UX audit: blue was overloaded
  // as brand + action + "medium priority" simultaneously, diluting meaning.
  medium: { bg: "#EEF0F3", fg: colors.onSurfaceSecondary, border: colors.borderStrong },
  low: { bg: colors.surfaceTertiary, fg: colors.onSurfaceMuted, border: colors.border },
};

const CATEGORY_ICON: Record<string, FeatherName> = {
  quotation: "file-text", general: "flag", sales: "trending-up", selection: "grid", walk_in: "user-plus",
};
const CHANNEL_ICON: Record<Channel, FeatherName> = {
  call: "phone", whatsapp: "message-circle", email: "mail", visit: "map-pin",
};
const CATEGORY_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "selection", label: "Tile Selection" },
  { value: "quotation", label: "Quotation" },
  { value: "general", label: "General" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Small formatters
// ─────────────────────────────────────────────────────────────────────────────
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dateShort(iso?: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch { return "—"; }
}
function timeAgo(iso?: string | null): string {
  if (!iso) return "Never contacted";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "Never contacted";
  const diffMin = Math.floor((Date.now() - d) / 60000);
  if (diffMin < 1) return "Contacted just now";
  if (diffMin < 60) return `Contacted ${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `Contacted ${h}h ago`;
  return `Contacted ${Math.floor(h / 24)}d ago`;
}
function dueLabel(f: Followup): string {
  if (f.status === "done") return f.completed_at ? `Completed ${dateShort(f.completed_at)}` : "Completed";
  if (f.status === "dismissed") return "Dismissed";
  if (f.status === "snoozed" && f.snoozed_until) {
    const d = new Date(f.snoozed_until);
    return `Snoozed till ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
  }
  const d = new Date(f.due_at);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.round((startOfDay(d).getTime() - startOfDay(new Date()).getTime()) / 86400000);
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (days < 0) return `Overdue ${Math.abs(days)}d`;
  if (days === 0) return `Today · ${time}`;
  if (days === 1) return `Tomorrow · ${time}`;
  if (days <= 7) return `${d.toLocaleDateString("en-IN", { weekday: "short" })} · ${time}`;
  return dateShort(f.due_at);
}
function isSameDay(aIso: string, b: Date): boolean {
  const a = new Date(aIso);
  const day = (date: Date) => new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return Number.isFinite(a.getTime()) && day(a) === day(b);
}
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
function isWonOrderFollowup(f: Followup): boolean {
  // "converted" is retained here only so records written during the rollout
  // stay out of the active queue; all new order placements are marked won.
  return f.auto_resolved && (f.completed_outcome === "won" || f.completed_outcome === "converted");
}

/**
 * Older API deployments do not expose the bounded `/followups/page` route.
 * FastAPI then resolves `page` as a follow-up id and responds with this exact
 * detail 404. It is a recoverable capability mismatch, not an empty inbox.
 */
function isMissingPagedInbox(error: any): boolean {
  return error?.status === 404 && /follow-?up not found/i.test(String(error?.detail || error?.message || ""));
}

/** Keep bulk mutations bounded so a large selection cannot stampede the API. */
async function settleBulkRequests(request: BulkRequest, ids: string[]): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  const concurrency = 5;
  for (let start = 0; start < ids.length; start += concurrency) {
    results.push(...await Promise.allSettled(ids.slice(start, start + concurrency).map(request.execute)));
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Screen
// ═══════════════════════════════════════════════════════════════════════════
export default function FollowupsScreen() {
  const { selectedFloorId } = useFloorAccess();
  // Switching workspaces discards the entire previous inbox, including sheets,
  // search, saved views and pending actions, before the new floor can render.
  return <FollowupsWorkspace key={selectedFloorId} />;
}

function FollowupsWorkspace() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const routeParams = useLocalSearchParams<{ workspace?: string; showroom_followup?: string }>();
  const { staff } = useAuth();
  const canDeleteFollowups = useActionAccess("followups", "delete", !!staff && MANAGER_ROLES.includes(staff.role));
  const { selectedFloorId, floors } = useFloorAccess();
  const router = useRouter();
  const { isPhone, isDesktop } = useBp();
  const insets = useSafeAreaInsets();
  const pagePad = isPhone ? spacing.md : spacing.xl;
  const isSanitary = ["first-floor", "ground-floor"].includes(selectedFloorId || "");

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [rawItems, setRawItems] = useState<Followup[]>([]);
  const [listPage, setListPage] = useState(1);
  const [hasMorePages, setHasMorePages] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [mission, setMission] = useState<Mission | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [customers, setCustomers] = useState<CustomerLite[]>([]);

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [q, setQ] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const [kpiFilter, setKpiFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const tierFilter = "all";
  const [ownerFilter, setOwnerFilter] = useState<"all" | "mine" | string>("all");
  const [followupView, setFollowupView] = useState<FollowupView>("active");
  useEffect(() => {
    if (!isSanitary) return;
    setKpiFilter("all"); setPriorityFilter("all"); setCategoryFilter("all"); setSummaryOpen(false);
  }, [isSanitary, selectedFloorId]);

  const [collapsed, setCollapsed] = useState<Set<Bucket>>(new Set(["completed", "snoozed"]));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bulkDockHeight, setBulkDockHeight] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const lastListLoadFailed = useRef(false);
  const listRequestVersion = useRef(0);
  const loadingPageRef = useRef(false);
  const bootstrappedFloorRef = useRef<string | null>(null);
  const detailRequestVersion = useRef(0);
  const detailAbortController = useRef<AbortController | null>(null);
  // Customer context is intentionally transient. Keeping it in a preview
  // sheet preserves the original, single-workspace follow-ups experience on
  // desktop as well as phone instead of reserving a permanent detail column.
  const [customerPreviewOpen, setCustomerPreviewOpen] = useState(false);

  const [rulesSheet, setRulesSheet] = useState(false);
  const [newSheet, setNewSheet] = useState(false);
  const [scopeLead, setScopeLead] = useState<Followup | null>(null);
  const [scopeLeadIds, setScopeLeadIds] = useState<string[]>([]);
  const [callOutcomeFor, setCallOutcomeFor] = useState<Followup | null>(null);
  const [lossActionFor, setLossActionFor] = useState<Followup | null>(null);
  const [customSnoozeFor, setCustomSnoozeFor] = useState<Followup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Followup | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const bulkBusy = useRef(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewsSheet, setSavedViewsSheet] = useState(false);
  const [shortcutHelp, setShortcutHelp] = useState(false);
  // Follow-ups 2.0 — dedicated workspaces (Tile Selections / Tile Quotations)
  // living inside the same premium inbox rather than separate screens, per
  // design decision to reuse existing components and avoid a new visual
  // style. Walk-ins / Payments workspaces land in a later phase.
  type Workspace = "all" | "selection" | "quotation_tiles" | "visit_showroom";
  const hasTileFollowupWorkspaces = selectedFloorId === "ground-floor";
  const requestedWorkspace = routeParams.workspace;
  const workspace: Workspace = requestedWorkspace === "visit_showroom" ? "visit_showroom"
    : hasTileFollowupWorkspaces && (requestedWorkspace === "selection" || requestedWorkspace === "quotation_tiles") ? requestedWorkspace : "all";
  const setWorkspace = (value: Workspace) => router.setParams({ workspace: value, showroom_followup: "" });

  // A transfer is an explicit request to see the new active showroom entry.
  // A previously mounted inbox may still carry Won, search or owner filters.
  useEffect(() => {
    if (!routeParams.showroom_followup) return;
    setQ(""); setSearchQuery(""); setFollowupView("active");
    setKpiFilter("all"); setPriorityFilter("all"); setCategoryFilter("all"); setOwnerFilter("all");
    detailRequestVersion.current += 1; detailAbortController.current?.abort();
    setSelectedId(null); setDetail(null); setLoadingDetail(false); setCustomerPreviewOpen(false);
    setSelectedIds(new Set()); setBulkResult(null); setCollapsed(new Set());
  }, [routeParams.showroom_followup]);

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadList = useCallback(async (nextPage = 1, pageNavigation = false) => {
    // The app shell normally waits for this, but retain the guard here for a
    // direct route/remount. A request with no floor header can be rejected or
    // return a different workspace, neither of which is an inbox failure.
    if (!selectedFloorId || !mounted.current) return [];
    if (pageNavigation && loadingPageRef.current) return [];
    if (pageNavigation) {
      loadingPageRef.current = true;
      setLoadingPage(true);
    }
    else {
      loadingPageRef.current = false;
      setLoading(true);
      setListError(null);
    }
    const requestVersion = ++listRequestVersion.current;
    try {
      const params = new URLSearchParams({ page: String(nextPage), page_size: String(FOLLOWUP_PAGE_SIZE), view: followupView });
      if (searchQuery) params.set("q", searchQuery);
      if (priorityFilter !== "all") params.set("priority", priorityFilter);
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (tierFilter !== "all") params.set("customer_tier", tierFilter);
      if (ownerFilter !== "all") params.set("assigned_to", filterValues(ownerFilter).map(owner => owner === "mine" ? staff?.id || "" : owner).filter(Boolean).join(","));
      if (followupView === "won" && ownerFilter === "all" && staff?.id) params.set("assigned_to", staff.id);
      if (workspace === "visit_showroom") params.set("origin", "visit_showroom");
      if (workspace === "selection") params.set("rule_type", "selection_waiting");
      else if (workspace === "quotation_tiles") params.set("rule_type", "quotation_tiles_waiting");
      if (kpiFilter === "expiring") {
        params.set("rule_type", "quotation_expiring");
        params.set("bucket", "expiring");
      } else if (kpiFilter !== "all") params.set("bucket", filterValues(kpiFilter).map(choice => choice === "completed" ? "completed_today" : choice).join(","));

      let result: FollowupPage;
      try {
        result = await api.get<FollowupPage>(`/followups/page?${params.toString()}`, { floorId: selectedFloorId });
      } catch (error: any) {
        // A rolling frontend/backend deploy must not strand an otherwise
        // usable queue. The established array endpoint retains the same core
        // filter contract, while the client continues to apply every visible
        // filter below. It intentionally has no cursor/page contract, so only
        // recover the first page and suppress unavailable pagination.
        if (!pageNavigation && nextPage === 1 && isMissingPagedInbox(error)) {
          const legacyParams = new URLSearchParams({ limit: String(FOLLOWUP_PAGE_SIZE) });
          if (followupView === "won" && ownerFilter === "all" && staff?.id) legacyParams.set("assigned_to", staff.id);
          if (workspace === "visit_showroom") legacyParams.set("origin", "visit_showroom");
          if (searchQuery) legacyParams.set("q", searchQuery);
          if (priorityFilter !== "all") legacyParams.set("priority", priorityFilter);
          if (categoryFilter !== "all") legacyParams.set("category", categoryFilter);
          if (tierFilter !== "all") legacyParams.set("customer_tier", tierFilter);
          if (ownerFilter !== "all") legacyParams.set("assigned_to", filterValues(ownerFilter).map(owner => owner === "mine" ? staff?.id || "" : owner).filter(Boolean).join(","));
          if (kpiFilter === "expiring") legacyParams.set("bucket", "expiring");
          else if (kpiFilter !== "all") legacyParams.set("bucket", filterValues(kpiFilter).map(choice => choice === "completed" ? "completed_today" : choice).join(","));
          const items = await api.get<Followup[]>(`/followups?${legacyParams.toString()}`, { floorId: selectedFloorId });
          result = { items, page: 1, page_size: FOLLOWUP_PAGE_SIZE, has_more: false };
        } else {
          throw error;
        }
      }
      if (!mounted.current || requestVersion !== listRequestVersion.current) return [];
      lastListLoadFailed.current = false;
      setRawItems(result.items);
      setListPage(result.page);
      setHasMorePages(result.has_more);
      setListError(null);
      return result.items;
    } catch (e: any) {
      if (!mounted.current || requestVersion !== listRequestVersion.current) return [];
      const message = e?.detail || "Could not load follow-ups";
      lastListLoadFailed.current = true;
      if (!pageNavigation) setListError(message);
      toast.error(message);
      return [];
    } finally {
      if (mounted.current && requestVersion === listRequestVersion.current) {
        loadingPageRef.current = false;
        setLoadingPage(false);
        if (!pageNavigation) setLoading(false);
      }
    }
  }, [categoryFilter, followupView, kpiFilter, ownerFilter, priorityFilter, searchQuery, selectedFloorId, staff?.id, tierFilter, workspace]);

  const refreshStatsQuiet = useCallback(async () => {
    if (!selectedFloorId || !mounted.current || isSanitary) return;
    try {
      const [s, m] = await Promise.all([
        api.get<Stats>("/followups/stats", { floorId: selectedFloorId }),
        api.get<Mission>("/followups/mission", { floorId: selectedFloorId }),
      ]);
      if (mounted.current) { setStats(s); setMission(m); }
    } catch { /* best-effort */ }
  }, [selectedFloorId, isSanitary]);

  const bootstrap = useCallback(async () => {
    if (!selectedFloorId || !mounted.current) return [];
    const floorId = selectedFloorId;
    // Keep entering the work queue cheap. The previous dashboard eagerly ran
    // three full-dataset summary queries alongside the inbox query; on a busy
    // floor those competing reads were the source of the client timeout. The
    // optional summary is loaded only when an operator explicitly opens it.
    void Promise.allSettled([
      api.get<Assignee[]>("/followups/config/assignees", { floorId: selectedFloorId }),
      api.get<CustomerLite[]>("/followups/config/customers", { floorId: selectedFloorId }),
      api.get<SavedView[]>("/followups/saved-views", { floorId: selectedFloorId }),
    ]).then(([assigneesResult, customersResult, savedViewsResult]) => {
      // A new floor request may already be in flight. Never let a late,
      // otherwise successful summary response repaint the newer workspace.
      if (!mounted.current || bootstrappedFloorRef.current !== floorId) return;
      if (assigneesResult.status === "fulfilled") setAssignees(assigneesResult.value);
      if (customersResult.status === "fulfilled") setCustomers(customersResult.value);
      if (savedViewsResult.status === "fulfilled") setSavedViews(savedViewsResult.value);
    });
    return loadList();
  }, [loadList, selectedFloorId]);

  useEffect(() => {
    if (!selectedFloorId || bootstrappedFloorRef.current === selectedFloorId) return;
    bootstrappedFloorRef.current = selectedFloorId;
    setStats(null);
    setMission(null);
    didApplyListFilters.current = false;
    // A floor is a hard data boundary: any selected card, detail request, or
    // bulk selection from the prior floor would otherwise make a valid 404
    // look like a broken follow-up.
    detailRequestVersion.current += 1;
    detailAbortController.current?.abort();
    setSelectedId(null);
    setDetail(null);
    setLoadingDetail(false);
    setCustomerPreviewOpen(false);
    setSelectedIds(new Set());
    setBulkResult(null);
    (async () => {
      setLoading(true);
      await bootstrap();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFloorId]);

  const latestLoadList = useRef(loadList);
  const didApplyListFilters = useRef(false);
  useEffect(() => { latestLoadList.current = loadList; }, [loadList]);
  useEffect(() => {
    if (!selectedFloorId || !mounted.current) return;
    if (!didApplyListFilters.current) {
      didApplyListFilters.current = true;
      return;
    }
    void loadList();
  }, [loadList, selectedFloorId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await bootstrap();
    setRefreshing(false);
    if (!lastListLoadFailed.current) toast.success("Workspace synced");
  }, [bootstrap]);

  // An order can be placed from the quotation screen while this route remains
  // mounted in the navigator. Refresh on return so its follow-ups move to the
  // Won orders view without relying on a manual page reload.
  useFocusEffect(useCallback(() => {
    void latestLoadList.current();
    if (summaryOpen) void refreshStatsQuiet();
  }, [refreshStatsQuiet, summaryOpen]));

  useEffect(() => () => detailAbortController.current?.abort(), []);

  const loadDetail = useCallback(async (id: string) => {
    const version = ++detailRequestVersion.current;
    detailAbortController.current?.abort();
    const controller = new AbortController();
    detailAbortController.current = controller;
    setLoadingDetail(true);
    try {
      const loadedDetail = await api.get<Detail>(`/followups/${id}`, { signal: controller.signal, floorId: selectedFloorId });
      if (mounted.current && version === detailRequestVersion.current) setDetail(loadedDetail);
    } catch (e: any) {
      if (!mounted.current || version !== detailRequestVersion.current || e?.name === "AbortError") return;
      if (e?.status === 404) {
        // The card was completed, moved, or removed in another session. Put
        // the queue back in control instead of displaying a stale "not found"
        // detail panel.
        setSelectedId(null);
        setDetail(null);
        setCustomerPreviewOpen(false);
        void latestLoadList.current();
        toast.error("That follow-up changed elsewhere. The queue has been refreshed.");
        return;
      }
      toast.error(e?.detail || "Could not load details");
      setDetail(null);
    } finally {
      if (mounted.current && version === detailRequestVersion.current) setLoadingDetail(false);
    }
  }, [selectedFloorId]);

  const selectCard = useCallback((f: Followup) => {
    setSelectedId(f.id);
    loadDetail(f.id);
    setCustomerPreviewOpen(true);
  }, [loadDetail]);

  const clearSelectedDetail = useCallback(() => {
    detailRequestVersion.current += 1;
    detailAbortController.current?.abort();
    setSelectedId(null);
    setDetail(null);
    setLoadingDetail(false);
  }, []);

  // Keep the queue and the open customer detail in sync after saved changes.
  const patchLocal = useCallback((id: string, patch: Partial<Followup>) => {
    setRawItems((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    setDetail((prev) => prev?.followup.id === id ? { ...prev, followup: { ...prev.followup, ...patch } } : prev);
  }, []);

  const runAction = useCallback((action: () => Promise<void>) => {
    if (!mounted.current) return;
    void action().catch((error: any) => { if (mounted.current) toast.error(error?.detail || "Could not update follow-up"); });
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────
  const contact = useCallback((f: Followup, channel: Channel) => {
    runAction(async () => {
      const res = await api.post<{ channel: string; phone?: string | null; wa_url?: string; email?: string | null }>(
        `/followups/${f.id}/contact`, { channel }, { floorId: selectedFloorId },
      );
      if (!mounted.current) return;
      if (channel === "call") {
        if (!res.phone) { toast.error("No phone number on file"); return; }
        await Linking.openURL(`tel:${res.phone}`).catch(() => toast.error("Open the phone app manually."));
        setCallOutcomeFor(f);
      } else if (channel === "whatsapp") {
        if (!res.wa_url) { toast.error("Could not build WhatsApp message"); return; }
        await Linking.openURL(res.wa_url).catch(() => toast.error("Open WhatsApp manually."));
        toast.success("WhatsApp opened");
      } else if (channel === "email") {
        if (!res.email) { toast.error("No email on file for this customer"); return; }
        await Linking.openURL(`mailto:${res.email}?subject=${encodeURIComponent(f.quotation_number || f.project_name || "Following up")}`).catch(() => toast.error("Open the email app manually."));
      }
      patchLocal(f.id, { last_contacted_at: new Date().toISOString() });
    });
  }, [patchLocal, runAction, selectedFloorId]);

  const completeFollowup = useCallback((f: Followup) => {
    runAction(async () => {
      const updated = await api.post<Followup>(`/followups/${f.id}/complete`, {}, { floorId: selectedFloorId });
      if (!mounted.current) return;
      patchLocal(f.id, { ...updated, bucket: "completed" });
      toast.success("Marked complete");
      void refreshStatsQuiet();
    });
  }, [patchLocal, refreshStatsQuiet, runAction, selectedFloorId]);

  const snoozeFollowup = useCallback((f: Followup, preset: "15m" | "1h" | "tomorrow" | "next_week") => {
    runAction(async () => {
      const updated = await api.post<Followup>(`/followups/${f.id}/snooze`, { preset }, { floorId: selectedFloorId });
      if (!mounted.current) return;
      patchLocal(f.id, { ...updated, bucket: "snoozed" });
      toast.success("Snoozed");
      void refreshStatsQuiet();
    });
  }, [patchLocal, refreshStatsQuiet, runAction, selectedFloorId]);

  const customSnooze = useCallback((f: Followup, untilIso: string) => {
    setCustomSnoozeFor(null);
    runAction(async () => {
      const updated = await api.post<Followup>(`/followups/${f.id}/snooze`, { until: untilIso }, { floorId: selectedFloorId });
      if (!mounted.current) return;
      patchLocal(f.id, { ...updated, bucket: "snoozed" });
      toast.success("Snoozed");
      void refreshStatsQuiet();
    });
  }, [patchLocal, refreshStatsQuiet, runAction, selectedFloorId]);

  const pushDue = useCallback((f: Followup, days: number) => {
    const dueDate = new Date(Date.now() + days * 86400000);
    const dueIso = dueDate.toISOString();
    const newBucket: Bucket = days === 1 ? "tomorrow" : days <= 7 ? "this_week" : "later";
    runAction(async () => {
      const updated = await api.patch<Followup>(`/followups/${f.id}`, { due_at: dueIso }, { floorId: selectedFloorId });
      if (!mounted.current) return;
      patchLocal(f.id, { ...updated, bucket: newBucket });
      toast.success(`Pushed ${days} day${days === 1 ? "" : "s"}`);
      void refreshStatsQuiet();
    });
  }, [patchLocal, refreshStatsQuiet, runAction, selectedFloorId]);

  const assignFollowup = useCallback((f: Followup, _userId?: string) => { setScopeLeadIds([]); setScopeLead(f); }, []);

  const dismissFollowup = useCallback((f: Followup) => {
    runAction(async () => {
      const updated = await api.patch<Followup>(`/followups/${f.id}`, { status: "dismissed" }, { floorId: selectedFloorId });
      if (!mounted.current) return;
      patchLocal(f.id, { ...updated, bucket: "completed" });
      toast.success("Dismissed");
      void refreshStatsQuiet();
    });
  }, [patchLocal, refreshStatsQuiet, runAction, selectedFloorId]);

  const deleteFollowup = useCallback(() => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    runAction(async () => {
      setDeleting(true);
      try {
        await api.delete(`/followups/${target.id}`, { floorId: selectedFloorId });
        if (!mounted.current) return;
        setRawItems((prev) => prev.filter((item) => item.id !== target.id));
        if (selectedId === target.id) clearSelectedDetail();
        toast.success("Follow-up deleted");
        void refreshStatsQuiet();
      } finally { setDeleting(false); }
    });
  }, [clearSelectedDetail, deleteTarget, refreshStatsQuiet, selectedId, runAction, selectedFloorId]);

  const logCallOutcome = useCallback(async (f: Followup, outcome: string, notes?: string, nextFollowupAt?: string, response?: string, interestedFloorIds?: string[], assignments?: LeadScope["assignments"]) => {
    if ((outcome === "lost" || outcome === "rejected") && !notes?.trim()) { toast.error("A lost reason is required"); return; }
    try {
      await api.post(`/followups/${f.id}/log-call`, {
        outcome,
        notes: outcome === "lost" || outcome === "rejected" ? notes : undefined,
        next_followup_at: nextFollowupAt || undefined,
        response: response?.trim() || undefined,
        interested_floor_ids: interestedFloorIds,
        assignments,
      }, { floorId: selectedFloorId });
      if (!mounted.current) return;
      toast.success("Call logged");
      setCallOutcomeFor(null);
      setLossActionFor(null);
      await loadList();
      refreshStatsQuiet();
    } catch (e: any) { toast.error(e?.detail || "Could not log call"); }
  }, [loadList, refreshStatsQuiet, selectedFloorId]);

  const createFollowup = useCallback(async (payload: any) => {
    try {
      await api.post("/followups", payload, { floorId: selectedFloorId });
      if (!mounted.current) return;
      toast.success("Follow-up created");
      setNewSheet(false);
      await loadList();
      refreshStatsQuiet();
    } catch (e: any) { toast.error(e?.detail || "Could not create follow-up"); throw e; }
  }, [loadList, refreshStatsQuiet, selectedFloorId]);

  // ── Filtering (100% client-side ⇒ instant) ──────────────────────────────
  const filtered = useMemo(() => {
    let list = rawItems;
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter((f) => (
        f.customer_name?.toLowerCase().includes(term)
        || f.customer_phone?.toLowerCase().includes(term)
        || f.quotation_number?.toLowerCase().includes(term)
        || f.purchase_number?.toLowerCase().includes(term)
        || f.project_name?.toLowerCase().includes(term)
        || f.reason?.toLowerCase().includes(term)
        || f.tags?.some((t) => t.toLowerCase().includes(term))
      ));
    }
    if (kpiFilter !== "all") {
      const selectedBuckets = filterValues(kpiFilter);
      list = list.filter(f => selectedBuckets.some(choice =>
        choice === "expiring" ? f.status === "open" && f.rule_type === "quotation_expiring"
        : choice === "waiting" ? f.status === "open" && f.rule_type === "payment_partial"
        : choice === "completed" ? f.bucket === "completed" && !!f.completed_at && isSameDay(f.completed_at, new Date())
        : f.bucket === choice));
    }
    if (followupView === "won") list = list.filter((f) => isWonOrderFollowup(f) && (ownerFilter !== "all" || f.assigned_to === staff?.id));
    else if (followupView === "lost") list = list.filter((f) => f.completed_outcome === "lost");
    else list = list.filter((f) => !isWonOrderFollowup(f) && f.completed_outcome !== "lost");
    if (priorityFilter !== "all") list = list.filter((f) => matchesFilter(f.manual_priority_override || f.priority_level, priorityFilter));
    if (categoryFilter !== "all") list = list.filter((f) => matchesFilter(f.category, categoryFilter));
    if (workspace === "selection") list = list.filter((f) => f.rule_type === "selection_waiting");
    else if (workspace === "quotation_tiles") list = list.filter((f) => f.rule_type === "quotation_tiles_waiting");
    if (tierFilter !== "all") list = list.filter((f) => matchesFilter(f.customer_tier, tierFilter));
    if (ownerFilter !== "all") {
      const owners = filterValues(ownerFilter).map(owner => owner === "mine" ? staff?.id : owner);
      list = list.filter(f => owners.includes(f.assigned_to || undefined));
    }
    if (workspace === "visit_showroom") list = list.filter(f => f.origin === "visit_showroom");
    return [...list].sort((a, b) => {
      const mineA = a.assigned_to === staff?.id ? 0 : 1;
      const mineB = b.assigned_to === staff?.id ? 0 : 1;
      if (mineA !== mineB) return mineA - mineB;
      return (b.priority_score - a.priority_score) || (a.due_at || "").localeCompare(b.due_at || "");
    });
  }, [rawItems, q, kpiFilter, followupView, priorityFilter, categoryFilter, workspace, tierFilter, ownerFilter, staff]);

  const sections = useMemo(() => {
    const map: Record<string, Followup[]> = {};
    for (const f of filtered) (map[f.bucket] ||= []).push(f);
    return SECTION_ORDER.filter((b) => map[b]?.length).map((b) => ({ bucket: b, data: map[b] }));
  }, [filtered]);
  const visibleSections = useMemo(
    () => sections.map((section) => ({ ...section, itemCount: section.data.length, data: followupView === "active" && collapsed.has(section.bucket) ? [] : section.data })),
    [collapsed, followupView, sections],
  );

  const priorityCounts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of rawItems) if (f.status === "open" || f.status === "snoozed") {
      const lvl = f.manual_priority_override || f.priority_level;
      c[lvl] = (c[lvl] || 0) + 1;
    }
    return c;
  }, [rawItems]);

  const outcomeCounts = useMemo(() => ({
    won: rawItems.filter(isWonOrderFollowup).length,
    lost: rawItems.filter((f) => f.completed_outcome === "lost").length,
  }), [rawItems]);

  const topPriorityOpen = useMemo(
    () => [...rawItems].filter((f) => f.bucket === "overdue" || f.bucket === "today")
      .sort((a, b) => b.priority_score - a.priority_score)[0] || null,
    [rawItems],
  );

  // Rank badge (repeats the Mission's "#1/#2/#3" framing inside the main
  // list itself — closes the "who do I call first" 5-second-scan gap).
  const rankMap = useMemo(() => {
    const top3 = [...rawItems]
      .filter((f) => f.status === "open" && (f.bucket === "overdue" || f.bucket === "today"))
      .sort((a, b) => b.priority_score - a.priority_score)
      .slice(0, 3);
    const m = new Map<string, number>();
    top3.forEach((f, i) => m.set(f.id, i + 1));
    return m;
  }, [rawItems]);

  const toggleKpi = (v: KpiFilter) => setKpiFilter(cur => cur === "expiring" ? v : toggleFilterValue(cur, v));
  const openSummary = (value: KpiFilter) => {
    setQ("");
    setSearchQuery("");
    setKpiFilter(value);
    setFollowupView("active");
    setWorkspace("all");
    setPriorityFilter("all");
    setCategoryFilter("all");
    setOwnerFilter("all");
    setCollapsed(new Set());
    if (isPhone) setSummaryOpen(false);
  };
  const toggleSection = (b: Bucket) => setCollapsed((prev) => {
    const n = new Set(prev);
    if (n.has(b)) n.delete(b); else n.add(b);
    return n;
  });
  const openRelatedDocument = useCallback((f: Followup) => {
    router.push(`/(admin)/tiles/${f.rule_type === "selection_waiting" ? "selection" : "quotation"}?id=${f.quotation_id}` as any);
  }, [router]);

  const activeFilterCount = [followupView !== "active", priorityFilter !== "all", categoryFilter !== "all", tierFilter !== "all", ownerFilter !== "all"].filter(Boolean).length;

  // ── Bulk selection ───────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const runBulk = useCallback(async (request: BulkRequest, ids = Array.from(selectedIds)) => {
    if (!ids.length || bulkBusy.current) return;
    bulkBusy.current = true;
    setBulkSaving(true);
    setBulkResult(null);
    const results = await settleBulkRequests(request, ids);
    if (!mounted.current) return;
    bulkBusy.current = false;
    setBulkSaving(false);
    const succeeded = new Set(ids.filter((_, index) => results[index]?.status === "fulfilled"));
    const failedIds = ids.filter((_, index) => results[index]?.status === "rejected");
    if (succeeded.size) {
      setRawItems((prev) => prev.map((f) => succeeded.has(f.id) ? { ...f, ...request.successPatch } : f));
      setDetail((prev) => prev && succeeded.has(prev.followup.id) ? { ...prev, followup: { ...prev.followup, ...request.successPatch } } : prev);
      void refreshStatsQuiet();
      toast.success(`${request.label} ${succeeded.size} follow-up${succeeded.size === 1 ? "" : "s"}`);
    }
    setSelectedIds(new Set(failedIds));
    if (failedIds.length) {
      setBulkResult({ request, successCount: succeeded.size, failedIds });
      toast.error(`${failedIds.length} follow-up${failedIds.length === 1 ? "" : "s"} could not be updated. They remain selected.`);
    }
  }, [refreshStatsQuiet, selectedIds]);

  const bulkSnooze = useCallback((preset: "1h" | "tomorrow" | "next_week") => {
    const ids = Array.from(selectedIds);
    runAction(async () => {
      await runBulk({ label: "Snoozed", successPatch: { status: "snoozed", bucket: "snoozed" }, execute: (id) => mounted.current ? api.post(`/followups/${id}/snooze`, { preset }, { floorId: selectedFloorId }) : Promise.reject(new Error("Workspace changed")) }, ids);
    });
  }, [runBulk, selectedIds, runAction, selectedFloorId]);

  const bulkComplete = useCallback(() => {
    const ids = Array.from(selectedIds);
    runAction(async () => {
      await runBulk({ label: "Completed", successPatch: { status: "done", bucket: "completed", completed_at: new Date().toISOString() }, execute: (id) => mounted.current ? api.post(`/followups/${id}/complete`, {}, { floorId: selectedFloorId }) : Promise.reject(new Error("Workspace changed")) }, ids);
    });
  }, [runBulk, selectedIds, runAction, selectedFloorId]);

  const bulkAssign = useCallback((_userId: string) => {
    const ids = Array.from(selectedIds);
    const first = rawItems.find(item => ids.includes(item.id));
    if (first) { setScopeLeadIds(ids); setScopeLead({ ...first, assignments: [] }); }
  }, [rawItems, selectedIds]);

  const retryFailedBulk = useCallback(() => {
    if (!bulkResult) return;
    void runBulk(bulkResult.request, bulkResult.failedIds);
  }, [bulkResult, runBulk]);

  // ── Saved Views ──────────────────────────────────────────────────────────
  const applySavedView = useCallback((v: SavedView) => {
    const flt = v.filters || {};
    setQ(flt.q || "");
    setKpiFilter(isSanitary ? "all" : flt.kpiFilter || "all");
    setFollowupView(flt.followupView || "active");
    setPriorityFilter(isSanitary ? "all" : flt.priorityFilter || "all");
    setCategoryFilter(isSanitary ? "all" : filterValues(flt.categoryFilter || "all").filter(value => value !== "sales").join(",") || "all");
    setOwnerFilter(filterValues(flt.ownerFilter || "all")
      .filter(value => !(isSanitary && staff?.role === "owner" && (value === "mine" || value === staff.id)))
      .join(",") || "all");
    setSavedViewsSheet(false);
    toast.success(`Applied "${v.name}"`);
  }, [isSanitary, staff?.role, staff?.id]);

  const saveCurrentView = useCallback(async (name: string) => {
    const filters = { q, kpiFilter, followupView, priorityFilter, categoryFilter, tierFilter, ownerFilter };
    try {
      const v = await api.post<SavedView>("/followups/saved-views", { name, filters }, { floorId: selectedFloorId });
      if (!mounted.current) return;
      setSavedViews((prev) => [v, ...prev]);
      toast.success("View saved");
    } catch (e: any) { toast.error(e?.detail || "Could not save view"); }
  }, [q, kpiFilter, followupView, priorityFilter, categoryFilter, tierFilter, ownerFilter, selectedFloorId]);

  const deleteSavedView = useCallback(async (id: string) => {
    if (!mounted.current) return;
    setSavedViews((prev) => prev.filter((v) => v.id !== id));
    try { await api.delete(`/followups/saved-views/${id}`, { floorId: selectedFloorId }); } catch { /* best-effort */ }
  }, [selectedFloorId]);

  // ── Export ───────────────────────────────────────────────────────────────
  const doExport = useCallback(async (format: "xlsx" | "csv") => {
    const qs = new URLSearchParams({ format });
    if (kpiFilter !== "all") qs.set("bucket", filterValues(kpiFilter).map(choice => choice === "completed" ? "completed_today" : choice).join(","));
    if (priorityFilter !== "all") qs.set("priority", priorityFilter);
    if (categoryFilter !== "all") qs.set("category", categoryFilter);
    if (tierFilter !== "all") qs.set("customer_tier", tierFilter);
    if (ownerFilter !== "all") qs.set("assigned_to", filterValues(ownerFilter).map(owner => owner === "mine" ? staff?.id || "" : owner).filter(Boolean).join(","));
    if (workspace === "visit_showroom") qs.set("origin", "visit_showroom");
    if (q.trim()) qs.set("q", q.trim());
    try {
      const url = await api.authenticatedUrl(`/followups/export?${qs.toString()}`, selectedFloorId);
      if (!mounted.current) return;
      if (Platform.OS === "web") {
        // @ts-ignore — web only
        window.open(url, "_blank");
      } else {
        await Linking.openURL(url);
      }
      toast.success("Export ready");
    } catch { toast.error("Could not export"); }
  }, [kpiFilter, priorityFilter, categoryFilter, tierFilter, ownerFilter, q, staff, workspace, selectedFloorId]);

  // ── Keyboard shortcuts (web only) ───────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const selected = rawItems.find((f) => f.id === selectedId) || null;
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (target?.closest('button, a, [role="button"], [role="tab"], [role="checkbox"], [role="dialog"]')) return;
      switch (e.key) {
        case "c": case "C": if (selected) contact(selected, "call"); break;
        case "w": case "W": if (selected) contact(selected, "whatsapp"); break;
        case "e": case "E": if (selected) contact(selected, "email"); break;
        case " ": if (selected) { e.preventDefault(); completeFollowup(selected); } break;
        case "s": case "S": if (selected) setCustomSnoozeFor(null); if (selected) snoozeFollowup(selected, "1h"); break;
        case "/": {
          e.preventDefault();
          // @ts-ignore — RN Web maps testID → data-testid on the underlying <input>
          const el = document.querySelector('[data-testid="followups-search"]') as HTMLInputElement | null;
          el?.focus();
          break;
        }
        case "?": setShortcutHelp((v) => !v); break;
        case "Escape":
          clearSelectedDetail(); setCustomerPreviewOpen(false);
          setCallOutcomeFor(null); setCustomSnoozeFor(null);
          break;
        default: break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rawItems, selectedId, contact, completeFollowup, snoozeFollowup, clearSelectedDetail]);

  const activeTileStyle = { borderColor: colors.brand, backgroundColor: colors.brandTint };
  const toggleSummary = useCallback(() => {
    setSummaryOpen((open) => {
      const next = !open;
      if (next) void refreshStatsQuiet();
      return next;
    });
  }, [refreshStatsQuiet]);
  const followupViewControl = (
    <SegmentedControl
      value={followupView}
      onChange={setFollowupView as any}
      fullWidth
      testID="followups-outcome-tabs"
      options={[
        { value: "active", label: "Follow-ups", icon: "inbox" },
        { value: "won", label: `Won orders${outcomeCounts.won ? ` · ${outcomeCounts.won}` : ""}`, icon: "shopping-bag" },
        { value: "lost", label: `Loss${outcomeCounts.lost ? ` · ${outcomeCounts.lost}` : ""}`, icon: "user-x" },
      ]}
    />
  );
  const workspaceAndFilters = (
    <>
      {isPhone ? <PageHeader
        overline="WORKSPACE"
        title="Follow-ups"
        subtitle="Calls, reminders and customer promises. One clear next step."
        dense
        embedded
        actions={<View style={{ flexDirection: "row", gap: spacing.sm }}>
          <IconButton icon="rotate-cw" onPress={onRefresh} tone="surface" accessibilityLabel="Refresh" size={40} />
          {staff?.role === "owner" ? <IconButton icon="users" onPress={() => router.push("/(admin)/team-assign" as never)} tone="surface" accessibilityLabel="Team assign" size={40} /> : null}
          <IconButton icon="plus" onPress={() => setNewSheet(true)} tone="brand" accessibilityLabel="New follow-up" size={40} testID="new-followup-btn" />
        </View>}
      /> : null}
      {followupViewControl}
      {(

        <SegmentedControl
          value={workspace}
          onChange={value => setWorkspace(value as typeof workspace)}
          fullWidth
          testID="followups-workspace-tabs"
          options={[
            { value: "all", label: "All", icon: "layers" },
            { value: "visit_showroom", label: "Visit Showroom", icon: "home" },
            ...(hasTileFollowupWorkspaces ? [
              { value: "selection", label: `Selections${stats ? ` · ${stats.workspace_counts.selection}` : ""}`, icon: "grid" as FeatherName },
              { value: "quotation_tiles", label: `Quotations${stats ? ` · ${stats.workspace_counts.quotation_tiles}` : ""}`, icon: "file-text" as FeatherName },
            ] : []),
          ]}
        />
      )}

      {!isSanitary ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        <Chip label={`Today${stats ? ` · ${stats.today_tasks}` : ""}`} active={filterValues(kpiFilter).includes("today")} onPress={() => toggleKpi("today")} />
        <Chip label={`Overdue${stats ? ` · ${stats.overdue}` : ""}`} active={filterValues(kpiFilter).includes("overdue")} onPress={() => toggleKpi("overdue")} />
        <Chip label="Summary" active={summaryOpen} onPress={toggleSummary} />
      </View> : null}
      {!isSanitary && summaryOpen ? <View style={{ gap: spacing.md }}>
      <ScrollView keyboardShouldPersistTaps="handled" horizontal={isPhone} showsHorizontalScrollIndicator={isPhone} contentContainerStyle={{ gap: spacing.md, paddingRight: isPhone ? spacing.md : 0 }} style={isPhone ? { marginHorizontal: -pagePad, paddingHorizontal: pagePad } : undefined}>
        <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: isPhone ? "nowrap" : "wrap" }}>
          <StatTile label="Today's Tasks" value={stats ? stats.today_tasks : "—"} icon="sun" tone="brand"
            sub={stats?.today_critical ? `${stats.today_critical} critical` : "On track"}
            onPress={() => openSummary("today")} style={filterValues(kpiFilter).includes("today") ? activeTileStyle : undefined} />
          <StatTile label="Overdue Tasks" value={stats ? stats.overdue : "—"} icon="alert-circle" tone="danger"
            sub={stats?.overdue_critical ? `${stats.overdue_critical} critical` : "None overdue"}
            onPress={() => openSummary("overdue")} style={filterValues(kpiFilter).includes("overdue") ? activeTileStyle : undefined} />
          <StatTile label="Expiring Soon" value={stats ? stats.expiring_quotations_count : "—"} icon="clock" tone="warning"
            onPress={() => openSummary("expiring")} />
          <StatTile label="Waiting For Customer" value={stats ? stats.waiting_for_customer : "—"} icon="watch" tone="warning"
            onPress={() => openSummary("waiting")} style={filterValues(kpiFilter).includes("waiting") ? activeTileStyle : undefined} />
        </View>
      </ScrollView>

      {/* Keep summary actions above asynchronous mission/list content so a
          loading-state change cannot move a tile during an active press. */}
      <MissionHero
        mission={mission}
        loading={loading}
        onOpenPriority={(id) => {
          const followup = rawItems.find((item) => item.id === id);
          if (followup) selectCard(followup);
        }}
        compact={isPhone}
      />

      </View> : null}

      <Panel padding={spacing.md}>
        <MobileFilterSection testID="followups-filters">
          <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center", flexWrap: isPhone ? "wrap" : "nowrap" }}>
            <View style={{ flex: 1, minWidth: isPhone ? "100%" : 0 }}>
              <SearchField testID="followups-search" value={q} onChangeText={setQ} onClear={() => setQ("")} placeholder="Search customer, phone, quotation #, project…" />
            </View>
            {!isPhone ? <IconButton icon="bookmark" onPress={() => setSavedViewsSheet(true)} tone="surface" accessibilityLabel="Saved views" size={40} /> : null}
            {!isPhone ? <IconButton icon="help-circle" onPress={() => setShortcutHelp(true)} tone="surface" accessibilityLabel="Keyboard shortcuts" size={40} /> : null}
          </View>
          {q.trim() ? <Text style={type.caption}>{filtered.length} customer{filtered.length === 1 ? "" : "s"} found</Text> : null}
          {isSanitary ? <FilterBar testID="followups-salesperson" multiSelect label="SALESPERSON" value={ownerFilter} onChange={setOwnerFilter} options={[
            { label: "All salespeople", value: "all" },
            ...(staff?.role !== "owner" ? [{ label: "Mine", value: "mine" }] : []),
            ...assignees.map(a => ({ label: a.full_name, value: a.id })),
          ]} /> : <>
          <FilterBar multiSelect label="PRIORITY" value={priorityFilter} onChange={setPriorityFilter as any} options={[
            { value: "all", label: "All priorities" }, { value: "critical", label: "Critical", count: priorityCounts.critical || undefined },
            { value: "high", label: "High", count: priorityCounts.high || undefined }, { value: "medium", label: "Medium", count: priorityCounts.medium || undefined },
            { value: "low", label: "Low", count: priorityCounts.low || undefined },
          ]} />
            <FilterBar multiSelect label="TYPE" value={categoryFilter} onChange={setCategoryFilter} options={CATEGORY_OPTIONS} />
            <View style={{ width: "100%", minWidth: 0 }}>
              <FilterBar testID="followups-owner" multiSelect label="OWNER" value={ownerFilter} onChange={setOwnerFilter} options={[
                { label: "All owners", value: "all" }, { label: "Mine", value: "mine" },
                ...assignees.map(a => ({ label: a.full_name, value: a.id })),
              ]} />
            </View>
          </>}

          {kpiFilter !== "all" || activeFilterCount > 0 ? <Chip label="Clear filters ✕" active onPress={() => { setKpiFilter("all"); setFollowupView("active"); setPriorityFilter("all"); setCategoryFilter("all"); setOwnerFilter("all"); }} /> : null}
        </MobileFilterSection>
      </Panel>

      {selectedIds.size > 0 && !isPhone ? <BulkActionBar busy={bulkSaving} count={selectedIds.size} assignees={assignees} onClear={clearSelection} onSnooze={bulkSnooze} onComplete={bulkComplete} onAssign={bulkAssign} /> : null}
    </>
  );

  const paginationFooter = (hasMorePages || listPage > 1) ? (
    <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.md, paddingTop: spacing.md }}>
      {listPage > 1 ? <Button label="Previous page" variant="secondary" size="sm" disabled={loadingPage} onPress={() => void loadList(listPage - 1, true)} testID="followups-previous-page" /> : null}
      <Text style={type.caption}>Page {listPage}</Text>
      {hasMorePages ? <Button label={loadingPage ? "Loading page…" : "Next page"} variant="secondary" size="sm" disabled={loadingPage} onPress={() => void loadList(listPage + 1, true)} testID="followups-next-page" /> : null}
    </View>
  ) : null;

  const renderFollowupList = (phone = false, includeWorkspaceHeader = false) => {
    const ownsScroll = phone || includeWorkspaceHeader;
    const horizontalPadding = ownsScroll ? pagePad : 0;
    return (
    <SectionList
      sections={listError ? [] : visibleSections}
      keyExtractor={(item) => item.id}
      scrollEnabled={ownsScroll}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      style={ownsScroll ? { flex: 1 } : undefined}
      refreshControl={ownsScroll ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} /> : undefined}
      contentContainerStyle={phone ? { paddingBottom: spacing.xl + (selectedIds.size > 0 ? bulkDockHeight : 0) } : ownsScroll ? { paddingBottom: spacing.xxxl } : { gap: spacing.sm, paddingBottom: spacing.sm }}
      ListHeaderComponent={ownsScroll ? <View style={{ padding: pagePad, gap: spacing.md }}>{workspaceAndFilters}</View> : undefined}
      ListEmptyComponent={loading ? (
        <View style={{ paddingHorizontal: horizontalPadding, gap: spacing.md }}><Skeleton w="30%" h={16} radius={radius.sm} /><SkeletonList rows={4} /></View>
      ) : listError ? (
        <View style={{ paddingHorizontal: horizontalPadding }}><Card><EmptyState icon="alert-circle" tone="neutral" title="Follow-ups are unavailable" subtitle={listError} action={<Button label="Try again" icon="rotate-cw" variant="primary" onPress={() => { void loadList(); }} />} /></Card></View>
      ) : (
        <View style={{ paddingHorizontal: horizontalPadding }}><Card><EmptyState icon={q || activeFilterCount || kpiFilter !== "all" ? "search" : "check-circle"} tone="brand" title={q || activeFilterCount || kpiFilter !== "all" ? "No matching follow-ups" : "You're all caught up."} subtitle={q || activeFilterCount || kpiFilter !== "all" ? "Try a different search or clear the filters." : "Your next reminders will appear here."} action={<Button label="New Follow-up" icon="plus" variant="primary" onPress={() => setNewSheet(true)} />} /></Card></View>
      )}
      // Keeping paging with the final visible bucket means it is mounted with
      // the results on tablet-sized virtual lists, instead of being deferred
      // until the operator has already scrolled past the last card.
      ListFooterComponent={phone ? <View style={{ height: spacing.md }} /> : undefined}
      renderSectionHeader={({ section }) => {
        const meta = BUCKET_META[section.bucket];
        const isCollapsed = followupView === "active" && collapsed.has(section.bucket);
        const label = followupView === "won" ? "Won orders" : followupView === "lost" ? "Loss" : meta.label;
        const icon: FeatherName = followupView === "won" ? "shopping-bag" : followupView === "lost" ? "user-x" : meta.icon;
        return <Pressable accessibilityRole={followupView === "active" ? "button" : "header"} accessibilityLabel={label} accessibilityState={followupView === "active" ? { expanded: !isCollapsed } : undefined} onPress={() => followupView === "active" && toggleSection(section.bucket)} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 4, paddingHorizontal: horizontalPadding, backgroundColor: colors.surface }}>
          <Feather name={icon} size={14} color={colors.onSurfaceSecondary} /><Text style={type.overline}>{label}</Text><Badge label={String(section.itemCount)} tone="neutral" size="sm" /><View style={{ flex: 1 }} />{followupView === "active" ? <Feather name={isCollapsed ? "chevron-down" : "chevron-up"} size={16} color={colors.onSurfaceMuted} /> : null}
        </Pressable>;
      }}
      renderSectionFooter={({ section }) =>
        section.bucket === visibleSections[visibleSections.length - 1]?.bucket ? paginationFooter : null
      }
      renderItem={({ item: f }) => <View style={{ paddingHorizontal: horizontalPadding, marginBottom: spacing.sm }}><MemoFollowupCard f={f} floorNames={floors} active={f.id === selectedId} assignees={assignees} rank={isSanitary ? undefined : rankMap.get(f.id)} checked={selectedIds.has(f.id)} onToggleSelect={toggleSelect} onPress={selectCard} onCall={contact} onWhatsApp={contact} onEmail={contact} onComplete={completeFollowup} onSnooze={snoozeFollowup} onCustomSnooze={setCustomSnoozeFor} onPushDays={pushDue} onAssign={assignFollowup} onMarkLost={(item) => { setLossActionFor(item); setCallOutcomeFor(item); }} onDismiss={dismissFollowup} canDelete={canDeleteFollowups} onDelete={setDeleteTarget} onOpenDoc={openRelatedDocument} /></View>}
    />
    );
  };
  // ═══════════════════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      {!isPhone ? <PageHeader
        overline="WORKSPACE"
        title="Follow-ups"
        subtitle="Calls, reminders and customer promises. One clear next step."
        dense={isPhone}
        actions={
          isPhone ? (
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <IconButton icon="rotate-cw" onPress={onRefresh} tone="surface" accessibilityLabel="Refresh" size={40} />
              {staff?.role === "owner" ? <IconButton icon="users" onPress={() => router.push("/(admin)/team-assign" as never)} tone="surface" accessibilityLabel="Team assign" size={40} /> : null}
              <IconButton icon="plus" onPress={() => setNewSheet(true)} tone="brand" accessibilityLabel="New follow-up" size={40} testID="new-followup-btn" />
            </View>
          ) : (
            <>
              <IconButton icon="rotate-cw" onPress={onRefresh} tone="surface" accessibilityLabel="Refresh" size={38} />
              {staff && MANAGER_ROLES.includes(staff.role) ? (
                <Button label="Team View" icon="users" variant="secondary" size="md" onPress={() => router.push((staff?.role === "owner" ? "/(admin)/team-assign" : "/(admin)/followup-assignments") as any)} testID="team-view-btn" />
              ) : null}
              <Button label="Automation Rules" icon="zap" variant="secondary" size="md" onPress={() => setRulesSheet(true)} />
              <Dropdown
                label="Export" icon="download" variant="secondary"
                items={[
                  { label: "Export as Excel (.xlsx)", icon: "file-text", onPress: () => doExport("xlsx") },
                  { label: "Export as CSV", icon: "file", onPress: () => doExport("csv") },
                ]}
              />
              <Button label="New Follow-up" icon="plus" variant="primary" size="md" onPress={() => setNewSheet(true)} testID="new-followup-btn" />
            </>
          )
        }
      /> : null}

      {bulkResult ? (
        <View style={{ paddingHorizontal: pagePad, paddingTop: spacing.sm }}>
          <Card>
            <View style={{ flexDirection: isPhone ? "column" : "row", alignItems: isPhone ? "flex-start" : "center", gap: spacing.md }}>
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text style={type.bodySm}>{bulkResult.successCount ? `${bulkResult.successCount} updated, ` : ""}{bulkResult.failedIds.length} failed</Text>
                <Text style={type.caption}>The failed follow-ups remain selected. Retry only those records.</Text>
              </View>
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <Button label="Retry failed" icon="rotate-cw" variant="secondary" size="sm" onPress={retryFailedBulk} />
                <IconButton icon="x" tone="surface" size={34} accessibilityLabel="Dismiss bulk result" onPress={() => setBulkResult(null)} />
              </View>
            </View>
          </Card>
        </View>
      ) : null}

      {/* Legacy layout: one uninterrupted follow-up workspace. Customer
          context opens only when requested, so no desktop space is lost to a
          persistent right-hand panel. */}
      {renderFollowupList(isPhone, !isPhone)}

      {/* Mobile: floating quick-contact for the #1 priority item */}
      {!isSanitary && !isDesktop && !isPhone && topPriorityOpen ? (
        <View style={styles.fabWrap} pointerEvents="box-none">
          <Pressable
            testID="fab-whatsapp"
            onPress={() => contact(topPriorityOpen, "whatsapp")}
            style={[styles.fab, { backgroundColor: colors.success }]}
          >
            <Feather name="message-circle" size={20} color={colors.onBrand} />
          </Pressable>
          <Pressable
            testID="fab-call"
            onPress={() => contact(topPriorityOpen, "call")}
            style={[styles.fab, { backgroundColor: colors.brand }]}
          >
            <Feather name="phone" size={20} color={colors.onBrand} />
          </Pressable>
        </View>
      ) : null}

      {/* Selection should remain actionable while moving through a long phone
          queue; keeping it in the list header stranded it above the cards. */}
      {isPhone && selectedIds.size > 0 ? (
        <View onLayout={({ nativeEvent }) => setBulkDockHeight(nativeEvent.layout.height)} style={[styles.mobileBulkDock, { paddingBottom: Math.max(spacing.sm, insets.bottom + spacing.xs) }]} pointerEvents="box-none">
          <BulkActionBar
            busy={bulkSaving}
            count={selectedIds.size}
            assignees={assignees}
            onClear={clearSelection}
            onSnooze={bulkSnooze}
            onComplete={bulkComplete}
            onAssign={bulkAssign}
          />
        </View>
      ) : null}

      {/* Customer preview: opened from a card on every breakpoint. */}
      <Sheet
        visible={customerPreviewOpen}
        onClose={() => setCustomerPreviewOpen(false)}
        variant={isPhone ? "bottom" : "modal"}
        width={isPhone ? undefined : 720}
        title={detail?.customer?.company || detail?.customer?.name || "Customer"}
        subtitle={detail?.followup?.reason}
      >
        <ScrollView style={styles.mobileDetailScroll} contentContainerStyle={styles.mobileDetailContent}>
          {detail?.followup && detail.followup.status === "open" ? (
            <View style={styles.mobileCustomerActions}>
              <Text style={type.overline}>NEXT ACTION</Text>
              <Text style={type.bodySm} numberOfLines={2}>{detail.followup.next_action}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                <Button label="Call" icon="phone" variant="primary" size="sm" onPress={() => contact(detail.followup, "call")} />
                <IconButton icon="message-circle" tone="surface" size={44} accessibilityLabel="WhatsApp customer" onPress={() => contact(detail.followup, "whatsapp")} />
                <IconButton icon="check" tone="surface" size={44} accessibilityLabel="Mark follow-up complete" onPress={() => completeFollowup(detail.followup)} />
              </View>
              <Pressable
                onPress={() => router.push(`/(admin)/customers/${detail.customer.id}` as any)}
                style={styles.mobileCustomerLink}
                accessibilityRole="button"
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: colors.brand }}>View full customer profile</Text>
                <Feather name="arrow-up-right" size={16} color={colors.brand} />
              </Pressable>
            </View>
          ) : null}
          <ContextPanel detail={detail} loading={loadingDetail} embedded compact={isPhone} />
        </ScrollView>
      </Sheet>

      <CallOutcomeSheet visible={!!callOutcomeFor} f={callOutcomeFor} initialOutcome={lossActionFor?.id === callOutcomeFor?.id ? "lost" : undefined} onClose={() => { setCallOutcomeFor(null); setLossActionFor(null); }} onSubmit={logCallOutcome} />
      <NewFollowupSheet
        visible={newSheet} onClose={() => setNewSheet(false)} customers={customers} assignees={assignees}
        defaultAssignee={staff?.id} onCreate={createFollowup}
      />
      <LeadScopeSheet lead={scopeLead} leadIds={scopeLeadIds} floorId={selectedFloorId} onClose={() => setScopeLead(null)} onSaved={() => { void loadList(); void refreshStatsQuiet(); }} />
      <AutomationRulesSheet visible={rulesSheet} onClose={() => setRulesSheet(false)} rules={stats?.rules || []} />
      <CustomSnoozeSheet visible={!!customSnoozeFor} f={customSnoozeFor} onClose={() => setCustomSnoozeFor(null)} onSave={customSnooze} />
      <ConfirmDialog
        visible={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteFollowup}
        title="Delete this follow-up?"
        description="This permanently removes the follow-up and its timeline entries."
        confirmLabel="Delete follow-up"
        tone="danger"
        loading={deleting}
        testID="confirm-delete-followup"
      />
      <SavedViewsSheet
        visible={savedViewsSheet} onClose={() => setSavedViewsSheet(false)} views={savedViews}
        onApply={applySavedView} onSave={saveCurrentView} onDelete={deleteSavedView}
      />
      <ShortcutHelpSheet visible={shortcutHelp} onClose={() => setShortcutHelp(false)} />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BulkActionBar — appears once ≥1 card is selected. Superhuman-style batch
// processing so a salesperson can clear dozens of stale cards in one pass.
// ─────────────────────────────────────────────────────────────────────────────
function BulkActionBar({ count, assignees, onClear, onSnooze, onComplete, onAssign, busy }: {
  busy?: boolean; count: number; assignees: Assignee[]; onClear: () => void;
  onSnooze: (preset: "1h" | "tomorrow" | "next_week") => void;
  onComplete: () => void; onAssign: (userId: string) => void;
}) {
  return (
    <View style={[styles.bulkBar, elevation.medium]} accessibilityState={{ busy }}>
      {busy ? <Text accessibilityLiveRegion="polite" style={type.bodySm}>Updating selected follow-ups…</Text> : <>

      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Badge label={String(count)} tone="brand" size="sm" />
        <Text style={{ fontSize: 13, fontWeight: "700", color: colors.onSurface }}>selected</Text>
      </View>
      <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center", flexWrap: "wrap", flexShrink: 1, minWidth: 0 }}>
        <Dropdown
          label="Snooze" icon="clock" variant="secondary"
          items={[
            { label: "1 hour", icon: "clock", onPress: () => onSnooze("1h") },
            { label: "Tomorrow", icon: "sunrise", onPress: () => onSnooze("tomorrow") },
            { label: "Next week", icon: "calendar", onPress: () => onSnooze("next_week") },
          ]}
        />
        <Button label="Assign team" icon="users" variant="secondary" size="sm" onPress={() => onAssign("")} />
        <Button label="Complete" icon="check" variant="primary" size="sm" onPress={onComplete} />
        <IconButton icon="x" onPress={onClear} tone="surface" size={34} accessibilityLabel="Clear selection" />
      </View>
      </>}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SavedViewsSheet — persisted filter configurations (Export/Saved Views are
// no longer stubbed per product decision).
// ─────────────────────────────────────────────────────────────────────────────
function SavedViewsSheet({ visible, onClose, views, onApply, onSave, onDelete }: {
  visible: boolean; onClose: () => void; views: SavedView[];
  onApply: (v: SavedView) => void; onSave: (name: string) => void; onDelete: (id: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => { if (visible) { setNaming(false); setName(""); } }, [visible]);
  return (
    <Sheet visible={visible} onClose={onClose} variant="drawer" title="Saved Views" subtitle="Persist your filter combinations so you can jump straight back to them.">
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
        {views.length === 0 ? (
          <EmptyState icon="bookmark" title="No saved views yet" subtitle="Set up your filters above, then save them here for one-tap access." />
        ) : (
          views.map((v) => (
            <View key={v.id} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Pressable onPress={() => onApply(v)} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceSecondary }}>
                <Feather name="bookmark" size={14} color={colors.brand} />
                <Text style={type.bodySm}>{v.name}</Text>
              </Pressable>
              <IconButton icon="trash-2" onPress={() => onDelete(v.id)} tone="danger" size={36} accessibilityLabel="Delete view" />
            </View>
          ))
        )}
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.sm }} />
        {naming ? (
          <View style={{ gap: spacing.sm }}>
            <FormField label="View name">
              <TextInput value={name} onChangeText={setName} placeholder="e.g. My showroom leads" placeholderTextColor={colors.onSurfaceMuted} style={styles.textInput} autoFocus />
            </FormField>
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <Button label="Cancel" variant="secondary" size="md" onPress={() => setNaming(false)} />
              <Button label="Save View" icon="check" variant="primary" size="md" onPress={() => { if (name.trim()) { onSave(name.trim()); setNaming(false); setName(""); } }} />
            </View>
          </View>
        ) : (
          <Button label="Save current filters as a view" icon="plus" variant="secondary" size="md" onPress={() => setNaming(true)} />
        )}
      </ScrollView>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ShortcutHelpSheet — makes the (already implemented) keyboard shortcuts
// discoverable. Triggered by the "?" key or the header help icon.
// ─────────────────────────────────────────────────────────────────────────────
const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "C", label: "Call the selected follow-up" },
  { keys: "W", label: "WhatsApp the selected follow-up" },
  { keys: "E", label: "Email the selected follow-up" },
  { keys: "Space", label: "Mark selected follow-up complete" },
  { keys: "S", label: "Snooze selected follow-up 1 hour" },
  { keys: "/", label: "Focus search" },
  { keys: "Esc", label: "Deselect / close panels" },
  { keys: "?", label: "Toggle this shortcut list" },
];
function ShortcutHelpSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} onClose={onClose} variant="modal" title="Keyboard Shortcuts" subtitle="Select a card, then use these — web only." width={420}>
      <View style={{ padding: spacing.xl, gap: spacing.sm }}>
        {SHORTCUTS.map((s) => (
          <View key={s.keys} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={type.bodySm}>{s.label}</Text>
            <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: colors.onSurface, fontFamily: type.mono.fontFamily }}>{s.keys}</Text>
            </View>
          </View>
        ))}
      </View>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MissionHero — Today's Mission
// ─────────────────────────────────────────────────────────────────────────────
function MissionHero({ mission, loading, onOpenPriority, compact }: { mission: Mission | null; loading: boolean; onOpenPriority: (id: string) => void; compact?: boolean }) {
  if (!loading && !mission) return <Text style={type.bodyMuted}>Summary unavailable. Your task queue is still available below.</Text>;
  if (loading || !mission) {
    return (
      <View style={{ padding: spacing.xl, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: spacing.md }}>
        <Skeleton w="40%" h={12} radius={radius.sm} />
        <Skeleton w="70%" h={22} radius={radius.sm} />
        <Skeleton w="90%" h={14} radius={radius.sm} />
      </View>
    );
  }
  const clean = mission.due_count === 0;
  if (compact) {
    return (
      <View style={styles.mobileMissionCard}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.md }}>
          <View style={styles.mobileMissionIcon}>
            <Feather name={clean ? "check-circle" : "zap"} size={18} color={clean ? colors.success : colors.brand} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
            <Text style={type.overline}>TODAY&apos;S MISSION</Text>
            <Text style={styles.mobileMissionTitle} numberOfLines={3}>
              {clean ? `${greeting()}, ${mission.greeting_name}. You're clear.` : `${mission.due_count} follow-up${mission.due_count === 1 ? "" : "s"} need you.`}
            </Text>
            <Text style={type.bodyMuted} numberOfLines={2}>
              {clean ? "No revenue at risk right now." : `₹${mission.revenue_at_risk_short.replace("₹", "")} at risk · ${mission.estimated_minutes} min to clear`}
            </Text>
          </View>
          {!clean && mission.top_priorities[0] ? <Button label="#1" icon="arrow-right" variant="primary" size="sm" onPress={() => onOpenPriority(mission.top_priorities[0].id)} testID="mission-jump-top" /> : null}
        </View>
        {!clean && mission.top_priorities.length ? (
          <View style={{ gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider }}>
            {mission.top_priorities.slice(0, 3).map((p, i) => (
              <Pressable key={p.id} onPress={() => onOpenPriority(p.id)} style={styles.mobileMissionPriority}>
                <View style={styles.mobileRank}><Text style={styles.mobileRankText}>{i + 1}</Text></View>
                <Text style={[type.bodySm, { flex: 1 }]} numberOfLines={1}>{p.customer_name} — {p.reason}</Text>
                <Badge label={String(p.priority_score)} tone="brand" size="sm" />
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <HeroCard
      overline="TODAY'S MISSION"
      title={clean ? `${greeting()}, ${mission.greeting_name}. You're clear.` : `${greeting()}, ${mission.greeting_name}. ${mission.due_count} follow-up${mission.due_count === 1 ? "" : "s"} need you.`}
      subtitle={clean
        ? "No revenue is at risk right now — great work staying ahead."
        : compact
          ? `₹${mission.revenue_at_risk_short.replace("₹", "")} at risk · ${mission.estimated_minutes} min to clear`
          : `₹${mission.revenue_at_risk_short.replace("₹", "")} potential revenue at risk · ${mission.quotations_expiring_today} quotation${mission.quotations_expiring_today === 1 ? "" : "s"} expiring today · Est. ${mission.estimated_minutes} min to clear`}
      icon={clean ? "check-circle" : "zap"}
      iconTone={clean ? "success" : mission.critical_count > 0 ? "danger" : "brand"}
      actions={clean || !mission.top_priorities[0] ? undefined : <Button label="Start with #1" icon="arrow-right" variant="primary" size="md" onPress={() => onOpenPriority(mission.top_priorities[0].id)} testID="mission-jump-top" />}
      metaRow={!clean && mission.top_priorities.length ? (
        <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.divider }} />
          {mission.top_priorities.map((p, i) => (
            <Pressable key={p.id} onPress={() => onOpenPriority(p.id)} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 36 }}>
              <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.brandTint, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 11, fontWeight: "700", color: colors.brand }}>{i + 1}</Text>
              </View>
              <Text style={[type.bodySm, { flex: 1 }]} numberOfLines={1}>{p.customer_name} — {p.reason}</Text>
              <Badge label={String(p.priority_score)} tone="brand" size="sm" />
            </Pressable>
          ))}
        </View>
      ) : undefined}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ScoreBadge — the AI Priority Score. Explainable, deterministic.
// ─────────────────────────────────────────────────────────────────────────────
function ScoreBadge({ score, level }: { score: number; level: PriorityLevel }) {
  const tone = PRIORITY_TONE[level];
  return (
    <View style={{ alignItems: "center", gap: 2, minWidth: 46 }}>
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: tone.bg, borderWidth: 1.5, borderColor: tone.border, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: tone.fg, fontVariant: ["tabular-nums"] }}>{score}</Text>
      </View>
      <Text style={{ fontSize: 9, fontWeight: "700", color: tone.fg, letterSpacing: 0.4, textTransform: "uppercase" }}>{level}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// IconMenuButton — icon-only trigger + small overlay menu (promoted Snooze /
// Assign — closes the "top actions buried 2 clicks deep" audit finding).
// ─────────────────────────────────────────────────────────────────────────────
function IconMenuButton({ icon, tone = "surface", accessibilityLabel, items, testID }: {
  icon: FeatherName; tone?: "surface" | "brandLight"; accessibilityLabel?: string;
  items: { label: string; icon?: FeatherName; onPress: () => void; tone?: "default" | "danger" }[];
  testID?: string;
}) {
  return (
    <Menu
      triggerLabel={accessibilityLabel || icon.replace(/-/g, " ")}
      triggerTestID={testID}
      items={items.map((item) => ({ ...item, tone: item.tone === "danger" ? "risk" : "ink" }))}
    >
      <View style={{ width: 44, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: tone === "brandLight" ? colors.brandTint : colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: tone === "brandLight" ? colors.brandBorder : colors.border }}>
        <Feather name={icon} size={16} color={tone === "brandLight" ? colors.brand : colors.onSurface} />
      </View>
    </Menu>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FollowupCard — the inbox row. Swipe right=Complete, left=Snooze (mobile).
// Long-press = quick Assign. Left-edge color bar = instant priority scan.
// ─────────────────────────────────────────────────────────────────────────────
function FollowupCard({
  f, active, assignees, rank, checked, floorNames, onToggleSelect,
  onPress, onCall, onWhatsApp, onEmail, onComplete, onSnooze, onCustomSnooze, onPushDays, onAssign, onMarkLost, onDismiss, canDelete, onDelete, onOpenDoc,
}: {
  floorNames: { id: string; name: string }[]; f: Followup; active: boolean; assignees: Assignee[]; rank?: number; checked: boolean; onToggleSelect: (id: string) => void;
  onPress: (f: Followup) => void; onCall: (f: Followup, channel: Channel) => void; onWhatsApp: (f: Followup, channel: Channel) => void; onEmail: (f: Followup, channel: Channel) => void;
  onComplete: (f: Followup) => void; onSnooze: (f: Followup, preset: "15m" | "1h" | "tomorrow" | "next_week") => void;
  onCustomSnooze: (f: Followup) => void; onPushDays: (f: Followup, days: number) => void;
  onAssign: (f: Followup, userId: string) => void; onMarkLost: (f: Followup) => void; onDismiss: (f: Followup) => void; canDelete: boolean; onDelete: (f: Followup) => void; onOpenDoc?: (f: Followup) => void;
}) {
  const { isPhone } = useBp();
  const isSanitary = ["first-floor", "ground-floor"].includes(f.floor_id || "");
  const level = f.manual_priority_override || f.priority_level;
  const tone = PRIORITY_TONE[level];
  const isResolved = f.status === "done" || f.status === "dismissed";
  const overdueDue = f.bucket === "overdue";
  const canOpenDoc = !!onOpenDoc
    && (f.rule_type === "selection_waiting" || f.rule_type === "quotation_tiles_waiting")
    && !!f.quotation_id;
  const swipeRef = useRef<Swipeable>(null);

  const content = (
    <HoverCard onPress={() => onPress(f)} padding={spacing.md} testID={`followup-${f.id}`} style={{
      borderColor: active ? colors.brand : colors.border,
      backgroundColor: active ? colors.brandTint : colors.surfaceSecondary,
      borderLeftWidth: 4,
      borderLeftColor: isResolved || isSanitary ? colors.border : tone.fg,
      ...(active ? elevation.medium : {}),
    }}>
      <View style={{ gap: spacing.sm }}>
        {/* Header row */}
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
          {!isResolved ? (
            <Pressable onPress={(event) => { event.stopPropagation(); onToggleSelect(f.id); }} hitSlop={8} style={{ paddingTop: 2, minWidth: 24, minHeight: 24 }} accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel="Select">
              <Feather name={checked ? "check-square" : "square"} size={18} color={checked ? colors.brand : colors.onSurfaceMuted} />
            </Pressable>
          ) : null}
          <Avatar name={f.customer_name} size={38} tone="brand" />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {rank ? (
                <View style={styles.rankChip}>
                  <Text style={styles.rankChipText}>#{rank}</Text>
                </View>
              ) : null}
              <Text style={type.titleSm} numberOfLines={1}>{f.customer_name}</Text>
              {f.is_automated ? <Badge label="Auto" tone="info" size="sm" icon="zap" /> : null}
            </View>
            <Text style={type.caption} numberOfLines={1}>
              {[f.project_name, f.quotation_number || f.purchase_number].filter(Boolean).join(" · ") || "General follow-up"}
            </Text>
          </View>
          {!isResolved ? (isSanitary ? null : <ScoreBadge score={f.priority_score} level={level} />) : (
            <Badge label={f.completed_outcome === "lost" ? "Lost" : isWonOrderFollowup(f) ? "Won order" : f.status === "dismissed" ? "Dismissed" : (f.completed_outcome || "Done")} tone={f.completed_outcome === "lost" || f.status === "dismissed" ? "neutral" : "success"} size="sm" />
          )}
        </View>

        {f.interested_floor_ids?.length ? <Text style={type.bodySm}>Interested: {f.interested_floor_ids.map(id => floorNames.find(floor => floor.id === id)?.name || id).join(", ")}</Text> : null}
        {!isResolved ? <Button label="Interested floors · Assign team" icon="layers" variant="secondary" size="sm" onPress={() => onAssign(f, "")} testID={`interested-${f.id}`} /> : null}
        {f.referrer_name || f.architect_interior_designer || f.reference_source ? <Text style={type.caption}>{[f.reference_source, referrerLabel(f) || f.architect_interior_designer, f.referrer_company, f.referrer_customers_acquired != null ? `${f.referrer_customers_acquired} customers brought` : null].filter(Boolean).join(" · ")}</Text> : null}
        {/* Revenue — dedicated visual chip (was buried in prose; audit gap) */}
        {f.value > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", backgroundColor: colors.surfaceTertiary, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
            <Feather name="trending-up" size={11} color={colors.onSurfaceSecondary} />
            <Text style={[type.numeric, { fontSize: 12, lineHeight: 16, color: colors.onSurface }]}>{moneyShort(f.value)}</Text>
            <Text style={type.caption}>at stake</Text>
          </View>
        ) : null}

        {/* Reason + explainability */}
        <View style={{ gap: 2 }}>
          <Text style={type.bodySm} numberOfLines={isPhone ? 1 : 2}>{f.reason}</Text>
          {!isPhone && f.reason_factors?.length ? (
            <Text style={type.caption} numberOfLines={2}>{f.reason_factors.join(" · ")}</Text>
          ) : null}
        </View>

        {/* Tags */}
        {!isPhone && f.tags?.length ? (
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {f.tags.map((t, i) => <Badge key={`${t}-${i}`} label={t} tone="neutral" size="sm" />)}
          </View>
        ) : null}

        {/* Next Best Action */}
        {!isResolved ? (
          <View style={{ backgroundColor: colors.brandTint, borderRadius: radius.sm, padding: spacing.sm, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Feather name={CHANNEL_ICON[f.suggested_channel]} size={12} color={colors.brand} />
              <Text style={{ fontSize: 12, fontWeight: "700", color: colors.brand }}>{f.next_action}</Text>
            </View>
            {!isPhone ? <Text style={{ fontSize: 11, color: colors.brand, opacity: 0.85 }} numberOfLines={2}>{f.next_action_reason}</Text> : null}
          </View>
        ) : f.resolution_note ? (
          <Text style={type.caption} numberOfLines={2}>{f.resolution_note}</Text>
        ) : null}

        {/* Meta row */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: overdueDue ? colors.error : colors.onSurfaceSecondary }}>{dueLabel(f)}</Text>
          <Text style={type.caption} numberOfLines={1}>{timeAgo(f.last_contacted_at)}</Text>
        </View>
        {f.assigned_to_name ? (
          <Text style={type.caption}>{isSanitary ? "Salesperson:" : "Assigned to"} {f.assigned_to_name}</Text>
        ) : null}

        {/* Actions — Call/WhatsApp/Snooze/Assign/Complete are 1-click; the
            rest (Email, custom snooze, loss, dismiss) live in the overflow. */}
        {!isResolved && isPhone ? (
          <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center", marginTop: 2 }}>
            <Button
              label={f.suggested_channel === "whatsapp" ? "WhatsApp" : "Call"}
              icon={f.suggested_channel === "whatsapp" ? "message-circle" : "phone"}
              variant="primary"
              size="sm"
              onPress={() => f.suggested_channel === "whatsapp" ? onWhatsApp(f, "whatsapp") : onCall(f, "call")}
              testID={`contact-${f.id}`}
            />
            <IconButton icon="check" onPress={() => onComplete(f)} size={44} tone="surface" accessibilityLabel="Mark complete" testID={`complete-${f.id}`} />
            <View style={{ flex: 1 }} />
            <Dropdown
              label="More" icon="more-horizontal" variant="secondary"
              items={[
                { label: "Open customer details", icon: "user", onPress: () => onPress(f) },
                ...(canOpenDoc ? [{ label: f.rule_type === "selection_waiting" ? "Open Selection" : "Open Quotation", icon: "external-link" as FeatherName, onPress: () => onOpenDoc!(f) }] : []),
                { label: "Call", icon: "phone", onPress: () => onCall(f, "call") },
                { label: "WhatsApp", icon: "message-circle", onPress: () => onWhatsApp(f, "whatsapp") },
                { label: "Snooze 1 hour", icon: "clock", onPress: () => onSnooze(f, "1h") },
                { label: "Mark as lost…", icon: "user-x", tone: "danger" as const, onPress: () => onMarkLost(f) },
              ]}
            />
          </View>
        ) : !isResolved ? (
          <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
            <IconButton icon="phone" onPress={() => onCall(f, "call")} size={34} tone="brandLight" accessibilityLabel="Call" testID={`call-${f.id}`} />
            <IconButton icon="message-circle" onPress={() => onWhatsApp(f, "whatsapp")} size={34} tone="surface" accessibilityLabel="WhatsApp" testID={`wa-${f.id}`} />
            {canOpenDoc ? (
              <Button
                label={f.rule_type === "selection_waiting" ? "Open Selection" : "Open Quotation"}
                icon="external-link" variant="secondary" size="sm" onPress={() => onOpenDoc!(f)}
                testID={`open-doc-${f.id}`}
              />
            ) : null}
            <IconMenuButton
              icon="clock" accessibilityLabel="Snooze" testID={`snooze-${f.id}`}
              items={[
                { label: "Snooze 15 min", icon: "clock", onPress: () => onSnooze(f, "15m") },
                { label: "Snooze 1 hour", icon: "clock", onPress: () => onSnooze(f, "1h") },
                { label: "Snooze till tomorrow", icon: "sunrise", onPress: () => onSnooze(f, "tomorrow") },
                { label: "Snooze next week", icon: "calendar", onPress: () => onSnooze(f, "next_week") },
                { label: "Custom snooze…", icon: "edit-2", onPress: () => onCustomSnooze(f) },
              ]}
            />
            <IconMenuButton
              icon="fast-forward" accessibilityLabel="Push follow-up date" testID={`push-${f.id}`}
              items={[
                { label: "Push +1 day", icon: "chevron-right", onPress: () => onPushDays(f, 1) },
                { label: "Push +2 days", icon: "chevron-right", onPress: () => onPushDays(f, 2) },
                { label: "Push +3 days", icon: "chevron-right", onPress: () => onPushDays(f, 3) },
                { label: "Push +7 days", icon: "chevron-right", onPress: () => onPushDays(f, 7) },
              ]}
            />
            <IconButton icon="check" onPress={() => onComplete(f)} size={34} tone="surface" accessibilityLabel="Mark complete" testID={`complete-${f.id}`} />
            <Dropdown
              label="More" icon="more-horizontal" variant="secondary"
              items={[
                { label: "Email", icon: "mail", onPress: () => onEmail(f, "email") },
                { label: "Mark as lost…", icon: "user-x", tone: "danger" as const, onPress: () => onMarkLost(f) },
                { label: "Dismiss", icon: "x-circle", tone: "danger" as const, onPress: () => onDismiss(f) },
              ]}
            />
            {canDelete ? <IconButton icon="trash-2" onPress={() => onDelete(f)} size={34} tone="danger" accessibilityLabel="Delete follow-up" testID={`delete-followup-${f.id}`} /> : null}
          </View>
        ) : null}
      </View>
    </HoverCard>
  );

  if (Platform.OS === "web" || isResolved) return content;

  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      leftThreshold={40}
      rightThreshold={40}
      renderLeftActions={() => (
        <View style={[styles.swipeAction, { backgroundColor: colors.success }]}>
          <Feather name="check" size={18} color={colors.onBrand} />
          <Text style={styles.swipeText}>Complete</Text>
        </View>
      )}
      renderRightActions={() => (
        <View style={[styles.swipeAction, { backgroundColor: colors.warning }]}>
          <Text style={styles.swipeText}>Snooze</Text>
          <Feather name="clock" size={18} color={colors.onBrand} />
        </View>
      )}
      onSwipeableOpen={(direction) => {
        swipeRef.current?.close();
        if (direction === "left") onComplete(f);
        else onSnooze(f, "1h");
      }}
    >
      {content}
    </Swipeable>
  );
}

// The virtualized list receives stable data and action handlers; memoization
// keeps visible cards from re-rendering when unrelated workspace state changes.
const MemoFollowupCard = memo(FollowupCard);

// ─────────────────────────────────────────────────────────────────────────────
// ContextPanel — full customer context inside the on-demand preview sheet.
// ─────────────────────────────────────────────────────────────────────────────
function ContextPanel({ detail, loading, embedded, compact }: { detail: Detail | null; loading: boolean; embedded?: boolean; compact?: boolean }) {
  if (loading) {
    return (
      <Panel title="Customer" overline="CONTEXT">
        <View style={{ gap: spacing.sm }}>
          <Skeleton w="60%" h={16} radius={radius.sm} />
          <Skeleton w="90%" h={12} radius={radius.sm} />
          <Skeleton w="100%" h={60} radius={radius.md} />
        </View>
      </Panel>
    );
  }
  if (!detail) {
    return embedded ? null : (
      <Panel title="Customer" overline="CONTEXT">
        <EmptyState icon="user" title="Select a follow-up" subtitle="Choose a card on the left to see full customer context, timeline and history." />
      </Panel>
    );
  }
  const { followup, customer, stats, quotations, timeline } = detail;
  return (
    <View style={{ gap: spacing.md }}>
      <Panel overline="CONTEXT" title={customer.company || customer.name}>
        <View style={{ gap: spacing.sm }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {customer.phone ? <Badge label={customer.phone} tone="neutral" size="sm" icon="phone" /> : null}
            {customer.email ? <Badge label={customer.email} tone="neutral" size="sm" icon="mail" /> : null}
            {customer.city ? <Badge label={customer.city} tone="neutral" size="sm" icon="map-pin" /> : null}

            <Badge
              label={`${stats.risk_level.toUpperCase()} RISK`}
              tone={stats.risk_level === "high" ? "error" : stats.risk_level === "medium" ? "warning" : "success"}
              size="sm" icon="shield"
            />
          </View>
          {customer.address ? <Text style={type.caption}>{customer.address}</Text> : null}
          {followup.referrer_name || followup.architect_interior_designer ? <Text style={type.caption}>{[referrerLabel(followup) || followup.architect_interior_designer, followup.referrer_company, followup.referrer_customers_acquired != null ? `${followup.referrer_customers_acquired} customers brought` : null].filter(Boolean).join(" · ")}</Text> : null}
          {(followup.assigned_to_name || stats.preferred_salesperson) ? (
            <Text style={type.caption}>
              Salesperson: {followup.assigned_to_name || "—"}
              {stats.preferred_salesperson && stats.preferred_salesperson !== followup.assigned_to_name ? ` · Usually served by ${stats.preferred_salesperson}` : ""}
            </Text>
          ) : null}
        </View>
      </Panel>

      {quotations.length ? (
        <Panel title="Pending quotations" overline="QUOTATIONS">
          <View style={{ gap: spacing.sm }}>
            {quotations.slice(0, 5).map((q) => (
              <View key={q.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}>
                <Text style={[type.bodySm, { flex: 1, minWidth: 0 }]} numberOfLines={1}>{q.number}</Text>
                <Text style={{ fontSize: 13, fontWeight: "700", color: colors.onSurface, flexShrink: 0 }}>{moneyShort(q.grand_total)}</Text>
              </View>
            ))}
          </View>
        </Panel>
      ) : null}

      <Panel title="Timeline" overline="ACTIVITY">
        <ActivityTimeline events={timeline} emptyLabel="No activity logged yet for this customer." />
      </Panel>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CallOutcomeSheet
// ─────────────────────────────────────────────────────────────────────────────
const OUTCOMES: { value: string; label: string; icon: FeatherName; tone: "success" | "warning" | "danger" | "brand" }[] = [
  { value: "interested", label: "Interested", icon: "thumbs-up", tone: "success" },
  { value: "call_back", label: "Call Back", icon: "phone-call", tone: "brand" },
  { value: "pending", label: "Pending", icon: "clock", tone: "warning" },
  { value: "no_answer", label: "No Answer", icon: "phone-missed", tone: "warning" },
    { value: "lost", label: "Lost", icon: "user-x", tone: "danger" },
];
function CallOutcomeSheet({ visible, f, initialOutcome, onClose, onSubmit }: {
  visible: boolean; f: Followup | null; initialOutcome?: string; onClose: () => void; onSubmit: (f: Followup, outcome: string, notes?: string, nextFollowupAt?: string, response?: string, interestedFloorIds?: string[], assignments?: LeadScope["assignments"]) => void;
}) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [nextFollowupAt, setNextFollowupAt] = useState("");
  const { selectedFloorId } = useFloorAccess();
  const [response, setResponse] = useState("");
  const [callScope, setCallScope] = useState<LeadScope>({ interested_floor_ids: [], assignments: [] });
  const [scopeDirty, setScopeDirty] = useState(false);
  const { floors: editableFloors } = useFloorAccess();
  const canEditCallScope = !!f && (f.interested_floor_ids || [f.floor_id || selectedFloorId]).every(id => editableFloors.some(floor => floor.id === id));
  // Initialize before the sheet can accept a choice or a Lost reason. A passive
  // effect could run after the first click and erase that new input.
  useLayoutEffect(() => { if (visible) { setOutcome(initialOutcome || null); setNotes(""); setNextFollowupAt(""); setResponse(""); setScopeDirty(false); setCallScope({ interested_floor_ids: f?.interested_floor_ids?.length ? f.interested_floor_ids : [f?.floor_id || selectedFloorId], assignments: f?.assignments?.length ? f.assignments : f?.assigned_to ? [{ floor_id: f.floor_id || selectedFloorId, user_id: f.assigned_to, user_name: f.assigned_to_name || undefined }] : [] }); } }, [visible, initialOutcome, f, selectedFloorId]);
  if (!f) return null;
  const notesRequired = outcome === "lost";
  const pending = outcome === "pending";
  const createsSuccessor = outcome === "interested" || outcome === "call_back" || pending;
  const hasLocalAssignee = callScope.assignments.some(a => a.floor_id === (f.floor_id || selectedFloorId) && a.user_id);
  const canSave = (!createsSuccessor || hasLocalAssignee) && !!outcome && (!notesRequired || !!notes.trim()) && (!pending || !!nextFollowupAt.trim());
  return (
    <Sheet visible={visible} onClose={onClose} variant="modal" title="Log Call Outcome" subtitle={f.customer_name} width={440}
      footer={<>
        <Button label="Cancel" variant="secondary" onPress={onClose} size="md" />
        <View style={{ flex: 1 }} />
        <Button label="Save" variant="primary" icon="check" disabled={!canSave} onPress={() => outcome && onSubmit(f, outcome, notesRequired ? notes.trim() : undefined, nextFollowupAt.trim() || undefined, response, createsSuccessor && scopeDirty && canEditCallScope ? callScope.interested_floor_ids : undefined, createsSuccessor && scopeDirty && canEditCallScope ? callScope.assignments : undefined)} size="md" testID="save-call-outcome" />
      </>}
    >
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
        <Text style={type.overline}>OUTCOME</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {OUTCOMES.map((o) => {
            const on = outcome === o.value;
            const tone = { success: colors.success, warning: colors.warning, danger: colors.error, brand: colors.brand }[o.tone];
            return (
              <Pressable key={o.value} testID={`outcome-${o.value}`} onPress={() => { setOutcome(o.value); setNotes(""); }}
                style={{
                  paddingHorizontal: spacing.md, height: 40, borderRadius: radius.md,
                  borderWidth: StyleSheet.hairlineWidth, borderColor: on ? tone : colors.border,
                  backgroundColor: on ? tone : colors.surfaceSecondary,
                  flexDirection: "row", alignItems: "center", gap: 6,
                }}
              >
                <Feather name={o.icon} size={14} color={on ? colors.onBrand : colors.onSurfaceSecondary} />
                <Text style={{ fontSize: 13, fontWeight: "600", color: on ? colors.onBrand : colors.onSurface }}>{o.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {createsSuccessor && canEditCallScope ? <LeadScopeFields assignmentsRequired requiredFloorId={f.floor_id || selectedFloorId} value={callScope} onChange={value => { setCallScope(value); setScopeDirty(true); }} sourceId={f.id} sourceFloorId={f.floor_id || selectedFloorId} reference={false} /> : null}
        <FormField label="Customer response"><TextInput value={response} onChangeText={setResponse} placeholder="What did the customer say?" style={styles.textArea} multiline testID="lead-call-response" /></FormField>
        {pending ? (
          <FormField label="Next follow-up date" helper="Required — enter when the customer asked you to reconnect (for example, 2026-08-14T10:00).">
            <TextInput value={nextFollowupAt} onChangeText={setNextFollowupAt} placeholder="YYYY-MM-DDTHH:MM" placeholderTextColor={colors.onSurfaceMuted}
              style={styles.textInput} testID="pending-next-followup-at" />
          </FormField>
        ) : null}
        {notesRequired ? <FormField label="Lost reason" helper="Required — record why we cannot work with this customer.">
          <TextInput value={notes} onChangeText={setNotes} placeholder="What did the customer say?" placeholderTextColor={colors.onSurfaceMuted}
            style={styles.textArea} multiline testID="outcome-notes" />
        </FormField> : null}
      </ScrollView>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CustomSnoozeSheet
// ─────────────────────────────────────────────────────────────────────────────
function CustomSnoozeSheet({ visible, f, onClose, onSave }: { visible: boolean; f: Followup | null; onClose: () => void; onSave: (f: Followup, untilIso: string) => void }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  useEffect(() => {
    if (visible) {
      const d = new Date(Date.now() + 86400000);
      setDate(d.toISOString().slice(0, 10));
      setTime("09:00");
    }
  }, [visible]);
  if (!f) return null;
  const submit = () => {
    if (!date) { toast.error("Pick a date"); return; }
    const iso = new Date(`${date}T${time || "09:00"}:00`).toISOString();
    onSave(f, iso);
  };
  return (
    <Sheet visible={visible} onClose={onClose} variant="modal" title="Custom Snooze" subtitle={f.customer_name} width={400}
      footer={<>
        <Button label="Cancel" variant="secondary" onPress={onClose} size="md" />
        <View style={{ flex: 1 }} />
        <Button label="Snooze" variant="primary" icon="clock" onPress={submit} size="md" />
      </>}
    >
      <View style={{ padding: spacing.xl, gap: spacing.md }}>
        <FormField label="Date">
          {Platform.OS === "web" ? (
            // @ts-ignore native HTML date input
            <input type="date" value={date} onChange={(e: any) => setDate(e.target.value)}
              style={{ border: `1px solid ${colors.border}`, borderRadius: radius.md, padding: "10px 12px", fontSize: 14, backgroundColor: colors.surfaceSecondary, color: colors.onSurface, fontFamily: "inherit", outline: "none", boxSizing: "border-box", height: 40 } as any} />
          ) : (
            <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.onSurfaceMuted} style={styles.textInput} />
          )}
        </FormField>
        <FormField label="Time">
          {Platform.OS === "web" ? (
            // @ts-ignore native HTML time input
            <input type="time" value={time} onChange={(e: any) => setTime(e.target.value)}
              style={{ border: `1px solid ${colors.border}`, borderRadius: radius.md, padding: "10px 12px", fontSize: 14, backgroundColor: colors.surfaceSecondary, color: colors.onSurface, fontFamily: "inherit", outline: "none", boxSizing: "border-box", height: 40 } as any} />
          ) : (
            <TextInput value={time} onChangeText={setTime} placeholder="HH:MM" placeholderTextColor={colors.onSurfaceMuted} style={styles.textInput} />
          )}
        </FormField>
      </View>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NewFollowupSheet — manual reminder
// ─────────────────────────────────────────────────────────────────────────────
const NEW_CATEGORIES = ["general", "quotation", "selection", "walk_in"] as const;
const NEW_CHANNELS: Channel[] = ["call", "whatsapp", "email", "visit"];
function NewFollowupSheet({ visible, onClose, customers, assignees, defaultAssignee, onCreate }: {
  visible: boolean; onClose: () => void; customers: CustomerLite[]; assignees: Assignee[]; defaultAssignee?: string;
  onCreate: (payload: any) => void;
}) {
  const { isPhone } = useBp();
  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [chosenCustomer, setChosenCustomer] = useState<CustomerLite | null>(null);
  const createRequestKey = useRef<string | null>(null);
  const createRequestSignature = useRef<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [searchedCustomers, setSearchedCustomers] = useState<CustomerLite[] | null>(null);
  const [customerSearchFailed, setCustomerSearchFailed] = useState(false);
  const [category, setCategory] = useState<string>("general");
  const [channel, setChannel] = useState<Channel>("call");
  const [reason, setReason] = useState("");
  const { selectedFloorId } = useFloorAccess();
  const simpleInbox = ["first-floor", "ground-floor"].includes(selectedFloorId || "");
  const [scope, setScope] = useState<LeadScope>({ interested_floor_ids: [], assignments: [] });
  const [partner, setPartner] = useState<LeadPartner>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) { createRequestKey.current = newLeadRequestKey(); createRequestSignature.current = null; setCustomerMode("existing"); setCustomerId(null); setChosenCustomer(null); setCustomerQuery(""); setNewCustomerName(""); setNewCustomerPhone(""); setCategory("general"); setChannel("call"); setReason(""); setPartner(null); setScope({ interested_floor_ids: selectedFloorId ? [selectedFloorId] : [], assignments: [] }); }
  }, [visible, defaultAssignee, selectedFloorId]);

  useEffect(() => {
    setSearchedCustomers(null); setCustomerSearchFailed(false);
    if (!visible || !customerQuery.trim() || !selectedFloorId) return;
    let active = true;
    const timer = setTimeout(() => {
      void api.get<CustomerLite[]>(`/followups/config/customers?q=${encodeURIComponent(customerQuery.trim())}&limit=20`, { floorId: selectedFloorId })
        .then(rows => { if (active) setSearchedCustomers(rows); })
        .catch(() => { if (active) setCustomerSearchFailed(true); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [visible, customerQuery, selectedFloorId]);
  const matches = useMemo(() => {
    if (searchedCustomers) return searchedCustomers.slice(0, 8);
    const term = customerQuery.trim().toLowerCase();
    if (!term) return customers.slice(0, 8);
    return customers.filter((c) => (c.company || c.name).toLowerCase().includes(term) || c.phone?.includes(term)).slice(0, 8);
  }, [customers, customerQuery, searchedCustomers]);
  const selectedCustomer = chosenCustomer || customers.find((c) => c.id === customerId);

  const submit = async () => {
    if (customerMode === "existing" && !customerId) { toast.error("Choose an existing customer"); return; }
    if (customerMode === "new" && !newCustomerName.trim()) { toast.error("Enter the customer's name"); return; }
    if (customerMode === "new" && !newCustomerPhone.trim()) { toast.error("Enter the customer's mobile number"); return; }
    if (!reason.trim()) { toast.error("Add a reason"); return; }
    if (!scope.interested_floor_ids.length) { toast.error("Choose at least one interested floor"); return; }
    if (scope.interested_floor_ids.some(floorId => !scope.assignments.some(a => a.floor_id === floorId && a.user_id))) { toast.error("Select a team member for each interested floor"); return; }
    const payload = {
      ...(customerMode === "existing" ? { customer_id: customerId } : {
        new_customer_name: newCustomerName.trim(), new_customer_phone: newCustomerPhone.trim(),
      }),
      category, channel, reason: reason.trim(), ...scope,
    };
    const signature = JSON.stringify(payload);
    // Unchanged retries finish the same request. Editing a rejected draft is
    // an intentional new request, rather than reusing a key for other data.
    if (createRequestSignature.current && createRequestSignature.current !== signature) createRequestKey.current = newLeadRequestKey();
    createRequestSignature.current = signature;
    setSaving(true);
    try { await onCreate({ ...payload, request_key: createRequestKey.current }); }
    catch { /* The parent retains the form and displays the API error. */ }
    finally { setSaving(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} variant={isPhone ? "bottom" : "drawer"} title="New Follow-up" subtitle={simpleInbox ? "Add a customer reminder and assign a salesperson." : "Manually add a reminder — the workspace will rank it alongside automated cards."}
      footer={<>
        <Button label="Cancel" variant="secondary" onPress={onClose} size="md" />
        <View style={{ flex: 1 }} />
        <Button label="Create Follow-up" variant="primary" icon="plus" loading={saving} onPress={submit} size="md" testID="create-followup" />
      </>}
    >
      <View style={{ flex: 1 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg, paddingBottom: isPhone ? 120 : spacing.xl }}>
        <FormField label="Customer type">
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Chip label="Existing customer" active={customerMode === "existing"} onPress={() => setCustomerMode("existing")} />
            <Chip label="New customer" active={customerMode === "new"} onPress={() => setCustomerMode("new")} />
          </View>
        </FormField>
        {customerMode === "existing" ? <FormField label="Customer" required>
            <SearchField value={selectedCustomer ? (selectedCustomer.company || selectedCustomer.name) : customerQuery}
              onChangeText={(v) => { setCustomerQuery(v); setCustomerId(null); setChosenCustomer(null); }} placeholder="Search customer…" onClear={() => { setCustomerQuery(""); setCustomerId(null); setChosenCustomer(null); }} />
            {customerSearchFailed ? <Text style={type.caption}>Customer search failed. Edit your search to retry.</Text> : null}
            {!customerId && matches.length ? (
              <View style={{ borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginTop: 6, overflow: "hidden" }}>
                {matches.map((c) => (
                  <Pressable key={c.id} onPress={() => { setCustomerId(c.id); setChosenCustomer(c); setCustomerQuery(""); }}
                    style={{ padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.divider }}>
                    <Text style={type.bodySm}>{c.company || c.name}</Text>
                    {c.phone ? <Text style={type.caption}>{c.phone}</Text> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
        </FormField> : <>
          <FormField label="Customer name" required>
            <TextInput value={newCustomerName} onChangeText={setNewCustomerName} placeholder="Customer name"
              placeholderTextColor={colors.onSurfaceMuted} style={styles.textInput} testID="new-followup-customer-name" />
          </FormField>
          <FormField label="Mobile number" required>
            <TextInput value={newCustomerPhone} onChangeText={setNewCustomerPhone} placeholder="Mobile number"
              placeholderTextColor={colors.onSurfaceMuted} keyboardType="phone-pad" style={styles.textInput} testID="new-followup-customer-mobile" />
          </FormField>
        </>}

        {!simpleInbox ? <FormField label="Type">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {NEW_CATEGORIES.map((c) => (
              <Chip key={c} label={c.charAt(0).toUpperCase() + c.slice(1)} active={category === c} onPress={() => setCategory(c)} />
            ))}
          </View>
        </FormField> : null}

        <FormField label="Preferred channel">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {NEW_CHANNELS.map((c) => (
              <Chip key={c} label={c.charAt(0).toUpperCase() + c.slice(1)} icon={CHANNEL_ICON[c]} active={channel === c} onPress={() => setChannel(c)} />
            ))}
          </View>
        </FormField>

        <FormField label="Reason" required helper="What should the salesperson do and why?">
          <TextInput value={reason} onChangeText={setReason} placeholder="e.g. Customer requested a call back about tile samples" placeholderTextColor={colors.onSurfaceMuted}
            style={styles.textArea} multiline testID="new-followup-reason" />
        </FormField>

        <LeadScopeFields assignmentsRequired value={scope} onChange={setScope}
          customerId={customerMode === "existing" ? customerId || undefined : undefined}
          customerPhone={customerMode === "new" ? newCustomerPhone : undefined} sourceFloorId={selectedFloorId || undefined}
          partner={partner} onPartnerChange={setPartner} />
        </ScrollView>
      </View>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AutomationRulesSheet — the visible automation engine
// ─────────────────────────────────────────────────────────────────────────────
function AutomationRulesSheet({ visible, onClose, rules }: { visible: boolean; onClose: () => void; rules: RuleInfo[] }) {
  return (
    <Sheet visible={visible} onClose={onClose} variant="drawer" title="Automation Rules"
      subtitle="Every card below is generated live by reconciling pre-order quotations, selections and leads — never by hand.">
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
        {rules.map((r) => (
          <Card key={r.rule_type} variant="outlined">
            <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.md }}>
              <View style={{ width: 34, height: 34, borderRadius: radius.sm, backgroundColor: colors.brandTint, alignItems: "center", justifyContent: "center" }}>
                <Feather name={CATEGORY_ICON[r.category] || "flag"} size={16} color={colors.brand} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={type.titleSm}>{r.label}</Text>
                  <Badge label="Generated Automatically" tone="info" size="sm" icon="zap" />
                </View>
                <Text style={type.caption}>{r.description}</Text>
              </View>
              <Badge label={`${r.active_count} active`} tone={r.active_count > 0 ? "brand" : "neutral"} size="sm" />
            </View>
          </Card>
        ))}
        <Text style={[type.caption, { textAlign: "center", marginTop: spacing.sm }]}>
          Manual reminders (via the &quot;+ New Follow-up&quot; button, or a logged call outcome) are the only cards a human creates directly.
        </Text>
      </ScrollView>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  fabWrap: {
    position: "absolute", right: spacing.lg, bottom: 104, gap: spacing.sm,
  },
  fab: {
    width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center",
    shadowColor: "#0B1220", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  swipeAction: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    borderRadius: radius.md, marginVertical: 2,
  },
  swipeText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  textInput: {
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: 14, backgroundColor: colors.surfaceSecondary,
    color: colors.onSurface, fontFamily: type.body.fontFamily, height: 40,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}),
  },
  textArea: {
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: 14, backgroundColor: colors.surfaceSecondary,
    color: colors.onSurface, fontFamily: type.body.fontFamily, minHeight: 90, textAlignVertical: "top",
    ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : {}),
  },
  rankChip: {
    minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5,
    backgroundColor: colors.onSurface, alignItems: "center", justifyContent: "center",
  },
  rankChipText: { fontSize: 10, fontWeight: "800", color: colors.onSurfaceInverse },
  bulkBar: {
    flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.brandBorder,
    padding: spacing.md,
  },
  mobileBulkDock: {
    position: "absolute", left: spacing.md, right: spacing.md, bottom: 0,
  },
  mobileMissionCard: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.md,
    ...elevation.low,
  },
  mobileMissionIcon: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.brandTint,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  mobileMissionTitle: {
    ...type.titleLg,
    fontSize: 22,
    lineHeight: 28,
  },
  mobileMissionPriority: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  mobileCustomerActions: {
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.brandTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.brandBorder,
  },
  mobileCustomerLink: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  mobileRank: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.brandTint,
    alignItems: "center",
    justifyContent: "center",
  },
  mobileRankText: {
    fontSize: 11,
    fontWeight: "800",
    color: colors.brand,
  },
  contextStatMobile: {
    flex: 0,
    minWidth: 0,
    flexBasis: "48%",
    maxWidth: "48%",
    flexShrink: 1,
  },
  contextStats: {
    width: "100%",
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  contextStatsMobile: {
    width: "100%",
  },
  mobileDetailScroll: {
    flex: 1,
    width: "100%",
  },
  mobileDetailContent: {
    width: "100%",
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: 120,
  },
});
