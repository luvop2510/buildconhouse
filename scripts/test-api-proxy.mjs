import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

process.env.BACKEND_URL = 'https://api.example.test';
const { createHandler, validateBackendUrl, requestBodyLimit } = await import('../api/[...path].js');
const originalConsoleError = console.error;
console.error = () => {};

function request({ method = 'GET', path = ['health'], headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.query = { path };
  req.url = `/api/${Array.isArray(path) ? path.join('/') : path}`;
  req.headers = { host: 'buildcon.example', ...headers };
  req.resume = () => {};
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    headers: {}, statusCode: 200, payload: undefined,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    send(value) { this.payload = value; return this; },
  };
}

assert.equal(validateBackendUrl('https://api.example.test/'), 'https://api.example.test');
for (const path of ['products/custom-with-media', 'products/id/media', 'products/id/media/media-id/replace', 'products/id/diagram-media', 'families/family/media', 'godown-stock/lot/image']) {
  assert.equal(requestBodyLimit('POST', path, 'multipart/form-data; boundary=test'), 4 * 1024 * 1024);
  assert.equal(requestBodyLimit('POST', path, 'application/json'), 1024 * 1024);
  assert.equal(requestBodyLimit('PATCH', path, 'multipart/form-data; boundary=test'), 1024 * 1024);
}
for (const path of ['godown-stock/image', 'godown-stock/lot/image/other', 'godown-stock/lot/details']) {
  assert.equal(requestBodyLimit('POST', path, 'multipart/form-data; boundary=test'), 1024 * 1024);
}
assert.equal(requestBodyLimit('POST', 'auth/login', 'multipart/form-data; boundary=test'), 1024 * 1024);
for (const value of ['', 'http://api.example.test', 'https://user:pass@api.example.test', 'not a url']) {
  assert.throws(() => validateBackendUrl(value));
}

{
  const [proxySource, buildSource, easConfig] = await Promise.all([
    readFile(new URL('../api/[...path].js', import.meta.url), 'utf8'),
    readFile(new URL('./sites-build.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../eas.json', import.meta.url), 'utf8'),
  ]);
  assert.match(proxySource, /process\.env\.BACKEND_URL/);
  assert.match(buildSource, /process\.env\.BACKEND_URL/);
  assert.doesNotMatch(`${proxySource}\n${buildSource}\n${easConfig}`, /buildcon-backend-production/);
}

{
  const res = response();
  let target;
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async (url) => {
    target = url.toString();
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  } })(request({ path: ['catalog'], headers: { 'x-floor-id': 'first-floor' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(target, 'https://api.example.test/api/catalog');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
}

{
  const res = response();
  const req = request({ path: ['products', 'families'], headers: { 'x-floor-id': 'first-floor' } });
  Object.assign(req.query, {
    brand_ids: ['grohe', 'hansgrohe'], category_ids: ['tap & mixers', 'showers'],
    sizes: ['M, compact', 'L/XL'], subcategories: ['', 'General'], limit: '60', skip: '0',
  });
  let target, sentHeaders;
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async (url, options) => {
    target = url;
    sentHeaders = options.headers;
    return new Response('{"total":0,"items":[]}', { headers: { 'Content-Type': 'application/json' } });
  } })(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(target.pathname, '/api/products/families');
  assert.deepEqual(target.searchParams.getAll('brand_ids'), ['grohe', 'hansgrohe']);
  assert.deepEqual(target.searchParams.getAll('category_ids'), ['tap & mixers', 'showers']);
  assert.deepEqual(target.searchParams.getAll('sizes'), ['M, compact', 'L/XL']);
  assert.deepEqual(target.searchParams.getAll('subcategories'), ['', 'General']);
  assert.equal(target.searchParams.get('limit'), '60');
  assert.equal(target.searchParams.get('skip'), '0');
  assert.equal(target.searchParams.has('path'), false);
  assert.equal(sentHeaders.get('x-floor-id'), 'first-floor');
}

{
  const res = response();
  let sentHeaders;
  const req = request({ path: ['quotations', 'q1', 'pptx'], headers: { cookie: 'forge_session=secret' } });
  req.query.dl = 'one-use';
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async (url, options) => {
    assert.equal(url.toString(), 'https://api.example.test/api/quotations/q1/pptx?dl=one-use');
    sentHeaders = options.headers;
    return new Response('deck', { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': 'attachment; filename="quote.pptx"',
    } });
  } })(req, res);
  assert.equal(sentHeaders.get('authorization'), null);
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="quote.pptx"');
  assert.equal(res.statusCode, 200);
}

{
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => new Response('{"detail":"Try later"}', {
    status: 429, headers: { 'Content-Type': 'application/json', 'Server-Timing': 'app;dur=12.3', 'Retry-After': '60', 'X-Internal-Debug': 'private' },
  }) })(request(), res);
  assert.equal(res.statusCode, 429);
  assert.match(res.headers['Server-Timing'], /^app;dur=12\.3, upstream;dur=\d+\.\d$/);
  assert.equal(res.headers['Retry-After'], '60');
  assert.equal(res.headers['X-Internal-Debug'], undefined);
  assert.equal(res.headers['Cache-Control'], 'no-store');
}

{
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => { throw new Error('offline'); } })(request(), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.payload.detail, 'The upstream API is unavailable.');
}

{
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', timeoutMs: 5, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }) })(request(), res);
  assert.equal(res.statusCode, 504);
}

// Headers alone must not end the deadline: stalled JSON/download bodies are
// the same upstream timeout as a connection that never returns headers.
for (const path of [['products', 'families'], ['auth', 'login'], ['quotations', 'q1', 'pptx']]) {
  const res = response();
  const login = path.join('/') === 'auth/login';
  await createHandler({ backendUrl: 'https://api.example.test', timeoutMs: 5, fetchImpl: async (_url, options) => {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      options.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    } }), { headers: { 'Content-Type': 'application/json' } });
  } })(request({ path, method: login ? 'POST' : 'GET', headers: login ? { origin: 'https://buildcon.example' } : {} }), res);
  assert.equal(res.statusCode, 504, `${path}: stalled response body must time out`);
}

{
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => new Response('broken') })(request({ method: 'POST', path: ['auth', 'login'], headers: { origin: 'https://buildcon.example' } }), res);
  assert.equal(res.statusCode, 502);
}

{
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => { throw new Error('must not reach upstream'); } })(
    request({ method: 'POST', headers: { 'content-length': String(1_048_577) } }), res,
  );
  assert.equal(res.statusCode, 413);
}

// A normal photo above the former 1 MiB cap must arrive intact, with its
// multipart boundary, selected floor and same-origin session protection.
for (const path of [['products', 'custom-with-media'], ['products', 'product', 'media'], ['godown-stock', 'lot', 'image']]) {
  const body = Buffer.concat([Buffer.from('--photo\r\nContent-Type: image/jpeg\r\n\r\n'), Buffer.alloc(2 * 1024 * 1024, 37), Buffer.from('\r\n--photo--\r\n')]);
  const headers = { cookie: 'forge_session=fixture-session; forge_csrf=csrf', origin: 'https://buildcon.example', 'x-csrf-token': 'csrf', 'x-floor-id': 'ground-floor', 'content-type': 'multipart/form-data; boundary=photo' };
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async (_url, options) => {
    assert.deepEqual(options.body, body);
    assert.equal(options.headers.get('content-type'), headers['content-type']);
    assert.equal(options.headers.get('x-floor-id'), 'ground-floor');
    assert.equal(options.headers.get('authorization'), 'Bearer fixture-session');
    return Response.json({ id: 'stored' });
  } })(request({ method: 'POST', path, headers, body }), res);
  assert.equal(res.statusCode, 200);
  const oversized = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => { throw new Error('oversized photo reached upstream'); } })(request({ method: 'POST', path, headers: { ...headers, 'content-length': String(4 * 1024 * 1024 + 1) } }), oversized);
  assert.equal(oversized.statusCode, 413);
  assert.match(oversized.payload.detail, /4 MiB/);
  const streamed = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => { throw new Error('unbounded stream reached upstream'); } })(request({ method: 'POST', path, headers, body: Buffer.alloc(4 * 1024 * 1024 + 1) }), streamed);
  assert.equal(streamed.statusCode, 413);
  const csrf = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => { throw new Error('CSRF upload reached upstream'); } })(request({ method: 'POST', path, headers: { ...headers, 'x-csrf-token': 'wrong' }, body }), csrf);
  assert.equal(csrf.statusCode, 403);
}

// A stale cookie pair must never prevent a new credential login. Login is
// still strictly same-origin; every authenticated write retains CSRF checks.
for (const path of [['auth', 'login'], ['auth', 'customer', 'login']]) {
  for (const cookie of ['forge_session=expired', 'forge_session=%ZZ; forge_csrf=%ZZ']) {
    const res = response();
    await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async (_url, options) => {
      assert.equal(options.headers.get('authorization'), null, 'old identity must not accompany credential login');
      return Response.json({ access_token: 'fresh-session', user: { id: 'fixture' } });
    } })(request({ method: 'POST', path, headers: { cookie, origin: 'https://buildcon.example' }, body: '{"email":"fixture","password":"fixture"}' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.access_token, '');
    assert.match(res.headers['Set-Cookie'][0], /forge_session=fresh-session;/);
  }
  for (const origin of [undefined, 'https://evil.example', 'null']) {
    const res = response();
    await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => { throw new Error('must not reach upstream'); } })(request({ method: 'POST', path, headers: { origin } }), res);
    assert.equal(res.statusCode, 403, 'credential login requires trusted browser origin');
  }
}
for (const path of [['team', 'fixture'], ['auth', 'logout']]) {
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => { throw new Error('must not reach upstream'); } })(request({ method: 'POST', path, headers: { cookie: 'forge_session=expired', origin: 'https://buildcon.example' } }), res);
  assert.equal(res.statusCode, 403, 'authenticated mutations still require CSRF');
}

for (const method of ['GET', 'HEAD']) {
  const res = response();
  const req = request({ method, path: ['quotations', 'shared-pdf', 'a'.repeat(43)], headers: {
    cookie: 'forge_session=expired', authorization: 'Bearer restricted',
  } });
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async (_url, options) => {
    assert.equal(options.headers.get('authorization'), null);
    return new Response('%PDF', { headers: { 'Content-Type': 'application/pdf', 'Referrer-Policy': 'no-referrer' } });
  } })(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(res.headers['Cache-Control'], 'no-store');
}

{
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async (_url, options) => {
    assert.equal(options.headers.get('authorization'), 'Bearer restricted');
    return new Response('{}');
  } })(request({ path: ['quotations', 'q1', 'whatsapp-draft'], headers: { authorization: 'Bearer restricted' } }), res);
}

console.log('API proxy security contract passed');
console.error = originalConsoleError;

// Browser restarts and deployment reloads retain the same revocable identity.
{
  const fixtureToken = (exp) => `fixture.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  for (const endpoint of ['auth/login', 'auth/customer/login']) {
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const token = fixtureToken(exp);
    const res = response();
    await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => Response.json({ access_token: token }) })(request({ method: 'POST', path: endpoint, headers: { origin: 'https://buildcon.example' } }), res);
    assert.equal(res.payload.access_token, '');
    for (const value of res.headers['Set-Cookie']) {
      const maxAge = Number(value.match(/Max-Age=(\d+)/)?.[1]);
      assert.ok(maxAge > 7100 && maxAge <= 7200, 'cookie persists no longer than the JWT');
      assert.match(value, /Expires=/);
      assert.match(value, /Secure;.*SameSite=Strict/);
    }
    assert.match(res.headers['Set-Cookie'][0], /HttpOnly/);
  }
  const token = fixtureToken(Math.floor(Date.now() / 1000) + 3600);
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async (_url, options) => {
    assert.equal(options.headers.get('authorization'), `Bearer ${token}`);
    return Response.json({ id: 'existing-account' });
  } })(request({ path: 'auth/me', headers: { cookie: `forge_session=${token}; forge_csrf=existing-csrf` } }), res);
  assert.match(res.headers['Set-Cookie'][0], /Max-Age=/, 'existing session-only cookies migrate without another login');
  assert.match(res.headers['Set-Cookie'][1], /forge_csrf=existing-csrf;/);
  for (const status of [401, 403, 503]) {
    const result = response();
    await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => Response.json({ detail: 'Fixture failure' }, { status }) })(request({ path: 'auth/me', headers: { cookie: `forge_session=${token}` } }), result);
    if (status === 401) assert.ok(result.headers['Set-Cookie'].every(value => value.includes('Max-Age=0')));
    else assert.equal(result.headers['Set-Cookie'], undefined, 'permissions/outages preserve the session');
  }
}

// Vercel transpiles the API entrypoint to CommonJS and disallows require(ESM),
// even when the development Node release accepts it. Execute that artifact.
{
  const source = await readFile(new URL('../api/[...path].js', import.meta.url), 'utf8');
  const artifact = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiled = { exports: {} };
  const localRequire = createRequire(new URL('../api/[...path].js', import.meta.url));
  vm.runInNewContext(artifact, {
    module: compiled, exports: compiled.exports,
    require(specifier) {
      assert.ok(!specifier.endsWith('.mjs'), 'Vercel CommonJS entrypoint must not require an ES module');
      return localRequire(specifier);
    },
    process, crypto, Buffer, fetch, Response, Headers, AbortController, URL, URLSearchParams, performance,
    setTimeout, clearTimeout, TextEncoder, TextDecoder, console,
  });
  const result = response();
  await compiled.exports.createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => Response.json({ status: 'ok' }) })(request(), result);
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.payload.toString()).status, 'ok');
  console.log('Vercel CommonJS runtime artifact imports and executes with ESM require disabled.');
}
