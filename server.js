'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const config = require('./lib/config');
const { openStore, COLLECTIONS, ID_RE } = require('./lib/store');

const store = openStore(config.dbFile);

// Utenti iniziali: usati solo se la tabella users è vuota. Formato "nome:hashbcrypt,nome:hashbcrypt".
if (config.initialUsers && store.countUsers() === 0) {
  for (const entry of config.initialUsers.split(',').map(s => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(':');
    const name = entry.slice(0, i).trim(), hash = entry.slice(i + 1).trim();
    if (i < 1 || !/^\$2[aby]\$\d\d\$/.test(hash)) { console.warn(`INITIAL_USERS: voce ignorata per "${name || entry}", serve nome:hashbcrypt`); continue; }
    store.saveUser(name, hash);
    console.log(`Utente creato da INITIAL_USERS: ${name}`);
  }
}
if (store.countUsers() === 0) console.warn('Nessun utente: creane uno con "npm run user -- add gianpiero".');

let secret = config.sessionSecret;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET non impostato: uso una chiave temporanea, le sessioni scadono al riavvio.');
}

const app = express();
app.disable('x-powered-by');
if (config.cookieSecure) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  next();
});
app.use(cookieSession({
  name: 'lana.sid',
  keys: [secret],
  maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: config.cookieSecure,
}));

/* ---------- accesso ---------- */
// La password non arriva mai al server: il browser manda un token derivato (public/crypto.js, authToken)
// e il server ne conserva solo l'hash bcrypt. Il token non permette di aprire i dati cifrati.
const VIEWS = path.join(__dirname, 'views');
const PUBLIC = path.join(__dirname, 'public');
const DUMMY_HASH = bcrypt.hashSync('nessun-utente', 10);
const TOKEN_RE = /^[0-9a-f]{64}$/;
const attempts = new Map(); // chiave -> {n, until}
const MAX_ATTEMPTS = 10, LOCK_MS = 15 * 60 * 1000;
const locked = key => { const a = attempts.get(key); return !!a && a.n >= MAX_ATTEMPTS && a.until > Date.now(); };
function strike(key) {
  const now = Date.now(), a = attempts.get(key);
  attempts.set(key, { n: (a && a.until > now ? a.n : 0) + 1, until: now + LOCK_MS });
  if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
}

// Le pagine di Lana (accesso, chiave, account) non hanno script inline: la CSP li vieta, così un
// eventuale testo iniettato non può leggere password e chiavi.
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
const htmlPage = file => (req, res) => res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP }).sendFile(path.join(VIEWS, file));
const asset = file => (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, file));

function meOf(u) {
  const on = store.encryptionOn();
  return { user: u.username, keys: !on ? 'none' : u.wrapped_dek ? 'ready' : 'locked', wrapped_dek: u.wrapped_dek ? JSON.parse(u.wrapped_dek) : null };
}

app.get('/login', (req, res, next) => {
  if (req.session.user) return res.redirect('/');
  htmlPage('login.html')(req, res, next);
});
app.get('/login/mark.png', (req, res) => res.type('png').sendFile(path.join(VIEWS, 'mark.png'), { maxAge: '7d' }));
app.get('/favicon.ico', (req, res) => res.type('png').sendFile(path.join(VIEWS, 'mark.png'), { maxAge: '7d' }));
app.get('/pagine.css', asset('pagine.css'));
app.get('/crypto.js', asset('crypto.js'));
app.get('/login.js', asset('login.js'));

app.post('/login', express.json({ limit: '2kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = req.ip;
  if (locked(ip)) return res.status(429).json({ error: 'troppi' });
  const body = req.body || {};
  const name = String(body.username || '').trim().slice(0, 60);
  const token = String(body.token || '');
  const user = name && TOKEN_RE.test(token) ? store.findUser(name) : null;
  const ok = await bcrypt.compare(token, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) { strike(ip); return res.status(401).json({ error: 'credenziali' }); }
  attempts.delete(ip);
  req.session.user = user.username;
  req.session.epoch = user.epoch;
  res.json(meOf(user));
});

function logout(req, res) { req.session = null; res.redirect(303, '/login'); }
app.get('/logout', logout);
app.post('/logout', logout);

app.use((req, res, next) => {
  const u = req.session.user && store.findUser(req.session.user);
  // L'epoca cambia con la password: le sessioni aperte altrove si chiudono.
  if (u && u.epoch === (req.session.epoch || 0)) { req.user = u; return next(); }
  req.session = null;
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
  res.redirect('/login');
});

/* ---------- app ---------- */
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').sendFile(path.join(PUBLIC, 'index.html'));
});
app.get(['/shim.js', '/enhance.js', '/enhance.css', '/importa.js', '/pagina.js', '/chiave.js', '/account.js'], (req, res) => asset(req.path.slice(1))(req, res));
app.get('/chiave', htmlPage('chiave.html'));
app.get('/account', htmlPage('account.html'));

/* ---------- API ---------- */
// Numero di revisione per collezione: cresce a ogni scrittura, così lo shim scarta
// istantanee arrivate fuori ordine (SSE e polling possono incrociarsi).
const seq = Object.fromEntries(COLLECTIONS.map(c => [c, Date.now()]));
const subscribers = new Set(); // {res, cols:Set}

function snapshot(col) { return { collection: col, seq: seq[col], docs: store.list(col) }; }
function sendEvent(res, payload) { res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`); }
function broadcast(col) {
  seq[col] += 1;
  let payload = null;
  for (const s of subscribers) {
    if (!s.cols.has(col)) continue;
    payload = payload || snapshot(col);
    sendEvent(s.res, payload);
  }
}

function openStream(req, res, cols) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const sub = { res, cols: new Set(cols) };
  subscribers.add(sub);
  cols.forEach(c => sendEvent(res, snapshot(c)));
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); subscribers.delete(sub); });
}

const api = express.Router();

/* --- chiavi, password e importazione (tutto cifrato nel browser) --- */
const BIG = express.json({ limit: '25mb' });

// Documenti cifrati nel formato {collezione: [{id, data: {_enc, iv, ct}}]}.
function readDocs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'collections_required' };
  const docs = {};
  for (const [col, arr] of Object.entries(raw)) {
    if (!COLLECTIONS.includes(col) || !Array.isArray(arr)) return { error: 'unknown_collection' };
    const ids = new Set();
    docs[col] = [];
    for (const d of arr) {
      if (!d || !ID_RE.test(String(d.id)) || ids.has(d.id) || !store.isEnvelope(d.data)) return { error: 'encryption_required' };
      ids.add(d.id);
      docs[col].push({ id: d.id, data: d.data });
    }
  }
  return { docs };
}

const passwordGate = (req, res, next) => (locked('p:' + req.user.username) ? res.status(429).json({ error: 'troppi' }) : next());
async function tokenOk(req, token) {
  if (!TOKEN_RE.test(String(token))) return false;
  const ok = await bcrypt.compare(token, req.user.password_hash);
  if (!ok) strike('p:' + req.user.username);
  return ok;
}

api.get('/me', (req, res) => res.set('Cache-Control', 'no-store').json(meOf(req.user)));

// Serve a pagine come /chiave e /account per controllare la password prima di avvolgere la chiave.
api.post('/account/check', express.json({ limit: '2kb' }), passwordGate, async (req, res) => {
  if (!(await tokenOk(req, (req.body || {}).token))) return res.status(401).json({ error: 'credenziali' });
  res.status(204).end();
});

// Cambio password. Con la cifratura attiva porta con sé il nuovo blocco della chiave, avvolto con la nuova password.
api.post('/account/password', express.json({ limit: '8kb' }), passwordGate, async (req, res) => {
  const { old_token, new_token, wrapped_dek } = req.body || {};
  if (!TOKEN_RE.test(String(new_token))) return res.status(400).json({ error: 'invalid_token' });
  if (store.encryptionOn() ? !store.isWrapped(wrapped_dek) : wrapped_dek != null) return res.status(400).json({ error: 'wrapped_required' });
  if (wrapped_dek && wrapped_dek.kdf !== 'pbkdf2-sha256') return res.status(400).json({ error: 'wrapped_kind' });
  if (!(await tokenOk(req, old_token))) return res.status(401).json({ error: 'credenziali' });
  req.session.epoch = store.changePassword(req.user.username, await bcrypt.hash(new_token, 12), wrapped_dek || null);
  attempts.delete('p:' + req.user.username);
  res.status(204).end();
});

api.get('/keys/recovery', (req, res) => {
  const recovery = store.getRecovery();
  if (!recovery) return res.status(404).json({ error: 'not_initialized' });
  res.set('Cache-Control', 'no-store').json({ recovery });
});

// Nuova chiave di recupero (la vecchia smette di funzionare). Il browser la manda già avvolta.
api.put('/keys/recovery', express.json({ limit: '8kb' }), (req, res) => {
  const recovery = (req.body || {}).recovery;
  if (!store.encryptionOn() || !req.user.wrapped_dek) return res.status(409).json({ error: 'keys_not_ready' });
  if (!store.isWrapped(recovery) || recovery.kdf !== 'recovery-v1') return res.status(400).json({ error: 'invalid_recovery' });
  store.setRecovery(recovery);
  res.status(204).end();
});

// Prima configurazione: un solo utente la fa una volta. Porta i due blocchi della chiave e
// le collezioni già presenti, cifrate dal browser.
api.post('/keys/setup', BIG, passwordGate, async (req, res) => {
  const { wrapped_dek, recovery, collections } = req.body || {};
  if (!store.isWrapped(wrapped_dek) || wrapped_dek.kdf !== 'pbkdf2-sha256' || !store.isWrapped(recovery) || recovery.kdf !== 'recovery-v1') return res.status(400).json({ error: 'invalid_keys' });
  const r = readDocs(collections || {});
  if (r.error) return res.status(400).json({ error: r.error });
  // La stessa richiesta può anche sostituire la password provvisoria: o cambia tutto o niente.
  const { old_token, new_token } = req.body;
  let newHash = null;
  if (new_token !== undefined) {
    if (!TOKEN_RE.test(String(new_token))) return res.status(400).json({ error: 'invalid_token' });
    if (!(await tokenOk(req, old_token))) return res.status(401).json({ error: 'credenziali' });
    newHash = await bcrypt.hash(new_token, 12);
  }
  try {
    const out = store.initEncryption(req.user.username, wrapped_dek, recovery, r.docs, newHash);
    if (newHash) req.session.epoch = store.findUser(req.user.username).epoch;
    if (out.status !== 200) return res.status(out.status).json({ error: out.error });
    store.scrub();
  } catch (e) {
    if (e.stale) return res.status(409).json({ error: 'stale' });
    throw e;
  }
  COLLECTIONS.forEach(broadcast);
  res.status(204).end();
});

api.post('/import', BIG, (req, res) => {
  if (!store.encryptionOn()) return res.status(409).json({ error: 'setup_required' });
  const r = readDocs((req.body || {}).collections);
  if (r.error) return res.status(400).json({ error: r.error });
  const counts = store.importDocs(r.docs, (req.body || {}).replace === true);
  Object.keys(r.docs).forEach(broadcast);
  res.json({ imported: counts });
});

api.use(express.json({ limit: '1mb' }));

// Un solo flusso per tutte le collezioni: con sei EventSource separati il browser
// esaurirebbe le sei connessioni HTTP/1.1 per dominio e le scritture resterebbero in coda.
api.get('/stream', (req, res) => {
  const asked = String(req.query.c || '').split(',').filter(Boolean);
  const cols = asked.length ? asked : COLLECTIONS;
  if (cols.some(c => !COLLECTIONS.includes(c))) return res.status(404).json({ error: 'unknown_collection' });
  openStream(req, res, cols);
});

api.param('collection', (req, res, next, col) => {
  if (!COLLECTIONS.includes(col)) return res.status(404).json({ error: 'unknown_collection' });
  next();
});
api.param('id', (req, res, next, id) => {
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid_id' });
  next();
});

api.get('/:collection/stream', (req, res) => openStream(req, res, [req.params.collection]));

api.get('/:collection', (req, res) => {
  const s = snapshot(req.params.collection);
  res.set({ 'Cache-Control': 'no-store', 'X-Lana-Seq': String(s.seq) }).json(s.docs);
});

function readIfMatch(req) {
  const h = req.get('If-Match');
  if (h == null || h === '') return { value: null };
  const v = Number(String(h).replace(/^W\//, '').replace(/"/g, '').trim());
  return Number.isSafeInteger(v) ? { value: v } : { error: true };
}

function writeRoute(kind) {
  return (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'body_must_be_object' });
    const im = readIfMatch(req);
    if (im.error) return res.status(400).json({ error: 'invalid_if_match' });
    // Con la cifratura attiva il server non può unire campi (PATCH) né accettare dati in chiaro.
    if (store.encryptionOn()) {
      if (kind === 'update') return res.status(405).json({ error: 'use_put' });
      if (!store.isEnvelope(body)) return res.status(400).json({ error: 'encryption_required' });
    }
    const { collection, id } = req.params;
    const r = store[kind](collection, id, body, im.value);
    if (r.status === 409) return res.status(409).json({ error: 'conflict', updated_at: r.updated_at });
    if (r.status === 404) return res.status(404).json({ error: 'not_found' });
    broadcast(collection);
    res.set('ETag', `"${r.updated_at}"`).json({ id, updated_at: r.updated_at });
  };
}
api.put('/:collection/:id', writeRoute('set'));
api.patch('/:collection/:id', writeRoute('update'));
api.delete('/:collection/:id', (req, res) => {
  const { collection, id } = req.params;
  if (store.remove(collection, id)) broadcast(collection);
  res.status(204).end();
});

api.use((req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});
app.use('/api', api);

app.use((req, res) => res.status(404).type('text').send('Pagina non trovata'));

const server = app.listen(config.port, () => {
  console.log(`Lana Studio su http://localhost:${config.port} (archivio: ${config.dbFile})`);
});

function shutdown() {
  for (const s of subscribers) s.res.end();
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
