// Podcasts: portada al estilo de la app de Podcasts del iPhone.
// Sigue escuchando · Populares · Programas · Nuevos · filas por categoría (solo las que tienen contenido).
// Las categorías favoritas se piden solo cuando ya hay variedad.
import { api } from '../api.js';
import { html, mount, icon, fmtDur, fmtDate, debounce, setPct, toast } from '../util.js';
import { podcastCover, brandHead } from '../common.js';
import { player, getProgress } from './player.js';
import { programCover, getCategories, catName } from '../programs.js';

const favs = () => { try { return JSON.parse(localStorage.getItem('rp_favcats') || '[]'); } catch { return []; } };
export function recentList() { try { return JSON.parse(localStorage.getItem('rp_recent') || '[]'); } catch { return []; } }

function card(p, cls = '') {
  const prog = Math.min(100, (getProgress(p.id) / p.duration) * 100);
  return html`<a class="pcard ${cls}" href="/p/${p.id}">
    <span class="pcard-img"><img src="${podcastCover(p)}" alt="" loading="lazy"><button class="pcard-play" data-play="${p.id}" aria-label="Escuchar ${p.title}">${icon('play')}</button></span>
    <span class="pcard-t ellip2">${p.title}</span>
    <span class="pcard-m ellip">${p.programName ? `${p.programName}${p.episode ? ` · Ep. ${p.episode}` : ''}` : p.porchName}</span>
    <span class="pcard-m">${fmtDate(p.created)} · ${fmtDur(p.duration)}</span>
    ${prog > 1 ? html`<span class="pcard-bar" data-p="${prog}"><i></i></span>` : ''}
  </a>`;
}
function progCard(g, cats) {
  return html`<a class="pcard" href="/programa/${g.id}">
    <span class="pcard-img"><img src="${programCover(g)}" alt="" loading="lazy"></span>
    <span class="pcard-t ellip2">${g.name}</span>
    <span class="pcard-m ellip">${g.porchName}</span>
    <span class="pcard-m">${catName(cats, g.category)} · ${g.episodes} ep.</span>
  </a>`;
}
const row = (title, items, more = '') => html`<section class="hsec"><div class="row between"><h2 class="hsec-t">${title}</h2>${more}</div><div class="hrow">${items}</div></section>`;

export async function render(view, _p, { go }) {
  const params = new URLSearchParams(location.search);
  let q = '', cat = params.get('cat') || '';
  mount(view, html`
    <section class="screen">
      <div class="top">
        ${brandHead('Podcasts')}
        <button class="icon-btn" data-act="search" aria-label="Buscar">${icon('search')}</button>
      </div>
      <input class="input" type="search" placeholder="Buscar programas, episodios o porches…" maxlength="60" data-el="q" aria-label="Buscar" hidden>
      <div class="fill scroll" data-el="body"><p class="muted small center">Cargando…</p></div>
    </section>`);
  const body = view.querySelector('[data-el=body]');
  const qi = view.querySelector('[data-el=q]');
  const cats = await getCategories();
  let home = null;

  const paintBars = () => body.querySelectorAll('[data-p]').forEach((el) => setPct(el, '--p', Number(el.dataset.p)));

  async function showHome() {
    try { home = home && home.total !== undefined ? home : await api('/api/home'); } catch (e) { body.innerHTML = `<p class="muted center">${e.message}</p>`; return; }
    if (!home.total) {
      mount(body, html`<div class="empty"><img src="/img/scenes/escena-4.webp" alt=""><p class="b">Aún no hay podcasts publicados.</p><p class="muted small">Sal al aire en modo <b>Directo + grabación</b> desde el Estudio y publica el primero.</p><a class="btn red" href="/estudio">Ir al estudio</a></div>`);
      return;
    }
    const used = cats.filter((c) => c.used);
    const fav = favs();
    const continueItems = recentList().filter((p) => { const t = getProgress(p.id); return t > 5 && t < p.duration - 15; }).slice(0, 10);
    const catRows = [...home.byCategory].sort((a, b) => (fav.includes(b.category.id) ? 1 : 0) - (fav.includes(a.category.id) ? 1 : 0));
    const askFavs = used.length >= 3 && !localStorage.getItem('rp_favcats') && !localStorage.getItem('rp_favcats_skip');
    mount(body, html`
      ${used.length > 1 ? html`<div class="chips-row">${used.map((c) => html`<button class="cat-chip" data-cat="${c.id}">${c.name}</button>`)}</div>` : ''}
      ${askFavs ? html`<div class="card col gap-s fav-card">
        <b>¿Qué te gusta escuchar?</b><span class="muted small">Elige tus categorías y te las pondremos primero.</span>
        <div class="chips-wrap">${used.map((c) => html`<button class="cat-chip" data-fav="${c.id}">${c.name}</button>`)}</div>
        <div class="row gap"><button class="btn sm ghost" data-act="favskip">Ahora no</button><button class="btn sm yellow grow" data-act="favsave">Guardar</button></div>
      </div>` : ''}
      ${continueItems.length ? row('Sigue escuchando', continueItems.map((p) => card(p, 'wide'))) : ''}
      ${home.popular.length ? row('Populares', home.popular.map((p) => card(p))) : ''}
      ${home.programs.length ? row('Programas', home.programs.map((g) => progCard(g, cats))) : ''}
      ${home.recent.length ? row('Nuevos episodios', home.recent.map((p) => card(p))) : ''}
      ${catRows.map((r) => row(r.category.name, r.podcasts.map((p) => card(p)), html`<button class="link-btn" data-cat="${r.category.id}">Ver todo</button>`))}
    `);
    paintBars();
  }

  let lastList = [];
  async function showList() {
    body.innerHTML = '<p class="muted small center">Cargando…</p>';
    try {
      const r = await api(`/api/podcasts?sort=${q ? 'top' : 'new'}&q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}&limit=50`);
      lastList = r.podcasts;
      const c = cats.find((x) => x.id === cat);
      mount(body, html`
        <div class="row gap-s wrap">${c ? html`<button class="cat-chip on" data-act="clearcat">${c.name} ✕</button>` : ''}${q ? html`<span class="muted small">Resultados para «${q}»</span>` : ''}</div>
        <div class="list mt-s">${r.podcasts.length ? r.podcasts.map((p) => html`
          <a class="item" href="/p/${p.id}">
            <img class="thumb" src="${podcastCover(p)}" alt="" loading="lazy">
            <div class="grow">
              <div class="t ellip">${p.title}</div>
              <div class="m ellip">${p.programName ? `${p.programName}${p.episode ? ` · Ep. ${p.episode}` : ''}` : p.porchName}</div>
              <div class="m">${fmtDate(p.created)} · ${fmtDur(p.duration)} · ${p.listens} escuchas</div>
              <div class="prog" data-p="${Math.min(100, (getProgress(p.id) / p.duration) * 100)}"><i></i></div>
            </div>
            <button class="play-dot" data-play="${p.id}" aria-label="Escuchar">${icon('play')}</button>
          </a>`) : html`<div class="empty"><p>No hay nada con esa búsqueda.</p></div>`}</div>`);
      body.querySelectorAll('.prog').forEach((el) => setPct(el, '--p', Number(el.dataset.p)));
    } catch (e) { body.innerHTML = `<p class="muted center">${e.message}</p>`; }
  }
  const refresh = () => (q || cat ? showList() : showHome());

  body.addEventListener('click', async (e) => {
    const pl = e.target.closest('[data-play]');
    if (pl) {
      e.preventDefault();
      const all = [...(home?.popular || []), ...(home?.recent || []), ...(home?.byCategory || []).flatMap((r) => r.podcasts), ...lastList];
      let p = all.find((x) => x.id === pl.dataset.play);
      if (!p) { try { p = (await api(`/api/podcasts/${pl.dataset.play}`)).podcast; } catch { return; } }
      player.load(p, true);
      go(`/p/${p.id}`);
      return;
    }
    const c = e.target.closest('[data-cat]');
    if (c) { cat = c.dataset.cat; history.replaceState(history.state, '', `/podcasts?cat=${cat}`); return showList(); }
    if (e.target.closest('[data-act=clearcat]')) { cat = ''; history.replaceState(history.state, '', '/podcasts'); return refresh(); }
    const f = e.target.closest('[data-fav]');
    if (f) { f.classList.toggle('on'); return; }
    if (e.target.closest('[data-act=favsave]')) {
      const sel = [...body.querySelectorAll('[data-fav].on')].map((x) => x.dataset.fav);
      localStorage.setItem('rp_favcats', JSON.stringify(sel));
      toast(sel.length ? 'Guardado. Te pondremos primero lo que te gusta.' : 'Guardado');
      return showHome();
    }
    if (e.target.closest('[data-act=favskip]')) { localStorage.setItem('rp_favcats_skip', '1'); return showHome(); }
  });
  view.querySelector('[data-act=search]').onclick = () => { qi.hidden = !qi.hidden; if (!qi.hidden) qi.focus(); else { qi.value = ''; q = ''; refresh(); } };
  qi.addEventListener('input', debounce(() => { q = qi.value.trim(); refresh(); }, 300));
  if (params.get('buscar')) { qi.hidden = false; setTimeout(() => qi.focus(), 100); }
  refresh();
}
