/* Друзья, посты и чужие профили на сервере. Подключается после sync.js.
   Модель друзей: заявка = подписка (follows: я -> он). Если он подписан в ответ, вы друзья (взаимная подписка).
   Пока он не принял, вы просто его подписчик и видите его открытые посты.
   index.html вызывает window.SOCIAL (если он есть и SOCIAL.on()). Не вошли: SOCIAL.on() = false, сайт работает как раньше. */
(function () {
  'use strict';
  const AUTH = window.AUTH;
  if (!AUTH || !AUTH.client) return;
  const sb = AUTH.client;
  const SO = window.SOCIAL = {};
  const PCOLS = 'id,nick,about,links,fav,song,avatar,banner,created_at';
  const PCOLS0 = 'id,nick,about,links,fav,song,created_at';
  const RCOLS = 'id,user_id,score,status,review,spoiler,liked,details,rated_at,titles(id,source,external_id,category,title,original_title,alt_titles,year,creators,genres,description,cover_url,banner_url,extra)';
  const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
  const escLike = s => String(s).replace(/[\\%_]/g, '\\$&');
  const myId = () => (AUTH.user && AUTH.user.id) || null;

  let rel = new Map();            // id -> {nick, i: я подписан, t: он подписан на меня}
  const byNick = new Map();       // ник в нижнем регистре -> {id, nick}: все, кого мы уже видели
  let viewing = null;             // открытый чужой профиль
  let events = [], loadSeq = 0, lastLoad = 0, errShown = false;

  const nickById = new Map();
  const addNick = (nick, id) => { if (nick) { byNick.set(String(nick).toLowerCase(), { id: id || (byNick.get(String(nick).toLowerCase()) || {}).id, nick }); if (id) { nickById.set(id, nick); wantAvatar(id); } } };
  /* аватары других людей: подгружаем одним запросом по мере того, как узнаём новых людей */
  const avAsked = new Set(); let avPend = [], avT = null, avDead = false;
  function wantAvatar(id) { if (avDead || !id || avAsked.has(id) || (AUTH.user && id === AUTH.user.id)) return; avAsked.add(id); avPend.push(id); clearTimeout(avT); avT = setTimeout(fetchAv, 200); }
  function setAv(nick, a) { if (!nick || !a || !a.p || !AUTH.mediaIn) return false; const o = AUTH.mediaIn(a); (window.AVMAP || (window.AVMAP = {}))[String(nick).toLowerCase()] = o; return true; }
  async function fetchAv() {
    const ids = avPend.splice(0); let any = false;
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const { data, error } = await sb.from('profiles').select('id,nick,avatar').in('id', ids.slice(i, i + 100));
        if (error) { avDead = true; return; }
        (data || []).forEach(p => { if (setAv(p.nick, p.avatar)) any = true; });
      } catch (e) { return; }
    }
    if (any && SO.on()) SO.safeRender && SO.safeRender();
  }
  const state = id => { const r = rel.get(id) || {}; return r.i && r.t ? 'friend' : r.i ? 'sent' : r.t ? 'incoming' : 'none'; };
  const stClass = v => /^(просмотр|прочит|прошё)/i.test(v) ? 'done' : /^(смотр|читаю|играю)/i.test(v) ? 'doing' : /отлож/i.test(v) ? 'hold' : /бросил/i.test(v) ? 'drop' : 'plan';
  const mapPost = p => ({ t: p.body, d: AUTH.daysSince(p.created_at), id: p.id, vis: p.visibility });
  const avatarOf = n => window.avaHtml ? avaHtml(n, 'hm-av', 'width:30px;height:30px;font-size:13px') : `<span class="hm-av" style="background:hsl(${hue(n)} 45% 42%);width:30px;height:30px;font-size:13px">${esc(n[0].toUpperCase())}</span>`;

  const st = document.createElement('style');
  st.textContent = '.so-row{display:flex;align-items:center;gap:8px;padding:6px 0}.so-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;border:0;text-align:left;padding:0;font-weight:500;cursor:pointer;color:inherit}.so-nm:hover{text-decoration:underline}.so-b{display:flex;gap:6px}.so-b .btn{padding:4px 10px;font-size:13px}.hm-who{cursor:pointer}.hm-who:hover{text-decoration:underline}.friend[data-user]{cursor:pointer}.cvis{max-width:150px}a.mention.user{text-decoration:none}.so-pbar{display:flex;gap:4px;margin-top:6px}.so-act{display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--muted);padding:4px 8px;border-radius:8px;cursor:pointer;font:inherit}.so-act:hover{background:var(--surface2)}.so-act svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linejoin:round}.so-act[aria-pressed="true"]{color:var(--accent)}.so-act[aria-pressed="true"] svg{fill:currentColor}.so-cm{border-top:1px solid var(--line);margin-top:8px;padding-top:8px;display:grid;gap:8px}.so-c{display:flex;gap:8px}.so-ct{min-width:0;flex:1}.so-ct p{margin:2px 0 0;overflow-wrap:anywhere}.so-cf{display:flex;gap:8px;align-items:flex-end}.so-cf textarea{flex:1;min-width:0;resize:vertical;background:var(--surface2);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:8px;font:inherit}';
  document.head.appendChild(st);

  /* ---------- что видит index.html ---------- */
  SO.on = () => !!AUTH.syncOn;
  SO.viewing = () => viewing;
  SO.known = n => byNick.has(String(n).toLowerCase());
  SO.nicks = () => [...byNick.values()].map(x => x.nick);
  SO.events = () => events;
  SO.visSel = () => {
    if (!SO.on()) return '';
    const d = (typeof ST !== 'undefined' && ST.pvis) || 'all';
    return `<select class="ssel cvis" aria-label="Кто видит пост" title="Кто видит пост"><option value="all" ${d === 'all' ? 'selected' : ''}>Видят все</option><option value="friends" ${d === 'friends' ? 'selected' : ''}>Только друзья</option></select>`;
  };
  SO.since = () => {
    const iso = S.me === false ? (viewing && viewing.created_at) : (AUTH.profile && AUTH.profile.created_at);
    if (!iso) return '';
    const d = new Date(iso);
    return `с нами с ${MON[d.getMonth()]} ${d.getFullYear()}`;
  };
  SO.headBtns = () => {
    const s = viewing ? state(viewing.id) : 'none', msg = `<button class="btn" id="b-msg">${ico('mail')}Написать</button>`;
    if (s === 'friend') return `<button class="btn on" id="b-friend" title="Нажмите, чтобы убрать из друзей">${ico('check')}В друзьях</button>${msg}`;
    if (s === 'sent') return `<button class="btn" id="b-friend" title="Нажмите, чтобы отменить заявку">${ico('check')}Заявка отправлена</button>${msg}`;
    if (s === 'incoming') return `<button class="btn primary" id="b-friend">${ico('check')}Принять заявку</button><button class="btn" id="b-decl">Отклонить</button>${msg}`;
    return `<button class="btn primary" id="b-friend">${ico('userplus')}Добавить в друзья</button>${msg}`;
  };
  SO.sideHtml = () => {
    const all = [...rel].filter(([, r]) => r.nick);
    const reqs = all.filter(([, r]) => r.t && !r.i), fr = all.filter(([, r]) => r.i && r.t), sent = all.filter(([, r]) => r.i && !r.t).length;
    const row = (n, extra = '') => `<div class="so-row">${avatarOf(n)}<button type="button" class="so-nm" data-user="${esc(n)}">${esc(n)}</button>${extra}</div>`;
    let h = '';
    if (reqs.length) h += `<section class="card"><h3>Заявки в друзья · ${reqs.length}</h3>${reqs.map(([id, r]) => row(r.nick, `<span class="so-b"><button type="button" class="btn primary" data-sacc="${esc(id)}">Принять</button><button type="button" class="btn" data-sdec="${esc(id)}">Нет</button></span>`)).join('')}</section>`;
    h += `<section class="card"><h3>Друзья${fr.length ? ' · ' + fr.length : ''}</h3>${fr.length ? fr.map(([, r]) => row(r.nick)).join('') : '<div class="sub">Пока никого. Найдите человека по нику через поиск вверху.</div>'}${sent ? `<div class="sub" style="margin-top:6px">Ждут ответа: ${sent}</div>` : ''}</section>`;
    return h;
  };
  SO.renderFriends = () => {
    const fc = document.getElementById('fcount'), fe = document.getElementById('friends');
    if (!fc || !fe) return;
    if (S.me === false) { fc.textContent = ''; fe.innerHTML = '<div class="sub">Список друзей виден только владельцу.</div>'; return; }
    const fr = [...rel].filter(([, r]) => r.i && r.t && r.nick);
    fc.textContent = String(fr.length);
    fe.innerHTML = fr.length ? fr.slice(0, 12).map(([, r]) => `<div class="friend" data-user="${esc(r.nick)}">${window.avaHtml ? avaHtml(r.nick, 'av') : `<div class="av" style="background:hsl(${hue(r.nick)} 50% 45%)">${esc(r.nick[0].toUpperCase())}</div>`}<span>${esc(r.nick)}</span></div>`).join('') : '<div class="sub">Пока никого.</div>';
  };

  /* ---------- поиск людей (общий поиск сверху и @ в постах) ---------- */
  const pcache = new Map(), pending = new Set(); let ptimer = null;
  function fetchPeople(q) {
    if (pending.has(q)) return;
    clearTimeout(ptimer);
    ptimer = setTimeout(async () => {
      pending.add(q);
      try {
        const { data, error } = await sb.from('profiles').select('id,nick').ilike('nick', '%' + escLike(q) + '%').limit(8);
        if (error) throw error;
        pcache.set(q, data || []);
        (data || []).forEach(p => addNick(p.nick, p.id));
        const pop = document.getElementById('gs-pop');
        if (pop && !pop.hidden && typeof gsDraw === 'function') gsDraw();
      } catch (e) { console.error(e); } finally { pending.delete(q); }
    }, 250);
  }
  SO.people = q => {
    q = norm(q).trim();
    const out = [], seen = new Set(), mine = AUTH.profile && AUTH.profile.nick;
    const push = (id, nick) => {
      if (seen.has(nick.toLowerCase())) return; seen.add(nick.toLowerCase());
      const s = nick === mine ? 'me' : state(id);
      out.push({ id: 'u:' + nick, ava: nick, t: nick, sub: s === 'me' ? 'Это вы' : s === 'friend' ? 'Друг' : s === 'sent' ? 'Заявка отправлена' : s === 'incoming' ? 'Хочет дружить' : 'Пользователь', go: () => openUser(nick) });
    };
    byNick.forEach(v => { if (v.nick && norm(v.nick).includes(q)) push(v.id, v.nick); });
    const c = pcache.get(q);
    if (c) c.forEach(p => push(p.id, p.nick)); else if (q.length >= 2) fetchPeople(q);
    return out;
  };

  /* ---------- загрузка ---------- */
  function safeRender() {   // не затираем недописанный пост
    const ct = document.getElementById('ct');
    if (ct && ct.textContent.trim()) return;
    if ([...document.querySelectorAll('.so-cf textarea')].some(t => t.value.trim())) return;
    render();
  }
  async function load(quiet) {
    const seq = ++loadSeq, uid = myId();
    if (!uid) return;
    try {
      const { data: f, error: e1 } = await sb.from('follows').select('follower_id,followee_id');
      if (e1) throw e1;
      const m = new Map();
      (f || []).forEach(x => {
        const mineRow = x.follower_id === uid, other = mineRow ? x.followee_id : x.follower_id, r = m.get(other) || { i: false, t: false };
        if (mineRow) r.i = true; else r.t = true;
        m.set(other, r);
      });
      const ids = [...m.keys()];
      if (ids.length) {
        const { data: pr, error } = await sb.from('profiles').select('id,nick').in('id', ids);
        if (error) throw error;
        (pr || []).forEach(p => { const r = m.get(p.id); if (r) { r.nick = p.nick; addNick(p.nick, p.id); } });
      }
      const follow = ids.filter(id => m.get(id).i && m.get(id).nick);
      const jobs = [sb.from('posts').select('id,body,visibility,created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(200)];
      if (follow.length) {
        jobs.push(sb.from('posts').select('id,user_id,body,visibility,created_at').in('user_id', follow).order('created_at', { ascending: false }).limit(50));
        jobs.push(sb.from('ratings').select(RCOLS).in('user_id', follow).order('rated_at', { ascending: false }).limit(60));
      }
      const res = await Promise.all(jobs);
      res.forEach(r => { if (r.error) throw r.error; });
      if (seq !== loadSeq || !myId()) return;   // пока грузили, вышли или запустили загрузку заново
      rel = m;
      if (AUTH.profile) addNick(AUTH.profile.nick, uid);
      const ev = [];
      ((res[1] && res[1].data) || []).forEach(p => {
        const r = m.get(p.user_id); if (!r || !r.nick) return;
        owner.set(p.id, p.user_id);
        ev.push({ id: 'p|' + p.id, tid: p.id, who: r.nick, d: AUTH.daysSince(p.created_at), t: 'post', text: p.body, real: true, vis: p.visibility });
      });
      ((res[2] && res[2].data) || []).forEach(x => {
        const r = m.get(x.user_id); if (!r || !r.nick || !x.titles) return;
        const key = regLive(x.titles, true); if (!key) return;
        const c = CAT_IDX[key];
        owner.set(x.id, x.user_id);
        ev.push({ id: 'r|' + x.user_id + '|' + x.titles.id, tid: x.id, who: r.nick, d: AUTH.daysSince(x.rated_at), key, k: c.k, c, real: true,
          t: x.score ? 'rate' : stClass(x.status) === 'done' ? 'done' : 'start', score: x.score || 0, status: x.status || '', text: x.spoiler ? '' : (x.review || '') });
      });
      events = ev;
      const myPosts = ((res[0] && res[0].data) || []).map(mapPost);
      myPosts.forEach(p => owner.set(p.id, uid));
      AUTH.setMyPosts(myPosts);
      await loadEng([...ev.map(x => x.tid), ...myPosts.map(p => p.id)]);
      lastLoad = Date.now(); errShown = false;
    } catch (e) {
      console.error('social', e);
      if (!errShown) { errShown = true; toast('Не удалось загрузить друзей и посты. Обновите страницу.'); }
    }
    if (!quiet) render(); else safeRender();
  }
  document.addEventListener('sync-entered', () => { if (AUTH.profile) addNick(AUTH.profile.nick, myId()); load(); });
  document.addEventListener('auth-changed', () => {
    if (AUTH.user) return;
    loadSeq++; rel = new Map(); events = []; viewing = null; byNick.clear(); nickById.clear(); pcache.clear(); eng.clear(); owner.clear();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && SO.on() && Date.now() - lastLoad > 60000) load(true); });

  /* ---------- посты ---------- */
  SO.publish = async (text, vis) => {
    const { data, error } = await sb.from('posts').insert({ body: String(text).slice(0, 5000), visibility: vis === 'friends' ? 'friends' : 'all' }).select('id,body,visibility,created_at').single();
    if (error || !data) { console.error(error); toast('Не удалось опубликовать. Попробуйте ещё раз.'); return; }
    if (S.me === false && viewing) { /* публикуем из чужого профиля нельзя: формы там нет */ }
    eng.set(data.id, { likes: 0, liked: false, comments: 0 }); owner.set(data.id, myId());
    S.posts.unshift(mapPost(data));
    toast('Опубликовано');
    render();
  };
  async function delPost(id) {
    if (!window.confirm('Удалить пост?')) return;
    const { error } = await sb.from('posts').delete().eq('id', id);
    if (error) { toast('Не удалось удалить пост.'); return; }
    S.posts = S.posts.filter(p => p.id !== id);
    render();
  }

  /* ---------- чужой профиль ---------- */
  async function openUser(name) {
    const n = String(name || '').trim(); if (!n) return;
    if (AUTH.profile && n.toLowerCase() === AUTH.profile.nick.toLowerCase()) { setProfile(true); window.scrollTo(0, 0); return; }
    try {
      let { data: pr, error } = await sb.from('profiles').select(PCOLS).ilike('nick', escLike(n)).maybeSingle();
      if (error) ({ data: pr, error } = await sb.from('profiles').select(PCOLS0).ilike('nick', escLike(n)).maybeSingle());
      if (error) throw error;
      if (!pr) { toast('Пользователь не найден'); return; }
      const recs = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: e2 } = await sb.from('ratings').select(RCOLS).eq('user_id', pr.id).order('rated_at', { ascending: false }).order('id').range(from, from + 999);
        if (e2) throw e2;
        recs.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const { data: ps, error: e3 } = await sb.from('posts').select('id,body,visibility,created_at').eq('user_id', pr.id).order('created_at', { ascending: false }).limit(100);
      if (e3) throw e3;
      const colls = AUTH.fetchColls ? await AUTH.fetchColls(pr.id) : [];
      setAv(pr.nick, pr.avatar);
      AUTH.setOther(pr, recs, (ps || []).map(mapPost), colls);
      (ps || []).forEach(p => owner.set(p.id, pr.id));
      await loadEng((ps || []).map(p => p.id));
      viewing = pr; addNick(pr.nick, pr.id);
      setProfile(false); window.scrollTo(0, 0);
    } catch (e) { console.error(e); toast('Не удалось открыть профиль.'); }
  }
  SO.openUser = openUser;

  /* ---------- лайки и комментарии (к постам и оценкам) ---------- */
  const eng = new Map();     // id поста/оценки -> {likes, liked, comments}
  const owner = new Map();   // id поста/оценки -> id автора (хозяин может удалять чужие комментарии)
  const ZERO = () => ({ likes: 0, liked: false, comments: 0 });
  const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 00-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 000-7.8z"/></svg>';
  const BUBBLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 01-11.6 7.1L3 21l1.9-5.4A8 8 0 1121 12z"/></svg>';
  SO.bar = id => {
    const e = eng.get(id) || ZERO();
    return `<button type="button" class="so-act so-like" data-solike="${esc(id)}" aria-pressed="${e.liked}" title="Нравится">${HEART}<span>${e.likes || ''}</span></button><button type="button" class="so-act" data-socom="${esc(id)}" aria-expanded="false" title="Комментарии">${BUBBLE}<span>${e.comments || ''}</span></button>`;
  };
  SO.box = id => `<div class="so-cm" data-socmbox="${esc(id)}" hidden></div>`;
  async function loadEng(ids) {
    ids = [...new Set((ids || []).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.rpc('engagement', { p_ids: ids.slice(i, i + 200) });
      if (error) { console.error('engagement', error); return false; }
      (Array.isArray(data) ? data : []).forEach(r => eng.set(r.target_id, { likes: r.likes, liked: r.liked, comments: r.comments }));
    }
    return true;
  }
  function paintEng(id) {   // обновляем кнопки на месте, без перерисовки страницы
    const e = eng.get(id) || ZERO();
    document.querySelectorAll('[data-solike]').forEach(b => { if (b.dataset.solike === id) { b.setAttribute('aria-pressed', e.liked); b.querySelector('span').textContent = e.likes || ''; } });
    document.querySelectorAll('[data-socom]').forEach(b => { if (b.dataset.socom === id) b.querySelector('span').textContent = e.comments || ''; });
  }
  const busy = new Set();
  async function toggleLike(id) {
    if (busy.has(id)) return; busy.add(id);
    const old = { ...(eng.get(id) || ZERO()) }, was = old.liked;
    eng.set(id, { ...old, liked: !was, likes: Math.max(0, old.likes + (was ? -1 : 1)) }); paintEng(id);
    const q = was ? sb.from('likes').delete().eq('user_id', myId()).eq('target_id', id) : sb.from('likes').insert({ user_id: myId(), target_id: id });
    const { error } = await q;
    if (error && error.code !== '23505') { console.error(error); eng.set(id, old); paintEng(id); toast('Не получилось. Попробуйте ещё раз.'); }
    busy.delete(id);
  }
  async function drawComments(id, box) {
    const { data, error } = await sb.from('comments').select('id,user_id,body,created_at').eq('target_id', id).order('created_at', { ascending: true }).limit(200);
    if (error) { box.innerHTML = '<div class="sub">Не удалось загрузить комментарии.</div>'; return; }
    const list = data || [], need = [...new Set(list.map(c => c.user_id).filter(u => !nickById.has(u)))];
    if (need.length) { const { data: ps } = await sb.from('profiles').select('id,nick').in('id', need); (ps || []).forEach(p => addNick(p.nick, p.id)); }
    const me = myId(), boss = owner.get(id);
    box.innerHTML = list.map(c => {
      const n = nickById.get(c.user_id) || '?';
      return `<div class="so-c">${avatarOf(n)}<div class="so-ct"><div><b class="hm-who" data-user="${esc(n)}">${esc(n)}</b> <span class="sub">${ago(AUTH.daysSince(c.created_at))}</span>${c.user_id === me || boss === me ? ` <button type="button" class="lnk" data-sodel="${esc(c.id)}" data-for="${esc(id)}">Удалить</button>` : ''}</div><p>${renderText(c.body)}</p></div></div>`;
    }).join('') + `<form class="so-cf" data-for="${esc(id)}"><textarea maxlength="1000" rows="2" placeholder="Написать комментарий" aria-label="Комментарий"></textarea><button type="submit" class="btn primary">Отправить</button></form>`;
    const e = eng.get(id) || ZERO();
    if (e.comments !== list.length) { eng.set(id, { ...e, comments: list.length }); paintEng(id); }
  }
  async function toggleComments(id, btn) {
    const art = btn.closest('article'), box = art && art.querySelector('.so-cm');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
    box.hidden = false; btn.setAttribute('aria-expanded', 'true'); box.innerHTML = '<div class="sub">Загружаю…</div>';
    await drawComments(id, box);
    const ta = box.querySelector('textarea'); if (ta) ta.focus();
  }
  document.addEventListener('submit', async e => {
    const f = e.target.closest && e.target.closest('.so-cf'); if (!f || !SO.on()) return;
    e.preventDefault();
    const id = f.dataset.for, ta = f.querySelector('textarea'), v = ta.value.trim(), b = f.querySelector('button');
    if (!v) return;
    b.disabled = true;
    const { error } = await sb.from('comments').insert({ user_id: myId(), target_id: id, body: v.slice(0, 1000) });
    b.disabled = false;
    if (error) { console.error(error); toast('Не удалось отправить комментарий.'); return; }
    const en = eng.get(id) || ZERO(); eng.set(id, { ...en, comments: en.comments + 1 }); paintEng(id);
    await drawComments(id, f.closest('.so-cm'));
  });
  async function delComment(cid, id, btn) {
    const { error } = await sb.from('comments').delete().eq('id', cid);
    if (error) { toast('Не удалось удалить комментарий.'); return; }
    const en = eng.get(id) || ZERO(); eng.set(id, { ...en, comments: Math.max(0, en.comments - 1) }); paintEng(id);
    await drawComments(id, btn.closest('.so-cm'));
  }

  /* ---------- друзья: действия ---------- */
  async function follow(id) {
    const { error } = await sb.from('follows').insert({ follower_id: myId(), followee_id: id });
    if (error && error.code !== '23505') { console.error(error); toast('Не получилось. Попробуйте ещё раз.'); return false; }
    return true;
  }
  async function unfollow(id) {
    const { error } = await sb.from('follows').delete().eq('follower_id', myId()).eq('followee_id', id);
    if (error) { console.error(error); toast('Не получилось. Попробуйте ещё раз.'); return false; }
    return true;
  }
  async function decline(id) {
    const { error } = await sb.from('follows').delete().eq('follower_id', id).eq('followee_id', myId());
    if (error) { console.error(error); toast('Не получилось. Попробуйте ещё раз.'); return false; }
    return true;
  }
  async function friendClick() {
    if (!viewing) return;
    const id = viewing.id, s = state(id);
    let ok = false, msg = '';
    if (s === 'none') { ok = await follow(id); msg = 'Заявка отправлена'; }
    else if (s === 'incoming') { ok = await follow(id); msg = 'Теперь вы друзья'; }
    else if (s === 'sent') { ok = await unfollow(id); msg = 'Заявка отменена'; }
    else if (window.confirm('Убрать ' + viewing.nick + ' из друзей? Он останется вашим подписчиком.')) { ok = await unfollow(id); msg = 'Убрали из друзей'; }
    if (ok) { toast(msg); await load(); }
  }
  document.addEventListener('click', async e => {
    if (!SO.on()) return;
    let b;
    if ((b = e.target.closest('[data-user]'))) { e.preventDefault(); openUser(b.dataset.user); return; }
    if (e.target.closest('#b-friend') && S.me === false) { friendClick(); return; }
    if (e.target.closest('#b-decl') && viewing) { if (await decline(viewing.id)) { toast('Заявка отклонена'); await load(); } return; }
    if ((b = e.target.closest('[data-sacc]'))) { if (await follow(b.dataset.sacc)) { toast('Теперь вы друзья'); await load(); } return; }
    if ((b = e.target.closest('[data-sdec]'))) { if (await decline(b.dataset.sdec)) { toast('Заявка отклонена'); await load(); } return; }
    if ((b = e.target.closest('[data-delpost]'))) { delPost(b.dataset.delpost); return; }
    if ((b = e.target.closest('[data-solike]'))) { toggleLike(b.dataset.solike); return; }
    if ((b = e.target.closest('[data-socom]'))) { toggleComments(b.dataset.socom, b); return; }
    if ((b = e.target.closest('[data-sodel]'))) { delComment(b.dataset.sodel, b.dataset.for, b); return; }
  });
})();
