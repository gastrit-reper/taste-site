// Отдаёт статический сайт (папка public) и проксирует картинки:
//   /img/<размер>/<файл>.jpg      - TMDB (фильмы, сериалы, аниме)
//   /img/ol/<S|M|L>/<id>.jpg      - Open Library (обложки книг)
//   /img/caa/<mbid>/<250|500|1200>.jpg - Cover Art Archive (обложки альбомов)
//   /img/rawg/<420|640|1280>/<путь>.jpg - RAWG (картинки игр: уменьшенная копия, при неудаче оригинал)
const TMDB_IMG = /^\/img\/(w92|w154|w185|w342|w500|w780|w1280|original)\/([A-Za-z0-9_-]+\.(?:jpg|png))$/;
const OL_IMG = /^\/img\/ol\/(S|M|L)\/(\d{1,12})\.jpg$/;
const RAWG_IMG = /^\/img\/rawg\/(420|640|1280)\/((?:games|screenshots)\/[0-9a-f]{2,3}\/[0-9a-f]{32}\.jpg)$/;
const CAA_IMG = /^\/img\/caa\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(250|500|1200)\.jpg$/;

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    let upstream = null;

    let m = path.match(TMDB_IMG);
    if (m) upstream = `https://image.tmdb.org/t/p/${m[1]}/${m[2]}`;
    if (!upstream && (m = path.match(OL_IMG))) upstream = `https://covers.openlibrary.org/b/id/${m[2]}-${m[1]}.jpg?default=false`;
    let fallback = null;
    if (!upstream && (m = path.match(RAWG_IMG))) {
      upstream = `https://media.rawg.io/media/resize/${m[1]}/-/${m[2]}`;
      fallback = `https://media.rawg.io/media/${m[2]}`;
    }
    if (!upstream && (m = path.match(CAA_IMG))) upstream = `https://coverartarchive.org/release-group/${m[1]}/front-${m[2]}`;

    if (!upstream) return env.ASSETS.fetch(request);       // всё остальное - обычные файлы сайта
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const get = (u) => fetch(u, { cf: { cacheEverything: true, cacheTtl: 2592000 } });
    let up = await get(upstream);
    if (!up.ok && fallback) up = await get(fallback);
    if (!up.ok) return new Response('not found', { status: 404 });
    return new Response(up.body, {
      headers: {
        'Content-Type': up.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=2592000, immutable',
      },
    });
  },
};
