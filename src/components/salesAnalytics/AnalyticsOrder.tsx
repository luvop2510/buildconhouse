import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button } from '@/src/components/ui';
import { openApiFile, downloadApiFile } from '@/src/utils/downloadFile';
import { spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi } from '@/src/api/salesAnalytics';
import { analyticMoney, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { RecordTable } from './AnalyticsProfile';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';
export function AnalyticsOrderPage() {
 const {id}=useLocalSearchParams<{id:string}>(); const {filters,go,router,canView}=useAnalyticsScope(); const [documentError,setDocumentError]=useState('');
 const read=useAnalyticsRead(`${id}:${analyticsQuery(filters)}`,signal=>salesAnalyticsApi.order(id,filters,signal),canView&&!!id);
 return <AdminPage title="Order details" header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}>
 <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:spacing.s8}}><Button label="Back" icon="arrow-left" variant="ghost" onPress={()=>router.canGoBack()?router.back():go('/(admin)/sales-data/records')}/></View>
 <ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>
 {read.data?<><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:spacing.s12}}><View style={{flex:1,minWidth:160,gap:spacing.s4}}><Text accessibilityRole="header" aria-level={1} style={type.displayMd}>{read.data.number||read.data.id}</Text><Text style={type.bodyMuted}>{FLOOR_NAMES[read.data.floor_id]||read.data.floor_id} · {read.data.status} · {read.data.date||'Date unavailable'}</Text></View><ExportMenu filters={filters} view="order" entityId={id}/></View>
 <Panel title="Order identity"><Text style={type.body}>Stable ID: {read.data.id}</Text><Button label={`Customer: ${read.data.customer_name||'Unavailable'}`} disabled={!read.data.customer_id} variant="ghost" onPress={()=>go(`/(admin)/sales-data/profile/customers/${encodeURIComponent(read.data!.customer_id!)}`)}/>{read.data.architect_id?<Button label={`Architect: ${read.data.architect_name||read.data.architect_id}`} variant="ghost" onPress={()=>go(`/(admin)/sales-data/profile/architects/${encodeURIComponent(read.data!.architect_id!)}`)}/>:<Text style={type.bodySm}>Architect attribution unavailable</Text>}</Panel>
 <Panel title="Order summary"><View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s16}}>{Object.entries(read.data.summary).map(([name,value])=><View key={name} style={{flexGrow:1,flexBasis:160,gap:spacing.s4}}><Text style={type.caption}>{name.replace(/_/g,' ')}</Text><Text style={[type.titleMd,{fontVariant:['tabular-nums']}]}>{analyticMoney(value,read.data!.currency)}</Text></View>)}</View></Panel>
 <RecordTable name="Order lines" rows={read.data.lines} go={go}/><RecordTable name="payments" rows={read.data.payments} go={go}/><RecordTable name="Order timeline" rows={read.data.timeline} go={go}/>
 <Panel title="Documents">{read.data.documents.length?read.data.documents.map((document,index)=>{const path=String(document.path||document.download_path||document.url||''); const permittedPath=path.startsWith('/api/')?path.slice(4):path.startsWith('/')&&!path.startsWith('//')?path:''; const name=String(document.name||document.filename||`Document ${index+1}`);return <View key={String(document.id||index)} style={{gap:spacing.s8}}><Text style={type.bodyStrong}>{name}</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s8}}><Button label="Open document" disabled={!permittedPath} variant="secondary" onPress={()=>void openApiFile(permittedPath,name,read.data!.floor_id).catch(()=>setDocumentError('Could not open the document. Try downloading it.'))}/><Button label="Download document" disabled={!permittedPath} variant="ghost" onPress={()=>void downloadApiFile(permittedPath,name,name,read.data!.floor_id)}/></View>{!permittedPath?<Text style={type.bodySm}>The source record has no authenticated document download.</Text>:null}</View>}):<Text style={type.bodyMuted}>No permitted documents are recorded for this order.</Text>}{documentError?<Text accessibilityRole="alert" style={type.bodySm}>{documentError}</Text>:null}</Panel>
 {read.data.notes.map(note=><Text key={note} style={type.bodySm}>{note}</Text>)}
 </>:null}
 </AdminPage>;
}
