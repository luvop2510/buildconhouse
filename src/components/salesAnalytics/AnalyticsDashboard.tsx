import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button, IconButton } from '@/src/components/ui';
import { Banner } from '@/src/components/ui/Banner';
import { useBp } from '@/src/design/responsive';
import { colors, spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsDashboardData, type AnalyticsEntity, type AnalyticsFilters as FilterValues, type AnalyticsKind } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { FloorBars, FloorContribution, SalesTrend } from './AnalyticsCharts';
import { analyticMoney, analyticNumber, linkActivation, BASIS_NAMES, Choice, DataLink, Empty, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';

function AnalyticsMetric({label,value,secondaryValue,detail,onPress,testID,money=false}:{label:string;value:string;secondaryValue?:string;detail:string;onPress:()=>void;testID:string;money?:boolean}) {
 const {isPhone,isTabletPortrait}=useBp(); const compact=isPhone||isTabletPortrait;
 return <Pressable testID={testID} accessibilityRole="link" {...linkActivation(onPress)} accessibilityLabel={`${label}: ${value}${secondaryValue?` and ${secondaryValue}`:''}. Open supporting records`} onPress={onPress}
 style={({pressed,hovered}:any)=>({flexGrow:1,flexBasis:compact?(money?'100%':'50%'):0,minWidth:0,padding:spacing.s12,gap:spacing.s4,borderBottomWidth:compact?1:0,borderBottomColor:colors.border,backgroundColor:pressed||hovered?colors.surfaceTertiary:'transparent'})}>
 <Text style={type.bodySm}>{label}</Text>
 <View style={{flexDirection:'row',flexWrap:'wrap',alignItems:'baseline',gap:spacing.s12}}><Text style={[type.titleLg,{fontSize:compact?22:24,lineHeight:compact?28:32,fontVariant:['tabular-nums'],fontWeight:'500'}]}>{value}</Text>{secondaryValue?<Text style={[type.bodyStrong,{fontVariant:['tabular-nums']}]}>{secondaryValue}</Text>:null}</View>
 {!compact?<Text style={type.caption}>{detail}</Text>:null}
 </Pressable>;
}
export function AnalyticsKpis({ data, go }: {data:AnalyticsDashboardData;go:(metric:string)=>void}) {
 const { kpis }=data; const payment=data.filters.date_basis==='payment'; const currency=data.floors.length===1&&data.floors[0].currency==='RNB'?'RNB':'INR';
 return <View testID="analytics-kpis" style={{flexDirection:'row',flexWrap:'wrap',backgroundColor:colors.surfaceSecondary,borderWidth:1,borderColor:colors.border,borderRadius:8,overflow:'hidden'}}>
 <AnalyticsMetric money label={data.metric_label || (payment ? "Collected amount" : "Confirmed sales")} testID="analytics-kpi-sales" value={analyticMoney(currency==='RNB'?kpis.sales_rnb:kpis.sales,currency)} secondaryValue={currency==='INR' && data.floors.some(f=>f.currency==='RNB') ? analyticMoney(kpis.sales_rnb,'RNB') : undefined} detail={payment ? "Recorded customer payments" : "Confirmed customer orders"} onPress={()=>go('sales')} />
 <AnalyticsMetric label={payment ? "Orders with payments" : "Confirmed orders"} testID="analytics-kpi-orders" value={analyticNumber(kpis.orders)} detail="Unique customer orders" onPress={()=>go('orders')} />
 <AnalyticsMetric label={payment ? "Paying customers" : "Purchasing customers"} testID="analytics-kpi-customers" value={analyticNumber(kpis.customers)} detail="Distinct recorded identities" onPress={()=>go('customers')} />
 <AnalyticsMetric money label={payment ? "Average collected per order" : "Average order value"} testID="analytics-kpi-aov" value={analyticMoney(currency==='RNB'?kpis.average_order_value_rnb:kpis.average_order_value,currency)} secondaryValue={currency==='INR'&&data.floors.some(f=>f.currency==='RNB')?analyticMoney(kpis.average_order_value_rnb,'RNB'):undefined} detail={payment ? "Collections ÷ paying orders" : "Sales ÷ unique orders"} onPress={()=>go('orders')} />
 </View>;
}
export function EntityRanking({ title, kind, rows, go, all = false }: {title:string;kind:AnalyticsKind;rows:AnalyticsEntity[];go:(path:string,filters?:FilterValues)=>void;all?:boolean}) {
 return <Panel title={title} action={!all?<Button label="View all" variant="ghost" onPress={()=>go(`/(admin)/sales-data/${kind}`)} />:undefined}>
 {rows.length?rows.slice(0,all?100:5).map(row=><DataLink key={row.id} label={row.name} detail={row.detail || `${analyticNumber(row.orders)} orders${row.customers!=null?` · ${analyticNumber(row.customers)} customers`:''}`} value={analyticMoney(row.sales)} secondary={row.sales_rnb?analyticMoney(row.sales_rnb,'RNB'):undefined} proportion={row.sales!=null && rows.reduce((sum,item)=>sum+(item.sales||0),0)>0?row.sales/rows.reduce((sum,item)=>sum+(item.sales||0),0):undefined} testID={`analytics-entity-${row.id}`} onPress={()=>go(`/(admin)/sales-data/profile/${kind}/${encodeURIComponent(row.id)}`)} />):<Empty text={`No ${kind} with attributable sales in this range. Unlinked historical data is not estimated.`} />}
 </Panel>;
}
export function DashboardContent({ data, filters, update, go, compact=false }: {data:AnalyticsDashboardData;filters:FilterValues;update:(filters:FilterValues)=>void;go:(path:string,filters?:FilterValues)=>void;compact?:boolean}) {
 const {isDesktop}=useBp();
 const currency=filters.floor_id==='third-floor'?'RNB':'INR';
 const showRecords=(next:FilterValues={})=>go('/(admin)/sales-data/records',{page:'1',...next});
 const trend=<Panel title={filters.date_basis==='payment'?'Collections by payment date':compact?'Confirmed sales trend':'Sales over time'} action={!compact?<View style={{minWidth:120}}><Choice label="Time scale" value={filters.granularity} options={['day','month','quarter','year'].map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))} onChange={granularity=>update({granularity})} testID="analytics-granularity" /></View>:undefined}><SalesTrend points={data.trend} currency={currency} onPoint={point=>showRecords({preset:'custom',date_from:point.start,date_to:point.end,dimension:point.id})} /></Panel>;
 return <View style={{gap:spacing.s16}}>
 <AnalyticsKpis data={data} go={metric=>showRecords({metric})} />
 {filters.date_basis!=='confirmation'?<Banner message={`${BASIS_NAMES[filters.date_basis]} selects the matching source dates. Quotation values and collections are not counted as confirmed sales.`}/>:null}
 {compact?trend:<>
 <View style={{flexDirection:isDesktop?'row':'column',alignItems:'flex-start',gap:spacing.s16}}><View style={{flex:2,minWidth:0,alignSelf:'stretch'}}>{trend}</View><View style={{flex:1,minWidth:0,alignSelf:'stretch'}}><Panel title="Sales by business unit"><FloorContribution floors={data.floors} onFloor={floor=>go(`/(admin)/sales-data/floor/${floor.floor_id}`,{floor_id:floor.floor_id,page:'1'})} /></Panel></View></View>
 <View style={{flexDirection:isDesktop?'row':'column',alignItems:'flex-start',gap:spacing.s16}}><View style={{flex:1,minWidth:0,alignSelf:'stretch'}}><EntityRanking title="Company / brand contribution" kind="companies" rows={data.companies} go={go}/></View><View style={{flex:1,minWidth:0,alignSelf:'stretch'}}><EntityRanking title="Architect ranking" kind="architects" rows={data.architects} go={go}/></View><View style={{flex:1,minWidth:0,alignSelf:'stretch'}}><EntityRanking title="Top products" kind="products" rows={data.products} go={go}/></View></View>
 {data.attribute_breakdowns?<View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s16}}>{Object.entries(data.attribute_breakdowns).filter(([dimension,rows])=>rows.length>0||filters.floor_id==='ground-floor'||filters.floor_id==='first-floor'&&dimension==='category').map(([dimension,rows])=><View key={dimension} style={{flexGrow:1,flexBasis:isDesktop?'45%':'100%',minWidth:0}}><Panel title={`${dimension[0].toUpperCase()+dimension.slice(1)} analysis`}>{rows.length?rows.slice(0,10).map(row=><DataLink key={row.id} label={row.name} value={analyticMoney(row.sales,currency)} detail={row.quantity==null?`${analyticNumber(row.orders)} orders`:`${analyticNumber(row.quantity)} ${row.unit||'units'}`} onPress={()=>showRecords({[dimension]:row.id,dimension})}/>):<Empty text={`Recorded ${dimension} attributes are unavailable in this scope.`}/>}</Panel></View>)}</View>:null}
 <Panel title="Sales by floor"><FloorBars floors={data.floors} onFloor={floor=>go(`/(admin)/sales-data/floor/${floor.floor_id}`,{floor_id:floor.floor_id})}/></Panel>
 <Panel title="Floor comparison"><Text style={type.caption}>Sales · orders · purchasing customers · average order value · contribution. RNB totals are kept separate.</Text>{data.floors.map(floor=><DataLink key={floor.id} label={floor.name} detail={`${analyticNumber(floor.orders)} orders · ${analyticNumber(floor.customers)} customers · AOV ${analyticMoney(floor.average_order_value,floor.currency)} · ${floor.contribution_pct==null?'Contribution unavailable':`${analyticNumber(floor.contribution_pct)}% contribution`}`} value={analyticMoney(floor.sales,floor.currency)} onPress={()=>go(`/(admin)/sales-data/floor/${floor.floor_id}`,{floor_id:floor.floor_id})} testID={`analytics-comparison-${floor.floor_id}`} />)}{!data.floors.length?<Empty/>:null}</Panel>
 <View style={{flexDirection:isDesktop?'row':'column',gap:spacing.s16}}><View style={{flex:1,minWidth:0}}><EntityRanking title="Customer purchases" kind="customers" rows={data.customers} go={go}/></View><View style={{flex:1,minWidth:0}}><Panel title="New and repeat customers">{data.customer_segments.length?data.customer_segments.map(segment=><DataLink key={segment.id} label={segment.name} value={analyticNumber(segment.customers)} onPress={()=>showRecords({dimension:segment.id,metric:'customers'})}/>):<Empty text="Customer purchase history is unavailable for this comparison."/>}</Panel><View style={{height:spacing.s16}}/><Panel title="Data brief">{data.insights.length?data.insights.map((insight,index)=><Text key={index} style={type.body}>{insight}</Text>):<Text style={type.bodyMuted}>There is not enough comparable recorded data to describe a trend.</Text>}</Panel></View></View>
 </>}
 {data.coverage.notes.length?<Banner id={compact?undefined:'sales-analytics-coverage'}><View style={{gap:spacing.s4}}>{data.coverage.notes.map(note=><Text key={note} style={type.bodySm}>{note}</Text>)}</View></Banner>:null}
 <Text style={type.caption}>Updated {new Date(data.generated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST · {data.period.label}</Text>
 </View>;
}
export function AnalyticsDashboard() {
 const {isPhone}=useBp();
 const scope=useAnalyticsScope(); const {filters,canView,go,update,floors}=scope;
 const key=analyticsQuery(filters); const read=useAnalyticsRead(key,signal=>salesAnalyticsApi.dashboard(filters,signal),canView);
 const title=filters.floor_id==='all'?'Overall sales data':`${FLOOR_NAMES[filters.floor_id]||'Business unit'} analysis`;
 return <AdminPage title={title} header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}><View testID="analytics-page" style={{gap:spacing.s16}}>
 <View style={{gap:spacing.s8}}><Text accessibilityRole="header" aria-level={1} style={type.displayMd}>{title}</Text><View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:spacing.s8}}><Text style={[type.bodyMuted,{flex:1,minWidth:0}]}>{isPhone?'Buildcon House':'Buildcon House · confirmed customer sales'}</Text><ExportMenu filters={filters} view="dashboard"/><IconButton accessibilityLabel={read.loading?'Updating sales analytics':'Refresh sales analytics'} icon="refresh-cw" disabled={read.loading} onPress={read.refresh} tone="ghost"/></View></View>
 <AnalyticsFilters filters={filters} update={update} floors={floors}/>
 {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:<><ReadState loading={read.loading&&!read.data} error={read.error||scope.accessError} retry={read.error?read.refresh:()=>void scope.retryAccess()}/>{read.data?<DashboardContent data={read.data} filters={filters} update={update} go={go}/>:null}</>}
 </View></AdminPage>;
}
export function AnalyticsDashboardPreview({floorId}:{floorId:string}) {
 const router=useRouter(); const filters={floor_id:floorId,preset:'this_month',date_basis:'confirmation',granularity:'day'}; const key=analyticsQuery(filters);
 const read=useAnalyticsRead(key,signal=>salesAnalyticsApi.dashboard(filters,signal),!!floorId);
 const go=(path:string,next:FilterValues={})=>router.push(`${path}?${analyticsQuery({...filters,...next})}` as never);
 return <Panel title="Sales at a glance" action={<Button label="Open full analysis" variant="ghost" onPress={()=>go('/(admin)/sales-data')}/>}><ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>{read.data?<DashboardContent compact data={read.data} filters={filters} update={()=>{}} go={go}/>:null}</Panel>;
}
