import assert from 'node:assert/strict';
import worker from '../cloudflare/media/worker.mjs';

const requests = [];
const bucket = {
  async get(key) {
    requests.push(key);
    if (key === 'missing') return null;
    return { body: new Blob(['image']).stream(), size: 5, httpEtag: '"verified"',
      writeHttpMetadata(headers) { headers.set('Content-Type', 'image/png'); } };
  },
  async head(key) { const { body, ...head } = await this.get(key); await body.cancel(); return head; },
};
const env = { PUBLIC_MEDIA: bucket };
const fetch = (path, options) => worker.fetch(new Request('https://media.test/' + path, options), env);
const image = await fetch('brand/a%20b.png');
assert.equal(image.status, 200);
assert.equal(await image.text(), 'image');
assert.equal(requests.at(-1), 'brand/a b.png');
assert.equal(image.headers.get('Content-Type'), 'image/png');
assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
const unchanged = await fetch('brand/a.png', { headers: { 'If-None-Match': 'W/"verified"' } });
assert.equal(unchanged.status, 304);
assert.equal(await unchanged.text(), '');
assert.equal(unchanged.headers.has('Content-Length'), false);
const head = await fetch('a.png', { method: 'HEAD' });
assert.equal(head.headers.get('Content-Length'), '5');
assert.equal(await head.text(), '');
assert.equal((await fetch('missing')).status, 404);
for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) assert.equal((await fetch('a', { method })).status, 405);
const before = requests.length;
for (const path of ['', 'a//b', '%00', '%ZZ', '%2E%2E%2Fbackup']) {
  assert.ok([400, 404].includes((await fetch(path)).status));
}
assert.equal(requests.length, before);
assert.equal((await worker.fetch(new Request('https://media.test/a'), {})).status, 503);
console.log('R2 media Worker: read-only delivery, ETag, HEAD, missing files and unsafe paths pass.');
