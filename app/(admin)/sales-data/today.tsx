import { FilterBar } from "@/src/components/ds";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import Feather from "@expo/vector-icons/Feather";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { executiveApi, type ExecutiveRow, type FeedEntry, type TodaysPriorities } from "@/src/api/executive";
import { AdminPage } from "@/src/components/AdminPage";
import { ActionRow } from "@/src/components/analytics/ActionRow";
import { Button, Card, EmptyState, ErrorState, LoadingState } from "@/src/components/ui";
import { fmtMoneyCompact } from "@/src/design/tokens";
import { getSelectedFloorId, useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { colors, spacing, type } from "@/src/theme/tokens";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";
import { toast } from "@/src/components/Toast";

const FLOOR_LABEL: Record<string, string> = {
  "first-floor": "Sanitary",
  "ground-floor": "Tiles",
};

/**
 * Stars for a row, and where they came from.
 *
 * followup_overdue rows carry the REAL output of followup_engine.score_followup
 * — already computed and stored on the Followup document, never recomputed
 * here (spec §14.2: "maps that existing score to the five-star scale rather
 * than inventing a second, conflicting notion of priority"). The bands match
 * that engine's own level cutoffs exactly (critical>=80, high>=60, medium>=35).
 *
 * No other rule has an equivalent — score_followup's inputs (days since last
 * CONTACT, a followup's urgency points, customer tier) don't exist for a
 * stalled quotation or a declining brand. Rather than fabricate a number for
 * those, stars fall back to the row's own position in the SAME ranked list
 * every other surface uses (§9/§10's rank-by-impact) — real, already-computed
 * ordering, just not the followup engine's.
 */
function starsFor(row: ExecutiveRow, index: number, total: number): { stars: number; basis: string } {
  if (row.priority_score !== null) {
    const stars = row.priority_score >= 80 ? 5 : row.priority_score >= 60 ? 4 : row.priority_score >= 35 ? 3 : 2;
    return { stars, basis: "engine" };
  }
  const quintile = total > 1 ? index / (total - 1) : 0;
  const stars = quintile <= 0.2 ? 5 : quintile <= 0.4 ? 4 : quintile <= 0.6 ? 3 : quintile <= 0.8 ? 2 : 1;
  return { stars, basis: "rank" };
}

function StarBadge({ row, index, total, testID }: { row: ExecutiveRow; index: number; total: number; testID?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { stars, basis } = starsFor(row, index, total);
  const label = basis === "engine"
    ? `Priority score ${row.priority_score}`
    : "Ranked by ₹ impact and age — no priority score for this rule type";

  return (
    <View style={{ gap: spacing.xs }}>
      <Pressable
        accessibilityLabel={`${stars} of 5 stars. ${label}. ${expanded ? "Hide" : "Show"} why`}
        onPress={() => setExpanded((v) => !v)}
        style={{ flexDirection: "row", alignItems: "center", gap: 2, minHeight: 44 }}
        testID={testID}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <Feather key={n} name="star" size={14} color={n <= stars ? colors.brand : colors.border} />
        ))}
      </Pressable>
      {expanded ? (
        <View style={{ gap: 2, paddingLeft: 2 }}>
          {row.reason_factors.length ? (
            row.reason_factors.map((factor) => (
              <Text key={factor} style={[type.caption, { color: colors.onSurfaceMuted }]}>• {factor}</Text>
            ))
          ) : (
            <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{label}</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function DoneTodayRow({ entry }: { entry: FeedEntry }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44 }}>
      <Feather name="check-circle" size={16} color={colors.success} />
      <Text style={[type.body, { flex: 1, minWidth: 0 }]} numberOfLines={1}>{entry.label}</Text>
      {entry.value ? (
        <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{fmtMoneyCompact(entry.value)}</Text>
      ) : null}
    </View>
  );
}

/**
 * Today's Priorities (spec §14.2) — the full, actionable surface of the same
 * Attention (§9) and Opportunity (§10) rules the Executive Overview shows the
 * top few of. Same triggers, same ₹ impact, same ranking: this screen exists
 * to fetch /analytics/today's already-ranked full list, never a second query
 * or a second rule set — a rule that fires here and not on the Overview would
 * be exactly the drift the spec's "one rule set" constraint forbids.
 */
export default function TodaysPrioritiesScreen() {
  const { staff } = useAuth();
  const canViewSales = useActionAccess("sales_data", "view", !!staff && ["owner", "admin", "manager"].includes(staff.role));
  const { floors } = useFloorAccess();
  const router = useRouter();
  const params = useLocalSearchParams<{ floor_id?: string }>();
  // Filter state lives in the URL (spec §16.3), matching executive.tsx — a
  // fresh visit with no params yet falls back to the shell's active floor.
  const [floorId, setFloorId] = useState(params.floor_id || "");
  const [data, setData] = useState<TodaysPriorities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.floor_id || floorId) return;
    void getSelectedFloorId().then((id) => setFloorId(id || "all"));
  }, [params.floor_id, floorId]);

  const selectFloor = (id: string) => {
    setFloorId(id);
    setData(null);
    router.setParams({ floor_id: id });
  };

  const load = useCallback(() => {
    if (!floorId) return;
    setError(null);
    executiveApi
      .today({ floorId })
      .then(setData)
      .catch((e: any) => setError(e?.detail || "Could not load Today's Priorities"));
  }, [floorId]);

  useEffect(() => { load(); }, [load]);

  if (staff && !canViewSales) {
    return <Redirect href="/(admin)/dashboard" />;
  }

  return (
    <AdminPage
      title="Today's Priorities"
      subtitle={data ? `${data.total} thing${data.total === 1 ? "" : "s"} need attention` : undefined}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }} testID="today-floor-filter">
        <FilterBar multiSelect
          testID="today-floor-tabs"
          value={floorId || "all"}
          onChange={selectFloor}
          options={[
            { value: "all", label: "All floors" },
            ...floors.map((f) => ({ value: f.id, label: FLOOR_LABEL[f.id] || f.name })),
          ]}
        />
      </View>

      {error ? <ErrorState subtitle={error} onRetry={load} /> : null}
      {!error && !data ? <LoadingState label="Building today's priorities…" /> : null}

      {data ? (
        <>
          {data.rows.length ? (
            <View style={{ gap: spacing.sm }} testID="today-priorities-list">
              <Button testID="today-priorities-export-xlsx" label="Export Excel" icon="download" variant="secondary" onPress={() => void downloadSectionExcel({ resource: "sales_data", page: "Today's Priorities", section: "Priorities", filename: "today-priorities.xlsx", floorId: floorId === "all" ? undefined : floorId, rows: [["Priority", "Type", "Impact", "Age (days)", "Destination"], ...data.rows.map((row, index) => [index + 1, row.headline, row.impact, row.age_days, row.destination])] }).catch((error: unknown) => toast.show(error instanceof Error ? error.message : "Could not export priorities"))} />
              {data.rows.map((row, index) => (
                <View key={`${row.rule}-${index}`} style={{ gap: spacing.xs }}>
                  <StarBadge row={row} index={index} total={data.total} testID={`today-stars-${index}`} />
                  <ActionRow row={row} testID={`today-row-${index}`} />
                </View>
              ))}
            </View>
          ) : (
            <EmptyState
              icon="check-circle"
              title="Nothing needs attention"
              subtitle="Every quotation, payment, follow-up and dispatch is on track."
              tone="brand"
            />
          )}

          <Card testID="today-done" variant="flat" padding={spacing.xl}>
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
                <Text style={type.titleSm}>Done today</Text>
                {data.done_today.length ? <Button testID="today-done-export-xlsx" label="Export Excel" icon="download" variant="secondary" onPress={() => void downloadSectionExcel({ resource: "sales_data", page: "Today's Priorities", section: "Done today", filename: "today-done.xlsx", floorId: floorId === "all" ? undefined : floorId, rows: [["Activity", "Type", "Value", "Completed at"], ...data.done_today.map(entry => [entry.label, entry.event_type, entry.value, entry.created_at])] }).catch((error: unknown) => toast.show(error instanceof Error ? error.message : "Could not export completed work"))} /> : null}
              </View>
              {data.done_today.length ? (
                <View style={{ gap: spacing.xs }}>
                  {data.done_today.map((entry) => <DoneTodayRow key={entry.id} entry={entry} />)}
                </View>
              ) : (
                <Text style={[type.body, { color: colors.onSurfaceMuted }]}>Nothing completed yet today.</Text>
              )}
            </View>
          </Card>
        </>
      ) : null}
    </AdminPage>
  );
}
