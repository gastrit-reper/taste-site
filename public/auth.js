/* Вход и регистрация (Supabase Auth). Подключается в index.html после config.js.
   Даёт window.AUTH = {user, profile, ready, client} и событие 'auth-changed' на document.
   Классы с префиксом au-, чтобы не пересекаться с index.html. */
(function () {
  const A = window.APP || {};
  const AUTH = window.AUTH = { user: null, profile: null, ready: false, client: null };
  const lib = window.supabase;
  if (!lib || !A.SUPABASE_URL || !A.PUBLISHABLE_KEY || /ВСТАВЬТЕ/.test(A.PUBLISHABLE_KEY)) { console.warn('auth: нет библиотеки или config.js'); return; }
  /* пока проверяем сохранённый вход, прячем демо-данные (их место займут данные аккаунта); sync.js снимает класс */
  try {
    if (Object.keys(localStorage).some(k => /^sb-.+-auth-token$/.test(k))) {
      const w = document.createElement('style'); w.textContent = 'html.sy-wait #home,html.sy-wait #profile,html.sy-wait #tp{visibility:hidden}';
      document.head.appendChild(w); document.documentElement.classList.add('sy-wait');
      setTimeout(() => document.documentElement.classList.remove('sy-wait'), 8000);
    }
  } catch (e) {}
  const sb = AUTH.client = lib.createClient(A.SUPABASE_URL, A.PUBLISHABLE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  const NICK = /^[\p{L}\p{N}_]{2,24}$/u;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const emit = () => document.dispatchEvent(new CustomEvent('auth-changed', { detail: AUTH }));

  const st = document.createElement('style');
  st.textContent = '.au-tabs{display:flex}.au-tabs button{flex:1}.au-btn{white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}.au-ok{color:var(--good);font-size:13px}.au-who{display:flex;flex-direction:column;gap:2px}';
  document.head.appendChild(st);

  /* кнопка рядом с шестерёнкой */
  const slot = document.createElement('button');
  slot.type = 'button'; slot.className = 'btn au-btn'; slot.id = 'au-btn'; slot.disabled = true; slot.textContent = '…';
  const pr = document.querySelector('.pr');
  if (pr) pr.insertBefore(slot, pr.querySelector('.gearwrap'));
  function paintBtn() {
    slot.disabled = false;
    slot.textContent = AUTH.user ? (AUTH.profile ? AUTH.profile.nick : 'Аккаунт') : 'Войти';
    slot.title = AUTH.user ? 'Аккаунт' : 'Войти или зарегистрироваться';
  }

  /* перевод ошибок Supabase */
  function human(e) {
    const m = String((e && e.message) || e || ''), c = (e && e.code) || '';
    if (/invalid login credentials/i.test(m)) return 'Неверная почта или пароль.';
    if (/already registered|user_already_exists/i.test(m + c)) return 'Эта почта уже зарегистрирована. Перейдите на вкладку «Вход».';
    if (/email not confirmed/i.test(m)) return 'Почта не подтверждена. Откройте письмо от нас и нажмите ссылку.';
    if (/at least \d+ char|weak_password/i.test(m + c)) return 'Пароль слишком простой: нужно минимум 6 символов.';
    if (/rate limit|over_email_send_rate_limit|too many/i.test(m + c)) return 'Слишком много попыток. Подождите несколько минут.';
    if (/valid email|email_address_invalid|invalid format/i.test(m + c)) return 'Проверьте адрес почты.';
    if (/signup.*disabled|signups not allowed/i.test(m + c)) return 'Регистрация сейчас отключена.';
    if (/network|failed to fetch|load failed/i.test(m)) return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
    return 'Не получилось (' + m + ').';
  }

  async function loadProfile() {
    AUTH.profile = null;
    if (!AUTH.user) return;
    const { data } = await sb.from('profiles').select('id,nick,about').eq('id', AUTH.user.id).maybeSingle();
    AUTH.profile = data || null;
  }
  async function setUser(u) {
    AUTH.user = u || null;
    await loadProfile();
    AUTH.ready = true; paintBtn(); emit();
  }

  /* окно */
  let mode = 'in';
  const close = () => { const o = document.getElementById('au-ov'); if (o) o.remove(); };
  function open(m) {
    close(); mode = m || 'in';
    const ov = document.createElement('div'); ov.id = 'au-ov'; ov.className = 'ov';
    document.body.appendChild(ov);
    ov.onmousedown = e => { if (e.target === ov) close(); };
    draw();
  }
  function draw() {
    const ov = document.getElementById('au-ov'); if (!ov) return;
    let body, foot = '';
    if (AUTH.user) {
      body = `<div class="au-who"><b>${esc(AUTH.profile ? AUTH.profile.nick : 'Аккаунт')}</b><span class="sub">${esc(AUTH.user.email || '')}</span></div>
        <div class="hint">Вы вошли. Оценки и статусы сохраняются в аккаунте. Посты, сборники и друзья пока хранятся только в этом браузере.</div>`;
      foot = '<button type="button" class="btn" id="au-c">Закрыть</button><button type="button" class="btn primary" id="au-out">Выйти</button>';
    } else {
      const reg = mode === 'up';
      body = `<div class="seg au-tabs" role="tablist"><button type="button" role="tab" data-aum="in" aria-pressed="${!reg}">Вход</button><button type="button" role="tab" data-aum="up" aria-pressed="${reg}">Регистрация</button></div>
        <form id="au-f" class="dr" novalidate>
          ${reg ? '<div><label for="au-nick">Ник</label><input id="au-nick" class="fld" maxlength="24" autocomplete="username" placeholder="например, kirill_k"><div class="hint">От 2 до 24 символов: буквы, цифры и _. Ник видят все.</div></div>' : ''}
          <div><label for="au-mail">Почта</label><input id="au-mail" class="fld" type="email" autocomplete="email" placeholder="name@example.com"></div>
          <div><label for="au-pass">Пароль</label><input id="au-pass" class="fld" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" placeholder="${reg ? 'минимум 6 символов' : ''}"></div>
          <div class="err" id="au-err" role="alert"></div>
          <button type="submit" class="btn primary" id="au-go">${reg ? 'Создать аккаунт' : 'Войти'}</button>
        </form>`;
      foot = '<button type="button" class="btn" id="au-c">Закрыть</button>';
    }
    ov.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="au-h" style="width:min(420px,100%)"><div class="dh"><h2 id="au-h">${AUTH.user ? 'Аккаунт' : 'Вход на сайт'}</h2><button type="button" class="ic" id="au-x" aria-label="Закрыть"><svg class="i" aria-hidden="true"><use href="#close"/></svg></button></div><div class="dr pb">${body}</div><div class="df">${foot}</div></div>`;
    const $ = id => document.getElementById(id);
    $('au-x').onclick = close; if ($('au-c')) $('au-c').onclick = close;
    ov.querySelectorAll('[data-aum]').forEach(b => b.onclick = () => { mode = b.dataset.aum; draw(); });
    if ($('au-out')) $('au-out').onclick = async () => { await sb.auth.signOut(); close(); };
    const f = $('au-f');
    if (f) { f.onsubmit = submit; const first = $(mode === 'up' ? 'au-nick' : 'au-mail'); if (first) first.focus(); }
  }
  async function submit(e) {
    e.preventDefault();
    const $ = id => document.getElementById(id), err = m => { $('au-err').textContent = m || ''; };
    const mail = $('au-mail').value.trim(), pass = $('au-pass').value, reg = mode === 'up';
    err('');
    if (!/^\S+@\S+\.\S+$/.test(mail)) return err('Введите адрес почты.');
    if (pass.length < 6) return err('Пароль: минимум 6 символов.');
    let nick = '';
    if (reg) { nick = $('au-nick').value.trim(); if (!NICK.test(nick)) return err('Ник: от 2 до 24 символов, только буквы, цифры и _.'); }
    const go = $('au-go'); go.disabled = true; go.textContent = 'Подождите…';
    try {
      if (reg) {
        const { data: free, error: e1 } = await sb.rpc('nick_free', { p_nick: nick });
        if (e1) throw e1;
        if (!free) { err('Этот ник уже занят. Выберите другой.'); return; }
        const { data, error } = await sb.auth.signUp({ email: mail, password: pass, options: { data: { nick } } });
        if (error) throw error;
        if (!data.session) {   // в Supabase включено подтверждение почты
          $('au-f').innerHTML = '<div class="au-ok">Аккаунт создан. Мы отправили письмо на ' + esc(mail) + ': откройте его и нажмите ссылку, потом вернитесь и войдите.</div>';
          return;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: mail, password: pass });
        if (error) throw error;
      }
      close();
    } catch (x) { err(human(x)); }
    finally { const g = document.getElementById('au-go'); if (g) { g.disabled = false; g.textContent = reg ? 'Создать аккаунт' : 'Войти'; } }
  }

  slot.onclick = () => open('in');
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.getElementById('au-ov')) close(); });
  AUTH.open = open;
  AUTH.setProfile = p => { AUTH.profile = p; paintBtn(); };

  /* состояние входа: при загрузке, входе, выходе, обновлении сессии */
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === 'INITIAL_SESSION' || ev === 'SIGNED_IN' || ev === 'SIGNED_OUT' || ev === 'USER_UPDATED') {
      setTimeout(() => setUser(session && session.user).then(() => { if (document.getElementById('au-ov')) { if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') close(); } }), 0);   // setTimeout: так советует Supabase, чтобы не блокировать внутренние вызовы
    }
  });
})();
