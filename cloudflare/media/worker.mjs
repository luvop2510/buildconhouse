// Public product files only. Never bind forge-private to this Worker.
export default {
  async fetch(request, env) {
    const headers = new Headers({ 'X-Content-Type-Options': 'nosniff' });
    if (!['GET', 'HEAD'].includes(request.method)) {
      headers.set('Allow', 'GET, HEAD');
      return new Response(null, { status: 405, headers });
    }
    let key;
    try { key = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response(null, { status: 400, headers }); }
    if (!key || key.split('/').some(part => ['', '.', '..'].includes(part)) || /[\0\r\n]/.test(key)) {
      return new Response(null, { status: 404, headers });
    }
    if (!env.PUBLIC_MEDIA) return new Response(null, { status: 503, headers });
    try {
      // Range requests may be answered in full with 200; no paid image
      // transformation or upstream request is performed.
      const object = request.method === 'HEAD'
        ? await env.PUBLIC_MEDIA.head(key) : await env.PUBLIC_MEDIA.get(key);
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
