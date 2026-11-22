import Feather from "@expo/vector-icons/Feather";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Button, Dropdown, IconButton, MobileFilterSection, SearchField } from "@/src/components/ds";
import { FollowupDateInput } from "@/src/components/followups/FollowupDateInput";
import { followupDateLabel, isCalendarDay } from "@/src/components/followups/followupDates";
import { useBp } from "@/src/design/responsive";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

const categories = [
  { value: "today", label: "Today", tone: colors.warning },
  { value: "overdue", label: "Overdue", tone: colors.error },
  { value: "upcoming", label: "Upcoming" },
  { value: "won", label: "Won", tone: colors.success },
  { value: "lost", label: "Lost" },
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "created", label: "Created quotations" },
  { value: "active", label: "Active follow-ups" },
  { value: "outcomes", label: "Won and lost" },
] as const;
export type PlannerCategory = typeof categories[number]["value"];

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

export type PlannerFilters = {
  category: PlannerCategory;
  period: typeof periods[number]["value"];
  department: string;
  brand: string;
  day: string;
  week: number;
  start: string;
  end: string;
};
export const defaultPlannerFilters: PlannerFilters = {
  category: "all", period: "all_time", department: "", brand: "", day: "", week: 0, start: "", end: "",
};

type Choice = { id: string; name: string };
type Amount = { currency: string; value: number };
type Metric = { count: number; customers?: number; amounts: Amount[]; missing_dates?: number; missing_values?: number };
export type PlannerRecord<T = never> = {
  id: string;
  kind: "followup" | "quotation";
  floor_id: string;
  customer_id?: string | null;
  quotation_id?: string | null;
  quotation_number?: string | null;
  status?: string | null;
  date?: string | null;
  brands?: Choice[];
  currency?: string | null;
  value?: number | null;
  lost_reason?: string | null;
  doc_type?: string | null;
  task?: T;
};
export type PlannerCustomer<T = never> = {
  key: string;
  customer_name: string;
  customer_phone?: string | null;
  records: PlannerRecord<T>[];
};
export type PlannerData<T = never> = {
  today: string;
  operational?: boolean;
  summary: Partial<Record<PlannerCategory, Metric>>;
  reports_available?: boolean;
  schedule: (Metric & { day: string })[];
  employees: (Choice & { today: number; overdue: number; upcoming: number; amounts: Amount[] })[];
  brands: (Choice & { won: number; lost: number; won_amounts: Amount[]; lost_amounts: Amount[];
    today?: number; overdue?: number; upcoming?: number; workload_amounts?: Amount[] })[];
  options: { employees: Choice[]; brands: Choice[]; departments: Choice[] };
  items: PlannerCustomer<T>[];
  page: number;
  page_size: number;
  has_more: boolean;
};
export type FollowupReport = Omit<PlannerData, "items">;

export function isMissingPlanner(cause: unknown) {
  const error = cause as { status?: number; detail?: unknown; message?: string };
  return error?.status === 404 && /^(?:follow-?up not found|not found|no route)$/i.test(String(error.detail || error.message || ""));
}

export async function fetchPlanner<T>(params: URLSearchParams, category: PlannerCategory, floorId: string, signal: AbortSignal) {
  const options = { floorId, signal, cacheMs: 0 };
  const path = `/followups/planner?${params}`;
  try {
    return await api.get<PlannerData<T>>(path, options);
  } catch (cause) {
    const error = cause as { status?: number; detail?: unknown };
    if (signal.aborted || ["won", "lost", "created", "outcomes"].includes(category) || error.status !== 422
      || error.detail !== "This Follow-ups view exceeds its reporting limit. Narrow the dates, customer or department.") throw cause;
    return api.get<PlannerData<T>>(`${path}&scope=work`, options);
  }
}

const amountFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const weekdayFormat = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long" });

export function amountsLine(amounts?: Amount[]) {
  return amounts?.length ? amounts.map(({ currency, value }) =>
    `${currency === "INR" ? "₹" : currency + " "}${amountFormat.format(value)}`).join(" · ") : undefined;
}

const workspaces = [
  { value: "all", label: "All activity" },
  { value: "visit_showroom", label: "Visit Showroom" },
  { value: "selection", label: "Tile selections" },
  { value: "quotation_tiles", label: "Tile quotations" },
] as const;
export type FollowupWorkspace = typeof workspaces[number]["value"];

export function FollowupFilters({ data, filters, update, floorId, floorLabel, workspace, onWorkspace, search, onSearch,
  owner, onEmployee, onReset, hasLegacyFilters, tools, extraFilters,
}: {
  data: FollowupReport | null;
  filters: PlannerFilters;
  update: (changes: Partial<PlannerFilters>) => void;
  floorId: string;
  floorLabel?: string;
  workspace: FollowupWorkspace;
  onWorkspace: (value: FollowupWorkspace) => void;
  search: string;
  onSearch: (value: string) => void;
  owner: string;
  onEmployee: (value: string) => void;
  onReset: () => void;
  hasLegacyFilters: boolean;
  tools?: ReactNode;
  extraFilters?: ReactNode;
}) {
  const { isPhone } = useBp();
  const [scheduleOpen, setScheduleOpen] = useState<boolean | null>(null);
  const showSchedule = scheduleOpen ?? (filters.category === "upcoming" || !!filters.day);
  const changeStatus = (category: PlannerCategory) => {
    setScheduleOpen(null);
    update({ category, day: "" });
  };
  const status = categories.find(choice => choice.value === filters.category)?.label;
  const period = periods.find(choice => choice.value === filters.period)?.label;
  const options = data?.options;
  const departments = options?.departments || [{ id: floorId, name: floorLabel || "Current department" }];
  const department = filters.department || floorId;
  const employeeLabel = owner === "unassigned" ? "Unassigned" : owner === "mine" ? "Mine"
    : options?.employees.find(employee => employee.id === owner)?.name || (owner !== "all" ? "Selected employees" : "All employees");
  const hasFilters = Boolean(search || filters.period !== "all_time" || filters.category !== "all" || filters.day ||
    owner !== "all" || filters.brand || department !== floorId || workspace !== "all" || hasLegacyFilters);
  const chosenDay = data?.schedule.find(day => day.day === filters.day);
  const result = filters.day ? chosenDay : data?.summary[filters.category];

  return (
    <View style={styles.stack} testID="followup-planner">
      <View style={styles.overview}>
        {categories.slice(0, 6).map(category => {
          const metric = data?.summary[category.value];
          const selected = filters.category === category.value && !filters.day;
          return (
            <Pressable key={category.value} accessibilityRole="button" accessibilityState={{ selected }}
              testID={`planner-card-${category.value}`} onPress={() => changeStatus(category.value)}
              style={[styles.metric, isPhone && { flexBasis: "30%" }, selected && styles.selected]}>
              <Text style={[type.captionStrong, { color: "tone" in category ? category.tone : colors.onSurface }]}>{category.label} {metric?.count ?? "—"}</Text>
              {metric?.amounts.length ? <Text style={type.caption}>{amountsLine(metric.amounts)}</Text> : null}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.inline}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <SearchField value={search} onChangeText={onSearch} onClear={() => onSearch("")} maxLength={120}
            accessibilityLabel="Search customers, phone, or quotation number" placeholder="Customer, phone or quotation #" testID="planner-search" />
        </View>
        {tools}
      </View>
      <MobileFilterSection testID="planner-filter" initiallyExpanded={!isPhone}>
        <View style={styles.inline}>
          <Picker label="Status" value={status} choices={categories} onChange={changeStatus} testID="planner-category" />
          <Picker label="Date" value={period} choices={periods} onChange={period => update({ period, day: "" })} testID="planner-period" />
          <Picker label="Employee" value={employeeLabel} choices={[
            { value: "", label: "All employees" },
            ...((options?.employees || []).some(employee => employee.id === "unassigned") ? [] : [{ value: "unassigned", label: "Unassigned" }]),
            ...(options?.employees || []).map(employee => ({ value: employee.id, label: employee.name })),
          ]} onChange={onEmployee} testID="planner-employee" />
          <Picker label="Company" value={options?.brands.find(brand => brand.id === filters.brand)?.name || "All companies"} choices={[
            { value: "", label: "All companies" }, ...(options?.brands || []).map(brand => ({ value: brand.id, label: brand.name })),
          ]} onChange={brand => update({ brand })} testID="planner-company" />
          <Picker label="Department" value={department === "all" ? "All authorized departments"
            : departments.find(choice => choice.id === department)?.name || floorLabel || "Current department"} choices={[
            { value: "all", label: "All authorized departments" }, ...departments.map(choice => ({ value: choice.id, label: choice.name })),
          ]} onChange={department => update({ department })} testID="planner-department" />
          <Picker label="Activity" value={workspaces.find(choice => choice.value === workspace)?.label}
            choices={floorId === "ground-floor" ? workspaces : workspaces.slice(0, 2)} onChange={onWorkspace} testID="planner-workspace" />
        </View>
        {extraFilters}
        {filters.period === "custom" ? (
          <View style={styles.inline}>
            <View style={styles.dateField}><FollowupDateInput label="Start date" value={filters.start} onChange={start => update({ start })} testID="planner-start-date" /></View>
            <View style={styles.dateField}><FollowupDateInput label="End date" value={filters.end} min={isCalendarDay(filters.start) ? filters.start : undefined}
              onChange={end => update({ end })} testID="planner-end-date" /></View>
          </View>
        ) : null}
      </MobileFilterSection>
      <View style={styles.inline}>
        <Button label="Weekday schedule" icon="calendar" variant="secondary" size="md" testID="planner-schedule"
          onPress={() => setScheduleOpen(!showSchedule)} />
        {hasFilters ? <Button label="Reset filters" variant="ghost" size="md" testID="planner-reset" onPress={() => { setScheduleOpen(false); onReset(); }} /> : null}
      </View>
      {showSchedule ? (
        <View style={styles.stack}>
          <View style={styles.inline}>
            <Text accessibilityRole="header" style={[type.titleSm, { flex: 1 }]}>Upcoming schedule</Text>
            <IconButton icon="chevron-left" tone="surface" size={44} accessibilityLabel="Previous week" testID="planner-previous-week"
              disabled={filters.week <= -104} onPress={() => { setScheduleOpen(true); update({ week: filters.week - 1, day: "" }); }} />
            <IconButton icon="chevron-right" tone="surface" size={44} accessibilityLabel="Next week" testID="planner-next-week"
              disabled={filters.week >= 104} onPress={() => { setScheduleOpen(true); update({ week: filters.week + 1, day: "" }); }} />
          </View>
          <ScrollView horizontal keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.sm }}>
            {(data?.schedule || []).map(day => (
              <Pressable key={day.day} testID={`planner-day-${day.day}`} accessibilityRole="button"
                accessibilityState={{ selected: filters.day === day.day }}
                onPress={() => { setScheduleOpen(true); update({ category: "all", day: filters.day === day.day ? "" : day.day }); }}
                style={[styles.day, filters.day === day.day && styles.selected]}>
                <Text style={type.captionStrong}>{weekdayFormat.format(new Date(day.day + "T00:00:00+05:30"))}</Text>
                <Text style={type.caption}>{followupDateLabel(day.day)} · {day.count}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <View style={styles.inline}>
        <Text accessibilityRole="header" style={[type.titleMd, { flex: 1 }]}>{filters.day ? followupDateLabel(filters.day) : status === "All" ? "Follow-up queue" : status}</Text>
        {result ? <Text testID="planner-result-metric" style={type.caption}>
          {[`${result.count} ${result.count === 1 ? "record" : "records"}`, amountsLine(result.amounts)].filter(Boolean).join(" · ")}
        </Text> : null}
      </View>
      {data?.reports_available === false ? <Text style={type.caption}>
        Choose a narrower date range, customer or department to load quotation totals.
      </Text> : null}
      {result?.missing_dates ? <Text style={type.caption}>
        {result.missing_dates} undated {result.missing_dates === 1 ? "record is" : "records are"} included only in All time.
      </Text> : null}
    </View>
  );
}

export function FollowupInsights({ data, onEmployee, onCompany, onPeriod }: {
  data: FollowupReport;
  onEmployee: (id: string, category: PlannerCategory) => void;
  onCompany: (id: string, category: PlannerCategory) => void;
  onPeriod: (period: PlannerFilters["period"], category?: PlannerCategory) => void;
}) {
  return (
    <View style={styles.stack}>
      <Disclosure label="Employee Workload" testID="planner-workload-toggle">
        {data.employees.length ? data.employees.map(employee => (
          <View key={employee.id} style={styles.secondaryRow}>
            <Button label={[employee.name, amountsLine(employee.amounts)].filter(Boolean).join(" · ")}
              variant="ghost" size="md" onPress={() => onEmployee(employee.id, "active")} testID={`planner-workload-${employee.id}`} />
            <View style={styles.inline}>
              {(["today", "overdue", "upcoming"] as const).map(bucket => (
                <Button key={bucket} label={`${categories.find(choice => choice.value === bucket)?.label} ${employee[bucket]}`}
                  variant="secondary" size="md" testID={`planner-workload-${employee.id}-${bucket}`} onPress={() => onEmployee(employee.id, bucket)} />
              ))}
            </View>
          </View>
        )) : <Text style={type.bodySm}>No assigned workload matches.</Text>}
      </Disclosure>
      {data.reports_available !== false ? <Disclosure label="Company Performance" testID="planner-brand-toggle">
        {data.brands.length ? data.brands.map(brand => (
          <View key={brand.id} style={styles.secondaryRow}>
            <Button label={brand.name} variant="ghost" size="md" onPress={() => onCompany(brand.id, "outcomes")} testID={`planner-brand-${brand.id}`} />
            <View style={styles.inline}>
              <Button label={[`Won ${brand.won}`, amountsLine(brand.won_amounts)].filter(Boolean).join(" · ")} variant="secondary" size="md"
                testID={`planner-brand-${brand.id}-won`} onPress={() => onCompany(brand.id, "won")} />
              <Button label={[`Lost ${brand.lost}`, amountsLine(brand.lost_amounts)].filter(Boolean).join(" · ")} variant="secondary" size="md"
                testID={`planner-brand-${brand.id}-lost`} onPress={() => onCompany(brand.id, "lost")} />
              {brand.today != null ? <Button label={[`Workload ${brand.today + (brand.overdue || 0) + (brand.upcoming || 0)}`, amountsLine(brand.workload_amounts)].filter(Boolean).join(" · ")}
                variant="secondary" size="md" onPress={() => onCompany(brand.id, "active")} /> : null}
            </View>
          </View>
        )) : <Text style={type.bodySm}>No company results match.</Text>}
      </Disclosure> : null}
      <Disclosure label="Weekly and monthly reporting" testID="planner-reporting-toggle">
        <View style={styles.inline}>
          {periods.filter(period => ["this_week", "last_week", "this_month", "last_month"].includes(period.value)).map(period =>
            <Button key={period.value} label={period.label} variant="secondary" size="md" onPress={() => onPeriod(period.value)} />)}
          <Button label="Quotations created this month" variant="secondary" size="md" onPress={() => onPeriod("this_month", "created")} />
        </View>
      </Disclosure>
    </View>
  );
}

function Picker<T extends string>({ label, value, choices, onChange, testID }: {
  label: string; value?: string; choices: readonly { value: T; label: string }[]; onChange: (value: T) => void; testID: string;
}) {
  return (
    <Dropdown label={value ? `${label} · ${value}` : label} testID={testID}
      items={choices.map(choice => ({ label: choice.label, icon: choice.label === value ? "check" : undefined, testID: `${testID}-${choice.value || "all"}`, onPress: () => onChange(choice.value) }))} />
  );
}

function Disclosure({ label, testID, children }: { label: string; testID: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.disclosure}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} testID={testID} onPress={() => setOpen(value => !value)} style={styles.disclosureButton}>
        <Text style={[type.titleSm, { flex: 1 }]}>{label}</Text>
        <Feather accessible={false} name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.onSurfaceSecondary} />
      </Pressable>
      {open ? <View style={styles.disclosureContent}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  overview: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  metric: {
    flexGrow: 1, flexBasis: "15%", minWidth: 0, minHeight: 44, justifyContent: "center", padding: spacing.sm,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surfaceSecondary,
  },
  selected: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  inline: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
  dateField: { flexBasis: 152, flexGrow: 1, maxWidth: 300 },
  day: {
    minWidth: 106, minHeight: 44, padding: spacing.sm,
    borderWidth: 1, borderRadius: radius.sm, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
  disclosure: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
  disclosureButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md },
  disclosureContent: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  secondaryRow: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingVertical: spacing.xs, gap: spacing.xs },
});
