// Entrar con Google (Google Identity Services). Solo aparece si el ID de cliente está puesto en Admin → Ajustes.
import { getConfig } from './api.js';

let loading = null;
function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => res();
    s.onerror = () => { loading = null; rej(new Error('No se ha podido cargar Google')); };
    document.head.appendChild(s);
  });
  return loading;
}

/** ¿Está activado «Entrar con Google»? */
export async function googleEnabled() {
  try { return !!(await getConfig()).googleClientId; } catch { return false; }
}

/**
 * Pinta el botón oficial de Google dentro de `el`. Al elegir cuenta llama a onCredential(credential).
 * Devuelve false si no está activado o no se puede cargar.
 */
export async function renderGoogleButton(el, onCredential, { text = 'continue_with' } = {}) {
  const cfg = await getConfig().catch(() => ({}));
  if (!cfg.googleClientId || !el) return false;
  try { await loadGis(); } catch { return false; }
  window.google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    callback: (r) => r?.credential && onCredential(r.credential),
    ux_mode: 'popup',
    auto_select: false,
    cancel_on_tap_outside: true,
    use_fedcm_for_prompt: true,
  });
  const width = Math.min(360, Math.max(220, Math.floor(el.clientWidth || 320)));
  window.google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', shape: 'pill', text, locale: 'es', width, logo_alignment: 'center' });
  return true;
}
