import { useState } from 'react';
import { View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/src/components/AppText';
import { Button } from '@/src/components/ui';
import { salesAnalyticsApi } from '@/src/api/salesAnalytics';
import { colors, spacing, type } from '@/src/theme/tokens';
import { useBp } from '@/src/design/responsive';
import { analyticNumber, chartColors, Empty, Panel, ReadState } from './AnalyticsParts';
import { useAnalyticsRead } from './useAnalytics';

/** Current operations have their own clock and do not inherit a historic sales range. */
export function OwnerOperations({floorId,refreshVersion=0}:{floorId:string;refreshVersion?:number|string}) {
 const read=useAnalyticsRead(`owner-operations:${floorId}:${refreshVersion}`,signal=>salesAnalyticsApi.ownerOperations({floor_id:floorId},signal));
 const [notes,setNotes]=useState(false);const [stages,setStages]=useState(false);const {isPhone}=useBp();
 const data=read.data;
 const max=Math.max(1,...(data?.team||[]).map(row=>row.contacts));
 return <Panel title="Team & current work" description="Current follow-ups · recorded contacts in the last 30 days" testID="analytics-owner-operations">
  <Button label="Refresh team status" variant="ghost" onPress={read.refresh}/><ReadState loading={read.loading&&!data} error={read.error} retry={read.refresh}/>
  {data?<><View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s12}}>{[{label:'Open follow-ups',value:data.open_followups,icon:'clock'},{label:'Overdue',value:data.overdue_followups,icon:'alert-circle'},{label:'Completed follow-ups',value:data.completed_followups,icon:'check-circle'},{label:'Unassigned',value:data.unassigned_followups,icon:'user'}].map(item=><View key={item.label} style={{flexGrow:1,flexBasis:isPhone?'44%':0,minWidth:0,gap:spacing.s8,padding:spacing.s12,backgroundColor:colors.surfaceTertiary,borderRadius:8}}><Feather name={item.icon as 'clock'} color={colors.onSurfaceMuted} size={18} aria-hidden/><Text style={type.bodySm}>{item.label}</Text><Text style={[type.titleLg,{fontVariant:['tabular-nums']}]}>{analyticNumber(item.value)}</Text></View>)}</View>
   {data.team.length?data.team.map(person=><View key={person.id} style={{gap:spacing.s8,paddingVertical:spacing.s12,borderBottomWidth:1,borderBottomColor:colors.border}}><View style={{flexDirection:'row',justifyContent:'space-between',gap:spacing.s8,flexWrap:'wrap'}}><Text style={type.bodyStrong}>{person.name}</Text><Text style={[type.bodyStrong,{fontVariant:['tabular-nums']}]}>{analyticNumber(person.contacts)} contacts</Text></View><View aria-hidden style={{height:8,backgroundColor:colors.surfaceTertiary,borderRadius:4,overflow:'hidden'}}><View style={{height:8,width:`${person.contacts/max*100}%`,backgroundColor:chartColors.primary}}/></View><Text style={type.bodySm}>{analyticNumber(person.open)} open · {analyticNumber(person.overdue)} overdue · {analyticNumber(person.completed)} recorded completed · {analyticNumber(person.calls)} calls</Text></View>):<Empty text="No assigned follow-ups or recorded contact activity in this scope."/>}
   {data.workflows?.map(workflow=><View key={workflow.floor_id} testID={`analytics-workflow-${workflow.floor_id}`} style={{gap:spacing.s12,paddingTop:spacing.s16,borderTopWidth:1,borderTopColor:colors.border}}><Text accessibilityRole="header" aria-level={3} style={type.titleMd}>{workflow.name} · current status</Text><Text style={type.bodyStrong}>{analyticNumber(workflow.total)} {workflow.unit}{workflow.active!=null?` · ${analyticNumber(workflow.active)} active`:''}{workflow.completed!=null?` · ${analyticNumber(workflow.completed)} completed`:''}{workflow.overdue!=null?` · ${analyticNumber(workflow.overdue)} overdue`:''}</Text>
    {workflow.workload?.map(person=><Text key={person.id||'unassigned'} style={type.bodySm}>{person.name} · {analyticNumber(person.count)} active projects</Text>)}
    {stages?workflow.stages.map(stage=><View key={stage.id} style={{gap:spacing.s4}}><View style={{flexDirection:'row',justifyContent:'space-between',gap:spacing.s8}}><Text style={type.bodySm}>{stage.name}</Text><Text style={type.bodyStrong}>{analyticNumber(stage.count)}</Text></View><View aria-hidden style={{height:6,backgroundColor:colors.surfaceTertiary,borderRadius:3,overflow:'hidden'}}><View style={{height:6,width:`${stage.count/Math.max(1,...workflow.stages.map(row=>row.count))*100}%`,backgroundColor:chartColors.primary}}/></View></View>):null}
   </View>)}
   {data.workflows?.length?<Button label={stages?'Hide workflow stages':'View workflow stages'} variant="ghost" onPress={()=>setStages(!stages)}/>:null}
   <Text style={type.caption}>Workload belongs to current assignees. Contact activity belongs to the person who recorded it. Completed counts cover recorded history.</Text>
   <Button label={notes?'Hide source notes':'How this is measured'} variant="ghost" onPress={()=>setNotes(!notes)}/>{notes?data.notes.map(note=><Text key={note} style={type.bodySm}>{note}</Text>):null}
  </>:null}
 </Panel>;
}
