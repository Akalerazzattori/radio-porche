// Piezas compartidas: entrar con nombre, aceptar condiciones, reportar, bloquear, compartir.
import { api, session, getConfig, turnstileWidget } from './api.js';
import { LEGAL, LIMITS, NAME_PATTERN, REPORT_REASONS } from './config.js';
import { html, sheet, toast, icon, esc, initial, avatarColor } from './util.js';

/** Avatar: su foto si la tiene, si no la inicial en un círculo de color. */
export function avatar(p, cls = '') {
  if (p && p.av && p.dev) return html`<img class="av ${cls}" src="/api/avatar/${p.dev}?v=${p.av}" alt="">`;
  return html`<span class="av ${cls} ${avatarColor(p?.name)}">${initial(p?.name)}</span>`;
}

export function porchCover(p) {
  if (!p) return '/img/scenes/escena-1.webp';
  return p.hasCover ? `/api/porch/${p.id}/cover` : `/img/scenes/escena-${p.scene || 1}.webp`;
}
export function podcastCover(p) {
  return p.hasCover ? `/api/podcasts/${p.id}/cover` : `/img/scenes/escena-${p.scene || 1}.webp`;
}
export const freqTxt = (f) => Number(f).toFixed(1).replace('.', ',') === 'NaN' ? '' : Number(f).toFixed(1);

// ---------- Bloqueos (en el dispositivo) ----------
export function blockedList() { try { return JSON.parse(localStorage.getItem('rp_blocked') || '[]'); } catch { return []; } }
export function isBlocked(dev) { return !!dev && blockedList().includes(dev); }
export function blockPerson(dev) {
  const l = blockedList();
  if (!l.includes(dev)) l.push(dev);
  localStorage.setItem('rp_blocked', JSON.stringify(l.slice(-500)));
}
export function unblockAll() { localStorage.removeItem('rp_blocked'); }

// ---------- Condiciones con versión ----------
export function termsAccepted() { return localStorage.getItem('rp_terms') === LEGAL.TERMS_VERSION; }
function setTerms() { localStorage.setItem('rp_terms', LEGAL.TERMS_VERSION); }

const legalLinks = html`<a href="/legal/condiciones" data-close="">Condiciones</a>, <a href="/legal/normas" data-close="">Normas</a> y <a href="/legal/privacidad" data-close="">Privacidad</a>`;

/** Primera visita: aviso de edad y de almacenamiento. */
export function welcomeOnce() {
  if (localStorage.getItem('rp_welcome')) return;
  const s = sheet(html`
    <img class="welcome-logo" src="/img/logo-v2.webp" alt="Radio Porche" width="300" height="104">
    <p class="center b">Radios de barrio en directo. Sintoniza, comenta y pide micro.</p>
    <div class="banner yellow">${icon('shield')} Solo para mayores de 18 años</div>
    <p class="muted small">Sin cookies de seguimiento ni analítica: solo guardamos en tu móvil lo necesario para que funcione. Más en ${legalLinks}.</p>
    <button class="btn yellow big" data-close="ok">Tengo 18 o más · Entrar</button>`, { dismissable: false });
  s.done.then(() => localStorage.setItem('rp_welcome', '1'));
}

/** Si cambió la versión de las condiciones, se vuelven a pedir. */
export async function checkTermsVersion() {
  if (!session.token || termsAccepted()) return;
  const s = sheet(html`
    <h2 class="h2">Hemos actualizado las condiciones</h2>
    <p class="muted">Para seguir usando Radio Porche, revisa y acepta las ${legalLinks} (versión ${LEGAL.TERMS_VERSION}).</p>
    <button class="btn yellow big" data-close="ok">Acepto</button>`, { dismissable: false });
  await s.done;
  setTerms();
  api('/api/me/terms', { method: 'POST', body: { terms: LEGAL.TERMS_VERSION } }).catch(() => {});
}

/** Devuelve true si hay identidad (pide el nombre si no). */
export async function requireIdentity(reason = '') {
  if (session.token) return true;
  const cfg = await getConfig();
  if (cfg.pausePorches) toast('Ahora mismo no se pueden abrir porches nuevos, pero puedes entrar para escuchar y comentar.');
  let getToken = () => '';
  const s = sheet(html`
    <h2 class="h2">Entra con tu nombre</h2>
    <p class="muted small">${reason || 'Sin email ni contraseña. Tu identidad se guarda en este dispositivo.'}</p>
    <label class="field">Tu nombre
      <input class="input" name="name" autocomplete="nickname" minlength="${LIMITS.NAME_MIN}" maxlength="${LIMITS.NAME_MAX}" pattern="${NAME_PATTERN}" placeholder="Lucía, Paco del bar…" required>
    </label>
    <label class="check"><input type="checkbox" name="adult"> <span>Tengo 18 años o más.</span></label>
    <label class="check"><input type="checkbox" name="terms"> <span>Acepto las ${legalLinks}.</span></label>
    <div class="ts"></div>
    <button class="btn yellow big" data-act="go">Entrar</button>
    <button class="btn ghost" data-act="recover">Ya tengo porche en otro aparato</button>`, {
    async onMount(api2) {
      const el = api2.el;
      getToken = await turnstileWidget(el.querySelector('.ts'));
      setTimeout(() => el.querySelector('input[name=name]').focus(), 80);
      el.querySelector('[data-act=recover]').onclick = () => { api2.close(null); recoverSheet(); };
      el.querySelector('[data-act=go]').onclick = async () => {
        const name = el.querySelector('input[name=name]').value.trim();
        if (name.length < LIMITS.NAME_MIN || !new RegExp(NAME_PATTERN).test(name)) return toast('Escribe un nombre válido (2–30 letras o números)', 'bad');
        if (!el.querySelector('input[name=adult]').checked) return toast('Radio Porche es solo para mayores de 18', 'bad');
        if (!el.querySelector('input[name=terms]').checked) return toast('Acepta las condiciones para continuar', 'bad');
        const btn = el.querySelector('[data-act=go]');
        btn.disabled = true;
        try {
          const r = await api('/api/identity', { method: 'POST', body: { name, adult: true, terms: LEGAL.TERMS_VERSION, turnstile: getToken() } });
          session.set({ token: r.token, deviceId: r.deviceId, name: r.name, porchId: r.porch?.id || null });
          setTerms();
          toast(`¡Bienvenido, ${r.name}!`, 'good');
          api2.close('ok');
          window.dispatchEvent(new CustomEvent('rp:identity'));
        } catch (e) { toast(e.message, 'bad'); btn.disabled = false; try { window.turnstile?.reset(); } catch {} }
      };
    },
  });
  return (await s.done) === 'ok';
}

export function recoveryLink() {
  return `${location.origin}/#recuperar=${encodeURIComponent(session.token)}`;
}

export function recoverSheet() {
  const s = sheet(html`
    <h2 class="h2">Usar mi porche en este aparato</h2>
    <p class="muted small">En el aparato donde ya tienes tu porche, ve a <b>Perfil → Vincular otro aparato</b>. Te saldrá un código de 6 cifras: escríbelo aquí.</p>
    <input class="input link-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" data-el="code">
    <button class="btn yellow big" data-a="code">Vincular</button>
    <details class="small muted"><summary>Tengo un enlace de recuperación</summary>
      <input class="input mt-s" placeholder="https://…/#recuperar=…" data-el="link">
      <button class="btn ghost mt-s" data-a="link">Usar enlace</button>
    </details>`, {
    onMount(a) {
      const code = a.el.querySelector('[data-el=code]');
      setTimeout(() => code.focus(), 80);
      const go = async () => {
        const c = code.value.replace(/\D/g, '');
        if (c.length !== 6) return toast('El código tiene 6 cifras', 'bad');
        try {
          const r = await api('/api/link/claim', { method: 'POST', body: { code: c } });
          session.set({ token: r.token, deviceId: r.deviceId, name: r.name, porchId: r.porchId });
          setTerms();
          toast(`Vinculado. Hola, ${r.name}`, 'good');
          window.dispatchEvent(new CustomEvent('rp:identity'));
          a.close('ok');
        } catch (e) { toast(e.message, 'bad'); }
      };
      code.addEventListener('input', () => { if (code.value.replace(/\D/g, '').length === 6) go(); });
      a.el.querySelector('[data-a=code]').onclick = go;
      a.el.querySelector('[data-a=link]').onclick = async () => {
        const v = a.el.querySelector('[data-el=link]').value.trim();
        const m = /recuperar=([^&\s]+)/.exec(v);
        if (!m) return toast('Ese enlace no parece de recuperación', 'bad');
        if (await useRecoveryToken(decodeURIComponent(m[1]))) a.close('ok');
      };
    },
  });
  return s.done;
}

/** Muestra un código de 6 cifras para entrar con esta misma identidad en otro aparato. */
export async function linkDeviceSheet() {
  let r;
  try { r = await api('/api/link/create', { method: 'POST', body: {} }); } catch (e) { toast(e.message, 'bad'); return; }
  let s;
  s = sheet(html`
    <h2 class="h2">Vincular otro aparato</h2>
    <p class="muted small">En el ordenador (o el otro móvil) abre <b>${location.host}</b>, ve a <b>Perfil → Ya tengo porche en otro aparato</b> y escribe:</p>
    <div class="link-code">${r.code}</div>
    <p class="muted tiny center" data-el="left"></p>
    <p class="muted tiny">Ese aparato será tú: podrá emitir, ser el estudio o controlar la cabina a distancia. El código sirve una sola vez y caduca en 10 minutos. No se lo des a nadie.</p>
    <div class="row gap"><button class="btn ghost grow" data-a="new">Código nuevo</button><button class="btn yellow grow" data-close="">Hecho</button></div>`);
  const left = s.el.querySelector('[data-el=left]');
  s.el.querySelector('[data-a=new]').onclick = async () => {
    try { r = await api('/api/link/create', { method: 'POST', body: {} }); s.el.querySelector('.link-code').textContent = r.code; toast('Código nuevo. El anterior ya no vale.'); } catch (e) { toast(e.message, 'bad'); }
  };
  const iv = setInterval(() => {
    const ms = r.exp - Date.now();
    if (ms <= 0) { left.textContent = 'Caducado. Pide otro.'; clearInterval(iv); return; }
    left.textContent = `Caduca en ${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  }, 500);
  await s.done;
  clearInterval(iv);
}

export async function useRecoveryToken(token) {
  const prev = session.get();
  session.set({ token });
  try {
    const me = await api('/api/me');
    session.set({ token, deviceId: me.deviceId, name: me.name, porchId: me.porch?.id || null });
    setTerms();
    toast(`Hola de nuevo, ${me.name}`, 'good');
    window.dispatchEvent(new CustomEvent('rp:identity'));
    return true;
  } catch {
    if (prev) session.set(prev); else session.clear();
    toast('Ese enlace no es válido o la identidad se borró', 'bad');
    return false;
  }
}

// ---------- Reportar ----------
export async function reportSheet({ kind, obj, snapshot = '', target = '', what = 'esto' }) {
  if (!(await requireIdentity('Para reportar necesitas entrar con tu nombre.'))) return;
  const s = sheet(html`
    <h2 class="h2">Reportar ${what}</h2>
    <p class="muted small">Elige el motivo. Varios reportes lo ocultan automáticamente hasta que se revise.</p>
    ${REPORT_REASONS.map((r) => html`<button class="opt" data-r="${r.id}">${icon('flag')} ${r.name}</button>`)}
    <button class="btn ghost" data-close="">Cancelar</button>`, {
    onMount(a) {
      a.el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-r]');
        if (!b) return;
        try {
          await api('/api/report', { method: 'POST', body: { kind, obj: String(obj), reason: b.dataset.r, snapshot: String(snapshot).slice(0, 400), target } });
          toast('Gracias. Lo revisaremos.', 'good');
        } catch (err) { toast(err.message, 'bad'); }
        a.close('ok');
      });
    },
  });
  return s.done;
}

/** Menú de una persona (chat): bloquear / reportar (y moderar si procede). */
export function personMenu({ name, dev, cid, msg, canMod, isHost, onMod }) {
  const s = sheet(html`
    <h2 class="h2">${name}</h2>
    ${msg ? html`<p class="muted small">"${msg.text}"</p>` : ''}
    ${canMod ? html`
      <button class="opt" data-a="mute">${icon('micoff')} Silenciar micro</button>
      <button class="opt" data-a="kick">${icon('close')} Expulsar de la sala</button>
      ${isHost ? html`<button class="opt danger" data-a="ban">${icon('block')} Expulsar y bloquear en mi porche</button>` : ''}
      ${msg && canMod ? html`<button class="opt" data-a="pin">${icon('flag')} Fijar este mensaje</button>` : ''}` : ''}
    ${dev && dev !== session.deviceId ? html`
      <button class="opt" data-a="block">${icon('block')} Bloquear (dejar de verle y oírle)</button>
      <button class="opt danger" data-a="report">${icon('flag')} Reportar</button>` : ''}
    <button class="btn ghost" data-close="">Cerrar</button>`, {
    onMount(a) {
      a.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        const act = b.dataset.a;
        a.close(act);
        if (act === 'block') { blockPerson(dev); toast(`Has bloqueado a ${name}`); window.dispatchEvent(new CustomEvent('rp:blocked')); }
        else if (act === 'report') reportSheet({ kind: 'chat', obj: msg ? msg.id : dev, snapshot: msg ? `${name}: ${msg.text}` : name, target: dev, what: 'este mensaje' });
        else onMod?.(act, { cid, dev, msg });
      });
    },
  });
  return s.done;
}

export async function shareUrl(url, title) {
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Enlace copiado'); } catch { prompt('Copia el enlace:', url); }
}

export async function copy(text, msg = 'Copiado') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copia:', text); }
}

export function nameColor(seed) {
  const c = ['c-yellow', 'c-orange', 'c-teal', 'c-red', 'c-cream', 'c-violet'];
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return c[h % c.length];
}

export { esc };
