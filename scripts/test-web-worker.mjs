import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createWorker, sessionCookies } from './web-worker.mjs';
import { standaloneWorkerSource } from './build-web-worker.mjs';
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
const signedIn=await login.fetch(request('/api/auth/login',{method:'POST',headers:{Origin:base}}),{});assert.equal((await signedIn.json()).access_token,'');assert.match(signedIn.headers.get('set-cookie'),/HttpOnly/);assert.match(signedIn.headers.get('set-cookie'),/Path=\/;/);
for (const path of ['/api/auth/login','/api/auth/customer/login']) {
  for (const Cookie of ['forge_session=expired','forge_session=%ZZ; forge_csrf=%ZZ']) {
    const recovery=createWorker('https://api.example.test',async req=>{
      assert.equal(req.headers.get('Authorization'),null);
      return Response.json({access_token:'fresh-session',user:{id:'fixture'}});
    });
    const result=await recovery.fetch(request(path,{method:'POST',headers:{Cookie,Origin:base}}),{});
    assert.equal(result.status,200);
    assert.equal((await result.json()).access_token,'');
    assert.match(result.headers.get('set-cookie'),/forge_session=fresh-session;/);
  }
  for (const Origin of [undefined,'https://evil.test','null']) {
    const blocked=createWorker('https://api.example.test',async()=>{throw Error('must not reach upstream');});
    assert.equal((await blocked.fetch(request(path,{method:'POST',headers:Origin?{Origin}:{}}),{})).status,403);
  }
}
const assets={ASSETS:{fetch:async req=>new URL(req.url).pathname==='/index.html'?new Response('<html>app</html>'):new Response('',{status:404})}};
assert.equal((await worker.fetch(request('/sales-data'),assets)).status,200);
assert.equal((await worker.fetch(request('/missing.js'),assets)).status,404);
let mapAssetReads=0;
const mapAssets={ASSETS:{fetch:async()=>{mapAssetReads++;return new Response('private sources');}}};
assert.equal((await worker.fetch(request('/assets/bundle.js.map'),mapAssets)).status,404);
assert.equal((await worker.fetch(request('/assets/bundle.js.MAP'),mapAssets)).status,404);
assert.equal(mapAssetReads,0,'source maps must be denied before asset lookup');
console.log('Web worker: CSRF, cookie isolation, malformed sessions, errors/timeouts, login, asset fallback passed');

// Persist login cookies and upgrade existing cookies without extending expiry.
{
 const token=`fixture.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+7200})).toString('base64url')}.signature`;
 const persistent=createWorker('https://api.example.test',async()=>Response.json({access_token:token}));
 const result=await persistent.fetch(request('/api/auth/login',{method:'POST',headers:{Origin:base}}),{});
 assert.equal((await result.json()).access_token,'');
 const cookieHeader=result.headers.get('set-cookie');
 const ages=[...cookieHeader.matchAll(/Max-Age=(\d+)/g)].map(match=>Number(match[1]));
 assert.equal(ages.length,2);assert.ok(ages.every(age=>age>7100 && age<=7200));
 const restore=createWorker('https://api.example.test',async()=>Response.json({id:'same-account'}));
 const restored=await restore.fetch(request('/api/auth/me',{headers:{Cookie:`forge_session=${token}; forge_csrf=retained`}}),{});
 assert.match(restored.headers.get('set-cookie'),/Max-Age=/);assert.match(restored.headers.get('set-cookie'),/forge_csrf=retained;/);
 for(const status of [401,403,503]) {
   const denied=createWorker('https://api.example.test',async()=>Response.json({detail:'Fixture failure'},{status}));
   const checked=await denied.fetch(request('/api/auth/me',{headers:{Cookie:`forge_session=${token}`}}),{});
   assert.equal(Boolean(checked.headers.get('set-cookie')),status===401);
   const proof=await denied.fetch(request('/api/auth/change-password',{method:'POST',headers:{Cookie:`forge_session=${token}; forge_csrf=csrf`,Origin:base,'X-CSRF-Token':'csrf'}}),{});
   assert.equal(proof.headers.get('set-cookie'),null,'incorrect password proof does not discard the browser session');
 }
}

{
 const now=Date.now();
 const fixtureToken=exp=>`fixture.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.signature`;
 for(const [exp,expected] of [[Math.floor(now/1000)-1,0],[Math.floor(now/1000)+90*86400,30*86400]]) {
   for(const cookie of sessionCookies(fixtureToken(exp),'fixture-csrf',now)) assert.match(cookie,new RegExp(`Max-Age=${expected};`));
 }
 for(const token of ['opaque-legacy','broken.@@@.signature',fixtureToken('forever')]) {
   assert.ok(sessionCookies(token,'fixture-csrf',now).every(cookie=>!cookie.includes('Max-Age=')), 'unparseable expiry never creates an indefinitely persistent credential');
 }
}

// Exercise the actual standalone worker source emitted by production builds,
// not just its source-module imports in the development Node process.
{
 const source = await standaloneWorkerSource();
 assert.doesNotMatch(source, /^\s*import\s/m, 'Deployed workers cannot reference unpackaged local helpers');
 const built = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
 const token = `fixture.${Buffer.from(JSON.stringify({ exp: 2000 })).toString('base64url')}.signature`;
 assert.deepEqual(built.sessionCookies(token, 'csrf', 1000_000), sessionCookies(token, 'csrf', 1000_000));
 const runtime = built.createWorker('https://api.example.test', async () => Response.json({ status: 'ok' }));
 assert.equal((await runtime.fetch(request('/api/health'), {})).status, 200);
 console.log('Actual standalone production worker boots without module dependencies and retains canonical cookie behavior.');
}
