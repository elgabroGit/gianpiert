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
const VIEWS = path.join(__dirname, 'views');
const DUMMY_HASH = bcrypt.hashSync('nessun-utente', 10);
const attempts = new Map(); // ip -> {n, until}
const MAX_ATTEMPTS = 10, LOCK_MS = 15 * 60 * 1000;

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.set('Cache-Control', 'no-store').sendFile(path.join(VIEWS, 'login.html'));
});
app.get(['/login/mark.png', '/favicon.ico'], (req, res) => res.type('png').sendFile(path.join(VIEWS, 'mark.png'), { maxAge: '7d' }));

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip);
  if (a && a.n >= MAX_ATTEMPTS && a.until > Date.now()) return res.redirect(303, '/login?e=troppi');
  const name = String(req.body.username || '').trim();
  const pass = String(req.body.password || '');
  const user = name ? store.findUser(name) : null;
  const ok = await bcrypt.compare(pass, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    const cur = a && a.until > Date.now() ? a : { n: 0 };
    attempts.set(ip, { n: cur.n + 1, until: Date.now() + LOCK_MS });
    return res.redirect(303, '/login?e=1');
  }
  attempts.delete(ip);
  req.session.user = user.username;
  res.redirect(303, '/');
});

function logout(req, res) { req.session = null; res.redirect(303, '/login'); }
app.get('/logout', logout);
app.post('/logout', logout);

app.use((req, res, next) => {
  if (req.session.user && store.findUser(req.session.user)) return next();
  req.session = null;
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
  res.redirect('/login');
});

/* ---------- app ---------- */
const PUBLIC = path.join(__dirname, 'public');
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').sendFile(path.join(PUBLIC, 'index.html'));
});
app.get(['/shim.js', '/enhance.js', '/enhance.css'], (req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, req.path.slice(1)));
});

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
