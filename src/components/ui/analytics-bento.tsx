import { useState, type ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Line, Polygon, Polyline, Text as SvgText } from 'react-native-svg';
import { Text } from '@/src/components/AppText';
import { Button } from '@/src/components/ui';
import { useBp } from '@/src/design/responsive';
import { colors, spacing, type } from '@/src/theme/tokens';
import type { AnalyticsDashboardData, AnalyticsFilters, AnalyticsFloor, AnalyticsTrend } from '@/src/api/salesAnalytics';
import { analyticMoney, analyticNumber, chartColors, Choice, DataLink, Empty, Panel } from '@/src/components/salesAnalytics/AnalyticsParts';
import { CollectionBalance, FloorBars, SalesTrend } from '@/src/components/salesAnalytics/AnalyticsCharts';
import { analyticEntityAmount, analyticsCurrency } from '@/src/components/salesAnalytics/currencyScope';
import { ActivityDots } from '@/src/design/graphics';
import { squarify } from './analytics-bento-layout';

export type AnalyticsBentoProps = {
 data: AnalyticsDashboardData;
 filters: AnalyticsFilters;
 update: (filters: AnalyticsFilters) => void;
 onPoint: (point: AnalyticsTrend) => void;
 onFloor: (floor: AnalyticsFloor) => void;
 revenueFooter?: ReactNode;
 onRecords: () => void;
 onCompany: (id:string) => void;
 onActivityPoint: (point:AnalyticsTrend) => void;
};

/** Adapted from the user-supplied Analytics Bento by vasnev.art: revenue, comparison, treemap and radial pattern. */
export function AnalyticsBento({data,filters,update,onPoint,onFloor,revenueFooter,onRecords,onCompany,onActivityPoint}:AnalyticsBentoProps) {
 const {isDesktop,isTabletLandscape}=useBp();
 const {fontScale}=useWindowDimensions();
 const paired=(isDesktop||isTabletLandscape)&&fontScale<=1.3;
 const currency=analyticsCurrency(filters.floor_id);
 const floors=data.floors.filter(floor=>floor.currency===currency);
 const companyTiles=data.companies.map(company=>({id:company.id,name:company.name,currency,sales:analyticEntityAmount(company,filters.floor_id)??null}));
 const comparison=data.trend.some(point=>(currency==='RNB'?point.previous_sales_rnb:point.previous_sales)!=null);
 const row=(children:ReactNode[],weights:number[])=><View style={{flexDirection:paired?'row':'column',gap:spacing.s12,alignItems:'stretch'}}>{children.map((child,i)=><View key={i} style={{flex:paired?weights[i]:undefined,minWidth:0}}>{child}</View>)}</View>;
 const revenue=<Panel title={filters.date_basis==='payment'?'Collections over time':'Sales over time'} description={data.period.label} testID="analytics-bento-revenue" action={<Choice label="Time scale" value={filters.granularity} options={['day','month','quarter','year'].map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))} onChange={granularity=>update({granularity})} testID="analytics-granularity"/>}><SalesTrend points={data.trend} currency={currency} onPoint={onPoint}/>{revenueFooter}</Panel>;
 const contribution=<Panel title={filters.floor_id==='all'?'Business contribution':'Company sales mix'} description={`Recorded ${currency} sales · area represents share`} testID="analytics-bento-treemap"><Treemap floors={filters.floor_id==='all'?floors:companyTiles}/>{filters.floor_id==='all'?<FloorBars floors={floors} onFloor={onFloor}/>:companyTiles.slice(0,4).map(company=><DataLink key={company.id} label={company.name} value={analyticMoney(company.sales,currency)} onPress={()=>onCompany(company.id)}/>)}</Panel>;
 const balance=<Panel title={comparison?'Current & previous period':'Collections & balances'} description={comparison?`Matching time buckets · ${currency}`:'Recorded payments on matching orders'} testID="analytics-bento-comparison">{comparison?<PeriodWaves points={data.trend} currency={currency} onPoint={onPoint}/>:<CollectionBalance collected={currency==='RNB'?data.kpis.collected_rnb:data.kpis.collected} outstanding={currency==='RNB'?data.kpis.outstanding_rnb:data.kpis.outstanding} currency={currency} onRecords={onRecords}/>}</Panel>;
 const activity=<Panel title="Order activity" description="Recorded orders across the selected time range" testID="analytics-bento-seasonality"><ActivityPattern points={data.trend} currency={currency} onPoint={onPoint} onActivityPoint={onActivityPoint}/></Panel>;
 return <View testID="analytics-bento" style={{gap:spacing.s12}}>
  {row([revenue,contribution],[7,5])}
  {row([balance,activity],[7,5])}
 </View>;
}

/** The supplied mirrored-waves composition now compares actual current/prior sales. */
function PeriodWaves({points,currency,onPoint}:{points:AnalyticsTrend[];currency:string;onPoint:(point:AnalyticsTrend)=>void}) {
 const {isPhone}=useBp();
 const [width,setWidth]=useState(300);
 const [selection,setSelection]=useState('0');
 const index=Math.min(Number(selection)||0,Math.max(0,points.length-1));
 const current=points.map(point=>currency==='RNB'?point.sales_rnb??null:point.sales);
 const previous=points.map(point=>currency==='RNB'?point.previous_sales_rnb??null:point.previous_sales);
 const max=Math.max(1,...current.map(value=>value??0),...previous.map(value=>value??0));
 const height=isPhone?144:176, mid=height/2, pad=12, amplitude=mid-12;
 const x=(i:number)=>pad+(i/Math.max(1,points.length-1))*(width-pad*2);
 const runs=(series:(number|null)[],direction:number)=>{
  const result:string[]=[];let run:string[]=[];
  series.forEach((value,i)=>{if(value==null){if(run.length)result.push(run.join(' '));run=[];}else run.push(`${x(i)},${mid+direction*value/max*amplitude}`);});
  if(run.length)result.push(run.join(' '));return result;
 };
 if(!points.length)return <Empty text="Comparable dated sales are unavailable for this period."/>;
 return <View style={{gap:spacing.s8}} onLayout={event=>setWidth(event.nativeEvent.layout.width)}>
  <View style={{flexDirection:'row',gap:spacing.s12,flexWrap:'wrap'}}><Text style={type.caption}>━ Current · above</Text><Text style={type.caption}>┄ Previous · below</Text></View>
  <View accessible accessibilityLabel={`Mirrored sales comparison in ${currency}. Both halves use the same zero baseline and scale. ${points.length} time buckets. Choose a bucket below for exact amounts.`}>
   <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
    {[.25,.5,.75].map(ratio=><Line key={ratio} x1={pad} x2={width-pad} y1={height*ratio} y2={height*ratio} stroke={colors.border} strokeDasharray={ratio===.5?undefined:'3 5'}/>)}
    {runs(current,-1).map((run,i)=><Polyline key={`current-${i}`} points={run} fill="none" stroke={chartColors.primary} strokeWidth={2.5}/>)}
    {runs(previous,1).map((run,i)=><Polyline key={`previous-${i}`} points={run} fill="none" stroke={chartColors.secondary} strokeWidth={2} strokeDasharray="5 4"/>)}
    {current[index]!=null?<Circle cx={x(index)} cy={mid-current[index]!/max*amplitude} r={4} fill={chartColors.primary}/>:null}
    {previous[index]!=null?<Circle cx={x(index)} cy={mid+previous[index]!/max*amplitude} r={4} fill={chartColors.secondary}/>:null}
   </Svg>
  </View>
  <Text style={type.caption}>Both halves show positive sales on one scale. Gaps mean unavailable amounts.</Text>
  <Choice label="Compare time bucket" value={String(index)} options={points.map((point,i)=>({value:String(i),label:point.label}))} onChange={setSelection} testID="analytics-bento-period"/>
  <View style={{flexDirection:'row',gap:spacing.s12,flexWrap:'wrap'}}><View style={{flex:1,minWidth:100}}><Text style={type.caption}>Current</Text><Text style={type.numeric}>{analyticMoney(current[index],currency)}</Text></View><View style={{flex:1,minWidth:100}}><Text style={type.caption}>Previous</Text><Text style={type.numeric}>{analyticMoney(previous[index],currency)}</Text></View></View>
  <Button label="View supporting orders" variant="ghost" onPress={()=>onPoint(points[index])}/>
 </View>;
}

function Treemap({floors}:{floors:Pick<AnalyticsFloor,'id'|'name'|'currency'|'sales'>[]}) {
 const {isPhone}=useBp();
 const [width,setWidth]=useState(300);
 const complete=floors.every(floor=>floor.sales!=null&&Number.isFinite(floor.sales)&&floor.sales>=0);
 const height=isPhone?132:180;
 const items=floors.filter(floor=>(floor.sales??0)>0).map(floor=>({name:floor.name,group:floor.id,v:floor.sales!})).sort((a,b)=>b.v-a.v);
 const total=items.reduce((sum,item)=>sum+item.v,0);
 const rects=complete&&Number.isFinite(total)?squarify(items,0,0,width,height):[];
 const tones=[{fill:colors.brand,ink:colors.onBrand},{fill:colors.onSurface,ink:colors.surfaceSecondary},{fill:colors.brandTint,ink:colors.onSurface}];
 return <View style={{gap:spacing.s8}} onLayout={event=>setWidth(event.nativeEvent.layout.width)}>
  {rects.length?<View accessible accessibilityLabel={`Sales treemap. ${floors.map(floor=>`${floor.name}: ${analyticMoney(floor.sales,floor.currency)}, ${analyticNumber(floor.sales!/total*100)} percent`).join('. ')}. Use the business-unit controls below for details.`} style={{height,position:'relative'}}>{rects.map((rect,i)=>{const tone=tones[i%tones.length];return <View key={rect.group} aria-hidden style={{position:'absolute',left:rect.x+2,top:rect.y+2,width:Math.max(0,rect.w-4),height:Math.max(0,rect.h-4),borderRadius:8,backgroundColor:tone.fill,padding:spacing.s8,justifyContent:'space-between',overflow:'hidden'}}>{rect.w>=84&&rect.h>=52?<><Text style={[type.captionStrong,{color:tone.ink}]}>{rect.name}</Text><Text style={[type.numeric,{color:tone.ink}]}>{Math.round(rect.v/total*100)}%</Text></>:null}</View>;})}</View>:<Empty text={complete?'No positive sales to plot in this range.':'Sales share unavailable because one or more business amounts are missing.'}/>}
 </View>;
}

function ActivityPattern({points,currency,onPoint,onActivityPoint}:{points:AnalyticsTrend[];currency:string;onPoint:(point:AnalyticsTrend)=>void;onActivityPoint:(point:AnalyticsTrend)=>void}) {
 const [radial,setRadial]=useState(false);const [table,setTable]=useState(false);
 return <View style={{gap:spacing.s12}}>
  {radial?<Radar points={points} currency={currency} onPoint={onPoint}/>:<><ActivityDots label="Recorded orders per time bucket" items={points.map(point=>({id:point.id,label:point.label,value:point.orders}))}/><Text style={type.caption}>Dots compare activity; exact order counts appear below each column.</Text><Button size="sm" label={table?'Hide activity data':'View activity data'} variant="ghost" onPress={()=>setTable(!table)}/>{table?points.slice(-12).map(point=><DataLink key={point.id} label={point.label} value={`${analyticNumber(point.orders)} orders`} onPress={()=>onActivityPoint(point)}/>):null}</>}
  <Button size="sm" label={radial?'Show order activity':'View radial sales pattern'} variant="ghost" onPress={()=>setRadial(!radial)}/>
 </View>;
}

/** Supplied radar axes/rings adapted to actual zero-based marks, without smoothing data. */
function Radar({points,currency,onPoint}:{points:AnalyticsTrend[];currency:string;onPoint:(point:AnalyticsTrend)=>void}) {
 const [table,setTable]=useState(false);
 const shown=points.slice(-12);
 const values=shown.map(point=>currency==='RNB'?point.sales_rnb??null:point.sales);
 const max=Math.max(1,...values.map(value=>value??0));
 const S=216,C=S/2,R=S/2-32,N=shown.length;
 const ang=(i:number)=>-Math.PI/2+i/Math.max(1,N)*Math.PI*2;
 const at=(value:number,i:number)=>({x:C+Math.cos(ang(i))*R*value/max,y:C+Math.sin(ang(i))*R*value/max});
 const complete=values.every(value=>value!=null&&value>=0);
 return <View style={{gap:spacing.s8}}>
  {shown.length>=3?<View accessible accessibilityLabel={`Radial sales pattern in ${currency}. Radius starts at zero; outer ring ${analyticMoney(max,currency)}. ${shown.map((point,i)=>`${point.label}: ${analyticMoney(values[i],currency)}`).join('. ')}.`} style={{alignItems:'center'}}><Svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} aria-hidden>
   {[.33,.66,1].map(k=><Circle key={k} cx={C} cy={C} r={R*k} fill="none" stroke={colors.border}/>)}
   {shown.map((point,i)=><Line key={point.id} x1={C} y1={C} x2={C+Math.cos(ang(i))*R} y2={C+Math.sin(ang(i))*R} stroke={colors.border}/>)}
   {shown.map((point,i)=><SvgText key={`label-${point.id}`} x={C+Math.cos(ang(i))*(R+18)} y={C+Math.sin(ang(i))*(R+18)+4} textAnchor="middle" fontSize={11} fill={colors.onSurfaceMuted}>{point.label.length<=8?point.label:`${i+1}`}</SvgText>)}
   {complete?<Polygon points={values.map((value,i)=>{const p=at(value!,i);return `${p.x},${p.y}`;}).join(' ')} fill={colors.brandTint} stroke={chartColors.primary} strokeWidth={2}/>:null}
   {values.map((value,i)=>{if(value==null||value<0)return null;const p=at(value,i);return <Circle key={shown[i].id} cx={p.x} cy={p.y} r={4} fill={chartColors.primary}/>;})}
   <Circle cx={C} cy={C} r={4} fill={colors.surfaceSecondary} stroke={colors.onSurfaceMuted}/>
  </Svg></View>:<Empty text="At least three dated buckets are needed for a radial pattern."/>}
  <Text style={type.caption}>{points.length>12?'Latest 12 time buckets. ':'Selected time buckets. '}Year-over-year seasonality is unavailable in this scoped report; the chart shows recorded sales in this range.</Text>
  {shown.some(point=>point.label.length>8)?<Text style={type.caption}>Axes run clockwise in date order; numbers match the pattern data below.</Text>:null}
  {shown.length?<View style={{flexDirection:'row',justifyContent:'space-between',gap:spacing.s8}}><Text style={type.caption}>{shown[0].label}</Text><Text style={type.caption}>{shown[shown.length-1].label}</Text></View>:null}
  <Button label={table?'Hide pattern data':'View pattern data'} icon={table?'chevron-up':'list'} variant="ghost" onPress={()=>setTable(!table)}/>
  {table?shown.map((point,i)=><DataLink key={point.id} label={`${i+1}. ${point.label}`} value={analyticMoney(values[i],currency)} onPress={()=>onPoint(point)}/>):null}
 </View>;
}

export default AnalyticsBento;
