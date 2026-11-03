'use strict';
// Gestione utenti: npm run user -- add <nome> | list | remove <nome> | hash
const readline = require('readline');
const bcrypt = require('bcryptjs');
const config = require('../lib/config');
const { openStore } = require('../lib/store');

const ROUNDS = 12;

function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

async function askPassword() {
  if (process.env.LANA_PASSWORD) return process.env.LANA_PASSWORD;
  const a = await ask('Password: ', true);
  const b = await ask('Ripeti la password: ', true);
  if (a !== b) throw new Error('Le due password non coincidono.');
  if (a.length < 8) throw new Error('Usa almeno 8 caratteri.');
  return a;
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  if (cmd === 'hash') {
    console.log(await bcrypt.hash(await askPassword(), ROUNDS));
    return;
  }
  const store = openStore(config.dbFile);
  try {
    if (cmd === 'add' && name) {
      if (!/^[A-Za-z0-9._-]{2,40}$/.test(name)) throw new Error('Nome utente: 2-40 caratteri tra lettere, numeri, punto, trattino.');
      const existed = !!store.findUser(name);
      store.saveUser(name, await bcrypt.hash(await askPassword(), ROUNDS));
      console.log(existed ? `Password aggiornata per ${name}.` : `Utente ${name} creato.`);
    } else if (cmd === 'remove' && name) {
      console.log(store.deleteUser(name) ? `Utente ${name} eliminato.` : `Nessun utente ${name}.`);
    } else if (cmd === 'list') {
      const us = store.listUsers();
      if (!us.length) console.log('Nessun utente.');
      us.forEach(u => console.log(`${u.username}  (creato il ${new Date(u.created_at).toLocaleString('it-IT')})`));
    } else {
      console.log('Uso: npm run user -- add <nome> | list | remove <nome> | hash');
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
