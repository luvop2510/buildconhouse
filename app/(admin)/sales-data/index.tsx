import { Redirect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { executiveApi, type Overview } from "@/src/api/executive";
import {
  salesDataApi,
  type BestSellingProductRow,
  type BrandRevenueRow,
  type CustomerRevenueRow,
  type RecentOrderRow,
  type ReferrerSummaryRow,
  type SalesFilter,
} from "@/src/api/salesData";
import { ComparisonLine } from "@/src/components/analytics/HistoryNote";
import { RowList } from "@/src/components/analytics/RowList";
import { AdminPage } from "@/src/components/AdminPage";
import { FLOOR_LABEL, SalesFilters } from "@/src/components/salesData/SalesFilters";
import { TrendChart } from "@/src/components/salesData/TrendChart";
import { SalesSection } from "@/src/components/salesData/SalesSection";
import { useSalesPeriod } from "@/src/components/salesData/useSalesPeriod";
import {
  Alert, Badge, Button, Card, ErrorState, KpiCard, SkeletonList,
  Table, TableCell, TableHeader, TableRow,
} from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { fmtMoney, fmtMoneyCompact } from "@/src/design/tokens";
import { getSelectedFloorId, useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { colors, layout, spacing, type } from "@/src/theme/tokens";
import { downloadApiFile } from "@/src/utils/downloadFile";

const ANALYTICS_ROLES = ["owner", "admin", "manager"];
const TOP_N = 10;

/**
 * Money inside a table cell.
 *
 * A full ₹25,26,885 does not fit the revenue column at 375px — it truncated
 * to "₹25,26,…", which is worse than a rounded figure because the reader
 * cannot tell the magnitude at all. Phones get the compact form the KPI
 * cards already use; every wider breakpoint keeps the exact rupee value.
 *
 * A hook rather than a prop so every table on the page — including the two
 * referrer workspaces below — formats money identically without threading a
 * formatter through each one.
 */
function useCellMoney() {
  const { isPhone, isTabletPortrait } = useBp();
  // A portrait tablet has the same constrained content column as a phone
  // once the admin rail and page gutters are accounted for. Compact amounts
  // keep the record cards readable without making the page horizontally
  // scrollable; landscape tablets retain exact values in the table.
  return (value: number) => (isPhone || isTabletPortrait ? fmtMoneyCompact(value) : `₹${fmtMoney(value)}`);
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

type Sections = {
  trend: { bucket: string; revenue: number }[] | null;
  brands: BrandRevenueRow[] | null;
  customers: CustomerRevenueRow[] | null;
  products: BestSellingProductRow[] | null;
  orders: RecentOrderRow[] | null;
  architects: ReferrerSummaryRow[] | null;
  designers: ReferrerSummaryRow[] | null;
};

const EMPTY_SECTIONS: Sections = {
  trend: null, brands: null, customers: null, products: null, orders: null, architects: null, designers: null,
};

/** Owner summary using canonical server totals and independently loaded breakdowns. */
export default function SalesDataIndex() {
  const { staff } = useAuth();
  const { floors } = useFloorAccess();
  const cellMoney = useCellMoney();
  const { isPhone, isTabletPortrait } = useBp();
  const router = useRouter();
  const useCompactRows = isPhone || isTabletPortrait;

  // The KPI row used to give each card its own minWidth (160 / 140 / 180),
  // which wrapped into a ragged 2-then-1 block at narrow widths — two
  // half-width cards above one full-width one. Every card now carries the
  // identical rule, so the row is a clean 3-up band from tablet upwards and a
  // clean single stack on a phone, with no in-between state where the cards
  // are different sizes.
  const kpiGap = spacing.md;
  const kpiCardStyle = isPhone
    ? { width: "100%" as const }
    : isTabletPortrait
      ? { flexBasis: "48%" as const, flexGrow: 1, minWidth: 0 }
    : { flex: 1, minWidth: 200, flexBasis: 0 };

  // Matches SalesSection, so the one hand-rolled Card on this page breathes
  // exactly like the six that go through the shared section component.
  const sectionPadding = isPhone ? layout.cardPadding.base : layout.cardPadding.spacious;

  const [floorId, setFloorId] = useState("");
  useEffect(() => {
    if (floorId) return;
    void getSelectedFloorId().then((id) => setFloorId(id || "all"));
  }, [floorId]);

  const { period, origin, serverDefault, choose, jumpToLatest } = useSalesPeriod(floorId);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [sections, setSections] = useState<Sections>(EMPTY_SECTIONS);
  const [sectionErrors, setSectionErrors] = useState<Partial<Record<keyof Sections, string>>>({});
  const requestVersion = useRef(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(() => {
    if (!floorId || !period) return; // never query before the scope is known
    const version = ++requestVersion.current;
    const filter: SalesFilter = {
      floorId,
      preset: period.preset,
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
    };
    const executiveQuery = {
      floorId: floorId === "all" ? undefined : floorId,
      preset: period.preset,
      dateFrom: period.preset === "custom" ? period.dateFrom || undefined : undefined,
      dateTo: period.preset === "custom" ? period.dateTo || undefined : undefined,
    };

    setOverviewError(null);
    setOverview(null);
    setSections(EMPTY_SECTIONS);
    setSectionErrors({});
    setUpdatedAt(null);

    executiveApi.overview(executiveQuery)
      .then((result) => {
        if (version !== requestVersion.current) return;
        setOverview(result);
        setUpdatedAt(new Date());
      })
      .catch((e: unknown) => {
        if (version !== requestVersion.current) return;
        const detail = (e as { detail?: unknown })?.detail;
        setOverviewError(typeof detail === "string" ? detail : "Could not load the sales summary");
      });

    // Each breakdown settles independently so one unavailable service cannot
    // hide the rest of the business. Responses from old filters are ignored.
    const settle = <K extends keyof Sections>(key: K, request: Promise<{ rows: NonNullable<Sections[K]> }>) => {
      void request.then((result) => {
        if (version === requestVersion.current) setSections((current) => ({ ...current, [key]: result.rows }));
      }).catch((e: unknown) => {
        if (version !== requestVersion.current) return;
        const detail = (e as { detail?: unknown })?.detail;
        setSectionErrors((current) => ({ ...current, [key]: typeof detail === "string" ? detail : "Could not load this breakdown" }));
      });
    };
    settle("trend", salesDataApi.revenueTrend(filter).then(result => ({ rows: result.points })));
    settle("brands", salesDataApi.revenueByBrand(filter));
    settle("customers", salesDataApi.revenueByCustomer(filter));
    settle("products", salesDataApi.bestSellingProducts(filter, TOP_N));
    settle("orders", salesDataApi.recentOrders(filter, TOP_N));
    settle("architects", salesDataApi.referrers(filter, "architect"));
    settle("designers", salesDataApi.referrers(filter, "interior_designer"));
  }, [floorId, period]);

  useEffect(() => {
    load();
    return () => { requestVersion.current += 1; };
  }, [load]);

  const exportSalesData = useCallback(() => {
    if (!floorId || !period) return;
    const filter: SalesFilter = {
      floorId,
      preset: period.preset,
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
    };
    void downloadApiFile(
      salesDataApi.salesExportPath(filter),
      "sales-data.xlsx",
      "sales data Excel file",
      floorId === "all" ? undefined : floorId,
    );
  }, [floorId, period]);

  // The role check is a plain `if` AFTER every hook call — an early return
  // before a hook would change this component's hook count between renders.
  if (staff && !ANALYTICS_ROLES.includes(staff.role)) {
    return <Redirect href="/(admin)/dashboard" />;
  }

  const kpis = overview?.kpis;

  /** The unit's own name, preferring what the owner configured. FLOOR_LABEL
   *  carries the two trading names the business uses day to day; anything
   *  else (a third unit) falls back to its configured name rather than
   *  rendering the raw `second-floor` slug. */
  const floorName = (id: string) =>
    FLOOR_LABEL[id] || floors.find((f) => f.id === id)?.name || id;

  const visibleFloorRevenue = (overview?.revenue_by_floor || []).filter(
    (row) => floorId === "all" || row.floor_id === floorId,
  );

  const isEmptyPeriod = !!kpis && kpis.orders === 0;
  // Only offer the jump when the server actually knows of a period that has
  // orders in it, and it is not the one already on screen.
  const canJumpToLatest =
    isEmptyPeriod && !!serverDefault?.latest_order_at && serverDefault.date_from !== period?.dateFrom;

  return (
    <AdminPage
      title="Sales Data"
      subtitle={`Confirmed sales, dated by order confirmation${period ? ` · ${period.label}` : ""}`}
    >
      {period ? (
        <View style={{ gap: spacing.md }}>
          <SalesFilters
            floors={floors}
            floorId={floorId}
            onFloorChange={setFloorId}
            period={period}
            onPeriodChange={choose}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, alignItems: "center", justifyContent: "flex-end" }}>
            {updatedAt ? <Text style={[type.caption, { color: colors.onSurfaceMuted, flexGrow: 1 }, isPhone && { width: "100%" }]}>Updated {updatedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</Text> : null}
            <Button label="Refresh" icon="refresh-cw" variant="secondary" onPress={load} style={isPhone ? { flex: 1 } : undefined} />
            <Button
              testID="sales-data-export-xlsx"
              label="Export Excel"
              icon="download"
              variant="secondary"
              onPress={exportSalesData}
              style={isPhone ? { flex: 1 } : undefined}
            />
          </View>
        </View>
      ) : null}

      {origin === "fallback" ? (
        <Alert
          tone="info"
          title="No orders yet this month"
          description={`Showing the most recent available sales period — ${period?.label}.`}
        />
      ) : null}

      {canJumpToLatest ? (
        <Alert
          tone="info"
          title="No confirmed orders in this period"
          description={`The most recent orders are in ${serverDefault?.label}.`}
          action={<Button label={`Show ${serverDefault?.label}`} variant="secondary" onPress={jumpToLatest} />}
        />
      ) : null}

      {/* ---------------------------------------------------------------
          1-3. Total Revenue · Total Orders · Outstanding Payments
          --------------------------------------------------------------- */}
      {overviewError ? <ErrorState subtitle={overviewError} onRetry={load} /> : null}
      {!overviewError && !kpis ? <SkeletonList rows={2} /> : null}
      {kpis ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: kpiGap }} testID="sales-data-kpis">
          <KpiCard
            testID="sales-kpi-revenue"
            label="Total Revenue"
            value={fmtMoneyCompact(kpis.revenue)}
            question="Value of confirmed orders in this period"
            footer={<ComparisonLine comparison={kpis.comparison} previousLabel={kpis.previous_label} />}
            style={kpiCardStyle}
          />
          <KpiCard
            testID="sales-kpi-orders"
            label="Total Orders"
            value={String(kpis.orders)}
            question={`${kpis.customers} customers · ${fmtMoneyCompact(kpis.aov)} average order`}
            style={kpiCardStyle}
          />
          <KpiCard
            testID="sales-kpi-outstanding"
            label="Outstanding Payments"
            value={fmtMoneyCompact(kpis.outstanding.outstanding)}
            question="Still due on orders confirmed in this period"
            footer={<Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{fmtMoneyCompact(kpis.outstanding.collected)} collected on these orders</Text>}
            tone={kpis.outstanding.outstanding > 0 ? "warning" : "neutral"}
            onPress={() => router.push("/(admin)/payments" as never)}
            style={kpiCardStyle}
          />
        </View>
      ) : null}

      {overview ? (
        <View style={{ gap: spacing.md }}>
          <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>Current priorities for the selected business unit. Open work may predate the sales period.</Text>
          <RowList kind="attention" rows={overview.attention.slice(0, 3)} total={overview.attention_total} floorId={floorId} testID="sales-attention" />
        </View>
      ) : null}

      <SalesSection title="Revenue over time" question="Confirmed order revenue by order date · UTC" rows={sections.trend} error={sectionErrors.trend} onRetry={load} emptyTitle={period?.preset === "all" ? "Choose a date range to see the trend" : "No trend data in this period"} testID="sales-revenue-trend">
        {(points) => <TrendChart points={points} />}
      </SalesSection>

      {/* ---------------------------------------------------------------
          4. Revenue by Floor
          --------------------------------------------------------------- */}
      {overview ? (
        <Card testID="sales-revenue-by-floor" variant="flat" padding={sectionPadding}>
          <View style={{ gap: spacing.lg }}>
            <View style={{ gap: spacing.s4 }}>
              <Text style={type.titleMd}>Revenue by Business Unit</Text>
              <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
                {floorId === "all" ? "Confirmed revenue and orders · select a unit to focus the dashboard" : "Confirmed revenue for the selected business unit"}
              </Text>
            </View>
            {/* `/analytics/overview` always reports every accessible floor
                here, regardless of the floor filter — it is built as a
                cross-unit comparison. Rendering that unfiltered under a
                single-unit KPI row made the page contradict itself: Total
                Revenue showed one unit while the breakdown below it summed
                to the whole company. Scoping the rows to the active filter
                is what keeps the two halves of the card telling one story. */}
            {visibleFloorRevenue.map((row) => (
              <Pressable
                key={row.floor_id}
                testID={`sales-floor-row-${row.floor_id}`}
                accessibilityRole="button"
                accessibilityLabel={`Show ${floorName(row.floor_id)}: ${fmtMoneyCompact(row.revenue)}, ${row.orders} orders`}
                onPress={() => setFloorId(row.floor_id)}
                style={{ minHeight: 52, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: spacing.sm }}>
                  <Text style={type.body}>{floorName(row.floor_id)}</Text>
                  <View style={{ height: 5, backgroundColor: colors.surfaceSecondary, borderRadius: 2 }}>
                    <View style={{ height: 5, borderRadius: 2, backgroundColor: colors.brand, width: `${Math.max(0, Math.min(100, (row.revenue / Math.max(overview.kpis.revenue, 1)) * 100))}%` }} />
                  </View>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[type.bodyStrong, { fontVariant: ["tabular-nums"] }]}>
                    {fmtMoneyCompact(row.revenue)}
                  </Text>
                  <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
                    {row.orders} {row.orders === 1 ? "order" : "orders"}
                  </Text>
                </View>
              </Pressable>
            ))}
            {visibleFloorRevenue.length === 0 ? <Text style={type.bodyMuted}>No business-unit revenue in this period.</Text> : null}
          </View>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------
          5. Revenue by Brand
          --------------------------------------------------------------- */}
      <SalesSection
        testID="sales-revenue-by-brand"
        title="Revenue by Brand"
        question="Which brands are actually selling?"
        rows={sections.brands}
        error={sectionErrors.brands}
        onRetry={load}
        emptyTitle="No brand revenue in this period"
      >
        {(rows) => useCompactRows ? (
          <MobileRows>{rows.map((row) => (
            <MobileRow key={row.brand_id} testID={`sales-brand-row-${row.brand_id}`} title={row.name} value={cellMoney(row.revenue)} detail={`${row.quantity} sold`} badge={row.is_unlinked ? "Unmatched" : undefined} />
          ))}</MobileRows>
        ) : (
          <Table>
            <TableHeader columns={[{ label: "Brand", flex: 2 }, { label: "Qty", align: "right" }, { label: "Revenue", align: "right" }]} />
            {rows.map((row, i) => (
              <TableRow key={row.brand_id} isLast={i === rows.length - 1} testID={`sales-brand-row-${row.brand_id}`}>
                <TableCell flex={2}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 }}>
                    <Text numberOfLines={1} style={[type.bodySm, { flexShrink: 1 }]}>{row.name}</Text>
                    {/* Not a brand — revenue from products whose catalog doc
                        is gone. Labelled rather than dropped so this column
                        still totals to the Total Revenue card above. */}
                    {row.is_unlinked ? <Badge label="Unmatched" tone="warning" /> : null}
                  </View>
                </TableCell>
                <TableCell align="right">{String(row.quantity)}</TableCell>
                <TableCell align="right">{cellMoney(row.revenue)}</TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </SalesSection>

      {/* ---------------------------------------------------------------
          6. Revenue by Customer
          --------------------------------------------------------------- */}
      <SalesSection
        testID="sales-revenue-by-customer"
        title="Revenue by Customer"
        question="Who is buying the most?"
        rows={sections.customers}
        error={sectionErrors.customers}
        onRetry={load}
        emptyTitle="No customer revenue in this period"
        footer={
          sections.customers && sections.customers.length > TOP_N ? (
            <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
              Showing the top {TOP_N} of {sections.customers.length} customers.
            </Text>
          ) : null
        }
      >
        {(rows) => useCompactRows ? (
          <MobileRows>{rows.slice(0, TOP_N).map((row) => (
            <MobileRow key={row.customer_id || row.name} testID={`sales-customer-row-${row.customer_id}`} title={row.name} value={cellMoney(row.revenue)} detail={`${row.orders} ${row.orders === 1 ? "order" : "orders"}`} onPress={row.customer_id ? () => router.push(`/(admin)/customers/${row.customer_id}` as never) : undefined} />
          ))}</MobileRows>
        ) : (
          <Table>
            <TableHeader columns={[{ label: "Customer", flex: 2 }, { label: "Orders", align: "right" }, { label: "Revenue", align: "right" }]} />
            {rows.slice(0, TOP_N).map((row, i, shown) => (
              <TableRow
                key={row.customer_id || row.name}
                isLast={i === shown.length - 1}
                testID={`sales-customer-row-${row.customer_id}`}
                onPress={row.customer_id ? () => router.push(`/(admin)/customers/${row.customer_id}` as never) : undefined}
              >
                <TableCell flex={2}>{row.name}</TableCell>
                <TableCell align="right">{String(row.orders)}</TableCell>
                <TableCell align="right">{cellMoney(row.revenue)}</TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </SalesSection>

      {/* ---------------------------------------------------------------
          7. Referred By — two separate workspaces, from the quotation's own
          "Referred By" field. Never fabricated: an empty book renders an
          empty state, not a zero row.
          --------------------------------------------------------------- */}
      <ReferrerWorkspace
        testID="sales-referrals-architects"
        title="Referred By — Architects"
        rows={sections.architects}
        error={sectionErrors.architects}
        onRetry={load}
        onOpen={(id) => router.push({ pathname: "/(admin)/sales-data/referrer/[id]", params: { id, floorId, preset: period?.preset, dateFrom: period?.dateFrom || "", dateTo: period?.dateTo || "" } } as never)}
      />
      <ReferrerWorkspace
        testID="sales-referrals-designers"
        title="Referred By — Interior Designers"
        rows={sections.designers}
        error={sectionErrors.designers}
        onRetry={load}
        onOpen={(id) => router.push({ pathname: "/(admin)/sales-data/referrer/[id]", params: { id, floorId, preset: period?.preset, dateFrom: period?.dateFrom || "", dateTo: period?.dateTo || "" } } as never)}
      />

      {/* ---------------------------------------------------------------
          8. Best Selling Products
          --------------------------------------------------------------- */}
      <SalesSection
        testID="sales-best-selling-products"
        title="Best Selling Products"
        question="What is moving off the shelves?"
        rows={sections.products}
        error={sectionErrors.products}
        onRetry={load}
        emptyTitle="No products sold in this period"
      >
        {(rows) => useCompactRows ? (
          <MobileRows>{rows.map((row) => (
            <MobileRow key={row.product_id} testID={`sales-product-row-${row.product_id}`} title={row.name} value={cellMoney(row.revenue)} detail={`${row.quantity} sold${row.brand_name ? ` · ${row.brand_name}` : ""}`} />
          ))}</MobileRows>
        ) : (
          <Table>
            <TableHeader columns={[{ label: "Product", flex: 3 }, { label: "Qty", align: "right" }, { label: "Revenue", align: "right" }]} />
            {rows.map((row, i) => (
              <TableRow key={row.product_id} isLast={i === rows.length - 1} testID={`sales-product-row-${row.product_id}`}>
                <TableCell flex={3}>
                  <View style={{ gap: 1, flexShrink: 1 }}>
                    <Text numberOfLines={1} style={type.bodySm}>{row.name}</Text>
                    {row.brand_name ? (
                      <Text numberOfLines={1} style={[type.caption, { color: colors.onSurfaceMuted }]}>
                        {row.brand_name}
                      </Text>
                    ) : null}
                  </View>
                </TableCell>
                <TableCell align="right">{String(row.quantity)}</TableCell>
                <TableCell align="right">{cellMoney(row.revenue)}</TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </SalesSection>

      {/* ---------------------------------------------------------------
          9. Recent Orders
          --------------------------------------------------------------- */}
      <SalesSection
        testID="sales-recent-orders"
        title="Recent Orders"
        question="What has just been confirmed?"
        rows={sections.orders}
        error={sectionErrors.orders}
        onRetry={load}
        emptyTitle="No confirmed orders in this period"
        emptySubtitle="Orders appear here the moment a quotation is confirmed."
        footer={
          sections.orders && sections.orders.length >= TOP_N ? (
            <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
              Showing the {TOP_N} most recent confirmed orders.
            </Text>
          ) : null
        }
      >
        {(rows) => useCompactRows ? (
          <MobileRows>{rows.map((row) => (
            <MobileRow key={row.id} testID={`sales-order-row-${row.id}`} title={row.customer_name} value={cellMoney(row.grand_total)} detail={`${row.number || "—"} · ${shortDate(row.ordered_at)} · ${row.outstanding > 0 ? `${cellMoney(row.outstanding)} due` : "Paid"}`} onPress={() => router.push(`/(admin)/quotations/${row.id}` as never)} />
          ))}</MobileRows>
        ) : (
          <Table>
            <TableHeader
              columns={[
                { label: "Order", flex: 2 },
                { label: "Date", width: 62, align: "right" },
                { label: "Value", align: "right" },
                { label: "Due", align: "right" },
              ]}
            />
            {rows.map((row, i) => (
              <TableRow
                key={row.id}
                isLast={i === rows.length - 1}
                testID={`sales-order-row-${row.id}`}
                onPress={() => router.push(`/(admin)/quotations/${row.id}` as never)}
              >
                <TableCell flex={2}>
                  <View style={{ gap: 1, flexShrink: 1 }}>
                    <Text numberOfLines={1} style={type.bodySm}>{row.customer_name}</Text>
                    <Text numberOfLines={1} style={[type.caption, { color: colors.onSurfaceMuted }]}>
                      {row.number || "—"}
                    </Text>
                  </View>
                </TableCell>
                <TableCell width={62} align="right">{shortDate(row.ordered_at)}</TableCell>
                <TableCell align="right">{cellMoney(row.grand_total)}</TableCell>
                <TableCell align="right">
                  <Text
                    numberOfLines={1}
                    style={[type.bodySm, { color: row.outstanding > 0 ? colors.warning : colors.success }]}
                  >
                    {row.outstanding > 0 ? cellMoney(row.outstanding) : "Paid"}
                  </Text>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </SalesSection>
    </AdminPage>
  );
}

/**
 * One Referred By workspace. Architects and Interior Designers get their own,
 * from the same Phase 0 `/analytics/referrers` endpoint filtered by type.
 *
 * The empty state is the important case, not the edge case: the live book
 * currently has no referral attributed to any quotation at all, so this is
 * what the owner will see at launch. It says why the block is empty rather
 * than rendering a zero row that would imply a referrer earning nothing.
 */
function ReferrerWorkspace({
  title, rows, error, onRetry, onOpen, testID,
}: {
  title: string;
  rows: ReferrerSummaryRow[] | null;
  error?: string | null;
  onRetry?: () => void;
  onOpen: (referrerId: string) => void;
  testID: string;
}) {
  const cellMoney = useCellMoney();
  const { isPhone, isTabletPortrait } = useBp();
  const useCompactRows = isPhone || isTabletPortrait;
  return (
    <SalesSection
      testID={testID}
      title={title}
      question="Who is sending us business?"
      rows={rows}
      error={error}
      onRetry={onRetry}
      emptyTitle="No referrals recorded in this period"
      emptySubtitle="Set 'Referred By' on a quotation and that person's business appears here."
    >
      {(list) => useCompactRows ? (
        <MobileRows>{list.map((row) => (
          <MobileRow key={row.referrer_id} testID={`${testID}-row-${row.referrer_id}`} title={row.name} value={cellMoney(row.revenue)} detail={`${row.customers_referred} ${row.customers_referred === 1 ? "client" : "clients"} · ${row.quotations_confirmed} confirmed ${row.quotations_confirmed === 1 ? "order" : "orders"}`} onPress={() => onOpen(row.referrer_id)} />
        ))}</MobileRows>
      ) : (
        <Table>
          <TableHeader
            columns={[
              { label: "Name", flex: 2 },
              { label: "Clients", align: "right" },
              { label: "Orders", align: "right" },
              { label: "Revenue", align: "right" },
            ]}
          />
          {list.map((row, i) => (
            <TableRow
              key={row.referrer_id}
              isLast={i === list.length - 1}
              testID={`${testID}-row-${row.referrer_id}`}
              onPress={() => onOpen(row.referrer_id)}
            >
              <TableCell flex={2}>{row.name}</TableCell>
              <TableCell align="right">{String(row.customers_referred)}</TableCell>
              <TableCell align="right">{String(row.quotations_confirmed)}</TableCell>
              <TableCell align="right">{cellMoney(row.revenue)}</TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </SalesSection>
  );
}

/** Phone-first records preserve the complete row meaning without forcing a
 * spreadsheet-width table to own the page's horizontal scroll. */
function MobileRows({ children }: { children: React.ReactNode }) {
  return <View style={{ gap: spacing.xs }}>{children}</View>;
}

function MobileRow({ title, detail, value, badge, onPress, testID }: {
  title: string; detail: string; value: string; badge?: string; onPress?: () => void; testID?: string;
}) {
  const content = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 56, paddingVertical: spacing.xs }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.xs }}>
          <Text style={type.bodyStrong} numberOfLines={2}>{title}</Text>
          {badge ? <Badge label={badge} tone="warning" /> : null}
        </View>
        <Text style={[type.caption, { color: colors.onSurfaceMuted }]} numberOfLines={2}>{detail}</Text>
      </View>
      <Text style={[type.bodyStrong, { fontVariant: ["tabular-nums"], textAlign: "right" }]} numberOfLines={1}>{value}</Text>
    </View>
  );
  return onPress ? <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`Open ${title}`} onPress={onPress} style={{ borderBottomWidth: 1, borderBottomColor: colors.border, minHeight: 56 }}>{content}</Pressable> : <View testID={testID} style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>{content}</View>;
}
