import { useState } from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Polyline, Rect } from 'react-native-svg';
import { Text } from '@/src/components/AppText';
import { Button } from '@/src/components/ui';
import { type } from '@/src/theme/tokens';
import type { AnalyticsDashboardData, AnalyticsFilters, AnalyticsFloor, AnalyticsTrend } from '@/src/api/salesAnalytics';
import { analyticMoney, analyticNumber, DataLink, Empty, linkActivation, Panel } from './AnalyticsParts';
import { analyticEntityAmount, analyticsCurrency } from './currencyScope';
import { averageForBucket, currencyOrders } from './visualMetrics';
import { useSalesTheme } from './salesTheme';
import { DatedColumns, RankedBars } from './SalesGraphs';

function Amount({value,large=false,onMeasure}:{value:string;large?:boolean;onMeasure?:(width:number)=>void}) {
 const theme=useSalesTheme();
 return <ScrollView horizontal showsHorizontalScrollIndicator style={{flexGrow:0,maxWidth:'100%'}}><Text onLayout={event=>onMeasure?.(event.nativeEvent.layout.width)} style={[type.titleLg,{alignSelf:'flex-start',fontSize:large?28:20,lineHeight:large?36:28,fontWeight:'600',color:large?theme.accent:theme.ink,fontVariant:['tabular-nums'],...(Platform.OS==='web'?{whiteSpace:'nowrap'} as never:{})}]}>{value}</Text></ScrollView>;
}

/** Small charts use the same recorded buckets as the full chart, including gaps. */
export function MiniTrend({values,bars=false,label}:{values:(number|null|undefined)[];bars?:boolean;label:string}) {
 const theme=useSalesTheme();
 const series=values.slice(-12).map(value=>value!=null&&Number.isFinite(value)?value:null);
 const maximum=Math.max(1,...series.map(value=>value??0));
 const minimum=Math.min(0,...series.map(value=>value??0));
 const y=(value:number)=>30-(value-minimum)/(maximum-minimum)*28;
 const x=(index:number)=>(index+.5)*240/Math.max(1,series.length);
 const paths:number[][]=[];
 let run:number[]=[];
 series.forEach((value,index)=>{if(value==null||!Number.isFinite(value)){if(run.length)paths.push(run);run=[];}else run.push(x(index),y(value));});
 if(run.length)paths.push(run);
 return <View accessible accessibilityLabel={`${label}. ${series.map(value=>value==null?'Unavailable':analyticNumber(value)).join(', ')}`} style={{height:32}}>
  <Svg width="100%" height={32} viewBox="0 0 240 32" preserveAspectRatio="none" accessible={false} aria-hidden>
   {bars?series.map((value,index)=>value==null?null:<Rect key={index} x={x(index)-Math.min(9,90/series.length)} y={Math.min(y(0),y(value))} width={Math.min(18,180/series.length)} height={Math.max(value===0?1:0,Math.abs(y(value)-y(0)))} rx={2} fill={theme.accent} opacity={index===series.length-1?1:.45}/>):paths.map((path,index)=>path.length===2?<Circle key={index} cx={path[0]} cy={path[1]} r={2} fill={theme.accent}/>:<Polyline key={index} points={Array.from({length:path.length/2},(_,i)=>`${path[i*2]},${path[i*2+1]}`).join(' ')} fill="none" stroke={theme.accent} strokeWidth={2} vectorEffect="non-scaling-stroke"/>)}
  </Svg>
 </View>;
}

export function SalesHero({data,currency,onRecords}:{data:AnalyticsDashboardData;currency:string;onRecords:()=>void}) {
 const theme=useSalesTheme(); const {kpis}=data;
 const collected=currency==='RNB'?kpis.collected_rnb:kpis.collected;
 const outstanding=currency==='RNB'?kpis.outstanding_rnb:kpis.outstanding;
 const change=currency==='RNB'?kpis.change_pct_rnb:kpis.change_pct;
 return <Panel title="Sales summary" description={data.period.label} testID="analytics-sales-hero">
  <Pressable testID="analytics-kpi-sales" accessibilityRole="link" {...linkActivation(onRecords)} accessibilityLabel={`${data.metric_label||'Confirmed sales'}: ${analyticMoney(currency==='RNB'?kpis.sales_rnb:kpis.sales,currency)}. Open supporting records`} onPress={onRecords} style={({pressed,hovered}:any)=>({gap:8,minHeight:64,backgroundColor:pressed||hovered?theme.tint:theme.surface})}>
   <Text style={type.bodySm}>{data.metric_label||'Confirmed sales'}</Text>
   <Amount large value={analyticMoney(currency==='RNB'?kpis.sales_rnb:kpis.sales,currency)}/>
   <Text style={type.caption}>{change==null?'Previous period unavailable':`${change>0?'+':''}${analyticNumber(change)}% vs previous period`}</Text>
  </Pressable>
  <View testID="analytics-collection-balance" style={{gap:4,paddingTop:8,borderTopWidth:1,borderTopColor:theme.line}}>
   <RankedBars compact label={`Current ${currency} balances on selected orders`} rows={[{id:'collected',label:'Collected',value:collected,formatted:analyticMoney(collected,currency),onPress:onRecords},{id:'outstanding',label:'Outstanding',value:outstanding,formatted:analyticMoney(outstanding,currency),onPress:onRecords}]}/>

   <Text style={type.caption}>Current recorded balances on the selected orders</Text>
  </View>
 </Panel>;
}

function VisualMetric({label,value,detail,testID,onPress,monetary=false,gridWidth,children}:{label:string;value:string;detail:string;testID:string;onPress:()=>void;monetary?:boolean;gridWidth:number;children?:import('react').ReactNode}) {
 const theme=useSalesTheme(); const {fontScale}=useWindowDimensions();
 const [amountWidth,setAmountWidth]=useState(0);
 const columns=gridWidth>=1000&&fontScale<=1.3?4:2;
 const fullWidth=fontScale>1.3||monetary&&(amountWidth||value.length*11)>(gridWidth-12*(columns-1))/columns-32;
 return <Pressable testID={testID} accessibilityRole="link" {...linkActivation(onPress)} accessibilityLabel={`${label}: ${value}. ${detail}. Open supporting records`} onPress={onPress} style={({pressed,hovered}:any)=>({flexGrow:1,flexBasis:fullWidth?(columns===4?'45%':'100%'):(columns===4?'22%':'45%'),minWidth:0,padding:16,gap:8,borderRadius:16,borderWidth:1,borderColor:theme.line,justifyContent:'center',backgroundColor:pressed||hovered?theme.tint:theme.surface})}>
  <Text style={[type.bodySm,{fontWeight:'500'}]}>{label}</Text><Amount value={value} onMeasure={monetary?setAmountWidth:undefined}/>
  {children}<Text style={type.caption}>{detail}</Text>
 </Pressable>;
}

export function VisualKpis({data,filters,go}:{data:AnalyticsDashboardData;filters:AnalyticsFilters;go:(metric:string,currency?:string)=>void}) {
 const [gridWidth,setGridWidth]=useState(300);
 const currency=analyticsCurrency(filters.floor_id); const payment=filters.date_basis==='payment';
 const {kpis}=data;
 const furniture=filters.floor_id==='all'?data.floors.find(floor=>floor.currency==='RNB'):undefined;
 const asRows=(values:(number|null|undefined)[],money=false,code=currency)=>data.trend.map((point,index)=>({id:point.id,label:point.label,value:values[index],formatted:money?analyticMoney(values[index],code):analyticNumber(values[index])}));
 const orderRows=asRows(data.trend.map(point=>point.orders));
 const averageRows=asRows(data.trend.map(point=>averageForBucket(currency==='RNB'?point.sales_rnb:point.sales,currencyOrders(point,currency,filters.floor_id))),true);
 const segmentRows=data.customer_segments.map(row=>({id:row.id,label:row.name,value:kpis.customers==null?null:row.customers,formatted:analyticNumber(kpis.customers==null?null:row.customers)}));
 return <View testID="analytics-kpis" onLayout={event=>setGridWidth(event.nativeEvent.layout.width)} style={{width:'100%',flexShrink:0,flexDirection:'row',flexWrap:'wrap',gap:12,alignItems:'stretch'}}>
  <VisualMetric gridWidth={gridWidth} label={payment?'Orders with payments':'Confirmed orders'} value={analyticNumber(kpis.orders)} detail="Latest dated order counts" testID="analytics-kpi-orders" onPress={()=>go('orders')}><DatedColumns label="Order counts by date" rows={orderRows}/></VisualMetric>
  <VisualMetric gridWidth={gridWidth} label={payment?'Paying customers':'Purchasing customers'} value={analyticNumber(kpis.customers)} detail="Customers by purchase history" testID="analytics-kpi-customers" onPress={()=>go('customers')}><RankedBars compact label="Customer purchase history" rows={segmentRows}/></VisualMetric>
  <VisualMetric gridWidth={gridWidth} monetary label={payment?'Average collected':'Average order value'} value={analyticMoney(currency==='RNB'?kpis.average_order_value_rnb:kpis.average_order_value,currency)} detail={`${currency} per matching order over time`} testID="analytics-kpi-aov" onPress={()=>go('sales',currency)}><DatedColumns label={`Average amount per order in ${currency}`} rows={averageRows}/></VisualMetric>
  {furniture?<VisualMetric gridWidth={gridWidth} monetary label="Furniture sales (RNB)" value={analyticMoney(furniture.sales,'RNB')} detail="Separate currency ledger" testID="analytics-furniture" onPress={()=>go('sales','RNB')}><DatedColumns label="Furniture sales in RNB" rows={asRows(data.trend.map(point=>point.sales_rnb),true,'RNB')}/></VisualMetric>:<VisualMetric gridWidth={gridWidth} monetary label="Collected and outstanding" value={analyticMoney(currency==='RNB'?kpis.outstanding_rnb:kpis.outstanding,currency)} detail="Current balance on selected orders" testID="analytics-kpi-outstanding" onPress={()=>go('sales',currency)}><RankedBars compact label="Current balances" rows={[{id:'collected',label:'Collected',value:currency==='RNB'?kpis.collected_rnb:kpis.collected,formatted:analyticMoney(currency==='RNB'?kpis.collected_rnb:kpis.collected,currency)},{id:'outstanding',label:'Outstanding',value:currency==='RNB'?kpis.outstanding_rnb:kpis.outstanding,formatted:analyticMoney(currency==='RNB'?kpis.outstanding_rnb:kpis.outstanding,currency)}]}/></VisualMetric>}
 </View>;
}

export function SalesDistribution({data,filters,onFloor,onCompany}:{data:AnalyticsDashboardData;filters:AnalyticsFilters;onFloor:(floor:AnalyticsFloor)=>void;onCompany:(id:string)=>void}) {
 const currency=analyticsCurrency(filters.floor_id);
 const overall=filters.floor_id==='all';
 const rows=overall?data.floors.filter(row=>row.currency===currency).map(row=>({id:row.id,name:row.name,value:row.sales,onPress:()=>onFloor(row),testID:`analytics-floor-${row.floor_id}`})):data.companies.filter(row=>filters.floor_id==='third-floor'||!row.floor_ids?.length||row.floor_ids.some(id=>id!=='third-floor')).slice(0,5).map(row=>({id:row.id,name:row.name,value:analyticEntityAmount(row,filters.floor_id),onPress:()=>onCompany(row.id),testID:`analytics-contribution-${row.id}`}));
 return <Panel title={overall?'Sales by department':'Sales by company'} description={`${filters.date_basis==='payment'?'Collected amount':'Confirmed sales'} in ${currency}${overall?'':' (top five)'}`} testID="analytics-bento-contribution">
  {rows.length?<RankedBars label={`Sales contribution in ${currency}`} rows={rows.map(row=>({id:row.id,label:row.name,value:row.value,formatted:analyticMoney(row.value,currency),testID:row.testID,onPress:row.onPress}))}/>:<Empty text="No attributable company sales in this range."/>}
  {overall?data.floors.filter(floor=>floor.currency==='RNB').map(floor=><DataLink key={floor.id} testID={`analytics-floor-${floor.floor_id}`} label={floor.name} value={analyticMoney(floor.sales,'RNB')} detail="Separate RNB ledger" onPress={()=>onFloor(floor)}/>):null}

 </Panel>;
}

export function OrderActivity({points,filters,onPoint}:{points:AnalyticsTrend[];filters:AnalyticsFilters;onPoint:(point:AnalyticsTrend,currency:string)=>void}) {
 const theme=useSalesTheme(); const currency=analyticsCurrency(filters.floor_id);
 const currencies=filters.floor_id==='all'?['INR','RNB']:[currency];
 const shown=points.slice(-7);
 const maximum=Math.max(1,...shown.flatMap(point=>currencies.map(code=>currencyOrders(point,code,filters.floor_id)??0)));
 return <Panel title="Order activity" description="Latest seven dated buckets · order counts" testID="analytics-order-activity">
  {!shown.length?<Empty text="No dated order activity in this range."/>:<ScrollView horizontal showsHorizontalScrollIndicator style={{flexGrow:0}} contentContainerStyle={{minWidth:'100%',gap:8}}>
   <View style={{width:56,gap:8}}><View style={{height:44,justifyContent:'center'}}><Text style={type.caption}>Ledger</Text></View>{currencies.map(code=><View key={code} style={{height:44,justifyContent:'center'}}><Text style={type.bodySm}>{code}</Text></View>)}</View>
   {shown.map(point=><View key={point.id} style={{flex:1,minWidth:44,gap:8}}><View style={{height:44,justifyContent:'center',alignItems:'center'}}><Text style={[type.caption,{textAlign:'center'}]}>{point.label}</Text></View>{currencies.map(code=>{const value=currencyOrders(point,code,filters.floor_id);const dark=value!=null&&value/maximum>=.6;return <Pressable key={code} testID={`analytics-activity-${code}-${point.id}`} accessibilityRole="link" {...linkActivation(()=>onPoint(point,code))} accessibilityLabel={`${point.label}: ${analyticNumber(value)} ${code} orders. Open supporting records`} onPress={()=>onPoint(point,code)} style={({pressed})=>({minHeight:44,minWidth:44,alignItems:'center',justifyContent:'center',borderRadius:8,backgroundColor:dark?theme.accent:value?theme.tint:theme.canvas,borderWidth:pressed?2:1,borderColor:pressed?theme.accent:theme.line})}><Text style={[type.bodySm,{fontVariant:['tabular-nums'],fontWeight:'500',color:dark?theme.surface:theme.ink}]}>{value??'Unavailable'}</Text></Pressable>;})}</View>)}
  </ScrollView>}
  <Text style={type.caption}>Darker cells indicate more orders. Tap a count to inspect it. Missing counts are labelled unavailable.</Text>
  <Button label="View latest date" variant="ghost" onPress={()=>{if(shown.length)onPoint(shown[shown.length-1],currency);}} disabled={!shown.length}/>
 </Panel>;
}
