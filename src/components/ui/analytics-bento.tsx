import { View, useWindowDimensions } from 'react-native';
import { useBp } from '@/src/design/responsive';
import { spacing } from '@/src/theme/tokens';
import type { AnalyticsDashboardData, AnalyticsFilters, AnalyticsFloor, AnalyticsTrend } from '@/src/api/salesAnalytics';
import { OrderActivity, SalesDistribution } from '@/src/components/salesAnalytics/SalesVisuals';
export type AnalyticsBentoProps = {
 data:AnalyticsDashboardData;filters:AnalyticsFilters;update:(filters:AnalyticsFilters)=>void;
 onPoint:(point:AnalyticsTrend)=>void;onActivity?:(point:AnalyticsTrend,currency:string)=>void;
 onFloor:(floor:AnalyticsFloor)=>void;onCompany:(id:string)=>void;
};
/** Different chart forms answer contribution and timing without repeating totals. */
export function AnalyticsBento({data,filters,onPoint,onActivity,onFloor,onCompany}:AnalyticsBentoProps){
 const {isDesktop,isTabletLandscape}=useBp();const {fontScale}=useWindowDimensions();const paired=(isDesktop||isTabletLandscape)&&fontScale<=1.3;
 return <View testID="analytics-bento" style={{gap:spacing.s16,flexDirection:paired?'row':'column',alignItems:'stretch'}}>
  <View style={{flex:paired?1:undefined,minWidth:0}}><SalesDistribution data={data} filters={filters} onFloor={onFloor} onCompany={onCompany}/></View>
  <View style={{flex:paired?1.5:undefined,minWidth:0}}><OrderActivity points={data.trend} filters={filters} onPoint={onActivity||onPoint}/></View>
 </View>;
}
export default AnalyticsBento;
