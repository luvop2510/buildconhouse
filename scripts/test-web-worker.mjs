import assert from 'node:assert/strict';
import { createWorker } from './web-worker.mjs';
const base='https://app.example.test';
const request=(path='/api/orders',options={})=>new Request(base+path,options);
let calls=0;
const worker=createWorker('https://api.example.test',async req=>{calls++;assert.equal(req.headers.get('Cookie'),null);assert.equal(req.headers.get('Authorization'),'Bearer secret');return Response.json({ok:true});});
for(const headers of [ {'Cookie':'forge_session=secret','Origin':base}, {'Cookie':'forge_session=secret; forge_csrf=csrf','Origin':base}, {'Cookie':'forge_session=secret; forge_csrf=csrf','Origin':'https://evil.test','X-CSRF-Token':'csrf'} ]) {
 assert.equal((await worker.fetch(request('/api/orders',{method:'POST',headers}),{})).status,403);
}
assert.equal(calls,0);
const good=await worker.fetch(request('/api/orders',{method:'POST',headers:{Cookie:'forge_session=secret; forge_csrf=csrf',Origin:base,'X-CSRF-Token':'csrf'}}),{});
assert.equal(good.status,200);assert.equal(good.headers.get('Cache-Control'),'no-store');
const attachmentWorker=createWorker('https://api.example.test',async req=>{
  assert.equal(req.url,'https://api.example.test/api/quotations/q1/pptx?dl=one-use');
  assert.equal(req.headers.get('Authorization'),null);
  return new Response('deck',{headers:{'Content-Disposition':'attachment; filename="quote.pptx"'}});
});
const attachment=await attachmentWorker.fetch(request('/api/quotations/q1/pptx?dl=one-use',{headers:{Cookie:'forge_session=secret'}}),{});
assert.equal(attachment.headers.get('Content-Disposition'),'attachment; filename="quote.pptx"');
const malformed=await worker.fetch(request('/api/orders',{headers:{Cookie:'forge_session=%ZZ'}}),{});assert.equal(malformed.status,401);
const offline=createWorker('https://api.example.test',async()=>{throw Error('offline');});assert.equal((await offline.fetch(request(),{})).status,502);
const timeout=createWorker('https://api.example.test',req=>new Promise((resolve,reject)=>req.signal.addEventListener('abort',()=>reject(Error('timeout')))),5);
assert.equal((await timeout.fetch(request(),{})).status,504);
const login=createWorker('https://api.example.test',async()=>Response.json({access_token:'secret',user:{id:'one'}}));
const signedIn=await login.fetch(request('/api/auth/login',{method:'POST'}),{});assert.equal((await signedIn.json()).access_token,'');assert.match(signedIn.headers.get('set-cookie'),/HttpOnly/);assert.match(signedIn.headers.get('set-cookie'),/Path=\/;/);
const assets={ASSETS:{fetch:async req=>new URL(req.url).pathname==='/index.html'?new Response('<html>app</html>'):new Response('',{status:404})}};
assert.equal((await worker.fetch(request('/sales-data'),assets)).status,200);
assert.equal((await worker.fetch(request('/missing.js'),assets)).status,404);
let mapAssetReads=0;
const mapAssets={ASSETS:{fetch:async()=>{mapAssetReads++;return new Response('private sources');}}};
assert.equal((await worker.fetch(request('/assets/bundle.js.map'),mapAssets)).status,404);
assert.equal((await worker.fetch(request('/assets/bundle.js.MAP'),mapAssets)).status,404);
assert.equal(mapAssetReads,0,'source maps must be denied before asset lookup');
console.log('Web worker: CSRF, cookie isolation, malformed sessions, errors/timeouts, login, asset fallback passed');
