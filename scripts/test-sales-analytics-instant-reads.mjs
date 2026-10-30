import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as cache from '../src/components/salesAnalytics/readCache.ts';

const transpile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const owner = { id: 'owner', role: 'owner', active: true, floor_ids: ['first-floor'] };
function fixture({ clear = true } = {}) {
 if (clear) cache.clearAnalyticsReadCache();
 const hooks = [], effects = [], requests = [], subscribers = new Set();
 let cursor = 0, identity = owner, input = 'dashboard:first-floor', enabled = true, revision = 0;
 const same = (a,b) => a && b && a.length === b.length && a.every((value,index)=>Object.is(value,b[index]));
 const react = {
  useState(initial) { const index=cursor++;hooks[index] ||= {value:typeof initial==='function'?initial():initial};return [hooks[index].value,value=>{hooks[index].value=typeof value==='function'?value(hooks[index].value):value;}]; },
  useRef(initial) { return hooks[cursor++] ||= {current:initial}; },
  useCallback(callback,deps) { const index=cursor++;if(!same(hooks[index]?.deps,deps))hooks[index]={value:callback,deps};return hooks[index].value; },
  useEffect(callback,deps) { const index=cursor++;if(!same(hooks[index]?.deps,deps)){const cleanup=hooks[index]?.cleanup;hooks[index]={deps};effects.push(()=>{cleanup?.();hooks[index].cleanup=callback();});} },
 };
 const modules = {
  react,
  'expo-router': {useFocusEffect: callback=>react.useEffect(callback,[callback])},
  '@/src/state/auth': {useAuth:()=>({staff:identity})},
  '@/src/api/client': {subscribeApiCacheInvalidation:callback=>{subscribers.add(callback);return ()=>subscribers.delete(callback);}},
  './readCache': cache,
 };
 const exports={};
 vm.runInNewContext(transpile(read('../src/components/salesAnalytics/useAnalytics.ts')),{exports,require:id=>modules[id]||{},AbortController,Error});
 const flush=()=>{while(effects.length)effects.shift()();};
 return {
  requests,
  render(next={},runEffects=true) {
   input=next.input??input;enabled=next.enabled??enabled;identity=next.identity===undefined?identity:next.identity;revision=next.revision??revision;cursor=0;
   const value=exports.useAnalyticsRead(input,signal=>new Promise((resolve,reject)=>requests.push({input,signal,resolve,reject})),enabled,revision);
   if(runEffects)flush();return value;
  },
  invalidate(scope='mutation') {subscribers.forEach(callback=>callback(scope));},
  async settle(){for(let index=0;index<6;index++)await Promise.resolve();},
  unmount(){hooks.forEach(hook=>hook?.cleanup?.());},
 };
}

{
 const first=fixture();assert.equal(first.render().data,null);first.requests[0].resolve({sales:125});await first.settle();assert.equal(first.render().data.sales,125);first.unmount();
 const revisit=fixture({clear:false});const immediate=revisit.render();assert.equal(immediate.data.sales,125);assert.equal(immediate.refreshing,true);assert.equal(revisit.requests.length,1,'cached preview always revalidates');
 revisit.requests[0].resolve({sales:150});await revisit.settle();assert.equal(revisit.render().data.sales,150);revisit.unmount();
}
{
 const view=fixture();view.render();const old=view.requests[0];assert.equal(view.render({input:'dashboard:ground-floor'},false).data,null);old.resolve({sales:999});await view.settle();assert.equal(view.render().data,null);view.requests[1].resolve({sales:20});await view.settle();assert.equal(view.render().data.sales,20);
 assert.equal(view.render({identity:{...owner,floor_ids:['ground-floor']}},false).data,null,'permission changes hide previous values synchronously');view.unmount();
}
{
 const view=fixture();view.render();view.requests[0].resolve({sales:125});await view.settle();let value=view.render();value.refresh();value=view.render();assert.equal(value.data.sales,125);assert.equal(value.refreshing,true);
 view.requests[1].reject(new Error('Offline'));await view.settle();value=view.render();assert.equal(value.data.sales,125);assert.equal(value.error,'Offline');value.refresh();view.render();view.requests[2].reject(Object.assign(new Error('Access denied'),{status:403}));await view.settle();assert.equal(view.render().data,null);view.unmount();
 const denied=fixture({clear:false});assert.equal(denied.render().data,null,'revoked access evicts the cached preview');denied.unmount();
}
{
 const view=fixture();view.render();view.requests[0].resolve({sales:125});await view.settle();view.render();assert.equal(view.render({enabled:false},false).data,null);assert.equal(view.render({enabled:false}).loading,false);view.unmount();
 const off=fixture();assert.equal(off.render({enabled:false}).loading,false);assert.equal(off.requests.length,0);off.unmount();
}
{
 const view=fixture();view.render();const obsolete=view.requests[0];view.invalidate();obsolete.resolve({sales:999});await view.settle();view.render();assert.equal(view.render().data,null,'mutation generation prevents late cache insertion');view.requests[1].resolve({sales:45});await view.settle();assert.equal(view.render().data.sales,45);
 view.invalidate('identity');assert.equal(view.render().data,null,'logout clears mounted state as well as revisit data');view.unmount();
}
{
 const view=fixture();view.render();view.requests[0].resolve({sales:50});await view.settle();view.render();const refreshed=view.render({revision:1});assert.equal(refreshed.data.sales,50);assert.equal(view.requests.length,2);view.unmount();
 const revisit=fixture({clear:false});assert.equal(revisit.render().data.sales,50,'refresh revisions do not fragment revisit keys');revisit.unmount();
}
{
 let now=1_000;class Clock extends Date{static now(){return now;}}
 const exports={};vm.runInNewContext(transpile(read('../src/components/salesAnalytics/readCache.ts')),{exports,Date:Clock});
 const generation=exports.analyticsCacheGeneration();
 for(let index=0;index<100;index++)exports.cacheAnalyticsRead(String(index),{index},generation);
 assert.equal(exports.cachedAnalyticsRead('0'),null,'long sessions retain only a bounded set of pages');assert.equal(exports.cachedAnalyticsRead('99').index,99);now+=30_001;assert.equal(exports.cachedAnalyticsRead('99'),null,'previews expire');
 exports.clearAnalyticsReadCache();exports.cacheAnalyticsRead('old',{sales:99},generation);assert.equal(exports.cachedAnalyticsRead('old'),null,'invalidated request cannot repopulate cache');
 assert.notEqual(exports.analyticsIdentityKey(owner),exports.analyticsIdentityKey({...owner,custom_access:true,access_grants:[{action:'view',allow:false}]}));
}
{
 const dashboard=fixture();dashboard.render();dashboard.requests[0].resolve({sales:100});await dashboard.settle();dashboard.render();
 const customers=fixture({clear:false});customers.render({input:'customers:first-floor'});const late=customers.requests[0];
 dashboard.render().refresh();dashboard.render();dashboard.requests[1].reject(Object.assign(new Error('Denied'),{status:403}));await dashboard.settle();
 assert.equal(customers.render().data,null,'a denial clears other mounted previews');
 late.resolve({sales:999});await customers.settle();assert.equal(customers.render().data,null,'a denied identity cannot repopulate a different cached page');
 dashboard.unmount();customers.unmount();
 const revisit=fixture({clear:false});assert.equal(revisit.render().data,null);revisit.unmount();
}
for(const path of ['../src/api/client.ts','../src/api/client.web.ts']) {
 const storage={secureGet:async()=>null,getItem:async()=>'',secureSet:async()=>{},setItem:async()=>{},secureRemove:async()=>{},removeItem:async()=>{}};
 const exports={};vm.runInNewContext(transpile(read(path)),{exports,require:()=>({storage,browserStorage:storage}),__DEV__:true,process:{env:{}},document:{cookie:''},AbortController,DOMException,setTimeout,clearTimeout,fetch:async()=>({ok:true,text:async()=>'{}'})});
 const seen=[];const off=exports.subscribeApiCacheInvalidation(scope=>seen.push(scope));
 exports.setRequestFloorId('first-floor');exports.setRequestFloorId('ground-floor');assert.equal(seen.at(-1),'workspace');
 await exports.setToken('test-only','staff');assert.equal(seen.at(-1),'identity');await exports.api.post('/test',{});assert.equal(seen.at(-1),'mutation');await exports.clearToken();assert.equal(seen.at(-1),'identity');
 const count=seen.length;off();exports.clearApiResponseCache();assert.equal(seen.length,count,'unmounted views unsubscribe');
}
console.log('Instant analytics reads: cached revalidation, permission/account/floor isolation, expiry/bounds, disabled states, refresh/error/revocation and actual-client invalidation passed.');
