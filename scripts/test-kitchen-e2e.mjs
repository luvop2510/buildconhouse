// Independent exported-UI -> actual FastAPI router -> disposable Mongo acceptance.
// This test-only proxy supplies a synthetic owner session; it is never deployed.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '..');
const pilot = process.argv.includes('--pilot');
const separator = process.argv.indexOf('--');
const playwrightArguments = separator < 0 ? [] : process.argv.slice(separator + 1);
const pilotPort = pilot ? Number(process.env.KITCHEN_PILOT_PORT || 0) : 0;
if (!Number.isInteger(pilotPort) || pilotPort < 0 || pilotPort > 65535 || (pilotPort > 0 && pilotPort < 1024)) {
  throw new Error('KITCHEN_PILOT_PORT must be zero or an unprivileged TCP port');
}
const temp = await mkdtemp(resolve(tmpdir(), 'forge-kitchen-e2e-'));
const children = [];
let proxy;
const cleanEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: temp,
  PYTHON_DOTENV_DISABLED: '1', PYTHONDONTWRITEBYTECODE: '1', EXPO_NO_DOTENV: '1',
  MONGO_URL: 'mongodb://127.0.0.1:1', DB_NAME: 'forge_kitchen_acceptance_unused',
  JWT_SECRET: 'kitchen-acceptance-not-a-real-secret-32chars', JWT_ALGORITHM: 'HS256', JWT_EXP_MINUTES: pilot ? '480' : '60',
  MEDIA_STORAGE_DRIVER: 'supabase', SUPABASE_URL: 'https://kitchen-placeholder.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'kitchen-not-real', SUPABASE_ANON_KEY: 'kitchen-not-real',
  SUPABASE_PUBLIC_BUCKET: 'forge-products', SUPABASE_PRIVATE_BUCKET: 'forge-private',
  FORGE_ALLOW_DEMO_SEED: 'false', ENVIRONMENT: 'production',
};
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function port() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const selected = probe.address().port; await new Promise(done => probe.close(done)); return selected;
}
function launch(command, args, extra = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...cleanEnv, ...extra } });
  children.push(child); return child;
}
async function completed(child) {
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Acceptance command failed (exit ${code}, signal ${signal || 'none'})`);
}
async function until(check, child, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before readiness`);
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`${label} did not become ready`);
}
try {
  let mongoUrl = process.env.KITCHEN_TEST_MONGO_URL;
  if (mongoUrl) {
    const url = new URL(mongoUrl);
    if (url.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      throw new Error('KITCHEN_TEST_MONGO_URL must identify an explicitly selected disposable loopback Mongo');
    }
  } else {
    const mongoPort = await port();
    await mkdir(resolve(temp, 'db'));
    const mongo = launch(process.env.KITCHEN_TEST_MONGOD || 'mongod', ['--bind_ip', '127.0.0.1', '--port', String(mongoPort),
      '--dbpath', resolve(temp, 'db'), '--logpath', resolve(temp, 'mongo.log'), '--nounixsocket']);
    mongoUrl = `mongodb://127.0.0.1:${mongoPort}`;
    await until(async () => (await readFile(resolve(temp, 'mongo.log'), 'utf8').catch(() => '')).includes('Waiting for connections'), mongo, 'Owned Mongo');
  }
  const apiPort = await port();
  const manifestPath = resolve(temp, 'session.json');
  const python = process.env.FORGE_AUDIT_PYTHON || resolve(root, 'backend/.venv/bin/python');
  const api = launch(python, [resolve(root, 'backend/tests/integration/test_kitchen_projects_mongo.py'), '--port', String(apiPort), '--manifest', manifestPath],
    { KITCHEN_TEST_MONGO_URL: mongoUrl, PYTHONPATH: resolve(root, 'backend') });
  await until(async () => Boolean(await stat(manifestPath).catch(() => null)), api, 'Kitchen API');
  const session = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!process.argv.includes('--reuse-export')) {
    await completed(launch('npm', ['run', 'build'], { BACKEND_URL: 'https://kitchen-acceptance.invalid' }));
  }
  const sourceExport = resolve(root, 'dist/client');
  if (!(await stat(resolve(sourceExport, 'kitchen.html')).catch(() => null)) && !(await stat(resolve(sourceExport, 'kitchen/index.html')).catch(() => null))) {
    throw new Error('Current export has no Kitchen route; rebuild before acceptance');
  }
  // Browser runs read an immutable copy. Another editor build cannot replace
  // chunks beneath an in-flight test or make a stale export look current.
  const exported = resolve(temp, 'export');
  await cp(sourceExport, exported, { recursive: true });
  const productionHeaders = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8')).routes.find(rule => rule.src === '/(.*)').headers;
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
  proxy = createServer(async (request, response) => {
    try {
      for (const [name, value] of Object.entries(productionHeaders)) response.setHeader(name, value);
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pilot && pathname === '/__kitchen-pilot-start.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        response.end("localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));location.replace('/kitchen');");
        return;
      }
      if (pilot && pathname === '/__kitchen-pilot') {
        const role = new URL(request.url, 'http://localhost').searchParams.get('role');
        if (role !== null) {
          if (!['owner', 'manager', 'worker'].includes(role)) { response.writeHead(400).end('Unknown synthetic role'); return; }
          response.setHeader('Set-Cookie', `kitchen_acceptance_session=${role}; HttpOnly; SameSite=Strict; Path=/`);
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Kitchen synthetic pilot</title><p>Opening synthetic Kitchen account...</p><script src="/__kitchen-pilot-start.js"></script></html>');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kitchen synthetic pilot</title><h1>Local synthetic Kitchen pilot</h1><p>Disposable test records; no production writes.</p><p>Select an account. Return here to switch accounts. Department manager approvals require the selected manager account.</p><ul><li><a href="/__kitchen-pilot?role=owner">Synthetic owner</a></li><li><a href="/__kitchen-pilot?role=manager">Selected department manager</a></li><li><a href="/__kitchen-pilot?role=worker">Ordinary assigned employee</a></li></ul><p>Use only synthetic data. This pilot ends when its local process stops.</p></html>');
        return;
      }
      if (pathname.startsWith('/api/')) {
        const actor = request.headers.cookie?.match(/(?:^|;\s*)kitchen_acceptance_session=([^;]+)/)?.[1];
        if (actor && !['owner', 'second', 'manager', 'worker', 'denied', 'anonymous'].includes(actor)) { response.writeHead(401).end('Unknown synthetic account'); return; }
        const token = actor === 'anonymous' ? null : actor === 'denied' ? session.denied_token : actor === 'second' ? session.second_token : actor === 'manager' ? session.manager_token : actor === 'worker' ? session.worker_token : session.token;
        if (actor === 'denied' && !token) { response.writeHead(503).end('Denied synthetic fixture is unavailable'); return; }
        const upstreamHeaders = { ...request.headers, host: `127.0.0.1:${apiPort}` };
        delete upstreamHeaders.authorization;
        if (token) upstreamHeaders.authorization = `Bearer ${token}`;
        const upstream = httpRequest({ host: '127.0.0.1', port: apiPort, path: request.url, method: request.method,
          headers: upstreamHeaders }, res => {
          response.writeHead(res.statusCode, res.headers); res.pipe(response);
        });
        upstream.on('error', () => response.writeHead(502).end('Owned acceptance API unavailable'));
        request.pipe(upstream); return;
      }
      const target = resolve(exported, `.${pathname}`);
      if (target !== exported && !target.startsWith(exported + sep)) { response.writeHead(403).end(); return; }
      for (const candidate of [target, `${target}.html`, resolve(target, 'index.html'), resolve(exported, 'index.html')]) {
        if (!(await stat(candidate).catch(() => null))?.isFile()) continue;
        response.writeHead(200, { 'Content-Type': mime[extname(candidate)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        response.end(await readFile(candidate)); return;
      }
      response.writeHead(404).end();
    } catch { response.writeHead(500).end('Acceptance harness error'); }
  });
  proxy.listen(pilotPort, '127.0.0.1'); await once(proxy, 'listening');
  const baseURL = `http://127.0.0.1:${proxy.address().port}`;
  if (pilot) {
    console.log(`Local synthetic Kitchen pilot: ${baseURL}/__kitchen-pilot`);
    console.log('Disposable test records; no production writes. Stop with SIGINT or SIGTERM.');
    await new Promise((done, reject) => {
      const finish = error => {
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        for (const [child, listener] of watchers) child.off('exit', listener);
        if (error) reject(error); else done();
      };
      const stop = () => finish();
      const watchers = children.map(child => {
        const listener = () => finish(new Error('Owned pilot dependency exited; the pilot has stopped'));
        child.once('exit', listener);
        return [child, listener];
      });
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } else {
    await completed(launch(resolve(root, 'node_modules/.bin/playwright'), ['test', '--config', 'playwright.kitchen.config.ts', ...playwrightArguments], {
      KITCHEN_E2E_BASE_URL: baseURL, KITCHEN_E2E_CUSTOMER_ID: session.customer_id, KITCHEN_E2E_WORKER_ID: session.worker_id,
      KITCHEN_E2E_MANAGER_ID: session.manager_id, KITCHEN_E2E_LEGACY_PROJECT_ID: session.legacy_project_id,
      ...(process.env.KITCHEN_E2E_REPORT ? { KITCHEN_E2E_REPORT: process.env.KITCHEN_E2E_REPORT } : {}),
      ...(process.env.KITCHEN_E2E_OUTPUT ? { KITCHEN_E2E_OUTPUT: process.env.KITCHEN_E2E_OUTPUT } : {}),
    }));
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); }
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), pause(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  }
  await rm(temp, { recursive: true, force: true });
}
