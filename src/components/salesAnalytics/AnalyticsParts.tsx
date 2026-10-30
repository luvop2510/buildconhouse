import { useState, type ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { useBp } from '@/src/design/responsive';
import { Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { useSalesTheme } from './salesTheme';
import { RankedBars } from './SalesGraphs';
import { Text } from '@/src/components/AppText';
import { Button, Skeleton, SkeletonCard } from '@/src/components/ui';
import { Sheet } from '@/src/design/components';
import { colors, spacing, type } from '@/src/theme/tokens';
import { downloadApiFile } from '@/src/utils/downloadFile';
import { analyticsQuery, type AnalyticsFilters } from '@/src/api/salesAnalytics';

/** React Native Web role=link needs an explicit Enter action without an href. */
export function linkActivation(onPress?:()=>void) { return Platform.OS==='web' && onPress ? { onKeyDown:(event:React.KeyboardEvent)=>{if(event.key==='Enter'){event.preventDefault();onPress();}} } : {}; }
export const analyticNumber = (value: number | null | undefined) => value == null ? 'Unavailable' : value.toLocaleString('en-IN', { maximumFractionDigits: 4 });
export const analyticMoney = (value: number | null | undefined, currency = 'INR') => value == null ? 'Unavailable' : `${currency === 'RNB' ? 'RNB ' : '₹'}${value.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
export const FLOOR_NAMES: Record<string, string> = { all: 'Overall sales', 'ground-floor': 'Tiles', 'first-floor': 'Sanitary / Bathroom', 'second-floor': 'Kitchen', 'third-floor': 'Furniture' };
export const BASIS_NAMES: Record<string, string> = { confirmation: 'Order confirmation', quotation: 'Quotation date', payment: 'Payment received', delivery: 'Delivery / completion' };
/** One shared blue accent for data, actions and navigation. */
export const chartColors = { primary: colors.brand, tint: colors.brandTint, secondary: colors.onSurfaceMuted, tertiary: colors.border };
export function Panel({ title, description, children, action, testID }: { title: string; description?: string; children: ReactNode; action?: ReactNode; testID?: string }) {
 const { isPhone } = useBp(); const theme=useSalesTheme();
 return <View testID={testID} style={{ flexGrow: 1, minWidth: 0, padding: isPhone ? 16 : 20, gap: spacing.s12, borderWidth: 1, borderColor: theme.line, borderRadius: 16, backgroundColor: theme.surface }}>
  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.s8 }}><View style={{flex:1,minWidth:120,gap:spacing.s4}}><Text accessibilityRole="header" aria-level={2} style={[type.titleSm,{fontSize:16,lineHeight:22,fontWeight:'600',color:theme.ink}]}>{title}</Text>{description ? <Text style={type.caption}>{description}</Text> : null}</View>{action}</View>{children}
 </View>;
}
export function Empty({ text = 'No confirmed orders match these filters. Try another date range or business unit.' }: { text?: string }) { return <Text testID="analytics-empty" style={[type.bodyMuted, { paddingVertical: spacing.s16 }]}>{text}</Text>; }
export function ReadState({ loading, error, retry, refreshing=false, variant='dashboard' }: { loading: boolean; error: string | null; retry: () => void; refreshing?:boolean; variant?:'dashboard'|'list'|'profile'|'order'|'quality' }) {
 const theme=useSalesTheme(); const {isPhone}=useBp();
 if (error) return <View accessibilityRole="alert" style={{ gap: spacing.s8 }}><Text style={type.body}>{error}</Text><Button label="Try again" testID="analytics-retry" onPress={retry} variant="secondary" /></View>;
 if (refreshing) return <Text testID="analytics-refreshing" role="status" accessibilityLiveRegion="polite" style={type.caption}>Updating recorded data…</Text>;
 if (!loading) return null;
 const rows=<View style={{gap:16}}>{Array.from({length:variant==='order'?3:5},(_,index)=><View key={index} style={{gap:8,paddingVertical:12,borderBottomWidth:1,borderBottomColor:theme.line}}><View style={{flexDirection:'row',justifyContent:'space-between',gap:16}}><Skeleton w="48%" h={16}/><Skeleton w="24%" h={20}/></View><Skeleton w="64%" h={12}/></View>)}</View>;
 return <View testID={`analytics-skeleton-${variant}`} aria-busy role="status" accessibilityLabel="Loading recorded data" style={{gap:16}}>
  {variant==='dashboard'||variant==='profile'?<><View style={{flexDirection:isPhone?'column':'row',gap:12}}><View style={{flex:isPhone?undefined:2}}><SkeletonCard height={320}/></View><View style={{flex:isPhone?undefined:1}}><SkeletonCard height={260}/></View></View><SkeletonCard height={260}/></>:null}
  {variant==='list'||variant==='order'||variant==='quality'?rows:null}
 </View>;
}
/** Secondary information stays available without competing with the main task. */
export function Disclosure({label,children,initiallyOpen=false,testID}:{label:string;children:ReactNode;initiallyOpen?:boolean;testID?:string}) {
 const [open,setOpen]=useState(initiallyOpen); const theme=useSalesTheme();
 return <View style={{gap:open?12:0,minWidth:0}}><Pressable testID={testID} accessibilityRole="button" accessibilityState={{expanded:open}} aria-expanded={open} onPress={()=>setOpen(value=>!value)} style={({pressed,hovered}:any)=>({minHeight:44,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12,paddingVertical:8,backgroundColor:pressed||hovered?theme.tint:'transparent'})}><Text style={[type.bodySm,{fontWeight:'500',color:theme.accent,flex:1}]}>{label}</Text><Feather aria-hidden name={open?'chevron-up':'chevron-down'} size={18} color={theme.accent}/></Pressable>{open?children:null}</View>;
}
export function Choice({ label, value, options, onChange, testID }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; testID?: string }) {
 const [open, setOpen] = useState(false);
 return <View style={{ gap: spacing.s4, minWidth: 0, flexShrink: 1, maxWidth: '100%' }}><Text style={type.caption}>{label}</Text>
  <Button testID={testID} label={options.find(option => option.value === value)?.label || value || 'Choose'} iconRight="chevron-down" variant="secondary" style={{borderRadius:20,borderColor:colors.border}} onPress={() => setOpen(true)} />
  <Sheet open={open} onClose={() => setOpen(false)} title={label}><View style={{ gap: spacing.s4 }}>{options.map(option => <Pressable key={option.value} accessibilityRole="button" accessibilityState={{ selected: value === option.value }} testID={`${testID}-${option.value}`} onPress={() => { onChange(option.value); setOpen(false); }} style={({ pressed }) => ({ minHeight: 48, padding: spacing.s12, justifyContent: 'center', backgroundColor: pressed || value === option.value ? colors.surfaceTertiary : colors.surfaceSecondary })}><Text style={type.body}>{option.label}</Text></Pressable>)}</View></Sheet>
 </View>;
}
export function DataLink({ label, detail, value, secondary, onPress, testID, proportion, vertical=false, markerColor }: { label: string; detail?: string; value?: string; secondary?: string; onPress?: () => void; testID?: string; proportion?: number; vertical?:boolean; markerColor?:string }) {
 const {isPhone,width}=useBp();
 const {fontScale}=useWindowDimensions();
 const theme=useSalesTheme(); const [rowWidth,setRowWidth]=useState(300);
 const measureRow=(event:any)=>setRowWidth(event.nativeEvent.layout.width);
 const stacked=vertical||fontScale>1.3||isPhone&&width<360||(value?.length||0)*8>rowWidth*.44;
 const rowText=isPhone?type.bodySm:type.bodyStrong;
 const content=<><View style={{flexDirection:'row',alignItems:'center',gap:spacing.s8,minWidth:0}}>
  <View style={{flex:1,minWidth:0,gap:spacing.s4}}><View style={{flexDirection:'row',alignItems:'center',gap:8}}>{markerColor?<View aria-hidden style={{width:8,height:8,borderRadius:2,backgroundColor:markerColor}}/>:null}<Text style={[rowText,{flexShrink:1,fontWeight:'500',color: theme.ink}]}>{label}</Text></View>{detail ? <Text style={isPhone?type.caption:type.bodySm}>{detail}</Text>:null}
   {stacked && value ? <><Text style={[type.bodyStrong,{fontVariant:['tabular-nums'],flexShrink:1}]}>{value}</Text>{secondary?<Text style={type.caption}>{secondary}</Text>:null}</>:null}
  </View>
  {!stacked && value ? <View style={{maxWidth:'44%',alignItems:'flex-end',gap:spacing.s4}}><Text style={[rowText,{fontVariant:['tabular-nums'],fontWeight:'500',textAlign:'right',flexShrink:1}]}>{value}</Text>{secondary?<Text style={type.caption}>{secondary}</Text>:null}</View>:null}
  {onPress?<Feather name="chevron-right" size={16} color={theme.muted} aria-hidden accessibilityElementsHidden/>:null}
 </View>{proportion!==undefined?<View aria-hidden accessibilityElementsHidden style={{height:6,backgroundColor:colors.surfaceTertiary,marginTop:spacing.s8,borderRadius:3,overflow:'hidden'}}><View style={{height:6,width:`${Math.max(0,Math.min(1,proportion))*100}%`,backgroundColor:chartColors.primary}}/></View>:null}</>;
 const style={minWidth:0,minHeight:44,paddingVertical:spacing.s8,borderBottomWidth:1,borderBottomColor:theme.line};
 return onPress ? <Pressable accessibilityRole="link" {...linkActivation(onPress)} accessibilityLabel={`${label}${value?`: ${value}`:''}. Open details`} testID={testID} onLayout={measureRow} onPress={onPress} style={({hovered,pressed}:any)=>[style,{backgroundColor:hovered||pressed?colors.surfaceTertiary:'transparent'}]}>{content}</Pressable>:<View testID={testID} onLayout={measureRow} style={style}>{content}</View>;
}
export function ExportMenu({ filters, view, kind, entityId, tab, title, compact = false }: { filters: AnalyticsFilters; view: string; kind?: string; entityId?: string; tab?: string; title?: string; compact?: boolean }) {
 const [open, setOpen] = useState(false);
 const [scope, setScope] = useState('full');
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const download = async (format: 'pdf' | 'xlsx') => {
  setBusy(true); setError(null);
  try {
   const query = analyticsQuery({ ...filters, format, view, ...(kind ? { kind } : {}), ...(entityId ? { entity_id: entityId } : {}), scope, ...(tab ? { tab } : {}), ...(title ? {report_title:title} : {}) });
   const filename = `buildcon-${kind || view}-${entityId || filters.floor_id || 'overall'}.${format}`.replace(/[^a-z0-9._-]/gi, '-');
   const saved = await downloadApiFile(`/sales-analytics/export?${query}`, filename, 'sales analytics report', filters.floor_id && filters.floor_id !== 'all' ? filters.floor_id : '', setError);
   if (saved) setOpen(false);
  } catch (reason) { setError(reason instanceof Error && reason.name !== 'AbortError' ? reason.message : 'Export timed out. Reduce the range and try again.'); }
  finally { setBusy(false); }
 };
 return <><Button size="sm" label={compact?'PDF':'Export'} testID="analytics-export" icon="download" variant="ghost" onPress={() => setOpen(true)} />
 <Sheet open={open} onClose={() => { if (!busy) setOpen(false); }} title="Export analysis"><View style={{ gap: spacing.s16 }}><Text style={type.bodyMuted}>A compact visual A4 report with sales charts, labelled comparisons and complete selected source data.</Text>
 {view === 'profile' ? <Choice label="Export scope" value={scope} options={[{value:'full',label:'Full selected profile'},{value:'current',label:'Current analysis tab'},{value:'records',label:'Filtered source records'}]} onChange={setScope} testID="analytics-export-scope" /> : null}
 <Button label={busy ? 'Preparing export…' : 'Download PDF'} testID="analytics-export-pdf" disabled={busy} onPress={() => void download('pdf')} />
 <Button label="Download Excel" testID="analytics-export-xlsx" disabled={busy} variant="secondary" onPress={() => void download('xlsx')} />
 {error ? <Text accessibilityRole="alert" style={{...type.bodySm,color:colors.error}}>{error}</Text> : null}<Button label="Close" disabled={busy} variant="ghost" onPress={() => setOpen(false)} />
 </View></Sheet></>;
}

export function EntityLedger({rows,onRow,testPrefix='analytics-entity',valueLabel='Sales'}:{rows:{id:string;name:string;detail:string;value:string;amount?:number|null;currency?:string;orders?:string;customers?:string;customer?:string;department?:string;status?:string}[];onRow:(id:string)=>void;testPrefix?:string;valueLabel?:string}) {
 const currencies=[...new Set(rows.map(row=>row.currency||'INR'))];
 return <View style={{gap:20}}>{currencies.map(currency=><View key={currency} style={{gap:12}}><Text style={type.caption}>{valueLabel} in {currency}{currencies.length>1?' (separate scale)':''}</Text><RankedBars label={`${valueLabel} by record in ${currency}`} rows={rows.filter(row=>(row.currency||'INR')===currency).map(row=>({id:row.id,label:row.customer||row.name,value:row.amount,formatted:row.value,detail:[row.customer?row.name:'',row.customer?row.detail:'',row.department,row.status].filter(Boolean).join(', '),testID:`${testPrefix}-${row.id}`,onPress:()=>onRow(row.id)}))}/></View>)}
 <Disclosure label="Source data and record details">{rows.map(row=><DataLink key={row.id} label={row.name} detail={row.detail} value={row.value} onPress={()=>onRow(row.id)}/>)}</Disclosure>
 </View>;
}
