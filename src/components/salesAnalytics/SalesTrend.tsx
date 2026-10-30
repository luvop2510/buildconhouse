import { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import Svg, { Circle, G, Line, Polyline, Rect } from 'react-native-svg';
import { Text } from '@/src/components/AppText';
import { Button, IconButton } from '@/src/components/ui';
import { colors, spacing, type } from '@/src/theme/tokens';
import { useBp } from '@/src/design/responsive';
import type { AnalyticsTrend } from '@/src/api/salesAnalytics';
import { useSalesTheme } from './salesTheme';
import { currencyOrders } from './visualMetrics';
import { analyticMoney, analyticNumber, chartColors, DataLink, Empty, linkActivation } from './AnalyticsParts';

/** Gaps stay gaps. A missing historic amount must never turn into a zero. */
export function SalesTrend({ points, currency = 'INR', floorId='all', unit, onPoint, initialMode='bars' }: { points: AnalyticsTrend[]; currency?: string; floorId?:string; unit?: string; initialMode?:'area'|'bars'; onPoint: (point: AnalyticsTrend) => void }) {
 const {isPhone}=useBp(); const theme=useSalesTheme();
 const [width,setWidth]=useState(300);
 const [table,setTable]=useState(false);
 const [mode,setMode]=useState<'area'|'bars'>(initialMode);
 const [selected,setSelected]=useState<number|null>(null);
 const format=(value:number|null|undefined)=>value==null?'Unavailable':unit?`${analyticNumber(value)} ${unit}`:analyticMoney(value,currency);
 const values=points.map(point=>currency==='RNB'?point.sales_rnb??null:point.sales);
 const previous=points.map(point=>currency==='RNB'?point.previous_sales_rnb??null:point.previous_sales);
 const compared=previous.some(value=>value!=null);
 const rawMax=Math.max(1,...values.map(value=>value??0),...previous.map(value=>value??0));
 const minimum=Math.min(0,...values.map(value=>value??0),...previous.map(value=>value??0));
 const step=10**Math.floor(Math.log10(rawMax));
 const max=Math.ceil(rawMax/step)*step;
 const height=isPhone?176:224, left=48, top=16, bottom=height-20, chartWidth=Math.max(40,width-left-12);
 const x=(index:number)=>left+(index+.5)/Math.max(1,points.length)*chartWidth;
 const y=(value:number)=>bottom-(value-minimum)/(max-minimum)*(bottom-top);
 const runs=(series:(number|null)[])=>{const result:{x:number;y:number}[][]=[];let run:{x:number;y:number}[]=[];series.forEach((value,index)=>{if(value==null){if(run.length)result.push(run);run=[];}else run.push({x:x(index),y:y(value)});});if(run.length)result.push(run);return result;};
 const index=Math.min(selected??Math.max(0,points.length-1),Math.max(0,points.length-1));
 const point=points[index];
 const labels=points.map((p,i)=>({p,i})).filter(({i})=>i===0||i===points.length-1||i===Math.floor(points.length/2));
 const compact=(value:number)=>Math.abs(value)>=10000000?`${+(value/10000000).toFixed(1)}Cr`:Math.abs(value)>=100000?`${+(value/100000).toFixed(1)}L`:Math.abs(value)>=1000?`${+(value/1000).toFixed(1)}k`:analyticNumber(value);
 return <View testID="analytics-trend" style={{gap:spacing.s12}} onLayout={event=>setWidth(event.nativeEvent.layout.width)}>
  {!points.length?<Empty text="No dated sales in this range. Choose another period to compare performance."/>:<>
   <Pressable accessibilityRole="button" accessibilityLabel={`Explore ${mode==='bars'?'bar':'line'} chart in ${unit||currency}. Select a date using the previous and next controls below, or open chart data.`} onPress={event=>setSelected(Math.max(0,Math.min(points.length-1,Math.floor((event.nativeEvent.locationX-left)/chartWidth*points.length))))}>
    <View pointerEvents="none" style={{position:'absolute',left:0,top,width:40,height:bottom-top+8,zIndex:1,justifyContent:'space-between'}}>{[1,2/3,1/3,0].map((v,i)=><Text key={i} style={[type.caption,{textAlign:'right',fontSize:12,lineHeight:16}]}>{compact(minimum+(max-minimum)*v)}</Text>)}</View>
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
     {[0,1/3,2/3,1].map(ratio=><Line key={ratio} x1={left} x2={width-8} y1={y(minimum+(max-minimum)*ratio)} y2={y(minimum+(max-minimum)*ratio)} stroke={colors.border}/>)}
     {mode==='area'?<>
      {runs(previous).map((run,i)=>run.length===1?<Circle key={`prev-${i}`} cx={run[0].x} cy={run[0].y} r={3} fill={chartColors.secondary}/>:<Polyline key={`prev-${i}`} points={run.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={chartColors.secondary} strokeWidth={2} strokeDasharray="5 5"/>)}
      {runs(values).map((run,i)=>run.length===1?<Circle key={i} cx={run[0].x} cy={run[0].y} r={4} fill={theme.accent}/>:<Polyline key={i} points={run.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={theme.accent} strokeWidth={2.5} strokeLinejoin="round"/>)}
     </>:points.map((p,i)=>{const w=Math.min(isPhone?20:28,chartWidth/points.length*(compared?.3:.65));return <G key={p.id}>{(compared?[previous[i],values[i]]:[values[i]]).map((value,series)=>value==null?null:<Rect key={series} x={x(i)+(compared?(series===0?-w-1:1):-w/2)} y={Math.min(y(0),y(value))} width={w} height={Math.abs(y(value)-y(0))} rx={2} fill={compared&&series===0?chartColors.secondary:theme.accent}/>)}</G>;})}

     {selected!=null&&values[index]!=null?<><Line x1={x(index)} x2={x(index)} y1={top} y2={bottom} stroke={chartColors.secondary} strokeDasharray="2 4"/><Circle cx={x(index)} cy={y(values[index]!)} r={5} fill={theme.accent} stroke={colors.surfaceSecondary} strokeWidth={2}/></>:null}
    </Svg>
   </Pressable>
   <View style={{height:44}}>{labels.map(({p,i})=><Pressable key={p.id} testID={`analytics-point-${p.id}`} accessibilityRole="link" {...linkActivation(()=>onPoint(p))} onPress={()=>onPoint(p)} accessibilityLabel={`${p.label}. Open supporting records`} style={{position:'absolute',left:Math.max(0,Math.min(width-60,x(i)-30)),width:60,minHeight:44,justifyContent:'center',alignItems:'center'}}><Text style={type.caption}>{p.label}</Text></Pressable>)}</View>
   {point&&selected!=null?<View style={{backgroundColor:colors.surfaceTertiary,borderRadius:8,padding:spacing.s12,gap:spacing.s8}}>
    <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:spacing.s8}}><View style={{flex:1,minWidth:0,gap:spacing.s4}}><Text style={type.caption}>{point.label} · {analyticNumber(currencyOrders(point,currency,floorId))} {currency} orders</Text><ScrollView horizontal showsHorizontalScrollIndicator style={{flexGrow:0,maxWidth:'100%'}}><Text style={[type.titleMd,{fontVariant:['tabular-nums'],...(Platform.OS==='web'?{whiteSpace:'nowrap'} as never:{})}]}>{format(values[index])}</Text></ScrollView></View><IconButton icon="chevron-left" accessibilityLabel="Previous chart date" disabled={index===0} onPress={()=>setSelected(index-1)} tone="ghost"/><IconButton icon="chevron-right" accessibilityLabel="Next chart date" disabled={index>=points.length-1} onPress={()=>setSelected(index+1)} tone="ghost"/></View>
    <Button label="View supporting orders" variant="ghost" onPress={()=>onPoint(point)}/>
   </View>:null}
  <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:spacing.s8}}>
   <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s8,flexWrap:'wrap'}}><View style={{width:16,height:mode==='bars'?8:3,borderRadius:2,backgroundColor:theme.accent}}/><Text style={type.caption}>Current · {unit||currency}</Text>{compared?<><View style={{width:16,height:mode==='bars'?8:3,borderRadius:2,backgroundColor:chartColors.secondary}}/><Text style={type.caption}>Previous period{mode==='area'?' · dashed':''}</Text></>:null}</View>
   <View style={{flexDirection:'row',gap:spacing.s4}}>{(['area','bars'] as const).map(value=><Pressable key={value} accessibilityRole="button" accessibilityState={{selected:mode===value}} aria-pressed={mode===value} onPress={()=>setMode(value)} style={{minHeight:44,minWidth:56,paddingHorizontal:spacing.s8,alignItems:'center',justifyContent:'center',borderRadius:8,backgroundColor:mode===value?colors.surfaceTertiary:'transparent'}}><Text style={mode===value?type.bodyStrong:type.bodySm}>{value==='area'?'Trend':'Bars'}</Text></Pressable>)}</View>
  </View>
   <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',justifyContent:'space-between',gap:spacing.s4}}><Button label={table?'Hide chart data':'Chart data'} variant="ghost" icon={table?'chevron-up':'list'} onPress={()=>setTable(!table)}/>{selected==null&&points.length?<Button label="Explore dates" variant="ghost" icon="crosshair" onPress={()=>setSelected(Math.max(0,points.length-1))}/>:null}{selected!=null?<Button label="Close selection" variant="ghost" onPress={()=>setSelected(null)}/>:null}</View>
   {values.some(value=>value==null)?<Text style={type.caption}>Gaps indicate unavailable amounts, not zero sales.</Text>:null}
   {table?points.map((p,i)=><DataLink key={p.id} label={p.label} detail={`${analyticNumber(currencyOrders(p,currency,floorId))} ${currency} orders${previous[i]!=null?` · Previous ${format(previous[i])}`:''}`} value={format(values[i])} onPress={()=>onPoint(p)}/>):null}
  </>}
 </View>;
}
