// Radio Porche · arranque, rutas y barra inferior.
import { api, session } from './api.js';
import { html, mount, icon, toast, setPct, esc } from './util.js';
import { welcomeOnce, checkTermsVersion, useRecoveryToken, porchCover, podcastCover } from './common.js';
import { purgeOldDrafts, requestPersist } from './db.js';
import { live, onLive } from './live.js';
import { player } from './screens/player.js';
import { renderLegal } from './screens/legal.js';

let view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const mini = document.getElementById('mini');
const app = document.getElementById('app');

const ROUTES = [
  { re: /^\/$/, mod: () => import('./screens/onair.js'), tab: 'aire' },
  { re: /^\/(?:archivo|podcasts)$/, mod: () => import('./screens/archive.js'), tab: 'archivo' },
  { re: /^\/avisos$/, mod: () => import('./screens/notices.js'), tab: 'aire' },
  { re: /^\/perfil$/, mod: () => import('./screens/profile.js'), tab: 'perfil' },
  { re: /^\/mi-porche$/, mod: () => import('./screens/myporch.js'), tab: 'porche' },
  { re: /^\/porche\/([A-Za-z0-9_-]+)$/, mod: () => import('./screens/porch.js'), immersive: true },
  { re: /^\/estudio$/, mod: () => import('./screens/porch.js'), immersive: true, params: ['__mine'], tab: 'cabina' },
  { re: /^\/p\/([A-Za-z0-9_-]+)$/, mod: () => import('./screens/player.js'), immersive: true },
  { re: /^\/programa\/([A-Za-z0-9_-]+)$/, mod: () => import('./screens/program.js'), tab: 'archivo' },
  { re: /^\/editor\/([A-Za-z0-9_-]+)$/, mod: () => import('./screens/editor.js'), immersive: true },
  { re: /^\/legal\/([a-z-]+)$/, legal: true, immersive: true },
  { re: /^\/admin$/, mod: () => import('./screens/admin.js'), immersive: true },
];

let cleanup = null;
let navId = 0;
let currentTab = '';

export function go(path, { replace = false } = {}) {
  if (path === location.pathname + location.search && !replace) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}
function back() {
  if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
  else go('/');
}
const ctx = { go, back };

async function route() {
  const id = ++navId;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const r = ROUTES.find((x) => x.re.test(path));
  try { cleanup?.(); } catch {}
  cleanup = null;
  if (!r) { go('/', { replace: true }); return; }
  const params = r.params || (path.match(r.re) || []).slice(1);
  // Contenedor nuevo en cada pantalla: así no se acumulan escuchadores de toques
  // (antes un toque podía ejecutarse dos veces, p. ej. crear dos códigos de vinculación).
  const fresh = view.cloneNode(false);
  view.replaceWith(fresh);
  view = fresh;
  app.classList.toggle('immersive', !!r.immersive);
  currentTab = r.tab || '';
  paintTabbar();
  paintMini();
  document.title = 'Radio Porche · Radios de barrio en directo';
  if (r.legal) { renderLegal(view, params[0], ctx); return; }
  try {
    const m = await r.mod();
    if (id !== navId) return;
    const c = await m.render(view, params, ctx);
    if (id !== navId) { try { c?.(); } catch {} return; }
    cleanup = typeof c === 'function' ? c : null;
  } catch (e) {
    console.error(e);
    mount(view, html`<section class="screen"><h1 class="h1">Ups</h1><p class="muted">Algo ha fallado al abrir esta pantalla.</p><a class="btn yellow" href="/">Volver al inicio</a></section>`);
  }
}

// ---------- Barra inferior: En el aire · Archivo · [Mi porche] · Avisos · Perfil
let badge = 0;
// Barra inferior: Directo · Podcasts · [CABINA] · Mi porche · Perfil
function paintTabbar() {
  const onAir = live.active && (live.role === 'host' || live.remote) && live.state.live;
  const t = (id, href, img, label) => {
    const on = currentTab === id;
    return html`<a href="${href}" class="${on ? 'on' : ''}" ${on ? html`aria-current="page"` : ''}><span class="dot"><img class="nav-ic" src="/img/ui/nav-${img}${on ? '-on' : ''}.png" alt="" width="26" height="26"></span>${label}</a>`;
  };
  const cabinaHref = onAir && live.porch ? `/porche/${live.porch.slug}` : session.token ? '/estudio' : '/mi-porche';
  mount(tabbar, html`
    ${t('aire', '/', 'directo', 'Directo')}
    ${t('archivo', '/podcasts', 'podcasts', 'Podcasts')}
    <a href="${cabinaHref}" class="center ${onAir ? 'onair' : ''} ${currentTab === 'cabina' ? 'on' : ''}" aria-label="${onAir ? 'Estás en el aire: volver al estudio' : 'Estudio: preparar y salir al aire'}">
      <span class="center-btn"><img src="/img/ui/${onAir ? 'nav-onair' : 'nav-cabina'}.png" alt="" width="34" height="34"></span>
      <small>${onAir ? 'ON AIR' : 'Estudio'}</small>
    </a>
    ${t('porche', '/mi-porche', 'porche', 'Mi porche')}
    ${t('perfil', '/perfil', 'perfil', 'Perfil')}`);
  window.dispatchEvent(new CustomEvent('rp:badge', { detail: badge }));
}
export const getBadge = () => badge;

// ---------- Mini reproductor (directo que escuchas o podcast)
function paintMini() {
  const immersive = app.classList.contains('immersive');
  const listeningLive = live.active && live.role && live.role !== 'host' && live.porch;
  const hostLive = live.active && live.role === 'host' && live.state.live;
  if (immersive || (!listeningLive && !hostLive && !player.p)) { mini.hidden = true; return; }
  mini.hidden = false;
  if (hostLive) {
    mount(mini, html`<img src="${porchCover(live.porch)}" alt=""><div class="grow"><div class="b ellip">Estás en el aire</div><div class="muted tiny">${live.counts.listeners} oyentes · toca para volver al estudio</div></div><a class="btn sm red" href="/porche/${live.porch.slug}">Estudio</a>`);
  } else if (listeningLive) {
    mount(mini, html`<img src="${porchCover(live.porch)}" alt=""><a class="grow" href="/porche/${live.porch.slug}"><div class="b ellip">${live.state.live ? live.state.title || live.porch.name : live.porch.name}</div><div class="muted tiny">${live.state.live ? 'En directo' : 'Esperando'} · ${live.porch.freq?.toFixed?.(1) || ''}${live.role === 'guest' ? ' · tienes micro' : ''}</div></a><button class="btn sm ghost" data-mini="stoplive" aria-label="Dejar de escuchar">${icon('close')}</button>`);
  } else if (player.p) {
    const p = player.p, a = player.audio;
    mount(mini, html`<img src="${podcastCover(p)}" alt=""><a class="grow" href="/p/${p.id}"><div class="b ellip">${p.title}</div><div class="muted tiny ellip">${p.porchName}</div><div class="bar"><i></i></div></a><button class="play-dot" data-mini="toggle" aria-label="Play/pausa">${icon(a && !a.paused ? 'pause' : 'play')}</button><button class="mini-ic" data-mini="f30" aria-label="Adelante 30 segundos">${icon('fwd30')}</button>`);
    setPct(mini.querySelector('.bar'), '--p', a && a.duration ? (a.currentTime / a.duration) * 100 : 0);
  }
}
mini.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mini]');
  if (!b) return;
  if (b.dataset.mini === 'toggle') player.toggle();
  if (b.dataset.mini === 'f30') player.skip(30);
  if (b.dataset.mini === 'stoplive') { if (live.role === 'guest') live.leaveMic(); live.disconnect(); paintMini(); }
});
let miniT = 0;
player.on(() => { const n = performance.now(); if (n - miniT > 500) { miniT = n; paintMini(); } });
onLive('update', () => { paintTabbar(); paintMini(); });

// ---------- Enlaces internos sin recargar
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.preventDefault();
  go(url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', route);
// Sin zoom con dos dedos (Safari ignora user-scalable)
['gesturestart', 'gesturechange'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
window.addEventListener('rp:logout', () => { session.clear(); toast('Tu sesión ya no es válida. Entra de nuevo.', 'bad'); });

// ---------- Avisos: insignia y notificación del navegador (con la app abierta)
let knownLive = null;
async function pollNotices() {
  if (!session.token || document.hidden) return;
  try {
    const r = await api('/api/notices');
    const liveNow = r.items.filter((i) => i.type === 'live');
    const ids = new Set(liveNow.map((i) => i.porch.id));
    if (knownLive) {
      for (const it of liveNow) if (!knownLive.has(it.porch.id)) {
        toast(`${it.porch.name} está en directo`, 'good');
        if ('Notification' in window && Notification.permission === 'granted') {
          try { const n = new Notification(`${it.porch.name} está en directo`, { body: it.porch.liveTitle || 'Entra a escuchar', icon: '/img/icon2-192.png', tag: it.porch.id }); n.onclick = () => { window.focus(); go(`/porche/${it.porch.slug}`); }; } catch {}
        }
      }
    }
    knownLive = ids;
    const seen = Number(localStorage.getItem('rp_notices_seen') || 0);
    badge = r.items.filter((i) => i.type === 'live' || (i.type === 'podcast' && i.ts > seen)).length;
    paintTabbar();
  } catch {}
}
window.addEventListener('rp:noticesSeen', () => { badge = 0; paintTabbar(); });
window.addEventListener('rp:identity', () => { pollNotices(); paintTabbar(); });

// ---------- Versión nueva: se recarga sola (nunca en mitad de un directo o con micro)
let bootVersion = null;
async function checkVersion() {
  try {
    const { v } = await (await fetch('/api/version', { cache: 'no-store' })).json();
    if (!bootVersion) { bootVersion = v; return; }
    if (v === bootVersion) return;
    const busy = (live.active && (live.role === 'guest' || live.state?.live || (live.role === 'host' && document.visibilityState === 'visible'))) || (player.audio && !player.audio.paused) || location.pathname.startsWith('/editor');
    if (!busy) location.reload();
  } catch {}
}
function watchVersion() {
  checkVersion();
  setInterval(checkVersion, 5 * 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
}

// ---------- Arranque
(async function start() {
  const m = /#recuperar=([^&]+)/.exec(location.hash);
  if (m) { history.replaceState(null, '', location.pathname + location.search); await useRecoveryToken(decodeURIComponent(m[1])); }
  if (session.get()?.token) api('/api/me').then((me) => { if ((me.avatar || 0) !== (session.get()?.avatar || 0)) { session.update({ avatar: me.avatar || 0 }); if (location.pathname === '/perfil') route(); } }).catch(() => {});
  route();
  welcomeOnce();
  checkTermsVersion();
  purgeOldDrafts();
  requestPersist();
  pollNotices();
  setInterval(pollNotices, 45000);
  watchVersion();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
