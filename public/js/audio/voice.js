// Voz procesada en el propio móvil antes de enviarla.
// Mejorada (por defecto): paso alto, de-esser suave, presencia, compresor.
// Efectos: Pitufo, Robot, Walkie, Burbuja, Gigante, Eco.

let ctx = null;
let workletReady = null;

export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

async function ensureWorklet(c) {
  if (!c.audioWorklet) return false;
  if (!workletReady) workletReady = c.audioWorklet.addModule('/js/audio/pitch-worklet.js').then(() => true).catch(() => false);
  return workletReady;
}

function makeCurve(k = 30) {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
  return curve;
}

export class Voice {
  constructor() {
    this.ctx = audioCtx();
    this.stream = null;
    this.effect = null;
    this.fxNodes = [];
    this.muted = false;
  }

  /** headphones=false reactiva la cancelación de eco (si alguien entra sin cascos). */
  async start({ headphones = true } = {}) {
    const c = this.ctx;
    this.headphones = headphones;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: !headphones,
        noiseSuppression: true,
        autoGainControl: !headphones,
        channelCount: 1,
        sampleRate: 48000,
      },
    });
    await ensureWorklet(c);
    this.src = c.createMediaStreamSource(this.stream);
    // --- Mejorada
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;
    const mud = c.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.Q.value = 1; mud.gain.value = -2;
    const pres = c.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.9; pres.gain.value = 3.5;
    const deess = c.createBiquadFilter(); deess.type = 'peaking'; deess.frequency.value = 7000; deess.Q.value = 2.5; deess.gain.value = -4;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -26; comp.knee.value = 8; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.18;
    const makeup = c.createGain(); makeup.gain.value = 1.6;
    this.src.connect(hp); hp.connect(mud); mud.connect(pres); pres.connect(deess); deess.connect(comp); comp.connect(makeup);
    this.fxIn = makeup;
    this.fxOut = c.createGain();
    this.out = c.createGain(); // silenciar
    this.fxOut.connect(this.out);
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 512;
    this.out.connect(this.analyser);
    this.dest = c.createMediaStreamDestination();
    this.out.connect(this.dest);
    // "Oírme": con cascos viene encendido (se puede apagar y se recuerda); sin cascos, nunca.
    this.monitorOn = headphones && localStorage.getItem('rp_oirme') !== '0';
    this.monitor = c.createGain(); this.monitor.gain.value = this.monitorOn ? 1 : 0;
    this.out.connect(this.monitor);
    this.monitor.connect(c.destination);
    this.setEffect(null);
    this.data = new Float32Array(this.analyser.fftSize);
    return this.dest.stream;
  }

  get track() { return this.dest?.stream.getAudioTracks()[0] || null; }
  /** Nodo de salida para mezclar en local (presentador). */
  get node() { return this.out; }

  setEffect(id) {
    const c = this.ctx;
    try { this.fxIn.disconnect(); } catch {}
    for (const n of this.fxNodes) { try { n.disconnect(); } catch {} try { n.stop?.(); } catch {} }
    this.fxNodes = [];
    this.effect = id || null;
    const chain = (...nodes) => {
      let prev = this.fxIn;
      for (const n of nodes) { prev.connect(n); prev = n; }
      prev.connect(this.fxOut);
      this.fxNodes.push(...nodes);
    };
    const pitch = (ratio) => {
      try {
        const n = new AudioWorkletNode(c, 'pitch-shifter');
        n.parameters.get('ratio').value = ratio;
        return n;
      } catch { return null; }
    };
    switch (id) {
      case 'pitufo': { const p = pitch(1.65); const hs = c.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 3000; hs.gain.value = 3; p ? chain(p, hs) : chain(hs); break; }
      case 'gigante': { const p = pitch(0.66); const ls = c.createBiquadFilter(); ls.type = 'lowshelf'; ls.frequency.value = 200; ls.gain.value = 4; p ? chain(p, ls) : chain(ls); break; }
      case 'robot': {
        const ring = c.createGain(); ring.gain.value = 0;
        const osc = c.createOscillator(); osc.type = 'square'; osc.frequency.value = 55; osc.connect(ring.gain); osc.start();
        const d = c.createDelay(0.05); d.delayTime.value = 0.009;
        const fb = c.createGain(); fb.gain.value = 0.55;
        const mix = c.createGain();
        this.fxIn.connect(ring); ring.connect(mix); ring.connect(d); d.connect(fb); fb.connect(d); d.connect(mix); mix.connect(this.fxOut);
        this.fxNodes.push(ring, osc, d, fb, mix);
        break;
      }
      case 'walkie': {
        const a = c.createBiquadFilter(); a.type = 'highpass'; a.frequency.value = 450;
        const b = c.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = 2800;
        const pk = c.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 1500; pk.gain.value = 6;
        const ws = c.createWaveShaper(); ws.curve = makeCurve(40); ws.oversample = '2x';
        const g = c.createGain(); g.gain.value = 0.6;
        chain(a, b, pk, ws, g);
        break;
      }
      case 'burbuja': {
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 650; lp.Q.value = 4;
        const d = c.createDelay(0.1); d.delayTime.value = 0.015;
        const lfo = c.createOscillator(); lfo.frequency.value = 5;
        const depth = c.createGain(); depth.gain.value = 0.006;
        lfo.connect(depth); depth.connect(d.delayTime); lfo.start();
        const g = c.createGain(); g.gain.value = 1.4;
        chain(lp, d, g);
        this.fxNodes.push(lfo, depth);
        break;
      }
      case 'eco': {
        const d = c.createDelay(1); d.delayTime.value = 0.3;
        const fb = c.createGain(); fb.gain.value = 0.45;
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
        const wet = c.createGain(); wet.gain.value = 0.6;
        this.fxIn.connect(this.fxOut);
        this.fxIn.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(this.fxOut);
        this.fxNodes.push(d, fb, lp, wet);
        break;
      }
      default:
        this.fxIn.connect(this.fxOut);
    }
  }

  setMonitor(on) {
    this.monitorOn = !!on;
    try { localStorage.setItem('rp_oirme', on ? '1' : '0'); } catch {}
    if (this.monitor) this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }
  setMuted(on) {
    this.muted = !!on;
    if (this.out) this.out.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.02);
  }
  /** Nivel 0..1 (para el medidor). */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let s = 0;
    for (let i = 0; i < this.data.length; i++) s += this.data[i] * this.data[i];
    return Math.min(1, Math.sqrt(s / this.data.length) * 4);
  }
  stop() {
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.src?.disconnect(); this.out?.disconnect(); this.monitor?.disconnect(); } catch {}
    for (const n of this.fxNodes) { try { n.stop?.(); } catch {} }
    this.stream = null;
  }
}

/** Pinta un medidor de segmentos (como en el diseño). */
export function meterHtml(n = 12) {
  return `<div class="meter">${'<i></i>'.repeat(n)}</div>`;
}
export function setMeter(el, level) {
  if (!el) return;
  const segs = el.children;
  const lit = Math.round(level * segs.length);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const on = i < lit;
    const zone = i / segs.length;
    s.className = on ? (zone > 0.85 ? 'r' : zone > 0.65 ? 'y' : 't') : '';
  }
}
