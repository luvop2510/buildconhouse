import { View, useWindowDimensions } from 'react-native';
import { useBp } from '@/src/design/responsive';
import { spacing } from '@/src/theme/tokens';
import type { AnalyticsDashboardData, AnalyticsFilters, AnalyticsFloor, AnalyticsTrend } from '@/src/api/salesAnalytics';
import { Choice, Panel } from '@/src/components/salesAnalytics/AnalyticsParts';
import { SalesTrend } from '@/src/components/salesAnalytics/AnalyticsCharts';
import { analyticsCurrency } from '@/src/components/salesAnalytics/currencyScope';
import { OrderActivity, SalesDistribution } from '@/src/components/salesAnalytics/SalesVisuals';

export type AnalyticsBentoProps = {
 data: AnalyticsDashboardData;
 filters: AnalyticsFilters;
 update: (filters: AnalyticsFilters) => void;
 onPoint: (point: AnalyticsTrend) => void;
 onActivity?: (point: AnalyticsTrend, currency: string) => void;
 onFloor: (floor: AnalyticsFloor) => void;
 onCompany: (id: string) => void;
};

/** Stitch's distribution, activity and comparison cards, filled with recorded data. */
export function AnalyticsBento({data,filters,update,onPoint,onActivity,onFloor,onCompany}:AnalyticsBentoProps) {
 const {isDesktop,isTabletLandscape}=useBp();
 const {fontScale}=useWindowDimensions();
 const paired=(isDesktop||isTabletLandscape)&&fontScale<=1.3;
 const currency=analyticsCurrency(filters.floor_id);
 return <View testID="analytics-bento" style={{gap:spacing.s16,flexDirection:paired?'row-reverse':'column',alignItems:'flex-start'}}>
   <View style={{flex:paired?1:undefined,minWidth:0,width:paired?undefined:'100%'}}><SalesDistribution data={data} filters={filters} onFloor={onFloor} onCompany={onCompany}/></View>
   <View style={{flex:paired?2:undefined,minWidth:0,gap:spacing.s16,width:paired?undefined:'100%'}}>
   <OrderActivity points={data.trend} filters={filters} onPoint={onActivity||onPoint}/>
   <Panel title={filters.date_basis==='payment'?'Collections over time':'Sales over time'} description={`${data.period.label} · selected vs previous period`} testID="analytics-bento-revenue" action={<Choice label="Time scale" value={filters.granularity} options={['day','month','quarter','year'].map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}))} onChange={granularity=>update({granularity})} testID="analytics-granularity"/>}><SalesTrend points={data.trend} currency={currency} floorId={filters.floor_id} onPoint={onPoint}/></Panel>
   </View>
 </View>;
}
export default AnalyticsBento;
