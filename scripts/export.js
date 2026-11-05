'use strict';
// npm run export [-- percorso.json]  scrive tutti i documenti di tutte le collezioni.
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { openStore, COLLECTIONS } = require('../lib/store');

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const out = path.resolve(process.argv[2] || `lana-export-${stamp}.json`);

const store = openStore(config.dbFile);
if (store.encryptionOn()) { store.close(); console.error("L'archivio è cifrato nel browser: da qui non si può leggere. Scarica la copia dalla pagina Account (/account)."); process.exit(1); }
const collections = {};
for (const col of COLLECTIONS) collections[col] = store.list(col);
store.close();

fs.writeFileSync(out, JSON.stringify({ format: 'lana-studio-export', version: 1, exportedAt: new Date().toISOString(), collections }, null, 2));
const total = Object.values(collections).reduce((n, d) => n + d.length, 0);
console.log(`Esportati ${total} documenti in ${out}`);
COLLECTIONS.forEach(c => console.log(`  ${c}: ${collections[c].length}`));
