import { View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/src/components/AppText';
import { Avatar } from '@/src/design/surfaces';
import { Button } from '@/src/components/ui';
import { colors, spacing, type } from '@/src/theme/tokens';

type ActivityStat = { label: string; value: number; color: string };
export type MarketingDashboardProps = {
 title?: string;
 teamActivities: { total: number; unit: string; stats: ActivityStat[] };
 team: { memberCount: number; members: { id: string; name: string }[] };
 cta: { text: string; buttonText: string; onButtonClick: () => void };
};

/** User-supplied dashboard-1 composition adapted to recorded ERP work and native primitives. */
export function MarketingDashboard({title='Follow-up activity',teamActivities,team,cta}:MarketingDashboardProps) {
 const total=teamActivities.stats.reduce((sum,stat)=>sum+stat.value,0);
 return <View testID="analytics-team-graphic" style={{gap:spacing.s12}}>
  <View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s12}}>
   <View style={{flexGrow:2,flexBasis:160,minWidth:0,gap:spacing.s8}}>
    <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s8}}><Feather accessible={false} name="activity" size={16} color={colors.onSurfaceMuted}/><Text style={type.bodySm}>{title}</Text></View>
    <Text style={[type.numeric,{fontSize:20,lineHeight:28}]}>{teamActivities.total.toLocaleString('en-IN')} <Text style={type.caption}>{teamActivities.unit}</Text></Text>
    <View accessible accessibilityLabel={teamActivities.stats.map(stat=>`${stat.label}: ${stat.value}`).join('. ')} style={{gap:spacing.s8}}>
     <View aria-hidden style={{height:10,flexDirection:'row',borderRadius:5,overflow:'hidden',backgroundColor:colors.surfaceTertiary}}>{teamActivities.stats.map(stat=><View key={stat.label} style={{height:10,width:`${total?stat.value/total*100:0}%`,backgroundColor:stat.color,borderRightWidth:2,borderRightColor:colors.surfaceSecondary}}/>)}</View>
     <View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s8}}>{teamActivities.stats.map(stat=><Text key={stat.label} style={type.caption}>{stat.label} {stat.value.toLocaleString('en-IN')}</Text>)}</View>
    </View>
   </View>
   <View style={{flexGrow:1,flexBasis:120,minWidth:0,gap:spacing.s8}}>
    <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s8}}><Feather accessible={false} name="users" size={16} color={colors.onSurfaceMuted}/><Text style={type.bodySm}>Active assignees</Text></View>
    <View style={{flexDirection:'row',alignItems:'center',gap:spacing.s8}}><Text style={[type.numeric,{fontSize:20,lineHeight:28}]}>{team.memberCount.toLocaleString('en-IN')}</Text><View accessible accessibilityLabel={team.members.map(member=>member.name).join(', ')} style={{flexDirection:'row',paddingLeft:spacing.s4}}>{team.members.slice(0,4).map(member=><View key={member.id} style={{marginLeft:-spacing.s4,borderWidth:2,borderColor:colors.surfaceSecondary,borderRadius:20}}><Avatar name={member.name} size={28}/></View>)}</View></View>
    <Text style={type.caption}>{team.members.slice(0,3).map(member=>member.name).join(', ')}{team.members.length>3?` +${team.members.length-3}`:''}</Text>
   </View>
  </View>
  <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:spacing.s8,borderTopWidth:1,borderTopColor:colors.border,paddingTop:spacing.s4}}><Text style={[type.caption,{flexGrow:1,flexBasis:140}]}>{cta.text}</Text><Button size="sm" label={cta.buttonText} iconRight="chevron-down" variant="ghost" onPress={cta.onButtonClick}/></View>
 </View>;
}
