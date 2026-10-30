import { Platform, Pressable, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import { Text } from '@/src/components/AppText';
import { type } from '@/src/theme/tokens';
import { graphScale } from './graphScale';
import { useSalesTheme } from './salesTheme';
const linkActivation=(onPress:()=>void)=>Platform.OS==='web'?{onKeyDown:(event:React.KeyboardEvent)=>{if(event.key==='Enter'){event.preventDefault();onPress();}}}:{};

export type GraphRow={id:string;label:string;value:number|null|undefined;formatted:string;detail?:string;onPress?:()=>void;testID?:string};
/** Named bars share a zero baseline. Unknown and zero never acquire invented marks. */
export function RankedBars({rows,label,compact=false,maxValue}:{rows:GraphRow[];label:string;compact?:boolean;maxValue?:number}) {
 const theme=useSalesTheme();
 const scale=graphScale(rows.map(row=>row.value),maxValue);const zero=scale.zero;
 return <View testID="analytics-ranked-bars" accessibilityLabel={label} style={{gap:compact?8:16,minWidth:0}}>{rows.map(row=>{
  const known=row.value!=null&&Number.isFinite(row.value);
  const end=known?scale.position(row.value!):zero;
  const content=<><View style={{flexDirection:'row',flexWrap:'wrap',justifyContent:'space-between',alignItems:'baseline',gap:8}}><Text style={[type.bodySm,{flexGrow:1,flexShrink:1,minWidth:0,fontWeight:'500'}]}>{row.label}</Text><Text style={[type.bodySm,{fontVariant:['tabular-nums'],fontWeight:'600'}]}>{row.formatted}</Text></View>
   <View aria-hidden style={{height:compact?12:20,borderRadius:4,backgroundColor:theme.canvas,overflow:'hidden'}}><Svg width="100%" height={compact?12:20} viewBox={`0 0 100 ${compact?12:20}`} preserveAspectRatio="none" accessible={false}><Line x1={zero} x2={zero} y1={0} y2={compact?12:20} stroke={theme.line} strokeWidth={.4}/>{known&&row.value!==0?<Rect x={Math.min(zero,end)} y={2} width={Math.abs(end-zero)} height={compact?8:16} rx={1} fill={theme.accent}/>:null}</Svg></View>
   {row.detail?<Text style={type.caption}>{row.detail}</Text>:null}</>;
  return row.onPress?<Pressable key={row.id} testID={row.testID} accessibilityRole="link" {...linkActivation(row.onPress)} accessibilityLabel={`${row.label}: ${row.formatted}. Open supporting records`} onPress={row.onPress} style={({pressed,hovered}:any)=>({minHeight:44,gap:8,paddingVertical:4,backgroundColor:pressed||hovered?theme.tint:'transparent'})}>{content}</Pressable>:<View key={row.id} testID={row.testID} style={{minHeight:44,gap:8,paddingVertical:4}}>{content}</View>;
 })}</View>;
}

/** Mini columns are real dated values, never decorative strokes or a sales target. */
export function DatedColumns({rows,label}:{rows:GraphRow[];label:string}) {
 const theme=useSalesTheme();const shown=rows.slice(-12);
 const scale=graphScale(shown.map(row=>row.value));
 const y=(value:number)=>64-scale.position(value)*.6;
 const step=100/Math.max(1,shown.length);
 return <View accessibilityLabel={label} style={{gap:8,minWidth:0}}>
  <View accessible accessibilityLabel={`${label}. ${shown.map(row=>`${row.label}: ${row.formatted}`).join('. ')}`}>
   <Svg aria-hidden accessible={false} width="100%" height={72} viewBox="0 0 100 72" preserveAspectRatio="none"><Line x1={0} x2={100} y1={y(0)} y2={y(0)} stroke={theme.line} strokeWidth={.5}/>{shown.map((row,index)=>row.value!=null&&Number.isFinite(row.value)&&row.value!==0?<Rect key={row.id} x={(index+.15)*step} width={step*.7} y={Math.min(y(0),y(row.value))} height={Math.abs(y(row.value)-y(0))} rx={.6} fill={theme.accent}/>:null)}</Svg>
  </View>
  <View style={{flexDirection:'row',justifyContent:'space-between',gap:8}}><Text style={type.caption}>{shown[0]?.label||'No dated values'}</Text>{shown.length>1?<Text style={type.caption}>{shown[shown.length-1].label}</Text>:null}</View>
 </View>;
}
