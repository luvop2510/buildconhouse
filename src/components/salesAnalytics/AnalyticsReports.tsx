import { useEffect, useState } from 'react';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button, TextField } from '@/src/components/ui';
import { useAuth } from '@/src/state/auth';
import { storage } from '@/src/utils/storage';
import { spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsFilters as FilterValues } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { DashboardContent } from './AnalyticsDashboard';
import { DataLink, ExportMenu, Panel, ReadState } from './AnalyticsParts';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';
type ReportHistory={id:string;title:string;at:string;filters:FilterValues};
export function AnalyticsReports() {
 const {filters,update,go,floors,canView}=useAnalyticsScope(); const {staff}=useAuth(); const [title,setTitle]=useState('Sales performance report'); const [preview,setPreview]=useState(false);const [history,setHistory]=useState<ReportHistory[]>([]);const [saveError,setSaveError]=useState('');
 const historyKey=`forge.analytics.reports.${staff?.id||''}`;
 useEffect(()=>{let alive=true;void storage.getItem<string>(historyKey,'[]').then(value=>{if(!alive)return;try{const parsed=JSON.parse(value||'[]');if(Array.isArray(parsed))setHistory(parsed.filter(row=>row&&typeof row.id==='string'&&typeof row.title==='string'&&row.filters));}catch{setHistory([]);}});return()=>{alive=false;};},[historyKey]);
 const read=useAnalyticsRead(analyticsQuery(filters),signal=>salesAnalyticsApi.dashboard(filters,signal),canView&&preview);
 const create=async()=>{if(!title.trim()){setSaveError('Give the report a title.');return;}setPreview(true);const next=[{id:String(Date.now()),title:title.trim(),at:new Date().toISOString(),filters:{...filters}},...history].slice(0,30);setHistory(next);const saved=await storage.setItem(historyKey,JSON.stringify(next));setSaveError(saved?'':'The preview is ready, but this browser could not save the report history.');};
 return <AdminPage title="Reports" header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}><Text accessibilityRole="header" aria-level={1} style={type.displayMd}>Reports</Text><Text style={type.bodyMuted}>Create a scoped report, review the source data, then download PDF or Excel.</Text>
 <AnalyticsFilters filters={filters} update={values=>{update(values);setPreview(false);}} floors={floors}/>
 <Panel title="Create report"><TextField label="Report title" value={title} onChangeText={setTitle} maxLength={200} testID="analytics-report-title"/><Button label="Generate preview" onPress={()=>void create()} testID="analytics-report-preview"/>{saveError?<Text accessibilityRole="alert" style={type.bodySm}>{saveError}</Text>:null}</Panel>
 {preview?<Panel title={title.trim()||'Report preview'} action={<ExportMenu filters={filters} view="dashboard" title={title.trim()}/>}><ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>{read.data?<DashboardContent data={read.data} filters={filters} update={update} go={go}/>:null}</Panel>:null}
 <Panel title="Report history"><Text style={type.caption}>Saved on this device for your account. Opening a report refreshes its source data and permissions.</Text>{history.length?history.map(report=><DataLink key={report.id} label={report.title} detail={`${new Date(report.at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST · ${report.filters.preset?.replace(/_/g,' ')}`} onPress={()=>{setTitle(report.title);update(report.filters);setPreview(true);}}/>):<Text style={type.bodyMuted}>Generate a report to save its filter settings here.</Text>}</Panel>
 </AdminPage>;
}
