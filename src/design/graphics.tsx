import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Text } from '@/src/components/AppText';
import { color, font, space } from './tokens';

/** Quiet, labelled graphics shared by work and sales; no inferred targets. */
export function HalfGauge({ratio,label,value,testID,size=128}:{ratio:number|null;label:string;value:string;testID?:string;size?:number}) {
 const valid=ratio!=null&&Number.isFinite(ratio)&&ratio>=0&&ratio<=1;
 const arc=Math.PI*52;
 return <View testID={testID} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={valid?{min:0,max:100,now:Math.round(ratio!*100),text:value}:{text:'Unavailable'}} aria-valuemin={valid?0:undefined} aria-valuemax={valid?100:undefined} aria-valuenow={valid?Math.round(ratio!*100):undefined} aria-valuetext={valid?value:'Unavailable'} style={{width:size,height:size*80/128,alignItems:'center',justifyContent:'flex-end'}}>
  <Svg accessible={false} aria-hidden width={size} height={size*80/128} viewBox="0 0 128 80" style={{position:'absolute',top:0,left:0}}><Path d="M 12 64 A 52 52 0 0 1 116 64" fill="none" stroke={color.sunkenDeep} strokeWidth={12} strokeLinecap="round"/>{valid&&ratio!>0?<Path d="M 12 64 A 52 52 0 0 1 116 64" fill="none" stroke={color.action} strokeWidth={12} strokeLinecap="round" strokeDasharray={`${ratio!*arc} ${arc}`}/>:null}</Svg>
  <Text style={{fontFamily:font.semibold,fontSize:valid?22:13,lineHeight:28,fontWeight:'600',color:color.ink,fontVariant:['tabular-nums']}}>{valid?value:'Unavailable'}</Text>
 </View>;
}

export function SegmentedMeter({values,label,inverse=false,testID}:{values:{value:number;color:string}[];label:string;inverse?:boolean;testID?:string}) {
 const valid=values.every(item=>Number.isFinite(item.value)&&item.value>=0);
 const total=valid?values.reduce((sum,item)=>sum+item.value,0):0;
 return <View testID={testID} accessible accessibilityLabel={label} style={{flexDirection:'row',gap:3,height:24}}>{Array.from({length:24},(_,index)=>{
  const at=(index+.5)/24*total;
  let cumulative=0;
  const segment=total>0?values.find(item=>{cumulative+=item.value;return at<cumulative;}):undefined;
  return <View key={index} style={{flex:1,minWidth:0,borderRadius:3,backgroundColor:segment?.color||(inverse?'rgba(255,255,255,0.2)':color.sunkenDeep)}}/>;
 })}</View>;
}

export function ActivityDots({items,label}:{items:{id:string;label:string;value:number|null}[];label:string}) {
 const shown=items.slice(-12);
 const max=Math.max(1,...shown.map(item=>item.value??0));
 return <View accessible accessibilityLabel={`${label}. ${shown.map(item=>`${item.label}: ${item.value==null?'unavailable':item.value}`).join('. ')}`} style={{gap:space.x2}}>
  <View aria-hidden style={{flexDirection:'row',gap:space.x1,alignItems:'flex-end'}}>{shown.map(item=><View key={item.id} style={{flex:1,minWidth:0,alignItems:'center',gap:space.x1}}>{Array.from({length:6},(_,index)=><View key={index} style={{width:7,height:7,borderRadius:3.5,backgroundColor:item.value!=null&&index>=6-Math.round(Math.max(0,item.value)/max*6)?color.action:color.sunkenDeep}}/>)}<Text style={{fontFamily:font.medium,fontSize:12,lineHeight:16,color:color.ink}}>{item.value??'—'}</Text></View>)}</View>
  <View style={{flexDirection:'row',justifyContent:'space-between',gap:space.x2}}><Text style={{fontSize:12,lineHeight:16,color:color.inkSoft}}>{shown[0]?.label}</Text><Text style={{fontSize:12,lineHeight:16,color:color.inkSoft}}>{shown[shown.length-1]?.label}</Text></View>
 </View>;
}
