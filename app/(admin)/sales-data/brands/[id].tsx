import { Redirect, useLocalSearchParams } from 'expo-router';

/** Legacy brand bookmarks share the same company identity, dates and source records. */
export default function ExecutiveBrandDetail() {
 const params=useLocalSearchParams<Record<string,string>>();
 return <Redirect href={{pathname:'/(admin)/sales-data/profile/[kind]/[id]',params:{...params,kind:'companies',floor_id:params.floor_id||params.floorId||'all',date_from:params.date_from||params.dateFrom||'',date_to:params.date_to||params.dateTo||''}} as never}/>;
}
