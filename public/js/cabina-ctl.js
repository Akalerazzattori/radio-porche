// Controlador de la cabina: la misma interfaz sirve en el estudio (actúa en local)
// y en otro aparato del anfitrión (mando a distancia: manda órdenes al estudio).
import { live } from './live.js';
import { decode } from './audio/sounds.js';
import { audioCtx } from './audio/voice.js';
import { toast } from './util.js';

const keyOf = (i) => i.origin + ':' + i.id;

// Pre-escucha: un solo sonido a la vez, solo en este aparato. Tocar el mismo = parar.
const pv = { src: null, key: null, subs: new Set() };
const pvEmit = () => pv.subs.forEach((f) => f(pv.key));
export function onPreview(fn) { pv.subs.add(fn); return () => pv.subs.delete(fn); }
export function stopPreview() {
  if (pv.src) { try { pv.src.onended = null; pv.src.stop(); } catch {} }
  pv.src = null; pv.key = null; pvEmit();
}
export const previewKey = () => pv.key;

export function makeCtl() {
  const R = () => live.role !== 'host';
  const S = () => live.remoteState || {};
  return {
    get remote() { return R(); },
    get ready() { return R() ? !!live.remoteState : !!live.mixer; },
    async sounds() {
      if (R()) return live.remoteSounds;
      return (await live.loadItems()).map((i) => ({ key: keyOf(i), name: i.name, zone: i.zone, origin: i.origin, duration: i.duration, section: i.section || '', src: i.src || '' }));
    },
    fire(key, { loop } = {}) { R() ? live.ctl('fire', { key, loop }) : live.fireSound(key, { loop }); },
    /** Escuchar un sonido solo tú. Devuelve true si empieza a sonar, false si se para. */
    async cue(item) {
      if (pv.key === item.key) { stopPreview(); return false; }
      stopPreview();
      let src;
      if (!R()) { if (!live.items.length) await live.loadItems(); src = live.findItem(item.key); }
      else if (item.origin === 'serie' && item.src) src = { origin: 'serie', id: item.key.split(':')[1], src: item.src };
      if (!src) { toast('Este sonido está solo en el estudio: no se puede escuchar aquí.'); return false; }
      try {
        const c = audioCtx();
        const buf = await decode(src);
        const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination);
        s.onended = () => { if (pv.src === s) { pv.src = null; pv.key = null; pvEmit(); } };
        s.start();
        pv.src = s; pv.key = item.key; pvEmit();
        return true;
      } catch { return false; }
    },
    stopMusic() { R() ? live.ctl('stopMusic') : live.mixer?.stopMusic(); },
    music() {
      if (R()) return S().music || null;
      const m = live.mixer?.music;
      return m ? { key: m.id, name: m.name, pos: live.mixer.musicPosition(), dur: m.duration, loop: m.loop } : null;
    },
    fxProgress(key) {
      if (R()) return S().fx?.[key];
      const h = live.fxPlaying.get(key);
      return h ? h.progress() : undefined;
    },
    fxKeys() { return R() ? Object.keys(S().fx || {}) : [...live.fxPlaying.keys()]; },
    faders() {
      if (R()) {
        const s = S();
        return { music: s.musicLevel ?? 0.28, fx: s.fxLevel ?? 0.9, tab: s.tab ?? null, voices: Object.keys(s.gains || {}).map((id) => ({ id, name: s.names?.[id] || '', gain: s.gains[id] })) };
      }
      const m = live.mixer;
      if (!m) return { music: 0.28, fx: 0.9, tab: null, voices: [] };
      return { music: m.musicLevel ?? 0.28, fx: m.fxBus.gain.value, tab: m.tabSrc ? m.tabBus.gain.value : null, voices: [...m.voices.values()].map((v) => ({ id: v.id, name: v.name, gain: v.gain.gain.value })) };
    },
    setFader(id, v) {
      if (R()) return live.ctl('fader', { id, v });
      const m = live.mixer;
      if (!m) return;
      if (id === 'music') m.setMusicLevel(v, true);
      else if (id === 'fx') m.setFxLevel(v);
      else if (id === 'tab') m.setTabLevel(v);
      else if (id.startsWith('v:')) m.setVoiceGain(id.slice(2), v);
    },
    ducking() { return R() ? !!S().ducking : !!live.mixer?.ducking; },
    setDucking(on) { R() ? live.ctl('ducking', { on }) : live.mixer && (live.mixer.ducking = on); },
    solo() { return R() ? !!S().solo : !!live.mixer?.soloMusic; },
    setSolo(on) { R() ? live.ctl('solo', { on }) : live.mixer?.setSoloMusic(on); },
    up() { R() ? live.ctl('up') : live.mixer?.musicUp(); },
    down() { R() ? live.ctl('down') : live.mixer?.musicDown(); },
    hasVoice() { return R() ? !!S().hasVoice : !!live.voice; },
    selfMuted() { return R() ? !!S().selfMuted : !!live.voice?.muted; },
    setSelfMute(on) { R() ? live.ctl('selfmute', { on }) : live.voice?.setMuted(on); },
    voiceLevel(cid) { return R() ? S().levels?.[cid] || 0 : cid === 'me' ? live.voice?.level() || 0 : live.mixer?.voiceLevel(cid) || 0; },
    muteVoice(cid, on) {
      if (cid === 'me') return this.setSelfMute(on);
      if (R()) return live.ctl('mutevoice', { cid, on });
      live.send({ t: 'mute', cid, on }); live.mixer?.muteVoice(cid, on);
    },
    pause(on) { R() ? live.ctl('pause', { on }) : live.pause(on); },
    nextPart() { R() ? live.ctl('nextpart') : live.continueNextPart(); },
    golive(mode, title, intro = '', programId = '') {
      if (R()) return live.ctl('golive', { mode, title, intro, programId });
      live.goLive(mode, title, programId);
      if (intro) live.introJingle(intro);
    },
    rec() {
      if (R()) return S().rec || null;
      return live.rec ? { part: live.rec.part, elapsed: live.partElapsed() } : null;
    },
    partClosed() { return R() ? !!S().partClosed : live.partClosed; },
    lastPart() { return R() ? S().lastPart || 0 : live.recParts.at(-1)?.part || 0; },
  };
}
