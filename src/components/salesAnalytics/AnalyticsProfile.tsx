import { formatPhone } from "@/src/utils/phone";
import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { AdminPage } from '@/src/components/AdminPage';
import { Button } from '@/src/components/ui';
import { colors, spacing, type } from '@/src/theme/tokens';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsFilters as FilterValues } from '@/src/api/salesAnalytics';
import { Pagination } from './AnalyticsEntities';
import { setSelectedFloorId } from '@/src/hooks/use-floor-access';
import { useState } from 'react';
import { AnalyticsFilters } from './AnalyticsFilters';
import { EntityRanking } from './AnalyticsDashboard';
import { FloorContribution, SalesTrend } from './AnalyticsCharts';
import { analyticMoney, Choice, Disclosure, DataLink, Empty, ExportMenu, FLOOR_NAMES, Panel, ReadState } from './AnalyticsParts';
import { analyticsCurrency, visibleAnalyticsFields } from './currencyScope';
import { SalesHero, VisualKpis } from './SalesVisuals';
import { RankedBars } from './SalesGraphs';
import { useAnalyticsRead, useAnalyticsScope } from './useAnalytics';

export const TABLE_NAMES:Record<string,string>={orders:'Order history',quotations:'Quotation history',payments:'Payments',products:'Products',customers:'Customers',architects:'Architect attribution',projects:'Projects',activity:'Activity history',related_products:'Related products',delivery:'Delivery status'};
const PROFILE_TABLES:Record<string,string[]>={companies:['products','customers','architects','quotations','orders'],products:['orders','customers','architects','related_products'],architects:['customers','projects','orders','quotations','activity'],customers:['orders','quotations','payments','products','architects','projects','delivery','activity']};
const FIELD_LABELS:Record<string,string>={id:'Record ID',name:'Name',product_name:'Product',product_id:'Product ID',brand_name:'Brand',company_name:'Company',category:'Category',sku:'SKU',quantity:'Quantity',unit:'Unit',unit_price:'Unit price',discount:'Discount',discount_pct:'Discount (%)',tax:'Tax',taxes:'Taxes',line_total:'Line total',total:'Total',sales:'Confirmed sales',sales_rnb:'RNB sales',amount:'Amount',date:'Date',status:'Status',customer_name:'Customer',customer_id:'Customer ID',architect_name:'Architect',architect_id:'Architect ID',floor_id:'Business unit',number:'Order number',description:'Description',event:'Event',at:'Recorded at'};
function fieldValue(key:string,value:unknown,currency='INR'):string {
 if(value==null||value==='')return 'Unavailable';
 if(/(?:^|_)(?:phone|mobile)(?:$|_)/i.test(key)&&typeof value==='string')return formatPhone(value);
 if(typeof value==='number'&&/_pct$|percent/i.test(key))return `${value.toLocaleString('en-IN',{maximumFractionDigits:2})}%`;
 if(typeof value==='number')return /sales|price|total|amount|discount|tax|collected|outstanding|subtotal/.test(key)?analyticMoney(value,key.endsWith('_rnb')?'RNB':currency):value.toLocaleString('en-IN',{maximumFractionDigits:4});
 if(Array.isArray(value))return value.map(item=>typeof item==='object'&&item?Object.values(item).join(', '):String(item)).join('; ')||'Unavailable';
 if(typeof value==='object')return Object.entries(value as Record<string,unknown>).map(([name,item])=>`${name.replace(/_/g,' ')}: ${fieldValue(name,item,currency)}`).join(', ');
 if(typeof value==='string'&&(/(?:^|_)(?:date|at)$/.test(key))){const date=new Date(value);if(!Number.isNaN(date.getTime()))return date.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'});}
 return key==='floor_id'?FLOOR_NAMES[String(value)]||String(value):String(value);
}
const SUMMARY_FIELDS=['date','at','status','sales','sales_rnb','total','amount','line_total','quantity','unit'];
export function RecordTable({name,rows,total,go,floorId}:{name:string;rows:Record<string,unknown>[];total?:number;floorId?:string;go:(path:string,filters?:FilterValues)=>void}) {
 const [sourceError,setSourceError]=useState('');
 const openSource=(row:Record<string,unknown>,path:string)=>{const floor=String(row.floor_id||'');if(!floor){setSourceError('This historical record has no business-unit link. Open it from its source workspace.');return;}void setSelectedFloorId(floor).then(()=>go(path,{floor_id:floor,...(path==='/(admin)/tiles/quotation'?{id:String(row.id)}:{})})).catch(()=>setSourceError('Could not open the source workspace. Try again.'));};
 const grouped=[...new Set(rows.map(row=>String(row.currency||analyticsCurrency(String(row.floor_id||floorId)))))];
 const graphRows=(currency:string)=>rows.filter(row=>String(row.currency||analyticsCurrency(String(row.floor_id||floorId)))===currency).map((row,index)=>{
  const field=['sales_rnb','sales','total','amount','line_total'].find(key=>key==='sales_rnb'?currency==='RNB'&&row[key]!=null:row[key]!=null);
  const value=field&&typeof row[field]==='number'?row[field] as number:null;
  return {id:String(row.id||index),label:String(row.name||row.product_name||row.number||row.customer_name||row.description||row.event||`Record ${index+1}`),value,formatted:value==null?'Amount unavailable':analyticMoney(value,currency)};
 });
 const numerical=rows.some(row=>['sales','sales_rnb','total','amount','line_total'].some(key=>typeof row[key]==='number'));
 return <Panel title={TABLE_NAMES[name]||name.replace(/_/g,' ')}>{rows.length?<>
 {numerical?grouped.map(currency=><RankedBars key={currency} label={`${TABLE_NAMES[name]||name} in ${currency}`} rows={graphRows(currency)}/>):<View testID="analytics-record-relationships" style={{gap:0}}>{rows.map((row,index)=><View key={String(row.id||index)} style={{flexDirection:'row',gap:12,minHeight:56}}><View aria-hidden style={{width:3,backgroundColor:colors.brand}}/><View style={{flex:1,minWidth:0,gap:4,paddingVertical:8}}><Text style={type.bodyStrong}>{String(row.name||row.number||row.product_name||row.customer_name||row.event||`Record ${index+1}`)}</Text><Text style={type.caption}>{String(row.status||TABLE_NAMES[name]||name)}</Text></View></View>)}</View>}
 <Disclosure label="Supporting records" testID="analytics-supporting-records">{rows.map((row,index)=>{
  const id=String(row.id||row.order_id||row.product_id||row.customer_id||row.architect_id||index);
  const primary=String(row.name||row.product_name||row.number||row.customer_name||row.description||row.event||id);
  const stableId=row.id||row.order_id||row.product_id||row.customer_id||row.architect_id;
  const fields=visibleAnalyticsFields(row,floorId).filter(([key])=>!['name','product_name','number','description','event','href','url','document_url','download_url'].includes(key));
  const summary=SUMMARY_FIELDS.flatMap(name=>fields.filter(([key])=>key===name)).slice(0,4);
  const details=fields.filter(([key])=>!summary.some(([name])=>key===name));
  const route=!stableId?undefined:name==='orders'?`/(admin)/sales-data/order/${encodeURIComponent(id)}`:name==='projects'?undefined:['products','related_products','customers','architects'].includes(name)?`/(admin)/sales-data/profile/${name==='related_products'?'products':name}/${encodeURIComponent(id)}`:undefined;
  return <View key={`${id}-${index}`} style={{gap:spacing.s8,paddingBottom:spacing.s12,borderBottomWidth:1,borderBottomColor:colors.border}}><DataLink label={primary} onPress={route?()=>go(route,row.source?{source:String(row.source)}:{}):undefined} testID={`analytics-row-${id}`}/><View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s12}}>{summary.map(([key,value])=><View key={key} style={{flexGrow:1,flexBasis:128,minWidth:0,gap:spacing.s4}}><Text style={type.caption}>{FIELD_LABELS[key]||key.replace(/_/g,' ')}</Text><Text style={type.bodySm}>{fieldValue(key,value,String(row.currency||analyticsCurrency(String(row.floor_id||floorId))))}</Text></View>)}</View>
  {name==='projects'?<Button label="Open project" variant="secondary" onPress={()=>openSource(row,`/(admin)/kitchen/${encodeURIComponent(String(row.project_id||id))}`)}/>:null}
  {name==='quotations'?<Button label="Open quotation source" variant="secondary" onPress={()=>openSource(row,row.source==='kitchen'?`/(admin)/kitchen/${encodeURIComponent(String(row.project_id||row.order_id||id))}`:row.floor_id==='ground-floor'?'/(admin)/tiles/quotation':`/(admin)/quotations/${encodeURIComponent(id)}`)}/>:null}
  {details.length||row.customer_id||row.architect_id||row.product_id?<Disclosure label="Record details" testID={`analytics-row-details-${id}`}><View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s12}}>{details.map(([key,value])=><View key={key} style={{flexGrow:1,flexBasis:128,minWidth:0,gap:spacing.s4}}><Text style={type.caption}>{FIELD_LABELS[key]||key.replace(/_/g,' ')}</Text><Text style={type.bodySm}>{fieldValue(key,value,String(row.currency||analyticsCurrency(String(row.floor_id||floorId))))}</Text></View>)}</View>
  {row.customer_id&&name!=='customers'?<Button label={`Customer: ${row.customer_name||row.customer_id}`} variant="ghost" onPress={()=>go(`/(admin)/sales-data/profile/customers/${encodeURIComponent(String(row.customer_id))}`)}/>:null}
  {row.architect_id&&name!=='architects'?<Button label={`Architect: ${row.architect_name||row.architect_id}`} variant="ghost" onPress={()=>go(`/(admin)/sales-data/profile/architects/${encodeURIComponent(String(row.architect_id))}`)}/>:null}
  {row.product_id&&name!=='products'?<Button label={`Product: ${row.product_name||row.product_id}`} variant="ghost" onPress={()=>go(`/(admin)/sales-data/profile/products/${encodeURIComponent(String(row.product_id))}`)}/>:null}</Disclosure>:null}
  </View>;
 })}</Disclosure></>:<Empty text={`No permitted ${TABLE_NAMES[name]?.toLowerCase()||name.replace(/_/g,' ')} are available for this profile and filter state. Historical records may not contain these links.`}/>}{sourceError?<Text accessibilityRole="alert" style={type.bodySm}>{sourceError}</Text>:null}{total!=null&&total>rows.length?<Text style={type.caption}>Showing {rows.length} of {total} related records. Export the filtered records for the complete result.</Text>:null}</Panel>;
}
export function AnalyticsProfilePage() {
 const params=useLocalSearchParams<{kind:string;id:string;tab?:string}>(); const {filters,update,go,router,floors,canView}=useAnalyticsScope(); const kind=params.kind; const id=params.id;
 const entityKey=`${kind==='companies'?'company':kind==='architects'?'architect':kind==='products'?'product':'customer'}_id`;
 const scopedGo=(path:string,next:FilterValues={})=>go(path,{[entityKey]:id,...next});
 const read=useAnalyticsRead(`profile:${kind}:${id}:${analyticsQuery(filters)}`,signal=>salesAnalyticsApi.profile(kind,id,filters,signal),canView&&!!id);
 const requestedTab=params.tab||'overview';
 const currency=analyticsCurrency(filters.floor_id);
 const attributes=(read.data?.identity.attributes||[]).filter(attribute=>currency==='RNB'?!/\(INR\)/.test(attribute.label):!/\(RNB\)/.test(attribute.label));
 const requiredAttributes=kind==='products'?['Quantity sold','Quantity unit','Average selling price','Stock']:kind==='customers'?[`Lifetime confirmed sales (${currency})`,'Last order date','Products purchased',`Current outstanding balance (${currency})`]:[];
 const presentLabels=new Set(attributes.map(attribute=>attribute.label.toLowerCase()));
 const displayAttributes=[...attributes,...requiredAttributes.filter(label=>!presentLabels.has(label.toLowerCase())).map(label=>({label,value:null}))]; const tabs=['overview',...(PROFILE_TABLES[kind]||['orders'])];
 const tab=tabs.includes(requestedTab)?requestedTab:'overview';
 return <AdminPage title={read.data?.identity.name||'Entity profile'} header={false} contentStyle={{gap:spacing.s16,paddingTop:spacing.s16}}>
 <View style={{width:'100%',maxWidth:1280,alignSelf:'center',gap:spacing.s16}}>
 <View style={{alignItems:'flex-start'}}><Button label="Back to analysis" icon="arrow-left" variant="secondary" onPress={()=>router.canGoBack()?router.back():go(`/(admin)/sales-data/${kind}`)}/></View>
 <ReadState variant="profile" loading={canView&&read.loading&&!read.data} refreshing={read.loading&&!!read.data} error={read.error} retry={read.refresh}/>
 {!canView?<Empty text="Your account does not have permission to view Sales Data."/>:null}
 {read.data?<><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:spacing.s12}}><View style={{flex:1,minWidth:160,gap:spacing.s4}}><Text accessibilityRole="header" aria-level={1} style={type.displayMd}>{read.data.identity.name}</Text>{read.data.identity.status?<Text style={type.bodySm}>{read.data.identity.status}</Text>:null}<Text style={type.bodySm}>{read.data.identity.floor_ids.map(floor=>FLOOR_NAMES[floor]||floor).join(', ')||'Business unit unavailable'}</Text></View><ExportMenu filters={filters} view="profile" kind={kind} entityId={id} tab={tab}/></View>
 <AnalyticsFilters filters={filters} update={update} floors={floors}/>
 <View style={{maxWidth:360}}><Choice label="View" value={tab} options={tabs.map(name=>({value:name,label:name==='overview'?'Overview':TABLE_NAMES[name]||name}))} onChange={name=>router.setParams({tab:name,page:'1'})} testID="analytics-profile-view"/></View>
 {tab==='overview'?<><SalesHero data={read.data} currency={currency} onRecords={()=>scopedGo('/(admin)/sales-data/records',{metric:'sales',currency})}/>

 <Panel title={kind==='customers'?'Purchase trend':'Attributed sales trend'}><SalesTrend initialMode="area" points={read.data.trend} currency={currency} floorId={filters.floor_id} onPoint={point=>go('/(admin)/sales-data/records',{[`${kind==='companies'?'company':kind==='architects'?'architect':kind==='products'?'product':'customer'}_id`]:id,preset:'custom',date_from:point.start,date_to:point.end})}/></Panel>
 <VisualKpis data={read.data} filters={filters} go={(metric,code)=>scopedGo('/(admin)/sales-data/records',{metric,...(code?{currency:code}:{})})}/>
 <Disclosure label="Identity and saved details"><Text style={type.caption}>Record ID: {read.data.identity.id}</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s16}}>{displayAttributes.map((attribute,index)=><View key={`${attribute.label}-${index}`} style={{flexGrow:1,flexBasis:180,minWidth:0,gap:spacing.s4}}><Text style={type.caption}>{attribute.label}</Text><Text style={type.body}>{attribute.value==null?'Unavailable':typeof attribute.value==='number'&&/sales|price|balance/i.test(attribute.label)?analyticMoney(attribute.value,/RNB/.test(attribute.label)?'RNB':/INR/.test(attribute.label)?'INR':currency):/phone|mobile/i.test(attribute.label)?formatPhone(String(attribute.value)):String(attribute.value)}</Text></View>)}</View></Disclosure>
 <Disclosure label="More analysis" testID="analytics-profile-more-analysis">
 {kind==='products'?<Panel title="Quantity sold over time">{read.data.trend.some(point=>point.quantity!=null)&&new Set(read.data.trend.map(point=>point.unit).filter(Boolean)).size===1?<SalesTrend floorId={filters.floor_id} points={read.data.trend.filter(point=>point.quantity!=null).map(point=>({...point,sales:point.quantity!,previous_sales:null}))} unit={read.data.trend.find(point=>point.unit)?.unit||'units'} onPoint={point=>scopedGo('/(admin)/sales-data/records',{preset:'custom',date_from:point.start,date_to:point.end})}/>:<Empty text="Quantity history with a consistent recorded unit is unavailable. Incompatible units are not combined."/>}</Panel>:null}
 {read.data.floors.length>1?<Panel title="Sales by business unit"><FloorContribution floors={read.data.floors} onFloor={floor=>update({floor_id:floor.floor_id})}/></Panel>:null}
 {kind!=='products'?<EntityRanking title="Product / category preferences" kind="products" rows={read.data.products} go={scopedGo} floorId={filters.floor_id}/>:null}
 {kind!=='companies'?<EntityRanking title="Company / brand contribution" kind="companies" rows={read.data.companies} go={scopedGo} floorId={filters.floor_id}/>:null}
 {read.data.attribute_breakdowns?Object.entries(read.data.attribute_breakdowns).filter(([,rows])=>rows.length>0).map(([dimension,rows])=><Panel key={dimension} title={`${dimension[0].toUpperCase()+dimension.slice(1)} contribution`}>{rows.slice(0,10).map(row=><DataLink key={row.id} label={row.name} value={analyticMoney(row.sales,currency)} onPress={()=>scopedGo('/(admin)/sales-data/records',{[dimension]:row.id,dimension})}/>)}</Panel>):null}
 {read.data.coverage.notes.map(note=><Text key={note} style={type.bodySm}>{note}</Text>)}
 </Disclosure>
 </>:<><RecordTable name={tab} rows={read.data.tables[tab]?.items||[]} total={read.data.tables[tab]?.total} go={scopedGo} floorId={filters.floor_id}/><Pagination total={read.data.tables[tab]?.total||0} page={read.data.tables[tab]?.page||Number(filters.page)||1} size={read.data.tables[tab]?.page_size||Number(filters.page_size)||25} update={update}/></>}</>:null}
 </View></AdminPage>;
}
