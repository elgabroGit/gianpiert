/*
 * Sostituisce window.claude.use('db') della piattaforma claude.ai con le API di server.js.
 * I documenti sono cifrati qui, nel browser, con la chiave dei dati (public/crypto.js): il server
 * conserva e inoltra solo {_enc, iv, ct}. Senza la chiave aperta in questo browser si passa da /chiave.
 * Superficie usata dall'app (e solo quella):
 *   db.collection(nome).onSnapshot(ok, errore)  -> ok({docs:[{id, data()}]})
 *   db.doc('collezione/id').set(obj) / .update(parziale) / .delete()
 *   errori con .code: 'unavailable' (rete, 409, 5xx: l'app riprova una volta),
 *   'revoked' (sessione scaduta), 'invalid_argument' (403), 'quota_exceeded' (413).
 * Aggiornamenti in tempo reale da un unico EventSource su /api/stream; se cade,
 * polling ogni 3 secondi finché il flusso non si riapre.
 */
(function () {
  'use strict';

  const POLL_MS = 3000;
  const REOPEN_MS = 15000;

  const listeners = new Map(); // collezione -> Set({ok, err})
  const latest = new Map();    // collezione -> ultimi documenti [{id, data, updated_at}]
  const lastSeq = new Map();   // collezione -> seq dell'ultima istantanea applicata
  const versions = new Map();  // collezione -> Map(id -> updated_at), per If-Match

  let es = null, pollTimer = null, reopenTimer = null, startTimer = null, revoked = false;
  let C = null, dek = null; // LanaCrypto e chiave dei dati, pronte dopo ready()

  function fail(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  function codeFor(status) {
    if (status === 401) return 'revoked';
    if (status === 403) return 'invalid_argument';
    if (status === 413) return 'quota_exceeded';
    if (status === 404) return 'not_found';
    if (status === 400 || status === 415) return 'bad_request';
    return 'unavailable'; // 409 e 5xx
  }

  const verMap = col => { if (!versions.has(col)) versions.set(col, new Map()); return versions.get(col); };
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function makeSnapshot(docs) {
    const list = docs.map(d => ({ id: d.id, exists: true, data: () => clone(d.data) }));
    return { docs: list, size: list.length, empty: list.length === 0, forEach: fn => list.forEach(fn) };
  }

  const isStale = (col, seq) => typeof seq === 'number' && lastSeq.has(col) && seq <= lastSeq.get(col);

  async function apply(col, seq, docs) {
    if (isStale(col, seq)) return;
    const plain = [];
    let unreadable = 0;
    for (const d of docs) {
      try { plain.push({ id: d.id, updated_at: d.updated_at, data: await C.decryptDoc(dek, col, d.id, d.data) }); }
      catch (e) { unreadable++; console.error('Documento non apribile:', col, d.id, e.code || e); }
    }
    notice(unreadable);
    // Mentre decifravo può essere passata un'istantanea più recente: quella vince.
    if (isStale(col, seq)) return;
    if (typeof seq === 'number') lastSeq.set(col, seq);
    // Una nostra scrittura può avere una versione più recente di un'istantanea ancora in viaggio.
    const old = verMap(col), next = new Map();
    plain.forEach(d => next.set(d.id, Math.max(d.updated_at || 0, old.get(d.id) || 0)));
    versions.set(col, next);
    latest.set(col, plain);
    (listeners.get(col) || []).forEach(l => { try { l.ok(makeSnapshot(plain)); } catch (e) { console.error(e); } });
  }

  // Se dei documenti non si aprono con questa chiave lo dico, invece di far sembrare vuoto l'archivio.
  function notice(n) {
    let bar = document.getElementById('lana-cifratura');
    if (!n) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'lana-cifratura';
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;padding:10px 16px;background:#F4E6C9;color:#4A3000;font:14px/1.4 system-ui,sans-serif;text-align:center';
      document.body.append(bar);
    }
    bar.textContent = 'Alcuni dati non si aprono con la chiave di questo browser. Non modificare nulla: vai su Account, esci, rientra e riprova.';
  }

  function revoke() {
    if (revoked) return;
    revoked = true;
    stopPolling();
    clearTimeout(reopenTimer);
    if (es) { es.close(); es = null; }
    const e = fail('revoked', 'Sessione scaduta');
    listeners.forEach(set => set.forEach(l => { try { l.err && l.err(e); } catch (x) { console.error(x); } }));
  }

  /* ---------- polling di riserva ---------- */
  async function pollOnce() {
    for (const col of listeners.keys()) {
      let res;
      try { res = await fetch('/api/' + encodeURIComponent(col), { credentials: 'same-origin', cache: 'no-store' }); }
      catch (e) { return; } // rete assente: si riprova al prossimo giro
      if (res.status === 401) return revoke();
      if (!res.ok) continue;
      const seq = Number(res.headers.get('X-Lana-Seq'));
      await apply(col, Number.isFinite(seq) ? seq : undefined, await res.json());
    }
  }
  function startPolling() {
    if (pollTimer || revoked) return;
    const tick = async () => { await pollOnce(); if (pollTimer) pollTimer = setTimeout(tick, POLL_MS); };
    pollTimer = setTimeout(tick, 0);
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  /* ---------- flusso SSE ---------- */
  function openStream() {
    startTimer = null;
    if (revoked) return;
    if (es) { es.close(); es = null; }
    if (typeof EventSource !== 'function') return startPolling();
    const cols = [...listeners.keys()];
    es = new EventSource('/api/stream?c=' + cols.map(encodeURIComponent).join(','));
    es.addEventListener('snapshot', ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return console.error(e); }
      apply(m.collection, m.seq, m.docs || []).catch(e => console.error(e));
    });
    es.onopen = () => stopPolling();
    es.onerror = () => {
      startPolling();
      if (es && es.readyState === EventSource.CLOSED) {
        // Il browser non riprova da solo (es. risposta 401): il polling decide se la sessione è scaduta.
        es = null;
        clearTimeout(reopenTimer);
        reopenTimer = setTimeout(openStream, REOPEN_MS);
      }
    };
  }
  // L'app si iscrive alle sei collezioni in un ciclo sincrono: le raccolgo in un solo flusso.
  function scheduleStream() {
    if (startTimer || revoked) return;
    startTimer = setTimeout(openStream, 0);
  }

  /* ---------- scritture ---------- */
  // PUT con il documento cifrato; "update" unisce i campi qui, perché il server non può leggere il contenuto.
  async function send(method, col, id, data) {
    const headers = {};
    let body;
    let plain = null;
    if (method !== 'DELETE') {
      if (method === 'PATCH') {
        const cur = (latest.get(col) || []).find(d => d.id === id);
        if (!cur) throw fail('not_found', 'Documento inesistente');
        plain = Object.assign(clone(cur.data), data);
      } else plain = data;
      try { body = JSON.stringify(await C.encryptDoc(dek, col, id, plain)); }
      catch (e) { throw fail('invalid_argument', 'Impossibile cifrare il documento'); }
      headers['Content-Type'] = 'application/json';
    }
    const v = verMap(col).get(id);
    if (v && method !== 'DELETE') headers['If-Match'] = String(v);
    let res;
    try {
      res = await fetch('/api/' + encodeURIComponent(col) + '/' + encodeURIComponent(id), {
        method: method === 'PATCH' ? 'PUT' : method, headers, credentials: 'same-origin', cache: 'no-store', body,
      });
    } catch (e) {
      throw fail('unavailable', 'Server non raggiungibile');
    }
    if (!res.ok) {
      if (res.status === 401) revoke();
      throw fail(codeFor(res.status), 'HTTP ' + res.status);
    }
    if (method === 'DELETE') { verMap(col).delete(id); return; }
    const j = await res.json().catch(() => null);
    const nv = j && j.updated_at ? Math.max(j.updated_at, verMap(col).get(id) || 0) : null;
    if (nv) verMap(col).set(id, nv);
    // Ricordo subito il documento com'è ora: due modifiche ravvicinate non devono partire dalla stessa base.
    const list = (latest.get(col) || []).filter(d => d.id !== id);
    list.push({ id, data: clone(plain), updated_at: nv || v || 0 });
    latest.set(col, list);
  }

  function doc(path) {
    const parts = String(path || '').split('/');
    const bad = () => Promise.reject(fail('invalid_argument', 'Percorso non valido: ' + path));
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { set: bad, update: bad, delete: bad };
    const [col, id] = parts;
    const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
    return {
      id,
      path,
      set: data => (isObj(data) ? send('PUT', col, id, data) : bad()),
      update: data => (isObj(data) ? send('PATCH', col, id, data) : bad()),
      delete: () => send('DELETE', col, id),
    };
  }

  function collection(name) {
    return {
      id: name,
      doc: id => doc(name + '/' + id),
      onSnapshot(ok, err) {
        const l = { ok, err };
        const isNew = !listeners.has(name);
        if (isNew) listeners.set(name, new Set());
        listeners.get(name).add(l);
        if (revoked) { setTimeout(() => err && err(fail('revoked', 'Sessione scaduta')), 0); return () => {}; }
        if (latest.has(name)) setTimeout(() => ok(makeSnapshot(latest.get(name))), 0);
        if (isNew) scheduleStream();
        return () => {
          const set = listeners.get(name);
          if (set) { set.delete(l); if (!set.size) { listeners.delete(name); scheduleStream(); } }
        };
      },
    };
  }

  const db = { collection, doc };

  /* ---------- chiave dei dati ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src; el.onload = resolve; el.onerror = () => reject(new Error('Non riesco a caricare ' + src));
      document.head.append(el);
    });
  }
  const goKey = () => { location.replace('/chiave' + location.hash); return new Promise(() => {}); };

  let readyPromise = null;
  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      if (!window.LanaCrypto) await loadScript('/crypto.js');
      C = window.LanaCrypto;
      let res;
      try { res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }); }
      catch (e) { throw fail('unavailable', 'Server non raggiungibile'); }
      if (res.status === 401) { revoke(); throw fail('revoked', 'Sessione scaduta'); }
      if (!res.ok) throw fail('unavailable', 'HTTP ' + res.status);
      const me = await res.json();
      if (me.keys !== 'ready') return goKey();
      const k = await C.loadKey();
      if (!k || k.user !== String(me.user).toLowerCase()) return goKey();
      dek = k.dek;
    })().catch(e => { readyPromise = null; throw e; });
    return readyPromise;
  }

  window.claude = Object.assign(window.claude || {}, {
    use: async name => {
      if (name === 'db') { await ready(); return db; }
      throw fail('invalid_argument', 'Servizio non disponibile: ' + name);
    },
  });
})();
