import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button } from '@/src/components/ui';
import { spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { analyticMoney, Choice, EntityLedger, Empty, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { Pagination } from './AnalyticsEntities';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';
export function AnalyticsRecords() {
 const {filters,update,go,floors,router,canView}=useAnalyticsScope();
 const read=useAnalyticsRead(`records:${analyticsQuery(filters)}`,signal=>salesAnalyticsApi.records(filters,signal),canView);
 return <AdminPage title="Supporting orders" header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}>
 <View style={{width:'100%',maxWidth:1280,alignSelf:'center',gap:spacing.s16}}>
 <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:spacing.s8}}><Button label="Back" icon="arrow-left" variant="ghost" onPress={()=>router.canGoBack()?router.back():go('/(admin)/sales-data')}/></View>
 <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:spacing.s12}}><Text accessibilityRole="header" aria-level={1} style={type.displayMd}>Supporting records</Text><ExportMenu filters={filters} view="records"/></View>
 <AnalyticsFilters filters={filters} update={update} floors={floors}/>
 <View style={{maxWidth:280}}><Choice label="Sort orders" value={filters.sort||'date_desc'} options={[{value:'date_desc',label:'Newest first'},{value:'date_asc',label:'Oldest first'},{value:'sales_desc',label:'Highest sales'},{value:'sales_asc',label:'Lowest sales'}]} onChange={sort=>update({sort})} testID="analytics-sort"/></View>
 <ReadState variant="list" loading={canView&&read.loading&&!read.data} refreshing={read.loading&&!!read.data} error={read.error} retry={read.refresh}/>
 {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:null}
 {read.data?<Panel title={`${read.data.total.toLocaleString('en-IN')} source records`}><Text style={type.caption}>Each customer order is counted once. Supplier purchase orders are excluded.</Text>{read.data.items.length?<EntityLedger testPrefix="analytics-record" valueLabel="Confirmed sales" rows={read.data.items.map(order=>({id:order.id,name:order.number||order.id,customer:order.customer_name||'Customer identity unavailable',department:FLOOR_NAMES[order.floor_id]||order.floor_id,status:order.status,detail:order.date?new Date(order.date).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'}):'Date unavailable',amount:order.sales,currency:order.currency,value:analyticMoney(order.sales,order.currency)}))} onRow={id=>{const order=read.data!.items.find(item=>item.id===id)!;go(`/(admin)/sales-data/order/${encodeURIComponent(order.id)}`,order.source?{source:order.source}:{});}}/>:<Empty/>}<Pagination total={read.data.total} page={read.data.page} size={read.data.page_size} update={update}/></Panel>:null}
 </View></AdminPage>;
}
