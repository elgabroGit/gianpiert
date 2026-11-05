# Lana Studio · gestionale

Versione locale del gestionale "Lana Studio" nato come artifact di claude.ai.
Il frontend è lo stesso file HTML dell'originale (Clienti, Task, Calendario, Fatture, Collaboratori),
senza modifiche al codice dell'app: i ritocchi per telefono e desktop stanno in due file a parte
(vedi [Interfaccia](#interfaccia)). Cambia l'archivio: invece del database della piattaforma
claude.ai, i dati stanno in un file SQLite gestito da un piccolo server Express.

## Requisiti

- Node.js 20 o superiore
- Nessuna build: niente bundler, framework o TypeScript

## Avvio

```bash
npm install
cp .env.example .env          # poi imposta SESSION_SECRET
npm run user -- add gianpiero # chiede la password
npm run user -- add mirko
npm start                     # http://localhost:3000
```

`npm run dev` riavvia il server a ogni modifica. `npm run check` prova accesso, API, If-Match,
SSE, export e import su un archivio temporaneo, senza toccare `data/`.

## Struttura

```
server.js                     Express: accesso, pagine, API REST e SSE
lib/config.js                 variabili d'ambiente (.env)
lib/store.js                  SQLite: tabella documents, users, studio (chiave di recupero), versioni per If-Match
public/index.html             copia dell'originale + righe che caricano shim ed enhance
public/shim.js                window.claude.use('db') sopra le API del server; cifra e decifra i documenti
public/crypto.js              cifratura (browser e Node): password, chiavi, documenti
public/importa.js             lettura dei file di dati da caricare (browser e Node)
public/login.js, chiave.js, account.js, pagina.js, pagine.css   pagine di accesso, chiave dei dati e account
views/chiave.html, account.html   le due pagine dopo l'accesso
public/enhance.css            ritocchi grafici: telefono, desktop, animazioni CSS
public/enhance.js             animazioni di ingresso, schede fatture su telefono, chiusura a trascinamento
views/login.html              pagina di accesso, stessi colori e font dell'app
views/mark.png                marchio Lana (estratto dall'originale)
scripts/user.js               gestione utenti
scripts/export.js             npm run export
scripts/import.js             npm run import
scripts/check.js              npm run check
lana-gestionale-originale.html  sorgente originale, solo come riferimento
```

### Archivio

Una sola tabella generica:

```sql
documents(collection TEXT, id TEXT, data TEXT /* JSON */, updated_at INTEGER,
          PRIMARY KEY (collection, id))
```

Collezioni ammesse: `clients`, `projects`, `tasks`, `collaborators`, `fatture`, `costi`.
Ogni scrittura aggiorna `updated_at` (millisecondi, sempre crescente per lo stesso documento),
che fa anche da numero di versione. Gli utenti stanno nella tabella `users` dello stesso file.

## Privacy: i dati sono cifrati nel browser

Chi amministra il server (e chiunque legga il disco o i backup) non può leggere i dati dello studio.

- La **chiave dei dati** (AES-GCM 256) nasce nel browser alla prima configurazione. Al server arriva solo
  *avvolta*: una copia cifrata con la password di ciascuna persona (PBKDF2, 600.000 giri) e una cifrata con la
  **chiave di recupero** dello studio (32 caratteri, 160 bit, mostrata una volta sola).
- Ogni documento viene cifrato nel browser con quella chiave e legato a `collezione/id`. Il server conserva
  `{_enc, iv, ct}`. Restano in chiaro solo nome della collezione, id, data di modifica e dimensioni.
- La **password non arriva al server**: dal browser parte un token derivato (PBKDF2 con sale legato al nome
  utente); il server ne tiene l'hash bcrypt. Il token non apre la chiave dei dati.
- Dopo l'accesso la chiave resta nel browser come oggetto non estraibile (IndexedDB) fino all'uscita.
- Le pagine di accesso, chiave e account hanno una CSP senza script inline.
- `secure_delete` e un `VACUUM` dopo la prima configurazione evitano che restino copie in chiaro scritte prima.

Cosa NON protegge: chi controlla il server può cambiare il codice che invia al browser e rubare password o chiave
(per questo il codice va aggiornato solo dal repository, senza modifiche a mano sulla macchina). Chi ha il
browser aperto e sbloccato vede i dati. Se si perdono sia la password sia la chiave di recupero, i dati non si
recuperano: non esiste un modo di aggirarlo, nemmeno per chi amministra.

### Primo avvio con la cifratura

1. Chi amministra crea gli utenti con una password provvisoria: `npm run user -- add gianpiero`.
2. La prima persona che entra viene portata su `/chiave`: sceglie la sua password, riceve la chiave di recupero
   e la salva. Da quel momento i dati (anche quelli già presenti) sono cifrati.
3. Passa la chiave di recupero all'altra persona con un canale privato. Entrando, andrà su `/chiave`, inserirà
   la sua password provvisoria, la chiave di recupero e una nuova password.
4. In **Account** (link in alto a destra) ognuno cambia la password, carica i dati, scarica una copia di
   sicurezza, crea una nuova chiave di recupero ed esce.

Password dimenticata: chi amministra la reimposta con `npm run user -- add <nome>` (vede solo la password
provvisoria); la persona rientra con la chiave di recupero e ne sceglie una nuova. Il blocco della chiave si
azzera con la reimpostazione, quindi senza la chiave di recupero non si riaprono i dati.

## Variabili d'ambiente

| Variabile | Default | Cosa fa |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `SESSION_SECRET` | casuale a ogni avvio | firma il cookie di sessione. Se manca, a ogni riavvio bisogna rientrare |
| `SESSION_DAYS` | `30` | durata della sessione |
| `COOKIE_SECURE` | `0` | `1` se il sito è in HTTPS dietro un proxy (attiva anche `trust proxy`) |
| `DB_FILE` | `data/lana.sqlite` | percorso del file SQLite, relativo alla cartella del progetto |
| `INITIAL_USERS` | vuoto | utenti creati al primo avvio se la tabella `users` è vuota: `gianpiero:<hash>,mirko:<hash>`. L'hash si ottiene con `npm run user -- hash <nome>` (è l'hash del token derivato, non della password) |

## Utenti

```bash
npm run user -- add <nome>     # crea l'utente con una password provvisoria, o la reimposta
npm run user -- list
npm run user -- remove <nome>  # chi è collegato con quel nome perde l'accesso alla richiesta successiva
npm run user -- hash <nome>    # stampa l'hash da usare in INITIAL_USERS
```

Il server salva l'hash bcrypt (libreria `bcryptjs`) del token che il browser ricava dalla password, mai la
password. Il nome utente non distingue maiuscole e minuscole. Dopo 10 tentativi sbagliati dallo stesso indirizzo
l'accesso si blocca per 15 minuti (stesso limite per i controlli di password in `/account` e `/chiave`).
Reimpostare o cambiare la password chiude le altre sessioni dello stesso utente. Si esce da **Account** o da
`/logout`; l'originale non ha un pulsante di uscita, quindi in alto a destra c'è solo il link **Account**.

Utenti creati prima della cifratura (con la password in chiaro nell'hash) non entrano più: vanno ricreati
con `npm run user -- add <nome>`.

La sessione è un cookie firmato (`cookie-session`), quindi non serve memoria lato server e sopravvive ai
riavvii. Per chiudere tutte le sessioni aperte basta cambiare `SESSION_SECRET`.

## API

Tutte le rotte `/api` e la pagina dell'app richiedono l'accesso (senza sessione: `401` per le API,
rimando a `/login` per le pagine).

Con la cifratura attiva (dopo la prima configurazione) `PUT` accetta solo documenti cifrati `{_enc, iv, ct}` e
`PATCH` risponde `405`: l'unione dei campi la fa lo shim nel browser.

| Metodo e percorso | Cosa fa |
|---|---|
| `GET /api/me` | utente, stato della chiave (`none`, `locked`, `ready`) e blocco della chiave dell'utente |
| `POST /api/account/check` | verifica il token di password (serve prima di avvolgere la chiave) |
| `POST /api/account/password` | cambia password; con la cifratura attiva porta il nuovo blocco della chiave |
| `GET/PUT /api/keys/recovery` | blocco della chiave di recupero: lettura, sostituzione |
| `POST /api/keys/setup` | prima configurazione: blocchi della chiave e collezioni già presenti, cifrate |
| `POST /api/import` | carica documenti già cifrati (`replace: true` svuota le collezioni indicate) |
| `GET /api/:collection` | elenco `[{id, data, updated_at}]`, con l'intestazione `X-Lana-Seq` |
| `PUT /api/:collection/:id` | crea o sostituisce il documento (come `set`) |
| `PATCH /api/:collection/:id` | unisce i campi al documento esistente (come `update`), `404` se non esiste |
| `DELETE /api/:collection/:id` | elimina, `204` anche se non esisteva |
| `GET /api/:collection/stream` | SSE: un evento `snapshot` con l'elenco completo all'apertura e dopo ogni modifica |
| `GET /api/stream?c=clients,tasks` | come sopra, più collezioni in un unico flusso (è quello usato dallo shim) |

`PUT` e `PATCH` accettano l'intestazione opzionale `If-Match` con l'`updated_at` letto dal client:
se il documento nel frattempo è cambiato o è stato eliminato rispondono `409`. Le risposte riuscite
restituiscono `{id, updated_at}` e l'intestazione `ETag`.

Lo shim usa un solo flusso per tutte le collezioni perché con sei `EventSource` separati il browser
occuperebbe tutte e sei le connessioni HTTP/1.1 disponibili per dominio e le scritture resterebbero in
attesa. Il flusso per singola collezione resta disponibile per altri usi.

## Lo shim

`public/shim.js` definisce `window.claude.use('db')` con la stessa forma usata dall'app:

- `db.collection(nome).onSnapshot(ok, errore)`: `ok` riceve `{docs: [{id, data()}]}`. Gli aggiornamenti
  arrivano via SSE; se il flusso cade lo shim passa al polling ogni 3 secondi e torna al flusso quando si
  riapre. Le istantanee arrivate fuori ordine vengono scartate.
- `db.doc('collezione/id').set(obj)`, `.update(parziale)`, `.delete()`: chiamate `PUT`, `PATCH`, `DELETE`.
  `set` e `update` mandano `If-Match` con l'ultima versione nota del documento.

Gli errori hanno la proprietà `code`, così `write()` ed `errMsg()` dell'app funzionano come sulla
piattaforma:

| Risposta del server | `code` | Effetto nell'app |
|---|---|---|
| rete assente, `409`, `5xx` | `unavailable` | l'app riprova una volta, poi "Salvataggio non riuscito" |
| `401` (sessione scaduta o utente rimosso) | `revoked` | "L'accesso a questa pagina è cambiato", banner di collegamento interrotto |
| `403` | `invalid_argument` | "Non hai i permessi per modificare" |
| `413` (oltre 1 MB) | `quota_exceeded` | "Archivio pieno" |
| `400`, `404`, `415` | `bad_request`, `not_found` | messaggio generico di salvataggio non riuscito |

Il callback di errore di `onSnapshot` viene chiamato solo con `revoked`: un'interruzione di rete
temporanea passa al polling senza mostrare nulla, perché nell'app quell'errore è definitivo fino al
ricaricamento della pagina.

## Interfaccia

Il codice dell'app in `public/index.html` non è stato modificato. I ritocchi si caricano dopo lo stile
originale e lo sovrascrivono:

- **Telefono (fino a 720px)**: le sezioni passano in una barra in basso con icone e indicatore a
  pillola; i filtri diventano una riga che scorre; i moduli si aprono come pannelli dal basso e si
  chiudono anche trascinando giù la maniglia; fatture e costi diventano schede invece di una tabella
  larga 860px; campi a 16px, così iOS non ingrandisce la pagina a ogni tocco; bersagli da 38-46px;
  la vista mese del calendario entra nello schermo.
- **Desktop**: barra superiore traslucida, sezioni in un contenitore a pillola, ombre leggere, righe
  e schede che si sollevano al passaggio del mouse, anello morbido sui campi attivi.
- **Animazioni**: ingresso delle viste (da destra andando più in profondità, da sinistra tornando
  indietro), elementi in cascata, barre del fatturato che crescono, rimbalzo della spunta e del
  contatore task, apparizione di avvisi e pannelli. Partono solo quando cambia la vista, non a ogni
  aggiornamento dal server, e si disattivano con "riduci movimento" del sistema.

## Esportare e importare

Con la cifratura attiva i comandi da terminale sotto rifiutano di lavorare (vedrebbero solo dati illeggibili):
**caricamento e copia di sicurezza si fanno dalla pagina Account**, che legge gli stessi formati e cifra o
decifra nel browser. Il resto di questa sezione vale per un archivio non ancora cifrato.

```bash
npm run export                         # scrive lana-export-AAAA-MM-GG-hh-mm-ss.json
npm run export -- backup.json
npm run import -- backup.json          # sostituisce i documenti con lo stesso id, lascia gli altri
npm run import -- backup.json --replace  # svuota prima le collezioni presenti nel file
npm run import -- backup.json --dry-run  # mostra cosa importerebbe, senza scrivere
```

Formati accettati da `import`:

- il file prodotto da `npm run export`: `{collections: {clients: [{id, data, updated_at}], ...}}`
- un oggetto con una chiave per collezione: `{clients: [...], tasks: [...]}`
- con `--collection <nome>`: un array JSON oppure un documento JSON per riga (NDJSON)

Ogni documento può essere `{id, data: {...}}` oppure `{id, ...campi}`. I campi extra della piattaforma
claude.ai (`version`, `updatedAt`) vengono ignorati e ogni documento importato riceve un nuovo
`updated_at`.

### Migrare i dati dall'artifact claude.ai

I dati reali stanno nel database dell'artifact originale, collezione per collezione. Si possono estrarre
come elenco di documenti `{id, data, version, updatedAt}` (per esempio chiedendo a Claude di leggere le
collezioni dell'artifact con gli strumenti del database), salvarli un file per collezione e importarli:

```bash
npm run import -- clients.ndjson --collection clients --dry-run
npm run import -- clients.ndjson --collection clients
# ripetere per projects, tasks, collaborators, fatture, costi
```

Se il server è acceso durante l'import, riavvialo: le pagine aperte si ricollegano e ricevono i dati.

## Note

- `better-sqlite3` è fissato alla 12.9.0, l'ultima versione con binari precompilati per Node 20 su
  Windows. Le versioni successive richiedono Node 22 o la compilazione locale.
- Dietro un proxy (nginx, Caddy) il flusso SSE non deve essere bufferizzato: il server manda già
  `X-Accel-Buffering: no` e un ping ogni 25 secondi.
- I documenti sono restituiti in ordine di id. L'app riordina da sé tutto quello che mostra.
- `public/index.html` deve restare identico all'originale a parte le righe che caricano `shim.js`,
  `enhance.css`, `enhance.js` e i due `theme-color`: `npm run check` lo verifica confrontandolo con
  `lana-gestionale-originale.html`. Le modifiche all'aspetto vanno in `enhance.css` ed `enhance.js`.
