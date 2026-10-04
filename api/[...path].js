const MAX_REQUEST_BODY_BYTES = 1_048_576;
// The browser client allows a request 30 seconds. Give the proxy nearly that
// full window so it does not turn a healthy-but-slow Railway response into a
// premature 504; retain a small margin for proxying the response downstream.
const UPSTREAM_TIMEOUT_MS = 28_000;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.ingest.sentry.io; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

export function validateBackendUrl(value) {
  if (!value) throw new Error('BACKEND_URL is required for the web API proxy.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('BACKEND_URL must be a valid absolute HTTPS URL.'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('BACKEND_URL must be an HTTPS URL without embedded credentials.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function cookie(req, name) {
  return req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function writeSecurityHeaders(res) {
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => res.setHeader(key, value));
}

export class BodyTooLargeError extends Error {}

export function readBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return Promise.reject(new BodyTooLargeError());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Drain the already-open connection without buffering the remaining body.
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) return fail(new BodyTooLargeError());
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error) => fail(error);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export async function fetchWithTimeout(url, options, { fetchImpl = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

export const config = { api: { bodyParser: false } };

export function createHandler({ backendUrl = process.env.BACKEND_URL, fetchImpl = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  return async function handler(req, res) {
    writeSecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    let backend;
    try { backend = validateBackendUrl(backendUrl); }
    catch (error) {
      console.error('Web API proxy configuration error:', error.message);
      return res.status(500).json({ detail: 'Web API proxy is not configured.' });
    }

    const queryPath = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
    const path = queryPath || req.url.split('?')[0].replace(/^\/api\/?/, '');
    if (!path) return res.status(404).json({ detail: 'Not Found' });

    const session = cookie(req, 'forge_session');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const expectedOrigin = host ? `https://${host}` : undefined;
    if (unsafe && session && (!cookie(req, 'forge_csrf') || origin !== expectedOrigin || req.headers['x-csrf-token'] !== cookie(req, 'forge_csrf'))) {
      return res.status(403).json({ detail: 'CSRF validation failed' });
    }

    let body;
    try { body = unsafe ? await readBody(req) : undefined; }
    catch (error) {
      if (error instanceof BodyTooLargeError) return res.status(413).json({ detail: 'Request body exceeds the 1 MiB limit.' });
      console.error('Web API proxy request-body error:', error);
      return res.status(400).json({ detail: 'Unable to read request body.' });
    }

    const upstream = new URL(`/api/${path}`, backend);
    Object.entries(req.query).forEach(([key, value]) => {
      if (key !== 'path') upstream.searchParams.set(key, Array.isArray(value) ? value[0] : value);
    });
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (!['cookie', 'host', 'connection', 'content-length'].includes(key) && value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    });
    // Preserve the single-use download token and its floor binding. A
    // forwarded session bearer would make backend auth ignore `dl`.
    if (req.method === 'GET' && upstream.searchParams.has('dl')) headers.delete('authorization');
    else if (session && !headers.has('authorization')) {
      try { headers.set('authorization', `Bearer ${decodeURIComponent(session)}`); }
      catch { return res.status(401).json({ detail: 'Invalid session. Sign in again.' }); }
    }
    headers.set('x-forwarded-proto', 'https');
    if (host) headers.set('x-forwarded-host', host);

    let upstreamResponse;
    try {
      upstreamResponse = await fetchWithTimeout(upstream, {
        method: req.method, headers, body: body?.length ? body : undefined, redirect: 'manual',
      }, { fetchImpl, timeoutMs });
    } catch (error) {
      if (error?.name === 'AbortError') return res.status(504).json({ detail: 'The upstream API timed out.' });
      console.error('Web API proxy upstream failure:', error);
      return res.status(502).json({ detail: 'The upstream API is unavailable.' });
    }

    // Keep backend processing time visible in browser diagnostics and preserve
    // rate-limit recovery guidance, including responses handled below as JSON.
    for (const name of ['Server-Timing', 'Retry-After']) {
      const value = upstreamResponse.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    const isLogin = upstreamResponse.ok && (path === 'auth/login' || path === 'auth/customer/login');
    if (isLogin) {
      const payload = await upstreamResponse.json();
      const token = payload?.access_token;
      if (token) {
        const csrf = crypto.randomUUID() + crypto.randomUUID();
        res.setHeader('Set-Cookie', [
          `forge_session=${encodeURIComponent(token)}; Path=/api; Secure; HttpOnly; SameSite=Strict`,
          `forge_csrf=${encodeURIComponent(csrf)}; Path=/; Secure; SameSite=Strict`,
        ]);
        payload.access_token = '';
        return res.status(upstreamResponse.status).json(payload);
      }
    }
    if (path === 'auth/logout') {
      res.setHeader('Set-Cookie', [
        'forge_session=; Path=/api; Max-Age=0; Secure; HttpOnly; SameSite=Strict',
        'forge_csrf=; Path=/; Max-Age=0; Secure; SameSite=Strict',
      ]);
    }
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentDisposition = upstreamResponse.headers.get('content-disposition');
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
    return res.status(upstreamResponse.status).send(Buffer.from(await upstreamResponse.arrayBuffer()));
  };
}

export default createHandler();
