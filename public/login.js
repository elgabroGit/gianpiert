/* Accesso: dalla password si ricava un token per il server e la chiave per aprire i dati. */
(function () {
  'use strict';
  const C = window.LanaCrypto;
  const form = document.getElementById('login');
  const go = document.getElementById('go');
  const show = id => { document.querySelectorAll('.msg').forEach(m => { m.hidden = m.id !== 'err-' + id; }); };

  // Se si arriva qui non c'è una sessione: la chiave rimasta nel browser non serve più.
  C.clearKey();
  const e = new URLSearchParams(location.search).get('e');
  if (e) show(e);

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    show('');
    go.disabled = true;
    const username = form.username.value.trim();
    const password = form.password.value;
    try {
      let token;
      try { token = await C.authToken(username, password); } catch (err) { return show('browser'); }
      let res;
      try {
        res = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ username, token }) });
      } catch (err) { return show('rete'); }
      if (res.status === 429) return show('troppi');
      if (!res.ok) return show(res.status === 401 ? 'credenziali' : 'rete');
      const me = await res.json();
      // Con la chiave già configurata la si apre qui, mentre la password è ancora a portata.
      // Altrimenti (prima configurazione, password reimpostata) ci pensa la pagina /chiave.
      if (me.keys === 'ready') {
        try { await C.saveKey(me.user, await C.unwrapWithPassword(me.wrapped_dek, password, false)); }
        catch (err) { return show('chiave'); }
      }
      location.replace((me.keys === 'ready' ? '/' : '/chiave') + location.hash);
    } finally {
      go.disabled = false;
    }
  });
})();
