/*
 * Cifratura di Lana Studio, uguale nel browser (login, shim, pagine) e in Node (test, CLI).
 *
 * Il server vede solo dati cifrati. La chiave dei dati (DEK, AES-GCM 256) nasce nel browser e sul
 * server arriva soltanto "avvolta" (cifrata) in due modi:
 *   - con una chiave derivata dalla password di ciascun utente (PBKDF2, un blocco per utente);
 *   - con la chiave di recupero dello studio (un blocco solo, stesso per tutti).
 * La password non lascia mai il browser: al server va un token derivato da essa (authToken), che
 * non permette di aprire la chiave. Ogni documento è cifrato con la DEK e legato a "collezione/id",
 * così il server non può scambiare tra loro due documenti.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LanaCrypto = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const webcrypto = globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto : require('crypto').webcrypto;
  const subtle = webcrypto && webcrypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const PASSWORD_ITER = 600000;
  const MIN_ITER = 100000;
  const MAX_ITER = 5000000;
  const AUTH_ITER = 100000;
  const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 simboli, senza I, O, 0, 1
  const RECOVERY_LEN = 32; // 32 x 5 bit = 160 bit

  function need() {
    if (!subtle) throw fail('no_crypto', 'Questo browser non offre la cifratura. Apri il sito in https.');
  }
  function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }

  /* ---------- base64 url ---------- */
  function toB64(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64(str) {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  }
  const hex = buf => Array.from(new Uint8Array(buf), x => x.toString(16).padStart(2, '0')).join('');
  const rnd = n => webcrypto.getRandomValues(new Uint8Array(n));
  const normPassword = p => String(p).normalize('NFC');

  /* ---------- accesso: token al posto della password ---------- */
  // Il server salva solo un hash bcrypt di questo token. Il sale dipende dal nome utente (senza
  // distinzione di maiuscole, come sul server), quindi il token è lo stesso su ogni dispositivo.
  async function authToken(username, password) {
    need();
    const salt = enc.encode('lana-auth-v1:' + String(username).trim().toLowerCase());
    const base = await subtle.importKey('raw', enc.encode(normPassword(password)), 'PBKDF2', false, ['deriveBits']);
    return hex(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: AUTH_ITER }, base, 256));
  }

  /* ---------- chiave dei dati e blocchi avvolti ---------- */
  const newDataKey = () => (need(), subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']));

  async function passwordKek(password, salt, iterations) {
    const base = await subtle.importKey('raw', enc.encode(normPassword(password)), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function recoveryKek(recoveryKey) {
    const norm = normalizeRecoveryKey(recoveryKey);
    if (!norm) throw fail('bad_recovery', 'La chiave di recupero non è nel formato giusto.');
    const raw = await subtle.digest('SHA-256', enc.encode('lana-recovery-v1:' + norm));
    return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async function seal(kek, dek, kdf, extra) {
    const raw = new Uint8Array(await subtle.exportKey('raw', dek));
    const iv = rnd(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('lana-dek-v1') }, kek, raw);
    raw.fill(0);
    return Object.assign({ v: 1, kdf, iv: toB64(iv), ct: toB64(ct) }, extra);
  }

  async function open(kek, wrapped, extractable) {
    let raw;
    try {
      raw = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(wrapped.iv), additionalData: enc.encode('lana-dek-v1') }, kek, fromB64(wrapped.ct));
    } catch (e) {
      throw fail('bad_key', 'Password o chiave non corretta.');
    }
    const key = await subtle.importKey('raw', raw, 'AES-GCM', !!extractable, ['encrypt', 'decrypt']);
    new Uint8Array(raw).fill(0);
    return key;
  }

  async function wrapWithPassword(dek, password, iterations) {
    need();
    const iter = iterations || PASSWORD_ITER;
    const salt = rnd(16);
    return seal(await passwordKek(password, salt, iter), dek, 'pbkdf2-sha256', { iter, salt: toB64(salt) });
  }

  async function unwrapWithPassword(wrapped, password, extractable) {
    need();
    if (!wrapped || wrapped.kdf !== 'pbkdf2-sha256' || !(wrapped.iter >= MIN_ITER && wrapped.iter <= MAX_ITER)) throw fail('bad_blob', 'Blocco della chiave non valido.');
    return open(await passwordKek(password, fromB64(wrapped.salt), wrapped.iter), wrapped, extractable);
  }

  async function wrapWithRecovery(dek, recoveryKey) {
    need();
    return seal(await recoveryKek(recoveryKey), dek, 'recovery-v1', {});
  }

  async function unwrapWithRecovery(wrapped, recoveryKey, extractable) {
    need();
    if (!wrapped || wrapped.kdf !== 'recovery-v1') throw fail('bad_blob', 'Blocco della chiave non valido.');
    return open(await recoveryKek(recoveryKey), wrapped, extractable);
  }

  /* ---------- chiave di recupero ---------- */
  function newRecoveryKey() {
    need();
    const bytes = rnd(RECOVERY_LEN);
    let s = '';
    for (const b of bytes) s += RECOVERY_ALPHABET[b % 32]; // 256 è multiplo di 32: nessuna distorsione
    return s.match(/.{4}/g).join('-');
  }
  // Accetta maiuscole o minuscole, con o senza trattini e spazi. Restituisce null se non è valida.
  function normalizeRecoveryKey(text) {
    const s = String(text || '').toUpperCase().replace(/[\s-]+/g, '');
    return s.length === RECOVERY_LEN && [...s].every(c => RECOVERY_ALPHABET.includes(c)) ? s : null;
  }

  /* ---------- documenti ---------- */
  const aad = (col, id) => enc.encode(col + '/' + id);

  async function encryptDoc(dek, col, id, data) {
    need();
    const iv = rnd(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(col, id) }, dek, enc.encode(JSON.stringify(data)));
    return { _enc: 1, iv: toB64(iv), ct: toB64(ct) };
  }

  async function decryptDoc(dek, col, id, env) {
    need();
    if (!isEnvelope(env)) throw fail('not_encrypted', 'Documento non cifrato.');
    let plain;
    try {
      plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(col, id) }, dek, fromB64(env.ct));
    } catch (e) {
      throw fail('bad_key', 'Documento non apribile con questa chiave.');
    }
    return JSON.parse(dec.decode(plain));
  }

  function isEnvelope(o) {
    return !!o && typeof o === 'object' && !Array.isArray(o) && o._enc === 1 && typeof o.iv === 'string' && typeof o.ct === 'string' && Object.keys(o).length === 3;
  }

  /* ---------- dove il browser tiene la chiave aperta ---------- */
  // IndexedDB conserva l'oggetto CryptoKey non estraibile: sopravvive ai ricaricamenti ma il suo
  // contenuto non si può leggere né da script né dagli strumenti del browser. Si svuota con l'uscita.
  const IDB = 'lana-chiavi';
  function idb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(IDB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('k');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('k', mode);
        const req = fn(tx.objectStore('k'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  const saveKey = (user, dek) => idbDo('readwrite', s => s.put({ user: String(user).toLowerCase(), dek }, 'dek'));
  const loadKey = () => idbDo('readonly', s => s.get('dek')).then(v => v || null).catch(() => null);
  const clearKey = () => idbDo('readwrite', s => s.delete('dek')).catch(() => {});

  return {
    PASSWORD_ITER, authToken, newDataKey,
    wrapWithPassword, unwrapWithPassword, wrapWithRecovery, unwrapWithRecovery,
    newRecoveryKey, normalizeRecoveryKey,
    encryptDoc, decryptDoc, isEnvelope,
    saveKey, loadKey, clearKey,
  };
});
