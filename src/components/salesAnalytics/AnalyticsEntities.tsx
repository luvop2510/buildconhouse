import { useEffect, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button, TextField } from '@/src/components/ui';
import { spacing, type } from '@/src/theme/tokens';
import { useBp } from '@/src/design/responsive';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsKind } from '@/src/api/salesAnalytics';
import { AnalyticsFilters } from './AnalyticsFilters';
import { analyticMoney, analyticNumber, Choice, EntityLedger, Empty, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';

const TITLES:Record<AnalyticsKind,string>={companies:'Companies',products:'Products',architects:'Architects',customers:'Customers'};
export function AnalyticsEntities({kind}:{kind:AnalyticsKind}) {
 const {isDesktop,isTabletLandscape}=useBp(); const {fontScale}=useWindowDimensions();
 const paired=(isDesktop||isTabletLandscape)&&fontScale<=1.3;
 const {filters,update,go,floors,canView}=useAnalyticsScope();
 const [search,setSearch]=useState(filters.search||'');
 useEffect(()=>setSearch(filters.search||''),[filters.search,kind]);
 useEffect(()=>{if(search===(filters.search||''))return;const timer=setTimeout(()=>update({search,page:'1'}),250);return()=>clearTimeout(timer);
 // URL filters remain the applied scope; the local input responds immediately.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[search,filters.search]);
 const read=useAnalyticsRead(`entities:${kind}:${analyticsQuery(filters)}`,signal=>salesAnalyticsApi.entities(kind,filters,signal),canView);
 return <AdminPage title={TITLES[kind]} header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}>
 <View style={{width:'100%',maxWidth:1280,alignSelf:'center',gap:spacing.s16}}>
 <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:spacing.s12}}><Text accessibilityRole="header" aria-level={1} style={type.displayMd}>{TITLES[kind]}</Text><ExportMenu filters={filters} view={kind}/></View>
 <TextField label={`Search ${TITLES[kind].toLowerCase()}`} placeholder="Search by name" value={search} onChangeText={setSearch} testID="analytics-directory-search"/>
 <View style={{flexDirection:paired?'row':'column',alignItems:paired?'flex-end':'stretch',justifyContent:'space-between',gap:spacing.s12}}><View style={{flex:paired?1:undefined,minWidth:0}}><AnalyticsFilters filters={filters} update={update} floors={floors}/></View>
 <View style={{maxWidth:paired?320:undefined,minWidth:0}}><Choice label="Rank by" value={filters.sort||'sales_desc'} options={[{value:'sales_desc',label:'Confirmed sales — highest first'},{value:'sales_asc',label:'Confirmed sales — lowest first'},{value:'orders_desc',label:'Order count'},{value:'aov_desc',label:'Average order value'},{value:'name_asc',label:'Name A–Z'}]} onChange={sort=>update({sort})} testID="analytics-sort"/></View></View>
 {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:<><ReadState variant="list" loading={read.loading&&!read.data} refreshing={read.loading&&!!read.data} error={read.error} retry={read.refresh}/>{read.data?<Panel title={`${analyticNumber(read.data.total)} ${read.data.total===1?({companies:'company',products:'product',architects:'architect',customers:'customer'}[kind]):TITLES[kind].toLowerCase()}`} description={kind==='companies'?'Existing catalog brands; sales follow the selected period.':undefined}>
 {read.data.items.length?<EntityLedger valueLabel={filters.date_basis==='payment'?'Collected':'Sales'} rows={read.data.items.flatMap(row=>{
  const furnitureOnly=filters.floor_id==='third-floor'||row.floor_ids?.length===1&&row.floor_ids[0]==='third-floor';
  const currency=furnitureOnly?'RNB':'INR';const amount=furnitureOnly?row.sales_rnb:row.sales;
  const base={id:row.id,name:row.name,detail:[row.floor_ids?.map(id=>FLOOR_NAMES[id]||id).join(', '),row.detail,`${analyticNumber(row.orders)} orders`,row.customers==null?'':`${analyticNumber(row.customers)} customers`].filter(Boolean).join(', '),amount,currency,value:analyticMoney(amount,currency)};
  return filters.floor_id==='all'&&!furnitureOnly&&row.sales_rnb!=null&&row.sales_rnb!==0?[base,{...base,id:`${row.id}::RNB`,amount:row.sales_rnb,currency:'RNB',value:analyticMoney(row.sales_rnb,'RNB')}]:[base];
 })} onRow={key=>{const id=key.replace(/::RNB$/,'');const row=read.data!.items.find(item=>item.id===id)!;go(`/(admin)/sales-data/profile/${kind}/${encodeURIComponent(id)}`,key.endsWith('::RNB')||row.floor_ids?.length===1&&row.floor_ids[0]==='third-floor'?{floor_id:'third-floor'}:{});}}/>:<Empty text={`No ${kind} match this scope. Try another date range or search.`}/>}
 <Pagination total={read.data.total} page={read.data.page} size={read.data.page_size} update={update}/>
 </Panel>:null}</>}
 </View></AdminPage>;
}
export function Pagination({total,page,size,update}:{total:number;page:number;size:number;update:(next:Record<string,string>)=>void}) {
 if(total<=size)return null;
 return <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:spacing.s8}}><Button label="Previous" disabled={page<=1} variant="secondary" onPress={()=>update({page:String(page-1)})}/><Text style={type.bodySm}>Page {page} of {Math.ceil(total/size)}</Text><Button label="Next" disabled={page*size>=total} variant="secondary" onPress={()=>update({page:String(page+1)})}/></View>;
}
