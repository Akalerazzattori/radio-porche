import { LIMITS, NAME_PATTERN, DEFAULT_BADWORDS } from '../../public/js/config.js';

const enc = new TextEncoder();

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const err = (status, msg, extra = {}) => json({ error: msg, ...extra }, status);

export function b64u(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function randomId(bytes = 12) {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Comparación en tiempo constante. */
export function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % x.length] || 0) ^ (y[i % y.length] || 0);
  return diff === 0;
}

export async function sha256(s) {
  return b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// ---------- Validación (lista blanca) ----------
const nameRe = new RegExp(NAME_PATTERN);

export function cleanText(v, max, { multiline = false } = {}) {
  if (typeof v !== 'string') return '';
  let s = v.normalize('NFC');
  // fuera caracteres de control (menos saltos de línea si multiline)
  s = s.replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F‪-‮⁦-⁩]/g : /[\u0000-\u001F\u007F‪-‮⁦-⁩]/g, '');
  if (multiline) s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  return [...s].slice(0, max).join('');
}

export function cleanName(v) {
  const s = cleanText(v, LIMITS.NAME_MAX).replace(/\s+/g, ' ');
  if ([...s].length < LIMITS.NAME_MIN || !nameRe.test(s)) return null;
  return s;
}

export function cleanInt(v, min, max, def = min) {
  if (v === null || v === undefined || v === '') return def;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function cleanNum(v, min, max, def = min) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function cleanId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(v) ? v : null;
}

export function slugify(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'porche';
}

// ---------- Filtro de chat ----------
// Normaliza conservando la longitud (para poder sustituir en el texto original).
function norm(s) {
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const d = c.normalize('NFD')[0].toLowerCase();
    o += d.length === 1 ? d : c;
  }
  return o;
}
export function filterChat(text, words = DEFAULT_BADWORDS, allowLinks = false) {
  let out = text;
  let flagged = false;
  if (!allowLinks && /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|es|net|org|io|ly|me|tv|xyz|gg|link)\b)/i.test(out)) {
    out = out.replace(/(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|es|net|org|io|ly|me|tv|xyz|gg|link)\b\S*)/gi, '[enlace]');
    flagged = true;
  }
  const n = norm(out);
  for (const w of words) {
    const nw = norm(w).trim();
    if (!nw) continue;
    let idx = n.indexOf(nw);
    while (idx !== -1) {
      const before = idx === 0 || !/[a-z0-9]/.test(n[idx - 1]);
      const after = idx + nw.length >= n.length || !/[a-z0-9]/.test(n[idx + nw.length]);
      if (before && after) {
        out = out.slice(0, idx) + '*'.repeat(nw.length) + out.slice(idx + nw.length);
        flagged = true;
      }
      idx = n.indexOf(nw, idx + nw.length);
    }
  }
  return { text: out, flagged };
}

export const now = () => Date.now();
export const sec = () => Math.floor(Date.now() / 1000);
