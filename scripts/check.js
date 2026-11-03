'use strict';
// npm run check: avvia il server su un archivio temporaneo e prova accesso, API, If-Match, SSE, export e import.
// Non tocca data/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { openStore } = require('../lib/store');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lana-check-'));
const dbFile = path.join(tmp, 'check.sqlite');
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const env = { ...process.env, PORT: String(port), DB_FILE: dbFile, SESSION_SECRET: 'check-secret', INITIAL_USERS: '' };

let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? 'ok  ' : 'NO  '} ${label}`); if (!cond) failed++; };

const s = openStore(dbFile);
s.saveUser('gianpiero', bcrypt.hashSync('password-di-prova', 4));
s.close();

const server = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', d => process.stderr.write(d));

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/login'); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('il server non parte');
}

let cookie = '';
const req = (p, o = {}) => fetch(base + p, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
const json = (method, p, body, extra) => req(p, { method, headers: { 'Content-Type': 'application/json', ...(extra || {}) }, body: JSON.stringify(body) });

async function readSse(p, wantEvents) {
  const ctrl = new AbortController();
  const res = await req(p, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  while (events.length < wantEvents) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split('\n').find(l => l.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }
  ctrl.abort();
  return { res, events };
}

(async () => {
  await waitUp();

  let r = await req('/');
  ok(r.status === 302 && r.headers.get('location') === '/login', 'HTML protetto: / senza sessione rimanda a /login');
  r = await req('/api/clients');
  ok(r.status === 401, 'API protette: 401 senza sessione');
  r = await req('/shim.js');
  ok(r.status === 302, 'shim.js protetto');

  r = await req('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=gianpiero&password=sbagliata' });
  ok(r.status === 303 && r.headers.get('location') === '/login?e=1', 'password sbagliata rifiutata');
  r = await req('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=Gianpiero&password=password-di-prova' });
  cookie = (r.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
  ok(r.status === 303 && r.headers.get('location') === '/' && cookie.includes('lana.sid'), 'accesso riuscito (nome senza distinzione di maiuscole)');

  r = await req('/');
  const html = await r.text();
  // index.html deve restare l'originale più queste righe aggiunte, e nient'altro
  const ADDED = [
    '<link rel="stylesheet" href="/enhance.css">',
    '<meta name="theme-color" content="#F2F2EF" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#0E0E0D" media="(prefers-color-scheme: dark)">',
    '<script src="/shim.js"></script>',
    '<script src="/enhance.js"></script>',
  ];
  const orig = fs.readFileSync(path.join(root, 'lana-gestionale-originale.html'), 'utf8');
  ok(r.status === 200 && html.split('\n').filter(l => !ADDED.includes(l)).join('\n') === orig && ADDED.every(l => html.includes(l)),
    'index.html = originale + solo le righe di shim ed enhance');
  for (const f of ['/enhance.css', '/enhance.js']) {
    const a = await req(f);
    ok(a.status === 200, `${f} servito con la sessione`);
  }

  r = await req('/api/nonesiste');
  ok(r.status === 404, 'collezione non ammessa: 404');
  r = await json('PUT', '/api/clients/a%20b', { name: 'x' });
  ok(r.status === 400, 'id non valido: 400');
  r = await json('PUT', '/api/clients/k1', [1, 2]);
  ok(r.status === 400, 'corpo non oggetto: 400');

  r = await json('PUT', '/api/clients/k1', { name: 'Acme', email: 'a@b.it', notes: '' });
  const v1 = (await r.json()).updated_at;
  ok(r.status === 200 && Number.isInteger(v1), 'PUT crea il documento e restituisce updated_at');

  r = await json('PATCH', '/api/clients/k1', { email: 'nuova@b.it' }, { 'If-Match': String(v1) });
  const v2 = (await r.json()).updated_at;
  ok(r.status === 200 && v2 > v1, 'PATCH con If-Match corretto');

  r = await json('PATCH', '/api/clients/k1', { notes: 'vecchia versione' }, { 'If-Match': String(v1) });
  ok(r.status === 409, 'PATCH con If-Match superato: 409');
  r = await json('PUT', '/api/clients/k1', { name: 'Sovrascritto' }, { 'If-Match': String(v1) });
  ok(r.status === 409, 'PUT con If-Match superato: 409');

  r = await req('/api/clients');
  let list = await r.json();
  ok(list.length === 1 && list[0].data.name === 'Acme' && list[0].data.email === 'nuova@b.it' && list[0].data.notes === '' && list[0].updated_at === v2,
    'GET elenco: merge dei campi e versione corrente');
  ok(Number(r.headers.get('X-Lana-Seq')) > 0, 'GET elenco espone X-Lana-Seq');

  r = await json('PATCH', '/api/tasks/assente', { done: true });
  ok(r.status === 404, 'PATCH su documento inesistente: 404');

  r = await json('PUT', '/api/tasks/t1', { title: 'Prima', done: false, doneAt: null });
  ok(r.status === 200, 'PUT task');
  r = await json('PATCH', '/api/tasks/t1', { done: true, doneAt: 123 });
  ok(r.status === 200, 'PATCH senza If-Match accettato');

  // SSE per collezione: istantanea iniziale, poi una nuova a ogni modifica
  const p1 = readSse('/api/tasks/stream', 2);
  await new Promise(res => setTimeout(res, 150));
  await json('PATCH', '/api/tasks/t1', { title: 'Rinominata' });
  const { res: sres, events } = await p1;
  ok(sres.headers.get('content-type').startsWith('text/event-stream'), 'stream SSE per collezione');
  ok(events.length === 2 && events[0].docs[0].data.title === 'Prima' && events[1].docs[0].data.title === 'Rinominata' && events[1].seq > events[0].seq,
    'SSE: istantanea iniziale e aggiornamento dopo la modifica');

  const multi = await readSse('/api/stream?c=clients,tasks', 2);
  ok(multi.events.map(e => e.collection).sort().join() === 'clients,tasks', 'stream unico: una istantanea per collezione richiesta');

  r = await req('/api/tasks/t1', { method: 'DELETE' });
  ok(r.status === 204, 'DELETE');
  list = await (await req('/api/tasks')).json();
  ok(list.length === 0, 'documento eliminato');

  // export e import
  const exportFile = path.join(tmp, 'export.json');
  execFileSync(process.execPath, [path.join(root, 'scripts/export.js'), exportFile], { env });
  const ex = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  ok(ex.collections.clients.length === 1 && ex.collections.clients[0].data.name === 'Acme', 'export');

  const dbFile2 = path.join(tmp, 'import.sqlite');
  const env2 = { ...env, DB_FILE: dbFile2 };
  execFileSync(process.execPath, [path.join(root, 'scripts/import.js'), exportFile], { env: env2 });
  const ndjson = path.join(tmp, 'tasks.ndjson');
  fs.writeFileSync(ndjson, [
    { id: 't9', data: { title: 'Da piattaforma', done: false }, version: 3, updatedAt: '2026-10-01T10:00:00Z' },
    { id: 't10', title: 'Piatto', done: true },
  ].map(o => JSON.stringify(o)).join('\n'));
  execFileSync(process.execPath, [path.join(root, 'scripts/import.js'), ndjson, '--collection', 'tasks'], { env: env2 });
  const s2 = openStore(dbFile2);
  const c2 = s2.list('clients'), t2 = s2.list('tasks');
  s2.close();
  ok(c2.length === 1 && c2[0].data.email === 'nuova@b.it', 'import del file di export');
  ok(t2.length === 2 && t2.find(t => t.id === 't9').data.title === 'Da piattaforma' && !('id' in t2.find(t => t.id === 't10').data),
    'import NDJSON nel formato della piattaforma e nel formato piatto');

  r = await req('/logout');
  ok(r.status === 303 && r.headers.get('location') === '/login', 'logout rimanda a /login');
  cookie = '';
  r = await req('/api/clients');
  ok(r.status === 401, 'dopo il logout le API tornano a 401');
})().catch(e => { console.error(e); failed++; }).finally(() => {
  server.kill();
  setTimeout(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* file ancora aperto su Windows */ }
    console.log(failed ? `\n${failed} controlli falliti` : '\nTutti i controlli passati');
    process.exit(failed ? 1 : 0);
  }, 300);
});
