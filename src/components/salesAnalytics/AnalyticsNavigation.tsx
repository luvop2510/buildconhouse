import { useState } from 'react';
import { usePathname } from 'expo-router';
import { View } from 'react-native';
import { Button } from '@/src/components/ui';
import { Sheet } from '@/src/design/components';
import { colors, spacing } from '@/src/theme/tokens';
import { useBp } from '@/src/design/responsive';
import { useAnalyticsScope } from './useAnalytics';
const DESTINATIONS=[{key:'dashboard',label:'Overview',path:''},{key:'companies',label:'Companies',path:'/companies'},{key:'products',label:'Products',path:'/products'},{key:'architects',label:'Architects',path:'/architects'},{key:'customers',label:'Customers',path:'/customers'},{key:'reports',label:'Reports',path:'/reports'},{key:'data-quality',label:'Data quality',path:'/data-quality'},{key:'references',label:'Reference directory',path:'/relationships'}];
/** A single compact switcher replaces the nested hierarchy and long phone tab strip. */
export function AnalyticsNavigation() {
 const pathname=usePathname();const {go}=useAnalyticsScope();const {gutter}=useBp();const [open,setOpen]=useState(false);
 const active=DESTINATIONS.find(item=>item.path&&pathname.includes(item.path))||DESTINATIONS[0];
 return <View style={{backgroundColor:colors.surfaceSecondary,borderBottomWidth:1,borderBottomColor:colors.border,paddingHorizontal:gutter,paddingVertical:spacing.s8,flexDirection:'row',alignItems:'center',gap:spacing.s8}}>
  <Button testID="analytics-nav-dashboard" label="Overview" icon="grid" variant={active.key==='dashboard'?'secondary':'ghost'} onPress={()=>go('/(admin)/sales-data',{page:'1',currency:''})}/>
  <Button label={active.key==='dashboard'?'Explore data':active.label} testID="analytics-navigation-open" iconRight="chevron-down" variant="ghost" onPress={()=>setOpen(true)}/>
  <Sheet title="Explore company data" open={open} onClose={()=>setOpen(false)}><View style={{gap:spacing.s8}}>{DESTINATIONS.filter(item=>item.key!=='dashboard').map(item=><Button key={item.key} testID={`analytics-nav-${item.key}`} label={item.label} variant={active.key===item.key?'secondary':'ghost'} onPress={()=>{setOpen(false);go(`/(admin)/sales-data${item.path}`,{page:'1',currency:''});}}/>)}</View></Sheet>
 </View>;
}
