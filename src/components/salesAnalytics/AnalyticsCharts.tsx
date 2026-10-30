import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { colors, spacing, type } from '@/src/theme/tokens';
import type { AnalyticsFloor } from '@/src/api/salesAnalytics';
import { analyticMoney, analyticNumber, chartColors, linkActivation, DataLink, Empty } from './AnalyticsParts';
export { SalesTrend } from './SalesTrend';

export function FloorContribution({ floors, onFloor }: { floors: AnalyticsFloor[]; onFloor: (floor: AnalyticsFloor)=>void }) {
 const inr=floors.filter(floor=>floor.currency!=='RNB');
 const shown=inr.length?inr:floors;
 const maximum=Math.max(1,...shown.map(floor=>floor.sales||0));
 return <View style={{gap:spacing.s4}}>{shown.length?shown.map(floor=><DataLink key={floor.id} testID={`analytics-floor-${floor.floor_id}`} vertical label={floor.name} value={analyticMoney(floor.sales,floor.currency)} proportion={floor.sales==null?undefined:floor.sales/maximum} detail={`${analyticNumber(floor.orders)} orders · ${analyticNumber(floor.customers)} customers${floor.contribution_pct!=null?` · ${floor.contribution_pct.toLocaleString('en-IN',{maximumFractionDigits:1})}% of ${floor.currency} sales`:''}`} onPress={()=>onFloor(floor)}/>):<Empty/>}</View>;
}

export function FloorBars({floors,onFloor}:{floors:AnalyticsFloor[];onFloor:(floor:AnalyticsFloor)=>void}) {
 const [metric,setMetric]=useState<'sales'|'orders'|'customers'|'average_order_value'>('sales');
 const currency=floors[0]?.currency||'INR';
 return <View testID="analytics-floor-bars" style={{gap:spacing.s8}}>
  <View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s4}}>{[{id:'sales',label:'Sales'},{id:'orders',label:'Orders'},{id:'customers',label:'Customers'},{id:'average_order_value',label:'Average'}].map(item=><Pressable key={item.id} accessibilityRole="button" accessibilityState={{selected:metric===item.id}} aria-pressed={metric===item.id} onPress={()=>setMetric(item.id as typeof metric)} style={({pressed})=>({minHeight:44,paddingHorizontal:spacing.s8,justifyContent:'center',borderRadius:8,backgroundColor:pressed||metric===item.id?colors.surfaceTertiary:'transparent'})}><Text style={metric===item.id?type.bodyStrong:type.bodySm}>{item.label}</Text></Pressable>)}</View>
  {floors.map(floor=>{const max=Math.max(1,...floors.filter(row=>!['sales','average_order_value'].includes(metric)||row.currency===floor.currency).map(row=>row[metric]||0));const value=floor[metric];return <Pressable key={floor.id} testID={`analytics-floor-${floor.floor_id}`} accessibilityRole="link" {...linkActivation(()=>onFloor(floor))} accessibilityLabel={`${floor.name}, ${metric.replace(/_/g,' ')}: ${value==null?'unavailable':value}. Open analysis`} onPress={()=>onFloor(floor)} style={({pressed})=>({gap:spacing.s8,paddingVertical:spacing.s8,minHeight:56,backgroundColor:pressed?colors.surfaceTertiary:'transparent'})}>
   <View style={{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between',gap:spacing.s8}}><Text style={[type.bodySm,{fontWeight:'500'}]}>{floor.name}</Text><Text style={[type.bodySm,{fontWeight:'500'},{fontVariant:['tabular-nums']}]}>{['sales','average_order_value'].includes(metric)?analyticMoney(value,floor.currency):analyticNumber(value)}</Text></View>
   <View aria-hidden style={{height:12,backgroundColor:colors.surfaceTertiary,borderRadius:4,overflow:'hidden'}}><View style={{height:12,width:`${Math.max(0,Math.min(1,(value||0)/max))*100}%`,backgroundColor:chartColors.primary,borderRadius:4}}/></View>
  </Pressable>;})}
  {!floors.length?<Empty/>:<Text style={type.caption}>{['sales','average_order_value'].includes(metric)?`${currency} · `:''}Bars start at zero and share one scale.</Text>}
 </View>;
}

export function CustomerMix({segments,onSegment}:{segments:{id:string;name:string;customers:number}[];onSegment?:(id:string)=>void}) {
 const total=segments.reduce((sum,row)=>sum+row.customers,0);
 return <View style={{gap:spacing.s12}}>
  {total>0?<View aria-hidden style={{height:30,flexDirection:'row',gap:3,borderRadius:15,overflow:'hidden'}}>{segments.map((row,index)=><View key={row.id} style={{flex:row.customers,backgroundColor:index===0?colors.brand:colors.onSurfaceMuted}}/>)}</View>:null}
  {segments.map(row=><DataLink key={row.id} label={row.name} detail={total?`${Math.round(row.customers/total*100)}% of purchasing customers`:'No purchasing customers in this period'} value={analyticNumber(row.customers)} onPress={onSegment?()=>onSegment(row.id):undefined}/>)}{!segments.length?<Empty text="Customer purchase history is unavailable for this comparison."/>:null}
 </View>;
}

export function CollectionBalance({collected,outstanding,currency,onRecords}:{collected:number|null|undefined;outstanding:number|null|undefined;currency:string;onRecords:()=>void}) {
 return <View testID="analytics-collection-balance" style={{gap:spacing.s12}}>
  <DataLink label="Collected" value={analyticMoney(collected,currency)} onPress={onRecords}/>
  <DataLink label="Outstanding" value={analyticMoney(outstanding,currency)} onPress={onRecords}/>
  <Text style={type.caption}>Current recorded balances on the selected orders</Text>
 </View>;
}
