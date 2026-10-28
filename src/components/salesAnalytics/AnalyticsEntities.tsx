import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button } from '@/src/components/ui';
import { spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsKind } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { analyticMoney, analyticNumber, Choice, DataLink, Empty, ExportMenu, Panel, ReadState } from './AnalyticsParts';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';

const TITLES:Record<AnalyticsKind,string>={companies:'Companies / brands',products:'Products',architects:'Architects',customers:'Customers'};
export function AnalyticsEntities({kind}:{kind:AnalyticsKind}) {
 const {filters,update,go,floors,canView}=useAnalyticsScope();
 const read=useAnalyticsRead(`${kind}:${analyticsQuery(filters)}`,signal=>salesAnalyticsApi.entities(kind,filters,signal),canView);
 return <AdminPage title={TITLES[kind]} header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}>
 <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:spacing.s12}}><Text accessibilityRole="header" aria-level={1} style={type.displayMd}>{TITLES[kind]}</Text><ExportMenu filters={filters} view={kind}/></View>
 <AnalyticsFilters filters={filters} update={update} floors={floors}/>
 <View style={{maxWidth:280}}><Choice label="Rank by" value={filters.sort||'sales_desc'} options={[{value:'sales_desc',label:'Confirmed sales — highest first'},{value:'sales_asc',label:'Confirmed sales — lowest first'},{value:'orders_desc',label:'Order count'},{value:'aov_desc',label:'Average order value'},{value:'name_asc',label:'Name A–Z'}]} onChange={sort=>update({sort})} testID="analytics-sort"/></View>
 {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:<><ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>{read.data?<Panel title={`${analyticNumber(read.data.total)} ${TITLES[kind].toLowerCase()}`}>
 {read.data.items.length?read.data.items.map(row=><DataLink key={row.id} testID={`analytics-entity-${row.id}`} label={row.name} detail={[row.detail,`${analyticNumber(row.orders)} orders`,row.customers==null?'':`${analyticNumber(row.customers)} customers`,row.quantity==null?'':`${analyticNumber(row.quantity)} ${row.unit||'units'}`].filter(Boolean).join(' · ')} value={analyticMoney(row.sales)} secondary={row.sales_rnb?analyticMoney(row.sales_rnb,'RNB'):undefined} onPress={()=>go(`/(admin)/sales-data/profile/${kind}/${encodeURIComponent(row.id)}`)}/>):<Empty text={`No ${kind} match this scope. Try another date range or search.`}/>}
 <Pagination total={read.data.total} page={read.data.page} size={read.data.page_size} update={update}/>
 </Panel>:null}</>}
 </AdminPage>;
}
export function Pagination({total,page,size,update}:{total:number;page:number;size:number;update:(next:Record<string,string>)=>void}) {
 if(total<=size)return null;
 return <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:spacing.s8}}><Button label="Previous" disabled={page<=1} variant="secondary" onPress={()=>update({page:String(page-1)})}/><Text style={type.bodySm}>Page {page} of {Math.ceil(total/size)}</Text><Button label="Next" disabled={page*size>=total} variant="secondary" onPress={()=>update({page:String(page+1)})}/></View>;
}
