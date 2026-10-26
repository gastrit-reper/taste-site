/* Синхронизация оценок и профиля с аккаунтом. Подключается в самом конце index.html (после всех скриптов).
   Вошли в аккаунт: демо-данные прячутся, профиль строится из таблицы ratings.
   Любые изменения оценок замечаются сами (сравнение до/после) и уходят на сервер через ~1 секунду.
   Три набора данных: demo (гость), acct (ваш аккаунт), other (открытый чужой профиль, собирает social.js).
   Не вошли: сайт работает как раньше (всё в браузере). */
(function () {
  'use strict';
  const AUTH = window.AUTH;
  if (!AUTH || !AUTH.client) return;
  const sb = AUTH.client;
  const NICK = /^[\p{L}\p{N}_]{2,24}$/u;
  const store = { demo: null, acct: null, other: null };
  let cur = 'demo', uid = null, loading = false, timer = null, chain = Promise.resolve(), lastErr = 0;
  const synced = new Map();   // ключ записи -> {sig, tid}: что уже лежит на сервере
  const fails = new Map(), warned = new Set();
  const syncedColl = new Map(), syncedSaves = new Set();   // сборники на сервере: id -> подпись; сохранённые чужие
  let collOk = true, localColl = [];                        // collOk=false: таблиц сборников ещё нет (не выполнен stage11.sql)
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/[x]/g, () => (Math.random() * 16 | 0).toString(16)));

  function release() { document.documentElement.classList.remove('sy-wait'); }   // класс ставит auth.js

  /* ---------- два набора данных ---------- */
  const clearObj = o => { Object.keys(o).forEach(k => delete o[k]); };
  const snapshot = () => ({
    DATA: Object.fromEntries(ORDER.map(k => [k, DATA[k].slice()])),
    EXTRA: { ...EXTRA }, TRK: { ...TRK }, posts: S.posts.slice(), P: JSON.parse(JSON.stringify(P)),
    COLL: COLL.slice(), SAVED: [...SAVED]
  });
  function restore(s) {
    ORDER.forEach(k => { DATA[k] = s.DATA[k].slice(); });
    clearObj(EXTRA); Object.assign(EXTRA, s.EXTRA);
    clearObj(TRK); Object.assign(TRK, s.TRK);
    S.posts = s.posts.slice();
    clearObj(P); Object.assign(P, s.P);
    COLL.length = 0; COLL.push(...s.COLL);
    SAVED.clear(); s.SAVED.forEach(x => SAVED.add(x));
  }
  function blank() {
    ORDER.forEach(k => { DATA[k] = []; });
    clearObj(EXTRA); clearObj(TRK); S.posts = [];
    clearObj(P); Object.assign(P, { nick: '', about: '', links: [], fav: {}, song: '' });
    COLL.length = 0; SAVED.clear();
  }
  function setKeys() {   // куда index.html сохраняет профиль и сборники (PK и COLL_K объявлены там через let)
    PK = cur === 'acct' && uid ? 'prof_profile_' + uid : 'prof_profile';
    COLL_K = cur === 'acct' && uid ? 'prof_coll_' + uid : 'prof_coll';
  }
  function swap(t) { store[cur] = snapshot(); restore(store[t]); cur = t; setKeys(); }
  function ensureView() {   // чужой профиль (S.me=false на странице профиля): открытый человек, иначе ваши данные
    if (!uid || loading || !store.demo) return;
    const profView = S.home === false && S.me === false && !S.page && !S.coll;
    const viewing = window.SOCIAL && SOCIAL.viewing && SOCIAL.viewing();
    const t = profView && viewing && store.other ? 'other' : 'acct';
    if (t !== cur) swap(t);
  }
  const _render = window.render;
  window.render = function () {
    try { ensureView(); } catch (e) { console.error(e); }
    const r = _render.apply(this, arguments);
    if (uid) schedule(900);
    return r;
  };

  /* ---------- загрузка из аккаунта ---------- */
  const daysSince = iso => {
    const a = new Date(); a.setHours(0, 0, 0, 0);
    const b = new Date(iso); b.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((a - b) / 864e5));
  };
  const sigOf = (k, row) => {
    const x = EXTRA[kk(k, row[0])] || {};
    return JSON.stringify([row[2] || 0, row[3] || '', row[4] || '', x.plat || '', x.own || '', x.ed || '', x.runs || 0, x.val || 0, x.mins || 0, x.src || '', x.ach || null, x.journal || {}, !!x.spoiler, !!x.liked]);
  };
  const DET = ['plat', 'own', 'ed', 'runs', 'val', 'mins', 'src', 'ach', 'journal'];
  function detailsOf(x) {
    const d = {};
    DET.forEach(f => {
      const v = x[f];
      if (v === undefined || v === null || v === '' || v === 0) return;
      if (f === 'journal' && !Object.keys(v).length) return;
      d[f] = v;
    });
    return d;
  }
  function addRec(rec, track = true) {
    const t = rec.titles; if (!t) return;
    const key = regLive(t, true); if (!key) return;
    const c = CAT_IDX[key], k = c.k;
    if (!DATA[k] || DATA[k].some(r => r[0] === c.t)) return;
    const row = [c.t, `${c.by} · ${c.y}`, rec.score || 0, rec.status || '', rec.review || '', daysSince(rec.rated_at)];
    DATA[k].push(row);
    const x = { ...(rec.details || {}) };
    if (rec.liked) x.liked = true;
    if (rec.spoiler) x.spoiler = true;
    if (Object.keys(x).length) EXTRA[key] = x;
    if (track) synced.set(key, { sig: sigOf(k, row), tid: t.id });
  }
  async function loadRatings() {
    synced.clear();
    const cols = 'score,status,review,spoiler,liked,details,rated_at,titles(id,source,external_id,category,title,original_title,alt_titles,year,creators,genres,description,cover_url,banner_url,extra)';
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('ratings').select(cols).eq('user_id', uid).order('rated_at', { ascending: false }).order('id').range(from, from + 999);
      if (error) throw error;
      (data || []).forEach(r => addRec(r));
      if (!data || data.length < 1000) break;
    }
  }
  /* ---------- сборники ---------- */
  const TCOLS = 'id,source,external_id,category,title,original_title,alt_titles,year,creators,genres,description,cover_url,banner_url,extra';
  const tidOf = key => { const c = CAT_IDX[key]; return c && c.ext && c.ext.title_id; };
  const collSig = c => JSON.stringify([c.name, c.desc || '', c.items.map(tidOf).filter(Boolean)]);
  const noTable = e => e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message || ''));
  async function titleKeys(ids) {   // номера тайтлов -> ключи каталога сайта
    const out = new Map(), need = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < need.length; i += 150) {
      const { data, error } = await sb.from('titles').select(TCOLS).in('id', need.slice(i, i + 150));
      if (error) throw error;
      (data || []).forEach(t => { const k = regLive(t, true); if (k) out.set(t.id, k); });
    }
    return out;
  }
  const toColl = (row, keys, ownerName) => ({ id: row.id, owner: ownerName, name: row.name, desc: row.descr || '', items: (row.items || []).map(i => keys.get(i)).filter(Boolean) });
  async function nickMap(ids) {
    const m = new Map(), need = [...new Set(ids)];
    if (!need.length) return m;
    const { data } = await sb.from('profiles').select('id,nick').in('id', need);
    (data || []).forEach(p => m.set(p.id, p.nick));
    return m;
  }
  async function loadColls() {
    syncedColl.clear(); syncedSaves.clear();
    const mine = await sb.from('collections').select('id,user_id,name,descr,items').eq('user_id', uid).order('created_at', { ascending: false });
    if (mine.error) { if (noTable(mine.error)) { collOk = false; return; } throw mine.error; }
    const sv = await sb.from('collection_saves').select('collection_id').eq('user_id', uid);
    if (sv.error) throw sv.error;
    const ids = (sv.data || []).map(x => x.collection_id);
    let others = [];
    if (ids.length) { const r = await sb.from('collections').select('id,user_id,name,descr,items').in('id', ids); if (r.error) throw r.error; others = r.data || []; }
    const nicks = await nickMap(others.map(c => c.user_id));
    const keys = await titleKeys([...(mine.data || []), ...others].flatMap(c => c.items || []));
    (mine.data || []).forEach(c => { const o = toColl(c, keys, 'me'); COLL.push(o); syncedColl.set(c.id, collSig(o)); });
    others.forEach(c => { COLL.push(toColl(c, keys, nicks.get(c.user_id) || 'user')); SAVED.add(c.id); syncedSaves.add(c.id); });
  }
  async function syncColls(me, res) {
    if (!collOk) return;
    const mine = COLL.filter(c => c.owner === 'me' && UUID.test(c.id));
    const need = [];
    mine.forEach(c => c.items.forEach(k => { if (CAT_IDX[k] && !tidOf(k) && (fails.get(k) || 0) < 3 && !need.includes(k)) need.push(k); }));
    if (need.length) { await Promise.all(need.map(resolve)); res.again = true; }
    for (const c of mine) {
      const ids = [...new Set(c.items.map(tidOf).filter(Boolean))].slice(0, 300);
      if (!ids.length) continue;
      const sig = collSig(c);
      if (syncedColl.get(c.id) === sig) continue;
      const { error } = await sb.from('collections').upsert({ id: c.id, user_id: me, name: String(c.name).slice(0, 60), descr: String(c.desc || '').slice(0, 200), items: ids }, { onConflict: 'id' });
      if (error) { if (noTable(error)) { collOk = false; return; } res.ok = false; fail(error); continue; }
      syncedColl.set(c.id, sig);
    }
    for (const id of [...syncedColl.keys()]) {
      if (mine.some(c => c.id === id)) continue;
      const { error } = await sb.from('collections').delete().eq('id', id).eq('user_id', me);
      if (error) { res.ok = false; fail(error); continue; }
      syncedColl.delete(id);
    }
    const want = [...SAVED].filter(id => UUID.test(id) && COLL.some(c => c.id === id && c.owner !== 'me'));
    const add = want.filter(id => !syncedSaves.has(id)), del = [...syncedSaves].filter(id => !SAVED.has(id));
    if (add.length) {
      const { error } = await sb.from('collection_saves').upsert(add.map(id => ({ user_id: me, collection_id: id })), { onConflict: 'user_id,collection_id' });
      if (error) { res.ok = false; fail(error); } else add.forEach(id => syncedSaves.add(id));
    }
    if (del.length) {
      const { error } = await sb.from('collection_saves').delete().eq('user_id', me).in('collection_id', del);
      if (error) { res.ok = false; fail(error); } else del.forEach(id => syncedSaves.delete(id));
    }
    if (res.ok && migrated && mine.every(c => syncedColl.has(c.id))) { try { localStorage.removeItem('prof_coll_' + me); } catch (e) {} migrated = false; }
  }
  let migrated = false;
  AUTH.newId = newId;
  AUTH.fetchColls = async function (userId) {   // сборники другого человека (для его профиля); ошибки не мешают открыть профиль
    try {
      if (!collOk) return [];
      const { data, error } = await sb.from('collections').select('id,user_id,name,descr,items').eq('user_id', userId).order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      const keys = await titleKeys((data || []).flatMap(c => c.items || []));
      return (data || []).map(c => toColl(c, keys, 'me'));
    } catch (e) { console.error('collections', e); return []; }
  };
  AUTH.openColl = async function (id) {   // ссылка вида /#c=<номер>: открыть любой сборник
    if (!uid || !UUID.test(id)) return false;
    let c = COLL.find(x => x.id === id);
    if (!c) {
      try {
        const { data, error } = await sb.from('collections').select('id,user_id,name,descr,items').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!data) { toast('Сборник не найден.'); return false; }
        const nicks = await nickMap([data.user_id]);
        const keys = await titleKeys(data.items || []);
        c = toColl(data, keys, data.user_id === uid ? 'me' : (nicks.get(data.user_id) || 'user'));
        if (cur === 'acct') COLL.push(c); else if (store.acct) store.acct.COLL.push(c);
      } catch (e) { console.error(e); toast('Не удалось открыть сборник.'); return false; }
    }
    if (cur !== 'acct') swap('acct');
    S.page = null; S.coll = id; S.cf = 'all'; render(); window.scrollTo(0, 0);
    return true;
  };

  async function enter(user, profile) {
    if (uid === user.id) return;
    loading = true; uid = user.id; AUTH.syncOn = true;
    document.documentElement.classList.add('sy-in');   // шапка «Прототип…» нужна только гостям
    const vo = document.getElementById('v-other'); if (vo) vo.hidden = true;   // «Чужой профиль»-пример нужен только гостям
    store.demo = snapshot();
    blank(); cur = 'acct'; setKeys();
    let sv = {};
    try { sv = JSON.parse(localStorage.getItem('prof_profile_' + uid) || '{}'); } catch (e) {}
    Object.assign(P, { about: sv.about || '', links: sv.links || [], fav: sv.fav || {}, song: sv.song || '' });
    P.nick = profile ? profile.nick : String(user.email || 'user').split('@')[0];
    if (profile) {   // с сервера: что там есть, то главнее; старое из браузера уйдёт на сервер само
      if (profile.about) P.about = profile.about;
      if (profile.links && profile.links.length) P.links = profile.links;
      if (profile.fav && Object.keys(profile.fav).length) P.fav = profile.fav;
      if (profile.song) P.song = profile.song;
    }
    localColl = [];
    try {
      const c = JSON.parse(localStorage.getItem('prof_coll_' + uid) || 'null');
      if (c && c.coll) localColl = c.coll.filter(x => x && x.owner === 'me' && Array.isArray(x.items));
    } catch (e) {}
    try { await loadRatings(); } catch (e) { console.error(e); toast('Не удалось загрузить оценки с сервера. Обновите страницу.'); }
    collOk = true;
    try { await loadColls(); } catch (e) { console.error(e); collOk = false; toast('Не удалось загрузить сборники. Обновите страницу.'); }
    if (collOk && localColl.length) {   // старые сборники из этого браузера уезжают на сервер
      localColl.forEach(c => { if (CAT_IDX[c.items[0]] || c.items.some(k => CAT_IDX[k])) COLL.push({ id: newId(), owner: 'me', name: c.name, desc: c.desc || '', items: c.items.filter(k => CAT_IDX[k]) }); });
      migrated = true; localColl = [];
    }
    loading = false;
    S.view = 'activity'; S.sub = 'all'; S.al = null; S.ar = null;
    release(); render();
    document.dispatchEvent(new CustomEvent('sync-entered'));
    offerMigration();
  }
  function leave() {
    release();
    if (!uid) return;
    clearTimeout(timer);
    if (store.demo) restore(store.demo);
    document.documentElement.classList.remove('sy-in'); uid = null; cur = 'demo'; AUTH.syncOn = false; store.demo = store.acct = store.other = null; synced.clear(); fails.clear(); syncedColl.clear(); syncedSaves.clear(); setKeys();
    const vo = document.getElementById('v-other'); if (vo) vo.hidden = false;
    S.view = 'activity'; S.sub = 'all'; S.al = null; S.ar = null; S.page = null; S.coll = null; S.me = false;
    const vh = document.getElementById('v-home'); if (vh) vh.click(); else render();
  }
  function handle() { if (!AUTH.ready) return; if (AUTH.user) enter(AUTH.user, AUTH.profile); else leave(); }
  document.addEventListener('auth-changed', handle);

  /* ---------- отправка изменений ---------- */
  const isoDays = d => { const x = new Date(); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - (d || 0)); return x.toISOString(); };
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(pass, ms); }
  const pass = () => (chain = chain.then(run).catch(e => { console.error(e); return false; }));
  AUTH.flush = pass;
  function fail(e) {
    console.error('sync', e);
    if (Date.now() - lastErr > 60000) { lastErr = Date.now(); toast('Не удалось сохранить на сервере. Попробую ещё раз чуть позже.'); }
    schedule(20000);
  }
  async function resolve(key) {   // у записи из демо-каталога ещё нет номера в базе: ищем её
    const c = CAT_IDX[key]; if (!c) return false;
    const head = c.t.split(/\s*[:–—]\s*|\s+-\s+/)[0].trim(), tries = [c.t];
    if (head && head !== c.t && head.length >= 2) tries.push(head);
    try {
      for (const q of tries) {
        const r = await fetch(`${APPC.SUPABASE_URL}/functions/v1/search?q=${encodeURIComponent(q)}&cat=${LIVE_CAT[c.k]}`, { headers: liveHeaders() });
        const j = await r.json(); if (!r.ok) throw 0;
        const m = pickMatch(c, j.results);
        if (m) { applyEnr(key, m); saveEnr(); return !!(c.ext && c.ext.title_id); }
      }
    } catch (e) { return false; }   // нет связи: не считаем неудачей
    fails.set(key, (fails.get(key) || 0) + 1);
    return false;
  }
  async function run() {
    let ok = true;
    for (let round = 0; round < 4; round++) {
      if (!uid || cur !== 'acct' || loading) return ok;
      const r = await once();
      ok = r.ok;
      if (!r.again) break;
    }
    return ok;
  }
  async function once() {
    const res = { ok: true, again: false }, me = uid;
    const now = new Map();
    ORDER.forEach(k => DATA[k].forEach(r => now.set(kk(k, r[0]), { k, r })));
    const items = [], need = [];
    for (const [key, { k, r }] of now) {
      const sig = sigOf(k, r), s = synced.get(key);
      if (s && s.sig === sig) continue;
      const c = CAT_IDX[key], tid = c && c.ext && c.ext.title_id;
      if (!tid) {
        res.ok = false;
        if ((fails.get(key) || 0) < 3) need.push(key);
        else if (!warned.has(key)) { warned.add(key); toast('«' + r[0] + '»: не нашёл в каталоге, пока сохранено только в этом браузере.'); }
        continue;
      }
      const x = EXTRA[key] || {};
      items.push({ key, sig, tid, rec: {
        user_id: me, title_id: tid, score: r[2] || 0, status: String(r[3] || '').slice(0, 30), review: String(r[4] || '').slice(0, 2000),
        spoiler: !!x.spoiler, liked: !!x.liked, details: detailsOf(x), rated_at: isoDays(r[5])
      } });
    }
    if (items.length) {
      const recs = [...new Map(items.map(i => [i.tid, i.rec])).values()];
      for (let i = 0; i < recs.length; i += 200) {
        const part = recs.slice(i, i + 200), tids = new Set(part.map(p => p.title_id));
        const { error } = await sb.from('ratings').upsert(part, { onConflict: 'user_id,title_id' });
        if (error) { res.ok = false; fail(error); continue; }
        items.filter(it => tids.has(it.tid)).forEach(it => synced.set(it.key, { sig: it.sig, tid: it.tid }));
      }
    }
    const gone = [...synced].filter(([key]) => !now.has(key));
    for (let i = 0; i < gone.length; i += 100) {
      const part = gone.slice(i, i + 100);
      const { error } = await sb.from('ratings').delete().eq('user_id', me).in('title_id', part.map(g => g[1].tid));
      if (error) { res.ok = false; fail(error); continue; }
      part.forEach(g => synced.delete(g[0]));
    }
    if (need.length) {
      await Promise.all(need.map(resolve)); res.again = true;
      if (need.some(k => !(CAT_IDX[k].ext && CAT_IDX[k].ext.title_id) && (fails.get(k) || 0) < 3)) schedule(30000);   // не было связи: повторим позже
    }
    try { await syncColls(me, res); } catch (e) { console.error(e); res.ok = false; }
    /* ник и «о себе» */
    const pr = AUTH.profile;
    const prSig = p => JSON.stringify([p.nick, p.about || '', p.links || [], p.fav || {}, p.song || '']);
    if (pr && uid === me && cur === 'acct' && P.nick && prSig(P) !== prSig(pr)) {
      if (!NICK.test(P.nick)) { P.nick = pr.nick; }
      else {
        const { data, error } = await sb.from('profiles').update({ nick: P.nick, about: P.about || '', links: (P.links || []).slice(0, 12), fav: P.fav || {}, song: String(P.song || '').slice(0, 300) }).eq('id', me).select('id,nick,about,links,fav,song,created_at').maybeSingle();
        if (error || !data) {
          toast(error && error.code === '23505' ? 'Этот ник уже занят, оставил прежний.' : 'Не удалось сохранить профиль на сервере.');
          P.nick = pr.nick; P.about = pr.about || ''; P.links = pr.links || P.links; P.fav = pr.fav || P.fav; P.song = pr.song || '';
          res.ok = false;
        } else AUTH.setProfile(data);
      }
      try { saveP(); } catch (e) {}
      render();
    }
    return res;
  }
  ['click', 'change', 'input', 'keyup', 'submit'].forEach(ev => document.addEventListener(ev, () => { if (uid) schedule(1200); }, true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && uid) pass(); });

  /* ---------- перенос старого импорта из браузера ---------- */
  const stClass = v => /^(просмотр|прочит|прошё)/i.test(v) ? 'done' : /^(смотр|читаю|играю)/i.test(v) ? 'doing' : /отлож/i.test(v) ? 'hold' : /бросил/i.test(v) ? 'drop' : 'plan';
  function normSt(v, k) {
    const st = (CATS[k] && CATS[k].st) || []; if (!st.length) return '';
    const want = stClass(v), cls = st.map(stClass);
    let i = cls.indexOf(want); if (i < 0 && want === 'hold') i = cls.indexOf('plan'); if (i < 0 && want === 'doing') i = cls.indexOf('done');
    return st[i < 0 ? 0 : i];
  }
  function offerMigration() {
    try { if (localStorage.getItem('mig_skip_' + uid)) return; } catch (e) { return; }
    let all = []; try { all = JSON.parse(localStorage.getItem('imported_v1') || '[]'); } catch (e) {}
    const have = new Set([...synced.values()].map(s => s.tid));
    const todo = all.filter(e => e && e.r && e.r.id && !have.has(e.r.id));
    if (!todo.length) { if (all.length) try { localStorage.removeItem('imported_v1'); } catch (e) {} return; }
    const ov = document.createElement('div'); ov.id = 'sy-ov'; ov.className = 'ov';
    ov.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="sy-h" style="width:min(460px,100%)"><div class="dh"><h2 id="sy-h">Перенести оценки в аккаунт?</h2></div><div class="dr pb"><p style="margin:0">В этом браузере лежит импорт оценок: <b>${todo.length}</b>. Перенести их в ваш аккаунт, чтобы они были на всех устройствах?</p></div><div class="df"><button type="button" class="lnk" id="sy-never" style="margin-right:auto">Не спрашивать</button><button type="button" class="btn" id="sy-later">Не сейчас</button><button type="button" class="btn primary" id="sy-go">Перенести</button></div></div>`;
    document.body.appendChild(ov);
    const $ = id => document.getElementById(id);
    $('sy-later').onclick = () => ov.remove();
    $('sy-never').onclick = () => { try { localStorage.setItem('mig_skip_' + uid, '1'); } catch (e) {} ov.remove(); };
    $('sy-go').onclick = async () => {
      $('sy-go').disabled = true; $('sy-go').textContent = 'Переношу…';
      if (cur !== 'acct') { S.home = true; render(); }
      let added = 0;
      todo.forEach(e => {
        const key = regLive(e.r, true); if (!key) return;
        const c = CAT_IDX[key], k = c.k;
        if (DATA[k].some(x => x[0] === c.t)) return;
        DATA[k].push([c.t, `${c.by} · ${c.y}`, e.score || 0, normSt(e.status, k), e.review || '', e.days || 0]);
        added++;
      });
      render();
      const ok = await pass();
      ov.remove();
      if (ok) { try { localStorage.removeItem('imported_v1'); } catch (e) {} toast('Перенесено в аккаунт: ' + added); }
      else toast('Не всё сохранилось на сервере. Предложу перенести ещё раз при следующем входе.');
    };
  }

  /* ---------- для social.js: чужие профили и свои посты ---------- */
  AUTH.daysSince = daysSince;
  AUTH.setOther = function (prof, recs, posts, colls) {   // собираем данные чужого профиля, не трогая ваши
    const keep = snapshot();
    try {
      blank();
      Object.assign(P, { nick: prof.nick, about: prof.about || '', links: prof.links || [], fav: prof.fav || {}, song: prof.song || '' });
      (recs || []).forEach(r => addRec(r, false));
      S.posts = posts || [];
      (colls || []).forEach(c => COLL.push({ ...c, owner: 'me', items: [...c.items] }));   // в его профиле они «его»
      store.other = snapshot();
      // чтобы сборник открывался (страница сборника идёт на ваших данных), кладём копию в ваш набор под именем автора
      (colls || []).forEach(c => {
        const copy = { ...c, owner: prof.nick, items: [...c.items] }, tgt = cur === 'acct' ? keep.COLL : (store.acct ? store.acct.COLL : keep.COLL);
        if (!tgt.some(x => x.id === c.id)) tgt.push(copy);
      });
    } finally { restore(keep); }
  };
  AUTH.setMyPosts = function (posts) { if (cur === 'acct') S.posts = posts; else if (store.acct) store.acct.posts = posts; };

  document.addEventListener('sync-entered', () => { const m = /^#c=([0-9a-f-]{36})$/i.exec(location.hash); if (m) AUTH.openColl(m[1]); });
  window.addEventListener('hashchange', () => { const m = /^#c=([0-9a-f-]{36})$/i.exec(location.hash); if (m && uid) AUTH.openColl(m[1]); });

  handle();
})();
