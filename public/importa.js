/*
 * Lettura dei file di dati da caricare: stessi formati di `npm run import` (scripts/import.js).
 *  - il file di export: {collections: {clients: [{id, data, updated_at}], ...}}
 *  - un oggetto per collezione: {clients: [...], tasks: [...]}
 *  - un elenco JSON o un documento per riga (NDJSON), per una collezione sola: quella dell'artifact claude.ai
 *    ({id, data, version, updatedAt}). La collezione si ricava dal nome del file o si sceglie a mano.
 * Ogni documento può essere {id, data: {...}} oppure {id, ...campi}.
 * Uguale nel browser e in Node (test).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LanaImport = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const COLLECTIONS = ['clients', 'projects', 'tasks', 'collaborators', 'fatture', 'costi'];
  const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  const LABELS = { clients: 'Clienti', projects: 'Progetti', tasks: 'Task', collaborators: 'Collaboratori', fatture: 'Fatture', costi: 'Costi' };
  const ALIASES = {
    clients: ['clients', 'client', 'clienti', 'cliente'],
    projects: ['projects', 'project', 'progetti', 'progetto'],
    tasks: ['tasks', 'task', 'attivita'],
    collaborators: ['collaborators', 'collaborator', 'collaboratori', 'collaboratore'],
    fatture: ['fatture', 'fattura', 'invoices', 'invoice'],
    costi: ['costi', 'costo', 'costs', 'cost'],
  };

  function parseText(text) {
    text = String(text).replace(/^﻿/, '');
    try { return JSON.parse(text); } catch (e) {
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) throw new Error('Il file è vuoto.');
      return lines.map((l, i) => {
        try { return JSON.parse(l); } catch (err) { throw new Error('Il file non è JSON valido (riga ' + (i + 1) + ').'); }
      });
    }
  }

  // "clienti-2026.json" -> "clients"; null se il nome non dice nulla.
  function guessCollection(filename) {
    const base = String(filename).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z]+/g, ' ').trim().split(' ');
    for (const word of base) for (const [col, names] of Object.entries(ALIASES)) if (names.includes(word)) return col;
    return null;
  }

  function normDoc(d, col, i) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(LABELS[col] + ', elemento ' + (i + 1) + ': non è un oggetto.');
    let data;
    if (d.data && typeof d.data === 'object' && !Array.isArray(d.data)) data = d.data;
    else { data = Object.assign({}, d); delete data.id; }
    const id = String(d.id == null ? '' : d.id);
    if (!ID_RE.test(id)) throw new Error(LABELS[col] + ', elemento ' + (i + 1) + ': manca l\'id oppure non è valido.');
    return { id, data };
  }

  // Risultato: {byCol: {col: [{id, data}]}, ignored: [nomi non riconosciuti]}.
  // Se il file è un elenco senza collezione e non ne viene indicata una, lancia un errore con code 'need_collection'.
  function extract(raw, forcedCollection) {
    const byCol = {}, ignored = [];
    if (forcedCollection) {
      if (!COLLECTIONS.includes(forcedCollection)) throw new Error('Collezione sconosciuta.');
      const arr = Array.isArray(raw) ? raw : raw && raw.collections ? raw.collections[forcedCollection] : raw && raw[forcedCollection];
      if (!Array.isArray(arr)) throw new Error('Nel file non trovo un elenco di documenti per ' + LABELS[forcedCollection] + '.');
      byCol[forcedCollection] = arr;
    } else if (Array.isArray(raw)) {
      const e = new Error('Il file è un elenco: scegli a quale sezione appartiene.');
      e.code = 'need_collection';
      throw e;
    } else if (raw && typeof raw === 'object') {
      const src = raw.collections && typeof raw.collections === 'object' ? raw.collections : raw;
      for (const [k, v] of Object.entries(src)) {
        if (!COLLECTIONS.includes(k)) { if (Array.isArray(v)) ignored.push(k); continue; }
        if (!Array.isArray(v)) throw new Error('"' + k + '" non è un elenco di documenti.');
        byCol[k] = v;
      }
    } else {
      throw new Error('Formato non riconosciuto.');
    }
    const docs = {};
    for (const [col, arr] of Object.entries(byCol)) {
      const ids = new Set();
      docs[col] = arr.map((d, i) => {
        const n = normDoc(d, col, i);
        if (ids.has(n.id)) throw new Error(LABELS[col] + ': l\'id ' + n.id + ' compare due volte.');
        ids.add(n.id);
        return n;
      });
    }
    if (!Object.keys(docs).length) throw new Error('Nel file non trovo nessuna sezione del gestionale.');
    return { byCol: docs, ignored };
  }

  // Unisce i risultati di più file. Lo stesso id in due file: vale l'ultimo.
  function combine(results) {
    const out = {};
    for (const r of results) for (const [col, docs] of Object.entries(r.byCol)) {
      const m = out[col] || (out[col] = new Map());
      docs.forEach(d => m.set(d.id, d));
    }
    return Object.fromEntries(Object.entries(out).map(([c, m]) => [c, [...m.values()]]));
  }

  return { COLLECTIONS, LABELS, parseText, guessCollection, extract, combine };
});
