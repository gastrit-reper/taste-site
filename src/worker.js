const IMG = /^\/img\/(w92|w154|w185|w342|w500|w780|w1280|original)\/([A-Za-z0-9_-]+\.(?:jpg|png))$/;

export default {
  async fetch(request, env) {
    const m = new URL(request.url).pathname.match(IMG);
    if (!m) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const up = await fetch(`https://image.tmdb.org/t/p/${m[1]}/${m[2]}`, {
      cf: { cacheEverything: true, cacheTtl: 2592000 },
    });
    if (!up.ok) return new Response('not found', { status: 404 });
    return new Response(up.body, {
      headers: {
        'Content-Type': up.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=2592000, immutable',
      },
    });
  },
};
