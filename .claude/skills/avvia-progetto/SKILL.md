---
name: avvia-progetto
description: Installa tutto il necessario (Node.js nella versione giusta, dipendenze, file .env, utenti) e fa partire il gestionale Lana Studio su qualsiasi sistema (Windows, macOS, Linux), anche su un computer dove Node non c'è. Usala quando chiedono di far partire, avviare, installare o configurare il progetto, dopo un git clone, o quando npm/node danno errori all'avvio.
---

# Avviare Lana Studio da zero

Chi ti chiede di avviare il progetto probabilmente non è uno sviluppatore e non ha Node installato.
Fai tu i passi, spiegando in parole semplici cosa succede. Chiedi conferma prima di installare
programmi sul sistema e avvisa quando comparirà una richiesta di password o di autorizzazione.

## Il vincolo che conta: Node dal 20 al 25, consigliato il 24

Il database usa `better-sqlite3` 12.9.0, che ha binari precompilati solo per **Node 20, 22, 23, 24 e 25**
(Windows, macOS Intel e Apple Silicon, Linux, x64 e arm64). Con **Node 26 o successivi** l'installazione
prova a compilarlo e fallisce, oppure il processo va in crash con un "segmentation fault".
Attenzione: "l'ultima LTS" proposta da nodejs.org o dagli installatori può essere la 26. **Installa la 24.**
Non aggiornare `better-sqlite3` per aggirare il problema: le versioni successive escludono Node 20.

## 1. Capire dove sei

```bash
node -v; npm -v; git --version
```

- Sistema: su Windows il prompt di Claude Code ha strumenti Bash e PowerShell; su macOS e Linux usa `uname -sm`.
- Se `node -v` risponde `v20`...`v25`, salta al passo 3.
- Se risponde `v26` o superiore, oppure meno di `v20`, serve la 24 **accanto** o al posto di quella che c'è:
  chiedi all'utente se usa Node per altro prima di sostituirlo. Su macOS e Linux nvm le tiene affiancate.
- Se il comando non esiste, Node non c'è: passo 2.

## 2. Installare Node 24

### Windows

Usa winget (presente in Windows 10 e 11). Trova l'ultima 24.x disponibile e installala:

```powershell
winget show --id OpenJS.NodeJS.LTS --versions
winget install --id OpenJS.NodeJS.LTS -e --version <24.x.y> --accept-package-agreements --accept-source-agreements
```

- Comparirà la finestra di Windows che chiede l'autorizzazione: di' all'utente di confermare.
- Il PATH della sessione corrente non si aggiorna. Nei comandi successivi aggiungilo a mano
  (Bash: `export PATH="/c/Program Files/nodejs:$PATH"`, PowerShell: `$env:Path = "C:\Program Files\nodejs;" + $env:Path`)
  oppure chiedi di riavviare Claude Code.
- Se winget manca o fallisce: scarica l'MSI della 24 da https://nodejs.org/dist/latest-v24.x/ (il nome esatto è in
  `SHASUMS256.txt` della stessa cartella, file `node-v24.*-x64.msi`, o `-arm64.msi` su processori ARM) e avvialo con
  `msiexec /i <file>.msi`. In ultima istanza chiedi all'utente di scaricarlo e installarlo a mano dallo stesso indirizzo.
- In PowerShell, se `npm` dà "l'esecuzione di script è disabilitata", usa `npm.cmd` al posto di `npm`, oppure, con il
  permesso dell'utente, `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### macOS

Se c'è Homebrew (`brew -v` risponde):

```bash
brew install node@24
echo 'export PATH="'"$(brew --prefix node@24)"'/bin:$PATH"' >> ~/.zshrc
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

`node@24` non si collega da solo al PATH: senza la riga in `~/.zshrc` il prossimo terminale non lo trova.

Senza Homebrew usa nvm (non chiede password di amministratore), come per Linux qui sotto.

### Linux (e macOS senza Homebrew)

nvm installa Node nella cartella dell'utente, senza `sudo`. Prendi l'ultima versione dello script da
https://github.com/nvm-sh/nvm/releases e:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/<versione>/install.sh | bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install 24 && nvm alias default 24
```

Ogni comando Bash di Claude Code parte da una shell nuova: anteponi `. "$HOME/.nvm/nvm.sh" &&` ai comandi `node`/`npm`
finché l'utente non riapre il terminale. Il file `.nvmrc` del progetto contiene già `24`, quindi `nvm use` basta.

Verifica sempre alla fine: `node -v` deve rispondere `v24.*`.

## 3. Preparare il progetto

Dalla cartella del progetto:

```bash
npm run setup -- --user <nome1> --user <nome2>
```

Chiedi prima all'utente con quali nomi vuole entrare (per esempio `gianpiero` e `mirko`). Lo script, ripetibile senza danni:

1. controlla la versione di Node e si ferma con un messaggio chiaro se non è tra quelle supportate;
2. installa le dipendenze con `npm ci`;
3. verifica che il database si carichi davvero;
4. crea `.env` con un `SESSION_SECRET` casuale, se non esiste già;
5. crea gli utenti mancanti con una **password casuale stampata una sola volta**.

Riporta all'utente nomi e password generate e digli che sono provvisorie: al primo accesso ognuno sceglie la sua su `/chiave` e riceve la chiave di recupero dei dati (si cambia poi da Account; `npm run user -- add <nome>` serve solo a reimpostarla)
(il comando chiede la password due volte e va lanciato da lui in un terminale, perché non mostra cosa si scrive).
Non scrivere le password in file.

Se l'utente ha un file di backup dei dati (`lana-export-*.json` o un file per collezione), importalo:
`npm run import -- <file> --dry-run`, poi senza `--dry-run`. I formati accettati sono descritti nel README.

## 4. Avviare e verificare

Avvia il server in background (`npm start`, con `run_in_background`) e controlla che risponda:

```bash
node -e "fetch('http://localhost:3000/login').then(r => console.log(r.status))"
```

Deve stampare `200`. Poi di' all'utente di aprire **http://localhost:3000** nel browser ed entrare con le sue credenziali.
Se la porta 3000 è occupata, imposta `PORT=3001` in `.env` e riavvia.

Per spegnerlo: interrompi il processo (o `Ctrl+C` nel terminale). Le volte successive basta `npm start`:
installazione e utenti restano.

## Problemi frequenti

| Sintomo | Causa e rimedio |
|---|---|
| `Segmentation fault` o crash appena parte | Node 26+ o `node_modules` installati con un altro Node. Installa la 24, cancella `node_modules`, rilancia `npm run setup` |
| `gyp ERR!`, `prebuild-install warn`, "No prebuilt binaries found" | Stessa causa: versione di Node non supportata. Non installare compilatori, cambia versione di Node |
| `npm: command not found` subito dopo l'installazione | PATH della sessione non aggiornato: vedi le note del passo 2 |
| `EADDRINUSE` | Porta occupata: `PORT` diversa in `.env` |
| La pagina chiede di nuovo l'accesso dopo ogni riavvio | Manca `SESSION_SECRET` in `.env`: rilancia `npm run setup` |
| "Nome utente o password non corretti" | `npm run user -- list` per vedere i nomi; `npm run user -- add <nome>` per reimpostare la password |
| "Troppi tentativi" | Blocco di 15 minuti dopo 10 errori: aspetta o riavvia il server |
| npm dietro proxy aziendale | `npm config set proxy http://...` e `https-proxy`, con i dati che ti dà l'utente |

## Da non fare

- Non modificare `public/index.html` (è l'originale): i ritocchi grafici stanno in `public/enhance.css` ed `enhance.js`.
- Non committare `.env`, la cartella `data/` né i file di export: sono già in `.gitignore`.
- Non cambiare la versione di `better-sqlite3` né usare `npm install` al posto di `npm ci` per la prima installazione.
- Prima di rendere il sito raggiungibile da fuori casa (HTTPS, proxy, `COOKIE_SECURE=1`) leggi la sezione Note del README.
