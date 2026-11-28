// Biblioteca de sonidos: tres zonas (Efectos · Música de fondo · Canciones),
// cada una con lo "De serie" (repo + panel admin, para todos) y lo "Mío" (en el móvil).
import { db, uid } from '../db.js';
import { LIMITS } from '../config.js';
import { audioCtx } from './voice.js';
import { canEncodeOpus, encodeOpusWebm, encodeWav, mixToMono, recorderMime } from './encode.js';

const cache = new Map(); // id -> AudioBuffer
let standard = null;

export async function loadStandard(force = false) {
  if (standard && !force) return standard;
  const out = [];
  try {
    const m = await (await fetch('/library/manifest.json')).json();
    for (const it of m.items || []) out.push({ ...it, src: it.file, origin: 'serie' });
  } catch {}
  try {
    const r = await (await fetch('/api/library')).json();
    for (const it of r.items || []) out.push({ ...it, src: `/api/library/${it.id}/audio`, origin: 'serie' });
  } catch {}
  standard = out;
  return out;
}

export async function loadMine() {
  try { return (await db.all('sounds')).map((s) => ({ ...s, origin: 'mias' })).sort((a, b) => a.created - b.created); } catch { return []; }
}

export async function loadAll() {
  const [a, b] = await Promise.all([loadStandard(), loadMine()]);
  return [...a, ...b];
}

export async function decode(item) {
  const key = item.origin + ':' + item.id;
  if (cache.has(key)) return cache.get(key);
  let ab;
  if (item.blob) ab = await item.blob.arrayBuffer();
  else ab = await (await fetch(item.src)).arrayBuffer();
  const buf = trimSilence(await audioCtx().decodeAudioData(ab));
  cache.set(key, buf);
  return buf;
}

/**
 * Quita el silencio del principio y del final para que en antena suene al instante.
 * Umbral ~ -50 dB; deja 10 ms antes y 60 ms después para no cortar ataques ni colas.
 */
export function trimSilence(buf, threshold = 0.0032) {
  const n = buf.length, chs = buf.numberOfChannels, sr = buf.sampleRate;
  const data = [];
  for (let c = 0; c < chs; c++) data.push(buf.getChannelData(c));
  const loud = (i) => { for (let c = 0; c < chs; c++) if (Math.abs(data[c][i]) > threshold) return true; return false; };
  let a = 0; while (a < n && !loud(a)) a++;
  let b = n - 1; while (b > a && !loud(b)) b--;
  if (a >= n) return buf; // todo silencio: lo dejamos tal cual
  a = Math.max(0, a - Math.round(sr * 0.01));
  b = Math.min(n - 1, b + Math.round(sr * 0.06));
  if (a < sr * 0.03 && n - 1 - b < sr * 0.03) return buf; // casi no hay silencio que quitar
  const len = b - a + 1;
  const out = audioCtx().createBuffer(chs, len, sr);
  const fade = Math.min(Math.round(sr * 0.004), len >> 2);
  for (let c = 0; c < chs; c++) {
    const seg = data[c].slice(a, b + 1);
    for (let i = 0; i < fade; i++) { seg[i] *= i / fade; seg[len - 1 - i] *= i / fade; }
    out.copyToChannel(seg, c);
  }
  return out;
}

const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm)$/i.test(f.name || '') && !/^audio\//.test(f.type);

/** Añade un archivo propio (MP3/audio o vídeo MP4/MOV: se extrae el audio). */
export async function importSound(file, { zone, name, section = '' }, onProgress) {
  if (file.size > LIMITS.SOUND_MAX_BYTES * (isVideo(file) ? 6 : 1)) throw new Error('El archivo es demasiado grande');
  const ab = await file.arrayBuffer();
  let buf;
  try { buf = await audioCtx().decodeAudioData(ab.slice(0)); } catch { throw new Error('No se ha podido leer el audio de este archivo'); }
  let blob = file;
  if (isVideo(file) || file.size > 12 * 1024 * 1024) {
    // Extraer y comprimir el audio en el navegador
    const pcm = mixToMono(buf);
    if (await canEncodeOpus(buf.sampleRate === 24000 ? 24000 : 48000) && (buf.sampleRate === 48000 || buf.sampleRate === 24000)) {
      blob = await encodeOpusWebm(pcm, buf.sampleRate, { bitrate: zone === 'fx' ? 64000 : 96000, onProgress });
    } else if (buf.duration < 120) {
      blob = encodeWav(pcm, buf.sampleRate);
    } else if (isVideo(file)) {
      blob = new Blob([ab], { type: file.type || 'video/mp4' }); // se guarda tal cual; se reproduce igual
    }
  }
  const item = {
    id: uid(), zone, name: (name || file.name.replace(/\.[^.]+$/, '')).slice(0, 40), section: section.slice(0, 40),
    duration: Math.round(buf.duration * 10) / 10, mime: blob.type, blob, created: Date.now(),
  };
  await db.put('sounds', item);
  cache.set('mias:' + item.id, buf);
  return item;
}

/** Guarda un sonido grabado y recortado (Float32 mono). */
export async function saveRecordedSound(pcm, sampleRate, { zone, name, section = '' }) {
  let blob;
  if (await canEncodeOpus(sampleRate)) blob = await encodeOpusWebm(pcm, sampleRate, { bitrate: 64000 });
  else blob = encodeWav(pcm, sampleRate);
  const item = { id: uid(), zone, name: name.slice(0, 40), section: section.slice(0, 40), duration: Math.round((pcm.length / sampleRate) * 10) / 10, mime: blob.type, blob, created: Date.now() };
  await db.put('sounds', item);
  return item;
}

export async function renameSound(id, patch) {
  const s = await db.get('sounds', id);
  if (!s) return;
  await db.put('sounds', { ...s, ...patch });
}
export async function deleteSound(id) {
  await db.del('sounds', id);
  cache.delete('mias:' + id);
}

/** Graba con el micro del móvil (para crear cortes). */
export async function recordMic() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = recorderMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.start(500);
  return {
    stream,
    async stop() {
      const done = new Promise((r) => (rec.onstop = r));
      rec.stop();
      await done;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(parts, { type: (mime || 'audio/webm').split(';')[0] });
      const buf = await audioCtx().decodeAudioData(await blob.arrayBuffer());
      return buf;
    },
  };
}
