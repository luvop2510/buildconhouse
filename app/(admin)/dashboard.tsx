import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";

import { api } from "@/src/api/client";
import { IconButton as RefreshButton } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { Button, Hairline, IconButton, Money, Skeleton, Surface, Txt } from "@/src/design/components";
import { useBp } from "@/src/design/responsive";
import { color, radius, space } from "@/src/design/tokens";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import type { TodayData, TodayOverview, TodayTask } from "@/src/api/today";

const DEPARTMENTS: Record<string, string> = {
  payments: "Payments", godown_stock: "Godown stock", orders: "Orders & dispatches", followups: "Follow-ups", walkins: "Walk-ins", quotations: "Quotations", tiles: "Tiles",
  purchases: "Purchases", kitchen_projects: "Kitchen", furniture_quotations: "Furniture",
};
const DESTINATIONS: Record<string, string> = {
  payments: "/(admin)/payments", godown_stock: "/(admin)/godown-stock", orders: "/(admin)/tiles/orders", followups: "/(admin)/followups", walkins: "/(admin)/walkins", quotations: "/(admin)/quotations",
  tiles: "/(admin)/tiles", purchases: "/(admin)/purchases", kitchen_projects: "/(admin)/kitchen",
  furniture_quotations: "/(admin)/notebook/furniture-quotations", notebook_quotations: "/(admin)/notebook/quotation-follow-up",
};
const dateLabel = (value: string) => new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
}).format(new Date(value));

function TaskRow({ task, open, complete }: { task: TodayTask; open: () => void; complete?: () => void }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.x2 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${task.title}. ${task.status}. Open task`}
      testID={`today-task-${task.resource}-${task.id}`} onPress={open}
      style={({ pressed, hovered }: any) => ({ flex: 1, minWidth: 0, minHeight: 72, paddingVertical: space.x3,
        paddingHorizontal: space.x2, borderRadius: radius.md, gap: space.x1, backgroundColor: pressed || hovered ? color.hoverWash : "transparent" })}>
      <Txt v="rowTitle">{task.title}</Txt>
      <Txt v="sub" tone="soft">{DEPARTMENTS[task.resource] || task.resource.replace(/_/g, " ")} · {task.status}</Txt>
      {task.due_at ? <Txt v="caption" tone="soft">{dateLabel(task.due_at)}</Txt> : null}
      {task.assignee_name ? <Txt v="caption" tone="soft">Assigned to {task.assignee_name}</Txt> : null}
      {task.progress != null ? <View style={{ gap: space.x1 }}>
        <Txt v="caption" tone="soft">{task.progress}% recorded progress</Txt>
        <View accessibilityRole="progressbar" accessibilityLabel={`${task.title} progress`} accessibilityValue={{ min: 0, max: 100, now: task.progress }} style={{ height: 4, borderRadius: 2, backgroundColor: color.sunkenDeep }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: color.focus, width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
        </View>
      </View> : null}
    </Pressable>
    {complete ? <IconButton icon="check" label={`Mark ${task.title} done`} size={44} onPress={complete} /> : <Feather name="chevron-right" size={16} color={color.inkSoft} accessible={false} />}
  </View>;
}

/** The workday is one floor-local read. Sales analysis belongs to Sales Data. */
export default function Today() {
  const router = useRouter();
  const { staff } = useAuth();
  const { selectedFloorId, floors } = useFloorAccess();
  const { isPhone, isDesktop, gutter } = useBp();
  const canUpdateFollowups = useActionAccess("followups", "update");
  const assignedKitchenWork = selectedFloorId === KITCHEN_FLOOR_ID && !["owner", "admin", "manager"].includes(staff?.role || "");
  const accessVersion = JSON.stringify([staff?.role, staff?.custom_access, staff?.access_profile, staff?.access_grants]);
  const scope = useMemo(() => ({ floorId: selectedFloorId, staffId: staff?.id, accessVersion, pending: new Set<string>(), confirmed: new Set<string>(), revision: 0 }),
    [selectedFloorId, staff?.id, accessVersion]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [state, setState] = useState<{ scope: typeof scope; data: TodayData | null; error: string | null; refreshing: boolean }>({ scope, data: null, error: null, refreshing: false });
  const [overviewState, setOverviewState] = useState<{ scope: typeof scope; loading: boolean; error: string | null }>({scope, loading: false, error: null});
  const [pending, setPending] = useState({ scope, ids: [] as string[] });
  const requestVersion = useRef(0);
  const data = state.scope === scope ? state.data : null;
  const error = state.scope === scope ? state.error : null;
  const refreshing = state.scope === scope && state.refreshing;
  const pendingIds = pending.scope === scope ? pending.ids : [];
  const queue = data?.tasks.filter(task => task.resource !== "followups" || (!pendingIds.includes(task.id) && !scope.confirmed.has(task.id))) ?? null;

  const load = useCallback(async (isRefresh = false) => {
    if (!scope.floorId || !scope.staffId) return;
    const version = ++requestVersion.current;
    const revision = scope.revision;
    const current = () => mounted.current && activeScope.current === scope && version === requestVersion.current && revision === scope.revision;
    setOverviewState({scope, loading: false, error: null});
    setState(previous => ({ scope, data: previous.scope === scope ? previous.data : null, error: null, refreshing: isRefresh }));
    try {
      const value = await api.get<TodayData>("/dashboard/today", { floorId: scope.floorId, cacheMs: 0 });
      if (current()) {
        if (value.floor_id !== scope.floorId) throw new Error("The workspace changed. Refresh to load this floor.");
        for (const id of scope.confirmed) {
          if (!value.tasks.some(task => task.resource === "followups" && task.id === id)) scope.confirmed.delete(id);
        }
        setState({ scope, data: value, error: null, refreshing: false });
        if (value.full_floor_access) {
          setOverviewState({scope, loading: true, error: null});
          try {
            const overview = await api.get<TodayOverview>("/dashboard/today/overview", {floorId:scope.floorId, cacheMs:0});
            if (current()) {
              if (overview.floor_id !== scope.floorId) throw new Error("Refresh to load this floor’s totals.");
              setState(previous => previous.scope === scope && previous.data ? {...previous, data:{...previous.data, ...overview}} : previous);
              setOverviewState({scope, loading:false, error:null});
            }
          } catch (cause: any) {
            if (current()) setOverviewState({scope, loading:false, error:cause?.detail || cause?.message || "Floor totals are unavailable. Refresh to try again."});
          }
        }
      }
    } catch (cause: any) {
      if (mounted.current && activeScope.current === scope && version === requestVersion.current) {
        setState(previous => ({ scope, data: previous.scope === scope ? previous.data : null, error: cause?.detail || cause?.message || "Could not load floor work. Try again.", refreshing: false }));
      }
    }
  }, [scope]);
  useFocusEffect(useCallback(() => { void load(); return () => { requestVersion.current += 1; }; }, [load]));

  const complete = (task: TodayTask) => {
    const current = () => mounted.current && activeScope.current === scope;
    if (!current() || !scope.floorId || !canUpdateFollowups || task.resource !== "followups" || scope.pending.has(task.id) || scope.confirmed.has(task.id)) return;
    scope.pending.add(task.id);
    setPending({ scope, ids: [...scope.pending] });
    void (async () => {
      try {
        await api.post(`/followups/${task.id}/complete`, {}, { floorId: scope.floorId });
        if (!current()) return;
        scope.revision += 1;
        scope.confirmed.add(task.id);
        setState(previous => previous.scope === scope && previous.data ? { ...previous, data: { ...previous.data, tasks: previous.data.tasks.filter(row => row.resource !== "followups" || row.id !== task.id) } } : previous);
        toast.success(`${task.title} — marked done`);
        void load(true);
      } catch {
        if (current()) toast.error("Could not confirm completion. Follow-up restored; refresh to check or try again.");
      } finally {
        scope.pending.delete(task.id);
        if (current()) setPending({ scope, ids: [...scope.pending] });
      }
    })();
  };
  const loading = queue === null && !error;
  const floorName = data?.floor_name || floors?.find(floor => floor.id === selectedFloorId)?.name || "Your floor";
  const summary = data?.task_summary;
  const visibleTasks = queue?.slice(0, 16) || [];
  const openTask = (task: TodayTask) => {
    const destination = DESTINATIONS[task.resource];
    if (!destination) return;
    const id = encodeURIComponent(task.id);
    const target = task.resource === "quotations" ? `/(admin)/quotations/${id}`
      : task.resource === "tiles" && [`/tiles/quotation?id=${id}`, `/tiles/selection?id=${id}`].includes(task.href) ? `/(admin)${task.href}`
      : task.resource === "walkins" ? `/(admin)/walkins/${id}`
      : task.resource === "kitchen_projects" && /^(lead|visit|cad|design|quotation|order|production|installation|completed)$/.test(task.status)
        ? `/(admin)/kitchen/${id}/stages/${task.status}` : destination;
    router.push(target as never);
  };

  return <ScrollView testID="today-page" style={{ flex: 1, backgroundColor: color.canvas }}
    contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: space.x4, paddingBottom: space.x8 }}
    showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={color.inkSoft} />}>
    <View style={{ width: "100%", maxWidth: 1200, alignSelf: "center", gap: space.x4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.x3 }}>
        <View style={{ flex: 1, minWidth: 0, gap: space.x1 }}>
          <Txt v="heading" style={{ fontSize: isPhone ? 24 : 28, lineHeight: isPhone ? 32 : 36 }}>Today</Txt>
          <Txt v="sub" tone="soft">{floorName} · {new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date())}</Txt>
        </View>
        <RefreshButton icon="refresh-cw" accessibilityLabel={refreshing ? "Updating floor work" : "Refresh floor work"} disabled={refreshing} onPress={() => void load(true)} />
      </View>
      {error ? <Surface><View accessibilityRole="alert" style={{ gap: space.x2 }}><Txt v="bodyMid">{error}</Txt>{data ? <Txt v="sub" tone="soft">Showing the last loaded work. Refresh to check the latest status.</Txt> : null}<Button label="Retry floor work" variant="secondary" onPress={() => void load(true)} /></View></Surface> : null}
      <Surface pad={0}>
        <View testID="today-task-summary" style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {([['Open tasks', summary?.open], ['Due today', summary?.due_today], ['Overdue', summary?.overdue], ['Completed today', summary?.completed_today]] as const).map(([label, value], i) => <View key={label} style={{ width: isPhone ? "50%" : "25%", padding: space.x4, gap: space.x1, borderLeftWidth: i % (isPhone ? 2 : 4) ? 1 : 0, borderTopWidth: isPhone && i > 1 ? 1 : 0, borderColor: color.line }}>
            <Txt v="caption" tone="soft">{label}</Txt>{value == null ? error ? <Txt v="sub" tone="soft">Unavailable</Txt> : <Skeleton w={48} h={28} /> : <Txt v="moneyLg">{value.toLocaleString("en-IN")}</Txt>}
          </View>)}
        </View>
      </Surface>
      <View style={{ flexDirection: isDesktop && data?.full_floor_access ? "row" : "column", alignItems: "stretch", gap: space.x4 }}>
        <View style={{ flex: isDesktop ? 2 : undefined, minWidth: 0 }}><Surface style={{ gap: space.x3 }}>
          <Txt v="heading">Scheduled work & tasks</Txt>
          <Txt v="sub" tone="soft">{assignedKitchenWork ? "Your assigned Kitchen tasks and recorded progress" : data?.full_floor_access ? "Current work across this floor’s departments" : "Tasks and progress for your departments"}</Txt>
          {pendingIds.length ? <View accessibilityLiveRegion="polite"><Txt v="sub" tone="soft">Saving {pendingIds.length} follow-up{pendingIds.length === 1 ? "" : "s"}…</Txt></View> : null}
          {loading ? <View accessibilityLabel="Loading floor tasks" style={{ gap: space.x4 }}><Skeleton h={64} /><Skeleton h={64} /><Skeleton h={64} /></View> : visibleTasks.length ? visibleTasks.map((task, i) => <View key={`${task.resource}:${task.id}`}>{i ? <Hairline /> : null}<TaskRow task={task} open={() => openTask(task)} complete={task.resource === "followups" && canUpdateFollowups ? () => complete(task) : undefined} /></View>) : <View style={{ paddingVertical: space.x6, gap: space.x2 }}><Txt v="bodyMid">{error ? "Tasks are unavailable." : assignedKitchenWork ? "No open Kitchen tasks assigned to you." : "No open tasks recorded."}</Txt><Txt v="sub" tone="soft">{error ? "Retry to load your work." : assignedKitchenWork ? "Tasks appear here when the owner assigns the current stage to you." : "Scheduled work will appear here when it is recorded in your departments."}</Txt></View>}
          {(queue && queue.length > visibleTasks.length) || data?.truncated ? <Txt v="sub" tone="soft">Showing the next {visibleTasks.length} tasks. Open a department below for its complete list.</Txt> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.x2 }}>{data?.resources.filter(resource => DESTINATIONS[resource]).map(resource => <Button key={resource} label={`Open ${DEPARTMENTS[resource] || resource.replace(/_/g, " ")}`} variant="ghost" size="sm" onPress={() => router.push(DESTINATIONS[resource] as never)} />)}</View>
        </Surface></View>
        {data?.full_floor_access ? <View testID="today-floor-overview" style={{ flex: isDesktop ? 1 : undefined, minWidth: 0, gap: space.x4 }}>
          {overviewState.scope === scope && overviewState.loading ? <Surface><Txt v="sub" tone="soft">Updating floor totals…</Txt></Surface> : null}
          {overviewState.scope === scope && overviewState.error ? <Surface><Txt v="sub" tone="soft">{overviewState.error}</Txt><Button label="Retry floor totals" variant="ghost" onPress={() => void load(true)} /></Surface> : null}
          {data.unavailable_sections?.length ? <Surface><Txt v="sub" tone="soft">Some floor totals are unavailable. Your tasks remain ready.</Txt><Button label="Retry floor totals" variant="ghost" onPress={() => void load(true)} /></Surface> : null}
          {data.payments ? <Surface style={{ gap: space.x3 }}>
            <Txt v="heading">Floor payments</Txt>
            <Txt v="caption" tone="soft">Received today · INR</Txt><Money value={data.payments.received_today} size="lg" />
            <Txt v="sub" tone="soft">{data.payments.receipt_count} recorded receipt{data.payments.receipt_count === 1 ? "" : "s"} · {floorName}</Txt>
            <Button label="Open payments" variant="secondary" onPress={() => router.push("/(admin)/payments" as never)} />
          </Surface> : null}
          {data.workflows.length ? <Surface style={{ gap: space.x3 }}><Txt v="heading">Department progress</Txt>
            {data.workflows.map((workflow, i) => <View key={workflow.resource} style={{ gap: space.x2 }}>{i ? <Hairline /> : null}<View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.x2 }}><Txt v="rowTitle" style={{ flex: 1 }}>{workflow.label}</Txt><Txt v="num">{workflow.total.toLocaleString("en-IN")}</Txt></View>{workflow.statuses.map(row => <View key={row.status} style={{ flexDirection: "row", justifyContent: "space-between", gap: space.x2 }}><Txt v="sub" tone="soft" style={{ flex: 1 }}>{row.status}</Txt><Txt v="num">{row.count.toLocaleString("en-IN")}</Txt></View>)}</View>)}
          </Surface> : null}
        </View> : null}
      </View>
      {data ? <Txt v="caption" tone="soft">Updated {dateLabel(data.generated_at)} IST · Current work on {floorName}</Txt> : null}
    </View>
  </ScrollView>;
}
