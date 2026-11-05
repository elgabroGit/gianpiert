'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const COLLECTIONS = ['clients', 'projects', 'tasks', 'collaborators', 'fatture', 'costi'];
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const B64 = /^[A-Za-z0-9_-]+$/;

// Un documento cifrato dal browser: {_enc:1, iv, ct}. Il server non può leggerne il contenuto.
function isEnvelope(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === 3 && o._enc === 1
    && typeof o.iv === 'string' && o.iv.length === 16 && B64.test(o.iv) && typeof o.ct === 'string' && B64.test(o.ct);
}
// Blocco della chiave dei dati avvolta (con password o con chiave di recupero).
function isWrapped(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) && o.v === 1 && ['pbkdf2-sha256', 'recovery-v1'].includes(o.kdf)
    && typeof o.iv === 'string' && B64.test(o.iv) && typeof o.ct === 'string' && B64.test(o.ct)
    && (o.kdf !== 'pbkdf2-sha256' || (Number.isInteger(o.iter) && typeof o.salt === 'string' && B64.test(o.salt)));
}

function openStore(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // Cancellando o sovrascrivendo, SQLite di solito lascia il vecchio contenuto nelle pagine libere.
  // Con questa opzione lo azzera: serve perché i dati scritti prima della cifratura non restino leggibili.
  db.pragma('secure_delete = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  // Colonne aggiunte con la cifratura: chiave dei dati avvolta con la password dell'utente,
  // versione dell'accesso (1 = token derivato nel browser) ed epoca (cambia con la password e chiude le altre sessioni).
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userCols.includes('wrapped_dek')) db.exec('ALTER TABLE users ADD COLUMN wrapped_dek TEXT');
  if (!userCols.includes('auth_v')) db.exec('ALTER TABLE users ADD COLUMN auth_v INTEGER NOT NULL DEFAULT 0');
  if (!userCols.includes('epoch')) db.exec('ALTER TABLE users ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0');

  const q = {
    list: db.prepare('SELECT id, data, updated_at FROM documents WHERE collection = ? ORDER BY id'),
    get: db.prepare('SELECT data, updated_at FROM documents WHERE collection = ? AND id = ?'),
    upsert: db.prepare(`INSERT INTO documents (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
    del: db.prepare('DELETE FROM documents WHERE collection = ? AND id = ?'),
    clear: db.prepare('DELETE FROM documents WHERE collection = ?'),
    user: db.prepare('SELECT username, password_hash, wrapped_dek, auth_v, epoch FROM users WHERE username = ?'),
    users: db.prepare('SELECT username, created_at FROM users ORDER BY username'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    // Nuova password decisa da chi amministra: il blocco della chiave non si apre più con la nuova
    // password, quindi si azzera e l'utente rientra con la chiave di recupero.
    userUpsert: db.prepare(`INSERT INTO users (username, password_hash, auth_v, created_at) VALUES (?, ?, 1, ?)
      ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, auth_v = 1, wrapped_dek = NULL, epoch = epoch + 1`),
    userPassword: db.prepare('UPDATE users SET password_hash = ?, wrapped_dek = COALESCE(?, wrapped_dek), epoch = epoch + 1 WHERE username = ?'),
    userWrapped: db.prepare('UPDATE users SET wrapped_dek = ? WHERE username = ?'),
    studioGet: db.prepare('SELECT v FROM studio WHERE k = ?'),
    studioSet: db.prepare('INSERT INTO studio (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'),
    allData: db.prepare('SELECT collection, id, data FROM documents'),
    userDel: db.prepare('DELETE FROM users WHERE username = ?'),
  };

  // Strettamente crescente per documento, anche con due scritture nello stesso millisecondo:
  // updated_at fa da versione per If-Match.
  const nextVersion = prev => Math.max(Date.now(), (prev || 0) + 1);

  const list = col => q.list.all(col).map(r => ({ id: r.id, data: JSON.parse(r.data), updated_at: r.updated_at }));

  // ifMatch: null = nessun controllo; numero = il documento deve esistere con quella versione.
  const write = db.transaction((col, id, data, ifMatch, merge) => {
    const cur = q.get.get(col, id);
    if (ifMatch != null && (!cur || cur.updated_at !== ifMatch)) return { status: 409, updated_at: cur ? cur.updated_at : null };
    if (merge && !cur) return { status: 404 };
    const next = merge ? Object.assign(JSON.parse(cur.data), data) : data;
    const updated_at = nextVersion(cur && cur.updated_at);
    q.upsert.run(col, id, JSON.stringify(next), updated_at);
    return { status: 200, updated_at };
  });

  const importDocs = db.transaction((byCollection, replace) => {
    const counts = {};
    for (const [col, docs] of Object.entries(byCollection)) {
      if (replace) q.clear.run(col);
      for (const d of docs) q.upsert.run(col, d.id, JSON.stringify(d.data), nextVersion(d.updated_at));
      counts[col] = docs.length;
    }
    return counts;
  });

  const getStudio = k => { const r = q.studioGet.get(k); return r ? JSON.parse(r.v) : null; };
  const encryptionOn = () => getStudio('recovery') !== null;

  // Prima configurazione: salva i due blocchi della chiave e sostituisce le collezioni con le versioni
  // cifrate dal browser. Tutto o niente: se resta un documento in chiaro (qualcuno ha scritto nel
  // frattempo) si annulla e il browser riparte da dati aggiornati.
  const initEncryption = db.transaction((user, wrappedDek, recovery, byCollection, newHash) => {
    if (encryptionOn()) return { status: 409, error: 'already_initialized' };
    for (const [col, docs] of Object.entries(byCollection)) {
      q.clear.run(col);
      for (const d of docs) q.upsert.run(col, d.id, JSON.stringify(d.data), nextVersion(0));
    }
    for (const r of q.allData.all()) {
      if (!isEnvelope(JSON.parse(r.data))) throw Object.assign(new Error('stale'), { stale: true });
    }
    q.studioSet.run('recovery', JSON.stringify(recovery));
    q.userWrapped.run(JSON.stringify(wrappedDek), user);
    if (newHash) q.userPassword.run(newHash, null, user);
    return { status: 200 };
  });
  // Dopo la prima configurazione si ricostruisce il file e si svuota il registro WAL, così le copie
  // in chiaro scritte prima non restano nemmeno nelle pagine vecchie.
  const scrub = () => { db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); };

  return {
    db,
    isEnvelope,
    isWrapped,
    encryptionOn,
    getRecovery: () => getStudio('recovery'),
    setRecovery: recovery => q.studioSet.run('recovery', JSON.stringify(recovery)),
    initEncryption,
    scrub,
    changePassword: (name, hash, wrappedDek) => {
      q.userPassword.run(hash, wrappedDek ? JSON.stringify(wrappedDek) : null, name);
      return q.user.get(name).epoch;
    },
    list,
    set: (col, id, data, ifMatch) => write(col, id, data, ifMatch, false),
    update: (col, id, data, ifMatch) => write(col, id, data, ifMatch, true),
    remove: (col, id) => q.del.run(col, id).changes > 0,
    importDocs,
    findUser: name => q.user.get(name),
    listUsers: () => q.users.all(),
    countUsers: () => q.userCount.get().n,
    saveUser: (name, hash) => q.userUpsert.run(name, hash, Date.now()),
    deleteUser: name => q.userDel.run(name).changes > 0,
    close: () => db.close(),
  };
}

module.exports = { openStore, COLLECTIONS, ID_RE, isEnvelope, isWrapped };
