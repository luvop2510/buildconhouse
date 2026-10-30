import { useState, type ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { useBp } from '@/src/design/responsive';
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSalesTheme } from './salesTheme';
import { Text } from '@/src/components/AppText';
import { Button, SkeletonCard } from '@/src/components/ui';
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
export function ReadState({ loading, error, retry }: { loading: boolean; error: string | null; retry: () => void }) {
 if (error) return <View accessibilityRole="alert" style={{ gap: spacing.s8 }}><Text style={type.body}>{error}</Text><Button label="Try again" testID="analytics-retry" onPress={retry} variant="secondary" /></View>;
 return loading ? <View aria-busy accessibilityLabel="Loading analytics" style={{ gap: spacing.s16 }}><SkeletonCard height={104} /><SkeletonCard height={224} /></View> : null;
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
   {stacked && value ? <><ScrollView horizontal showsHorizontalScrollIndicator style={{flexGrow:0,maxWidth:'100%'}}><Text style={[type.bodyStrong,{fontVariant:['tabular-nums'],...(Platform.OS==='web'?{whiteSpace:'nowrap'} as never:{})}]}>{value}</Text></ScrollView>{secondary?<Text style={type.caption}>{secondary}</Text>:null}</>:null}
  </View>
  {!stacked && value ? <View style={{maxWidth:'44%',alignItems:'flex-end',gap:spacing.s4}}><ScrollView horizontal showsHorizontalScrollIndicator style={{flexGrow:0,maxWidth:'100%'}}><Text style={[rowText,{fontVariant:['tabular-nums'],fontWeight:'500',textAlign:'right',...(Platform.OS==='web'?{whiteSpace:'nowrap'} as never:{})}]}>{value}</Text></ScrollView>{secondary?<Text style={type.caption}>{secondary}</Text>:null}</View>:null}
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

export function EntityLedger({rows,onRow,testPrefix='analytics-entity',valueLabel='Sales'}:{rows:{id:string;name:string;detail:string;value:string;orders?:string;customers?:string;customer?:string;department?:string;status?:string}[];onRow:(id:string)=>void;testPrefix?:string;valueLabel?:string}) {
 const {isPhone,isTabletPortrait}=useBp(); const {fontScale}=useWindowDimensions(); const theme=useSalesTheme();
 const compact=isPhone||isTabletPortrait||fontScale>1.3;
 const transactions=rows.some(row=>row.customer!==undefined);
 const hasMetrics=rows.some(row=>row.orders!==undefined||row.customers!==undefined);
 if(transactions&&compact) return <View style={{gap:8}}>{rows.map(row=><Pressable key={row.id} testID={`${testPrefix}-${row.id}`} accessibilityRole="link" {...linkActivation(()=>onRow(row.id))} accessibilityLabel={`${row.name}. ${row.customer}. ${row.department}. ${row.status}. ${valueLabel}: ${row.value}. Open details`} onPress={()=>onRow(row.id)} style={({pressed,hovered}:any)=>({minHeight:80,padding:12,borderWidth:1,borderColor:theme.line,borderRadius:12,backgroundColor:pressed||hovered?theme.tint:theme.surface,gap:8})}>
  <View style={{flexDirection:fontScale>1.3?'column':'row',alignItems:'flex-start',gap:8}}><View aria-hidden style={{width:32,height:32,borderRadius:10,backgroundColor:theme.tint,alignItems:'center',justifyContent:'center'}}><Text style={[type.caption,{fontWeight:'600',color:theme.accent}]}>{row.customer?.split(/\s+/).slice(0,2).map(part=>part[0]).join('')}</Text></View><View style={{flex:fontScale>1.3?undefined:1,minWidth:0,gap:4}}><Text style={[type.bodyStrong,{fontSize:14}]}>{row.customer}</Text><Text style={type.caption}>{row.name} · {row.department}</Text><Text style={[type.caption,{alignSelf:'flex-start',color:theme.accent,backgroundColor:theme.tint,borderRadius:6,padding:4}]}>{row.status}</Text></View></View>
  <View style={{flexDirection:fontScale>1.3?'column':'row',flexWrap:'wrap',alignItems:fontScale>1.3?'stretch':'center',gap:8}}><ScrollView horizontal showsHorizontalScrollIndicator style={{flexGrow:fontScale>1.3?0:1,flexBasis:fontScale>1.3?undefined:140,minWidth:0,maxWidth:'100%'}}><Text style={[type.bodyStrong,{fontSize:16,color:theme.ink,fontVariant:['tabular-nums'],...(Platform.OS==='web'?{whiteSpace:'nowrap'} as never:{})}]}>{row.value}</Text></ScrollView><Text style={type.caption}>{row.detail}</Text><Feather name="arrow-up-right" size={14} color={theme.muted} aria-hidden/></View>
 </Pressable>)}</View>;
 return <View style={{gap:0}}>
  {!compact?<View aria-hidden style={{flexDirection:'row',gap:12,paddingVertical:10,paddingHorizontal:8,backgroundColor:theme.canvas}}><Text style={[type.caption,{flex:transactions?1:3}]}>{transactions?'Order':'Name'}</Text>
   {transactions?<><Text style={[type.caption,{flex:2}]}>Customer</Text><Text style={[type.caption,{flex:1.5}]}>Department</Text><Text style={[type.caption,{flex:1}]}>Status</Text></>:hasMetrics?<><Text style={[type.caption,{flex:1,textAlign:'right'}]}>Orders</Text><Text style={[type.caption,{flex:1,textAlign:'right'}]}>Customers</Text></>:null}
   <Text style={[type.caption,{flex:2,textAlign:'right'}]}>{valueLabel}</Text>
  </View>:null}
  {rows.map(row=><Pressable key={row.id} testID={`${testPrefix}-${row.id}`} accessibilityRole="link" {...linkActivation(()=>onRow(row.id))} accessibilityLabel={`${row.name}: ${row.value}. Open details`} onPress={()=>onRow(row.id)} style={({pressed,hovered}:any)=>({minHeight:64,paddingVertical:12,paddingHorizontal:8,borderBottomWidth:1,borderBottomColor:theme.line,backgroundColor:pressed||hovered?theme.tint:theme.surface,flexDirection:compact?'column':'row',alignItems:compact?'stretch':'center',gap:compact?6:12})}>
   <View style={{flex:compact?undefined:transactions?1:3,minWidth:0,gap:4}}><Text style={[type.bodyStrong,{fontSize:14,color:theme.ink}]}>{row.name}</Text><Text style={type.caption}>{row.detail}</Text></View>
   {transactions?compact?<Text style={type.bodySm}>{row.customer} · {row.department} · {row.status}</Text>:<><Text style={[type.bodySm,{flex:2}]}>{row.customer}</Text><Text style={[type.bodySm,{flex:1.5}]}>{row.department}</Text><Text style={[type.bodySm,{flex:1}]}>{row.status}</Text></>:!compact&&hasMetrics?<><Text style={[type.bodySm,{flex:1,textAlign:'right',fontVariant:['tabular-nums']}]}>{row.orders||'—'}</Text><Text style={[type.bodySm,{flex:1,textAlign:'right',fontVariant:['tabular-nums']}]}>{row.customers||'—'}</Text></>:null}
   <View style={{flex:compact?undefined:2,minWidth:transactions&&!compact?145:0,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8}}><ScrollView horizontal showsHorizontalScrollIndicator style={{flex:1,minWidth:0}} contentContainerStyle={{flexGrow:1,justifyContent:compact?'flex-start':'flex-end'}}><Text style={[type.bodyStrong,{fontSize:14,textAlign:compact?'left':'right',fontVariant:['tabular-nums'],color:theme.ink,...(Platform.OS==='web'?{whiteSpace:'nowrap'} as never:{})}]}>{row.value}</Text></ScrollView><Feather name="arrow-up-right" size={14} color={theme.muted}/></View>
  </Pressable>)}
 </View>;
}
