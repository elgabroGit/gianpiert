/*
 * Sostituisce window.claude.use('db') della piattaforma claude.ai con le API di server.js.
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

  function apply(col, seq, docs) {
    if (typeof seq === 'number' && lastSeq.has(col) && seq <= lastSeq.get(col)) return;
    if (typeof seq === 'number') lastSeq.set(col, seq);
    // Una nostra scrittura può avere una versione più recente di un'istantanea ancora in viaggio.
    const old = verMap(col), next = new Map();
    docs.forEach(d => next.set(d.id, Math.max(d.updated_at || 0, old.get(d.id) || 0)));
    versions.set(col, next);
    latest.set(col, docs);
    (listeners.get(col) || []).forEach(l => { try { l.ok(makeSnapshot(docs)); } catch (e) { console.error(e); } });
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
      apply(col, Number.isFinite(seq) ? seq : undefined, await res.json());
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
      try { const m = JSON.parse(ev.data); apply(m.collection, m.seq, m.docs || []); } catch (e) { console.error(e); }
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
  async function send(method, col, id, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const v = verMap(col).get(id);
    if (v && method !== 'DELETE') headers['If-Match'] = String(v);
    let res;
    try {
      res = await fetch('/api/' + encodeURIComponent(col) + '/' + encodeURIComponent(id), {
        method, headers, credentials: 'same-origin', cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
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
    if (j && j.updated_at) verMap(col).set(id, Math.max(j.updated_at, verMap(col).get(id) || 0));
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

  window.claude = Object.assign(window.claude || {}, {
    use: async name => {
      if (name === 'db') return db;
      throw fail('invalid_argument', 'Servizio non disponibile: ' + name);
    },
  });
})();
