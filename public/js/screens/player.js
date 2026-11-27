// Reproductor de podcasts: capítulos, comentarios clavados en el minuto, velocidades,
// temporizador para dormir, retomar donde se dejó y controles en la pantalla bloqueada.
import { api, session } from '../api.js';
import { LIMITS } from '../config.js';
import { html, mount, icon, fmtTime, fmtDur, fmtDate, toast, sheet, setPct, $, esc } from '../util.js';
import { podcastCover, requireIdentity, reportSheet, shareUrl, nameColor, isBlocked } from '../common.js';

const RATES = [1, 1.2, 1.5, 2];
const PIN_COLORS = ['#f47a1f', '#1fb5a8', '#c7b2ff', '#ffc72c', '#ff8a7a'];

export const player = {
  audio: null, p: null, comments: [], played: 0, lastT: 0, listenSent: false, sleepAt: 0, sleepTimer: null, subs: new Set(),
  ensure() {
    if (this.audio) return this.audio;
    const a = (this.audio = new Audio());
    a.preload = 'metadata';
    a.addEventListener('timeupdate', () => this.onTime());
    a.addEventListener('play', () => this.emit());
    a.addEventListener('pause', () => { this.save(); this.emit(); });
    a.addEventListener('ended', () => { this.save(true); this.emit(); if (this.p?.nextId) toast('Sigue en la siguiente parte'); });
    a.addEventListener('loadedmetadata', () => this.emit());
    return a;
  },
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); },
  emit() { for (const f of this.subs) f(); },
  get playing() { return this.audio && !this.audio.paused; },
  async load(p, autoplay = true) {
    const a = this.ensure();
    if (this.p?.id !== p.id) {
      this.p = p; this.played = 0; this.listenSent = false; this.comments = [];
      a.src = `/api/podcasts/${p.id}/audio`;
      a.playbackRate = Number(localStorage.getItem('rp_rate') || 1);
      const pos = getProgress(p.id);
      if (pos > 5 && pos < p.duration - 10) a.currentTime = pos;
      this.loadComments();
      this.media();
    }
    if (autoplay) { try { await a.play(); } catch { toast('Toca play para escuchar'); } }
    this.emit();
  },
  async loadComments() {
    if (!this.p) return;
    try { const r = await api(`/api/podcasts/${this.p.id}/comments`); this.comments = r.comments.filter((c) => !isBlocked(c.device)); this.emit(); } catch {}
  },
  toggle() { const a = this.ensure(); a.paused ? a.play().catch(() => {}) : a.pause(); },
  seek(t) { const a = this.ensure(); a.currentTime = Math.max(0, Math.min(t, (a.duration || this.p?.duration || 0) - 0.5)); this.emit(); },
  skip(d) { this.seek((this.audio?.currentTime || 0) + d); },
  setRate(r) { this.ensure().playbackRate = r; localStorage.setItem('rp_rate', r); this.emit(); },
  setSleep(min) {
    clearTimeout(this.sleepTimer);
    this.sleepAt = min ? Date.now() + min * 60000 : 0;
    if (min) this.sleepTimer = setTimeout(() => { this.audio?.pause(); this.sleepAt = 0; toast('Buenas noches 🌙'); this.emit(); }, min * 60000);
    this.emit();
  },
  onTime() {
    const a = this.audio;
    const t = a.currentTime;
    const dt = t - this.lastT;
    if (dt > 0 && dt < 2 && !a.paused) this.played += dt / (a.playbackRate || 1);
    this.lastT = t;
    if (!this.listenSent && this.played >= LIMITS.LISTEN_COUNT_SEC && session.token) {
      this.listenSent = true;
      api(`/api/podcasts/${this.p.id}/listen`, { method: 'POST', body: {} }).catch(() => {});
    }
    if (Math.floor(t) % 5 === 0) this.save();
    if ('mediaSession' in navigator && a.duration) {
      try { navigator.mediaSession.setPositionState({ duration: a.duration, position: Math.min(t, a.duration), playbackRate: a.playbackRate }); } catch {}
    }
    this.emit();
  },
  save(ended = false) {
    if (!this.p || !this.audio) return;
    try { localStorage.setItem('rp_prog_' + this.p.id, ended ? String(this.p.duration) : String(Math.floor(this.audio.currentTime))); } catch {}
  },
  media() {
    if (!('mediaSession' in navigator) || !this.p) return;
    const p = this.p;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: p.title, artist: p.porchName, album: 'Radio Porche',
      artwork: [{ src: podcastCover(p), sizes: '512x512', type: 'image/jpeg' }],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.audio.play());
    ms.setActionHandler('pause', () => this.audio.pause());
    ms.setActionHandler('seekbackward', () => this.skip(-15));
    ms.setActionHandler('seekforward', () => this.skip(30));
    try { ms.setActionHandler('seekto', (d) => this.seek(d.seekTime)); } catch {}
  },
  stop() { this.audio?.pause(); this.p = null; this.emit(); },
};

export function getProgress(id) { return Number(localStorage.getItem('rp_prog_' + id) || 0); }

export async function render(view, [id], { back, go }) {
  let p = player.p?.id === id ? player.p : null;
  if (!p) {
    try { p = (await api(`/api/podcasts/${id}`)).podcast; } catch (e) {
      mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Podcasts</h1><button class="icon-btn" data-act="back">${icon('close')}</button></div><div class="empty"><img src="/img/scenes/escena-2.webp" alt=""><p>${e.message}</p></div></section>`);
      view.querySelector('[data-act=back]').onclick = back;
      return;
    }
  }
  if (player.p?.id !== p.id) player.load(p, false);
  document.title = `${p.title} · Radio Porche`;

  mount(view, html`
    <section class="screen">
      <div class="top">
        <button class="icon-btn" data-act="back" aria-label="Cerrar">${icon('down')}</button>
        <div class="h3 center grow">${p.part > 1 ? `Parte ${p.part} · ` : ''}Podcast</div>
        <button class="icon-btn" data-act="more" aria-label="Más">${icon('more')}</button>
      </div>
      ${p.hidden ? html`<div class="banner red">Este podcast está oculto por reportes y solo lo ves tú.</div>` : ''}
      <div class="cover-big"><img src="${podcastCover(p)}" alt="Portada de ${p.title}"></div>
      <div class="row between gap">
        <div class="grow">
          <div class="b ellip" data-el="title">${p.title}</div>
          <a class="muted small" href="/porche/${p.porchSlug}">${p.porchName}</a><span class="muted small"> · ${fmtDur(p.duration)} · ${fmtDate(p.created)}</span>
        </div>
        <button class="col center" data-act="like" aria-label="Me gusta">
          <span class="red-t" data-el="heart">${icon(p.liked ? 'heartf' : 'heart')}</span>
          <span class="tiny red-t b" data-el="likes">${p.likes}</span>
        </button>
      </div>
      <div>
        <div class="small b yellow-t ellip" data-el="chap">&nbsp;</div>
        <div class="timeline" data-el="tl">
          <div class="rail"></div><div class="done"></div><div class="knob"></div>
          <div data-el="marks"></div>
        </div>
        <div class="row between mono small muted"><span data-el="cur">0:00</span><span data-el="rem">-0:00</span></div>
      </div>
      <div class="ctrl">
        <button class="pill" data-act="rate" aria-label="Velocidad">1×</button>
        <button class="sec" data-act="b15" aria-label="Atrás 15 segundos">${icon('back15')}</button>
        <button class="main" data-act="play" aria-label="Reproducir">${icon('play')}</button>
        <button class="sec" data-act="f30" aria-label="Adelante 30 segundos">${icon('fwd30')}</button>
        <button class="pill" data-act="sleep" aria-label="Temporizador para dormir">${icon('moon')}</button>
      </div>
      <div class="actions">
        <button class="y" data-act="clip" title="Muy pronto">${icon('clip')}Clip</button>
        <button data-act="comments">${icon('chat')}<span data-el="ncom">${p.comments}</span></button>
        <button data-act="dl">${icon('dl')}Bajar</button>
        <button data-act="share">${icon('share')}Enviar</button>
      </div>
      <div class="ticker" data-el="ticker"><span class="muted">Los comentarios aparecen en su minuto exacto. Toca 💬 para dejar el tuyo.</span></div>
    </section>`);

  const $el = (n) => view.querySelector(`[data-el=${n}]`);
  const playBtn = view.querySelector('[data-act=play]');
  const rateBtn = view.querySelector('[data-act=rate]');
  const tl = $el('tl');

  function drawMarks() {
    const d = p.duration || 1;
    const parts = [];
    for (const c of p.chapters || []) parts.push(`<i class="chap" data-x="${(c.t / d) * 100}"></i>`);
    player.comments.slice(0, 80).forEach((c, i) => parts.push(`<i class="pin" data-x="${(c.t / d) * 100}" data-c="${PIN_COLORS[i % PIN_COLORS.length]}"></i>`));
    $el('marks').innerHTML = parts.join('');
    for (const m of $el('marks').children) { m.style.setProperty('--x', m.dataset.x + '%'); if (m.dataset.c) m.style.setProperty('--c', m.dataset.c); }
  }
  let lastTicker = -1;
  function update() {
    const a = player.audio;
    if (!a || player.p?.id !== p.id) return;
    const t = a.currentTime || 0, d = a.duration && isFinite(a.duration) ? a.duration : p.duration;
    setPct(tl, '--p', (t / d) * 100);
    $el('cur').textContent = fmtTime(t);
    $el('rem').textContent = '-' + fmtTime(d - t);
    mount(playBtn, a.paused ? icon('play') : icon('pause'));
    rateBtn.textContent = `${String(a.playbackRate).replace('.', ',')}×`;
    const ch = [...(p.chapters || [])].reverse().find((c) => c.t <= t);
    const idx = (p.chapters || []).indexOf(ch);
    $el('chap').textContent = ch ? `Capítulo ${idx + 1} · ${ch.title}` : ' ';
    const near = player.comments.filter((c) => c.t <= t && t - c.t < 12).pop();
    if (near && near.id !== lastTicker) {
      lastTicker = near.id;
      $el('ticker').innerHTML = `<span class="mono teal-t">${fmtTime(near.t)}</span> <b class="${nameColor(near.device)}">${esc(near.name)}</b> ${esc(near.text)}`;
    }
    view.querySelector('[data-act=sleep]').classList.toggle('yellow-t', !!player.sleepAt);
  }
  const off = player.on(() => { update(); if (player.comments.length !== drawMarks.n) { drawMarks.n = player.comments.length; drawMarks(); } });
  drawMarks(); update();

  // arrastrar en la línea de tiempo
  const seekAt = (e) => {
    const r = tl.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    player.seek(k * (player.audio.duration || p.duration));
  };
  tl.addEventListener('pointerdown', (e) => { tl.setPointerCapture(e.pointerId); seekAt(e); tl.onpointermove = seekAt; });
  tl.addEventListener('pointerup', () => { tl.onpointermove = null; });

  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'back': back(); break;
      case 'play': player.toggle(); break;
      case 'b15': player.skip(-15); break;
      case 'f30': player.skip(30); break;
      case 'rate': { const r = player.audio.playbackRate; player.setRate(RATES[(RATES.indexOf(r) + 1) % RATES.length]); break; }
      case 'sleep': sleepSheet(); break;
      case 'clip': toast('Los clips llegarán pronto ✂️'); break;
      case 'comments': commentsSheet(p); break;
      case 'dl': { const a = document.createElement('a'); a.href = `/api/podcasts/${p.id}/audio?dl=1`; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); break; }
      case 'share': shareUrl(`${location.origin}/p/${p.id}`, p.title); break;
      case 'like': {
        if (!(await requireIdentity('Para dar me gusta, entra con tu nombre.'))) return;
        try {
          const r = await api(`/api/podcasts/${p.id}/like`, { method: 'POST', body: { on: !p.liked } });
          p.liked = r.liked; p.likes = r.likes;
          mount($el('heart'), icon(p.liked ? 'heartf' : 'heart'));
          $el('likes').textContent = p.likes;
        } catch (err) { toast(err.message, 'bad'); }
        break;
      }
      case 'more': moreSheet(p, go); break;
    }
  });
  return () => off();
}

function sleepSheet() {
  const s = sheet(html`
    <h2 class="h2">Temporizador para dormir</h2>
    ${[10, 20, 30, 45, 60].map((m) => html`<button class="opt" data-m="${m}">${icon('moon')} ${m} minutos</button>`)}
    ${player.sleepAt ? html`<button class="opt danger" data-m="0">Quitar temporizador</button>` : ''}`, {
    onMount(a) { a.el.addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) { player.setSleep(Number(b.dataset.m)); a.close(); if (+b.dataset.m) toast(`Se parará en ${b.dataset.m} min`); } }); },
  });
  return s.done;
}

function moreSheet(p, go) {
  sheet(html`
    <h2 class="h2">${p.title}</h2>
    ${p.description ? html`<p class="muted small">${p.description}</p>` : ''}
    ${p.prevId ? html`<button class="opt" data-a="prev">${icon('back')} Ir a la parte anterior</button>` : ''}
    ${p.nextId ? html`<button class="opt" data-a="next">${icon('play')} Ir a la siguiente parte</button>` : ''}
    ${(p.chapters || []).map((c, i) => html`<button class="opt" data-t="${c.t}"><span class="mono small yellow-t">${fmtTime(c.t)}</span> ${i + 1}. ${c.title}</button>`)}
    <button class="opt" data-a="porch">${icon('radio')} Ver ${p.porchName}</button>
    ${p.owner !== session.deviceId ? html`<button class="opt danger" data-a="report">${icon('flag')} Reportar este podcast</button>` : ''}`, {
    onMount(a) {
      a.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a],[data-t]');
        if (!b) return;
        a.close();
        if (b.dataset.t) return player.seek(Number(b.dataset.t));
        if (b.dataset.a === 'prev') go(`/p/${p.prevId}`);
        if (b.dataset.a === 'next') go(`/p/${p.nextId}`);
        if (b.dataset.a === 'porch') go(`/porche/${p.porchSlug}`);
        if (b.dataset.a === 'report') reportSheet({ kind: 'podcast', obj: p.id, snapshot: p.title, what: 'este podcast' });
      });
    },
  });
}

function commentsSheet(p) {
  const t0 = player.audio?.currentTime || 0;
  const s = sheet(html`
    <h2 class="h2">Comentarios</h2>
    <div class="list" data-el="list"></div>
    <div class="composer">
      <input class="input" maxlength="${LIMITS.COMMENT_MAX}" placeholder="Comentar en el ${fmtTime(t0)}…">
      <button class="btn yellow" data-a="send">Enviar</button>
    </div>`, {
    onMount(a) {
      const list = a.el.querySelector('[data-el=list]');
      const paint = () => {
        if (!player.comments.length) { list.innerHTML = '<p class="muted small">Aún no hay comentarios. ¡Estrena tú!</p>'; return; }
        list.innerHTML = player.comments.map((c) => `
          <div class="row gap-s">
            <button class="mono small teal-t" data-t="${c.t}">${fmtTime(c.t)}</button>
            <div class="grow small"><b class="${nameColor(c.device)}">${esc(c.name)}</b> ${esc(c.text)}${c.hidden ? ' <span class="muted tiny">(oculto por reportes)</span>' : ''}</div>
            ${c.device !== session.deviceId ? `<button class="muted" data-rep="${c.id}" aria-label="Reportar">⋯</button>` : ''}
          </div>`).join('');
      };
      paint();
      a.el.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-t]');
        if (t) { player.seek(Number(t.dataset.t)); return; }
        const r = e.target.closest('[data-rep]');
        if (r) {
          const c = player.comments.find((x) => String(x.id) === r.dataset.rep);
          const choice = await sheet(html`<h2 class="h2">${c.name}</h2><button class="opt" data-close="block">${icon('block')} Bloquear</button><button class="opt danger" data-close="report">${icon('flag')} Reportar comentario</button>`).done;
          if (choice === 'report') reportSheet({ kind: 'comment', obj: c.id, snapshot: c.text, what: 'este comentario' });
          if (choice === 'block') { (await import('../common.js')).blockPerson(c.device); player.comments = player.comments.filter((x) => x.device !== c.device); paint(); }
          return;
        }
        if (e.target.closest('[data-a=send]')) {
          if (!(await requireIdentity('Para comentar, entra con tu nombre.'))) return;
          const inp = a.el.querySelector('input');
          const text = inp.value.trim();
          if (!text) return;
          try {
            await api(`/api/podcasts/${p.id}/comments`, { method: 'POST', body: { t: t0, text } });
            inp.value = '';
            await player.loadComments();
            paint();
            toast('Comentario clavado en el ' + fmtTime(t0), 'good');
          } catch (err) { toast(err.message, 'bad'); }
        }
      });
    },
  });
  return s.done;
}
