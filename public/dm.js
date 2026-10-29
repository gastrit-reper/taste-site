/* Личные сообщения между друзьями (только текст). Подключается после social.js; таблица messages создаётся в stage14.sql.
   Пока окно закрыто, раз в минуту проверяется только число непрочитанных. Открыто окно: новые сообщения подтягиваются раз в 5 секунд. */
(function () {
  'use strict';
  const A = window.AUTH;
  if (!A || !A.client) return;
  const sb = A.client;
  const DM = window.DM = {};
  const me = () => (A.user && A.user.id) || null;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SO = () => window.SOCIAL;
  const COLS = 'id,sender_id,recipient_id,body,created_at,read_at';

  let all = [];            // загруженные сообщения (по возрастанию времени)
  let ov = null, cur = null, timer = null, badgeTimer = null, dead = false, unread = 0, sending = false, mobileThread = false;
  const draft = {};        // черновики по собеседникам

  const st = document.createElement('style');
  st.textContent = `
  .dmb{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:9px;background:var(--accent);color:#fff;font-size:11px;font-weight:700}
  .dmb[hidden]{display:none}
  .dmdlg{width:min(860px,100%);height:min(640px,calc(100vh - 32px));display:grid;grid-template-columns:260px 1fr;overflow:hidden;margin-block:auto}
  .dmside{border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
  .dmside h2,.dmhead{margin:0;padding:14px 16px;font-size:16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
  .dmlist{overflow:auto;flex:1}
  .dmrow{display:flex;gap:10px;align-items:center;width:100%;padding:10px 14px;background:none;border:0;border-bottom:1px solid var(--line);color:var(--fg);text-align:left;cursor:pointer;font:inherit}
  .dmrow:hover,.dmrow[aria-current="true"]{background:var(--surface2)}
  .dmrow .t{flex:1;min-width:0}.dmrow b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dmrow small{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dmav{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;flex:none;font-weight:600;color:#fff;background-size:cover;background-position:center}
  .dmmain{display:flex;flex-direction:column;min-height:0}
  .dmmsgs{flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:6px}
  .dmm{max-width:75%;padding:8px 12px;border-radius:14px;background:var(--surface2);align-self:flex-start;white-space:pre-wrap;word-break:break-word;position:relative}
  .dmm.me{align-self:flex-end;background:color-mix(in srgb,var(--accent) 35%,var(--surface))}
  .dmm i{display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:2px}
  .dmm .x{position:absolute;top:2px;right:4px;background:none;border:0;color:var(--muted);cursor:pointer;opacity:0;font-size:14px;line-height:1}
  .dmm:hover .x{opacity:1}
  .dmday{align-self:center;font-size:12px;color:var(--muted);margin:6px 0}
  .dmform{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line);align-items:flex-end}
  .dmform textarea{flex:1;resize:none;max-height:120px}
  .dmempty{margin:auto;color:var(--muted);text-align:center;padding:20px}
  .dmback{display:none}
  @media (max-width:700px){.dmdlg{grid-template-columns:1fr}.dmdlg .dmmain{display:none}.dmdlg.th .dmside{display:none}.dmdlg.th .dmmain{display:flex}.dmback{display:inline-flex}}
  `;
  document.head.appendChild(st);

  const friends = () => (SO() && SO().friendsList ? SO().friendsList() : []);
  const byFriend = id => all.filter(m => m.sender_id === id || m.recipient_id === id);
  const unreadFrom = id => all.filter(m => m.sender_id === id && m.recipient_id === me() && !m.read_at).length;

  function updateBadge() {
    document.querySelectorAll('[data-dm=""] .dmb').forEach(b => { b.textContent = unread > 99 ? '99+' : String(unread); b.hidden = !unread; });
  }
  DM.updateBadge = updateBadge;
  DM.badgeHtml = () => `<span class="dmb"${unread ? '' : ' hidden'}>${unread > 99 ? '99+' : unread}</span>`;
  const _r = window.render;
  if (typeof _r === 'function') window.render = function () { const r = _r.apply(this, arguments); try { updateBadge(); } catch (e) {} return r; };

  async function countUnread() {
    if (!me() || dead || document.hidden) return;
    try {
      const { count, error } = await sb.from('messages').select('id', { count: 'exact', head: true }).eq('recipient_id', me()).is('read_at', null);
      if (error) throw error;
      unread = count || 0; updateBadge();
    } catch (e) { if (/relation|does not exist|schema cache/i.test((e && e.message) || '')) dead = true; }
  }

  const merge = rows => {
    const have = new Set(all.map(m => m.id)); let added = 0;
    rows.forEach(m => { if (!have.has(m.id)) { all.push(m); added++; } });
    if (added) all.sort((a, b) => a.created_at < b.created_at ? -1 : 1);
    return added;
  };
  async function loadAll() {
    const { data, error } = await sb.from('messages').select(COLS).order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    all = []; merge((data || []).reverse());
  }
  async function loadNew() {
    const ts = all.length ? all[all.length - 1].created_at : null;
    let q = sb.from('messages').select(COLS).order('created_at', { ascending: true }).limit(100);
    if (ts) q = q.gt('created_at', ts);
    const { data, error } = await q;
    if (error) throw error;
    return merge(data || []);
  }
  async function markRead(id) {
    const ids = all.filter(m => m.sender_id === id && m.recipient_id === me() && !m.read_at);
    if (!ids.length) return;
    const now = new Date().toISOString();
    ids.forEach(m => { m.read_at = now; });
    unread = all.filter(m => m.recipient_id === me() && !m.read_at).length; updateBadge();
    await sb.from('messages').update({ read_at: now }).eq('sender_id', id).eq('recipient_id', me()).is('read_at', null).then(() => {}, () => {});
  }

  const avatar = nick => window.avaHtml ? avaHtml(nick, 'dmav') : `<span class="dmav" style="background:hsl(${[...nick].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 45% 42%)">${esc(nick[0].toUpperCase())}</span>`;
  const hm = iso => new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const dayLabel = iso => { const d = new Date(iso), t = new Date(); const same = (a, b) => a.toDateString() === b.toDateString(); const y = new Date(t); y.setDate(t.getDate() - 1); return same(d, t) ? 'Сегодня' : same(d, y) ? 'Вчера' : d.toLocaleDateString('ru', { day: 'numeric', month: 'long' }); };

  function drawList() {
    const el = document.getElementById('dm-list'); if (!el) return;
    const fr = friends().map(f => { const ms = byFriend(f.id); return { ...f, last: ms[ms.length - 1], un: unreadFrom(f.id) }; })
      .sort((a, b) => (b.last ? b.last.created_at : '') < (a.last ? a.last.created_at : '') ? -1 : 1);
    el.innerHTML = fr.length ? fr.map(f => `<button type="button" class="dmrow" data-dmf="${esc(f.id)}" aria-current="${cur && cur.id === f.id}">${avatar(f.nick)}<span class="t"><b>${esc(f.nick)}</b><small>${f.last ? (f.last.sender_id === me() ? 'Вы: ' : '') + esc(f.last.body.slice(0, 50)) : 'Напишите первым'}</small></span>${f.un ? `<span class="dmb">${f.un}</span>` : ''}</button>`).join('')
      : '<div class="dmempty">Писать можно друзьям. Друзья: когда вы оба подписаны друг на друга. Найдите человека через поиск вверху.</div>';
    el.querySelectorAll('[data-dmf]').forEach(b => b.onclick = () => select(b.dataset.dmf));
  }

  function drawThread(stick) {
    const box = document.getElementById('dm-msgs'); if (!box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const ms = cur ? byFriend(cur.id) : [];
    let h = '', lastDay = '';
    ms.forEach(m => {
      const dl = dayLabel(m.created_at);
      if (dl !== lastDay) { h += `<div class="dmday">${esc(dl)}</div>`; lastDay = dl; }
      const mine = m.sender_id === me();
      h += `<div class="dmm${mine ? ' me' : ''}">${esc(m.body)}<i>${hm(m.created_at)}${mine && m.read_at ? ' · прочитано' : ''}</i>${mine ? `<button type="button" class="x" data-dmdel="${esc(m.id)}" aria-label="Удалить сообщение">×</button>` : ''}</div>`;
    });
    box.innerHTML = h || '<div class="dmempty">Пока нет сообщений. Скажите привет.</div>';
    box.querySelectorAll('[data-dmdel]').forEach(b => b.onclick = async () => {
      const ok = window.ask ? await window.ask('Удалить это сообщение? У собеседника оно тоже исчезнет.') : confirm('Удалить сообщение?');
      if (!ok) return;
      const { error } = await sb.from('messages').delete().eq('id', b.dataset.dmdel);
      if (error) { if (window.toast) toast('Не удалось удалить.'); return; }
      all = all.filter(m => m.id !== b.dataset.dmdel); drawThread(false); drawList();
    });
    if (stick || near) box.scrollTop = box.scrollHeight;
  }

  async function select(id) {
    const f = friends().find(x => x.id === id); if (!f) return;
    cur = f; mobileThread = true;
    drawAll(true); markRead(id).then(drawList);
    const ta = document.getElementById('dm-in'); if (ta) ta.focus();
  }

  function drawAll(stick) {
    if (!ov) return;
    ov.querySelector('.dmdlg').classList.toggle('th', mobileThread && !!cur);
    drawList();
    const head = document.getElementById('dm-head'), form = document.getElementById('dm-form');
    if (head) head.innerHTML = cur ? `<button type="button" class="btn dmback" id="dm-back">←</button>${avatar(cur.nick)}<b>${esc(cur.nick)}</b>` : '<span class="sub">Выберите друга слева</span>';
    if (form) form.hidden = !cur;
    const bk = document.getElementById('dm-back'); if (bk) bk.onclick = () => { mobileThread = false; cur = null; drawAll(false); };
    const ta = document.getElementById('dm-in'); if (ta && cur) ta.value = draft[cur.id] || ta.value;
    drawThread(stick);
  }

  async function send() {
    if (sending || !cur) return;
    const ta = document.getElementById('dm-in'); const body = ta.value.trim().slice(0, 2000);
    if (!body) return;
    sending = true; document.getElementById('dm-send').disabled = true;
    try {
      const { data, error } = await sb.from('messages').insert({ sender_id: me(), recipient_id: cur.id, body }).select(COLS).single();
      if (error) throw error;
      merge([data]); ta.value = ''; delete draft[cur.id]; drawThread(true); drawList();
    } catch (e) {
      console.error(e);
      if (window.toast) toast(/row-level|policy|permission/i.test((e && e.message) || '') ? 'Писать можно только друзьям (вы оба должны быть подписаны друг на друга).' : 'Не удалось отправить. Попробуйте ещё раз.');
    } finally { sending = false; const b = document.getElementById('dm-send'); if (b) b.disabled = false; }
  }

  function close() {
    clearInterval(timer); timer = null;
    if (ov) { ov.remove(); ov = null; }
    cur = null; mobileThread = false;
    countUnread();
  }

  DM.open = async function (nick) {
    if (!me()) { if (window.toast) toast('Войдите в аккаунт, чтобы писать сообщения.'); return; }
    if (ov) close();
    ov = document.createElement('div'); ov.className = 'ov'; ov.id = 'dmov'; ov.style.zIndex = 30;
    ov.innerHTML = `<div class="dlg dmdlg" role="dialog" aria-modal="true" aria-label="Сообщения">
      <div class="dmside"><h2>Сообщения<button type="button" class="ic" id="dm-x" style="margin-left:auto" aria-label="Закрыть">×</button></h2><div class="dmlist" id="dm-list"><div class="dmempty">Загружаю…</div></div></div>
      <div class="dmmain"><div class="dmhead" id="dm-head"></div><div class="dmmsgs" id="dm-msgs"></div>
        <form class="dmform" id="dm-form" hidden><textarea id="dm-in" class="fld" rows="1" maxlength="2000" placeholder="Сообщение" aria-label="Сообщение"></textarea><button type="submit" class="btn primary" id="dm-send">Отправить</button></form></div></div>`;
    document.body.appendChild(ov);
    ov.onmousedown = e => { if (e.target === ov) close(); };
    document.getElementById('dm-x').onclick = close;
    const ta = document.getElementById('dm-in');
    ta.oninput = () => { if (cur) draft[cur.id] = ta.value; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
    ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    document.getElementById('dm-form').onsubmit = e => { e.preventDefault(); send(); };
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    try { await loadAll(); }
    catch (e) {
      const l = document.getElementById('dm-list');
      if (l) l.innerHTML = `<div class="dmempty">${/relation|does not exist|schema cache/i.test((e && e.message) || '') ? 'Сообщения ещё не включены: нужно выполнить stage14.sql в Supabase.' : 'Не удалось загрузить сообщения. Попробуйте ещё раз.'}</div>`;
      return;
    }
    const want = nick && friends().find(f => f.nick.toLowerCase() === String(nick).toLowerCase());
    if (want) { cur = want; mobileThread = true; markRead(want.id); }
    else if (nick && window.toast) toast('Писать можно только друзьям: вы оба должны быть подписаны друг на друга.');
    drawAll(true);
    timer = setInterval(async () => {
      if (document.hidden || !ov) return;
      try {
        if (await loadNew()) { if (cur) { markRead(cur.id); } drawThread(false); drawList(); }
      } catch (e) {}
    }, 5000);
  };

  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-dm]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    DM.open(b.dataset.dm || '');
  }, true);

  countUnread();
  badgeTimer = setInterval(() => { if (!ov) countUnread(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !ov) countUnread(); });
})();
