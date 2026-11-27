// En el aire (inicio): contadores, emisora sintonizada en grande y dial deslizable.
import { api, session } from '../api.js';
import { html, mount, icon, toast, haptic, weekdayGreeting, fmtDateLong } from '../util.js';
import { porchCover, requireIdentity } from '../common.js';

const MIN = 87.5, MAX = 108.5, PX = 44; // píxeles por MHz

export async function render(view, _p, { go }) {
  const lastFreq = Number(localStorage.getItem('rp_freq') || 96.4);
  mount(view, html`
    <section class="screen">
      <div class="top">
        <div><h1 class="h1">En el aire</h1><div class="sub">${weekdayGreeting()}</div></div>
        <a class="icon-btn" href="/archivo?buscar=1" aria-label="Buscar">${icon('search')}</a>
      </div>
      <div class="stats">
        <div class="card stat"><span class="big-num red-t" data-el="nlive">–</span><div class="lbl">porches en directo</div></div>
        <div class="card stat"><span class="big-num" data-el="npod">–</span><div class="lbl">podcasts grabados</div></div>
      </div>
      <article class="station" data-el="station"></article>
      <div class="dial-wrap">
        <div class="dial" data-el="dial" role="slider" aria-label="Dial de radio" aria-valuemin="88" aria-valuemax="108" tabindex="0">
          <div class="track" data-el="track"><div class="ticks"></div></div>
          <div class="fade l"></div><div class="fade r"></div><div class="needle"></div>
        </div>
        <div class="dial-hint"><span aria-hidden="true">⟷</span> Desliza el dial para sintonizar</div>
      </div>
      <div class="card tight next-card" data-el="next" hidden></div>
    </section>`);

  const $el = (n) => view.querySelector(`[data-el=${n}]`);
  let porches = [];
  let stations = [];
  let current = null;

  // --- Dial con inercia y "clic" en cada emisora
  const dial = $el('dial'), track = $el('track');
  const width = (MAX - MIN) * PX;
  track.style.width = width + 'px';
  for (let f = 88; f <= 108; f += 2) {
    const l = document.createElement('span');
    l.className = 'lbl';
    l.textContent = f;
    l.style.left = (f - MIN) * PX + 'px';
    track.appendChild(l);
  }
  let freq = lastFreq, vel = 0, dragging = false, raf = 0, lastX = 0, lastT = 0, lastStation = null;
  const pos = () => { const half = dial.clientWidth / 2; track.style.transform = `translate3d(${half - (freq - MIN) * PX}px,0,0)`; };
  const clamp = (f) => Math.max(88, Math.min(108, f));
  function nearest(f) {
    if (!stations.length) return null;
    return stations.reduce((a, b) => (Math.abs(b.freq - f) < Math.abs(a.freq - f) ? b : a));
  }
  function crossCheck() {
    const n = nearest(freq);
    if (n && Math.abs(n.freq - freq) < 0.12 && n !== lastStation) { lastStation = n; haptic(10); }
  }
  function animate() {
    if (dragging) return;
    if (Math.abs(vel) > 0.002) {
      freq = clamp(freq + vel);
      vel *= 0.93;
      crossCheck();
      pos();
      raf = requestAnimationFrame(animate);
      return;
    }
    // enganchar en la emisora más cercana
    const n = nearest(freq);
    const target = n ? n.freq : Math.round(freq * 10) / 10;
    const d = target - freq;
    if (Math.abs(d) > 0.003) { freq += d * 0.22; pos(); raf = requestAnimationFrame(animate); return; }
    freq = target; pos();
    if (n && n !== current) select(n);
  }
  dial.addEventListener('pointerdown', (e) => {
    dragging = true; vel = 0; cancelAnimationFrame(raf);
    dial.setPointerCapture(e.pointerId); lastX = e.clientX; lastT = performance.now();
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    const df = -(e.clientX - lastX) / PX;
    freq = clamp(freq + df);
    vel = (df / Math.max(8, now - lastT)) * 16;
    lastX = e.clientX; lastT = now;
    crossCheck(); pos();
  });
  const release = () => { if (!dragging) return; dragging = false; raf = requestAnimationFrame(animate); };
  dial.addEventListener('pointerup', release);
  dial.addEventListener('pointercancel', release);
  dial.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = stations.indexOf(current);
    const n = stations[(i + (e.key === 'ArrowRight' ? 1 : -1) + stations.length) % stations.length];
    if (n) { freq = n.freq; pos(); select(n); haptic(10); }
  });
  window.addEventListener('resize', pos);
  pos();

  function paintStations() {
    track.querySelectorAll('.st').forEach((s) => s.remove());
    for (const s of stations) {
      const d = document.createElement('i');
      d.className = 'st' + (s.live ? ' live' : '');
      d.style.left = (s.freq - MIN) * PX + 'px';
      track.appendChild(d);
    }
  }

  function select(p) {
    current = p;
    localStorage.setItem('rp_freq', p.freq);
    dial.setAttribute('aria-valuenow', p.freq);
    dial.setAttribute('aria-valuetext', `${p.freq.toFixed(1)} ${p.name}`);
    const st = $el('station');
    st.classList.toggle('off', !p.live);
    const following = p.following;
    mount(st, html`
      <img src="${porchCover(p)}" alt="">
      <div class="inner">
        <div class="row between">
          ${p.live ? html`<span class="live-chip">En directo</span>` : html`<span class="live-chip off">Apagado</span>`}
          ${p.live && p.mics ? html`<span class="chip dark">${icon('mic')} ${p.mics} micros</span>` : ''}
        </div>
        <div>
          <span class="chip freq">${p.freq.toFixed(1)} · ${p.name.toUpperCase()}</span>
          <div class="ttl">${p.live ? (p.liveTitle || p.name) : p.name}</div>
          <div class="row between gap">
            <div class="meta">${p.live ? `${p.listeners} escuchando · ${p.mics} micros` : p.nextShow ? `Vuelve ${p.nextShow}` : `${p.podcasts} podcasts · ${p.followers} le siguen`}</div>
            ${p.live
              ? html`<button class="btn red title" data-act="listen">${icon('play')} Escuchar</button>`
              : html`<button class="btn outline" data-act="follow">${following ? '✓ Te aviso' : 'Avísame'}</button>`}
          </div>
        </div>
      </div>`);
    paintNext();
  }

  function paintNext() {
    const next = $el('next');
    // otra emisora útil: un porche en directo distinto, o uno apagado con próximo programa
    const other = stations.find((s) => s !== current && s.live) || stations.find((s) => s !== current && !s.live && s.nextShow) || stations.find((s) => s !== current);
    if (!other) {
      next.hidden = false;
      mount(next, html`<img src="/img/scenes/escena-3.webp" alt=""><div class="grow"><div class="b">Abre tu porche</div><div class="muted small">Emite con tus amigos desde el móvil</div></div><a class="btn outline" href="/mi-porche">Empezar</a>`);
      return;
    }
    next.hidden = false;
    mount(next, html`
      <img src="${porchCover(other)}" alt="">
      <div class="grow" data-act="tune" data-f="${other.freq}">
        <div class="b ellip">${other.name} · <span class="mono">${other.freq.toFixed(1)}</span></div>
        <div class="muted small ellip">${other.live ? `En directo · ${other.listeners} escuchando` : other.nextShow ? `Vuelve ${other.nextShow}` : 'Apagado'}</div>
      </div>
      ${other.live ? html`<button class="btn outline" data-act="tune" data-f="${other.freq}">Sintonizar</button>` : html`<button class="btn outline" data-act="follow2" data-id="${other.id}">${other.following ? '✓' : 'Avísame'}</button>`}`);
  }

  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'listen' && current) go(`/porche/${current.slug}`);
    if (b.dataset.act === 'tune') { const s = stations.find((x) => x.freq === Number(b.dataset.f)); if (s) { freq = s.freq; pos(); select(s); haptic(10); } }
    if (b.dataset.act === 'follow' || b.dataset.act === 'follow2') {
      const p = b.dataset.id ? stations.find((s) => s.id === b.dataset.id) : current;
      if (!p) return;
      if (!(await requireIdentity('Para que te avisemos, entra con tu nombre.'))) return;
      try {
        await api('/api/follow', { method: 'POST', body: { porchId: p.id, on: !p.following } });
        p.following = !p.following;
        toast(p.following ? `Te avisaremos cuando ${p.name} salga al aire` : 'Ya no te avisaremos');
        if (p === current) select(p); else paintNext();
      } catch (err) { toast(err.message, 'bad'); }
    }
  });

  async function load() {
    try {
      const [st, pr] = await Promise.all([api('/api/stats'), api('/api/porches')]);
      $el('nlive').textContent = st.live;
      $el('npod').textContent = st.podcasts.toLocaleString('es-ES');
      porches = pr.porches;
      // Con poca gente en directo también se ven los apagados (nunca vacío)
      stations = porches.filter((p) => p.live || p.nextShow || p.podcasts > 0 || p.owner === session.deviceId);
      if (stations.length < 4) stations = porches.slice();
      stations.sort((a, b) => a.freq - b.freq);
      paintStations();
      if (!stations.length) {
        mount($el('station'), html`<img src="/img/scenes/escena-1.webp" alt=""><div class="inner"><span class="live-chip off">Silencio en el barrio</span><div><div class="ttl">Abre el primer porche</div><div class="row between gap"><div class="meta">Emite con tus amigos desde el móvil.</div><a class="btn red title" href="/mi-porche">Empezar</a></div></div></div>`);
        paintNext();
        return;
      }
      const keep = current && stations.find((s) => s.id === current.id);
      const live = stations.filter((s) => s.live).sort((a, b) => b.listeners - a.listeners)[0];
      const pick = keep || (live && !localStorage.getItem('rp_freq') ? live : nearest(freq)) || stations[0];
      freq = pick.freq; pos(); select(pick);
    } catch (e) { toast(e.message, 'bad'); }
  }
  load();
  const iv = setInterval(load, 30000);
  return () => { clearInterval(iv); window.removeEventListener('resize', pos); cancelAnimationFrame(raf); };
}
