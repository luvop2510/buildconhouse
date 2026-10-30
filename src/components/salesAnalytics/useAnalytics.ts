import { useFocusEffect, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/src/state/auth';
import { subscribeApiCacheInvalidation } from '@/src/api/client';
import { analyticsNextFilters } from './currencyScope';
import { useSalesScope } from '@/src/components/salesData/SalesScope';
import { analyticsQuery, salesAnalyticsApi, type AnalyticsFilters } from '@/src/api/salesAnalytics';
import { analyticsCacheGeneration, analyticsIdentityKey, cacheAnalyticsRead, cachedAnalyticsRead, clearAnalyticsReadCache, revokeAnalyticsReads, subscribeAnalyticsRevocation } from './readCache';

// Only in-memory previews: logout, floor changes and writes release them immediately.
subscribeApiCacheInvalidation(clearAnalyticsReadCache);

const FILTER_KEYS = ['floor_id','preset','date_from','date_to','date_basis','company_id','product_id','architect_id','customer_id','status','search','sort','page','page_size','granularity','metric','dimension','category','size','finish','currency','source','series'];
export function useAnalyticsScope() {
 const params = useGlobalSearchParams<Record<string, string | string[]>>();
 const isFloorRoute = usePathname().includes('/sales-data/floor/');
 const router = useRouter();
 const access = useSalesScope();
 const filters: AnalyticsFilters = { preset: 'this_month', date_basis: 'confirmation', granularity: 'day', floor_id: 'all', page: '1', page_size: '25' };
 FILTER_KEYS.forEach(key => { const value = params[key]; if (typeof value === 'string' && value) filters[key] = value; });
 if(typeof params.floor_id!=='string'&&typeof params.floorId==='string')filters.floor_id=params.floorId;
 if(typeof params.date_from!=='string'&&typeof params.dateFrom==='string')filters.date_from=params.dateFrom;
 if(typeof params.date_to!=='string'&&typeof params.dateTo==='string')filters.date_to=params.dateTo;
 filters.preset=({all:'all_time',quarter:'this_quarter',year:'this_year'} as Record<string,string>)[filters.preset]||filters.preset;
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
export function useAnalyticsRead<T>(inputKey: string, load: (signal: AbortSignal) => Promise<T>, enabled = true, revision = 0) {
 const {staff}=useAuth();
 const key=`${analyticsIdentityKey(staff)}:${inputKey}`;
 const currentKey=useRef(key); currentKey.current=key;
 const currentEnabled=useRef(enabled); currentEnabled.current=enabled;
 const [state, setState] = useState<{ key: string; data: T | null; error: string | null; loading: boolean }>(()=>({ key, data: enabled ? cachedAnalyticsRead<T>(key) : null, error: null, loading: enabled }));
 const [refreshKey, setRefreshKey] = useState(0);
 useEffect(()=>subscribeAnalyticsRevocation(()=>setState({key:currentKey.current,data:null,error:'Sales data access changed. Try again to verify your permissions.',loading:false})),[]);
 useEffect(()=>subscribeApiCacheInvalidation(scope=>{
  if(scope!=='mutation')setState({key:currentKey.current,data:null,error:null,loading:currentEnabled.current});
  setRefreshKey(value=>value+1);
 }),[]);
 useEffect(() => {
  if (typeof window === 'undefined') return;
  const focus=()=>setRefreshKey(value=>value+1);
  window.addEventListener('focus',focus);
  return ()=>window.removeEventListener('focus',focus);
 }, []);
 useFocusEffect(useCallback(() => {
  if (!enabled) { setState({key,data:null,error:null,loading:false}); return; }
  const controller = new AbortController();
  const generation=analyticsCacheGeneration();
  const isCurrent=()=>currentEnabled.current&&!controller.signal.aborted&&currentKey.current===key&&generation===analyticsCacheGeneration();
  setState(previous => ({ key, data: previous.key === key ? previous.data : cachedAnalyticsRead<T>(key), error: null, loading: true }));
  void load(controller.signal).then(data => {
   if (!isCurrent()) return;
   cacheAnalyticsRead(key,data,generation);
   setState({ key, data, error: null, loading: false });
  }).catch(error => {
   if (!isCurrent()) return;
   const revoked=error?.status===401||error?.status===403;
   if(revoked)revokeAnalyticsReads();
   setState(previous => ({ ...previous, data:revoked?null:previous.data, error: error instanceof Error ? error.message : 'Could not load this analysis. Try again.', loading: false }));
  });
  return () => controller.abort();
 // The serialized request key describes every input to load.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [key, enabled, refreshKey, staff?.id, revision]));
 const data=enabled?(state.key===key?state.data:cachedAnalyticsRead<T>(key)):null;
 const loading=enabled&&(state.key!==key||state.loading);
 return { data, error: enabled&&state.key===key?state.error:null, loading, refreshing:loading&&data!==null, refresh: () => { setState(previous=>({...previous,loading:currentEnabled.current}));setRefreshKey(value => value + 1); } };
}

/** Legacy people/reference endpoints consume the unified dashboard's exact India boundaries. */
export function useResolvedAnalyticsPeriod(){
 const scope=useAnalyticsScope();const f=scope.filters;
 const filters:AnalyticsFilters={floor_id:f.floor_id,preset:f.preset,date_from:f.date_from||'',date_to:f.date_to||'',date_basis:'confirmation',granularity:f.granularity||'day',page:'1',page_size:'25'};
 const periodRead=useAnalyticsRead(`dashboard:${analyticsQuery(filters)}`,signal=>salesAnalyticsApi.dashboard(filters,signal),scope.canView);
 const bounds=periodRead.data?.period;
 const period=bounds?{preset:bounds.start&&bounds.end?'custom':'all',dateFrom:bounds.start,dateTo:bounds.end,label:bounds.label}:null;
 const query=period?analyticsQuery({floor_id:filters.floor_id,preset:period.preset,date_from:period.dateFrom||'',date_to:period.dateTo||''}):'';
 return {...scope,filters,period,periodRead,query};
}
