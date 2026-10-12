import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createWorker } from './web-worker.mjs';

// Local release preview uses the same cookie/CSRF boundary as the hosted app.
const root = resolve('dist/client');
const port = Number(process.env.LOCAL_PORT || 8090);
const worker = createWorker(process.env.BACKEND_URL || 'http://127.0.0.1:8010');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const env = { ASSETS: { async fetch(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
  for (const candidate of [target, `${target}.html`, resolve(target, 'index.html')]) {
    if (!(await stat(candidate).catch(() => null))?.isFile()) continue;
    return new Response(await readFile(candidate), { headers: { 'Content-Type': types[extname(candidate)] || 'application/octet-stream', 'Cache-Control': 'no-store' } });
  }
  return new Response('Not found', { status: 404 });
} } };
createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, `http://127.0.0.1:${port}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(url, { method: incoming.method, headers, ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: incoming, duplex: 'half' } : {}) });
    const response = await worker.fetch(request, env);
    const responseHeaders = Object.fromEntries(response.headers);
    // Node's fetch transparently decompresses upstream responses but may
    // preserve the upstream Content-Encoding header. Sending that header with
    // the decoded body makes browsers fail while consuming otherwise healthy
    // API responses (for example /settings/floor-access).
    delete responseHeaders['content-encoding'];
    delete responseHeaders['content-length'];
    const cookies = response.headers.getSetCookie();
    if (cookies.length) responseHeaders['set-cookie'] = cookies;
    outgoing.writeHead(response.status, responseHeaders);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ detail: 'Local preview request failed' }));
  }
}).listen(port, '127.0.0.1', () => console.log(`Local app: http://127.0.0.1:${port}`));
