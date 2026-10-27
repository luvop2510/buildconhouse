import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { isolateWebModuleGraph } from './isolate-web-module-graph.mjs';

const fixture = async (root, dependencyValue, moduleId) => {
  const jsDirectory = join(root, '_expo', 'static', 'js', 'web');
  await mkdir(jsDirectory, { recursive: true });
  await writeFile(join(jsDirectory, '__common-samehash.js'), `globalThis.dependency=${JSON.stringify(dependencyValue)};`);
  await writeFile(join(jsDirectory, 'entry-samehash.js'), `globalThis.moduleId=${moduleId};globalThis.lazyPath="/_expo/static/js/web/page-samehash.js";`);
  await writeFile(join(jsDirectory, 'page-samehash.js'), 'globalThis.page=true;');
  await writeFile(join(jsDirectory, '__expo-metro-runtime-samehash.js'), 'globalThis.metro=true;');
  await writeFile(join(root, 'index.html'), [
    '<script src="/_expo/static/js/web/__expo-metro-runtime-samehash.js" defer></script>',
    '<script src="/_expo/static/js/web/__common-samehash.js" defer></script>',
    '<script src="/_expo/static/js/web/entry-samehash.js" defer></script>',
    '<link rel="modulepreload" href="/_expo/static/js/web/page-samehash.js">',
    '<script src="https://cdn.example.test/_expo/static/js/web/foreign.js"></script>',
    '<script src="https://[::1]/_expo/static/js/web/ipv6-foreign.js"></script>',
    '<script src="//cdn.example.test/_expo/static/js/web/protocol-relative-foreign.js"></script>',
    '<script src="/api/v1/status"></script>',
  ].join('\n'));
};

const readExport = async (root) => {
  const jsDirectory = join(root, '_expo', 'static', 'js', 'web');
  const names = (await readdir(jsDirectory)).filter((name) => name.endsWith('.js')).sort();
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const jsContents = new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(jsDirectory, name), 'utf8')])));
  return { names, html, jsContents };
};

const createCacheFixture = async (root, id) => {
  const jsDirectory = join(root, '_expo', 'static', 'js', 'web');
  await mkdir(jsDirectory, { recursive: true });
  await writeFile(join(jsDirectory, 'runtime-stable.js'), 'window.fixtureRuntime=true;');
  await writeFile(join(jsDirectory, 'common-stable.js'), 'window.fixtureCommon=true;');
  await writeFile(join(jsDirectory, 'entry-stable.js'), [
    `window.fixtureModule=${JSON.stringify(id)};`,
    'const lazy=document.createElement("script");',
    'lazy.src="/_expo/static/js/web/lazy-stable.js";',
    'document.head.appendChild(lazy);',
  ].join('\n'));
  await writeFile(join(jsDirectory, 'lazy-stable.js'), 'window.fixtureLazyLoaded=window.fixtureModule;');
  await writeFile(join(root, 'index.html'), [
    '<!doctype html><html><head>',
    '<script src="/_expo/static/js/web/runtime-stable.js"></script>',
    '<script src="/_expo/static/js/web/common-stable.js"></script>',
    '<script src="/_expo/static/js/web/entry-stable.js"></script>',
    '</head><body>cache fixture</body></html>',
  ].join(''));
  return isolateWebModuleGraph(root);
};

const verifyWarmBrowserCacheIsolation = async (rootA, rootB) => {
  await createCacheFixture(rootA, 'graph-a');
  await createCacheFixture(rootB, 'graph-b');
  let activeRoot = rootA;
  const requests = new Map();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(await readFile(join(activeRoot, 'index.html')));
      return;
    }
    if (pathname.startsWith('/_expo/static/js/web/')) {
      requests.set(pathname, (requests.get(pathname) || 0) + 1);
      const file = join(activeRoot, '_expo', 'static', 'js', 'web', pathname.slice('/_expo/static/js/web/'.length));
      try {
        const contents = await readFile(file);
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' });
        response.end(contents);
      } catch {
        response.writeHead(404);
        response.end('missing fixture asset');
      }
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.on('requestfailed', (request) => console.error('cache fixture request failed:', request.url(), request.failure()?.errorText));
    page.on('pageerror', (error) => console.error('cache fixture page error:', error.message));
    const appUrl = `http://127.0.0.1:${address.port}/`;
    await page.goto(appUrl);
    await page.waitForFunction(() => window.fixtureLazyLoaded === 'graph-a', null, { timeout: 5000 });
    const firstNames = (await readdir(join(rootA, '_expo', 'static', 'js', 'web'))).sort();
    const firstPaths = firstNames.map((name) => `/_expo/static/js/web/${name}`);
    assert(firstPaths.every((path) => requests.get(path) === 1), 'the warm browser should fetch every graph A asset once');

    await page.goto(appUrl);
    await page.waitForFunction(() => window.fixtureLazyLoaded === 'graph-a', null, { timeout: 5000 });
    assert(firstPaths.every((path) => requests.get(path) === 1), 'a second graph A navigation should reuse the immutable JavaScript HTTP cache');

    activeRoot = rootB;
    await page.goto(appUrl);
    await page.waitForFunction(() => window.fixtureLazyLoaded === 'graph-b', null, { timeout: 5000 });
    const secondNames = (await readdir(join(rootB, '_expo', 'static', 'js', 'web'))).sort();
    const secondPaths = secondNames.map((name) => `/_expo/static/js/web/${name}`);
    assert(secondPaths.every((path) => !firstPaths.includes(path)), 'every graph B JavaScript URL should be new to the warm browser');
    assert(secondPaths.every((path) => requests.get(path) === 1), 'the browser should request each graph B asset from the server once');
    assert(firstPaths.every((path) => requests.get(path) === 1), 'graph A assets should remain served from the browser cache after deployment switches to B');
    assert.equal(await page.evaluate(() => window.fixtureLazyLoaded), 'graph-b', 'the lazy route should execute from the same new graph as the entry bundle');
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};

const roots = [];
try {
  for (let i = 0; i < 3; i += 1) roots.push(await mkdtemp(join(tmpdir(), 'web-module-graph-')));
  await fixture(roots[0], 'dependency-a', 101);
  await fixture(roots[1], 'dependency-b', 202);
  await fixture(roots[2], 'dependency-a', 101);

  const [firstResult, secondResult, repeatResult] = await Promise.all(roots.map((root) => isolateWebModuleGraph(root)));
  const [first, second, repeat] = await Promise.all(roots.map(readExport));

  assert.equal(firstResult.files, 4);
  assert.equal(firstResult.digest, repeatResult.digest, 'the same source graph should have a deterministic digest');
  assert.deepEqual(first.names, repeat.names, 'the same source graph should produce the same filenames');
  assert.notEqual(firstResult.digest, secondResult.digest, 'dependency bytes and module IDs must change the shared graph key');
  assert.equal(first.names.length, 4, 'all emitted files should be stamped in place without unstamped duplicates');
  assert(first.names.every((name) => name.includes(`-g${firstResult.digest}.js`)));
  assert(second.names.every((name) => name.includes(`-g${secondResult.digest}.js`)));
  assert(first.names.every((name) => second.names.includes(name.replace(`-g${firstResult.digest}`, `-g${secondResult.digest}`))));

  const expectedReferences = [
    '__expo-metro-runtime-samehash',
    '__common-samehash',
    'entry-samehash',
    'page-samehash',
  ].map((base) => `/_expo/static/js/web/${base}-g${firstResult.digest}.js`);
  for (const reference of expectedReferences) {
    assert(first.html.includes(reference), `HTML must reference stamped asset ${reference}`);
  }
  const entry = [...first.jsContents].find(([name]) => name.startsWith('entry-samehash-'))?.[1];
  assert(entry?.includes(expectedReferences[3]), 'lazy module paths must use the same graph digest as entry and common bundles');
  assert(first.html.includes('https://cdn.example.test/_expo/static/js/web/foreign.js'), 'foreign URLs must remain unchanged');
  assert(first.html.includes('https://[::1]/_expo/static/js/web/ipv6-foreign.js'), 'IPv6 foreign URLs must remain unchanged');
  assert(first.html.includes('//cdn.example.test/_expo/static/js/web/protocol-relative-foreign.js'), 'protocol-relative foreign URLs must remain unchanged');
  assert(first.html.includes('/api/v1/status'), 'API URLs must remain unchanged');
  assert.equal(repeat.html, first.html, 'HTML rewrites should be deterministic');

  const cacheRootA = await mkdtemp(join(tmpdir(), 'web-module-cache-a-'));
  const cacheRootB = await mkdtemp(join(tmpdir(), 'web-module-cache-b-'));
  roots.push(cacheRootA, cacheRootB);
  await verifyWarmBrowserCacheIsolation(cacheRootA, cacheRootB);

  const brokenRoot = await mkdtemp(join(tmpdir(), 'web-module-graph-missing-'));
  roots.push(brokenRoot);
  await fixture(brokenRoot, 'broken', 303);
  await writeFile(join(brokenRoot, '_expo', 'static', 'js', 'web', 'entry-samehash.js'), '"/_expo/static/js/web/missing.js";');
  await assert.rejects(isolateWebModuleGraph(brokenRoot), /references missing Expo web JavaScript asset/);
  assert((await readdir(join(brokenRoot, '_expo', 'static', 'js', 'web'))).includes('entry-samehash.js'), 'validation failure must not rename output files');

  console.log('web module graph isolation tests passed');
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
