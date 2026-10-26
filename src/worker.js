// Отдаёт статический сайт (папка public) и проксирует картинки:
//   /img/<размер>/<файл>.jpg      - TMDB (фильмы, сериалы, аниме)
//   /img/ol/<S|M|L>/<id>.jpg      - Open Library (обложки книг)
//   /img/dz/<md5>/<250|500|1000>.jpg - Deezer (обложки альбомов)
//   /img/caa/<mbid>/<250|500|1200>.jpg - Cover Art Archive (обложки альбомов)
//   /img/steam/<appid>.jpg        - вертикальная обложка игры из Steam (600x900)
//   /img/steam/hero/<appid>.jpg   - широкий баннер игры из Steam
//   /img/ss/<appid>/<ss_хеш.600x338|1920x1080>.jpg - скриншоты игры из Steam
//   /api/music/search?q=...        - поиск песен (Deezer), для музыки в профиле
//   /media/<id>/<avatar|banner>-<код>.<png|jpg|gif|webp> - аватары и баннеры из Supabase Storage
//   /audio/dz/<id>.mp3            - 30-секундный фрагмент песни (Deezer), отдаётся через наш сайт
//   /img/rawg/<420|640|1280>/<путь>.jpg - RAWG (картинки игр: уменьшенная копия, при неудаче оригинал)
const TMDB_IMG = /^\/img\/(w92|w154|w185|w342|w500|w780|w1280|original)\/([A-Za-z0-9_-]+\.(?:jpg|png))$/;
const OL_IMG = /^\/img\/ol\/(S|M|L)\/(\d{1,12})\.jpg$/;
const RAWG_IMG = /^\/img\/rawg\/(420|640|1280)\/((?:games|screenshots)\/[0-9a-f]{2,3}\/[0-9a-f]{32}\.jpg)$/;
const STEAM_HERO = /^\/img\/steam\/hero\/(\d{1,9})\.jpg$/;
const STEAM_IMG = /^\/img\/steam\/(\d{1,9})\.jpg$/;
const SS_IMG = /^\/img\/ss\/(\d{1,9})\/(ss_[0-9a-f]{40}\.(?:600x338|1920x1080))\.jpg$/;
const DZ_IMG = /^\/img\/dz\/([0-9a-f]{32})\/(250|500|1000)\.jpg$/;
const CAA_IMG = /^\/img\/caa\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(250|500|1200)\.jpg$/;

// адрес проекта Supabase (тот же, что в config.js); картинки профиля отдаём через свой сайт, чтобы работало и без VPN
const SUPABASE_URL = 'https://kdcbtdypmcqwjeskctat.supabase.co';
const MEDIA_IMG = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/((?:avatar|banner)-[a-z0-9]{1,16}\.(?:png|jpg|gif|webp))$/;
const DZ_AUDIO = /^\/audio\/dz\/(\d{1,12})\.mp3$/;
const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' };

async function musicSearch(url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (q.length < 2) return new Response(JSON.stringify({ results: [] }), { headers: JSON_H });
  const u = new URL('https://api.deezer.com/search/track');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '10');
  try {
    const r = await fetch(u, { cf: { cacheEverything: true, cacheTtl: 3600 } });
    if (!r.ok) throw new Error('deezer ' + r.status);
    const j = await r.json();
    const results = (j.data || []).filter((t) => t && t.id && t.preview).map((t) => ({
      id: t.id, t: t.title_short || t.title, a: t.artist && t.artist.name || '', al: t.album && t.album.title || '', c: t.album && t.album.md5_image || '',
    }));
    return new Response(JSON.stringify({ results }), { headers: JSON_H });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}

// ссылка на фрагмент у Deezer живёт недолго, поэтому каждый раз берём свежую и отдаём звук через наш сайт (с поддержкой Range)
async function musicAudio(request, id) {
  try {
    const r = await fetch(`https://api.deezer.com/track/${id}`);
    const j = await r.json();
    const src = j && j.preview;
    if (!src || !/^https:\/\/[a-z0-9.-]+\.dzcdn\.net\//.test(src)) return new Response('not found', { status: 404 });
    const h = {};
    const range = request.headers.get('Range');
    if (range) h.Range = range;
    const up = await fetch(src, { headers: h });
    if (!up.ok && up.status !== 206) return new Response('not found', { status: 404 });
    const out = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };
    ['Content-Length', 'Content-Range'].forEach((k) => { const v = up.headers.get(k); if (v) out[k] = v; });
    return new Response(request.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
  } catch (e) {
    return new Response('unavailable', { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/api/music/search' && request.method === 'GET') return musicSearch(url);
    const am = path.match(DZ_AUDIO);
    if (am && (request.method === 'GET' || request.method === 'HEAD')) return musicAudio(request, am[1]);
    let upstream = null;

    let m = path.match(TMDB_IMG);
    if (m) upstream = `https://image.tmdb.org/t/p/${m[1]}/${m[2]}`;
    if (!upstream && (m = path.match(OL_IMG))) upstream = `https://covers.openlibrary.org/b/id/${m[2]}-${m[1]}.jpg?default=false`;
    let fallback = null;
    if (!upstream && (m = path.match(STEAM_HERO))) upstream = `https://cdn.cloudflare.steamstatic.com/steam/apps/${m[1]}/library_hero.jpg`;
    if (!upstream && (m = path.match(STEAM_IMG))) upstream = `https://cdn.cloudflare.steamstatic.com/steam/apps/${m[1]}/library_600x900.jpg`;
    if (!upstream && (m = path.match(RAWG_IMG))) {
      upstream = `https://media.rawg.io/media/resize/${m[1]}/-/${m[2]}`;
      fallback = `https://media.rawg.io/media/${m[2]}`;
    }
    let fallback2 = null;
    if (!upstream && (m = path.match(SS_IMG))) {   // у новых игр скриншоты лежат в store_item_assets, у старых - в steam/apps
      upstream = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${m[1]}/${m[2]}.jpg`;
      fallback = `https://cdn.cloudflare.steamstatic.com/steam/apps/${m[1]}/${m[2]}.jpg`;
      fallback2 = `https://cdn.akamai.steamstatic.com/steam/apps/${m[1]}/${m[2]}.jpg`;
    }
    if (!upstream && (m = path.match(MEDIA_IMG))) upstream = `${SUPABASE_URL}/storage/v1/object/public/media/${m[1]}/${m[2]}`;
    if (!upstream && (m = path.match(DZ_IMG))) upstream = `https://cdn-images.dzcdn.net/images/cover/${m[1]}/${m[2]}x${m[2]}-000000-80-0-0.jpg`;
    if (!upstream && (m = path.match(CAA_IMG))) upstream = `https://coverartarchive.org/release-group/${m[1]}/front-${m[2]}`;

    if (!upstream) return env.ASSETS.fetch(request);       // всё остальное - обычные файлы сайта
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });

    const get = (u) => fetch(u, { cf: { cacheEverything: true, cacheTtl: 2592000 } });
    let up = await get(upstream);
    if (!up.ok && fallback) up = await get(fallback);
    if (!up.ok && fallback2) up = await get(fallback2);
    if (!up.ok) return new Response('not found', { status: 404 });
    return new Response(up.body, {
      headers: {
        'Content-Type': up.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=2592000, immutable',
      },
    });
  },
};
