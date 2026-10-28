import { useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button } from '@/src/components/ui';
import { colors, spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsFilters as FilterValues } from '@/src/api/salesAnalytics';
import { Pagination } from './AnalyticsEntities';
import { setSelectedFloorId } from '@/src/hooks/use-floor-access';
import { useState } from 'react';
import { AnalyticsFilters } from './AnalyticsFilters';
import { AnalyticsKpis, EntityRanking } from './AnalyticsDashboard';
import { FloorContribution, SalesTrend } from './AnalyticsCharts';
import { analyticMoney, DataLink, Empty, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';

export const TABLE_NAMES:Record<string,string>={orders:'Order history',quotations:'Quotation history',payments:'Payments',products:'Products',customers:'Customers',architects:'Architect attribution',projects:'Projects',activity:'Activity history',related_products:'Related products',delivery:'Delivery status'};
const PROFILE_TABLES:Record<string,string[]>={companies:['products','customers','architects','quotations','orders'],products:['orders','customers','architects','related_products'],architects:['customers','projects','orders','quotations','activity'],customers:['orders','quotations','payments','products','architects','projects','delivery','activity']};
const FIELD_LABELS:Record<string,string>={id:'Record ID',name:'Name',product_name:'Product',product_id:'Product ID',brand_name:'Brand',company_name:'Company',category:'Category',sku:'SKU',quantity:'Quantity',unit:'Unit',unit_price:'Unit price',discount:'Discount',discount_pct:'Discount (%)',tax:'Tax',taxes:'Taxes',line_total:'Line total',total:'Total',sales:'Confirmed sales',sales_rnb:'RNB sales',amount:'Amount',date:'Date',status:'Status',customer_name:'Customer',customer_id:'Customer ID',architect_name:'Architect',architect_id:'Architect ID',floor_id:'Business unit',number:'Order number',description:'Description',event:'Event',at:'Recorded at'};
function fieldValue(key:string,value:unknown,currency='INR'):string {
 if(value==null||value==='')return 'Unavailable';
 if(typeof value==='number'&&/_pct$|percent/i.test(key))return `${value.toLocaleString('en-IN',{maximumFractionDigits:2})}%`;
 if(typeof value==='number')return /sales|price|total|amount|discount|tax|collected|outstanding|subtotal/.test(key)?analyticMoney(value,key==='sales_rnb'?'RNB':currency):value.toLocaleString('en-IN',{maximumFractionDigits:4});
 if(Array.isArray(value))return value.map(item=>typeof item==='object'&&item?Object.values(item).join(' · '):String(item)).join('; ')||'Unavailable';
 if(typeof value==='object')return Object.entries(value as Record<string,unknown>).map(([name,item])=>`${name.replace(/_/g,' ')}: ${fieldValue(name,item,currency)}`).join(' · ');
 return key==='floor_id'?FLOOR_NAMES[String(value)]||String(value):String(value);
}
export function RecordTable({name,rows,total,go}:{name:string;rows:Record<string,unknown>[];total?:number;go:(path:string,filters?:FilterValues)=>void}) {
 const [sourceError,setSourceError]=useState('');
 const openSource=(row:Record<string,unknown>,path:string)=>{const floor=String(row.floor_id||'');if(!floor){setSourceError('This historical record has no business-unit link. Open it from its source workspace.');return;}void setSelectedFloorId(floor).then(()=>go(path,{floor_id:floor,...(path==='/(admin)/tiles/quotation'?{id:String(row.id)}:{})})).catch(()=>setSourceError('Could not open the source workspace. Try again.'));};
 return <Panel title={TABLE_NAMES[name]||name.replace(/_/g,' ')}>{rows.length?rows.map((row,index)=>{
  const id=String(row.id||row.order_id||row.product_id||row.customer_id||row.architect_id||index);
  const primary=String(row.name||row.product_name||row.number||row.customer_name||row.description||row.event||id);
  const stableId=row.id||row.order_id||row.product_id||row.customer_id||row.architect_id;
  const route=!stableId?undefined:name==='orders'?`/(admin)/sales-data/order/${encodeURIComponent(id)}`:name==='projects'?undefined:['products','related_products','customers','architects'].includes(name)?`/(admin)/sales-data/profile/${name==='related_products'?'products':name}/${encodeURIComponent(id)}`:undefined;
  return <View key={`${id}-${index}`} style={{gap:spacing.s8,paddingBottom:spacing.s12,borderBottomWidth:1,borderBottomColor:colors.border}}><DataLink label={primary} onPress={route?()=>go(route,row.source?{source:String(row.source)}:{}):undefined} testID={`analytics-row-${id}`}/><View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s12}}>{Object.entries(row).filter(([key])=>!['name','product_name','number','description','event','href','url','document_url','download_url'].includes(key)).map(([key,value])=><View key={key} style={{flexGrow:1,flexBasis:180,minWidth:0,gap:spacing.s4}}><Text style={type.caption}>{FIELD_LABELS[key]||key.replace(/_/g,' ')}</Text><Text style={type.bodySm}>{fieldValue(key,value,String(row.currency||'INR'))}</Text></View>)}</View>
  {name==='projects'?<Button label="Open project" variant="secondary" onPress={()=>openSource(row,`/(admin)/kitchen/${encodeURIComponent(String(row.project_id||id))}`)}/>:null}
  {name==='quotations'?<Button label="Open quotation source" variant="secondary" onPress={()=>openSource(row,row.source==='kitchen'?`/(admin)/kitchen/${encodeURIComponent(String(row.project_id||row.order_id||id))}`:row.floor_id==='ground-floor'?'/(admin)/tiles/quotation':`/(admin)/quotations/${encodeURIComponent(id)}`)}/>:null}
  {row.customer_id&&name!=='customers'?<Button label={`Customer: ${row.customer_name||row.customer_id}`} variant="ghost" onPress={()=>go(`/(admin)/sales-data/profile/customers/${encodeURIComponent(String(row.customer_id))}`)}/>:null}
  {row.architect_id&&name!=='architects'?<Button label={`Architect: ${row.architect_name||row.architect_id}`} variant="ghost" onPress={()=>go(`/(admin)/sales-data/profile/architects/${encodeURIComponent(String(row.architect_id))}`)}/>:null}
  {row.product_id&&name!=='products'?<Button label={`Product: ${row.product_name||row.product_id}`} variant="ghost" onPress={()=>go(`/(admin)/sales-data/profile/products/${encodeURIComponent(String(row.product_id))}`)}/>:null}
  </View>;
 }):<Empty text={`No permitted ${TABLE_NAMES[name]?.toLowerCase()||name.replace(/_/g,' ')} are available for this profile and filter state. Historical records may not contain these links.`}/>}{sourceError?<Text accessibilityRole="alert" style={type.bodySm}>{sourceError}</Text>:null}{total&&total>rows.length?<Text style={type.caption}>Showing {rows.length} of {total} related records. Export the filtered records for the complete result.</Text>:null}</Panel>;
}
export function AnalyticsProfilePage() {
 const params=useLocalSearchParams<{kind:string;id:string;tab?:string}>(); const {filters,update,go,router,floors,canView}=useAnalyticsScope(); const kind=params.kind; const id=params.id;
 const entityKey=`${kind==='companies'?'company':kind==='architects'?'architect':kind==='products'?'product':'customer'}_id`;
 const scopedGo=(path:string,next:FilterValues={})=>go(path,{[entityKey]:id,...next});
 const read=useAnalyticsRead(`${kind}:${id}:${analyticsQuery(filters)}`,signal=>salesAnalyticsApi.profile(kind,id,filters,signal),canView&&!!id);
 const tab=params.tab||'overview';
 const attributes=read.data?.identity.attributes||[];
 const requiredAttributes=kind==='products'?['Quantity sold','Quantity unit','Average selling price','Stock']:kind==='customers'?['Lifetime confirmed sales (INR)','Lifetime confirmed sales (RNB)','Last order date','Products purchased','Current outstanding balance (INR)','Current outstanding balance (RNB)']:[];
 const presentLabels=new Set(attributes.map(attribute=>attribute.label.toLowerCase()));
 const displayAttributes=[...attributes,...requiredAttributes.filter(label=>!presentLabels.has(label.toLowerCase())).map(label=>({label,value:null}))]; const tabs=['overview',...(PROFILE_TABLES[kind]||['orders'])];
 return <AdminPage title={read.data?.identity.name||'Entity profile'} header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}>
 <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:spacing.s8}}><Button label="Back" icon="arrow-left" variant="ghost" onPress={()=>router.canGoBack()?router.back():go(`/(admin)/sales-data/${kind}`)}/><Button label="Sales analytics" variant="ghost" onPress={()=>go('/(admin)/sales-data')}/><Text style={type.caption}>/ {kind} / {read.data?.identity.name||id}</Text></View>
 <ReadState loading={read.loading&&!read.data} error={read.error} retry={read.refresh}/>
 {read.data?<><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:spacing.s12}}><View style={{flex:1,minWidth:160,gap:spacing.s4}}><Text accessibilityRole="header" aria-level={1} style={type.displayMd}>{read.data.identity.name}</Text><Text style={type.bodySm}>{read.data.identity.id} · {read.data.identity.status||'Status unavailable'}</Text><Text style={type.bodySm}>{read.data.identity.floor_ids.map(floor=>FLOOR_NAMES[floor]||floor).join(' · ')||'Business unit unavailable'}</Text></View><ExportMenu filters={filters} view="profile" kind={kind} entityId={id} tab={tab}/></View>
 <AnalyticsFilters filters={filters} update={update} floors={floors}/>
 <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" accessibilityLabel="Profile sections"><View style={{flexDirection:'row',borderBottomWidth:1,borderBottomColor:colors.border}}>{tabs.map(name=><Pressable key={name} accessibilityRole="tab" accessibilityState={{selected:tab===name}} testID={`analytics-profile-tab-${name}`} onPress={()=>router.setParams({tab:name,page:'1'})} style={({pressed})=>({minHeight:48,paddingHorizontal:spacing.s16,justifyContent:'center',borderBottomWidth:2,borderBottomColor:tab===name?colors.onSurface:'transparent',backgroundColor:pressed?colors.surfaceTertiary:'transparent'})}><Text style={tab===name?type.bodyStrong:type.bodyMuted}>{name==='overview'?'Overview':TABLE_NAMES[name]||name}</Text></Pressable>)}</View></ScrollView>
 {tab==='overview'?<><AnalyticsKpis data={read.data} go={metric=>go('/(admin)/sales-data/records',{[`${kind==='companies'?'company':kind==='architects'?'architect':kind==='products'?'product':'customer'}_id`]:id,metric})}/>
 <Panel title="Profile details"><View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s16}}>{displayAttributes.map((attribute,index)=><View key={`${attribute.label}-${index}`} style={{flexGrow:1,flexBasis:180,gap:spacing.s4}}><Text style={type.caption}>{attribute.label}</Text><Text style={type.body}>{attribute.value==null?'Unavailable':typeof attribute.value==='number'&&/sales|price|balance/i.test(attribute.label)?analyticMoney(attribute.value,/RNB/.test(attribute.label)?'RNB':'INR'):String(attribute.value)}</Text></View>)}</View></Panel>
 <Panel title={kind==='customers'?'Purchase trend':'Attributed sales trend'}><SalesTrend points={read.data.trend} currency={filters.floor_id==='third-floor'?'RNB':'INR'} onPoint={point=>go('/(admin)/sales-data/records',{[`${kind==='companies'?'company':kind==='architects'?'architect':kind==='products'?'product':'customer'}_id`]:id,preset:'custom',date_from:point.start,date_to:point.end})}/></Panel>
 {kind==='products'?<Panel title="Quantity sold over time">{read.data.trend.some(point=>point.quantity!=null)&&new Set(read.data.trend.map(point=>point.unit).filter(Boolean)).size===1?<SalesTrend points={read.data.trend.filter(point=>point.quantity!=null).map(point=>({...point,sales:point.quantity!,previous_sales:null}))} unit={read.data.trend.find(point=>point.unit)?.unit||'units'} onPoint={point=>scopedGo('/(admin)/sales-data/records',{preset:'custom',date_from:point.start,date_to:point.end})}/>:<Empty text="Quantity history with a consistent recorded unit is unavailable. Incompatible units are not combined."/>}</Panel>:null}
 <Panel title="Business unit contribution"><FloorContribution floors={read.data.floors} onFloor={floor=>update({floor_id:floor.floor_id})}/></Panel>
 {kind!=='products'?<EntityRanking title="Product / category preferences" kind="products" rows={read.data.products} go={scopedGo}/>:null}
 {kind!=='companies'?<EntityRanking title="Company / brand contribution" kind="companies" rows={read.data.companies} go={scopedGo}/>:null}
 {read.data.attribute_breakdowns?Object.entries(read.data.attribute_breakdowns).filter(([,rows])=>rows.length>0).map(([dimension,rows])=><Panel key={dimension} title={`${dimension[0].toUpperCase()+dimension.slice(1)} contribution`}>{rows.slice(0,10).map(row=><DataLink key={row.id} label={row.name} value={analyticMoney(row.sales)} onPress={()=>scopedGo('/(admin)/sales-data/records',{[dimension]:row.id,dimension})}/>)}</Panel>):null}
 {read.data.coverage.notes.map(note=><Text key={note} style={type.bodySm}>{note}</Text>)}
 </>:<><RecordTable name={tab} rows={read.data.tables[tab]?.items||[]} total={read.data.tables[tab]?.total} go={scopedGo}/><Pagination total={read.data.tables[tab]?.total||0} page={read.data.tables[tab]?.page||Number(filters.page)||1} size={read.data.tables[tab]?.page_size||Number(filters.page_size)||25} update={update}/></>}</>:null}
 </AdminPage>;
}
