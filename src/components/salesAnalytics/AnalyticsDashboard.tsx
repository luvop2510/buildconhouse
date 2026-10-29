import { useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button, IconButton } from '@/src/components/ui';
import { useBp } from '@/src/design/responsive';
import { useAuth } from '@/src/state/auth';
import { colors, spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsDashboardData, type AnalyticsEntity, type AnalyticsFilters as FilterValues, type AnalyticsKind } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { CustomerMix, FloorBars, FloorContribution, SalesTrend } from './AnalyticsCharts';
import { analyticMoney, analyticNumber, linkActivation, BASIS_NAMES, Choice, DataLink, Empty, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { analyticEntityAmount, analyticsCurrency } from './currencyScope';
import { OwnerOperations } from './OwnerOperations';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';

type Navigate = (path:string,filters?:FilterValues)=>void;
function Metric({label,value,detail,onPress,testID}:{label:string;value:string;detail:string;onPress:()=>void;testID:string}) {
 const {isPhone,isDesktop,width}=useBp();
 return <Pressable testID={testID} accessibilityRole="link" {...linkActivation(onPress)} accessibilityLabel={`${label}: ${value}. Open supporting records`} onPress={onPress}
  style={({pressed,hovered}:any)=>({flexGrow:1,flexBasis:!isDesktop?'45%':0,minWidth:0,padding:isPhone&&width<360?spacing.s12:spacing.s16,gap:spacing.s8,borderWidth:1,borderColor:colors.border,borderRadius:12,backgroundColor:pressed||hovered?colors.surfaceTertiary:colors.surfaceSecondary})}>
  <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s4}}><Text style={[type.bodySm,{flex:1}]}>{label}</Text><Feather name="arrow-up-right" size={16} color={colors.onSurfaceMuted} aria-hidden/></View>
  <Text style={[type.titleLg,{fontSize:isPhone?(width<360?16:18):26,lineHeight:isPhone?28:34,fontVariant:['tabular-nums'],fontWeight:'600'}]}>{value}</Text>
  {!isPhone?<Text style={type.caption}>{detail}</Text>:null}
 </Pressable>;
}
export function AnalyticsKpis({ data, go }: {data:AnalyticsDashboardData;go:(metric:string)=>void}) {
 const {kpis}=data; const payment=data.filters.date_basis==='payment'; const currency=analyticsCurrency(data.filters.floor_id);
 const change=currency==='RNB'?kpis.change_pct_rnb:kpis.change_pct;
 return <View testID="analytics-kpis" style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s12}}>
  <Metric label={data.metric_label||(payment?'Collected amount':'Confirmed sales')} testID="analytics-kpi-sales" value={analyticMoney(currency==='RNB'?kpis.sales_rnb:kpis.sales,currency)} detail={change==null?'Comparable growth unavailable':`${change>0?'+':''}${analyticNumber(change)}% vs previous period`} onPress={()=>go('sales')}/>
  <Metric label={payment?'Orders with payments':'Confirmed orders'} testID="analytics-kpi-orders" value={analyticNumber(kpis.orders)} detail={data.floors.length>1?"Across accessible business units":"Unique customer orders"} onPress={()=>go('orders')}/>
  <Metric label={payment?'Paying customers':'Purchasing customers'} testID="analytics-kpi-customers" value={analyticNumber(kpis.customers)} detail="Distinct recorded customers" onPress={()=>go('customers')}/>
  <Metric label={payment?'Average collected':'Average order value'} testID="analytics-kpi-aov" value={analyticMoney(currency==='RNB'?kpis.average_order_value_rnb:kpis.average_order_value,currency)} detail={`${currency} per matching order`} onPress={()=>go('sales')}/>
 </View>;
}
export function EntityRanking({title,kind,rows,go,all=false,floorId}:{title:string;kind:AnalyticsKind;rows:AnalyticsEntity[];go:Navigate;all?:boolean;floorId?:string}) {
 const currency=analyticsCurrency(floorId);
 const visible=rows.filter(row=>floorId==='third-floor'||!row.floor_ids?.length||row.floor_ids.some(id=>id!=='third-floor')).slice(0,all?100:5);
 const max=Math.max(1,...visible.map(row=>analyticEntityAmount(row,floorId)||0));
 return <Panel title={title} action={!all?<Button label="View all" variant="ghost" onPress={()=>go(`/(admin)/sales-data/${kind}`)}/>:undefined}>
  {visible.length?visible.map(row=><DataLink key={row.id} label={row.name} detail={row.detail||`${analyticNumber(row.orders)} orders${row.customers!=null?` · ${analyticNumber(row.customers)} customers`:''}`} value={analyticMoney(analyticEntityAmount(row,floorId),currency)} proportion={analyticEntityAmount(row,floorId)==null?undefined:(analyticEntityAmount(row,floorId)||0)/max} testID={`analytics-entity-${row.id}`} onPress={()=>go(`/(admin)/sales-data/profile/${kind}/${encodeURIComponent(row.id)}`)}/>):<Empty text={`No attributable ${kind} sales in this range.`}/>}
 </Panel>;
}
function Columns({children}:{children:ReactNode[]}) {
 const {isDesktop}=useBp();
 return <View style={{flexDirection:isDesktop?'row':'column',alignItems:'stretch',gap:spacing.s16}}>{children.map((child,index)=><View key={index} style={{flex:isDesktop?1:undefined,minWidth:0}}>{child}</View>)}</View>;
}
export function DashboardContent({data,filters,update,go,compact=false,operations}:{data:AnalyticsDashboardData;filters:FilterValues;update:(filters:FilterValues)=>void;go:Navigate;compact?:boolean;operations?:ReactNode}) {
 const {isDesktop}=useBp();
 const currency=analyticsCurrency(filters.floor_id);
 const showRecords=(next:FilterValues={})=>go('/(admin)/sales-data/records',{page:'1',...next});
 const onFloor=(floor:AnalyticsDashboardData['floors'][number])=>go(`/(admin)/sales-data/floor/${floor.floor_id}`,{floor_id:floor.floor_id,page:'1'});
 const inr=data.floors.filter(floor=>floor.currency!=='RNB');
 const furniture=data.floors.find(floor=>floor.floor_id==='third-floor');
 const trend=<Panel title={filters.date_basis==='payment'?'Collections over time':'Sales over time'} description={data.period.label} action={!compact?<Choice label="Time scale" value={filters.granularity} options={['day','month','quarter','year'].map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))} onChange={granularity=>update({granularity})} testID="analytics-granularity"/>:undefined}><SalesTrend points={data.trend} currency={currency} onPoint={point=>showRecords({preset:'custom',date_from:point.start,date_to:point.end,dimension:point.id,currency})}/></Panel>;
 return <View style={{gap:spacing.s16}}>
  <AnalyticsKpis data={data} go={metric=>showRecords({metric,...(metric==='sales'?{currency}:{})})}/>
  {filters.date_basis!=='confirmation'?<Text style={type.bodySm}>{BASIS_NAMES[filters.date_basis]} · {data.metric_label||'Matching confirmed orders'}</Text>:null}
  <View style={{flexDirection:isDesktop&&!compact?'row':'column',gap:spacing.s16,alignItems:'stretch'}}><View style={{flex:isDesktop&&!compact?1.8:undefined,minWidth:0}}>{trend}</View>{!compact&&currency==='INR'?<View style={{flex:isDesktop?1:undefined,minWidth:0}}><Panel title="Business contribution" description="Share of confirmed INR sales"><FloorContribution floors={inr} onFloor={onFloor}/></Panel></View>:null}</View>
  {!compact?<>
   <Columns>{[<Panel key="floors" title={currency==='RNB'?'Furniture performance':'Business unit performance'} description="Compare recorded sales, orders and customers"><FloorBars floors={currency==='RNB'?data.floors:inr} onFloor={onFloor}/></Panel>,<Panel key="collection" title="Collections & balances" description="Recorded payments on the matching orders"><DataLink label="Collected" value={analyticMoney(currency==='RNB'?data.kpis.collected_rnb:data.kpis.collected,currency)} onPress={()=>showRecords({metric:'orders',currency})}/><DataLink label="Outstanding" value={analyticMoney(currency==='RNB'?data.kpis.outstanding_rnb:data.kpis.outstanding,currency)} onPress={()=>showRecords({metric:'orders',currency})}/><Text style={type.caption}>Balances reflect the source records at the latest update. Missing payment history remains unavailable.</Text>{data.insights.slice(0,2).map(insight=><Text key={insight} style={type.bodySm}>{insight}</Text>)}</Panel>]}</Columns>
   {furniture&&filters.floor_id==='all'?<Panel title="Furniture" description="Furniture uses its own ledger" testID="analytics-furniture"><DataLink testID="analytics-floor-third-floor" label="Furniture sales" value={analyticMoney(furniture.sales,'RNB')} detail={`${analyticNumber(furniture.orders)} confirmed orders · ${analyticNumber(furniture.customers)} purchasing customers`} onPress={()=>onFloor(furniture)}/></Panel>:null}
   {operations}
   <Columns>{[<EntityRanking key="companies" title="Leading companies" kind="companies" rows={data.companies} go={go} floorId={filters.floor_id}/>,<EntityRanking key="products" title="Top products" kind="products" rows={data.products} go={go} floorId={filters.floor_id}/>]}</Columns>
   <Columns>{[<EntityRanking key="architects" title="Architect contribution" kind="architects" rows={data.architects} go={go} floorId={filters.floor_id}/>,<Panel key="mix" title="Customer mix" description="New and returning purchasing customers"><CustomerMix segments={data.customer_segments} onSegment={dimension=>showRecords({dimension,metric:'customers'})}/></Panel>]}</Columns>
   <EntityRanking title="Customer purchases" kind="customers" rows={data.customers} go={go} floorId={filters.floor_id}/>
   {data.attribute_breakdowns?Object.entries(data.attribute_breakdowns).filter(([,rows])=>rows.length>0).map(([dimension,rows])=><Panel key={dimension} title={`${dimension[0].toUpperCase()+dimension.slice(1)} analysis`}>{rows.slice(0,5).map(row=><DataLink key={row.id} label={row.name} value={analyticMoney(row.sales,currency)} detail={row.quantity==null?`${analyticNumber(row.orders)} orders`:`${analyticNumber(row.quantity)} ${row.unit||'units'}`} proportion={(row.sales||0)/Math.max(1,...rows.map(item=>item.sales||0))} onPress={()=>showRecords({[dimension]:row.id,dimension})}/>)}</Panel>):null}
   {data.coverage.notes.length?<Panel title="About this data"><Text style={type.bodySm}>{data.coverage.notes.filter(note=>currency==='RNB'||!/RNB/.test(note)).join('\n\n')}</Text></Panel>:null}
  </>:null}
  <Text style={type.caption}>Updated {new Date(data.generated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST · {data.period.label}</Text>
 </View>;
}
export function AnalyticsDashboard({operations,operationsRevision=''}:{operations?:ReactNode;operationsRevision?:string}={}) {
 const {staff}=useAuth(); const {isPhone}=useBp(); const [refreshVersion,setRefreshVersion]=useState(0);
 const scope=useAnalyticsScope(); const {filters,canView,go,update,floors}=scope;
 const read=useAnalyticsRead(analyticsQuery(filters),signal=>salesAnalyticsApi.dashboard(filters,signal),canView);
 const title=filters.floor_id==='all'?'Company overview':`${FLOOR_NAMES[filters.floor_id]||'Business unit'} overview`;
 const work=<>{staff?.role==='owner'?<OwnerOperations floorId={filters.floor_id} refreshVersion={`${refreshVersion}:${operationsRevision}`}/>:null}{operations}</>;
 return <AdminPage title={title} header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}><View testID="analytics-page" style={{gap:spacing.s16,maxWidth:1440,width:'100%',alignSelf:'center'}}>
  <View style={{gap:spacing.s8}}><View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:spacing.s8}}><View style={{flex:1,minWidth:0,gap:spacing.s4}}><Text accessibilityRole="header" aria-level={1} style={[type.titleLg,{fontSize:isPhone?24:28,lineHeight:isPhone?32:36}]}>{title}</Text><Text style={type.bodySm}>{isPhone?'Buildcon House':'Buildcon House · sales & team performance'}</Text></View><IconButton accessibilityLabel={read.loading?'Updating sales analytics':'Refresh sales analytics'} icon="refresh-cw" disabled={read.loading} onPress={()=>{read.refresh();setRefreshVersion(v=>v+1);}} tone="ghost"/></View></View>
  <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s8}}><View style={{flex:1,minWidth:0}}><AnalyticsFilters filters={filters} update={update} floors={floors}/></View><ExportMenu filters={filters} view="dashboard"/></View>
  {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:<><ReadState loading={read.loading&&!read.data} error={read.error||scope.accessError} retry={read.error?read.refresh:()=>void scope.retryAccess()}/>{read.data?<DashboardContent data={read.data} filters={filters} update={update} go={go} operations={work}/>:work}</>}
 </View></AdminPage>;
}
export function AnalyticsDashboardPreview({floorId}:{floorId:string}) {
 const router=useRouter(); const filters={floor_id:floorId,preset:'this_month',date_basis:'confirmation',granularity:'day'};
 const read=useAnalyticsRead(analyticsQuery(filters),signal=>salesAnalyticsApi.dashboard(filters,signal),!!floorId);
 const go=(path:string,next:FilterValues={})=>router.push(`${path}?${analyticsQuery({...filters,...next})}` as never);
 return <Panel title="Sales at a glance" action={<Button label="Open full analysis" variant="ghost" onPress={()=>go('/(admin)/sales-data')}/>}><ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>{read.data?<DashboardContent compact data={read.data} filters={filters} update={()=>{}} go={go}/>:null}</Panel>;
}
