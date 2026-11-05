'use strict';
/*
 * Prima installazione, ripetibile senza danni:
 *   node scripts/setup.js [--user nome]... [--skip-install]
 * 1. controlla che la versione di Node sia tra quelle supportate
 * 2. installa le dipendenze (npm ci)
 * 3. verifica che better-sqlite3 si carichi davvero (con la versione sbagliata di Node va in crash)
 * 4. crea .env da .env.example con un SESSION_SECRET casuale, se manca
 * 5. crea gli utenti richiesti con --user, con una password casuale stampata una sola volta
 * Usa solo moduli di Node: funziona anche prima di npm ci.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUPPORTED = [20, 22, 23, 24, 25]; // versioni con i binari precompilati di better-sqlite3 12.9.0
const RECOMMENDED = 24;

const args = process.argv.slice(2);
const users = args.flatMap((a, i) => (a === '--user' && args[i + 1] ? [args[i + 1]] : []));
const step = (n, msg) => console.log(`\n[${n}/5] ${msg}`);
const fail = (msg, code = 1) => { console.error(`\nERRORE: ${msg}`); process.exit(code); };

step(1, 'Versione di Node');
const major = parseInt(process.versions.node.split('.')[0], 10);
console.log(`Node ${process.versions.node} su ${process.platform}-${process.arch}`);
if (!SUPPORTED.includes(major)) {
  fail(`Node ${major} non è supportato. Servono le versioni ${SUPPORTED.join(', ')} (consigliata la ${RECOMMENDED}).\n` +
    `Con Node ${major} il database (better-sqlite3) non ha binari precompilati e andrebbe compilato.`, 2);
}

step(2, 'Dipendenze');
if (args.includes('--skip-install')) console.log('Saltato (--skip-install).');
else {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail('npm ci non è riuscito: leggi il messaggio qui sopra.', 3);
}

step(3, 'Database');
const probe = spawnSync(process.execPath, ['-e',
  "const D=require('better-sqlite3');console.log('SQLite '+new D(':memory:').prepare('select sqlite_version() v').get().v)"],
{ cwd: ROOT, encoding: 'utf8' });
if (probe.status !== 0) {
  fail(`better-sqlite3 non si carica (codice ${probe.status}${probe.signal ? ', segnale ' + probe.signal : ''}).\n` +
    `${(probe.stderr || '').trim().split('\n').slice(-3).join('\n')}\n` +
    'Di solito vuol dire Node di una versione non supportata, o node_modules installati con un altro Node: ' +
    'cancella la cartella node_modules e rilancia questo script.', 4);
}
console.log(probe.stdout.trim());

step(4, 'File .env');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) console.log('.env esiste già, lo lascio com\'è.');
else {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  fs.writeFileSync(envFile, example.replace(/^SESSION_SECRET=.*$/m, 'SESSION_SECRET=' + crypto.randomBytes(32).toString('hex')));
  console.log('Creato .env con un SESSION_SECRET casuale.');
}

step(5, 'Utenti');
const config = require('../lib/config');
const { openStore } = require('../lib/store');
const { authToken } = require('../public/crypto.js');
const bcrypt = require('bcryptjs');

(async () => {
  const store = openStore(config.dbFile);
  const created = [];
  for (const name of users) {
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(name)) { console.log(`Nome non valido, saltato: ${name}`); continue; }
    if (store.findUser(name)) { console.log(`${name} esiste già, password invariata.`); continue; }
    const pass = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    store.saveUser(name, bcrypt.hashSync(await authToken(name, pass), 12));
    created.push([name, pass]);
  }
  const all = store.listUsers().map(u => u.username);
  store.close();
  if (created.length) {
    console.log('Utenti creati con una password temporanea (mostrata solo ora; al primo accesso ognuno ne sceglie una sua):');
    created.forEach(([n, p]) => console.log(`  ${n}  ${p}`));
  }
  console.log(all.length ? `Utenti nel database: ${all.join(', ')}` : 'Nessun utente: rilancia con --user <nome>.');

  console.log(`\nPronto. Avvia con: npm start  (poi apri http://localhost:${config.port})`);
})();
