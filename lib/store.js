'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const COLLECTIONS = ['clients', 'projects', 'tasks', 'collaborators', 'fatture', 'costi'];
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function openStore(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
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
  `);

  const q = {
    list: db.prepare('SELECT id, data, updated_at FROM documents WHERE collection = ? ORDER BY id'),
    get: db.prepare('SELECT data, updated_at FROM documents WHERE collection = ? AND id = ?'),
    upsert: db.prepare(`INSERT INTO documents (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
    del: db.prepare('DELETE FROM documents WHERE collection = ? AND id = ?'),
    clear: db.prepare('DELETE FROM documents WHERE collection = ?'),
    user: db.prepare('SELECT username, password_hash FROM users WHERE username = ?'),
    users: db.prepare('SELECT username, created_at FROM users ORDER BY username'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    userUpsert: db.prepare(`INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)
      ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash`),
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

  return {
    db,
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

module.exports = { openStore, COLLECTIONS, ID_RE };
