// Buzón de paso entre tus aparatos (móvil ⇄ ordenador).
// - Lo que grabas emitiendo desde el ordenador llega solo a tu móvil (tu casa).
// - Los sonidos propios que añades en un aparato llegan al otro (para la botonera del Estudio).
// - "Pasar al ordenador / al móvil" envía una grabación concreta.
// - Al publicar una grabación, se quita también del otro aparato.
// El archivo espera en el servidor solo hasta que el otro aparato lo recoge; entonces se borra.
import { api, session, ApiError } from './api.js';
import { db } from './db.js';
import { toast, DEVICE_KIND } from './util.js';

export const OTHER = DEVICE_KIND === 'móvil' ? 'ordenador' : 'móvil';
const fidOf = (kind, id, to) => `${kind === 'del' ? 'x' : kind[0]}${to === 'móvil' ? 'm' : 'o'}${id}`.slice(0, 40);

/** ¿Has usado alguna vez un aparato de ese tipo? (si no, no tiene sentido enviarle nada) */
export const hasUsed = (kind) => localStorage.getItem(`rp_has_${kind}`) === '1';
export function markUsed(kind) {
  if (!kind || kind === DEVICE_KIND || hasUsed(kind)) return;
  localStorage.setItem(`rp_has_${kind}`, '1');
  // Primera vez que vemos tu otro aparato: le mandamos tus sonidos propios para su botonera
  sendAllSounds(kind).catch(() => {});
}

function splitBlobs(item) {
  const meta = {}, blobs = {};
  for (const [k, v] of Object.entries(item)) {
    if (v instanceof Blob) blobs[k] = v;
    else meta[k] = v;
  }
  return { meta, blobs };
}

async function upload(kind, item, to, extra = {}) {
  const { meta, blobs } = splitBlobs(item);
  const fid = fidOf(kind, item.id, to);
  await api(`/api/cloud/${fid}/meta`, { method: 'POST', body: { kind, meta: { ...meta, ...extra, to, from: DEVICE_KIND, sentAt: Date.now() } } });
  const audio = blobs.blob;
  if (audio) await api(`/api/cloud/${fid}/a`, { method: 'POST', raw: audio, headers: { 'content-type': audio.type || 'application/octet-stream' } });
  const photo = blobs.photo;
  if (photo) await api(`/api/cloud/${fid}/p`, { method: 'POST', raw: photo, headers: { 'content-type': photo.type || 'image/jpeg' } });
  return fid;
}

/** Envía una grabación al otro aparato. Devuelve true si ha ido bien. */
export async function sendRecording(rec, to = OTHER, { quiet = false } = {}) {
  if (!session.token || !rec?.blob) return false;
  try {
    await upload('rec', rec, to);
    if (!quiet) toast(`Enviada a tu ${to}. Aparecerá en Grabaciones en cuanto lo abras.`, 'good');
    return true;
  } catch (e) {
    toast(e instanceof ApiError && e.status === 413 ? e.message : `No se ha podido enviar a tu ${to}: ${e.message}`, 'bad');
    return false;
  }
}

/** Sonido propio nuevo o cambiado → al otro aparato (si lo usas). */
export async function sendSound(snd) {
  if (!session.token || !snd?.blob || !hasUsed(OTHER)) return;
  try { await upload('snd', snd, OTHER); } catch {}
}
async function sendAllSounds(to) {
  if (!session.token) return;
  for (const s of await db.all('sounds')) { try { await upload('snd', s, to); } catch (e) { if (e.status === 413) break; } }
}

/** Avisa al otro aparato de que quite algo (grabación publicada, sonido borrado). */
export async function sendDelete(store, id, to = OTHER) {
  if (!session.token || !hasUsed(to)) return;
  try { await api(`/api/cloud/${fidOf('del', store[0] + id, to)}/meta`, { method: 'POST', body: { kind: 'del', meta: { store, id, to, from: DEVICE_KIND, sentAt: Date.now() } } }); } catch {}
}

async function download(fid, part) {
  const r = await fetch(`/api/cloud/${fid}/${part}`, { headers: { authorization: `Bearer ${session.token}` } });
  if (!r.ok) throw new Error('No se ha podido descargar');
  return r.blob();
}

let busy = false;
/** Recoge lo que te han enviado tus otros aparatos. */
export async function pickup() {
  if (busy || !session.token) return;
  busy = true;
  try {
    const { files } = await api('/api/cloud');
    const mine = files.filter((f) => f.meta?.to === DEVICE_KIND).sort((a, b) => a.created - b.created);
    let recs = 0, snds = 0, first = '';
    for (const f of mine) {
      try {
        const { to, from, sentAt, ...meta } = f.meta;
        if (f.kind === 'del') {
          if (meta.store === 'recordings' || meta.store === 'sounds') await db.del(meta.store, meta.id);
        } else {
          if (!f.aBytes) continue; // aún subiendo
          const item = { ...meta, blob: await download(f.id, 'a') };
          if (f.pBytes) item.photo = await download(f.id, 'p');
          if (f.kind === 'rec') { item.from = from; await db.put('recordings', item); recs++; first = first || item.title; }
          else { await db.put('sounds', item); snds++; }
        }
        await api(`/api/cloud/${f.id}/delete`, { method: 'POST', body: {} });
      } catch {}
    }
    if (recs || snds) {
      if (recs) toast(recs === 1 ? `Ha llegado «${first}» desde tu ${OTHER}` : `Han llegado ${recs} grabaciones desde tu ${OTHER}`, 'good');
      window.dispatchEvent(new CustomEvent('rp:inbox', { detail: { recs, snds } }));
    }
  } catch {}
  finally { busy = false; }
}

/** Revisa el buzón al abrir, al volver a la app y cada minuto mientras está a la vista. */
export function watchInbox() {
  pickup();
  setInterval(() => { if (document.visibilityState === 'visible') pickup(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pickup(); });
  window.addEventListener('rp:identity', () => pickup());
}

// ---------- Preferencias de tu cuenta (favoritos de la botonera…): pequeñas, compartidas en todos tus aparatos
let prefs = null;
try { prefs = JSON.parse(localStorage.getItem('rp_prefs') || 'null'); } catch {}
export function getPref(k, def = null) { return prefs && k in prefs ? prefs[k] : def; }
export async function loadPrefs() {
  if (!session.token) return prefs || {};
  try { prefs = (await api('/api/cloud/prefs')).prefs || {}; localStorage.setItem('rp_prefs', JSON.stringify(prefs)); } catch {}
  return prefs || {};
}
export async function setPref(k, v) {
  prefs = { ...(prefs || {}), [k]: v };
  try { localStorage.setItem('rp_prefs', JSON.stringify(prefs)); } catch {}
  if (session.token) { try { await api('/api/cloud/prefs', { method: 'POST', body: { [k]: v } }); } catch {} }
}
