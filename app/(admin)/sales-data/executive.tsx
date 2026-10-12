import { FilterBar } from "@/src/components/ds";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";

import { executiveApi, type FeedEntry, type Overview } from "@/src/api/executive";
import { AdminPage } from "@/src/components/AdminPage";
import { ActivityFeed } from "@/src/components/analytics/ActivityFeed";
import { HealthScoreCard } from "@/src/components/analytics/HealthScoreCard";
import { ComparisonLine } from "@/src/components/analytics/HistoryNote";
import { MoneyBlockedCard } from "@/src/components/analytics/MoneyBlockedCard";
import { MorningBrief } from "@/src/components/analytics/MorningBrief";
import { RowList } from "@/src/components/analytics/RowList";
import { Button, Card, ErrorState, KpiCard, LoadingState, PillTabs } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { fmtMoneyCompact } from "@/src/design/tokens";
import { getSelectedFloorId, useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { colors, spacing, type } from "@/src/theme/tokens";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";
import { toast } from "@/src/components/Toast";

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
  { value: "all", label: "All time" },
];

const FLOOR_LABEL: Record<string, string> = {
  "first-floor": "Sanitary",
  "ground-floor": "Tiles",
};

/**
 * The Executive Overview (spec §7 Workspace 1) — the six above-the-fold
 * elements, in the exact order the spec fixes, and nothing else above the
 * fold. `ABOVE_THE_FOLD` on the backend (executive_overview_routes.py)
 * enforces the same contract; adding a seventh element here without amending
 * that constant is exactly the drift the spec's discipline exists to prevent.
 *
 * Below the fold: Revenue by Floor, Pending Quotations, Pending Follow-ups,
 * and the Activity Feed — all backed by the same /analytics/overview payload
 * Stage B verified live. Revenue Trend (bucketed time series) and Top 5
 * Movers (brand/product/referrer/salesperson rank comparison) are Phase 2/3
 * scope: no backend aggregation for either exists yet, and building them here
 * would mean either fabricating a number or quietly reusing the legacy
 * dashboard's differently-dated figures — both break this phase's own rules.
 * They stay off the screen rather than being faked.
 */
export default function ExecutiveOverview() {
  const { staff } = useAuth();
  const canViewSales = useActionAccess("sales_data", "view", !!staff && ["owner", "admin", "manager"].includes(staff.role));
  const { floors } = useFloorAccess();
  const { isPhone, isTablet } = useBp();
  const router = useRouter();
  const params = useLocalSearchParams<{ floor_id?: string; preset?: string }>();

  // One rule for all four cards, so the row is a clean 1-up / 2-up / 4-up
  // band instead of wrapping into uneven sizes. Per-card minWidths used to
  // let three cards sit on one line and the fourth drop to full width.
  const kpiCardStyle = isPhone
    ? { width: "100%" as const }
    : isTablet
      ? { flexBasis: "48%" as const, flexGrow: 1 }
      : { flex: 1, minWidth: 180, flexBasis: 0 };

  // Filter state lives in the URL (spec §16.3) so a drill-down is shareable
  // and back-navigable — but a fresh visit with no params yet still needs a
  // sane default, which is the shell's currently-active floor, not "all".
  const [floorId, setFloorId] = useState(params.floor_id || "");
  const [preset, setPreset] = useState(params.preset || "this_month");
  const [data, setData] = useState<Overview | null>(null);
  const [feed, setFeed] = useState<FeedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.floor_id || floorId) return;
    void getSelectedFloorId().then((id) => setFloorId(id || "all"));
  }, [params.floor_id, floorId]);

  const load = useCallback(() => {
    if (!floorId) return;
    setError(null);
    executiveApi
      .overview({ floorId, preset })
      .then(setData)
      .catch((e: any) => setError(e?.detail || "Could not load the executive overview"));
    // Own fetch, own cache key — the feed is already a tested, live-verified
    // endpoint; folding it into /overview would mean re-deriving the same
    // allowlist-and-floor-join logic a second way.
    executiveApi
      .feed({ floorId, limit: 15 })
      .then((res) => setFeed(res.rows))
      .catch(() => setFeed([]));
  }, [floorId, preset]);

  useEffect(() => { load(); }, [load]);

  const updateFilters = (next: { floorId?: string; preset?: string }) => {
    const nextFloor = next.floorId ?? floorId;
    const nextPreset = next.preset ?? preset;
    setFloorId(nextFloor);
    setPreset(nextPreset);
    setData(null);
    router.setParams({ floor_id: nextFloor, preset: nextPreset });
  };

  if (staff && !canViewSales) {
    return <Redirect href="/(admin)/dashboard" />;
  }

  return (
    <AdminPage
      title="Executive Overview"
      subtitle="Confirmed orders only, dated by ordered_at · live business books"
    >
      {/* A 6-option pill row does not fit AdminPage's header `right` slot on
          mobile — that slot's flex row does not wrap, so it pushed the whole
          page 153px wider than the viewport at 375px. Floor + preset filters
          both live in the body instead, where flexWrap genuinely wraps. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }} testID="executive-preset-filter">
        <PillTabs
          testID="executive-preset"
          value={preset}
          onChange={(v) => updateFilters({ preset: v })}
          options={PRESETS}
        />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }} testID="executive-floor-filter">
        <FilterBar multiSelect
          testID="executive-floor-tabs"
          value={floorId || "all"}
          onChange={(v) => updateFilters({ floorId: v })}
          options={[
            { value: "all", label: "All floors" },
            ...floors.map((f) => ({ value: f.id, label: FLOOR_LABEL[f.id] || f.name })),
          ]}
        />
      </View>

      {error ? <ErrorState subtitle={error} onRetry={load} /> : null}
      {!error && !data ? <LoadingState label="Building the executive view…" /> : null}

      {data ? (
        <>
          {/* 1. Business Health */}
          <HealthScoreCard health={data.health} testID="executive-health" />

          {/* 2. Morning Brief */}
          <MorningBrief brief={data.brief} testID="executive-brief" />

          {/* 3. Revenue KPIs */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }} testID="executive-kpis">
            <KpiCard
              testID="executive-kpi-revenue"
              label="Revenue"
              value={fmtMoneyCompact(data.kpis.revenue)}
              question="Are we making more money?"
              footer={
                <ComparisonLine
                  comparison={data.kpis.comparison}
                  previousLabel={data.kpis.previous_label}
                />
              }
              style={kpiCardStyle}
            />
            <KpiCard
              testID="executive-kpi-orders"
              label="Orders"
              value={String(data.kpis.orders)}
              question="How many deals did we close?"
              style={kpiCardStyle}
            />
            <KpiCard
              testID="executive-kpi-aov"
              label="Average Order"
              value={fmtMoneyCompact(data.kpis.aov)}
              question="Are deals getting bigger or smaller?"
              style={kpiCardStyle}
            />
            <KpiCard
              testID="executive-kpi-outstanding"
              label="Outstanding"
              value={fmtMoneyCompact(data.kpis.outstanding.outstanding)}
              question="How much money is owed to us?"
              onPress={() => router.push("/(admin)/payments" as never)}
              style={kpiCardStyle}
            />
          </View>

          {/* 4. Money Blocked */}
          <MoneyBlockedCard blocked={data.money_blocked} testID="executive-money-blocked" />

          {/* 5. Attention Center */}
          <RowList
            kind="attention"
            rows={data.attention}
            total={data.attention_total}
            testID="executive-attention"
          />

          {/* 6. Opportunity Center */}
          <RowList
            kind="opportunity"
            rows={data.opportunities}
            total={data.opportunities_total}
            testID="executive-opportunities"
          />

          {/* Below the fold */}
          <Card testID="executive-pending" variant="flat" padding={spacing.xl}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xl }}>
              <View style={{ gap: 2, minWidth: 160 }}>
                <Text style={type.captionStrong}>PENDING QUOTATIONS</Text>
                <Text style={[type.titleMd, { fontVariant: ["tabular-nums"] }]}>
                  {data.pending_quotations.count}
                </Text>
                <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
                  {fmtMoneyCompact(data.pending_quotations.value)} undecided
                  {data.pending_quotations.max_age_days !== null
                    ? ` · oldest ${data.pending_quotations.max_age_days}d`
                    : ""}
                </Text>
              </View>
              <View style={{ gap: 2, minWidth: 160 }}>
                <Text style={type.captionStrong}>PENDING FOLLOW-UPS</Text>
                <Text style={[type.titleMd, { fontVariant: ["tabular-nums"] }]}>
                  {data.pending_followups.count}
                </Text>
                <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
                  {data.pending_followups.overdue_count} overdue ·{" "}
                  {fmtMoneyCompact(data.pending_followups.value)} at stake
                </Text>
              </View>
            </View>
          </Card>

          {data.revenue_by_floor.length > 1 ? (
            <Card testID="executive-revenue-by-floor" variant="flat" padding={spacing.xl}>
              <View style={{ gap: spacing.md }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: spacing.sm }}>
                  <Text style={type.titleSm}>Revenue by Floor</Text>
                  <Button testID="executive-revenue-by-floor-export-xlsx" label="Export Excel" icon="download" variant="secondary" onPress={() => void downloadSectionExcel({ resource: "sales_data", page: "Executive Overview", section: "Revenue by Floor", filename: "executive-revenue-by-floor.xlsx", floorId: floorId === "all" ? undefined : floorId, rows: [["Business unit", "Revenue", "Orders"], ...data.revenue_by_floor.map(row => [FLOOR_LABEL[row.floor_id] || row.floor_id, row.revenue, row.orders])] }).catch((error: unknown) => toast.show(error instanceof Error ? error.message : "Could not export floor revenue"))} />
                </View>
                <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
                  Which floor is winning?
                </Text>
                <View style={{ gap: spacing.sm }}>
                  {data.revenue_by_floor.map((row) => (
                    <View
                      key={row.floor_id}
                      style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
                    >
                      <Text style={type.body}>{FLOOR_LABEL[row.floor_id] || row.floor_id}</Text>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={[type.bodyStrong, { fontVariant: ["tabular-nums"] }]}>
                          {fmtMoneyCompact(row.revenue)}
                        </Text>
                        <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
                          {row.orders} orders
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            </Card>
          ) : null}

          {feed === null ? (
            <LoadingState label="Loading activity…" />
          ) : (
            <ActivityFeed entries={feed} testID="executive-activity-feed" />
          )}
        </>
      ) : null}
    </AdminPage>
  );
}
