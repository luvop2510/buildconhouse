import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
for(const name of ['client.ts','client.web.ts']) for(const scenario of ['recover','persistent','cancel','write','timeout','http']) {
 const module={exports:{}}, timers=new Map();let id=0,calls=0;
 const storage={secureGet:async()=>null,getItem:async()=> 'second-floor'};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../src/api/${name}`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module,exports:module.exports,require:()=>({storage,browserStorage:storage}),__DEV__:true,process:{env:{}},document:{cookie:''},AbortController,DOMException,TypeError,
  setTimeout:(callback,ms)=>{const key=++id;timers.set(key,{callback,ms});return key;},clearTimeout:key=>timers.delete(key),
  fetch:async(_url,{signal})=>{calls++;if(scenario==='http')return {ok:false,status:503,text:async()=>'{"detail":"Unavailable"}'};
   if(scenario==='timeout')return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new TypeError('Load failed')),{once:true}));
   if(calls===1||scenario==='persistent'||scenario==='write')throw new TypeError('Load failed');
   return {ok:true,text:async()=>'{"stage":"quotation"}'};
  },
 });
 const client=module.exports;client.setRequestFloorId('second-floor');const controller=new AbortController();
 const outcome=(scenario==='write'?client.api.post('/kitchen-projects/p/commands',{command:'move_stage'}):client.api.get('/kitchen-projects/p',{signal:controller.signal})).then(value=>({value}),error=>({error}));
 const tick=()=>new Promise(resolve=>setImmediate(resolve));await tick();
 if(scenario==='cancel')controller.abort();
 if(scenario==='timeout'){const deadline=[...timers.values()].find(x=>x.ms===30000);assert.ok(deadline);deadline.callback();}
 if(['recover','persistent'].includes(scenario)){const pause=[...timers.values()].find(x=>x.ms===150);assert.ok(pause);pause.callback();}
 const {value,error}=await outcome;
 if(scenario==='recover'){assert.equal(value.stage,'quotation');assert.equal(calls,2);}
 else {assert.ok(error);assert.equal(calls,scenario==='persistent'?2:1);assert.equal(scenario==='cancel'?error.name:error.status,scenario==='cancel'?'AbortError':scenario==='timeout'?408:503);}
 assert.equal([...timers.values()].filter(x=>x.ms===30000).length,0,'Original deadline cleans up; no new request budget is allocated');
}
console.log('Kitchen native/web: one dropped read recovers, persistent failure stays bounded, cancellation/timeout never retries, HTTP errors and stage writes execute once.');
