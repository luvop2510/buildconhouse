import { NavigationLink } from "@/src/design/NavigationLink";
import { STAGE_LABELS, type KitchenStage } from "@/src/api/kitchenProjects";
import { referrerCode } from "@/src/utils/referrer";
import { MobileFilterSection } from "@/src/components/MobileFilterSection";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";

import { AdminPage } from "@/src/components/AdminPage";
import { api } from "@/src/api/client";
import {
  Button, EmptyState,
} from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { colors, spacing, type } from "@/src/theme/tokens";
import { TrendChart } from "@/src/components/salesData/TrendChart";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";
import { toast } from "@/src/components/Toast";
import { AnalyticsFilters } from "@/src/components/salesAnalytics/AnalyticsFilters";
import type { Granularity } from "@/src/components/salesData/salesDataApi";

import { RankedBars } from '@/src/components/salesAnalytics/SalesGraphs';
import { Choice, Disclosure, ReadState } from '@/src/components/salesAnalytics/AnalyticsParts';
import { useAnalyticsRead, useResolvedAnalyticsPeriod } from '@/src/components/salesAnalytics/useAnalytics';
const fmtMoney = (value: number | null | undefined) => value == null ? 'Unavailable' : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

type ReferrerDetailResponse = {
  referrer: { id: string; name: string; type: string; phone?: string | null; company?: string | null };
  kitchen_projects?: { id: string; number: string; customer_name: string; kitchen_stage: KitchenStage; status: string; grand_total: number }[];
  customers_acquired?: number;
  referred_people?: { customer_name: string | null; first_referred_at: string | null; confirmed: number; sources: string[]; floor_ids: string[] }[];
  people_offset?: number;
  total_revenue: number;
  total_revenue_rnb?: number;
  furniture_quotations_total?: number;
  furniture_quotations?: { id: string; customer_name: string; total_payable_rmb: string; total_received_rmb: string; balance_rmb: string; finalized_at: string }[];
  trend: { bucket: string; revenue: number }[];
  quotations: { id: string; number: string; customer_name: string; grand_total: number; updated_at: string | null }[];
};

export default function ReferrerDetail() {
  const { id, floorId } = useLocalSearchParams<{ id: string; floorId?: string }>();
  const {query:periodQuery,period,periodRead,filters,update,floors,canView}=useResolvedAnalyticsPeriod();
  const periodLabel=period?.label||'Selected period';const reportFloor=filters.floor_id;
  const [peopleOffset, setPeopleOffset] = useState(0);
  useEffect(() => { setPeopleOffset(0); }, [id, periodQuery]);
  const [granularity, setGranularity] = useState<Granularity>("month");
  const { isPhone, isTabletPortrait } = useBp();
  const compact = isPhone || isTabletPortrait;

  const read=useAnalyticsRead(`referrer:${id}:${periodQuery}:${granularity}:${peopleOffset}`,signal=>api.get<ReferrerDetailResponse>(`/sales-data/referrers/${encodeURIComponent(id)}?${periodQuery}&granularity=${granularity}&people_offset=${peopleOffset}`,{signal}),canView&&!!id&&!!periodQuery);
  const data=read.data;

  const exportData = (section: string, rows: (string | number | null)[][]) => {
    if (!data) return;
    void downloadSectionExcel({ resource: "sales_data", page: `Referrer / ${data.referrer.name}`, section, filename: `referrer-${section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.xlsx`, floorId, rows }).catch((error: unknown) => toast.show(error instanceof Error ? error.message : "Could not export referrer data"));
  };

  return (
    <AdminPage
      title={data?.referrer.name || "Referrer"}
      subtitle={data ? `${reportFloor === "third-floor" ? "" : `₹${fmtMoney(data.total_revenue)} sales · `}${data.total_revenue_rnb || reportFloor === "third-floor" ? `RNB ${fmtMoney(data.total_revenue_rnb)} Furniture sales · ` : ""}${periodLabel}` : undefined}
      contentStyle={{gap:spacing.s16,width:"100%",maxWidth:1280,alignSelf:"center"}}
    >
      <AnalyticsFilters filters={filters} showDateBasis={false} update={next=>update({...next,date_basis:'confirmation'})} floors={floors}/>
      <MobileFilterSection testID="referrer-filters">
      <Choice label="Time scale" value={granularity} onChange={value=>setGranularity(value as Granularity)} options={[{value:'day',label:'Day'},{value:'month',label:'Month'},{value:'quarter',label:'Quarter'},{value:'year',label:'Year'}]} testID="referrer-detail-granularity"/>
      </MobileFilterSection>
      {!canView?<EmptyState title="Your account does not have permission to view Sales Data."/>:<ReadState variant="profile" loading={(read.loading||periodRead.loading)&&!data} refreshing={read.refreshing} error={read.error||periodRead.error} retry={()=>{periodRead.refresh();read.refresh();}}/>}
      {data ? (
        <View style={{ gap: spacing.lg }}>
          <Text style={type.body}>{[data.referrer.company, referrerCode(data.referrer.id, data.referrer.type, data.referrer.name)].filter(Boolean).join(", ")}</Text>
          {data.referred_people ? <View testID="referrer-clients" style={{ gap: spacing.s12, minWidth: 0 }}>
            <Text accessibilityRole="header" aria-level={2} style={type.titleSm}>Clients brought · {(data.customers_acquired || 0).toLocaleString("en-IN")}</Text>
            <Text style={type.bodySm}>Walk-ins and confirmed or non-confirmed customers, counted once per person in {periodLabel}. Sales below use order confirmation dates.</Text>
            <RankedBars label="Confirmed and not-confirmed clients on this page" rows={[{id:'confirmed',label:'Confirmed clients',value:data.referred_people.filter(person=>person.confirmed).length,formatted:String(data.referred_people.filter(person=>person.confirmed).length)},{id:'other',label:'Clients without confirmed orders',value:data.referred_people.filter(person=>!person.confirmed).length,formatted:String(data.referred_people.filter(person=>!person.confirmed).length)}]}/>
            <Disclosure label="Referred people and source history">{data.referred_people.map((person, index) => <View key={index} testID={`referrer-client-${index}`} style={{ gap: spacing.s4, paddingVertical: spacing.s12, borderBottomWidth: 1, borderBottomColor: colors.border, minWidth: 0 }}>
              <Text style={type.bodyStrong}>{person.customer_name || "Unnamed customer"}</Text>
              <Text style={type.bodySm}>{person.confirmed ? "Confirmed customer" : person.sources.includes("walkins") ? "Walk-in · Not confirmed" : "Not confirmed"}{person.first_referred_at ? ` · ${new Date(person.first_referred_at).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })}` : ""}</Text>
            </View>)}
            </Disclosure>
            {!data.customers_acquired ? <Text style={type.body}>No referred people in this range.</Text> : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.s8, alignItems: "center" }}>
              <Text style={type.bodySm}>Showing {peopleOffset + 1}–{peopleOffset + data.referred_people.length} of {data.customers_acquired}</Text>
              {peopleOffset ? <Button label="Previous clients" variant="secondary" onPress={() => setPeopleOffset(offset => Math.max(0, offset - 100))} /> : null}
              {peopleOffset + data.referred_people.length < data.customers_acquired! ? <Button label="More clients" variant="secondary" onPress={() => setPeopleOffset(offset => offset + 100)} /> : null}
            </View>}
          </View> : null}
          {data.furniture_quotations?.length ? <Disclosure label="Furniture final ledgers">
            <Text accessibilityRole="header" aria-level={2} style={type.titleSm}>Furniture final ledgers</Text>
            <Text style={type.bodySm}>{data.furniture_quotations_total || data.furniture_quotations.length} final ledgers · RNB {fmtMoney(data.total_revenue_rnb)} sales</Text>
            <Button label="Export Furniture ledgers" variant="secondary" icon="download" onPress={() => exportData("Furniture final ledgers", [["Ledger ID", "Customer", "Sales (RNB)", "Received (RNB)", "Balance (RNB)", "Finalized"], ...data.furniture_quotations!.map(row => [row.id, row.customer_name, row.total_payable_rmb, row.total_received_rmb, row.balance_rmb, row.finalized_at])])} />
            {data.furniture_quotations.map(row => <View key={row.id} testID={`referrer-furniture-row-${row.id}`} style={{ gap: spacing.s8, paddingVertical: spacing.s12, borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text style={type.bodyStrong}>{row.customer_name}</Text>
              <Text style={type.bodySm}>Finalized {new Date(row.finalized_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" })}</Text>
              <View style={{ flexDirection: compact ? "column" : "row", flexWrap: "wrap", gap: spacing.s12 }}>
                <Text style={[type.body, { fontVariant: ["tabular-nums"] }]}>Sales RNB {row.total_payable_rmb}</Text>
                <Text style={[type.body, { fontVariant: ["tabular-nums"] }]}>Received RNB {row.total_received_rmb}</Text>
                <Text style={[type.body, { fontVariant: ["tabular-nums"] }]}>Balance RNB {row.balance_rmb}</Text>
              </View>
            </View>)}
            {(data.furniture_quotations_total || 0) > data.furniture_quotations.length ? <Text style={type.bodySm}>Showing the latest {data.furniture_quotations.length} ledgers. Narrow the reporting period to see earlier records.</Text> : null}
          </Disclosure> : null}
          {data.kitchen_projects?.length ? <Disclosure label="Kitchen leads and projects"><Text style={type.titleSm}>Kitchen leads and projects</Text>{data.kitchen_projects.map(project => <NavigationLink key={project.id} href={`/kitchen/${project.id}/stages/${project.kitchen_stage}` as any} accessibilityLabel={`Open ${project.number}`} style={{ minHeight: 56, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}><Text style={type.bodyStrong}>{project.customer_name} · {project.number}</Text><Text style={type.body}>{STAGE_LABELS[project.kitchen_stage]}{project.status === "ordered" ? ` · Confirmed sale ₹${fmtMoney(project.grand_total)}` : ""}</Text></NavigationLink>)}</Disclosure> : null}
          {data.trend.length ? <Button testID="referrer-detail-trend-export-xlsx" label="Export revenue trend" icon="download" variant="secondary" onPress={() => exportData("Revenue trend", [["Period", "Revenue"], ...data.trend.map(point => [point.bucket, point.revenue])])} /> : null}
          {reportFloor !== "third-floor" ? <TrendChart points={data.trend} /> : null}
          {data.quotations.length === 0 ? (
            data.furniture_quotations?.length ? null : <EmptyState title="No confirmed sales in this range" />
          ) : (
            <View style={{ gap: spacing.sm }}>
            <Button testID="referrer-detail-orders-export-xlsx" label="Export orders" icon="download" variant="secondary" onPress={() => exportData("Confirmed orders", [["Order", "Customer", "Value", "Confirmed at"], ...data.quotations.map(quote => [quote.number, quote.customer_name, quote.grand_total, quote.updated_at])])} />
            <RankedBars label="Confirmed referred orders in INR" rows={data.quotations.map(quote=>({id:quote.id,label:quote.customer_name,value:quote.grand_total,formatted:`₹${fmtMoney(quote.grand_total)}`,detail:quote.number,testID:`referrer-quote-row-${quote.id}`}))}/>

            </View>
          )}
        </View>
      ) : null}
    </AdminPage>
  );
}
