import { useFocusEffect, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/src/state/auth';
import { analyticsNextFilters } from './currencyScope';
import { useSalesScope } from '@/src/components/salesData/SalesScope';
import { analyticsQuery, type AnalyticsFilters } from '@/src/api/salesAnalytics';

const FILTER_KEYS = ['floor_id','preset','date_from','date_to','date_basis','company_id','product_id','architect_id','customer_id','status','search','sort','page','page_size','granularity','metric','dimension','category','size','finish','currency','source','series'];
export function useAnalyticsScope() {
 const params = useGlobalSearchParams<Record<string, string | string[]>>();
 const isFloorRoute = usePathname().includes('/sales-data/floor/');
 const router = useRouter();
 const access = useSalesScope();
 const filters: AnalyticsFilters = { preset: 'this_month', date_basis: 'confirmation', granularity: 'day', floor_id: 'all', page: '1', page_size: '25' };
 FILTER_KEYS.forEach(key => { const value = params[key]; if (typeof value === 'string' && value) filters[key] = value; });
 if (isFloorRoute && !params.floor_id && typeof params.id === 'string' && ['ground-floor','first-floor','second-floor','third-floor'].includes(params.id)) filters.floor_id=params.id;
 const update = (input: AnalyticsFilters) => {
  const next = analyticsNextFilters(filters, input);
  if (isFloorRoute && next.floor_id !== undefined) {
   router.replace(`/(admin)/sales-data?${analyticsQuery({...filters,...next,page:next.page||'1'})}` as never);
  } else router.setParams({ ...next, page: next.page || '1' });
 };
 const href = (path: string, next: AnalyticsFilters = {}) => `${path}?${analyticsQuery({ ...filters, ...analyticsNextFilters(filters, next) })}`;
 const go = (path: string, next: AnalyticsFilters = {}) => router.push(href(path, next) as never);
 return { filters, update, href, go, router, ...access };
}
export function useAnalyticsRead<T>(inputKey: string, load: (signal: AbortSignal) => Promise<T>, enabled = true) {
 const {staff}=useAuth();
 const key=`${staff?.id||'anonymous'}:${staff?.role||''}:${inputKey}`;
 const [state, setState] = useState<{ key: string; data: T | null; error: string | null; loading: boolean }>({ key, data: null, error: null, loading: true });
 const [refreshKey, setRefreshKey] = useState(0);
 useEffect(() => {
  if (typeof window === 'undefined') return;
  const focus=()=>setRefreshKey(value=>value+1);
  window.addEventListener('focus',focus);
  return ()=>window.removeEventListener('focus',focus);
 }, []);
 useFocusEffect(useCallback(() => {
  if (!enabled) { setState({key,data:null,error:null,loading:false}); return; }
  const controller = new AbortController();
  setState(previous => ({ key, data: previous.key === key ? previous.data : null, error: null, loading: true }));
  void load(controller.signal).then(data => { if (!controller.signal.aborted) setState({ key, data, error: null, loading: false }); }).catch(error => {
   if (!controller.signal.aborted) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'Could not load this analysis. Try again.', loading: false }));
  });
  return () => controller.abort();
 // The serialized request key describes every input to load.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [key, enabled, refreshKey, staff?.id]));
 return { data: enabled && state.key === key ? state.data : null, error: state.key === key ? state.error : null, loading: state.key !== key || state.loading, refresh: () => setRefreshKey(value => value + 1) };
}
