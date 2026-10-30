import { View, useWindowDimensions } from 'react-native';
import type { TodayData } from '@/src/api/today';
import { HalfGauge, SegmentedMeter } from '@/src/design/graphics';
import { Surface, Txt, Skeleton } from '@/src/design/components';
import { useBp } from '@/src/design/responsive';
import { color, space } from '@/src/design/tokens';

export function TodaySummary({summary,unavailable=false}:{summary:TodayData['task_summary']|undefined;unavailable?:boolean}) {
 const {isPhone,width}=useBp();
 const {fontScale}=useWindowDimensions();
 const share=summary&&summary.open>0&&summary.due_today<=summary.open?summary.due_today/summary.open:summary&&summary.open===0&&summary.due_today===0?0:null;
 return <Surface pad={0} style={{overflow:'hidden'}}><View testID="today-task-summary" style={{flexDirection:fontScale>1.3?'column':'row'}}>
  <View style={{flex:1.2,minWidth:0,padding:isPhone?space.x3:space.x4,backgroundColor:color.action,gap:space.x2}}>
   <Txt v="caption" tone="onAction">Open tasks</Txt>
   {summary?<Txt v="moneyLg" tone="onAction" style={{fontSize:isPhone?26:30,lineHeight:isPhone?32:36}}>{summary.open.toLocaleString('en-IN')}</Txt>:unavailable?<Txt v="sub" tone="onAction">Unavailable</Txt>:<Skeleton w={48} h={32}/>}
   <SegmentedMeter inverse values={summary?[{value:summary.overdue,color:color.onAction},{value:Math.max(0,summary.open-summary.overdue),color:'rgba(255,255,255,0.3)'}]:[]} label={summary?`${summary.overdue} overdue of ${summary.open} open tasks`:'Task counts loading'}/>
   <View style={{gap:space.x1}}><Txt v="caption" tone="onAction">Overdue {summary?.overdue.toLocaleString('en-IN')??'—'}</Txt><Txt v="caption" tone="onAction">Due today {summary?.due_today.toLocaleString('en-IN')??'—'}</Txt></View>
  </View>
  <View style={{flex:1,minWidth:0,padding:space.x3,alignItems:'center',justifyContent:'center',gap:space.x1}}>
   <Txt v="caption" tone="soft">Due today / open</Txt>
   <HalfGauge size={isPhone&&width<360?104:128} testID="today-urgency-meter" ratio={share} label="Share of current open tasks due today" value={share==null?'Unavailable':`${Math.round(share*100)}%`}/>
   <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',justifyContent:'center',gap:space.x1}}><Txt v="caption" tone="soft">Completed today</Txt><Txt v="moneySm">{summary?.completed_today.toLocaleString('en-IN')??'—'}</Txt></View>
  </View>
 </View></Surface>;
}

export function WorkflowDistribution({workflow}:{workflow:TodayData['workflows'][number]}) {
 const tones=[color.action,color.inkMid,color.inkSoft];
 return <View testID={`today-workflow-${workflow.resource}`} style={{gap:space.x2}}>
  <View style={{flexDirection:'row',justifyContent:'space-between',gap:space.x2}}><Txt v="rowTitle" style={{flex:1}}>{workflow.label}</Txt><Txt v="num">{workflow.total.toLocaleString('en-IN')}</Txt></View>
  <SegmentedMeter values={workflow.statuses.map((row,i)=>({value:row.count,color:tones[i%tones.length]}))} label={`${workflow.label}. ${workflow.statuses.map(row=>`${row.status}: ${row.count}`).join('. ')}`}/>
  {workflow.statuses.map((row,i)=><View key={row.status} style={{flexDirection:'row',alignItems:'center',gap:space.x2}}><View aria-hidden style={{width:6,height:6,borderRadius:3,backgroundColor:tones[i%tones.length]}}/><Txt v="sub" tone="soft" style={{flex:1}}>{row.status}</Txt><Txt v="num">{row.count.toLocaleString('en-IN')}</Txt></View>)}
 </View>;
}
