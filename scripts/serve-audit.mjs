import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

// Serve the actual release export. This server deliberately has no API proxy:
// browser journeys must intercept requests and can never write to production.
const root = resolve('dist/client');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ detail: 'Audit API request was not intercepted.' }));
      return;
    }
    const target = resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    // Dynamic Expo routes are resolved by the client router from index.html.
    const candidates = [target, `${target}.html`, resolve(target, 'index.html'), resolve(root, 'index.html')];
    for (const candidate of candidates) {
      if (!(await stat(candidate).catch(() => null))?.isFile()) continue;
      response.writeHead(200, { 'Content-Type': types[extname(candidate)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(await readFile(candidate));
      return;
    }
    response.writeHead(404).end('Build the release export before running the browser audit.');
  } catch {
    response.writeHead(400).end('Invalid request');
  }
}).listen(Number(process.env.AUDIT_PORT || 8090), '127.0.0.1', () => {
  console.log(`Release audit server: http://127.0.0.1:${process.env.AUDIT_PORT || 8090}`);
});
