# CLAUDE.md

Gestionale "Lana Studio" (clienti, task, calendario, fatture, collaboratori) per Gianpiero e Mirko.
Frontend HTML/JS vanilla copiato dall'artifact claude.ai originale, server Express, archivio SQLite. Testi in italiano.

## Regole

- Per installare e avviare il progetto, anche su un computer senza Node, usa la skill `avvia-progetto`.
- Node dal 20 al 25 (consigliato 24): con Node 26+ `better-sqlite3` 12.9.0 non ha binari e si rompe.
- `public/index.html` è l'originale più poche righe che caricano `shim.js`, `enhance.css`, `enhance.js`:
  non modificarlo. I ritocchi grafici vanno in `public/enhance.css` ed `enhance.js`. `npm run check` lo verifica.
- Non committare `.env`, `data/` né i file `lana-export-*.json`.
- **Il server non deve mai vedere dati o password in chiaro.** I documenti si cifrano nel browser (`public/crypto.js`, `public/shim.js`), al server va solo un token derivato dalla password. Non aggiungere rotte o log che leggano il contenuto dei documenti, e non reintrodurre la password in chiaro nel login. Le pagine di accesso, chiave e account non hanno script inline (CSP in `server.js`).
- Un `<form>` in queste pagine ha sempre `method="post"`: se lo script non è ancora pronto, la password non deve finire nell'indirizzo.

## Comandi

- `npm run setup -- --user <nome>`: prima installazione (dipendenze, `.env`, utenti).
- `npm start`: http://localhost:3000 (`PORT` in `.env` per cambiarla). `npm run dev` riavvia a ogni modifica.
- `npm run check`: test di API, accesso, If-Match, SSE, export e import su un archivio temporaneo.
- `npm run user -- add|list|remove <nome>`, `npm run export`, `npm run import -- <file>` (questi due non funzionano a cifratura attiva: usare la pagina Account).

Struttura, API ed eventuale migrazione dei dati sono nel README.
