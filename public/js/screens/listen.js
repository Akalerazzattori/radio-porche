// Escuchar una grabación que alguien te ha compartido en privado (no está publicada).
import { html, mount, icon, fmtTime, fmtDate } from '../util.js';
import { SCENES } from '../cover.js';

export async function render(view, [dev, key], { go }) {
  const base = `/api/share/${dev}/${key}`;
  let meta;
  try {
    const r = await fetch(base);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Este enlace ya no está disponible');
    meta = await r.json();
  } catch (e) {
    mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Grabación privada</h1></div>
      <div class="empty"><img src="/img/scenes/escena-2.webp" alt=""><p>${e.message}</p><p class="muted small">Los enlaces privados duran 30 días o hasta que quien la compartió deja de compartirla.</p><button class="btn yellow" data-x>Ir a Radio Porche</button></div></section>`);
    view.querySelector('[data-x]').onclick = () => go('/');
    return;
  }
  document.title = `${meta.title} · Radio Porche`;
  const cover = meta.hasCover ? `${base}/cover` : SCENES[((meta.scene || 1) - 1) % SCENES.length];
  mount(view, html`
    <section class="screen">
      <div class="top"><div class="h3 center grow">Grabación privada</div></div>
      <div class="cover-big"><img src="${cover}" alt=""></div>
      <div>
        <div class="b">${meta.title}</div>
        <div class="muted small">${meta.porchName ? `${meta.porchName} · ` : ''}Te la han compartido a ti · no está publicada</div>
      </div>
      <div>
        <div class="timeline" data-el="tl"><div class="rail"></div><div class="done"></div><div class="knob"></div></div>
        <div class="row between mono small muted"><span data-el="cur">0:00</span><span data-el="dur">${fmtTime(meta.duration || 0)}</span></div>
      </div>
      <div class="ctrl"><button class="main" data-act="play" aria-label="Reproducir">${icon('play')}</button></div>
      <p class="muted tiny center">${meta.exp ? `El enlace funciona hasta el ${fmtDate(meta.exp)}. ` : ''}¿Te animas a emitir tú? Abre tu porche en Radio Porche.</p>
    </section>`);
  const audio = new Audio(`${base}/audio`);
  audio.preload = 'metadata';
  const tl = view.querySelector('[data-el=tl]');
  const playBtn = view.querySelector('[data-act=play]');
  const dur = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : meta.duration || 0);
  const paint = () => {
    const d = dur();
    tl.style.setProperty('--p', d ? `${(audio.currentTime / d) * 100}%` : '0%');
    view.querySelector('[data-el=cur]').textContent = fmtTime(audio.currentTime);
    view.querySelector('[data-el=dur]').textContent = fmtTime(d);
    mount(playBtn, icon(audio.paused ? 'play' : 'pause'));
  };
  ['timeupdate', 'play', 'pause', 'loadedmetadata', 'ended'].forEach((ev) => audio.addEventListener(ev, paint));
  playBtn.onclick = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());
  const seekAt = (e) => { const r = tl.getBoundingClientRect(); const k = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); audio.currentTime = k * dur(); paint(); };
  tl.addEventListener('pointerdown', (e) => { tl.setPointerCapture(e.pointerId); seekAt(e); tl.onpointermove = seekAt; });
  tl.addEventListener('pointerup', () => { tl.onpointermove = null; });
  return () => { audio.pause(); audio.src = ''; };
}
