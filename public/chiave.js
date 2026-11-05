/*
 * /chiave: prima configurazione della cifratura, ingresso della seconda persona con la chiave di
 * recupero, riapertura della chiave su un browser nuovo. Qui la password serve ancora in chiaro
 * (nel browser) per avvolgere la chiave dei dati; al server arrivano solo token e blocchi cifrati.
 */
(function () {
  'use strict';
  const C = window.LanaCrypto, P = window.LanaPage;
  const $ = id => document.getElementById(id);
  const form = $('f1'), msg = $('msg'), go = $('go');
  const show = (id, on) => { $(id).hidden = !on; };

  let me = null, mode = null; // mode: none | locked | ready
  let pending = null;          // prima configurazione: {dek, recoveryKey, newPassword, oldToken}

  const TEXT = {
    none: ['Proteggi i dati', "Lo studio non ha ancora una chiave. Qui la crei: da quel momento i dati vengono cifrati nel browser e sul server restano illeggibili, anche per chi amministra la macchina. Scegli anche la tua password: sostituisce quella provvisoria."],
    locked: ['Apri i dati dello studio', "La cifratura è già attiva. Per entrare servono la chiave di recupero dello studio (te l'ha data l'altra persona) e una tua nuova password. Quella provvisoria serve solo ora."],
    ready: ['Apri i dati', "Su questo browser la chiave non è ancora aperta. Inserisci la tua password."],
  };

  async function init() {
    const r = await P.api('GET', '/api/me');
    if (r.status !== 200) return P.say(msg, 'bad', 'Il server non risponde. Ricarica la pagina.');
    me = r.data; mode = me.keys;
    $('title').textContent = TEXT[mode][0];
    $('lead').textContent = TEXT[mode][1];
    $('l-old').textContent = mode === 'ready' ? 'Password' : 'Password provvisoria';
    show('g-rec', mode === 'locked');
    show('g-new', mode !== 'ready');
    show('g-new2', mode !== 'ready');
    $('old').focus();
  }

  async function checkOld(token) {
    const r = await P.api('POST', '/api/account/check', { token });
    if (r.status === 204) return true;
    P.say(msg, r.status === 429 ? 'warn' : 'bad', r.status === 429 ? 'Troppi tentativi. Riprova tra 15 minuti.' : 'La password non è corretta.');
    return false;
  }

  async function finishWith(newPassword, wrapped) {
    await C.saveKey(me.user, await C.unwrapWithPassword(wrapped, newPassword, false));
    location.replace('/' + location.hash);
  }

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    P.hush(msg);
    const oldPw = $('old').value;
    if (!oldPw) return P.say(msg, 'bad', 'Inserisci la password.');
    go.disabled = true;
    try {
      if (mode === 'ready') {
        try { return await finishWith(oldPw, me.wrapped_dek); }
        catch (e) { return P.say(msg, 'bad', 'Password non corretta, oppure la chiave non si apre con questa password.'); }
      }
      const newPw = $('new').value;
      const problem = P.passwordProblem(newPw, $('new2').value);
      if (problem) return P.say(msg, 'bad', problem);
      const oldToken = await C.authToken(me.user, oldPw);
      if (mode === 'none') {
        if (!(await checkOld(oldToken))) return;
        pending = { dek: await C.newDataKey(), recoveryKey: C.newRecoveryKey(), newPassword: newPw, oldToken };
        $('rk').textContent = pending.recoveryKey;
        show('f1', false); show('s2', true);
        return;
      }
      // locked: prima la chiave di recupero (se è sbagliata non si consuma nessun tentativo di password)
      let recKey = C.normalizeRecoveryKey($('rec').value);
      if (!recKey) return P.say(msg, 'bad', 'La chiave di recupero non è nel formato giusto: 32 lettere e cifre, a gruppi di 4.');
      const blob = await P.api('GET', '/api/keys/recovery');
      if (blob.status !== 200) return P.say(msg, 'bad', 'Non trovo la chiave dello studio sul server.');
      let dek;
      try { dek = await C.unwrapWithRecovery(blob.data.recovery, recKey, true); }
      catch (e) { return P.say(msg, 'bad', 'La chiave di recupero non è quella giusta.'); }
      const wrapped = await C.wrapWithPassword(dek, newPw);
      const r = await P.api('POST', '/api/account/password', { old_token: oldToken, new_token: await C.authToken(me.user, newPw), wrapped_dek: wrapped });
      if (r.status === 401) return P.say(msg, 'bad', 'La password provvisoria non è corretta.');
      if (r.status === 429) return P.say(msg, 'warn', 'Troppi tentativi. Riprova tra 15 minuti.');
      if (r.status !== 204) return P.say(msg, 'bad', 'Non sono riuscito a salvare. Riprova.');
      await finishWith(newPw, wrapped);
    } catch (e) {
      console.error(e);
      P.say(msg, 'bad', e.code === 'no_crypto' ? e.message : 'Qualcosa non ha funzionato. Riprova.');
    } finally {
      go.disabled = false;
    }
  });

  /* ---------- prima configurazione, passo 2: chiave di recupero e attivazione ---------- */
  $('saved').addEventListener('change', e => { $('finish').disabled = !e.target.checked; });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pending.recoveryKey); $('copy').textContent = 'Copiata'; }
    catch (e) { $('copy').textContent = 'Seleziona e copia a mano'; }
  });
  $('print').addEventListener('click', () => window.print());

  $('finish').addEventListener('click', async () => {
    const msg2 = $('msg2');
    P.hush(msg2);
    $('finish').disabled = true;
    try {
      const { dek, recoveryKey, newPassword, oldToken } = pending;
      // Se nell'archivio ci sono già dati in chiaro (prima della cifratura), si cifrano qui nel browser.
      const plain = await P.listAll();
      const collections = {};
      for (const col of P.COLLECTIONS) {
        collections[col] = [];
        for (const d of plain[col]) collections[col].push({ id: d.id, data: await C.encryptDoc(dek, col, d.id, d.data) });
      }
      const wrapped = await C.wrapWithPassword(dek, newPassword);
      const r = await P.api('POST', '/api/keys/setup', {
        wrapped_dek: wrapped,
        recovery: await C.wrapWithRecovery(dek, recoveryKey),
        collections,
        old_token: oldToken,
        new_token: await C.authToken(me.user, newPassword),
      });
      if (r.status === 409 && r.data && r.data.error === 'stale') return P.say(msg2, 'warn', 'Qualcuno ha modificato i dati mentre cifravo. Premi di nuovo il pulsante.');
      if (r.status === 409) { location.replace('/chiave'); return; }
      if (r.status !== 204) return P.say(msg2, 'bad', 'Non sono riuscito ad attivare la cifratura. Riprova.');
      pending = null;
      await finishWith(newPassword, wrapped);
    } catch (e) {
      console.error(e);
      P.say(msg2, 'bad', 'Qualcosa non ha funzionato. Riprova.');
    } finally {
      if (pending) $('finish').disabled = !$('saved').checked;
    }
  });

  $('out').addEventListener('click', async () => { await C.clearKey(); location.href = '/logout'; });

  init();
})();
