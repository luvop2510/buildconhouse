import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

process.env.BACKEND_URL = 'https://api.example.test';
const { createHandler, validateBackendUrl } = await import('../api/[...path].js');
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
  assert.equal(res.headers['Server-Timing'], 'app;dur=12.3');
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

{
  const res = response();
  await createHandler({ backendUrl: 'https://api.example.test', fetchImpl: async () => { throw new Error('must not reach upstream'); } })(
    request({ method: 'POST', headers: { 'content-length': String(1_048_577) } }), res,
  );
  assert.equal(res.statusCode, 413);
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
