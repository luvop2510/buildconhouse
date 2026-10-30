import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { salesWorkspaceApi } from '@/src/api/salesWorkspaces';
import { analyticsQuery } from '@/src/api/salesAnalytics';
import { spacing, type } from '@/src/theme/tokens';
import { ReferrerDirectory } from './ReferrerDirectory';
import { Empty, ReadState } from '@/src/components/salesAnalytics/AnalyticsParts';
import { AnalyticsFilters } from '@/src/components/salesAnalytics/AnalyticsFilters';
import { useAnalyticsRead, useResolvedAnalyticsPeriod } from '@/src/components/salesAnalytics/useAnalytics';
import { ReportHeader } from './SalesReportParts';

export function ReferencesWorkspace(){
 const params=useLocalSearchParams<{kind?:string}>();
 const {filters:selected,update,floors,canView,accessError,retryAccess,period,periodRead}=useResolvedAnalyticsPeriod();
 const bounds=periodRead.data?.period;
 const key=analyticsQuery(selected)+':'+(period?.dateFrom||'')+':'+(period?.dateTo||'');
 const read=useAnalyticsRead(`reference-performance:${key}`,signal=>salesWorkspaceApi.get('relationships',{floorId:selected.floor_id,preset:period!.preset,dateFrom:period!.dateFrom||undefined,dateTo:period!.dateTo||undefined},{signal}),canView&&!!period);
 return <AdminPage title="Reference variety" header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}><View style={{width:'100%',maxWidth:1280,alignSelf:'center',gap:spacing.s16}}>
 <ReportHeader title="Reference variety" subtitle={bounds?.label||'Selected sales period'} updating={read.refreshing||periodRead.refreshing} refresh={()=>{periodRead.refresh();read.refresh();}}/>
 {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:<>
 <AnalyticsFilters filters={selected} showDateBasis={false} update={next=>update({...next,date_basis:'confirmation'})} floors={floors}/>
 <Text style={type.caption}>Clients use referral dates. Sales use order confirmation dates in the same India calendar period.</Text>
 <ReadState loading={false} refreshing={read.refreshing} error={accessError||periodRead.error||read.error} retry={accessError?()=>void retryAccess():()=>{periodRead.refresh();read.refresh();}}/>
 {read.data?.relationships_truncated?<Text style={type.bodySm}>Performance covers up to 2,000 references. Search the directory for every contact.</Text>:null}
 <ReferrerDirectory floorId={selected.floor_id} period={period} kind={params.kind==='architect'||params.kind==='interior_designer'?params.kind:undefined} performance={read.data?.relationships} performanceLoading={!period||read.loading&&!read.data} onSaved={read.refresh}/>
 </>}
 </View></AdminPage>;
}
