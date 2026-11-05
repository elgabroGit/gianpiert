/*
 * /account: caricare i dati (cifrandoli qui), scaricare una copia, cambiare password,
 * rinnovare la chiave di recupero, uscire. Il server non vede mai dati in chiaro né password.
 */
(function () {
  'use strict';
  const C = window.LanaCrypto, P = window.LanaPage, I = window.LanaImport;
  const $ = id => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = Object.assign(document.createElement(tag), props || {});
    kids.forEach(k => n.append(k));
    return n;
  };

  let me = null, dek = null;

  async function boot() {
    const r = await P.api('GET', '/api/me');
    if (r.status !== 200) return;
    me = r.data;
    if (me.keys !== 'ready') return location.replace('/chiave');
    const k = await C.loadKey();
    if (!k || k.user !== me.user.toLowerCase()) return location.replace('/chiave');
    dek = k.dek;
    $('who').textContent = 'Account di ' + me.user;
  }

  /* ---------- copia di sicurezza ---------- */
  async function buildBackup() {
    const all = await P.listAll();
    const collections = {};
    let bad = 0;
    for (const col of P.COLLECTIONS) {
      collections[col] = [];
      for (const d of all[col]) {
        try { collections[col].push({ id: d.id, data: await C.decryptDoc(dek, col, d.id, d.data), updated_at: d.updated_at }); }
        catch (e) { bad++; }
      }
    }
    return { bad, file: { format: 'lana-studio-export', version: 1, exportedAt: new Date().toISOString(), collections } };
  }

  function download(name, obj) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  $('do-backup').addEventListener('click', async () => {
    const m = $('m-backup'); P.hush(m);
    try {
      const { bad, file } = await buildBackup();
      download('lana-copia-' + stamp() + '.json', file);
      if (bad) P.say(m, 'warn', bad + ' documenti non si sono aperti e non sono nella copia.');
    } catch (e) { P.say(m, 'bad', 'Non sono riuscito a leggere i dati. Riprova.'); }
  });

  /* ---------- caricamento dati ---------- */
  let entries = []; // {name, raw, col (per gli elenchi), error, result}

  function resultOf(e) {
    e.result = null; e.error = '';
    try { e.result = I.extract(e.raw, e.col || null); }
    catch (err) { e.error = err.message; }
  }

  function renderPlan() {
    const body = $('plan-rows');
    body.replaceChildren();
    const ready = entries.length && entries.every(e => e.result);
    for (const e of entries) {
      const tr = el('tr');
      tr.append(el('td', { textContent: e.name }));
      const sel = el('td');
      if (e.isList) {
        const s = el('select', { ariaLabel: 'Sezione di ' + e.name });
        s.append(el('option', { value: '', textContent: 'Scegli…' }));
        I.COLLECTIONS.forEach(c => s.append(el('option', { value: c, textContent: I.LABELS[c], selected: e.col === c })));
        s.addEventListener('change', () => { e.col = s.value; resultOf(e); renderPlan(); });
        sel.append(s);
      } else sel.textContent = e.result ? Object.keys(e.result.byCol).map(c => I.LABELS[c]).join(', ') : '';
      tr.append(sel);
      const n = e.result ? Object.values(e.result.byCol).reduce((a, d) => a + d.length, 0) : 0;
      tr.append(el('td', { textContent: e.error && !(e.isList && !e.col) ? e.error : e.result ? String(n) : '' }));
      body.append(tr);
    }
    $('plan').hidden = !entries.length;
    $('modes').hidden = !ready;
    $('do-import').hidden = !ready;
  }

  $('files').addEventListener('change', async ev => {
    P.hush($('m-data'));
    entries = [];
    for (const f of ev.target.files) {
      const e = { name: f.name, raw: null, col: null, isList: false, result: null, error: '' };
      entries.push(e);
      try {
        e.raw = I.parseText(await f.text());
        e.isList = Array.isArray(e.raw);
        e.col = e.isList ? I.guessCollection(f.name) : null;
      } catch (err) { e.error = err.message; continue; }
      resultOf(e);
    }
    renderPlan();
  });

  $('do-import').addEventListener('click', async () => {
    const m = $('m-data'); P.hush(m);
    const btn = $('do-import');
    btn.disabled = true;
    try {
      const docs = I.combine(entries.map(e => e.result));
      const replace = document.querySelector('input[name="mode"]:checked').value === 'replace';
      if (replace) {
        const { file } = await buildBackup();
        download('lana-copia-prima-della-sostituzione-' + stamp() + '.json', file);
      }
      const collections = {};
      let total = 0;
      for (const [col, list] of Object.entries(docs)) {
        collections[col] = [];
        for (const d of list) { collections[col].push({ id: d.id, data: await C.encryptDoc(dek, col, d.id, d.data) }); total++; }
      }
      const body = { replace, collections };
      if (JSON.stringify(body).length > 24 * 1024 * 1024) return P.say(m, 'bad', 'I dati sono troppi per un solo caricamento. Dividili in più file e caricali uno alla volta.');
      const r = await P.api('POST', '/api/import', body);
      if (r.status !== 200) return P.say(m, 'bad', 'Il server ha rifiutato il caricamento (' + (r.data && r.data.error || r.status) + ').');
      P.say(m, 'ok', 'Caricati ' + total + ' documenti. Li trovi nel gestionale.');
      entries = []; $('files').value = ''; renderPlan();
    } catch (e) {
      console.error(e);
      P.say(m, 'bad', 'Qualcosa non ha funzionato. Riprova.');
    } finally { btn.disabled = false; }
  });

  /* ---------- password ---------- */
  $('f-pass').addEventListener('submit', async ev => {
    ev.preventDefault();
    const m = $('m-pass'); P.hush(m);
    const oldPw = $('p-old').value, newPw = $('p-new').value;
    if (!oldPw) return P.say(m, 'bad', 'Inserisci la password attuale.');
    const problem = P.passwordProblem(newPw, $('p-new2').value);
    if (problem) return P.say(m, 'bad', problem);
    $('do-pass').disabled = true;
    try {
      let key;
      try { key = await C.unwrapWithPassword(me.wrapped_dek, oldPw, true); }
      catch (e) { return P.say(m, 'bad', 'La password attuale non è corretta.'); }
      const wrapped = await C.wrapWithPassword(key, newPw);
      const r = await P.api('POST', '/api/account/password', {
        old_token: await C.authToken(me.user, oldPw), new_token: await C.authToken(me.user, newPw), wrapped_dek: wrapped,
      });
      if (r.status === 401) return P.say(m, 'bad', 'La password attuale non è corretta.');
      if (r.status === 429) return P.say(m, 'warn', 'Troppi tentativi. Riprova tra 15 minuti.');
      if (r.status !== 204) return P.say(m, 'bad', 'Non sono riuscito a salvare. Riprova.');
      me.wrapped_dek = wrapped;
      $('f-pass').reset();
      P.say(m, 'ok', 'Password cambiata.');
    } catch (e) {
      console.error(e); P.say(m, 'bad', 'Qualcosa non ha funzionato. Riprova.');
    } finally { $('do-pass').disabled = false; }
  });

  /* ---------- chiave di recupero ---------- */
  let newRecovery = null;
  $('do-rec').addEventListener('click', async () => {
    const m = $('m-rec'); P.hush(m);
    const pw = $('r-pw').value;
    if (!pw) return P.say(m, 'bad', 'Inserisci la tua password.');
    try {
      const key = await C.unwrapWithPassword(me.wrapped_dek, pw, true);
      newRecovery = { key: C.newRecoveryKey(), dek: key };
    } catch (e) { return P.say(m, 'bad', 'La password non è corretta.'); }
    $('rk').textContent = newRecovery.key;
    $('rec-new').hidden = false; $('saved').checked = false; $('rec-commit').disabled = true;
  });
  $('saved').addEventListener('change', e => { $('rec-commit').disabled = !e.target.checked; });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(newRecovery.key); $('copy').textContent = 'Copiata'; }
    catch (e) { $('copy').textContent = 'Seleziona e copia a mano'; }
  });
  $('print').addEventListener('click', () => window.print());
  $('rec-commit').addEventListener('click', async () => {
    const m = $('m-rec'); P.hush(m);
    $('rec-commit').disabled = true;
    try {
      const r = await P.api('PUT', '/api/keys/recovery', { recovery: await C.wrapWithRecovery(newRecovery.dek, newRecovery.key) });
      if (r.status !== 204) return P.say(m, 'bad', 'Non sono riuscito a salvare la nuova chiave. La vecchia vale ancora.');
      newRecovery = null; $('rec-new').hidden = true; $('r-pw').value = '';
      P.say(m, 'ok', 'Chiave sostituita. Quella vecchia non funziona più: ricordati di darla anche all\'altra persona.');
    } catch (e) { console.error(e); P.say(m, 'bad', 'Qualcosa non ha funzionato. Riprova.'); }
    finally { $('rec-commit').disabled = !$('saved').checked; }
  });

  $('out').addEventListener('click', async () => { await C.clearKey(); location.href = '/logout'; });

  boot();
})();
