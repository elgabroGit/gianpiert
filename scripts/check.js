'use strict';
// npm run check: avvia il server su un archivio temporaneo e prova accesso, API, If-Match, SSE, export e import.
// Non tocca data/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { openStore } = require('../lib/store');
const C = require('../public/crypto.js');
const I = require('../public/importa.js');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lana-check-'));
const dbFile = path.join(tmp, 'check.sqlite');
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const env = { ...process.env, PORT: String(port), DB_FILE: dbFile, SESSION_SECRET: 'check-secret', INITIAL_USERS: '' };

let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? 'ok  ' : 'NO  '} ${label}`); if (!cond) failed++; };

let server;
async function start() {
  const s = openStore(dbFile);
  s.saveUser('gianpiero', bcrypt.hashSync(await C.authToken('gianpiero', 'password-provvisoria'), 4));
  s.close();
  server = spawn(process.execPath, [path.join(root, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write(d));
}

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
  await start();
  await waitUp();

  let r = await req('/');
  ok(r.status === 302 && r.headers.get('location') === '/login', 'HTML protetto: / senza sessione rimanda a /login');
  r = await req('/api/clients');
  ok(r.status === 401, 'API protette: 401 senza sessione');
  r = await req('/shim.js');
  ok(r.status === 302, 'shim.js protetto');

  const loginAs = async (u, pw) => req('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, token: await C.authToken(u, pw) }) });
  r = await loginAs('gianpiero', 'sbagliata');
  ok(r.status === 401, 'password sbagliata rifiutata');
  r = await req('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gianpiero', token: 'password-provvisoria' }) });
  ok(r.status === 401, 'la password in chiaro non è accettata al posto del token');
  r = await loginAs('Gianpiero', 'password-provvisoria');
  cookie = (r.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
  const me0 = await r.json();
  ok(r.status === 200 && cookie.includes('lana.sid') && me0.user === 'gianpiero' && me0.keys === 'none', 'accesso riuscito (nome senza distinzione di maiuscole), cifratura non ancora attiva');

  for (const f of ['/crypto.js', '/login.js', '/pagine.css']) ok((await fetch(base + f)).status === 200, `${f} pubblico (serve alla pagina di accesso)`);
  r = await fetch(base + '/login');
  ok(r.status === 200 && /script-src 'self'/.test(r.headers.get('content-security-policy') || '') && !/<script>/.test(await r.text()), 'pagina di accesso con CSP e senza script inline');

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
  for (const f of ['/enhance.css', '/enhance.js', '/importa.js', '/pagina.js', '/chiave.js', '/account.js', '/chiave', '/account']) {
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

  /* ---------- cifratura nel browser ---------- */
  // Un "browser" per ogni sessione: tiene i cookie e li aggiorna a ogni risposta.
  const browser = () => {
    const jar = {};
    const absorb = res => { for (const c of res.headers.getSetCookie() || []) { const [k, ...v] = c.split(';')[0].split('='); jar[k] = v.join('='); } return res; };
    const cookies = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const call = async (p, o = {}) => absorb(await fetch(base + p, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), Cookie: cookies() } }));
    const post = (p, body, method = 'POST') => call(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const login = async (u, pw) => absorb(await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies() }, body: JSON.stringify({ username: u, token: await C.authToken(u, pw) }) }));
    return { call, post, login };
  };
  const ITER = 100000; // più veloce nei test; il valore vero è C.PASSWORD_ITER
  const NEWPW = 'una-password-lunga-e-nuova';
  const tok = (u, p) => C.authToken(u, p);
  const gian = browser();
  r = await gian.login('gianpiero', 'password-provvisoria');
  ok(r.status === 200, 'cifratura: gianpiero entra con la password provvisoria');

  // Prima configurazione, con un documento già presente in chiaro (clients/k1 creato più sopra).
  const dek = await C.newDataKey();
  const recoveryKey = C.newRecoveryKey();
  const plainNow = await (await gian.call('/api/clients')).json();
  ok(plainNow.length === 1 && plainNow[0].data.name === 'Acme', 'prima della cifratura il documento è in chiaro');
  const setupBody = async extra => ({
    wrapped_dek: await C.wrapWithPassword(dek, NEWPW, ITER),
    recovery: await C.wrapWithRecovery(dek, recoveryKey),
    collections: { clients: await Promise.all(plainNow.map(async d => ({ id: d.id, data: await C.encryptDoc(dek, 'clients', d.id, d.data) }))) },
    ...extra,
  });
  r = await gian.post('/api/keys/setup', await setupBody({ old_token: await tok('gianpiero', 'sbagliata'), new_token: await tok('gianpiero', NEWPW) }));
  ok(r.status === 401, 'setup con la password provvisoria sbagliata: 401');
  r = await gian.post('/api/keys/setup', { ...(await setupBody()), collections: { clients: [{ id: 'k1', data: { name: 'in chiaro' } }] } });
  ok(r.status === 400, 'setup con dati in chiaro: 400');
  r = await gian.post('/api/keys/setup', await setupBody({ old_token: await tok('gianpiero', 'password-provvisoria'), new_token: await tok('gianpiero', NEWPW) }));
  ok(r.status === 204, 'setup: chiave, chiave di recupero e nuova password in un colpo solo');
  r = await gian.post('/api/keys/setup', await setupBody());
  ok(r.status === 409, 'setup una seconda volta: 409');
  r = await gian.call('/api/me');
  const meG = await r.json();
  ok(r.status === 200 && meG.keys === 'ready' && meG.wrapped_dek.kdf === 'pbkdf2-sha256', 'dopo il setup la sessione resta valida e la chiave è pronta');

  // Il server non vede più nulla in chiaro
  const stored = await (await gian.call('/api/clients')).json();
  ok(stored.length === 1 && C.isEnvelope(stored[0].data) && !JSON.stringify(stored).includes('Acme'), 'l\'elenco restituito dal server è solo cifrato');
  const raw = ['', '-wal'].map(x => { try { return fs.readFileSync(dbFile + x); } catch (e) { return Buffer.alloc(0); } });
  ok(raw.every(b => !b.includes('Acme') && !b.includes('nuova@b.it')), 'il file SQLite non contiene il testo in chiaro');
  ok((await C.decryptDoc(dek, 'clients', 'k1', stored[0].data)).email === 'nuova@b.it', 'il documento si apre con la chiave giusta');
  let swap = false;
  try { await C.decryptDoc(dek, 'clients', 'altro', stored[0].data); } catch (e) { swap = e.code === 'bad_key'; }
  ok(swap, 'un documento spostato su un altro id non si apre');

  r = await gian.post('/api/clients/k2', { name: 'in chiaro' }, 'PUT');
  ok(r.status === 400, 'scrittura in chiaro rifiutata a cifratura attiva');
  r = await gian.post('/api/clients/k1', { email: 'x' }, 'PATCH');
  ok(r.status === 405, 'PATCH rifiutato a cifratura attiva (si unisce nel browser)');
  r = await gian.post('/api/clients/k2', await C.encryptDoc(dek, 'clients', 'k2', { name: 'Beta' }), 'PUT');
  const vk2 = (await r.json()).updated_at;
  ok(r.status === 200 && Number.isInteger(vk2), 'scrittura cifrata accettata');
  r = await gian.post('/api/clients/k2', await C.encryptDoc(dek, 'clients', 'k2', { name: 'Beta 2' }), 'PUT');
  ok(r.status === 200, 'seconda scrittura cifrata');
  r = await fetch(base + '/api/clients/k2', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': String(vk2), Cookie: '' }, body: '{}' });
  ok(r.status === 401, 'senza sessione nessuna scrittura');

  // La password: la nuova vale, la provvisoria no
  r = await browser().login('gianpiero', 'password-provvisoria');
  ok(r.status === 401, 'la password provvisoria non vale più');
  const gian2 = browser();
  r = await gian2.login('gianpiero', NEWPW);
  const meG2 = await r.json();
  ok(r.status === 200 && meG2.keys === 'ready', 'la nuova password entra e trova la chiave pronta');
  const dek2 = await C.unwrapWithPassword(meG2.wrapped_dek, NEWPW, false);
  ok((await C.decryptDoc(dek2, 'clients', 'k1', stored[0].data)).name === 'Acme', 'la chiave avvolta con la password apre i dati');
  let wrongPw = false;
  try { await C.unwrapWithPassword(meG2.wrapped_dek, 'password-provvisoria'); } catch (e) { wrongPw = e.code === 'bad_key'; }
  ok(wrongPw, 'una password sbagliata non apre la chiave');

  // Seconda persona: entra con password provvisoria + chiave di recupero
  { const s = openStore(dbFile); s.saveUser('mirko', bcrypt.hashSync(await tok('mirko', 'provvisoria-mirko'), 4)); s.close(); }
  const mirko = browser();
  r = await mirko.login('mirko', 'provvisoria-mirko');
  ok(r.status === 200 && (await r.json()).keys === 'locked', 'secondo utente: la chiave è bloccata finché non usa la chiave di recupero');
  const blob = (await (await mirko.call('/api/keys/recovery')).json()).recovery;
  let badRec = false;
  try { await C.unwrapWithRecovery(blob, C.newRecoveryKey()); } catch (e) { badRec = e.code === 'bad_key'; }
  ok(badRec, 'una chiave di recupero sbagliata non apre nulla');
  const dekM = await C.unwrapWithRecovery(blob, recoveryKey.toLowerCase().replace(/-/g, ' '), true);
  const wrappedM = await C.wrapWithPassword(dekM, 'password-di-mirko-lunga', ITER);
  r = await mirko.post('/api/account/password', { old_token: await tok('mirko', 'sbagliata'), new_token: await tok('mirko', 'password-di-mirko-lunga'), wrapped_dek: wrappedM });
  ok(r.status === 401, 'cambio password con la provvisoria sbagliata: 401');
  r = await mirko.post('/api/account/password', { old_token: await tok('mirko', 'provvisoria-mirko'), new_token: await tok('mirko', 'password-di-mirko-lunga') });
  ok(r.status === 400, 'a cifratura attiva il cambio password deve portare il blocco della chiave');
  r = await mirko.post('/api/account/password', { old_token: await tok('mirko', 'provvisoria-mirko'), new_token: await tok('mirko', 'password-di-mirko-lunga'), wrapped_dek: wrappedM });
  ok(r.status === 204, 'secondo utente: nuova password e chiave in un colpo solo');
  const mirko2 = browser();
  const meM = await (await mirko2.login('mirko', 'password-di-mirko-lunga')).json();
  const dekM2 = await C.unwrapWithPassword(meM.wrapped_dek, 'password-di-mirko-lunga');
  ok(meM.keys === 'ready' && (await C.decryptDoc(dekM2, 'clients', 'k2', (await (await mirko2.call('/api/clients')).json()).find(d => d.id === 'k2').data)).name === 'Beta 2', 'il secondo utente legge i dati scritti dal primo');

  // Cambio password dal proprio account: chiude le altre sessioni
  r = await gian2.post('/api/account/password', { old_token: await tok('gianpiero', 'sbagliata'), new_token: await tok('gianpiero', 'terza-password-lunga'), wrapped_dek: await C.wrapWithPassword(dek, 'terza-password-lunga', ITER) });
  ok(r.status === 401, 'cambio password con quella attuale sbagliata: 401');
  r = await gian2.post('/api/account/password', { old_token: await tok('gianpiero', NEWPW), new_token: await tok('gianpiero', 'terza-password-lunga'), wrapped_dek: await C.wrapWithPassword(dek, 'terza-password-lunga', ITER) });
  ok(r.status === 204, 'cambio password dal proprio account');
  ok((await gian2.call('/api/me')).status === 200, 'la sessione che ha cambiato la password resta aperta');
  ok((await gian.call('/api/me')).status === 401, 'le altre sessioni dello stesso utente si chiudono');
  const gian3 = browser();
  const meG3 = await (await gian3.login('gianpiero', 'terza-password-lunga')).json();
  ok(meG3.keys === 'ready' && (await C.unwrapWithPassword(meG3.wrapped_dek, 'terza-password-lunga')), 'la terza password entra e apre la chiave');

  // Chiave di recupero nuova: la vecchia smette di valere
  const rec2 = C.newRecoveryKey();
  r = await gian3.post('/api/keys/recovery', { recovery: { v: 1, kdf: 'pbkdf2-sha256', iv: 'a', ct: 'b', iter: 1, salt: 'c' } }, 'PUT');
  ok(r.status === 400, 'chiave di recupero nel formato sbagliato: 400');
  r = await gian3.post('/api/keys/recovery', { recovery: await C.wrapWithRecovery(dek, rec2) }, 'PUT');
  ok(r.status === 204, 'chiave di recupero sostituita');
  const blob2 = (await (await gian3.call('/api/keys/recovery')).json()).recovery;
  let oldRec = false;
  try { await C.unwrapWithRecovery(blob2, recoveryKey); } catch (e) { oldRec = e.code === 'bad_key'; }
  ok(oldRec && (await C.unwrapWithRecovery(blob2, rec2)), 'la vecchia chiave di recupero non apre più, la nuova sì');

  // Importazione di dati cifrati
  const enc = async (col, id, data) => ({ id, data: await C.encryptDoc(dek, col, id, data) });
  r = await gian3.post('/api/import', { collections: { tasks: [{ id: 't1', data: { title: 'in chiaro' } }] } });
  ok(r.status === 400, 'importazione in chiaro rifiutata');
  r = await gian3.post('/api/import', { collections: { nope: [] } });
  ok(r.status === 400, 'importazione con collezione sconosciuta rifiutata');
  r = await gian3.post('/api/import', { collections: { tasks: [await enc('tasks', 't1', { title: 'Uno' }), await enc('tasks', 't2', { title: 'Due' })], clients: [await enc('clients', 'k9', { name: 'Nove' })] } });
  ok(r.status === 200, 'importazione cifrata (aggiungi)');
  let ids = (await (await gian3.call('/api/clients')).json()).map(d => d.id).sort().join();
  ok(ids === 'k1,k2,k9' && (await (await gian3.call('/api/tasks')).json()).length === 2, 'aggiungi lascia i documenti che c\'erano');
  r = await gian3.post('/api/import', { replace: true, collections: { clients: [await enc('clients', 'k5', { name: 'Cinque' })] } });
  ids = (await (await gian3.call('/api/clients')).json()).map(d => d.id).join();
  ok(r.status === 200 && ids === 'k5' && (await (await gian3.call('/api/tasks')).json()).length === 2, 'sostituisci svuota solo le sezioni importate');

  // Formati dei file (stessa logica dell'importazione da terminale)
  const ndj = I.extract(I.parseText('{"id":"a","data":{"x":1},"version":3,"updatedAt":"2026-10-01"}\n{"id":"b","y":2}'), 'clients');
  ok(ndj.byCol.clients.length === 2 && ndj.byCol.clients[0].data.x === 1 && !('id' in ndj.byCol.clients[1].data), 'file: NDJSON della piattaforma e formato piatto');
  ok(Object.keys(I.extract(I.parseText(JSON.stringify(ex))).byCol).includes('clients'), 'file: export completo');
  let needCol = false;
  try { I.extract([{ id: 'a' }]); } catch (e) { needCol = e.code === 'need_collection'; }
  ok(needCol && I.guessCollection('Fatture 2026.json') === 'fatture' && I.guessCollection('clienti.ndjson') === 'clients' && I.guessCollection('boh.json') === null, 'file: elenco senza sezione e nome del file');

  // Il terminale non può leggere né scrivere dati cifrati
  let refused = 0;
  for (const sc of ['export.js', 'import.js']) {
    try { execFileSync(process.execPath, [path.join(root, 'scripts', sc), sc === 'import.js' ? exportFile : path.join(tmp, 'no.json')], { env, stdio: 'pipe' }); } catch (e) { refused++; }
  }
  ok(refused === 2, 'export e import da terminale rifiutati a cifratura attiva');

  // Password reimpostata da chi amministra: il blocco della chiave si azzera, si rientra con la chiave di recupero
  { const s = openStore(dbFile); s.saveUser('mirko', bcrypt.hashSync(await tok('mirko', 'reset-da-admin'), 4)); s.close(); }
  ok((await mirko2.call('/api/me')).status === 401, 'reimpostare la password chiude le sessioni aperte');
  const meReset = await (await browser().login('mirko', 'reset-da-admin')).json();
  ok(meReset.keys === 'locked' && meReset.wrapped_dek === null, 'dopo il reset la chiave è bloccata e serve la chiave di recupero');

  // Blocco dopo troppi tentativi (per ultimo: vale per l'indirizzo)
  let last;
  for (let i = 0; i < 11; i++) last = await browser().login('gianpiero', 'sbagliata-' + i);
  ok(last.status === 429, 'troppi tentativi sbagliati: 429');
  r = await browser().login('gianpiero', 'terza-password-lunga');
  ok(r.status === 429, 'durante il blocco nemmeno la password giusta entra');

  r = await req('/logout');
  ok(r.status === 303 && r.headers.get('location') === '/login', 'logout rimanda a /login');
  cookie = '';
  r = await req('/api/clients');
  ok(r.status === 401, 'dopo il logout le API tornano a 401');
})().catch(e => { console.error(e); failed++; }).finally(() => {
  if (server) server.kill();
  setTimeout(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* file ancora aperto su Windows */ }
    console.log(failed ? `\n${failed} controlli falliti` : '\nTutti i controlli passati');
    process.exit(failed ? 1 : 0);
  }, 300);
});
