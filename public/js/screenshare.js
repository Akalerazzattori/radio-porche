// Compartir pantalla o pestaña (Chrome de ordenador) para comentar un vídeo, una foto o un audio.
// Primero está PREPARADO: lo ves y lo oyes solo tú. Cuando pulsas «Sacar al aire», su sonido entra en la emisión:
// - desde el aparato que emite: por la tira «Pestaña» de la mesa;
// - desde un invitado u otro aparato tuyo: mezclado en lo que manda su micro (con el micro silenciado si no lo usabas).
// Los oyentes solo oyen el sonido; la imagen la veis vosotros (por ejemplo, en la tele).
import { live } from './live.js';
import { audioCtx } from './audio/voice.js';
import { html, mount, icon, toast, canShareTab } from './util.js';

const st = { stream: null, audio: null, src: null, gain: null, target: null, onAir: false, level: 0.8, subs: new Set(), usedMic: false };
const emit = () => st.subs.forEach((f) => f());
export const onShare = (fn) => { st.subs.add(fn); return () => st.subs.delete(fn); };
export const sharing = () => !!st.stream;

export async function startShare() {
  const ds = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include', surfaceSwitching: 'include',
  });
  stopShare(true);
  st.stream = ds;
  st.audio = ds.getAudioTracks()[0] || null;
  const c = audioCtx();
  st.gain = c.createGain(); st.gain.gain.value = st.level;
  if (st.audio) { st.src = c.createMediaStreamSource(new MediaStream([st.audio])); st.src.connect(st.gain); }
  const v = ds.getVideoTracks()[0];
  if (v) v.onended = () => stopShare();
  if (st.audio) st.audio.onended = () => { if (!ds.getVideoTracks().some((t) => t.readyState === 'live')) stopShare(); };
  emit();
}

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); }
  return null;
}

/** Dónde tiene que entrar el sonido para que salga en la emisión. */
async function resolveTarget() {
  if (live.role === 'host' && live.mixer) return live.mixer.tabBus;
  if (live.role === 'guest' && live.guestVoice?.dest) return live.guestVoice.dest;
  if (live.isOwner && live.role !== 'host') {
    // Otro aparato tuyo sin micro: usa su conexión de micro con el micro silenciado
    await live.setMicHere(true);
    const v = await waitFor(() => live.guestVoice?.dest && live.guestVoice);
    if (!v) throw new Error('No se ha podido conectar con el estudio');
    v.setMuted(true); st.usedMic = true;
    return v.dest;
  }
  throw new Error('Para sacarlo al aire tienes que tener micro en esta emisión');
}

export async function setShareOnAir(on) {
  if (!st.stream) return;
  if (!st.audio) { toast('Esto no tiene sonido: lo veis vosotros y lo comentáis.'); return; }
  try { st.gain.disconnect(); } catch {}
  st.onAir = false; st.target = null;
  if (live.mixer && live.mixer.tabSrc === st.src) { live.mixer.tabSrc = null; }
  if (on) {
    try {
      st.target = await resolveTarget();
      st.gain.connect(st.target);
      st.onAir = true;
      if (live.role === 'host' && live.mixer) { live.mixer.tabSrc = st.src; live.mixer.tabTrack = st.audio; }
    } catch (e) { toast(e.message, 'bad'); }
  }
  emit();
}

export function setShareLevel(v) {
  st.level = v;
  if (st.gain) st.gain.gain.setTargetAtTime(v, audioCtx().currentTime, 0.03);
}

export function stopShare(silent = false) {
  if (!st.stream) return;
  try { st.gain?.disconnect(); st.src?.disconnect(); } catch {}
  st.stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
  if (live.mixer && live.mixer.tabSrc === st.src) { live.mixer.tabSrc = null; live.mixer.tabTrack = null; }
  if (st.usedMic) { live.guestVoice?.setMuted(false); live.setMicHere(false); st.usedMic = false; }
  Object.assign(st, { stream: null, audio: null, src: null, gain: null, target: null, onAir: false });
  if (!silent) emit();
}

/** Tarjeta para compartir: botón, vista previa, PREPARADO / AL AIRE, volumen y parar. */
export function mountShareCard(el) {
  const paint = () => {
    if (!canShareTab()) {
      mount(el, html`<div class="card col gap-s"><b>${icon('tab')} Compartir pantalla</b><div class="muted tiny">Se hace desde <b>Chrome en un ordenador</b> (en el móvil el navegador no lo permite). Abre el Estudio allí: lo que pongas en una pestaña (un vídeo, una foto, un audio) lo veis en la tele y su sonido entra en la emisión.</div></div>`);
      return;
    }
    if (!st.stream) {
      mount(el, html`<div class="card col gap-s">
        <b>${icon('tab')} Compartir pantalla o pestaña</b>
        <div class="muted tiny">Para comentar un vídeo, una foto o un audio: lo veis en la pantalla (o en la tele) y su sonido entra en la emisión. Al elegir la pestaña, marca <b>«Compartir también el audio»</b>. Primero lo verás solo tú; no sale al aire hasta que pulses «Sacar al aire». Solo fragmentos breves para comentar.</div>
        <button class="btn yellow" data-sh="start">${icon('tab')} Elegir pestaña o pantalla</button>
      </div>`);
      return;
    }
    mount(el, html`<div class="card col gap-s share-card ${st.onAir ? 'air' : 'prep'}">
      <div class="share-state">${st.onAir ? html`<span class="dot"></span><b>AL AIRE</b> · los oyentes lo están oyendo` : html`${icon('hp')}<b>PREPARADO</b> · lo ves y lo oyes solo tú; aún no sale al aire`}</div>
      <video class="share-prev" autoplay muted playsinline></video>
      ${st.audio ? html`<label class="row gap small"><span class="muted">Volumen</span><input type="range" min="0" max="1.2" step="0.05" value="${st.level}" data-sh="level" class="grow"></label>` : html`<div class="muted tiny">Sin sonido (una foto, o no marcaste «Compartir también el audio»): lo veis vosotros y lo comentáis.</div>`}
      <div class="row gap">
        ${st.audio ? (st.onAir ? html`<button class="btn ghost grow" data-sh="off">Quitar del aire</button>` : html`<button class="btn red grow" data-sh="on">Sacar al aire</button>`) : ''}
        <button class="btn ghost" data-sh="stop">Dejar de compartir</button>
      </div>
    </div>`);
    const v = el.querySelector('.share-prev');
    if (v) v.srcObject = new MediaStream(st.stream.getVideoTracks());
  };
  const onClick = async (e) => {
    const b = e.target.closest('[data-sh]');
    if (!b || b.tagName === 'INPUT') return;
    const a = b.dataset.sh;
    try {
      if (a === 'start') await startShare();
      if (a === 'on') await setShareOnAir(true);
      if (a === 'off') await setShareOnAir(false);
      if (a === 'stop') stopShare();
    } catch (err) { if (err?.name !== 'NotAllowedError') toast(err.message || 'No se ha podido compartir', 'bad'); }
  };
  const onInput = (e) => { if (e.target.matches('[data-sh=level]')) setShareLevel(Number(e.target.value)); };
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  const off = onShare(paint);
  paint();
  return () => { off(); el.removeEventListener('click', onClick); el.removeEventListener('input', onInput); };
}
