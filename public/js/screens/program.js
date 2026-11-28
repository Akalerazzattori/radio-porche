// Página de un programa: portada, de qué va, y sus episodios (con sus partes).
import { api, session } from '../api.js';
import { html, mount, icon, toast, fmtDur, fmtDate, setPct } from '../util.js';
import { podcastCover, requireIdentity, shareUrl } from '../common.js';
import { programCover, getCategories, catName, programSheet } from '../programs.js';
import { player, getProgress } from './player.js';

export async function render(view, [id], { go, back }) {
  let d;
  try { d = await api(`/api/program/${id}`); } catch (e) {
    mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Programa</h1><button class="icon-btn" data-x>${icon('close')}</button></div><div class="empty"><p>${e.message}</p></div></section>`);
    view.querySelector('[data-x]').onclick = back;
    return;
  }
  const g = d.program, eps = d.episodes;
  const cats = await getCategories();
  document.title = `${g.name} · Radio Porche`;
  const mine = g.owner === session.deviceId;
  mount(view, html`
    <section class="screen">
      <div class="top">
        <button class="icon-btn" data-act="back" aria-label="Volver">${icon('back')}</button>
        <div class="h3 grow center">Programa</div>
        <button class="icon-btn" data-act="share" aria-label="Compartir">${icon('share')}</button>
      </div>
      <div class="fill scroll col gap">
        <div class="prog-hero">
          <img src="${programCover(g)}" alt="">
          <div class="grow">
            <h1 class="h1">${g.name}</h1>
            <a class="muted small" href="/porche/${g.porchSlug}">${g.porchName}</a>
            <div class="row gap-s wrap mt-s"><span class="cat-chip on small">${catName(cats, g.category)}</span><span class="muted small">${g.episodes} episodios</span></div>
          </div>
        </div>
        ${g.description ? html`<p class="small">${g.description}</p>` : ''}
        <div class="row gap">
          ${eps.length ? html`<button class="btn red grow title" data-act="playlast">${icon('play')} Último episodio</button>` : ''}
          ${mine ? html`<button class="btn ghost" data-act="edit">${icon('edit')} Editar</button>` : html`<button class="btn outline" data-act="follow">Avísame</button>`}
        </div>
        <div class="h3">Episodios</div>
        <div class="list">${eps.length ? eps.map((p) => html`
          <a class="item" href="/p/${p.id}">
            <img class="thumb" src="${podcastCover(p)}" alt="" loading="lazy">
            <div class="grow">
              <div class="m yellow-t b">${p.episode ? `Episodio ${p.episode}` : 'Episodio'}${p.part > 1 ? ` · Parte ${p.part}` : ''}</div>
              <div class="t ellip">${p.title}</div>
              <div class="m">${fmtDate(p.created)} · ${fmtDur(p.duration)}</div>
              <div class="prog" data-p="${Math.min(100, (getProgress(p.id) / p.duration) * 100)}"><i></i></div>
            </div>
            <button class="play-dot" data-play="${p.id}" aria-label="Escuchar">${icon('play')}</button>
          </a>`) : html`<div class="empty"><p>Este programa aún no tiene episodios publicados.</p></div>`}</div>
      </div>
    </section>`);
  view.querySelectorAll('.prog').forEach((el) => setPct(el, '--p', Number(el.dataset.p)));
  view.addEventListener('click', async (e) => {
    const pl = e.target.closest('[data-play]');
    if (pl) { e.preventDefault(); const p = eps.find((x) => x.id === pl.dataset.play); player.load(p, true); go(`/p/${p.id}`); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'back') back();
    if (b.dataset.act === 'share') shareUrl(`${location.origin}/programa/${g.id}`, g.name);
    if (b.dataset.act === 'playlast') { const p = eps[0]; player.load(p, true); go(`/p/${p.id}`); }
    if (b.dataset.act === 'edit') { if (await programSheet(g)) go(`/programa/${g.id}`, { replace: true }); }
    if (b.dataset.act === 'follow') {
      if (!(await requireIdentity('Para que te avisemos, entra con tu nombre.'))) return;
      try { await api('/api/follow', { method: 'POST', body: { porchId: g.porchId, on: true } }); toast(`Te avisaremos cuando ${g.porchName} salga al aire`, 'good'); } catch (err) { toast(err.message, 'bad'); }
    }
  });
}
