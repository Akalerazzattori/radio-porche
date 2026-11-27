// Archivo: podcasts publicados. Más escuchados (escuchas reales > 1 min), nuevos y búsqueda.
import { api } from '../api.js';
import { html, mount, icon, fmtDur, fmtDate, debounce, setPct } from '../util.js';
import { podcastCover } from '../common.js';
import { player, getProgress } from './player.js';

export async function render(view, _p, { go }) {
  const params = new URLSearchParams(location.search);
  let sort = localStorage.getItem('rp_sort') || 'top';
  let q = '';
  mount(view, html`
    <section class="screen">
      <div class="top">
        <div><h1 class="h1">Archivo</h1></div>
        <span class="mono muted small" data-el="count"></span>
      </div>
      <div class="promo">
        <h2 class="h2">Cada programa, un podcast</h2>
        <p>Se graba al emitir, con portada y capítulos. Ranking por escuchas reales.</p>
      </div>
      <div class="seg">
        <button data-sort="top" class="${sort === 'top' ? 'on' : ''}">Más escuchados</button>
        <button data-sort="new" class="${sort === 'new' ? 'on' : ''}">Nuevos</button>
      </div>
      <div class="row gap">
        <input class="input" type="search" placeholder="Buscar programas o porches…" maxlength="60" data-el="q" aria-label="Buscar">
      </div>
      <div class="fill scroll"><div class="list" data-el="list"></div></div>
    </section>`);
  const list = view.querySelector('[data-el=list]');
  const qi = view.querySelector('[data-el=q]');
  if (params.get('buscar')) setTimeout(() => qi.focus(), 100);

  async function load() {
    list.innerHTML = '<p class="muted small center">Cargando…</p>';
    try {
      const r = await api(`/api/podcasts?sort=${sort}&q=${encodeURIComponent(q)}&limit=50`);
      view.querySelector('[data-el=count]').textContent = `${r.podcasts.length}${r.podcasts.length === 50 ? '+' : ''} programas`;
      if (!r.podcasts.length) {
        mount(list, html`<div class="empty"><img src="/img/scenes/escena-4.webp" alt=""><p>${q ? 'No hay nada con esa búsqueda.' : 'Aún no hay podcasts publicados. ¡Graba el primero desde tu porche!'}</p></div>`);
        return;
      }
      mount(list, html`${r.podcasts.map((p) => html`
        <a class="item" href="/p/${p.id}">
          <img class="thumb" src="${podcastCover(p)}" alt="" loading="lazy">
          <div class="grow">
            <div class="t ellip">${p.title}${p.part > 1 ? ` · Parte ${p.part}` : ''}</div>
            <div class="m ellip">${p.porchName} · ${fmtDate(p.created)} · ${fmtDur(p.duration)}</div>
            <div class="m">${p.listens} escuchas · ♥ ${p.likes}</div>
            <div class="prog" data-p="${Math.min(100, (getProgress(p.id) / p.duration) * 100)}"><i></i></div>
          </div>
          <button class="play-dot" data-play="${p.id}" aria-label="Escuchar ${p.title}">${icon('play')}</button>
        </a>`)}`);
      list.querySelectorAll('.prog').forEach((el) => setPct(el, '--p', Number(el.dataset.p)));
      list.onclick = (e) => {
        const b = e.target.closest('[data-play]');
        if (!b) return;
        e.preventDefault();
        const p = r.podcasts.find((x) => x.id === b.dataset.play);
        player.load(p, true);
        go(`/p/${p.id}`);
      };
    } catch (e) { list.innerHTML = `<p class="muted center">${e.message}</p>`; }
  }
  view.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => {
    sort = b.dataset.sort; localStorage.setItem('rp_sort', sort);
    view.querySelectorAll('[data-sort]').forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  qi.addEventListener('input', debounce(() => { q = qi.value.trim(); load(); }, 300));
  load();
}
