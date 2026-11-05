/* Piccoli aiuti condivisi dalle pagine /chiave e /account. */
(function () {
  'use strict';

  const COLLECTIONS = ['clients', 'projects', 'tasks', 'collaborators', 'fatture', 'costi'];

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { return { status: 0, data: null }; }
    const data = await res.json().catch(() => null);
    if (res.status === 401 && data && data.error === 'unauthenticated') location.replace('/login');
    return { status: res.status, data };
  }

  // Messaggio in un <p class="msg">: kind = bad | warn | ok
  function say(el, kind, text) { el.className = 'msg ' + kind; el.textContent = text; el.hidden = false; }
  function hush(el) { el.hidden = true; }

  async function listAll() {
    const out = {};
    for (const col of COLLECTIONS) {
      const r = await api('GET', '/api/' + col);
      if (r.status !== 200) throw new Error('Non riesco a leggere ' + col);
      out[col] = r.data;
    }
    return out;
  }

  const MIN_PASSWORD = 10;
  function passwordProblem(a, b) {
    if (a.length < MIN_PASSWORD) return 'La nuova password deve avere almeno ' + MIN_PASSWORD + ' caratteri.';
    if (a !== b) return 'Le due password nuove non coincidono.';
    return '';
  }

  window.LanaPage = { COLLECTIONS, api, say, hush, listAll, passwordProblem };
})();
