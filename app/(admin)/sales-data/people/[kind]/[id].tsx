import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { api } from '@/src/api/client';
import { AdminPage } from '@/src/components/AdminPage';
import { SectionExcelButton } from '@/src/components/salesData/SectionExcelButton';
import { analyticMoney, analyticNumber, Disclosure, Empty, Panel, ReadState } from '@/src/components/salesAnalytics/AnalyticsParts';
import { useAnalyticsRead, useResolvedAnalyticsPeriod } from '@/src/components/salesAnalytics/useAnalytics';
import { RankedBars } from '@/src/components/salesAnalytics/SalesGraphs';
import { spacing, type } from '@/src/theme/tokens';

type Detail={salesperson?:{full_name:string};referrer?:{name:string};kpis:{revenue:number|null;orders:number|null;aov:number|null;customers:number|null};brands:{brand_id:string;brand_name:string;revenue:number|null}[]};
export default function PeopleAnalytics(){
 const {kind,id}=useLocalSearchParams<{kind:string;id:string}>();const router=useRouter();
 const {canView,query,period,periodRead}=useResolvedAnalyticsPeriod();const label=period?.label||'Selected period';
 const valid=kind==='salespeople'||kind==='referrers';
 const read=useAnalyticsRead(`people:${kind}:${id}:${query}`,signal=>api.get<Detail>(`/executive-analytics/${kind}/${encodeURIComponent(id)}?${query}`,{signal}),canView&&valid&&!!id&&!!query);
 const data=read.data;const name=data?.salesperson?.full_name||data?.referrer?.name||'People analysis';
 return <AdminPage title={name} subtitle={label} back={()=>router.back()} contentStyle={{gap:spacing.s16}}><View style={{width:'100%',maxWidth:1280,alignSelf:'center',gap:spacing.s16}}>
 {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:!valid?<Empty text="This analysis type is unavailable. Return to Sales Data."/>:<ReadState variant="profile" loading={(read.loading||periodRead.loading)&&!data} refreshing={read.refreshing} error={read.error||periodRead.error} retry={()=>{periodRead.refresh();read.refresh();}}/>}
 {data?<><Disclosure label="Summary data"><Text style={type.bodySm}>Confirmed sales: {analyticMoney(data.kpis.revenue)}. Orders: {analyticNumber(data.kpis.orders)}. Average order value: {analyticMoney(data.kpis.aov)}. Customers: {analyticNumber(data.kpis.customers)}</Text></Disclosure>
 <Panel title="Sales by company" testID="people-detail-brands" action={<SectionExcelButton testID="people-brands-export-xlsx" page={name} section="Top brands" filename="people-top-brands.xlsx" rows={[["Brand","Revenue"],...data.brands.map(row=>[row.brand_name||'Unmapped',row.revenue])]}/>}>
 {data.brands.length?<RankedBars label="Attributed company sales in INR" rows={data.brands.slice(0,10).map((row,index)=>({id:row.brand_id||String(index),label:row.brand_name||'Unmapped',value:row.revenue,formatted:analyticMoney(row.revenue),testID:`people-brand-${row.brand_id}`}))}/>:<Text style={type.bodyMuted}>No attributed company sales in this period.</Text>}</Panel></>:null}
 </View></AdminPage>;
}
