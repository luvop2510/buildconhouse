import { useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Polyline, Rect } from 'react-native-svg';
import { Text } from '@/src/components/AppText';
import { Button } from '@/src/components/ui';
import { HalfGauge } from '@/src/design/graphics';
import { type } from '@/src/theme/tokens';
import type { AnalyticsDashboardData, AnalyticsFilters, AnalyticsFloor, AnalyticsTrend } from '@/src/api/salesAnalytics';
import { analyticMoney, analyticNumber, DataLink, Empty, linkActivation, Panel } from './AnalyticsParts';
import { analyticEntityAmount, analyticsCurrency } from './currencyScope';
import { averageForBucket, collectionProgress, currencyOrders, distributionTotal } from './visualMetrics';
import { useSalesTheme } from './salesTheme';

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
 const theme=useSalesTheme();
 const {fontScale}=useWindowDimensions();
 const [footerWidth,setFooterWidth]=useState(300);
 const [collectedWidth,setCollectedWidth]=useState(0);
 const [outstandingWidth,setOutstandingWidth]=useState(0);
 const singleBalance=fontScale>1.3||Math.max(collectedWidth,outstandingWidth)>(footerWidth-12)/2;
 const {kpis}=data;
 const collected=currency==='RNB'?kpis.collected_rnb:kpis.collected;
 const outstanding=currency==='RNB'?kpis.outstanding_rnb:kpis.outstanding;
 const ratio=collectionProgress(collected,outstanding);
 const change=currency==='RNB'?kpis.change_pct_rnb:kpis.change_pct;
 return <Panel title="Sales & collections" description={data.period.label} testID="analytics-sales-hero">
  <View testID="analytics-collection-balance" style={{alignItems:'center',gap:4,paddingVertical:4}}>
   <HalfGauge ratio={ratio} size={220} label={`${currency} collected share of recorded receipts plus outstanding balance`} value={ratio==null?'Unavailable':`${Math.round(ratio*100)}%`}/>
   <Text style={[type.bodySm,{fontWeight:'500',color:theme.accent}]}>Collected share · {currency}</Text>
   <Text style={[type.caption,{textAlign:'center'}]}>Current balances on selected orders</Text>
  </View>
  <Pressable testID="analytics-kpi-sales" accessibilityRole="link" {...linkActivation(onRecords)} accessibilityLabel={`${data.metric_label||'Confirmed sales'}: ${analyticMoney(currency==='RNB'?kpis.sales_rnb:kpis.sales,currency)}. Open supporting records`} onPress={onRecords} style={{gap:4,paddingTop:12,borderTopWidth:1,borderTopColor:theme.line,minHeight:64}}>
   <Text style={type.bodySm}>{data.metric_label||'Confirmed sales'}</Text>
   <Amount large value={analyticMoney(currency==='RNB'?kpis.sales_rnb:kpis.sales,currency)}/>
   <Text style={type.caption}>{change==null?'Previous-period comparison unavailable':`${change>0?'+':''}${analyticNumber(change)}% vs previous period`}</Text>
  </Pressable>
  <MiniTrend label={`${currency} ${data.filters.date_basis==='payment'?'collections':'sales'} trend`} values={data.trend.map(point=>currency==='RNB'?point.sales_rnb:point.sales)}/>
  <View onLayout={event=>setFooterWidth(event.nativeEvent.layout.width)} style={{flexDirection:'row',flexWrap:'wrap',gap:12,paddingTop:8,borderTopWidth:1,borderTopColor:theme.line}}>
   {[['Collected',collected],['Outstanding',outstanding]].map(([label,value])=><View key={label as string} style={{flexGrow:1,flexBasis:singleBalance?'100%':120,minWidth:0,gap:4}}><Text style={type.caption}>{label}</Text><Amount value={analyticMoney(value as number|null|undefined,currency)} onMeasure={label==='Collected'?setCollectedWidth:setOutstandingWidth}/></View>)}
  </View>
 </Panel>;
}

function VisualMetric({label,value,detail,testID,onPress,children,monetary=false,gridWidth}:{label:string;value:string;detail:string;testID:string;onPress:()=>void;children:ReactNode;monetary?:boolean;gridWidth:number}) {
 const theme=useSalesTheme(); const {fontScale}=useWindowDimensions();
 const [amountWidth,setAmountWidth]=useState(0);
 const fullWidth=fontScale>1.3||monetary&&(amountWidth||value.length*11)>(gridWidth-12)/2-34;
 return <Pressable testID={testID} accessibilityRole="link" {...linkActivation(onPress)} accessibilityLabel={`${label}: ${value}. ${detail}. Open supporting records`} onPress={onPress} style={({pressed,hovered}:any)=>({flexGrow:1,flexBasis:fullWidth?'100%':'45%',minWidth:0,padding:16,gap:8,borderRadius:16,borderWidth:1,borderColor:theme.line,justifyContent:'space-between',backgroundColor:pressed||hovered?theme.tint:theme.surface})}>
  <Text style={[type.bodySm,{fontWeight:'500'}]}>{label}</Text><Amount value={value} onMeasure={monetary?setAmountWidth:undefined}/>
  {children}<Text style={type.caption}>{detail}</Text>
 </Pressable>;
}

export function VisualKpis({data,filters,go}:{data:AnalyticsDashboardData;filters:AnalyticsFilters;go:(metric:string,currency?:string)=>void}) {
 const [gridWidth,setGridWidth]=useState(300);
 const theme=useSalesTheme(); const currency=analyticsCurrency(filters.floor_id); const payment=filters.date_basis==='payment';
 const {kpis}=data;
 const total=distributionTotal(data.customer_segments.map(row=>row.customers));
 const repeat=data.customer_segments.find(row=>row.id==='repeat');
 const repeatRatio=total!=null&&repeat&&kpis.customers!=null&&data.coverage.missing_customer_ids===0?repeat.customers/total:null;
 const furniture=filters.floor_id==='all'?data.floors.find(floor=>floor.currency==='RNB'):undefined;
 const collected=currency==='RNB'?kpis.collected_rnb:kpis.collected;
 const outstanding=currency==='RNB'?kpis.outstanding_rnb:kpis.outstanding;
 const collectedShare=collectionProgress(collected,outstanding);
 return <View testID="analytics-kpis" onLayout={event=>setGridWidth(event.nativeEvent.layout.width)} style={{flex:1,flexDirection:'row',flexWrap:'wrap',gap:12,alignItems:'stretch',alignContent:'stretch'}}>
  <VisualMetric gridWidth={gridWidth} label={payment?'Orders with payments':'Confirmed orders'} value={analyticNumber(kpis.orders)} detail="Orders in the selected period" testID="analytics-kpi-orders" onPress={()=>go('orders')}><MiniTrend bars label="Order count by date" values={data.trend.map(point=>point.orders)}/></VisualMetric>
  <VisualMetric gridWidth={gridWidth} label={payment?'Paying customers':'Purchasing customers'} value={analyticNumber(kpis.customers)} detail={repeatRatio==null?'Repeat-customer comparison unavailable':`${Math.round(repeatRatio*100)}% repeat purchasing customers`} testID="analytics-kpi-customers" onPress={()=>go('customers')}>
   <View accessible accessibilityLabel={repeatRatio==null?'Repeat customer share unavailable':`${Math.round(repeatRatio*100)}% repeat customers`} style={{height:32,flexDirection:'row',alignItems:'center',gap:8}}><Svg aria-hidden accessible={false} width={32} height={32} viewBox="0 0 32 32"><Circle cx={16} cy={16} r={12} stroke={theme.line} strokeWidth={4} fill="none"/>{repeatRatio!=null&&repeatRatio>0?<Circle cx={16} cy={16} r={12} stroke={theme.accent} strokeWidth={4} fill="none" strokeDasharray={`${repeatRatio*75.4} 75.4`} rotation={-90} origin="16, 16"/>:null}</Svg><Text style={type.caption}>Repeat share</Text></View>
  </VisualMetric>
  <VisualMetric gridWidth={gridWidth} monetary label={payment?'Average collected':'Average order value'} value={analyticMoney(currency==='RNB'?kpis.average_order_value_rnb:kpis.average_order_value,currency)} detail={`${currency} per matching order`} testID="analytics-kpi-aov" onPress={()=>go('sales',currency)}>
   <MiniTrend label={`Average ${currency} amount by date`} values={data.trend.map(point=>averageForBucket(currency==='RNB'?point.sales_rnb:point.sales,currencyOrders(point,currency,filters.floor_id)))}/>
  </VisualMetric>
  {furniture?<VisualMetric gridWidth={gridWidth} monetary label="Furniture RNB" value={analyticMoney(furniture.sales,'RNB')} detail="Separate ledger · excluded from INR totals" testID="analytics-furniture" onPress={()=>go('sales','RNB')}><MiniTrend bars label="Furniture RNB trend" values={data.trend.map(point=>point.sales_rnb)}/></VisualMetric>:<VisualMetric gridWidth={gridWidth} monetary label="Outstanding balance" value={analyticMoney(outstanding,currency)} detail="Current balance on selected orders" testID="analytics-kpi-outstanding" onPress={()=>go('sales',currency)}><View accessible accessibilityLabel="Recorded collected and outstanding amounts" style={{gap:8}}>{collectedShare==null?<Text style={type.caption}>Share unavailable</Text>:<View aria-hidden style={{height:6,backgroundColor:theme.line,borderRadius:3,overflow:'hidden'}}><View style={{height:6,width:`${collectedShare*100}%`,backgroundColor:theme.accent}}/></View>}<Text style={type.caption}>Collected {analyticMoney(collected,currency)}</Text></View></VisualMetric>}
 </View>;
}

export function SalesDistribution({data,filters,onFloor,onCompany}:{data:AnalyticsDashboardData;filters:AnalyticsFilters;onFloor:(floor:AnalyticsFloor)=>void;onCompany:(id:string)=>void}) {
 const theme=useSalesTheme(); const currency=analyticsCurrency(filters.floor_id);
 const overall=filters.floor_id==='all';
 const rows=overall?data.floors.filter(row=>row.currency===currency).map(row=>({id:row.id,name:row.name,value:row.sales,onPress:()=>onFloor(row),testID:`analytics-floor-${row.floor_id}`})):data.companies.filter(row=>filters.floor_id==='third-floor'||!row.floor_ids?.length||row.floor_ids.some(id=>id!=='third-floor')).slice(0,5).map(row=>({id:row.id,name:row.name,value:analyticEntityAmount(row,filters.floor_id),onPress:()=>onCompany(row.id),testID:`analytics-contribution-${row.id}`}));
 const total=distributionTotal(rows.map(row=>row.value));
 const marks=[theme.accent,theme.ink,theme.muted,theme.line];
 let offset=0;
 return <Panel title={overall?'Department distribution':'Company distribution'} description={`${filters.date_basis==='payment'?'Collected amount':'Confirmed sales'} · ${currency}${overall?'':' · top five shown'}`} testID="analytics-bento-contribution">
  {rows.length>1&&total!=null?<View accessible accessibilityLabel={rows.map(row=>`${row.name}: ${Math.round(row.value!/total*100)}%`).join('. ')} style={{alignItems:'center',gap:12}}><View style={{width:140,height:140,alignItems:'center',justifyContent:'center'}}><Svg width={140} height={140} viewBox="0 0 140 140" style={{position:'absolute'}} aria-hidden accessible={false}>{rows.map((row,index)=>{const length=row.value!/total*326.73;const start=offset;offset+=length;return <Circle key={row.id} cx={70} cy={70} r={52} fill="none" stroke={marks[index%marks.length]} strokeWidth={16} strokeDasharray={`${length} 326.73`} strokeDashoffset={-start} rotation={-90} origin="70, 70"/>;})}</Svg><Text style={[type.titleMd,{fontVariant:['tabular-nums']}]}>{rows.filter(row=>(row.value??0)>0).length}</Text><Text style={type.caption}>{overall?'departments':'companies'}</Text></View></View>:null}
  {rows.length?rows.map((row,index)=><DataLink key={row.id} markerColor={marks[index%marks.length]} testID={row.testID} label={row.name} value={analyticMoney(row.value,currency)} detail={total!=null?`${(row.value!/total*100).toLocaleString('en-IN',{maximumFractionDigits:1})}% of ${overall?'INR':'shown'} amount`:undefined} proportion={total!=null?row.value!/total:undefined} onPress={row.onPress}/>):<Empty text="No attributable company sales in this range."/>}
  {overall?data.floors.filter(floor=>floor.currency==='RNB').map(floor=><DataLink key={floor.id} testID={`analytics-floor-${floor.floor_id}`} label={floor.name} value={analyticMoney(floor.sales,'RNB')} detail="Separate RNB ledger · outside the INR distribution" onPress={()=>onFloor(floor)}/>):null}
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
   {shown.map(point=><View key={point.id} style={{flex:1,minWidth:44,gap:8}}><View style={{height:44,justifyContent:'center',alignItems:'center'}}><Text style={[type.caption,{textAlign:'center'}]}>{point.label}</Text></View>{currencies.map(code=>{const value=currencyOrders(point,code,filters.floor_id);const dark=value!=null&&value/maximum>=.6;return <Pressable key={code} testID={`analytics-activity-${code}-${point.id}`} accessibilityRole="link" {...linkActivation(()=>onPoint(point,code))} accessibilityLabel={`${point.label}: ${analyticNumber(value)} ${code} orders. Open supporting records`} onPress={()=>onPoint(point,code)} style={({pressed})=>({minHeight:44,minWidth:44,alignItems:'center',justifyContent:'center',borderRadius:8,backgroundColor:dark?theme.accent:value?theme.tint:theme.canvas,borderWidth:pressed?2:1,borderColor:pressed?theme.accent:theme.line})}><Text style={[type.bodySm,{fontVariant:['tabular-nums'],fontWeight:'500',color:dark?theme.surface:theme.ink}]}>{value??'—'}</Text></Pressable>;})}</View>)}
  </ScrollView>}
  <Text style={type.caption}>Darker cells indicate more orders. Tap a count to inspect it. Missing counts appear as —.</Text>
  <Button label="View latest date" variant="ghost" onPress={()=>{if(shown.length)onPoint(shown[shown.length-1],currency);}} disabled={!shown.length}/>
 </Panel>;
}
