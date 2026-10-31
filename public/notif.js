/* Уведомления: заявки в друзья, комментарии и лайки к вашим постам и оценкам. Подключается после dm.js.
   Данные даёт функция my_notifications (stage15.sql). Колокольчик у ника + пункт «Уведомления» в меню. */
(function () {
  'use strict';
  const A = window.AUTH;
  if (!A || !A.client) return;
  const sb = A.client, NF = window.NF = {};
  const me = () => (A.user && A.user.id) || null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SO = () => window.SOCIAL;
  const seenKey = () => 'nf_seen_' + me();
  const BELL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px"><path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 003.4 0"/></svg>';

  let items = [], unread = 0, ov = null, timer = null, dead = false, loading = false, seen = 0;

  const st = document.createElement('style');
  st.textContent = `
  .nfb{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:9px;background:var(--accent);color:#fff;font-size:11px;font-weight:700}
  .nfb[hidden]{display:none}
  #nf-bell{display:inline-flex;align-items:center;padding-inline:10px}
  #nf-bell .nfb{margin-left:4px}
  .nfpop{position:fixed;z-index:40;width:380px;max-width:calc(100vw - 16px);display:flex;flex-direction:column;overflow:hidden;background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px rgb(0 0 0 / .45)}
  .nfpop h2{margin:0;padding:12px 16px;font-size:15px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
  .nflist{overflow:auto;flex:1;overscroll-behavior:contain}
  .nfpop{overscroll-behavior:contain}
  .nfrow{display:flex;gap:10px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);cursor:pointer}
  .nfrow:hover{background:var(--surface2)}
  .nfrow.new{background:color-mix(in srgb,var(--accent) 10%,transparent)}
  .nfav{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;flex:none;font-weight:600;color:#fff;background-size:cover;background-position:center}
  .nft{flex:1;min-width:0}.nft small{display:block;color:var(--muted)}
  .nft q{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
  .nfbtn{display:flex;gap:6px}.nfbtn .btn{padding:4px 10px;font-size:13px}
  .nfempty{padding:28px 20px;text-align:center;color:var(--muted)}
  @keyframes nfDrop{from{opacity:0;transform:translateY(-8px) scale(.97)}to{opacity:1;transform:none}}
  @keyframes nfWig{0%,100%{transform:rotate(0)}25%{transform:rotate(16deg)}50%{transform:rotate(-14deg)}75%{transform:rotate(8deg)}}
  .nfpop{animation:nfDrop .2s cubic-bezier(.2,.8,.2,1);transform-origin:top right}
  .nfrow{transition:background .15s,transform .15s}.nfrow:hover{transform:translateX(3px)}
  #nf-bell:hover svg{animation:nfWig .6s ease-in-out;transform-origin:50% 10%}
  `;
  document.head.appendChild(st);

  const badge = () => unread > 99 ? '99+' : String(unread);
  function paintBadges() {
    document.querySelectorAll('.nfb').forEach(b => { b.textContent = badge(); b.hidden = !unread; });
  }
  NF.badgeHtml = () => `<span class="nfb"${unread ? '' : ' hidden'}>${badge()}</span>`;
  const _r = window.render;
  if (typeof _r === 'function') window.render = function () { const r = _r.apply(this, arguments); try { paintBadges(); } catch (e) {} return r; };

  /* колокольчик возле ника */
  function bell() {
    let b = document.getElementById('nf-bell');
    if (!A.user) { if (b) b.remove(); return; }
    if (b) return;
    const slot = document.getElementById('au-btn'); if (!slot || !slot.parentNode) return;
    b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.id = 'nf-bell'; b.setAttribute('data-notif', ''); b.title = 'Уведомления'; b.setAttribute('aria-label', 'Уведомления');
    b.innerHTML = BELL + NF.badgeHtml();
    slot.parentNode.insertBefore(b, slot);
  }

  const isNew = n => n.kind === 'request' || (Date.parse(n.created_at) || 0) > seen;
  async function fetchAll() {
    if (!me() || dead) return false;
    try {
      const { data, error } = await sb.rpc('my_notifications', { p_limit: 60 });
      if (error) throw error;
      items = Array.isArray(data) ? data : [];
      unread = items.filter(isNew).length; paintBadges();
      return true;
    } catch (e) {
      console.error('notif', e);
      if (/function|does not exist|schema cache|PGRST202/i.test((e && (e.message + e.code)) || '')) dead = true;
      return false;
    }
  }
  async function poll() { if (!me() || document.hidden) return; await fetchAll(); if (ov) draw(); }

  const ago = iso => {
    const t = Date.parse(iso) || 0; if (!t || t < 86400e3) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'только что'; if (m < 60) return m + ' мин назад';
    const h = Math.round(m / 60); if (h < 24) return h + ' ч назад';
    const d = Math.round(h / 24); return d + ' дн назад';
  };
  const avatar = nick => window.avaHtml ? avaHtml(nick, 'nfav') : `<span class="nfav" style="background:hsl(${[...nick].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 45% 42%)">${esc(nick[0].toUpperCase())}</span>`;
  const target = n => n.what === 'post' ? `вашему посту «${esc(n.label || '')}»` : `вашей оценке «${esc(n.label || '')}»`;
  function text(n) {
    const who = `<b>${esc(n.actor_nick)}</b>`;
    if (n.kind === 'request') return `${who} хочет дружить`;
    if (n.kind === 'friend') return `Теперь вы друзья: ${who}`;
    if (n.kind === 'like') return `${who}: лайк ${target(n)}`;
    return `${who} оставил комментарий к ${target(n)}`;
  }

  function draw() {
    const box = document.getElementById('nf-list'); if (!box) return;
    box.innerHTML = items.length ? items.map((n, i) => `<div class="nfrow${isNew(n) ? ' new' : ''}" data-i="${i}">${avatar(n.actor_nick)}<div class="nft">${text(n)}${n.snippet ? `<q>${esc(n.snippet)}</q>` : ''}<small>${esc(ago(n.created_at))}</small></div>${n.kind === 'request' ? `<span class="nfbtn"><button type="button" class="btn primary" data-nfacc="${esc(n.actor_id)}">Принять</button></span>` : ''}</div>`).join('')
      : '<div class="nfempty">Пока ничего нового. Здесь появятся заявки в друзья, комментарии и лайки.</div>';
  }

  function close() {
    if (ov) { ov.remove(); ov = null; }
    clearInterval(timer); timer = null;
  }
  function markSeen() {
    seen = Date.now();
    try { localStorage.setItem(seenKey(), String(seen)); } catch (e) {}
    unread = items.filter(n => n.kind === 'request').length; paintBadges();   // заявки остаются в счётчике, пока их не приняли
  }
  let anchor = null;
  function place() {   // панель под колокольчиком, у его правого края
    if (!ov) return;
    const w = window.innerWidth, r = anchor ? anchor.getBoundingClientRect() : { bottom: 60, right: w - 12 };
    const top = Math.round(r.bottom + 8);
    ov.style.top = top + 'px'; ov.style.maxHeight = Math.max(200, window.innerHeight - top - 12) + 'px';
    if (w < 440) { ov.style.left = '8px'; ov.style.right = '8px'; ov.style.width = 'auto'; }
    else { ov.style.left = 'auto'; ov.style.width = ''; ov.style.right = Math.max(8, Math.round(w - r.right)) + 'px'; }
  }
  window.addEventListener('resize', place);
  document.addEventListener('mousedown', e => { if (ov && !ov.contains(e.target) && !(e.target.closest && e.target.closest('[data-notif]'))) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov) close(); });
  NF.open = async function (from) {
    if (!me()) { if (window.toast) toast('Войдите в аккаунт, чтобы видеть уведомления.'); return; }
    if (ov) close();
    ov = document.createElement('div'); ov.className = 'nfpop'; ov.id = 'nfov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Уведомления');
    ov.innerHTML = `<h2>Уведомления<button type="button" class="ic" id="nf-x" style="margin-left:auto" aria-label="Закрыть">×</button></h2><div class="nflist" id="nf-list"><div class="nfempty">Загружаю…</div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('wheel', e => {   // колесо над панелью крутит только список, страница под ней стоит
      const l = document.getElementById('nf-list');
      if (!l || l.scrollHeight <= l.clientHeight + 1 || (e.deltaY < 0 && l.scrollTop <= 0) || (e.deltaY > 0 && l.scrollTop + l.clientHeight >= l.scrollHeight - 1)) e.preventDefault();
    }, { passive: false });
    anchor = (document.getElementById('nf-bell') && document.getElementById('nf-bell').offsetParent) ? document.getElementById('nf-bell') : (from || null);
    place();
    document.getElementById('nf-x').onclick = close;
    ov.addEventListener('click', async e => {
      const acc = e.target.closest('[data-nfacc]');
      if (acc) {
        e.stopPropagation(); acc.disabled = true;
        const ok = SO() && SO().accept ? await SO().accept(acc.dataset.nfacc) : false;
        if (!ok) { acc.disabled = false; return; }
        await fetchAll(); draw(); return;
      }
      const row = e.target.closest('.nfrow'); if (!row) return;
      const n = items[+row.dataset.i]; if (!n) return;
      close();
      if (n.kind === 'request' || n.kind === 'friend') { if (SO() && SO().openUser) SO().openUser(n.actor_nick); }
      else { const m = document.getElementById('v-me'); if (m) m.click(); window.scrollTo(0, 0); }
    });
    if (dead) { document.getElementById('nf-list').innerHTML = '<div class="nfempty">Уведомления ещё не включены: нужно выполнить stage15.sql в Supabase.</div>'; return; }
    const ok = await fetchAll();
    if (!ov) return;
    if (!ok) { document.getElementById('nf-list').innerHTML = `<div class="nfempty">${dead ? 'Уведомления ещё не включены: нужно выполнить stage15.sql в Supabase.' : 'Не удалось загрузить. Попробуйте ещё раз.'}</div>`; return; }
    draw();
    setTimeout(() => { if (ov) markSeen(); }, 1500);   // новые подсвечены ещё секунду-две, потом считаются прочитанными
    timer = setInterval(poll, 20000);
  };

  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-notif]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (ov) { close(); return; }
    NF.open(b);
  }, true);

  function start() {
    if (!me()) { items = []; unread = 0; return; }
    let s = 0; try { s = +localStorage.getItem(seenKey()) || 0; } catch (e) {}
    seen = s || Date.now() - 3 * 864e5;   // в первый раз показываем события за последние 3 дня
    bell(); fetchAll();
    if (!start.drawn) { start.drawn = true; try { if (typeof window.render === 'function') window.render(); } catch (e) {} }   // чтобы пункт меню появился, даже если меню нарисовано раньше
  }
  document.addEventListener('auth-changed', () => { bell(); start(); });
  document.addEventListener('sync-entered', () => { bell(); start(); });
  setInterval(poll, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !ov) poll(); });
  if (me()) start();
})();
