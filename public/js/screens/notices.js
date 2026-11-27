// Avisos: porches que sigues en directo, programas anunciados y podcasts nuevos.
import { api, session } from '../api.js';
import { html, mount, icon, toast, fmtDate, fmtDateLong, fmtDur } from '../util.js';
import { porchCover, podcastCover, requireIdentity } from '../common.js';

export async function render(view, _p, { go }) {
  mount(view, html`
    <section class="screen">
      <div class="top"><div><h1 class="h1">Avisos</h1><div class="sub">De los porches que sigues</div></div></div>
      <div data-el="perm"></div>
      <div class="fill scroll"><div class="list" data-el="list"></div></div>
    </section>`);
  const list = view.querySelector('[data-el=list]');
  if (!session.token) {
    mount(list, html`<div class="empty"><img src="/img/scenes/escena-1.webp" alt=""><p>Sigue porches para que te avisemos cuando salgan al aire.</p><button class="btn yellow" data-act="login">Entrar con mi nombre</button></div>`);
    list.querySelector('[data-act=login]').onclick = async () => { if (await requireIdentity()) go('/avisos', { replace: true }); };
    return;
  }
  const perm = view.querySelector('[data-el=perm]');
  if ('Notification' in window && Notification.permission === 'default') {
    mount(perm, html`<div class="banner yellow"><span class="grow small">Activa los avisos del navegador para enterarte mientras tienes la app abierta.</span><button class="btn sm yellow" data-act="perm">Activar</button></div>`);
    perm.querySelector('[data-act=perm]').onclick = async () => { await Notification.requestPermission(); perm.innerHTML = ''; };
  }
  try {
    const r = await api('/api/notices');
    localStorage.setItem('rp_notices_seen', String(Date.now()));
    window.dispatchEvent(new CustomEvent('rp:noticesSeen'));
    if (!r.items.length) {
      mount(list, html`<div class="empty"><img src="/img/scenes/escena-3.webp" alt=""><p>Aún no hay avisos. En <b>En el aire</b>, pulsa <b>Avísame</b> en los porches que te gusten.</p><a class="btn yellow" href="/">Ir al dial</a></div>`);
      return;
    }
    mount(list, html`${r.items.map((it) => {
      if (it.type === 'live') return html`<a class="item" href="/porche/${it.porch.slug}"><img class="thumb" src="${porchCover(it.porch)}" alt=""><div class="grow"><span class="live-chip">En directo</span><div class="t ellip mt-s">${it.porch.name} está en directo</div><div class="m ellip">${it.porch.liveTitle || ''} · ${it.porch.listeners} escuchando</div></div><span class="play-dot">${icon('play')}</span></a>`;
      if (it.type === 'scheduled') return html`<a class="item" href="/porche/${it.porch.slug}"><img class="thumb" src="${porchCover(it.porch)}" alt=""><div class="grow"><div class="t ellip">${it.porch.name}</div><div class="m">Programa anunciado: ${it.porch.nextShow || (it.ts ? fmtDateLong(it.ts) : '')}</div></div></a>`;
      if (it.type === 'podcast') return html`<a class="item" href="/p/${it.podcast.id}"><img class="thumb" src="${podcastCover(it.podcast)}" alt=""><div class="grow"><div class="t ellip">Nuevo: ${it.podcast.title}</div><div class="m">${it.podcast.porchName} · ${fmtDate(it.podcast.created)} · ${fmtDur(it.podcast.duration)}</div></div></a>`;
      if (it.type === 'hidden') return html`<div class="item"><div class="grow"><div class="t red-t">Tu podcast «${it.podcast.title}» está oculto</div><div class="m">Ha recibido varios reportes y queda oculto hasta que se revise. Si crees que es un error, escríbenos (ver Aviso legal).</div></div></div>`;
      return '';
    })}`);
  } catch (e) { toast(e.message, 'bad'); }
}
