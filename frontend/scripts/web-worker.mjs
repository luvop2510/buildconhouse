// Production browser authentication boundary, shared by Sites and Pages builds.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.ingest.sentry.io; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};
function secure(response, api = false) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  if (api) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {status:response.status,statusText:response.statusText,headers});
}
function cookie(request, name) {
  return request.headers.get('Cookie')?.split(';').map(p=>p.trim()).find(p=>p.startsWith(name+'='))?.slice(name.length+1);
}
function clearSession(response) {
  const headers=new Headers(response.headers);
  headers.append('Set-Cookie','forge_session=; Path=/api; Max-Age=0; Secure; HttpOnly; SameSite=Strict');
  headers.append('Set-Cookie','forge_csrf=; Path=/; Max-Age=0; Secure; SameSite=Strict');
  return new Response(response.body,{status:response.status,headers});
}
function failure(status, detail) { return new Response(JSON.stringify({detail}),{status,headers:{'Content-Type':'application/json'}}); }
async function loginSession(response) {
  const payload=await response.json();
  const token=payload?.access_token;
  const headers=new Headers(response.headers);
  headers.delete('Content-Length'); headers.delete('Content-Encoding');
  if (token) {
    headers.append('Set-Cookie','forge_session='+encodeURIComponent(token)+'; Path=/api; Secure; HttpOnly; SameSite=Strict');
    headers.append('Set-Cookie','forge_csrf='+encodeURIComponent(crypto.randomUUID()+crypto.randomUUID())+'; Path=/; Secure; SameSite=Strict');
    payload.access_token='';
  }
  return new Response(JSON.stringify(payload),{status:response.status,headers});
}
async function fetchAsset(request, env, pathname) {
  for (const prefix of ['', '/client', '/dist', '/dist/client']) {
    const response=await env.ASSETS.fetch(new Request(new URL(prefix+(pathname||'/'),request.url),request));
    if(response.status!==404) return response;
  }
  return new Response('Not Found',{status:404});
}
export function createWorker(backendUrl, fetchImpl = fetch, timeoutMs = 15000) {
  return {async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/')) {
      const session=cookie(request,'forge_session');
      const unsafe=!['GET','HEAD','OPTIONS'].includes(request.method);
      const csrf=cookie(request,'forge_csrf');
      if(unsafe && session && (!csrf || request.headers.get('Origin')!==url.origin || request.headers.get('X-CSRF-Token')!==csrf)) return secure(failure(403,'CSRF validation failed'),true);
      const headers=new Headers(request.headers);
      headers.delete('Cookie'); headers.delete('Host');
      if(session && !headers.has('Authorization')) {
        try { headers.set('Authorization','Bearer '+decodeURIComponent(session)); }
        catch { return secure(clearSession(failure(401,'Invalid session. Sign in again.')),true); }
      }
      headers.set('X-Forwarded-Proto','https'); headers.set('X-Forwarded-Host',url.host);
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        let response=await fetchImpl(new Request(new URL(url.pathname+url.search,backendUrl),{
          method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,
          redirect:'manual',signal:controller.signal,...(request.body?{duplex:'half'}:{}),
        }));
        if(response.ok && ['/api/auth/login','/api/auth/customer/login'].includes(url.pathname)) response=await loginSession(response);
        if(url.pathname==='/api/auth/logout' || response.status===401) response=clearSession(response);
        return secure(response,true);
      } catch {
        const response=failure(controller.signal.aborted?504:502,controller.signal.aborted?'The upstream API timed out.':'The upstream API is unavailable.');
        return secure(url.pathname==='/api/auth/logout'?clearSession(response):response,true);
      } finally { clearTimeout(timer); }
    }
    const asset=await fetchAsset(request,env,url.pathname);
    if(asset.status!==404) return secure(asset);
    // Missing scripts must remain 404; serving HTML hides deployment errors.
    if(/\.[^/]+$/.test(url.pathname)) return secure(asset);
    return secure(await fetchAsset(request,env,'/index.html'));
  }};
}
