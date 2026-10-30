import { useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { Button } from '@/src/components/ui';
import { salesAnalyticsApi } from '@/src/api/salesAnalytics';
import { colors, spacing, type } from '@/src/theme/tokens';
import { analyticNumber, chartColors, Empty, Panel, ReadState } from './AnalyticsParts';
import { useAnalyticsRead } from './useAnalytics';
import { MarketingDashboard } from '@/src/components/ui/dashboard-1';

/** Current operations have their own clock and do not inherit a historic sales range. */
export function OwnerOperations({floorId,refreshVersion=0}:{floorId:string;refreshVersion?:number|string}) {
 const read=useAnalyticsRead(`owner-operations:${floorId}:${refreshVersion}`,signal=>salesAnalyticsApi.ownerOperations({floor_id:floorId},signal));
 const [notes,setNotes]=useState(false);const [stages,setStages]=useState(false);const [teamDetails,setTeamDetails]=useState(false);
 const data=read.data;
 const max=Math.max(1,...(data?.team||[]).map(row=>row.contacts));
 return <Panel title="Team & current work" description="Current follow-ups · recorded contacts in the last 30 days" testID="analytics-owner-operations">
  <Button label="Refresh team status" variant="ghost" onPress={read.refresh}/><ReadState loading={read.loading&&!data} error={read.error} retry={read.refresh}/>
  {data?<><MarketingDashboard teamActivities={{total:data.open_followups+data.completed_followups+data.dismissed_followups,unit:'tracked follow-ups',stats:[{label:'Open',value:Math.max(0,data.open_followups-data.overdue_followups),color:colors.brand},{label:'Overdue',value:data.overdue_followups,color:colors.warning},{label:'Completed',value:data.completed_followups,color:colors.success},{label:'Dismissed',value:data.dismissed_followups,color:colors.onSurfaceMuted}]}} team={{memberCount:data.team.length,members:data.team}} cta={{text:`${analyticNumber(data.team.reduce((sum,person)=>sum+person.contacts,0))} contacts · last 30 days · ${analyticNumber(data.unassigned_followups)} unassigned`,buttonText:teamDetails?'Hide team details':'View team details',onButtonClick:()=>setTeamDetails(!teamDetails)}}/>
   {data.team.length?teamDetails?data.team.map(person=><View key={person.id} style={{gap:spacing.s8,paddingVertical:spacing.s12,borderBottomWidth:1,borderBottomColor:colors.border}}><View style={{flexDirection:'row',justifyContent:'space-between',gap:spacing.s8,flexWrap:'wrap'}}><Text style={type.bodyStrong}>{person.name}</Text><Text style={[type.bodyStrong,{fontVariant:['tabular-nums']}]}>{analyticNumber(person.contacts)} contacts</Text></View><View aria-hidden style={{height:8,backgroundColor:colors.surfaceTertiary,borderRadius:4,overflow:'hidden'}}><View style={{height:8,width:`${person.contacts/max*100}%`,backgroundColor:chartColors.primary}}/></View><Text style={type.bodySm}>{analyticNumber(person.open)} open · {analyticNumber(person.overdue)} overdue · {analyticNumber(person.completed)} recorded completed · {analyticNumber(person.calls)} calls</Text></View>):null:<Empty text="No assigned follow-ups or recorded contact activity in this scope."/>}
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
