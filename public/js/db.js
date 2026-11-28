// Almacenamiento en el móvil (IndexedDB). Nunca se sube al servidor salvo al publicar.
// Borradores, podcasts privados, sonidos propios (efectos, fondo, canciones) y ajustes.
import { LIMITS } from './config.js';

const DB_NAME = 'radio-porche';
const VERSION = 1;
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sounds')) db.createObjectStore('sounds', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => (out = v));
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  async all(store) { return tx(store, 'readonly', (s) => req2p(s.getAll())); },
  async get(store, key) { return tx(store, 'readonly', (s) => req2p(s.get(key))); },
  async put(store, val, key) { return tx(store, 'readwrite', (s) => req2p(key !== undefined ? s.put(val, key) : s.put(val))); },
  async del(store, key) { return tx(store, 'readwrite', (s) => req2p(s.delete(key))); },
  async clear(store) { return tx(store, 'readwrite', (s) => req2p(s.clear())); },
};

export async function getSetting(k, def = null) {
  try { const v = await db.get('settings', k); return v === undefined ? def : v; } catch { return def; }
}
export async function setSetting(k, v) { return db.put('settings', v, k); }

/** Borra las grabaciones sin publicar de más de LIMITS.DRAFT_DAYS días (null = nunca). */
export async function purgeOldDrafts() {
  if (!LIMITS.DRAFT_DAYS) return;
  try {
    const list = await db.all('recordings');
    const limit = Date.now() - LIMITS.DRAFT_DAYS * 86400_000;
    for (const r of list) if (r.kind === 'draft' && r.created < limit) await db.del('recordings', r.id);
  } catch {}
}

export async function requestPersist() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}

// ---------- Copia para cambiar de móvil ----------
// Formato: "RPBK1\n" + 12 dígitos con la longitud del índice JSON + índice + blobs seguidos.
export async function exportBackup() {
  const recordings = await db.all('recordings');
  const sounds = await db.all('sounds');
  const settingsKeys = await tx('settings', 'readonly', (s) => req2p(s.getAllKeys()));
  const settings = {};
  for (const k of settingsKeys) settings[k] = await db.get('settings', k);
  const parts = [];
  const index = { app: 'radio-porche', version: 1, created: Date.now(), recordings: [], sounds: [], settings, identity: null };
  try { index.identity = JSON.parse(localStorage.getItem('rp_identity') || 'null'); } catch {}
  let offset = 0;
  const addBlob = (b) => { if (!b) return null; const ref = { o: offset, n: b.size, t: b.type }; parts.push(b); offset += b.size; return ref; };
  for (const r of recordings) {
    const { blob, coverBlob, ...meta } = r;
    index.recordings.push({ ...meta, blob: addBlob(blob), coverBlob: addBlob(coverBlob) });
  }
  for (const s of sounds) {
    const { blob, ...meta } = s;
    index.sounds.push({ ...meta, blob: addBlob(blob) });
  }
  const ij = new TextEncoder().encode(JSON.stringify(index));
  const head = new TextEncoder().encode('RPBK1\n' + String(ij.length).padStart(12, '0'));
  return new Blob([head, ij, ...parts], { type: 'application/octet-stream' });
}

export async function importBackup(file) {
  const head = new TextDecoder().decode(await file.slice(0, 18).arrayBuffer());
  if (!head.startsWith('RPBK1\n')) throw new Error('Este archivo no es una copia de Radio Porche');
  const n = Number(head.slice(6, 18));
  const index = JSON.parse(new TextDecoder().decode(await file.slice(18, 18 + n).arrayBuffer()));
  const base = 18 + n;
  const blob = (ref) => (ref ? file.slice(base + ref.o, base + ref.o + ref.n, ref.t) : null);
  let count = 0;
  for (const r of index.recordings || []) {
    await db.put('recordings', { ...r, blob: blob(r.blob), coverBlob: blob(r.coverBlob) });
    count++;
  }
  for (const s of index.sounds || []) { await db.put('sounds', { ...s, blob: blob(s.blob) }); count++; }
  for (const [k, v] of Object.entries(index.settings || {})) await db.put('settings', v, k);
  return { count, identity: index.identity };
}

export async function wipeLocal() {
  await db.clear('recordings');
  await db.clear('sounds');
  await db.clear('settings');
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('rp_')) localStorage.removeItem(k);
  } catch {}
}
