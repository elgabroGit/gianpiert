'use strict';
/*
 * npm run import -- <file> [--replace] [--dry-run] [--collection <nome>]
 *
 * Formati accettati:
 *  - il file di npm run export: {collections: {clients: [{id, data, updated_at}], ...}}
 *  - un oggetto per collezione: {clients: [...], tasks: [...]}
 *  - con --collection: un array JSON o un documento JSON per riga (NDJSON),
 *    per esempio l'output della piattaforma claude.ai ({id, data, version, updatedAt}).
 * Ogni documento può essere {id, data: {...}} oppure {id, ...campi}.
 *
 * --replace svuota prima le collezioni presenti nel file. Senza, i documenti
 * con lo stesso id vengono sostituiti e gli altri restano.
 */
const fs = require('fs');
const config = require('../lib/config');
const { openStore, COLLECTIONS, ID_RE } = require('../lib/store');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--collection');
const onlyCol = opt('--collection');

if (!file) {
  console.log('Uso: npm run import -- <file> [--replace] [--dry-run] [--collection <nome>]');
  process.exit(1);
}
if (onlyCol && !COLLECTIONS.includes(onlyCol)) {
  console.error(`Collezione sconosciuta: ${onlyCol}. Ammesse: ${COLLECTIONS.join(', ')}`);
  process.exit(1);
}

function parse(text) {
  text = text.replace(/^﻿/, '');
  try { return JSON.parse(text); } catch (e) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines.map((l, i) => {
      try { return JSON.parse(l); } catch (err) { throw new Error(`Riga ${i + 1} non è JSON valido`); }
    });
  }
}

function normDoc(d, col, i) {
  if (!d || typeof d !== 'object') throw new Error(`${col}[${i}]: non è un oggetto`);
  let id = d.id, data;
  if (d.data && typeof d.data === 'object' && !Array.isArray(d.data)) data = d.data;
  else { data = Object.assign({}, d); delete data.id; }
  id = String(id || '');
  if (!ID_RE.test(id)) throw new Error(`${col}[${i}]: id mancante o non valido (${JSON.stringify(d.id)})`);
  return { id, data };
}

const raw = parse(fs.readFileSync(file, 'utf8'));
let byCol = {};
if (onlyCol) {
  const arr = Array.isArray(raw) ? raw : raw.collections ? raw.collections[onlyCol] : raw[onlyCol];
  if (!Array.isArray(arr)) { console.error(`Nel file non trovo un elenco di documenti per ${onlyCol}.`); process.exit(1); }
  byCol[onlyCol] = arr;
} else if (Array.isArray(raw)) {
  console.error('Il file è un elenco senza nome di collezione: aggiungi --collection <nome>.');
  process.exit(1);
} else {
  const src = raw.collections && typeof raw.collections === 'object' ? raw.collections : raw;
  for (const [k, v] of Object.entries(src)) {
    if (!COLLECTIONS.includes(k)) { if (src === raw.collections || Array.isArray(v)) console.warn(`Ignoro la collezione sconosciuta "${k}"`); continue; }
    if (!Array.isArray(v)) { console.error(`"${k}" non è un elenco di documenti.`); process.exit(1); }
    byCol[k] = v;
  }
}

const docs = {};
for (const [col, arr] of Object.entries(byCol)) {
  docs[col] = arr.map((d, i) => normDoc(d, col, i));
  const ids = new Set();
  docs[col].forEach(d => { if (ids.has(d.id)) throw new Error(`${col}: id duplicato ${d.id}`); ids.add(d.id); });
}
if (!Object.keys(docs).length) { console.error('Nessuna collezione riconosciuta nel file.'); process.exit(1); }

const replace = flag('--replace');
console.log(`${flag('--dry-run') ? 'Prova (nessuna scrittura)' : 'Importazione'} da ${file}${replace ? ', con sostituzione delle collezioni' : ''}:`);
Object.entries(docs).forEach(([c, d]) => console.log(`  ${c}: ${d.length}`));
if (flag('--dry-run')) process.exit(0);

const store = openStore(config.dbFile);
store.importDocs(docs, replace);
store.close();
console.log(`Fatto. Archivio: ${config.dbFile}`);
console.log('Se il server è acceso, riavvialo: le pagine aperte si ricollegano da sole e ricevono i dati importati.');
