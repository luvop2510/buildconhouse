import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect } from "expo-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Button, Card, Dropdown, EmptyState, IconButton, MobileFilterSection, SearchField, Sheet, SkeletonList } from "@/src/components/ds";
import { FollowupDateInput } from "@/src/components/followups/FollowupDateInput";
import { followupCalendarDay, followupDateLabel, isCalendarDay } from "@/src/components/followups/followupDates";
import { useBp } from "@/src/design/responsive";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { formatDepartmentPhone } from "@/src/utils/phone";

const categories = [
  { value: "today", label: "Today", icon: "sun", tone: colors.warning, tint: colors.warningBg },
  { value: "overdue", label: "Overdue", icon: "alert-circle", tone: colors.error, tint: colors.errorBg },
  { value: "upcoming", label: "Upcoming", icon: "calendar" },
  { value: "won", label: "Won", icon: "check-circle", tone: colors.success, tint: colors.successBg },
  { value: "lost", label: "Lost", icon: "x-circle" },
  { value: "all", label: "All", icon: "layers" },
  { value: "completed", label: "Completed", icon: "check-square" },
  { value: "created", label: "Created quotations", icon: "file-plus" },
  { value: "active", label: "Active follow-ups", icon: "inbox" },
  { value: "outcomes", label: "Won and lost", icon: "pie-chart" },
] as const;
type Category = typeof categories[number]["value"];

const periods = [
  { value: "all_time", label: "All time" },
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "last_week", label: "Last week" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_3_months", label: "Last 3 months" },
  { value: "last_6_months", label: "Last 6 months" },
  { value: "custom", label: "Custom date range" },
] as const;
type Period = typeof periods[number]["value"];

type Choice = { id: string; name: string };
type Amount = { currency: string; value: number };
type Metric = { count: number; customers?: number; amounts: Amount[]; missing_dates?: number; missing_values?: number };
export type PlannerRecord = {
  id: string;
  kind: "followup" | "quotation";
  floor_id: string;
  customer_id?: string | null;
  quotation_id?: string | null;
  quotation_number?: string | null;
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  assigned?: Choice[];
  due_at?: string | null;
  status?: string | null;
  date?: string | null;
  brands?: Choice[];
  currency?: string | null;
  value?: number | null;
  notes?: string | null;
  lost_reason?: string | null;
  doc_type?: string | null;
};
type Customer = {
  key: string;
  customer_id?: string | null;
  customer_name: string;
  customer_phone?: string | null;
  records: PlannerRecord[];
};
type PlannerData = {
  today: string;
  summary: Partial<Record<Category, Metric>>;
  reports_available?: boolean;
  schedule: (Metric & { day: string })[];
  employees: (Choice & { today: number; overdue: number; upcoming: number; amounts: Amount[] })[];
  brands: (Choice & { won: number; lost: number; won_amounts: Amount[]; lost_amounts: Amount[] })[];
  options: { employees: Choice[]; brands: Choice[]; departments: Choice[] };
  items: Customer[];
  page: number;
  page_size: number;
  has_more: boolean;
};

type Filters = {
  category: Category;
  period: Period;
  department: string;
  assignedTo: string;
  brand: string;
  day: string;
  week: number;
  start: string;
  end: string;
  page: number;
};

function defaultFilters(floorId: string): Filters {
  return { category: "today", period: "all_time", department: floorId, assignedTo: "", brand: "", day: "", week: 0, start: "", end: "", page: 1 };
}

const amountFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const weekdayFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long" });
const dayMs = 86_400_000;

function money({ currency, value }: Amount): string {
  return currency === "INR" ? `₹${amountFormat.format(value)}` : `${currency} ${amountFormat.format(value)}`;
}

function amountsLine(amounts?: Amount[]): string | undefined {
  return amounts?.length ? amounts.map(money).join(" · ") : undefined;
}

function recordAmount(record: PlannerRecord) {
  return record.value != null && record.currency ? money({ value: record.value, currency: record.currency }) : undefined;
}

function recordState(record: PlannerRecord, today: string): { label: string; color: string } {
  if (record.status === "won") return { label: "Won", color: colors.success };
  if (record.status === "lost") return { label: "Lost", color: colors.onSurfaceSecondary };
  if (record.kind === "quotation") {
    return { label: record.status === "created" || !record.status ? "Created" : record.status.replaceAll("_", " "), color: colors.onSurfaceSecondary };
  }
  if (record.status === "done" || record.status === "completed") return { label: "Completed", color: colors.success };
  if (record.status === "dismissed") return { label: "Dismissed", color: colors.onSurfaceSecondary };
  if (record.due_at) {
    const date = isCalendarDay(record.due_at) ? record.due_at : followupCalendarDay(record.due_at);
    const days = (Date.parse(today) - Date.parse(date)) / dayMs;
    if (days > 0) return { label: `Overdue by ${days} day${days === 1 ? "" : "s"}`, color: colors.error };
    if (days === 0) return { label: "Due today", color: colors.warning };
    if (days < 0) return { label: "Upcoming", color: colors.onSurfaceSecondary };
  }
  return { label: "Open", color: colors.onSurfaceSecondary };
}

function isMissingPlanner(cause: unknown) {
  const error = cause as { status?: number; detail?: unknown; message?: string };
  return error?.status === 404 && /^(?:follow-?up not found|not found|no route)$/i.test(String(error.detail || error.message || ""));
}

async function fetchPlanner(query: string, category: Category, floorId: string, signal: AbortSignal) {
  const options = { floorId, signal, cacheMs: 0 };
  try {
    return await api.get<PlannerData>(`/followups/planner?${query}`, options);
  } catch (cause) {
    const error = cause as { status?: number; detail?: unknown };
    if (signal.aborted || ["won", "lost", "created", "outcomes"].includes(category) || error.status !== 422
      || error.detail !== "This Follow-ups view exceeds its reporting limit. Narrow the dates, customer or department.") throw cause;
    return api.get<PlannerData>(`/followups/planner?${query}&scope=work`, options);
  }
}

function assigneeLabel(record: PlannerRecord) {
  return record.assigned?.map(assignee => assignee.name).filter(Boolean).join(", ") || record.assigned_to_name || "Unassigned";
}

export function FollowupPlanner({ floorId, floorLabel, refreshVersion, header, queueTools, onUnavailable, onOpenRecord, onOpenCustomer, canOpenRecord, canOpenCustomer }: {
  floorId: string;
  floorLabel?: string;
  refreshVersion: number;
  header?: ReactNode;
  queueTools?: ReactNode;
  onUnavailable: () => void;
  onOpenRecord: (record: PlannerRecord) => void;
  onOpenCustomer: (id: string, floorId: string) => void;
  canOpenRecord: (record: PlannerRecord) => boolean;
  canOpenCustomer: (floorId: string) => boolean;
}) {
  const { isPhone, isDesktop } = useBp();
  const [filters, setFilters] = useState(() => defaultFilters(floorId));
  const [search, setSearch] = useState("");
  const [requestSearch, setRequestSearch] = useState("");
  const [snapshot, setSnapshot] = useState<{ query: string; data: PlannerData } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [localDay, setLocalDay] = useState(() => followupCalendarDay(new Date()));
  const [workloadOpen, setWorkloadOpen] = useState(false);
  const [brandsOpen, setBrandsOpen] = useState(false);
  const [openCustomerKey, setOpenCustomerKey] = useState<string | null>(null);

  const scroll = useRef<ScrollView>(null);
  const resultsTop = useRef(0);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (requestSearch !== search.trim()) {
        setRequestSearch(search.trim());
        setFilters(previous => ({ ...previous, page: 1 }));
      }
    }, 250);
    return () => clearTimeout(timeout);
  }, [requestSearch, search]);

  const rangeReady = filters.period !== "custom" || (
    isCalendarDay(filters.start) && isCalendarDay(filters.end) && filters.start <= filters.end
  );
  const query = useMemo(() => {
    const params = new URLSearchParams({
      category: filters.category, period: filters.period, department: filters.department,
      week: String(filters.week), page: String(filters.page), page_size: "25",
    });
    if (filters.day && filters.category === "upcoming") params.set("day", filters.day);
    if (filters.assignedTo) params.set("assigned_to", filters.assignedTo);
    if (filters.brand) params.set("brand", filters.brand);
    if (requestSearch) params.set("q", requestSearch);
    if (filters.period === "custom") {
      params.set("start", filters.start);
      params.set("end", filters.end);
    }
    return params.toString();
  }, [filters, requestSearch]);
  const requestKey = JSON.stringify([query, refreshVersion, retry, localDay]);

  useFocusEffect(useCallback(() => {
    if (!floorId || !rangeReady) return;
    const controller = new AbortController();
    setFailure(null);
    void fetchPlanner(query, filters.category, floorId, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (!result?.summary || !Array.isArray(result.items)) {
          setFailure({ key: requestKey, message: "The Follow-ups response was incomplete. Try again." });
          return;
        }
        setSnapshot({ query, data: result });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (isMissingPlanner(cause)) { onUnavailable(); return; }
        const detail = (cause as { detail?: unknown })?.detail;
        setFailure({ key: requestKey, message: typeof detail === "string" ? detail : "Try loading Follow-ups again." });
      })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [filters.category, floorId, onUnavailable, query, rangeReady, requestKey]));

  const data = rangeReady && snapshot?.query === query ? snapshot.data : null;
  const options = snapshot?.data.options;
  const error = rangeReady && failure?.key === requestKey ? failure.message : null;
  const today = data?.today || localDay;

  // A workspace left open overnight must pick up the next India business day.
  useFocusEffect(useCallback(() => {
    const advance = () => {
      setLocalDay(followupCalendarDay(new Date()));
      setFilters(previous => previous.day ? { ...previous, day: "", page: 1 } : previous);
    };
    const currentDay = followupCalendarDay(new Date());
    if (currentDay !== localDay) { advance(); return; }
    const nextMidnight = Date.parse(currentDay + "T00:00:00+05:30") + dayMs;
    const timeout = setTimeout(advance, Math.max(1000, nextMidnight - Date.now() + 100));
    return () => clearTimeout(timeout);
  }, [localDay]));

  const update = (changes: Partial<Filters>) => setFilters(previous => ({ ...previous, page: 1, ...changes }));
  const showResults = (changes: Partial<Filters>) => {
    update(changes);
    scroll.current?.scrollTo({ y: Math.max(0, resultsTop.current - spacing.md), animated: false });
  };
  const changeCategory = (category: Category) => update({ category, day: "" });
  const refresh = () => {
    if (!rangeReady) return;
    setRefreshing(true);
    setRetry(value => value + 1);
  };
  const reset = () => {
    setFilters(defaultFilters(floorId));
    setSearch("");
    setRequestSearch("");
  };

  const chosenPeriod = periods.find(period => period.value === filters.period)?.label || "All time";
  const employeeLabel = options?.employees.find(employee => employee.id === filters.assignedTo)?.name || (filters.assignedTo === "unassigned" ? "Unassigned" : "");
  const brandLabel = options?.brands.find(brand => brand.id === filters.brand)?.name;
  const departmentLabel = filters.department === "all" ? "All accessible floors"
    : options?.departments.find(department => department.id === filters.department)?.name || floorLabel || "Current floor";
  const selectedCategory = categories.find(category => category.value === filters.category)!;
  const currentMetric = data?.summary[filters.category];
  const selectedDay = data?.schedule.find(day => day.day === filters.day);
  const visibleMetric = selectedDay || currentMetric;
  const customer = data?.items.find(item => item.key === openCustomerKey);
  const floorName = (id: string) => options?.departments.find(department => department.id === id)?.name || (id === floorId ? floorLabel : undefined);
  const hasFilters = Boolean(search || filters.period !== "all_time" || filters.category !== "today" || filters.day || filters.assignedTo || filters.brand || filters.department !== floorId);
  const departmentOptions = options?.departments || [{ id: floorId, name: floorLabel || "Current floor" }];

  return (
    <>
      <ScrollView ref={scroll} style={{ flex: 1 }} testID="followup-planner" keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.brand} />}
        contentContainerStyle={styles.page}>
        <View style={[styles.content, { paddingHorizontal: isPhone ? spacing.lg : spacing.xl }]}>
          {header}
          <View style={styles.overview}>
            {categories.slice(0, 6).map(category => {
              const metric = data?.summary[category.value];
              const selected = filters.category === category.value && !filters.day;
              return (
                <Pressable key={category.value} accessibilityRole="button" accessibilityState={{ selected }}
                  testID={`planner-card-${category.value}`} onPress={() => changeCategory(category.value)}
                  style={[styles.metric, { flexBasis: isDesktop ? "14%" : isPhone ? "42%" : "29%" },
                    "tint" in category && { backgroundColor: category.tint, borderColor: category.tint },
                    selected && styles.selected]}>
                  <View style={styles.metricLabel}>
                    <Feather accessible={false} name={category.icon} size={16} color={"tone" in category ? category.tone : colors.onSurfaceSecondary} />
                    <Text style={[type.bodySm, { color: "tone" in category ? category.tone : colors.onSurfaceSecondary }]}>{category.label}</Text>
                  </View>
                  <Text style={type.displayMd}>{metric?.count ?? "—"}</Text>
                  {metric ? <Text style={type.caption}>{metric.customers != null ? `${metric.customers} customer${metric.customers === 1 ? "" : "s"}` : category.value === "won" || category.value === "lost" ? "Quotations" : "Records"}</Text> : null}
                  {metric?.amounts?.length ? <Text style={type.numeric}>{amountsLine(metric.amounts)}</Text> : null}
                </Pressable>
              );
            })}
          </View>

          <View style={styles.filterPanel}>
            <SearchField value={search} onChangeText={setSearch} onClear={() => setSearch("")}
              accessibilityLabel="Search customers, phone, or quotation number" placeholder="Search customer, phone, or quotation number" testID="planner-search" />
            <MobileFilterSection testID="planner-filter" initiallyExpanded={!isPhone}>
              <View style={styles.filterControls}>
                <Picker label="Category" value={selectedCategory.label} choices={categories} onChange={changeCategory} testID="planner-category" />
                <Picker label="Period" value={chosenPeriod} choices={periods} onChange={period => update({ period })} testID="planner-period" />
                <Picker label="Assigned to" value={employeeLabel || "All employees"} choices={[
                  { value: "", label: "All employees" },
                  ...((options?.employees || []).some(employee => employee.id === "unassigned") ? [] : [{ value: "unassigned", label: "Unassigned" }]),
                  ...(options?.employees || []).map(employee => ({ value: employee.id, label: employee.name })),
                ]} onChange={assignedTo => update({ assignedTo })} testID="planner-employee" />
                <Picker label="Company" value={brandLabel || "All companies"} choices={[
                  { value: "", label: "All companies" },
                  ...(options?.brands || []).map(brand => ({ value: brand.id, label: brand.name })),
                ]} onChange={brand => update({ brand })} testID="planner-company" />
                <Picker label="Department" value={departmentLabel} choices={[
                  { value: "all", label: "All accessible floors" },
                  ...departmentOptions.map(department => ({ value: department.id, label: department.name })),
                ]} onChange={department => update({ department })} testID="planner-department" />
              </View>
              {filters.period === "custom" ? (
                <View style={styles.filterControls}>
                  <View style={styles.dateField}><FollowupDateInput label="Start date" value={filters.start} onChange={start => update({ start })} testID="planner-start-date" /></View>
                  <View style={styles.dateField}><FollowupDateInput label="End date" value={filters.end} min={isCalendarDay(filters.start) ? filters.start : undefined}
                    onChange={end => update({ end })} testID="planner-end-date" /></View>
                </View>
              ) : null}
            </MobileFilterSection>
            <View style={styles.inline}>
              <Text style={[type.bodySm, { flex: 1 }]}>{[selectedCategory.label, chosenPeriod, departmentLabel, employeeLabel, brandLabel,
                filters.day ? followupDateLabel(filters.day) : null].filter(Boolean).join(" · ")}</Text>
              {hasFilters ? <Button label="Reset filters" variant="ghost" size="md" testID="planner-reset" onPress={reset} /> : null}
            </View>
          </View>
          {data?.reports_available === false ? <Text style={type.bodySm}>
            Quotation reports exceed the current scope. Choose a narrower period, customer or department to load them.
          </Text> : null}

          {filters.category === "upcoming" && rangeReady ? (
            <View style={styles.schedule}>
              <View style={styles.inline}>
                <Text accessibilityRole="header" style={[type.titleMd, { flex: 1 }]}>Upcoming schedule</Text>
                <IconButton icon="chevron-left" tone="surface" size={44} accessibilityLabel="Previous week" testID="planner-previous-week"
                  disabled={filters.week === 0} onPress={() => update({ week: Math.max(0, filters.week - 1), day: "" })} />
                <IconButton icon="chevron-right" tone="surface" size={44} accessibilityLabel="Next week" testID="planner-next-week"
                  onPress={() => update({ week: filters.week + 1, day: "" })} />
              </View>
              <ScrollView horizontal keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.sm }}>
                {(data?.schedule || []).map(day => (
                  <Pressable key={day.day} testID={`planner-day-${day.day}`} accessibilityRole="button"
                    accessibilityState={{ selected: filters.day === day.day }}
                    onPress={() => update({ day: filters.day === day.day ? "" : day.day })}
                    style={[styles.day, filters.day === day.day && styles.selected]}>
                    <Text style={type.titleSm}>{weekdayFormat.format(new Date(day.day + "T00:00:00+05:30"))}</Text>
                    <Text style={type.bodySm}>{followupDateLabel(day.day)}</Text>
                    <Text style={type.caption}>{day.count} follow-up{day.count === 1 ? "" : "s"}</Text>
                    {day.amounts?.length ? <Text style={type.numeric}>{amountsLine(day.amounts)}</Text> : null}
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <View style={{ gap: spacing.md }} onLayout={event => { resultsTop.current = event.nativeEvent.layout.y; }}>
            <View style={styles.inline}>
              <Text accessibilityRole="header" style={[type.titleLg, { flex: 1 }]}>
                {filters.day ? followupDateLabel(filters.day) : selectedCategory.label === "All" ? "All records" : selectedCategory.label}
              </Text>
              {visibleMetric ? <View testID="planner-result-metric" style={{ alignItems: "flex-end", gap: spacing.xs }}>
                <Text style={type.caption}>{visibleMetric.count} {["created", "won", "lost"].includes(filters.category) ? "quotation" : "record"}{visibleMetric.count === 1 ? "" : "s"}</Text>
                {visibleMetric.amounts?.length ? <Text style={type.numeric}>{amountsLine(visibleMetric.amounts)}</Text> : null}
              </View> : null}
            </View>
            {Boolean(visibleMetric?.missing_dates) ? <Text style={type.bodySm}>
              {visibleMetric?.missing_dates} {visibleMetric?.missing_dates === 1 ? "record has" : "records have"} no saved reporting date.
            </Text> : null}
            {Boolean(visibleMetric?.missing_values) ? <Text style={type.bodySm}>
              Quotation value is unavailable for {visibleMetric?.missing_values} {visibleMetric?.missing_values === 1 ? "record" : "records"}.
            </Text> : null}
            {error ? <Card><EmptyState icon="alert-circle" title="Follow-ups are unavailable" subtitle={error}
              action={<Button label="Try again" icon="rotate-cw" onPress={refresh} />} /></Card>
              : !rangeReady ? <Card><Text style={type.body}>Choose a valid start and end date.</Text></Card>
              : !data ? <SkeletonList rows={3} />
              : data.items.length === 0 ? <Card><EmptyState icon="search" title="No matching records" subtitle="Change the filters to see other customers." /></Card>
              : <View style={styles.results}>
                {data.items.map(item => {
                  const first = item.records[0];
                  const state = first && recordState(first, today);
                  return (
                    <Pressable key={item.key} testID={`planner-customer-${item.key}`} accessibilityRole="button" onPress={() => setOpenCustomerKey(item.key)}
                      style={({ pressed }) => [styles.customerRow, pressed && { backgroundColor: colors.surfaceTertiary }]}>
                      <View style={{ flex: 1, gap: spacing.xs }}>
                        <Text style={type.titleMd}>{item.customer_name}</Text>
                        <Text style={type.bodySm}>
                          {[item.customer_phone ? formatDepartmentPhone(item.customer_phone, first?.floor_id) : null,
                            first?.quotation_number, first ? assigneeLabel(first) : null, first?.brands?.map(brand => brand.name).join(", ")].filter(Boolean).join(" · ")}
                        </Text>
                        {state ? <Text style={[type.captionStrong, { color: state.color }]}>{[state.label, first.due_at ? followupDateLabel(first.due_at) : first.date ? followupDateLabel(first.date) : null, item.records.length > 1 ? `${item.records.length} records` : null].filter(Boolean).join(" · ")}</Text> : null}
                      </View>
                      {item.records.length === 1 && first && recordAmount(first) ? <Text style={[type.numeric, { maxWidth: "38%" }]}>{recordAmount(first)}</Text> : null}
                      <Feather accessible={false} name="chevron-right" size={18} color={colors.onSurfaceMuted} />
                    </Pressable>
                  );
                })}
              </View>}
            {data && (data.page > 1 || data.has_more) ? (
              <View style={styles.pageNav}>
                {data.page > 1 ? <Button label="Previous page" variant="secondary" size="md" onPress={() => update({ page: data.page - 1 })} /> : null}
                <Text style={type.caption}>Page {data.page}</Text>
                {data.has_more ? <Button label="Next page" variant="secondary" size="md" onPress={() => update({ page: data.page + 1 })} /> : null}
              </View>
            ) : null}
          </View>

          {data ? (
            <View style={{ gap: spacing.sm }}>
              <Disclosure label="Employee workload" open={workloadOpen} onPress={() => setWorkloadOpen(open => !open)} testID="planner-workload-toggle">
                {data.employees.length ? data.employees.map(employee => (
                  <View key={employee.id} style={styles.secondaryRow}>
                    <Button label={[employee.name, amountsLine(employee.amounts)].filter(Boolean).join(" · ")}
                      variant="ghost" size="md" onPress={() => showResults({ category: "active", assignedTo: employee.id, day: "" })}
                      testID={`planner-workload-${employee.id}`} />
                    <View style={styles.filterControls}>
                      {categories.slice(0, 3).map(category => {
                        const bucket = category.value as "today" | "overdue" | "upcoming";
                        return <Button key={bucket} label={`${category.label} ${employee[bucket]}`} variant="secondary" size="md"
                          testID={`planner-workload-${employee.id}-${bucket}`} onPress={() => showResults({ category: bucket, assignedTo: employee.id, day: "" })} />;
                      })}
                    </View>
                  </View>
                )) : <Text style={type.bodySm}>No assigned workload in this view.</Text>}
              </Disclosure>
              {data.reports_available !== false ? <Disclosure label="Company performance" open={brandsOpen} onPress={() => setBrandsOpen(open => !open)} testID="planner-brand-toggle">
                {data.brands.length ? data.brands.map(brand => (
                  <View key={brand.id} style={styles.secondaryRow}>
                    <Button label={brand.name} variant="ghost" size="md" onPress={() => showResults({ category: "outcomes", brand: brand.id, day: "" })}
                      testID={`planner-brand-${brand.id}`} />
                    <View style={styles.filterControls}>
                      <Button label={[`Won ${brand.won}`, amountsLine(brand.won_amounts)].filter(Boolean).join(" · ")} variant="secondary" size="md"
                        testID={`planner-brand-${brand.id}-won`} onPress={() => showResults({ category: "won", brand: brand.id, day: "" })} />
                      <Button label={[`Lost ${brand.lost}`, amountsLine(brand.lost_amounts)].filter(Boolean).join(" · ")} variant="secondary" size="md"
                        testID={`planner-brand-${brand.id}-lost`} onPress={() => showResults({ category: "lost", brand: brand.id, day: "" })} />
                    </View>
                  </View>
                )) : <Text style={type.bodySm}>No brand outcomes match these filters.</Text>}
              </Disclosure> : null}
            </View>
          ) : null}
          {queueTools}
        </View>
      </ScrollView>

      <Sheet visible={!!customer} onClose={() => setOpenCustomerKey(null)}
        variant={isPhone ? "bottom" : "modal"} width={isPhone ? undefined : 660} title={customer?.customer_name || "Customer"}>
        {customer ? (
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={styles.sheetContent} testID="planner-customer-detail">
            {customer.customer_phone ? <Text style={type.body}>{formatDepartmentPhone(customer.customer_phone, customer.records[0]?.floor_id)}</Text> : null}
            {customer.records.map(record => {
              const state = recordState(record, today);
              const customerId = record.customer_id || (record.floor_id === floorId ? customer.customer_id : undefined);
              return (
                <View key={`${record.floor_id}:${record.kind}:${record.id}`} style={styles.record}>
                  <View style={styles.inline}>
                    <Text style={[type.titleMd, { flex: 1 }]}>{record.quotation_number || (record.kind === "followup" ? "Follow-up" : "Quotation")}</Text>
                    {recordAmount(record) ? <Text style={type.numeric}>{recordAmount(record)}</Text> : null}
                  </View>
                  <Text style={[type.captionStrong, { color: state.color }]}>{state.label}</Text>
                  {record.due_at ? <Text style={type.bodySm}>Due {followupDateLabel(record.due_at)}</Text> : record.date ? <Text style={type.bodySm}>{followupDateLabel(record.date)}</Text> : null}
                  <Text style={type.bodySm}>{[floorName(record.floor_id), assigneeLabel(record), record.brands?.map(brand => brand.name).join(", ")].filter(Boolean).join(" · ")}</Text>
                  {record.notes ? <Text style={type.body}>Note · {record.notes}</Text> : null}
                  {record.lost_reason ? <Text style={type.body}>Loss reason · {record.lost_reason}</Text> : null}
                  <View style={styles.filterControls}>
                    {canOpenRecord(record) ? <Button label={record.kind === "followup" ? "Open follow-up" : "Open quotation"} size="md" variant="secondary"
                      testID={`planner-open-${record.id}`} onPress={() => { setOpenCustomerKey(null); onOpenRecord(record); }} /> : null}
                    {customerId && canOpenCustomer(record.floor_id) ? <Button label="Open customer" size="md" variant="ghost"
                      onPress={() => { setOpenCustomerKey(null); onOpenCustomer(customerId, record.floor_id); }} /> : null}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        ) : null}
      </Sheet>
    </>
  );
}

function Picker<T extends string>({ label, value, choices, onChange, testID }: {
  label: string; value: string; choices: readonly { value: T; label: string }[]; onChange: (value: T) => void; testID: string;
}) {
  return (
    <Dropdown label={`${label} · ${value}`} testID={testID}
      items={choices.map(choice => ({ label: choice.label, icon: choice.label === value ? "check" : undefined, testID: `${testID}-${choice.value || "all"}`, onPress: () => onChange(choice.value) }))} />
  );
}

function Disclosure({ label, open, onPress, testID, children }: {
  label: string; open: boolean; onPress: () => void; testID: string; children: ReactNode;
}) {
  return (
    <View style={styles.disclosure}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} testID={testID} onPress={onPress} style={styles.disclosureButton}>
        <Text style={[type.titleMd, { flex: 1 }]}>{label}</Text>
        <Feather accessible={false} name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.onSurfaceSecondary} />
      </Pressable>
      {open ? <View style={styles.disclosureContent}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingTop: spacing.md, paddingBottom: spacing.xxl },
  content: { width: "100%", maxWidth: 1280, alignSelf: "center", gap: spacing.lg },
  overview: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  metric: {
    flexGrow: 1, minWidth: 0, minHeight: 96, padding: spacing.md, gap: spacing.xs,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary,
  },
  selected: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  metricLabel: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.xs },
  filterPanel: { gap: spacing.sm },
  filterControls: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  dateField: { flexBasis: 152, flexGrow: 1, maxWidth: 300 },
  inline: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  schedule: { gap: spacing.sm },
  day: {
    minWidth: 136, maxWidth: 200, padding: spacing.md, gap: spacing.xs,
    borderWidth: 1, borderRadius: radius.sm, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
  results: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
  customerRow: {
    minHeight: 72, flexDirection: "row", gap: spacing.md, alignItems: "center", padding: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  pageNav: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: spacing.sm },
  disclosure: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
  disclosureButton: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md },
  disclosureContent: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  secondaryRow: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingVertical: spacing.sm, gap: spacing.xs },
  sheetContent: { padding: spacing.lg, gap: spacing.lg },
  record: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingVertical: spacing.md, gap: spacing.sm },
});
