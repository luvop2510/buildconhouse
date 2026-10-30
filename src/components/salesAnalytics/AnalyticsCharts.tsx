import { useState } from 'react';
import { useBp } from '@/src/design/responsive';
import { collectionProgress } from './visualMetrics';
import { HalfGauge } from '@/src/design/graphics';
import { Pressable, View } from 'react-native';
import Svg, { Circle, Rect } from 'react-native-svg';
import { Text } from '@/src/components/AppText';
import { colors, spacing, type } from '@/src/theme/tokens';
import type { AnalyticsFloor } from '@/src/api/salesAnalytics';
import { analyticMoney, analyticNumber, chartColors, linkActivation, DataLink, Empty } from './AnalyticsParts';
export { SalesTrend } from './SalesTrend';

export function FloorContribution({ floors, onFloor }: { floors: AnalyticsFloor[]; onFloor: (floor: AnalyticsFloor)=>void }) {
 const {isPhone}=useBp();
 const inr=floors.filter(floor=>floor.currency!=='RNB');
 if (!inr.length && floors.length) return <View>{floors.map(floor=><DataLink key={floor.id} label={floor.name} value={analyticMoney(floor.sales,floor.currency)} detail={`${analyticNumber(floor.orders)} orders · ${analyticNumber(floor.customers)} customers`} onPress={()=>onFloor(floor)}/>)}</View>;
 const available=inr.every(floor=>floor.sales!=null);
 const total=inr.reduce((sum,floor)=>sum+(floor.sales||0),0);
 const circumference=2*Math.PI*54;
 const tones=[chartColors.primary,colors.onSurface,chartColors.secondary];
 let accumulated=0;
 return <View style={{gap:spacing.s8}}>
  <View style={{alignItems:'center',justifyContent:'center',height:isPhone?116:136}} accessibilityLabel={`INR sales contribution. ${inr.map(floor=>`${floor.name}: ${analyticMoney(floor.sales)}`).join('; ')}`}>
   <Svg width={isPhone?116:136} height={isPhone?116:136} viewBox="0 0 164 164" aria-hidden><Circle cx={82} cy={82} r={54} stroke={colors.surfaceTertiary} strokeWidth={16} fill="none"/>{available?inr.map((floor,index)=>{const fraction=total?(floor.sales||0)/total:0;const offset=accumulated;accumulated+=fraction;return <Circle key={floor.id} cx={82} cy={82} r={54} stroke={tones[index%tones.length]} strokeWidth={16} fill="none" strokeDasharray={`${Math.max(0,fraction*circumference-2)} ${circumference}`} strokeDashoffset={-offset*circumference} rotation={-90} origin="82,82"/>;}):null}</Svg>
   <View pointerEvents="none" style={{position:'absolute',alignItems:'center',gap:spacing.s4}}><Text style={[type.titleMd,{fontVariant:['tabular-nums']}]}>{available?analyticNumber(inr.length):'—'}</Text><Text style={type.caption}>INR units</Text></View>
  </View>
  {!available?<Text style={type.caption}>Share unavailable: one or more sales amounts are missing.</Text>:null}
  {inr.length?inr.map((floor,index)=><View key={floor.id} style={{flexDirection:'row',gap:spacing.s8,alignItems:'center'}}><View aria-hidden style={{width:8,height:8,borderRadius:4,backgroundColor:tones[index%tones.length]}}/><View style={{flex:1,minWidth:0}}><DataLink testID={`analytics-floor-${floor.floor_id}`} label={floor.name} detail={available&&floor.contribution_pct!=null?`${floor.contribution_pct.toLocaleString('en-IN',{maximumFractionDigits:1})}% of INR sales`:'Share unavailable'} value={analyticMoney(floor.sales)} onPress={()=>onFloor(floor)}/></View></View>):<Empty/>}
 </View>;
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
  {total>0?<View accessible accessibilityLabel={segments.map(row=>`${row.name}: ${analyticNumber(row.customers)} customers, ${Math.round(row.customers/total*100)} percent`).join('. ')} style={{gap:spacing.s8}}>
   <View aria-hidden style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s4}}>{Array.from({length:20},(_,index)=>{const firstShare=(segments[0]?.customers||0)/total;return <Svg key={index} width={12} height={24} viewBox="0 0 12 24"><Circle cx={6} cy={4} r={3} fill={index<Math.round(firstShare*20)?chartColors.primary:chartColors.secondary}/><Rect x={2} y={9} width={8} height={14} rx={3} fill={index<Math.round(firstShare*20)?chartColors.primary:chartColors.secondary}/></Svg>;})}</View>
   <Text style={type.caption}>Customer mix · each figure represents approximately 5%</Text>
  </View>:null}
  <View aria-hidden style={{height:12,flexDirection:'row',backgroundColor:colors.surfaceTertiary,borderRadius:4,overflow:'hidden'}}>{segments.map((row,index)=><View key={row.id} style={{width:`${total?row.customers/total*100:0}%`,backgroundColor:index===0?chartColors.primary:colors.onSurface,borderRightWidth:2,borderRightColor:colors.surfaceSecondary}}/>)}</View>
  {segments.map(row=><DataLink key={row.id} label={row.name} detail={total?`${Math.round(row.customers/total*100)}% of customers`:'No customers in this period'} value={analyticNumber(row.customers)} onPress={onSegment?()=>onSegment(row.id):undefined}/>)}{!segments.length?<Empty text="Customer purchase history is unavailable for this comparison."/>:null}
 </View>;
}

export function CollectionBalance({collected,outstanding,currency,onRecords}:{collected:number|null|undefined;outstanding:number|null|undefined;currency:string;onRecords:()=>void}) {
 const share=collectionProgress(collected,outstanding);
 return <View testID="analytics-collection-balance" style={{gap:spacing.s12}}>
  <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s16}}>
   <HalfGauge ratio={share} label="Collected share of receipts plus outstanding balance" value={share==null?'Unavailable':`${Math.round(share*100)}%`}/>
   <View style={{flex:1,minWidth:0}}><DataLink label="Collected" value={analyticMoney(collected,currency)} onPress={onRecords}/><DataLink label="Outstanding" value={analyticMoney(outstanding,currency)} onPress={onRecords}/></View>
  </View>
  <Text style={type.caption}>{share==null?'Balance mix unavailable.':'Collected / (collected + outstanding). Current recorded balances.'}</Text>
 </View>;
}
