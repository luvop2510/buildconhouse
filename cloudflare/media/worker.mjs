// Public product files only. Never bind forge-private to this Worker.
export default {
  async fetch(request, env) {
    const headers = new Headers({ 'X-Content-Type-Options': 'nosniff' });
    if (!['GET', 'HEAD'].includes(request.method)) {
      headers.set('Allow', 'GET, HEAD');
      return new Response(null, { status: 405, headers });
    }
    let key;
    const url = new URL(request.url);
    try { key = decodeURIComponent(url.pathname.slice(1)); }
    catch { return new Response(null, { status: 400, headers }); }
    if (!key || key.startsWith('_image_variants/') || key.split('/').some(part => ['', '.', '..'].includes(part)) || /[\0\r\n]/.test(key)) {
      return new Response(null, { status: 404, headers });
    }
    if (!env.PUBLIC_MEDIA) return new Response(null, { status: 503, headers });
    const width = url.searchParams.get('width');
    if (width !== null && !['320', '640', '1024', '1600', '2048'].includes(width)) {
      return new Response(null, { status: 400, headers });
    }
    try {
      // Range requests may be answered in full with 200; no paid image
      // transformation or upstream request is performed.
      const read = key => request.method === 'HEAD' ? env.PUBLIC_MEDIA.head(key) : env.PUBLIC_MEDIA.get(key);
      // Derivatives are generated at ingestion/backfill, never on a read.
      // The URL contains the size, so separate representations have distinct
      // browser/CDN keys. Missing derivatives safely serve the exact original.
      // A leftover copy cannot keep a deleted source publicly available.
      if (width && !await env.PUBLIC_MEDIA.head(key)) return new Response(null, { status: 404, headers });
      let object = width ? await read(`_image_variants/v1/w${width}/${key}.webp`) : null;
      if (!object) object = await read(key);
      if (!object) return new Response(null, { status: 404, headers });
      object.writeHttpMetadata(headers);
      headers.set('ETag', object.httpEtag);
      headers.set('Cache-Control', 'public, max-age=3600');
      headers.set('Content-Length', String(object.size));
      const noneMatch = request.headers.get('If-None-Match');
      if (noneMatch && (noneMatch === '*' || noneMatch.split(',').some(tag => tag.trim().replace(/^W\//, '') === object.httpEtag))) {
        if (object.body) await object.body.cancel();
        headers.delete('Content-Length');
        return new Response(null, { status: 304, headers });
      }
      return new Response(request.method === 'HEAD' ? null : object.body, { headers });
    } catch {
      return new Response(null, { status: 503, headers });
    }
  },
};
