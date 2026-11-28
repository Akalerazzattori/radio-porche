// Mesa de mezclas del estudio (el único dispositivo que mezcla y emite).
// Buses: voces · efectos · música (fondo y canciones) · pestaña compartida.
// Salidas: oyentes (y grabación), una mezcla por invitado en Casa (sin su voz),
// una mezcla Patio (solo música y efectos), y los cascos del presentador.
import { audioCtx } from './voice.js';

const FADE = 1.5;
const BG_LEVEL = 0.28; // música "a fondo"

export class Mixer {
  constructor() {
    const c = (this.ctx = audioCtx());
    this.voices = new Map(); // id -> {src, gain, mute, analyser, data, local, el}
    this.casa = new Map(); // id -> {sum, dest}
    this.fxPlaying = new Set();
    this.music = null;

    // Salida a oyentes (y grabación)
    this.listenerSum = c.createGain();
    this.onAir = c.createGain(); this.onAir.gain.value = 0; // se abre al salir al aire
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -3; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.002; this.limiter.release.value = 0.1;
    this.listenerSum.connect(this.limiter); this.limiter.connect(this.onAir);
    this.listenerDest = c.createMediaStreamDestination();
    this.onAir.connect(this.listenerDest);
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 2048;
    this.onAir.connect(this.analyser);
    this.fft = new Float32Array(this.analyser.frequencyBinCount);

    // Patio: solo música y efectos (sin voces ni pestaña)
    this.patioSum = c.createGain();
    this.patioDest = c.createMediaStreamDestination();
    this.patioSum.connect(this.patioDest);

    // Cascos del presentador
    this.monitor = c.createGain();
    this.monitor.connect(c.destination);
    this.cueGain = c.createGain(); // pre-escucha
    this.cueGain.connect(c.destination);

    // Buses
    this.fxBus = c.createGain(); this.fxBus.gain.value = 0.9;
    // Los sonidos largos (una falca, una cortinilla de un minuto) bajan solos cuando alguien habla, como la música
    this.fxLong = c.createGain(); this.fxLong.connect(this.fxBus);
    this.musicBus = c.createGain(); this.musicBus.gain.value = BG_LEVEL;
    this.duck = c.createGain();
    this.musicBus.connect(this.duck);
    this.tabBus = c.createGain(); this.tabBus.gain.value = 0.8;
    for (const b of [this.fxBus, this.duck]) { b.connect(this.listenerSum); b.connect(this.patioSum); b.connect(this.monitor); }
    this.tabBus.connect(this.listenerSum); this.tabBus.connect(this.monitor);
    // Medidores de la mesa: lo que suena en cada línea (después de su deslizador)
    this.busA = {};
    for (const [k, node] of [['music', this.duck], ['fx', this.fxBus], ['tab', this.tabBus]]) {
      const a = c.createAnalyser(); a.fftSize = 512; node.connect(a); this.busA[k] = { a, data: new Float32Array(512) };
    }

    this.ducking = true;
    this.manualUntil = 0;
    this.soloMusic = false;
    this.feedbackSince = 0;
    this.onFeedback = null;
    this.loop = setInterval(() => this.tick(), 60);
  }

  get listenerStream() { return this.listenerDest.stream; }
  get patioStream() { return this.patioDest.stream; }

  /** Retorno: oír la emisión (música, efectos, invitados) en este aparato. Sin cascos, mejor apagado. */
  setMonitor(on) { this.monitorOn = !!on; this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05); }
  setOnAir(on) { this.onAir.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05); }

  // ---------- Voces
  addVoice(id, { node, stream, local = false, name = '' }) {
    this.removeVoice(id);
    const c = this.ctx;
    let src = node, el = null;
    if (!src) {
      // Chrome necesita que el stream remoto esté en un <audio> para que fluya a Web Audio
      el = new Audio(); el.muted = true; el.srcObject = stream; el.play().catch(() => {});
      src = c.createMediaStreamSource(stream);
    }
    const gain = c.createGain();
    const mute = c.createGain();
    const analyser = c.createAnalyser(); analyser.fftSize = 512;
    src.connect(gain); gain.connect(mute); mute.connect(analyser);
    mute.connect(this.listenerSum);
    if (!local) mute.connect(this.monitor); // la propia voz solo con "Oírme" (en Voice)
    for (const [cid, m] of this.casa) if (cid !== id) mute.connect(m.sum);
    const v = { id, src, gain, mute, analyser, data: new Float32Array(512), local, el, name, userMuted: false };
    this.voices.set(id, v);
    if (this.soloMusic) mute.gain.value = 0;
    return v;
  }
  removeVoice(id) {
    const v = this.voices.get(id);
    if (!v) return;
    try { v.gain.disconnect(); v.mute.disconnect(); if (!v.local) v.src.disconnect(); } catch {}
    if (v.el) { v.el.srcObject = null; }
    this.voices.delete(id);
  }
  setVoiceGain(id, val) { const v = this.voices.get(id); if (v) { v.gain.gain.setTargetAtTime(val, this.ctx.currentTime, 0.03); v.level = val; } this.syncSelf(); }
  /** "Oírme" (tu voz en tus cascos) sigue a tu tira: si la bajas, la silencias o pones solo música, te oyes igual que te oyen. */
  syncSelf() {
    const me = this.voices.get('me');
    if (me && this.selfVoice) this.selfVoice.setMonitorScale(me.userMuted || this.soloMusic ? 0 : (me.level ?? 1));
  }
  muteVoice(id, on) {
    const v = this.voices.get(id);
    if (!v) return;
    v.userMuted = !!on;
    v.mute.gain.setTargetAtTime(on || this.soloMusic ? 0 : 1, this.ctx.currentTime, 0.03);
    this.syncSelf();
  }
  /** Nivel 0..1 de una línea de la mesa: music, fx o tab. */
  busLevel(k) {
    const b = this.busA?.[k];
    if (!b) return 0;
    b.a.getFloatTimeDomainData(b.data);
    let s = 0, pk = 0;
    for (let i = 0; i < b.data.length; i++) { const v = b.data[i]; s += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
    return Math.min(1, Math.max(Math.sqrt(s / b.data.length) * 4, pk * 0.9));
  }
  voiceLevel(id) {
    const v = this.voices.get(id);
    if (!v) return 0;
    v.analyser.getFloatTimeDomainData(v.data);
    let s = 0;
    for (let i = 0; i < v.data.length; i++) s += v.data[i] * v.data[i];
    return Math.min(1, Math.sqrt(s / v.data.length) * 4);
  }

  // ---------- Mezclas por invitado
  addCasa(id) {
    if (this.casa.has(id)) return this.casa.get(id).dest.stream;
    const c = this.ctx;
    const sum = c.createGain();
    const dest = c.createMediaStreamDestination();
    sum.connect(dest);
    this.fxBus.connect(sum); this.duck.connect(sum); this.tabBus.connect(sum);
    for (const [vid, v] of this.voices) if (vid !== id) v.mute.connect(sum); // mix-minus
    this.casa.set(id, { sum, dest });
    return dest.stream;
  }
  removeCasa(id) {
    const m = this.casa.get(id);
    if (!m) return;
    for (const b of [this.fxBus, this.duck, this.tabBus]) { try { b.disconnect(m.sum); } catch {} }
    for (const v of this.voices.values()) { try { v.mute.disconnect(m.sum); } catch {} }
    try { m.sum.disconnect(); } catch {}
    this.casa.delete(id);
  }

  // ---------- Efectos (varios a la vez, encima de todo)
  playFx(buffer, { onEnd, cue = false } = {}) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.connect(cue ? this.cueGain : buffer.duration > 8 ? this.fxLong : this.fxBus);
    const h = { src: s, start: this.ctx.currentTime, duration: buffer.duration, cue };
    s.onended = () => { this.fxPlaying.delete(h); onEnd?.(); };
    s.start();
    this.fxPlaying.add(h);
    h.stop = () => { try { s.stop(); } catch {} };
    h.progress = () => Math.min(1, (this.ctx.currentTime - h.start) / h.duration);
    return h;
  }
  setFxLevel(v) { this.fxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }

  // ---------- Música (una pista a la vez)
  playMusic(buffer, { loop = false, id = '', name = '', onEnd, offset = 0 } = {}) {
    this.pausedMusic = null;
    this.stopMusic(0.6);
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = buffer; s.loop = loop;
    const g = c.createGain(); g.gain.value = 0;
    s.connect(g); g.connect(this.musicBus);
    g.gain.setTargetAtTime(1, c.currentTime, 0.15);
    const m = { src: s, gain: g, id, name, loop, start: c.currentTime - offset, duration: buffer.duration, buffer, onEnd };
    s.onended = () => { if (this.music === m) { this.music = null; onEnd?.(); } };
    s.start(0, offset % buffer.duration);
    this.music = m;
    return m;
  }
  stopMusic(fade = FADE) {
    const m = this.music;
    if (!m) return;
    this.music = null;
    const t = this.ctx.currentTime;
    m.gain.gain.cancelScheduledValues(t);
    m.gain.gain.setValueAtTime(m.gain.gain.value, t);
    m.gain.gain.linearRampToValueAtTime(0, t + fade);
    try { m.src.stop(t + fade + 0.05); } catch {}
  }
  musicPosition() {
    const m = this.music;
    if (!m) return 0;
    const e = this.ctx.currentTime - m.start;
    return m.loop ? e % m.duration : Math.min(e, m.duration);
  }
  /** Pausa del directo: la música se para donde iba (y sigue desde ahí al reanudar) y se cortan los efectos. */
  pauseAll() {
    for (const h of this.fxPlaying) if (!h.cue) h.stop();
    const m = this.music;
    this.pausedMusic = m ? { buffer: m.buffer, loop: m.loop, id: m.id, name: m.name, onEnd: m.onEnd, offset: this.musicPosition() } : null;
    if (m) this.stopMusic(0.3);
  }
  resumeAll() {
    const p = this.pausedMusic;
    this.pausedMusic = null;
    if (p && p.offset < p.buffer.duration - 0.5) return this.playMusic(p.buffer, p);
  }
  cue(buffer) { return this.playFx(buffer, { cue: true }); }

  /** Deslizador manual: manda sobre el ducking durante un rato. */
  setMusicLevel(v, manual = true) {
    if (manual) { this.manualUntil = performance.now() + 8000; this.duck.gain.setTargetAtTime(1, this.ctx.currentTime, 0.1); }
    this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    this.musicLevel = v;
  }
  rampMusic(to) {
    const t = this.ctx.currentTime, g = this.musicBus.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(to, t + FADE);
    this.musicLevel = to;
    this.manualUntil = 0;
  }
  musicUp() { this.rampMusic(1); }
  musicDown() { this.rampMusic(BG_LEVEL); }

  setSoloMusic(on) {
    this.soloMusic = !!on;
    for (const v of this.voices.values()) v.mute.gain.setTargetAtTime(on || v.userMuted ? 0 : 1, this.ctx.currentTime, 0.05);
    on ? this.musicUp() : this.musicDown();
    this.syncSelf();
  }

  // ---------- Pestaña con audio (solo ordenador con Chrome)
  stopTab() {
    try { this.tabSrc?.disconnect(); this.tabTrack?.stop(); } catch {}
    this.tabSrc = null; this.tabTrack = null;
    this.onTabEnd?.();
  }
  setTabLevel(v) { this.tabBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }

  // ---------- Bucle: ducking y detección de acople
  tick() {
    const t = this.ctx.currentTime;
    if (this.ducking && performance.now() > this.manualUntil && !this.soloMusic) {
      let max = 0;
      for (const v of this.voices.values()) if (!v.userMuted) max = Math.max(max, this.voiceLevel(v.id));
      // Con voz, la música y los sonidos largos bajan a una cuarta parte (−12 dB): la voz siempre se entiende
      const target = max > 0.1 ? 0.25 : 1;
      if (Math.abs(this.duck.gain.value - target) > 0.02) this.duck.gain.setTargetAtTime(target, t, target < 1 ? 0.12 : 0.6);
      if (Math.abs(this.fxLong.gain.value - target) > 0.02) this.fxLong.gain.setTargetAtTime(target, t, target < 1 ? 0.12 : 0.6);
    } else if (!this.ducking && this.duck.gain.value < 0.98) {
      this.duck.gain.setTargetAtTime(1, t, 0.3);
      this.fxLong.gain.setTargetAtTime(1, t, 0.3);
    }
    // Acople: un pico estrecho y fuerte que se mantiene
    this.analyser.getFloatFrequencyData(this.fft);
    let peak = -Infinity, sum = 0, n = 0;
    for (let i = 8; i < this.fft.length / 2; i++) { const v = this.fft[i]; if (v > peak) peak = v; if (Number.isFinite(v)) { sum += v; n++; } }
    const mean = n ? sum / n : -100;
    if (peak > -18 && peak - mean > 42) {
      if (!this.feedbackSince) this.feedbackSince = performance.now();
      else if (performance.now() - this.feedbackSince > 1200) { this.feedbackSince = performance.now() + 15000; this.onFeedback?.(); }
    } else if (this.feedbackSince && this.feedbackSince < performance.now()) this.feedbackSince = 0;
  }

  destroy() {
    clearInterval(this.loop);
    this.stopMusic(0.1);
    for (const h of this.fxPlaying) h.stop();
    this.stopTab();
    for (const id of [...this.voices.keys()]) this.removeVoice(id);
    for (const id of [...this.casa.keys()]) this.removeCasa(id);
    try { this.monitor.disconnect(); this.cueGain.disconnect(); this.onAir.disconnect(); } catch {}
  }
}
