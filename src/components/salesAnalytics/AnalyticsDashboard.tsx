import { useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, View, useWindowDimensions } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Rect } from 'react-native-svg';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button, IconButton } from '@/src/components/ui';
import { useBp } from '@/src/design/responsive';
import { useAuth } from '@/src/state/auth';
import { colors, spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsDashboardData, type AnalyticsEntity, type AnalyticsFilters as FilterValues, type AnalyticsKind } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { CollectionBalance, CustomerMix, SalesTrend } from './AnalyticsCharts';
import { analyticMoney, analyticNumber, linkActivation, BASIS_NAMES, Choice, DataLink, Empty, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { analyticEntityAmount, analyticsCurrency } from './currencyScope';
import { AnalyticsBento } from '@/src/components/ui/analytics-bento';
import { OwnerOperations } from './OwnerOperations';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';

type Navigate = (path:string,filters?:FilterValues)=>void;
function Metric({label,value,detail,onPress,testID,series,inline=false}:{label:string;value:string;detail:string;onPress:()=>void;testID:string;series?:(number|null)[];inline?:boolean}) {
 const {isPhone,isDesktop,width}=useBp();
 const {fontScale}=useWindowDimensions();
 const icon=testID==='analytics-kpi-sales'?'trending-up':testID==='analytics-kpi-orders'?'shopping-bag':testID==='analytics-kpi-customers'?'users':'bar-chart-2';
 return <Pressable testID={testID} accessibilityRole="link" {...linkActivation(onPress)} accessibilityLabel={`${label}: ${value}. Open supporting records`} onPress={onPress}
  style={({pressed,hovered}:any)=>({flexGrow:1,flexDirection:inline?'row':undefined,alignItems:inline?'center':undefined,flexBasis:inline?'100%':isPhone?(fontScale>1.3||testID==='analytics-kpi-sales'||width<360&&testID==='analytics-kpi-aov'?'100%':testID==='analytics-kpi-aov'?'44%':width<360?'44%':'20%'):!isDesktop?'45%':0,minWidth:0,padding:isPhone&&series?0:isPhone?spacing.s8:spacing.s12,gap:spacing.s8,borderBottomWidth:isPhone&&series?0:1,borderBottomColor:colors.border,backgroundColor:pressed||hovered?colors.surfaceTertiary:isPhone&&series?'transparent':colors.surfaceSecondary})}>
  <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s4,flex:inline?1:undefined,minWidth:0}}>{!inline&&(!series||!isPhone)?<Feather name={icon} size={14} color={colors.onSurfaceMuted} aria-hidden/>:null}<Text style={[inline?type.bodySm:type.caption,{flex:1}]}>{label}</Text>{!inline&&(!series||!isPhone)?<Feather name="arrow-up-right" size={12} color={colors.onSurfaceMuted} aria-hidden/>:null}</View>
  <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:spacing.s8}}><Text style={[type.titleLg,{fontSize:isPhone&&!series?18:22,lineHeight:isPhone&&!series?24:28,fontVariant:['tabular-nums'],fontWeight:'600',maxWidth:'100%'}]}>{value}</Text>{isPhone&&series?.some(v=>v!=null)?<Svg accessible={false} aria-hidden width={72} height={24} viewBox="0 0 72 24">{series.slice(-8).map((amount,i,values)=><Rect key={i} x={i*72/values.length} y={24-Math.max(0,amount||0)/Math.max(1,...values.map(v=>v||0))*24} width={Math.max(2,72/values.length-3)} height={Math.max(0,amount||0)/Math.max(1,...values.map(v=>v||0))*24} rx={2} fill={colors.brand}/>)}</Svg>:null}</View>
  {!isPhone?<Text style={type.caption}>{detail}</Text>:null}
 </Pressable>;
}
export function AnalyticsKpis({ data, go, subset='all' }: {data:AnalyticsDashboardData;go:(metric:string)=>void;subset?:'all'|'primary'|'secondary'}) {
 const {kpis}=data; const payment=data.filters.date_basis==='payment'; const currency=analyticsCurrency(data.filters.floor_id);
 const change=currency==='RNB'?kpis.change_pct_rnb:kpis.change_pct;
 return <View testID={subset==='secondary'?'analytics-kpis-secondary':'analytics-kpis'} style={{flexDirection:'row',flexWrap:'wrap',borderWidth:subset==='all'?1:0,borderColor:colors.border,borderRadius:12,overflow:'hidden',backgroundColor:subset==='primary'?'transparent':colors.surfaceSecondary}}>
  {subset!=='secondary'?<Metric label={data.metric_label||(payment?'Collected amount':'Confirmed sales')} testID="analytics-kpi-sales" series={data.trend.map(point=>currency==='RNB'?point.sales_rnb??null:point.sales)} value={analyticMoney(currency==='RNB'?kpis.sales_rnb:kpis.sales,currency)} detail={change==null?'Comparable growth unavailable':`${change>0?'+':''}${analyticNumber(change)}% vs previous period`} onPress={()=>go('sales')}/>:null}
  {subset!=='primary'?<>
  <Metric label={payment?'Orders with payments':'Confirmed orders'} inline={subset==='secondary'} testID="analytics-kpi-orders" value={analyticNumber(kpis.orders)} detail={data.floors.length>1?"Across accessible business units":"Unique customer orders"} onPress={()=>go('orders')}/>
  <Metric label={payment?'Paying customers':'Purchasing customers'} inline={subset==='secondary'} testID="analytics-kpi-customers" value={analyticNumber(kpis.customers)} detail="Distinct recorded customers" onPress={()=>go('customers')}/>
  <Metric label={payment?'Average collected':'Average order value'} inline={subset==='secondary'} testID="analytics-kpi-aov" value={analyticMoney(currency==='RNB'?kpis.average_order_value_rnb:kpis.average_order_value,currency)} detail={`${currency} per matching order`} onPress={()=>go('sales')}/>
  </>:null}
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
 const {isDesktop,isTabletLandscape}=useBp();
 const {fontScale}=useWindowDimensions();
 const sideBySide=(isDesktop||isTabletLandscape)&&fontScale<=1.3;
 return <View style={{flexDirection:sideBySide?'row':'column',alignItems:'stretch',gap:spacing.s16}}>{children.map((child,index)=><View key={index} style={{flex:sideBySide?1:undefined,minWidth:0}}>{child}</View>)}</View>;
}
export function DashboardContent({data,filters,update,go,compact=false,operations}:{data:AnalyticsDashboardData;filters:FilterValues;update:(filters:FilterValues)=>void;go:Navigate;compact?:boolean;operations?:ReactNode}) {
 const {isPhone}=useBp();
 const currency=analyticsCurrency(filters.floor_id);
 const showRecords=(next:FilterValues={})=>go('/(admin)/sales-data/records',{page:'1',...next});
 const onFloor=(floor:AnalyticsDashboardData['floors'][number])=>go(`/(admin)/sales-data/floor/${floor.floor_id}`,{floor_id:floor.floor_id,page:'1'});
 const furniture=data.floors.find(floor=>floor.floor_id==='third-floor');
 const trend=<Panel title={filters.date_basis==='payment'?'Collections over time':'Sales over time'} description={data.period.label} action={!compact?<Choice label="Time scale" value={filters.granularity} options={['day','month','quarter','year'].map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))} onChange={granularity=>update({granularity})} testID="analytics-granularity"/>:undefined}><SalesTrend points={data.trend} currency={currency} onPoint={point=>showRecords({preset:'custom',date_from:point.start,date_to:point.end,dimension:point.id,currency})}/></Panel>;
 return <View style={{gap:spacing.s16}}>
  <AnalyticsKpis data={data} subset={isPhone&&!compact?'primary':'all'} go={metric=>showRecords({metric,...(metric==='sales'?{currency}:{})})}/>
  {filters.date_basis!=='confirmation'?<Text style={type.bodySm}>{BASIS_NAMES[filters.date_basis]} · {data.metric_label||'Matching confirmed orders'}</Text>:null}
  {compact?trend:<AnalyticsBento data={data} filters={filters} update={update} onRecords={()=>showRecords({metric:'orders',currency})} onCompany={id=>go(`/(admin)/sales-data/profile/companies/${encodeURIComponent(id)}`)} onActivityPoint={point=>showRecords({preset:'custom',date_from:point.start,date_to:point.end,dimension:point.id,currency:''})} revenueFooter={isPhone?<AnalyticsKpis subset="secondary" data={data} go={metric=>showRecords({metric})}/>:undefined} onFloor={onFloor} onPoint={point=>showRecords({preset:'custom',date_from:point.start,date_to:point.end,dimension:point.id,currency})}/>}
  {!compact?<>
   {data.trend.some(point=>(currency==='RNB'?point.previous_sales_rnb:point.previous_sales)!=null)?<Panel title="Collections & balances" description="Recorded payments on the matching orders"><CollectionBalance collected={currency==='RNB'?data.kpis.collected_rnb:data.kpis.collected} outstanding={currency==='RNB'?data.kpis.outstanding_rnb:data.kpis.outstanding} currency={currency} onRecords={()=>showRecords({metric:'orders',currency})}/>{data.insights.slice(0,2).map(insight=><Text key={insight} style={type.bodySm}>{insight}</Text>)}</Panel>:null}
   {furniture&&filters.floor_id==='all'?<Panel title="Furniture" description="Furniture uses its own ledger" testID="analytics-furniture"><DataLink testID="analytics-floor-third-floor" label="Furniture sales" value={analyticMoney(furniture.sales,'RNB')} detail={`${analyticNumber(furniture.orders)} confirmed orders · ${analyticNumber(furniture.customers)} purchasing customers`} onPress={()=>onFloor(furniture)}/></Panel>:null}
   <Columns>{[<EntityRanking key="companies" title="Leading companies" kind="companies" rows={data.companies} go={go} floorId={filters.floor_id}/>,<EntityRanking key="products" title="Top products" kind="products" rows={data.products} go={go} floorId={filters.floor_id}/>]}</Columns>
   <Columns>{[<EntityRanking key="architects" title="Architect contribution" kind="architects" rows={data.architects} go={go} floorId={filters.floor_id}/>,<Panel key="mix" title="Customer mix" description="New and returning purchasing customers"><CustomerMix segments={data.customer_segments} onSegment={dimension=>showRecords({dimension,metric:'customers'})}/></Panel>]}</Columns>
   <EntityRanking title="Customer purchases" kind="customers" rows={data.customers} go={go} floorId={filters.floor_id}/>
   {data.attribute_breakdowns?Object.entries(data.attribute_breakdowns).filter(([,rows])=>rows.length>0).map(([dimension,rows])=><Panel key={dimension} title={`${dimension[0].toUpperCase()+dimension.slice(1)} analysis`}>{rows.slice(0,5).map(row=><DataLink key={row.id} label={row.name} value={analyticMoney(row.sales,currency)} detail={row.quantity==null?`${analyticNumber(row.orders)} orders`:`${analyticNumber(row.quantity)} ${row.unit||'units'}`} proportion={(row.sales||0)/Math.max(1,...rows.map(item=>item.sales||0))} onPress={()=>showRecords({[dimension]:row.id,dimension})}/>)}</Panel>):null}
   {operations}
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
 return <AdminPage title={title} header={false} contentStyle={{gap:spacing.s12,paddingTop:spacing.s12}}><View testID="analytics-page" style={{gap:spacing.s8,maxWidth:1440,width:'100%',alignSelf:'center'}}>
  <View style={{gap:spacing.s8}}><View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:spacing.s8}}><View style={{flex:1,minWidth:0,gap:spacing.s4}}><Text accessibilityRole="header" aria-level={1} style={[type.titleLg,{fontSize:isPhone?20:24,lineHeight:isPhone?28:32}]}>{title}</Text>{!isPhone?<Text style={type.bodySm}>Buildcon House · sales & team performance</Text>:null}</View><ExportMenu compact={isPhone} filters={filters} view="dashboard"/><IconButton accessibilityLabel={read.loading?'Updating sales analytics':'Refresh sales analytics'} icon="refresh-cw" disabled={read.loading} onPress={()=>{read.refresh();setRefreshVersion(v=>v+1);}} tone="ghost"/></View></View>
  <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s8}}><View style={{flex:1,minWidth:0}}><AnalyticsFilters filters={filters} update={update} floors={floors}/></View></View>
  {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:<><ReadState loading={read.loading&&!read.data} error={read.error||scope.accessError} retry={read.error?read.refresh:()=>void scope.retryAccess()}/>{read.data?<DashboardContent data={read.data} filters={filters} update={update} go={go} operations={work}/>:work}</>}
 </View></AdminPage>;
}
export function AnalyticsDashboardPreview({floorId}:{floorId:string}) {
 const router=useRouter(); const filters={floor_id:floorId,preset:'this_month',date_basis:'confirmation',granularity:'day'};
 const read=useAnalyticsRead(analyticsQuery(filters),signal=>salesAnalyticsApi.dashboard(filters,signal),!!floorId);
 const go=(path:string,next:FilterValues={})=>router.push(`${path}?${analyticsQuery({...filters,...next})}` as never);
 return <Panel title="Sales at a glance" action={<Button label="Open full analysis" variant="ghost" onPress={()=>go('/(admin)/sales-data')}/>}><ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>{read.data?<DashboardContent compact data={read.data} filters={filters} update={()=>{}} go={go}/>:null}</Panel>;
}
