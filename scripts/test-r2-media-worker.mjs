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

const variantReads = [];
const files = new Map([
  ['brand/original.png', ['original-png-data', 'image/png', '"original"']],
  ['_image_variants/v1/w320/brand/original.png.webp', ['webp', 'image/webp', '"thumbnail"']],
]);
const variants = {
  async get(key) {
    variantReads.push(key);
    const file = files.get(key); if (!file) return null;
    return { body: new Blob([file[0]]).stream(), size: file[0].length, httpEtag: file[2],
      writeHttpMetadata(headers) { headers.set('Content-Type', file[1]); } };
  },
  async head(key) { const object = await this.get(key); if (!object) return null; await object.body.cancel(); return object; },
};
const sized = (query, options) => worker.fetch(new Request(`https://media.test/brand/original.png${query}`, options), { PUBLIC_MEDIA: variants });
const thumb = await sized('?width=320');
assert.equal(thumb.headers.get('Content-Type'), 'image/webp');
assert.equal(thumb.headers.get('Content-Length'), '4');
assert.equal(await thumb.text(), 'webp');
assert.equal(variantReads.length, 1, 'Existing derivative needs one R2 read');
const fallback = await sized('?width=640');
assert.equal(fallback.headers.get('Content-Type'), 'image/png');
assert.equal(await fallback.text(), 'original-png-data');
assert.deepEqual(variantReads.slice(-2), ['_image_variants/v1/w640/brand/original.png.webp', 'brand/original.png']);
const variantHead = await sized('?width=320', { method: 'HEAD' });
assert.equal(variantHead.headers.get('Content-Length'), '4');
assert.equal(await variantHead.text(), '');
assert.equal((await sized('?width=320', { headers: { 'If-None-Match': '"thumbnail"' } })).status, 304);
assert.equal((await sized('?width=320', { headers: { 'If-None-Match': '"original"' } })).status, 200, 'Original ETag is not a derivative match');
const beforeInvalid = variantReads.length;
for (const width of ['0', '-1', '500000', '640/../a', 'unknown']) assert.equal((await sized(`?width=${encodeURIComponent(width)}`)).status, 400);
assert.equal(variantReads.length, beforeInvalid);
assert.equal(await (await sized('')).text(), 'original-png-data', 'Zoom/export URL remains original');
console.log('R2 WebP sizes, original fallback, ETag/HEAD and bounded size inputs pass.');
