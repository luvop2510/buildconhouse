import { useState, type ReactNode } from 'react';
import { useSalesTheme } from './salesTheme';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button, IconButton } from '@/src/components/ui';
import { useBp } from '@/src/design/responsive';
import { spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsDashboardData, type AnalyticsEntity, type AnalyticsFilters as FilterValues, type AnalyticsKind } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { SalesTrend } from './AnalyticsCharts';
import { analyticMoney, analyticNumber, linkActivation, BASIS_NAMES, DataLink, EntityLedger, Empty, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { analyticEntityAmount, analyticsCurrency } from './currencyScope';
import { AnalyticsBento } from '@/src/components/ui/analytics-bento';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';
import { SalesHero, VisualKpis } from './SalesVisuals';

type Navigate = (path:string,filters?:FilterValues)=>void;
function Metric({label,value,detail,onPress,testID}:{label:string;value:string;detail:string;onPress:()=>void;testID:string}) {
 const {isPhone,width}=useBp(); const theme=useSalesTheme(); const {fontScale}=useWindowDimensions();
 const monetary=testID==='analytics-kpi-sales'||testID==='analytics-kpi-aov';
 return <Pressable testID={testID} accessibilityRole="link" {...linkActivation(onPress)} accessibilityLabel={`${label}: ${value}. ${detail}. Open supporting records`} onPress={onPress}
  style={({pressed,hovered}:any)=>({flexGrow:1,flexBasis:fontScale>1.3?'100%':isPhone?(monetary&&width<360?'100%':'44%'):monetary?190:130,minWidth:0,padding:16,gap:8,borderWidth:1,borderColor:theme.line,borderRadius:16,backgroundColor:pressed||hovered?theme.tint:theme.surface})}>
  <Text style={[type.bodySm,{color:theme.muted}]}>{label}</Text>
  <ScrollView horizontal showsHorizontalScrollIndicator style={{flexGrow:0,maxWidth:'100%'}}><Text style={[type.titleLg,{fontSize:isPhone?18:22,lineHeight:28,color:theme.ink,fontVariant:['tabular-nums'],fontWeight:'600',...(monetary?{whiteSpace:'nowrap'} as never:{})}]}>{value}</Text></ScrollView>
  <Text style={[type.caption,{color:theme.muted}]}>{detail}</Text>
 </Pressable>;
}
export function AnalyticsKpis({ data, go, subset='all' }: {data:AnalyticsDashboardData;go:(metric:string)=>void;subset?:'all'|'primary'|'secondary'}) {
 const {kpis}=data; const payment=data.filters.date_basis==='payment'; const currency=analyticsCurrency(data.filters.floor_id);
 const change=currency==='RNB'?kpis.change_pct_rnb:kpis.change_pct;
 return <View testID={subset==='secondary'?'analytics-kpis-secondary':'analytics-kpis'} style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s8}}>
  {subset!=='secondary'?<Metric label={data.metric_label||(payment?'Collected amount':'Confirmed sales')} testID="analytics-kpi-sales" value={analyticMoney(currency==='RNB'?kpis.sales_rnb:kpis.sales,currency)} detail={`${currency} · ${change==null?'No prior baseline':`${change>0?'+':''}${analyticNumber(change)}% vs previous period`}`} onPress={()=>go('sales')}/>:null}
  {subset!=='primary'?<>
  <Metric label={payment?'Orders with payments':'Confirmed orders'} testID="analytics-kpi-orders" value={analyticNumber(kpis.orders)} detail="Customer orders" onPress={()=>go('orders')}/>
  <Metric label={payment?'Paying customers':'Purchasing customers'} testID="analytics-kpi-customers" value={analyticNumber(kpis.customers)} detail="Distinct customers" onPress={()=>go('customers')}/>
  <Metric label={payment?'Average collected':'Average order value'} testID="analytics-kpi-aov" value={analyticMoney(currency==='RNB'?kpis.average_order_value_rnb:kpis.average_order_value,currency)} detail={`${currency} per matching order`} onPress={()=>go('sales')}/>
  </>:null}
 </View>;
}
export function EntityRanking({title,kind,rows,go,all=false,floorId}:{title:string;kind:AnalyticsKind;rows:AnalyticsEntity[];go:Navigate;all?:boolean;floorId?:string}) {
 const currency=analyticsCurrency(floorId);
 const visible=rows.filter(row=>floorId==='third-floor'||!row.floor_ids?.length||row.floor_ids.some(id=>id!=='third-floor')).slice(0,all?100:3);
 const maximum=Math.max(1,...visible.map(row=>analyticEntityAmount(row,floorId)||0));
 return <Panel title={title} action={!all?<Button label="View all" variant="ghost" onPress={()=>go(`/(admin)/sales-data/${kind}`)}/>:undefined}>
  {visible.length?visible.map(row=><DataLink key={row.id} label={row.name} detail={row.detail||`${analyticNumber(row.orders)} orders${row.customers!=null?` · ${analyticNumber(row.customers)} customers`:''}`} value={analyticMoney(analyticEntityAmount(row,floorId),currency)} proportion={kind==='companies'||kind==='products'?analyticEntityAmount(row,floorId)==null?undefined:(analyticEntityAmount(row,floorId)||0)/maximum:undefined} testID={`analytics-entity-${row.id}`} onPress={()=>go(`/(admin)/sales-data/profile/${kind}/${encodeURIComponent(row.id)}`)}/>):<Empty text={`No attributable ${kind} sales in this range.`}/>}
 </Panel>;
}
export function DashboardContent({data,filters,update,go,compact=false,operations}:{data:AnalyticsDashboardData;filters:FilterValues;update:(filters:FilterValues)=>void;go:Navigate;compact?:boolean;operations?:ReactNode}) {
 const {isDesktop,isTabletLandscape}=useBp(); const {fontScale}=useWindowDimensions();
 const paired=(isDesktop||isTabletLandscape)&&fontScale<=1.3;
 const currency=analyticsCurrency(filters.floor_id);
 const showRecords=(next:FilterValues={})=>go('/(admin)/sales-data/records',{page:'1',...next});
 return <View style={{gap:12}}>
  {compact?<AnalyticsKpis data={data} go={metric=>showRecords({metric,...(metric==='sales'?{currency}:{})})}/>:<View style={{flexDirection:paired?'row':'column',gap:16,alignItems:'stretch'}}><View style={{flex:paired?1:undefined,minWidth:0}}><SalesHero data={data} currency={currency} onRecords={()=>showRecords({metric:'sales',currency})}/></View><View style={{flex:paired?1.5:undefined,minWidth:0}}><VisualKpis data={data} filters={filters} go={(metric,code)=>showRecords({metric,...(code?{currency:code}:{})})}/></View></View>}
  {filters.date_basis!=='confirmation'?<Text style={type.bodySm}>{BASIS_NAMES[filters.date_basis]} · {data.metric_label||'Matching confirmed orders'}</Text>:null}
  {compact?<Panel title={filters.date_basis==='payment'?'Collections over time':'Sales over time'} description={data.period.label}><SalesTrend points={data.trend} currency={currency} floorId={filters.floor_id} onPoint={point=>showRecords({preset:'custom',date_from:point.start,date_to:point.end,dimension:point.id,currency})}/></Panel>:<AnalyticsBento data={data} filters={filters} update={update} onCompany={id=>go(`/(admin)/sales-data/profile/companies/${encodeURIComponent(id)}`)} onFloor={floor=>go(`/(admin)/sales-data/floor/${floor.floor_id}`,{floor_id:floor.floor_id,page:'1'})} onActivity={(point,code)=>showRecords({preset:'custom',date_from:point.start,date_to:point.end,dimension:point.id,currency:code})} onPoint={point=>showRecords({preset:'custom',date_from:point.start,date_to:point.end,dimension:point.id,currency})}/>}
  {operations}
  {!compact&&data.coverage.notes.length?<View style={{gap:6,paddingTop:8}}><Text accessibilityRole="header" aria-level={2} style={type.bodyStrong}>Sales basis & sources</Text><Text style={type.caption}>{data.coverage.notes.filter(note=>currency==='RNB'||!/RNB/.test(note)).join(' ')}</Text></View>:null}
  <Text style={type.caption}>Updated {new Date(data.generated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST · {data.period.label}</Text>
 </View>;
}
function RecentOrders({filters,go,enabled,revision}:{filters:FilterValues;go:Navigate;enabled:boolean;revision:number}) {
 const selected={...filters,page:'1',page_size:'5',sort:'date_desc'};
 const read=useAnalyticsRead(`recent:${revision}:${analyticsQuery(selected)}`,signal=>salesAnalyticsApi.records(selected,signal),enabled);
 return <Panel title="Recent transactions" description="Latest five matching customer orders" action={<Button label="View all" variant="ghost" onPress={()=>go('/(admin)/sales-data/records')}/>}>
  <ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>
  {read.data?.items.length?<EntityLedger valueLabel={filters.date_basis==='payment'?'Collected':'Sales'} testPrefix="analytics-recent" rows={read.data.items.map(order=>({id:order.id,name:order.number||order.id,detail:order.date?new Date(order.date).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'}):'Date unavailable',customer:order.customer_name||'Customer unavailable',department:FLOOR_NAMES[order.floor_id]||order.floor_id,status:order.status,value:analyticMoney(order.sales,order.currency)}))} onRow={id=>{const order=read.data!.items.find(item=>item.id===id)!;go(`/(admin)/sales-data/order/${encodeURIComponent(id)}`,order.source?{source:order.source}:{});}}/>:!read.loading&&!read.error?<Empty/>:null}
 </Panel>;
}
export function AnalyticsDashboard({operations}:{operations?:ReactNode;operationsRevision?:string}={}) {
 const {isPhone}=useBp(); const theme=useSalesTheme(); const [revision,setRevision]=useState(0);
 const scope=useAnalyticsScope(); const {filters,canView,go,update,floors}=scope;
 const read=useAnalyticsRead(analyticsQuery(filters),signal=>salesAnalyticsApi.dashboard(filters,signal),canView);
 const title=filters.floor_id==='all'?'Company overview':`${FLOOR_NAMES[filters.floor_id]||'Business unit'} overview`;
 return <AdminPage title={title} header={false} contentStyle={{gap:16,paddingTop:16,backgroundColor:theme.canvas}}><View testID="analytics-page" style={{gap:16,maxWidth:1440,width:'100%',alignSelf:'center'}}>
  <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:12}}>
   <Text accessibilityRole="header" aria-level={1} style={[type.titleLg,{fontSize:isPhone?24:28,lineHeight:34,color:theme.ink,fontWeight:'500'}]}>{title}</Text>
   <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:8}}><AnalyticsFilters filters={filters} update={update} floors={floors}/><ExportMenu compact={isPhone} filters={filters} view="dashboard"/><IconButton accessibilityLabel={read.loading?'Updating sales analytics':'Refresh sales analytics'} icon="refresh-cw" disabled={read.loading} onPress={()=>{read.refresh();setRevision(value=>value+1);}} tone="ghost"/></View>
  </View>
  {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:<><ReadState loading={read.loading&&!read.data} error={read.error||scope.accessError} retry={read.error?read.refresh:()=>void scope.retryAccess()}/>{read.data?<DashboardContent data={read.data} filters={filters} update={update} go={go} operations={<><RecentOrders filters={filters} go={go} enabled={canView} revision={revision}/>{operations}</>}/>:null}</>}
 </View></AdminPage>;
}
export function AnalyticsDashboardPreview({floorId}:{floorId:string}) {
 const router=useRouter(); const filters={floor_id:floorId,preset:'this_month',date_basis:'confirmation',granularity:'day'};
 const read=useAnalyticsRead(analyticsQuery(filters),signal=>salesAnalyticsApi.dashboard(filters,signal),!!floorId);
 const go=(path:string,next:FilterValues={})=>router.push(`${path}?${analyticsQuery({...filters,...next})}` as never);
 return <Panel title="Sales at a glance" action={<Button label="Open full analysis" variant="ghost" onPress={()=>go('/(admin)/sales-data')}/>}><ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>{read.data?<DashboardContent compact data={read.data} filters={filters} update={()=>{}} go={go}/>:null}</Panel>;
}
