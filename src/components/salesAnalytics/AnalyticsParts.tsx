import { useState, type ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { useBp } from '@/src/design/responsive';
import { Platform, Pressable, View, useWindowDimensions } from 'react-native';
import { radius } from '@/src/design/tokens';
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
export const chartColors = { primary: colors.brand, tint: colors.brandTint, secondary: colors.onSurfaceMuted, tertiary: '#A3A3AA' };
export function Panel({ title, description, children, action, testID }: { title: string; description?: string; children: ReactNode; action?: ReactNode; testID?: string }) {
 const { isPhone, isDesktop } = useBp();
 return <View testID={testID} style={{ flexGrow: 1, minWidth: 0, padding: isPhone ? spacing.s12 : isDesktop ? spacing.s20 : spacing.s16, gap: spacing.s12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surfaceSecondary }}>
  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.s8 }}><View style={{flex:1,minWidth:120,gap:spacing.s4}}><Text accessibilityRole="header" aria-level={2} style={isPhone?type.titleSm:type.titleMd}>{title}</Text>{description ? <Text style={type.bodySm}>{description}</Text> : null}</View>{action}</View>{children}
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
  <Button testID={testID} label={options.find(option => option.value === value)?.label || value || 'Choose'} iconRight="chevron-down" variant="secondary" onPress={() => setOpen(true)} />
  <Sheet open={open} onClose={() => setOpen(false)} title={label}><View style={{ gap: spacing.s4 }}>{options.map(option => <Pressable key={option.value} accessibilityRole="button" accessibilityState={{ selected: value === option.value }} testID={`${testID}-${option.value}`} onPress={() => { onChange(option.value); setOpen(false); }} style={({ pressed }) => ({ minHeight: 48, padding: spacing.s12, justifyContent: 'center', backgroundColor: pressed || value === option.value ? colors.surfaceTertiary : colors.surfaceSecondary })}><Text style={type.body}>{option.label}</Text></Pressable>)}</View></Sheet>
 </View>;
}
export function DataLink({ label, detail, value, secondary, onPress, testID, proportion }: { label: string; detail?: string; value?: string; secondary?: string; onPress?: () => void; testID?: string; proportion?: number }) {
 const {isPhone,width}=useBp();
 const {fontScale}=useWindowDimensions();
 const stacked=isPhone&&(width<360||fontScale>1.3);
 const rowText=isPhone?type.bodySm:type.bodyStrong;
 const content=<><View style={{flexDirection:'row',alignItems:'center',gap:spacing.s8,minWidth:0}}>
  <View style={{flex:1,minWidth:0,gap:spacing.s4}}><Text style={[rowText,{fontWeight:'500'}, onPress ? {color: colors.brand} : null]}>{label}</Text>{detail ? <Text style={isPhone?type.caption:type.bodySm}>{detail}</Text>:null}
   {stacked && value ? <Text style={[type.bodyStrong,{fontVariant:['tabular-nums']}]}>{value}{secondary ? ` · ${secondary}` : ''}</Text>:null}
  </View>
  {!stacked && value ? <View style={{maxWidth:'44%',alignItems:'flex-end',gap:spacing.s4}}><Text style={[rowText,{fontVariant:['tabular-nums'],fontWeight:'500',textAlign:'right'}]}>{value}</Text>{secondary?<Text style={type.caption}>{secondary}</Text>:null}</View>:null}
  {onPress?<Feather name="chevron-right" size={16} color={colors.brand} aria-hidden accessibilityElementsHidden/>:null}
 </View>{proportion!==undefined?<View aria-hidden accessibilityElementsHidden style={{height:6,backgroundColor:colors.surfaceTertiary,marginTop:spacing.s8,borderRadius:3,overflow:'hidden'}}><View style={{height:6,width:`${Math.max(0,Math.min(1,proportion))*100}%`,backgroundColor:chartColors.primary}}/></View>:null}</>;
 const style={minWidth:0,minHeight:44,paddingVertical:spacing.s8,borderBottomWidth:1,borderBottomColor:colors.border};
 return onPress ? <Pressable accessibilityRole="link" {...linkActivation(onPress)} accessibilityLabel={`${label}${value?`: ${value}`:''}. Open details`} testID={testID} onPress={onPress} style={({hovered,pressed}:any)=>[style,{backgroundColor:hovered||pressed?colors.surfaceTertiary:'transparent'}]}>{content}</Pressable>:<View testID={testID} style={style}>{content}</View>;
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
 <Sheet open={open} onClose={() => { if (!busy) setOpen(false); }} title="Export analysis"><View style={{ gap: spacing.s16 }}><Text style={type.bodyMuted}>An A4 visual report with charts, comparisons and source tables. Includes your selected period, filters and permitted records.</Text>
 {view === 'profile' ? <Choice label="Export scope" value={scope} options={[{value:'full',label:'Full selected profile'},{value:'current',label:'Current analysis tab'},{value:'records',label:'Filtered source records'}]} onChange={setScope} testID="analytics-export-scope" /> : null}
 <Button label={busy ? 'Preparing export…' : 'Download PDF'} testID="analytics-export-pdf" disabled={busy} onPress={() => void download('pdf')} />
 <Button label="Download Excel" testID="analytics-export-xlsx" disabled={busy} variant="secondary" onPress={() => void download('xlsx')} />
 {error ? <Text accessibilityRole="alert" style={{...type.bodySm,color:colors.error}}>{error}</Text> : null}<Button label="Close" disabled={busy} variant="ghost" onPress={() => setOpen(false)} />
 </View></Sheet></>;
}
