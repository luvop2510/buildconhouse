import { usePathname } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/src/components/AppText';
import { colors, spacing, type } from '@/src/theme/tokens';
import { linkActivation } from './AnalyticsParts';
import { useAnalyticsScope } from './useAnalytics';
const DESTINATIONS=[{key:'dashboard',label:'Overview',path:''},{key:'companies',label:'Companies',path:'/companies'},{key:'products',label:'Products',path:'/products'},{key:'architects',label:'Architects',path:'/architects'},{key:'customers',label:'Customers',path:'/customers'},{key:'reports',label:'Reports',path:'/reports'},{key:'data-quality',label:'Data quality',path:'/data-quality'},{key:'references',label:'Reference directory',path:'/relationships'}];
export function AnalyticsNavigation() {
 const pathname=usePathname(); const {go}=useAnalyticsScope();
 const active=DESTINATIONS.find(item=>item.path&&pathname.includes(item.path))?.key||'dashboard';
 return <View style={{backgroundColor:colors.surfaceSecondary,borderBottomWidth:1,borderBottomColor:colors.border}}><ScrollView horizontal showsHorizontalScrollIndicator={false} role="navigation" accessibilityLabel="Sales analytics sections"><View style={{flexDirection:'row',paddingHorizontal:spacing.s16}}>{DESTINATIONS.map(destination=><Pressable key={destination.key} accessibilityRole="link" {...linkActivation(()=>go(`/(admin)/sales-data${destination.path}`,{page:'1'}))} accessibilityState={{selected:active===destination.key}} testID={`analytics-nav-${destination.key}`} onPress={()=>go(`/(admin)/sales-data${destination.path}`,{page:'1'})} style={({pressed,hovered}:any)=>({minHeight:48,justifyContent:'center',paddingHorizontal:spacing.s16,borderBottomWidth:2,borderBottomColor:active===destination.key?colors.onSurface:'transparent',backgroundColor:pressed||hovered?colors.surfaceTertiary:'transparent'})}><Text style={active===destination.key?type.bodyStrong:type.bodyMuted}>{destination.label}</Text></Pressable>)}</View></ScrollView></View>;
}
