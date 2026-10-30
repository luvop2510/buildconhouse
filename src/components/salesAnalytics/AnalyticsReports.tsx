import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button, TextField } from '@/src/components/ui';
import { useAuth } from '@/src/state/auth';
import { storage } from '@/src/utils/storage';
import { spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsFilters as FilterValues } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { DashboardContent } from './AnalyticsDashboard';
import { DataLink, Empty, ExportMenu, Panel, ReadState } from './AnalyticsParts';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';

type ReportHistory={id:string;title:string;at:string;filters:FilterValues};
export function AnalyticsReports() {
 const {filters,update,go,floors,canView,accessError,retryAccess}=useAnalyticsScope();
 const {staff}=useAuth();
 const [title,setTitle]=useState('Sales report');
 const [preview,setPreview]=useState(false);
 const [historyOpen,setHistoryOpen]=useState(false);
 const [saved,setSaved]=useState<{key:string;items:ReportHistory[]}>({key:'',items:[]});
 const [saveError,setSaveError]=useState('');
 const historyKey=`forge.analytics.reports.${staff?.id||''}`;
 const history=saved.key===historyKey?saved.items:[];
 useEffect(()=>{
  if(!canView)return;
  let alive=true;
  void storage.getItem<string>(historyKey,'[]').then(value=>{
   if(!alive)return;
   try { const parsed=JSON.parse(value||'[]');setSaved({key:historyKey,items:Array.isArray(parsed)?parsed.filter(row=>row&&typeof row.id==='string'&&typeof row.title==='string'&&row.filters).slice(0,30):[]}); }
   catch { setSaved({key:historyKey,items:[]}); }
  });
  return()=>{alive=false;};
 },[historyKey,canView]);
 const read=useAnalyticsRead(`dashboard:${analyticsQuery(filters)}`,signal=>salesAnalyticsApi.dashboard(filters,signal),canView&&preview);
 const create=async()=>{
  if(!title.trim()){setSaveError('Give the report a title.');return;}
  setPreview(true);setSaveError('');
  const next=[{id:String(Date.now()),title:title.trim(),at:new Date().toISOString(),filters:{...filters}},...history].slice(0,30);
  setSaved({key:historyKey,items:next});
  const stored=await storage.setItem(historyKey,JSON.stringify(next));
  setSaveError(stored?'':'The preview is ready. This device could not save its filter history. Generate it again to retry.');
 };
 return <AdminPage title="Reports" header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}>
  <View style={{width:'100%',maxWidth:1280,alignSelf:'center',gap:spacing.s16}}>
   <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:spacing.s12}}>
    <Text accessibilityRole="header" aria-level={1} style={type.titleLg}>Reports</Text>
    <AnalyticsFilters filters={filters} update={values=>{update(values);setPreview(false);}} floors={floors}/>
   </View>
   {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:<>
    {accessError?<ReadState loading={false} error={accessError} retry={()=>void retryAccess()}/>:null}
    <Panel title="Create a sales report" description="Preview the selected period, then download PDF or Excel.">
     <TextField label="Report title" value={title} onChangeText={setTitle} maxLength={200} testID="analytics-report-title"/>
     <View style={{flexDirection:'row',flexWrap:'wrap',alignItems:'center',gap:spacing.s8}}>
      <Button label={preview?'Update preview':'Generate preview'} onPress={()=>void create()} testID="analytics-report-preview"/>
      <Button label={historyOpen?'Hide saved reports':`Saved reports (${history.length})`} variant="ghost" onPress={()=>setHistoryOpen(value=>!value)}/>
     </View>
     {saveError?<Text accessibilityRole="alert" style={type.bodySm}>{saveError}</Text>:null}
     {historyOpen?<View style={{gap:spacing.s8}}>
      <Text style={type.caption}>Filter settings saved on this device. Opening a report refreshes its figures.</Text>
      {history.length?history.map(report=><DataLink key={report.id} label={report.title} detail={`${new Date(report.at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST`} onPress={()=>{setTitle(report.title);update(report.filters);setPreview(true);setHistoryOpen(false);}}/>):<Text style={type.bodyMuted}>Generate a report to save its filters here.</Text>}
     </View>:null}
    </Panel>
    {preview?<View style={{gap:spacing.s16}}>
     <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:spacing.s8,flexWrap:'wrap'}}>
      <Text accessibilityRole="header" aria-level={2} style={type.titleMd}>{title.trim()||'Report preview'}</Text>
      <ExportMenu filters={filters} view="dashboard" title={title.trim()}/>
     </View>
     <ReadState variant="dashboard" loading={read.loading&&!read.data} refreshing={read.refreshing} error={read.error} retry={read.refresh}/>
     {read.data?<DashboardContent data={read.data} filters={filters} update={update} go={go}/>:null}
    </View>:null}
   </>}
  </View>
 </AdminPage>;
}
