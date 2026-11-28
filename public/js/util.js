// Utilidades de interfaz. Todo texto de usuarios pasa por esc() o textContent (contra XSS).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export function esc(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
}

/** Plantilla segura: los valores interpolados se escapan salvo que sean raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v === false || v === null || v === undefined) return;
      if (v && v.__raw) out += v.html;
      else if (Array.isArray(v)) out += v.map((x) => (x && x.__raw ? x.html : esc(x))).join('');
      else out += esc(v);
    }
  });
  return { __raw: true, html: out };
}
export const raw = (s) => ({ __raw: true, html: String(s) });

export function mount(el, tpl) {
  el.innerHTML = tpl.__raw ? tpl.html : esc(tpl);
  return el;
}

export function fmtTime(sec, forceH = false) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h || forceH ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h || forceH ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}
export function fmtDur(sec) {
  const m = Math.round((sec || 0) / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
export function fmtShortDur(sec) {
  sec = Math.round(sec || 0);
  return sec < 60 ? `0:${String(sec).padStart(2, '0')}` : fmtTime(sec);
}
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export function fmtDate(ts) {
  const d = new Date(ts);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function fmtDateLong(ts) {
  const d = new Date(ts);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
export function weekdayGreeting() {
  const d = new Date();
  const day = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][d.getDay()];
  const h = d.getHours();
  return `${day} ${h < 6 ? 'de madrugada' : h < 13 ? 'por la mañana' : h < 21 ? 'por la tarde' : 'noche'}`;
}

export function initial(name) {
  return ([...String(name || '?').trim()][0] || '?').toUpperCase();
}
const AV_COLORS = ['yellow', 'orange', 'teal', 'red', 'cream', 'violet'];
export function avatarColor(seed) {
  let h = 0;
  for (const c of String(seed || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch {}
}

export const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
export const canShareTab = () => !isMobile() && !!navigator.mediaDevices?.getDisplayMedia && /Chrome|Edg/.test(navigator.userAgent);

// ---------- Avisos breves ----------
export function toast(msg, kind = '') {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ---------- Hojas / modales ----------
export function sheet(tpl, { onMount, dismissable = true, cls = '' } = {}) {
  const root = document.getElementById('overlays');
  const wrap = document.createElement('div');
  wrap.className = `sheet-wrap ${cls}`;
  wrap.innerHTML = `<div class="sheet-bg"></div><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div><div class="sheet-body"></div></div>`;
  mount(wrap.querySelector('.sheet-body'), tpl);
  root.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));
  let closed = false;
  const close = (v) => {
    if (closed) return;
    closed = true;
    wrap.classList.remove('in');
    setTimeout(() => wrap.remove(), 250);
    api.resolve?.(v);
  };
  const api = { el: wrap.querySelector('.sheet-body'), close };
  if (dismissable) wrap.querySelector('.sheet-bg').addEventListener('click', () => close(null));
  wrap.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) close(c.dataset.close || null);
  });
  api.done = new Promise((r) => (api.resolve = r));
  onMount?.(api);
  return api;
}

export function confirmSheet(title, text, { ok = 'Aceptar', cancel = 'Cancelar', danger = false } = {}) {
  const s = sheet(html`
    <h2 class="h2">${title}</h2>
    <p class="muted">${text}</p>
    <div class="row gap mt">
      <button class="btn ghost grow" data-close="">${cancel}</button>
      <button class="btn ${danger ? 'red' : 'yellow'} grow" data-close="ok">${ok}</button>
    </div>`);
  return s.done.then((v) => v === 'ok');
}

export function promptSheet(title, { value = '', max = 80, placeholder = '', ok = 'Guardar', multiline = false } = {}) {
  const s = sheet(html`
    <h2 class="h2">${title}</h2>
    ${multiline ? html`<textarea class="input" rows="4" maxlength="${max}" placeholder="${placeholder}">${value}</textarea>` : html`<input class="input" maxlength="${max}" placeholder="${placeholder}" value="${value}">`}
    <div class="row gap mt">
      <button class="btn ghost grow" data-close="">Cancelar</button>
      <button class="btn yellow grow" data-act="ok">${ok}</button>
    </div>`, {
    onMount(api) {
      const inp = api.el.querySelector('input,textarea');
      setTimeout(() => inp.focus(), 50);
      const go = () => { api.resolve(inp.value.trim()); api.close(inp.value.trim()); };
      api.el.querySelector('[data-act=ok]').onclick = go;
      if (!multiline) inp.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    },
  });
  return s.done;
}

export function on(root, event, selector, fn) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Pone anchuras/posiciones dinámicas sin atributos style (CSP). */
export function setPct(el, prop, v) {
  if (el) el.style.setProperty(prop, `${Math.max(0, Math.min(100, v))}%`);
}

// Iconos SVG (inline, sin dependencias)
const I = {
  radio: '<circle cx="12" cy="12" r="2.2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micoff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  heartf: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" fill="currentColor"/>',
  clip: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.2 8.2L20 20M8.2 15.8L20 4"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  share: '<path d="M12 15V4M7 8l5-5 5 5M5 13v6h14v-6"/>',
  moon: '<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/>',
  back15: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="Space Mono">15</text>',
  fwd30: '<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="Space Mono">30</text>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  hp: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  rec: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
  flag: '<path d="M5 21V4h11l-1.5 4L16 12H5"/>',
  block: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  tab: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.2 8.2L20 20M8.2 15.8L20 4"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8 11h6M11 8v6"/>',
  zoomout: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8 11h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  send: '<path d="M21 3 10 14M21 3l-6.5 18-4.5-7-7-4.5z"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  starf: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4M21 12h0"/>',
};
export function icon(name, cls = '') {
  return raw(`<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || ''}</svg>`);
}

/** ¿Este aparato es un móvil/tablet o un ordenador? */
export const DEVICE_KIND = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ? 'móvil' : 'ordenador';
