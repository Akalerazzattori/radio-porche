// Cliente de la API e identidad guardada en el dispositivo.
// La identidad está desacoplada: en el futuro se puede añadir login con Google
// sustituyendo solo cómo se obtiene el token.

import { setSetting } from './db.js';

const KEY = 'rp_identity';
// Copia de seguridad de la identidad en IndexedDB: si el sistema borra localStorage, la recuperamos al abrir
const backup = (v) => { try { setSetting('identity', v).catch(() => {}); } catch {} };
let ident = null;
try { ident = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { ident = null; }

export const session = {
  get() { return ident; },
  get token() { return ident?.token || ''; },
  get deviceId() { return ident?.deviceId || ''; },
  get name() { return ident?.name || ''; },
  get porchId() { return ident?.porchId || null; },
  set(v) { ident = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} backup(v); },
  update(patch) { this.set({ ...(ident || {}), ...patch }); },
  clear() { ident = null; try { localStorage.removeItem(KEY); } catch {} backup(null); },
};

export class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export async function api(path, { method = 'GET', body, form, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (session.token) h.authorization = `Bearer ${session.token}`;
  let b;
  if (form) b = form;
  else if (raw) b = raw;
  else if (body !== undefined) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
  let res;
  try {
    res = await fetch(path, { method, headers: h, body: b });
  } catch {
    throw new ApiError(0, 'Sin conexión. Revisa tu internet.');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 && session.token) {
      // token caducado o identidad borrada
      window.dispatchEvent(new CustomEvent('rp:logout'));
    }
    throw new ApiError(res.status, data?.error || 'Algo ha fallado');
  }
  return data;
}

let configCache = null;
export async function getConfig() {
  if (!configCache) configCache = await api('/api/config').catch(() => ({ turnstileSiteKey: '', termsVersion: '' }));
  return configCache;
}

// ---------- Turnstile (opcional) ----------
let tsLoading = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (!tsLoading) {
    tsLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => res();
      s.onerror = () => rej(new Error('turnstile'));
      document.head.appendChild(s);
    });
  }
  return tsLoading;
}
/** Pinta el widget en `el` si hay clave configurada. Devuelve una función que da el token (o ''). */
export async function turnstileWidget(el) {
  const cfg = await getConfig();
  if (!cfg.turnstileSiteKey) { el.hidden = true; return () => ''; }
  let token = '';
  try {
    await loadTurnstile();
    window.turnstile.render(el, { sitekey: cfg.turnstileSiteKey, theme: 'dark', language: 'es', callback: (t) => { token = t; } });
  } catch { el.hidden = true; }
  return () => token;
}
