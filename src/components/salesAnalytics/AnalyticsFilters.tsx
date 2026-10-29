import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { Button, TextField } from '@/src/components/ui';
import { Sheet } from '@/src/design/components';
import { KitchenDateField } from '@/src/components/kitchen/KitchenFilters';
import { useBp } from '@/src/design/responsive';
import { colors, spacing, type } from '@/src/theme/tokens';
import { analyticsDateDisplay, validAnalyticsRange } from './dateBounds';
import { BASIS_NAMES, Choice, FLOOR_NAMES } from './AnalyticsParts';
import type { AnalyticsFilters as FilterValues } from '@/src/api/salesAnalytics';

export function AnalyticsFilters({ filters, update, floors }: { filters: FilterValues; update: (values: FilterValues) => void; floors: {id:string;name:string}[] }) {
 const { isPhone } = useBp(); const [open, setOpen] = useState(false);
 const [draft, setDraft] = useState(filters); const [error, setError] = useState('');
 const appliedKey=JSON.stringify(filters);
 useEffect(()=>{setDraft(JSON.parse(appliedKey));},[appliedKey]);
 const active = ['company_id','product_id','architect_id','customer_id','category','size','finish','series','status','search'].filter(key => filters[key]);
 const apply = () => {
  if (draft.preset === 'custom' && !validAnalyticsRange(draft.date_from,draft.date_to)) { setError('Choose valid start and end dates, with the end on or after the start.'); return; }
  setError(''); update(draft); setOpen(false);
 };
 const form = <View testID="analytics-filters" style={{ gap: spacing.s16 }}>
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s12 }}>
   <Choice label="Business unit" testID="analytics-floor-picker" value={draft.floor_id} options={[{value:'all',label:'All accessible business units'},...floors.map(floor=>({value:floor.id,label:FLOOR_NAMES[floor.id] || floor.name}))]} onChange={floor_id=>setDraft({...draft,floor_id,currency:''})} />
   <Choice label="Date basis" testID="analytics-date-basis" value={draft.date_basis} options={Object.entries(BASIS_NAMES).map(([value,label])=>({value,label}))} onChange={date_basis=>setDraft({...draft,date_basis})} />
   <Choice label="Date range · India" testID="analytics-period" value={draft.preset} options={[{value:'this_month',label:'This month'},{value:'last_month',label:'Last month'},{value:'this_quarter',label:'This quarter'},{value:'this_year',label:'This year'},{value:'all_time',label:'All time'},{value:'custom',label:'Custom range'}]} onChange={preset=>setDraft({...draft,preset,date_from:'',date_to:''})} />
  </View>
  {draft.preset === 'custom' ? <View style={{ flexDirection: 'row', flexWrap:'wrap',gap:spacing.s12 }}><View style={{flex:1,minWidth:120}}><KitchenDateField defaultToToday={false} label="From date" value={analyticsDateDisplay(draft.date_from)} onChange={date_from=>setDraft({...draft,date_from})} testID="analytics-date-from" /></View><View style={{flex:1,minWidth:120}}><KitchenDateField defaultToToday={false} label="To date" value={analyticsDateDisplay(draft.date_to,true)} min={analyticsDateDisplay(draft.date_from)} onChange={date_to=>setDraft({...draft,date_to})} testID="analytics-date-to" /></View></View> : null}
  <View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s12}}><TextField label="Search source records" value={draft.search || ''} onChangeText={search=>setDraft({...draft,search})} placeholder="Customer, order or product" containerStyle={{flexGrow:1,flexBasis:180}} testID="analytics-search" /><Choice label="Order status" testID="analytics-status" value={draft.status || ''} options={[{value:'',label:'All statuses'},{value:'confirmed',label:'Confirmed'},{value:'completed',label:'Completed'},{value:'delivered',label:'Delivered'}]} onChange={status=>setDraft({...draft,status})} /></View>
  {error ? <Text accessibilityRole="alert" style={{...type.bodySm,color:colors.error}}>{error}</Text> : null}
  <View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s8}}><Button label="Apply filters" onPress={apply} testID="analytics-filter-apply" /><Button label="Reset filters" variant="ghost" onPress={()=>setDraft({floor_id:filters.floor_id,preset:'this_month',date_basis:'confirmation',granularity:'day',currency:'',search:'',status:'',company_id:'',product_id:'',customer_id:'',architect_id:'',category:'',size:'',finish:'',series:'',date_from:'',date_to:''})} /></View>
 </View>;
 return <View style={{gap:spacing.s8}}><View style={{flexDirection:'row',alignItems:'center',gap:spacing.s12,flexWrap:'wrap'}}><Button label={active.length ? `Filters · ${active.length} active` : 'Filters'} icon="sliders" variant="secondary" testID="analytics-filter-open" onPress={()=>setOpen(true)} /><Text style={[type.caption,{flex:1,minWidth:80}]}>{FLOOR_NAMES[filters.floor_id] || 'All units'} · {filters.preset === 'custom' ? `${analyticsDateDisplay(filters.date_from)} – ${analyticsDateDisplay(filters.date_to,true)}` : filters.preset.replace(/_/g,' ')}</Text></View>
 {active.length ? <View style={{flexDirection:'row',flexWrap:'wrap',gap:spacing.s8}}>{active.map(key=><Button key={key} label={`${key.replace(/_id$/,'').replace(/_/g,' ')}: ${filters[key]} ×`} variant="ghost" onPress={()=>update({[key]:''})} />)}</View> : null}
 <Sheet open={open} onClose={()=>setOpen(false)} title="Filter sales analytics" {...(isPhone ? {} : {})}>{form}<Button label="Cancel" variant="ghost" onPress={()=>{setDraft(filters);setError('');setOpen(false);}} /></Sheet></View>;
}

export { isAnalyticsCalendarDate as validAnalyticsDate } from './dateBounds';
