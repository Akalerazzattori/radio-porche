// Voz procesada en el propio móvil antes de enviarla.
// Mejorada (por defecto): paso alto, de-esser suave, presencia, compresor.
// Efectos de personaje (ver VOICE_FX en config.js). Todos salen al MISMO volumen:
// un igualador automático compara tu voz antes y después del efecto y compensa la diferencia.

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

/** Respuesta de impulso sintética para reverberaciones (sala, catedral, fantasma). */
const irCache = new Map();
function makeIR(c, seconds, decay = 3, bright = 1) {
  const key = `${seconds}|${decay}|${bright}`;
  if (irCache.has(key)) return irCache.get(key);
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * bright; // brillo: 1 = blanco, menos = más oscuro
      d[i] = lp * Math.pow(1 - i / len, decay);
    }
  }
  irCache.set(key, buf);
  return buf;
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
    // Igualador de volumen de los efectos: mide antes (fxIn) y después (fxOut) y compensa
    this.agc = c.createGain();
    this.fxOut.connect(this.agc); this.agc.connect(this.out);
    this.preA = c.createAnalyser(); this.preA.fftSize = 2048; this.fxIn.connect(this.preA);
    this.postA = c.createAnalyser(); this.postA.fftSize = 2048; this.fxOut.connect(this.postA);
    this.agcBuf = new Float32Array(2048);
    this.agcGain = 1;
    this.agcIv = setInterval(() => this.levelMatch(), 60);
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

  /** Compara el volumen de tu voz con y sin efecto y ajusta para que todos suenen igual. */
  levelMatch() {
    if (!this.preA) return;
    const rms = (an) => { an.getFloatTimeDomainData(this.agcBuf); let q = 0; for (let i = 0; i < this.agcBuf.length; i++) q += this.agcBuf[i] * this.agcBuf[i]; return Math.sqrt(q / this.agcBuf.length); };
    let target = 1;
    if (this.effect) {
      const pre = rms(this.preA), post = rms(this.postA);
      if (pre < 0.008 || post < 1e-5) return; // en silencio no se toca
      target = Math.min(4, Math.max(0.25, pre / post));
    }
    this.agcGain += (target - this.agcGain) * (this.effect ? 0.12 : 0.5);
    this.agc.gain.setTargetAtTime(this.agcGain, this.ctx.currentTime, 0.05);
  }

  setEffect(id) {
    const c = this.ctx;
    try { this.fxIn.disconnect(); } catch {}
    for (const n of this.fxNodes) { try { n.disconnect(); } catch {} try { n.stop?.(); } catch {} }
    this.fxNodes = [];
    this.fxIn.connect(this.preA);
    this.effect = id || null;
    // Ganancia inicial aproximada por efecto (el igualador afina enseguida)
    const START = { pitufo: 1.2, gigante: 1, monstruo: 0.9, robot: 1.4, walkie: 0.8, telefono: 1.1, megafono: 0.7, radio: 1, burbuja: 1.3, eco: 0.8, catedral: 0.9, fantasma: 1, alien: 1.2, locutor: 0.9, abuelo: 1.1 };
    this.agcGain = START[id] || 1;
    this.agc.gain.setValueAtTime(this.agcGain, c.currentTime);
    const chain = (...nodes) => {
      nodes = nodes.filter(Boolean);
      let prev = this.fxIn;
      for (const n of nodes) { prev.connect(n); prev = n; }
      prev.connect(this.fxOut);
      this.fxNodes.push(...nodes);
      return prev;
    };
    const pitch = (ratio) => {
      try { const n = new AudioWorkletNode(c, 'pitch-shifter'); n.parameters.get('ratio').value = ratio; return n; } catch { return null; }
    };
    const filt = (type, f, q = 0.7, g = 0) => { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = g; return n; };
    const shaper = (k) => { const n = c.createWaveShaper(); n.curve = makeCurve(k); n.oversample = '2x'; return n; };
    const gain = (v) => { const n = c.createGain(); n.gain.value = v; return n; };
    const lfo = (freq, depth, target, type = 'sine') => { const o = c.createOscillator(); o.type = type; o.frequency.value = freq; const d = gain(depth); o.connect(d); d.connect(target); o.start(); this.fxNodes.push(o, d); return o; };
    /** Señal seca + reverberación (mezcla). */
    const reverb = (from, seconds, decay, bright, wetV, dryV = 1) => {
      const cv = c.createConvolver(); cv.buffer = makeIR(c, seconds, decay, bright);
      const wet = gain(wetV), dry = gain(dryV);
      from.connect(cv); cv.connect(wet); wet.connect(this.fxOut);
      from.connect(dry); dry.connect(this.fxOut);
      this.fxNodes.push(cv, wet, dry);
    };
    switch (id) {
      case 'pitufo': chain(pitch(1.65), filt('highshelf', 3000, 0.7, 3)); break;
      case 'gigante': chain(pitch(0.66), filt('lowshelf', 200, 0.7, 4)); break;
      case 'monstruo': chain(pitch(0.5), filt('lowshelf', 160, 0.7, 6), shaper(6), filt('lowpass', 3500)); break;
      case 'robot': {
        const ring = gain(0);
        const osc = c.createOscillator(); osc.type = 'square'; osc.frequency.value = 55; osc.connect(ring.gain); osc.start();
        const d = c.createDelay(0.05); d.delayTime.value = 0.009;
        const fb = gain(0.55), mix = gain(1);
        this.fxIn.connect(ring); ring.connect(mix); ring.connect(d); d.connect(fb); fb.connect(d); d.connect(mix); mix.connect(this.fxOut);
        this.fxNodes.push(ring, osc, d, fb, mix);
        break;
      }
      case 'walkie': chain(filt('highpass', 450), filt('lowpass', 2800), filt('peaking', 1500, 1, 6), shaper(40)); break;
      case 'telefono': chain(filt('highpass', 320, 0.9), filt('lowpass', 3400, 0.9), filt('peaking', 1800, 1, 4), shaper(4)); break;
      case 'megafono': chain(filt('highpass', 600, 1), filt('lowpass', 4200, 1), filt('peaking', 2200, 1.2, 9), shaper(60)); break;
      case 'radio': {
        // Radio de los años 40: banda estrecha, algo saturada y con un vaivén leve
        const d = c.createDelay(0.05); d.delayTime.value = 0.004;
        chain(filt('highpass', 380, 0.8), filt('lowpass', 2600, 0.8), filt('peaking', 1100, 0.8, 5), shaper(10), d);
        lfo(0.6, 0.0008, d.delayTime);
        break;
      }
      case 'burbuja': {
        // Bajo el agua: apagado pero se entiende, con un vaivén que suena a burbujas
        const d = c.createDelay(0.05); d.delayTime.value = 0.008;
        chain(filt('lowpass', 1400, 1.2), filt('peaking', 500, 1.5, 5), d);
        lfo(7, 0.0025, d.delayTime);
        break;
      }
      case 'eco': {
        const d = c.createDelay(1); d.delayTime.value = 0.3;
        const fb = gain(0.45), lp = filt('lowpass', 3000), wet = gain(0.6);
        this.fxIn.connect(this.fxOut);
        this.fxIn.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(this.fxOut);
        this.fxNodes.push(d, fb, lp, wet);
        break;
      }
      case 'catedral': { const pre = filt('highpass', 150); this.fxIn.connect(pre); this.fxNodes.push(pre); reverb(pre, 4, 2.5, 0.35, 0.9, 0.7); break; }
      case 'fantasma': {
        // Voz grave y temblorosa con mucha reverberación
        const p = pitch(0.85) || gain(1);
        const d = c.createDelay(0.05); d.delayTime.value = 0.01;
        this.fxIn.connect(p); p.connect(d); this.fxNodes.push(p, d);
        lfo(5, 0.003, d.delayTime);
        reverb(d, 3.5, 2, 0.25, 1.1, 0.5);
        break;
      }
      case 'alien': {
        // Extraterrestre: modulación en anillo suave + algo aguda + barrido
        const p = pitch(1.25) || gain(1);
        const ring = gain(0);
        const osc = c.createOscillator(); osc.type = 'sine'; osc.frequency.value = 35; osc.connect(ring.gain); osc.start();
        const dry = gain(0.4);
        const d = c.createDelay(0.05); d.delayTime.value = 0.006;
        this.fxIn.connect(p); p.connect(ring); p.connect(dry); ring.connect(d); dry.connect(d); d.connect(this.fxOut);
        this.fxNodes.push(p, ring, osc, dry, d);
        lfo(0.3, 0.004, d.delayTime);
        break;
      }
      case 'locutor': {
        // Voz de locutor de radio FM: grave, cálida, muy presente y comprimida
        const comp = c.createDynamicsCompressor();
        comp.threshold.value = -30; comp.knee.value = 6; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.12;
        chain(filt('lowshelf', 130, 0.7, 6), filt('peaking', 300, 1, -3), filt('peaking', 3500, 0.9, 4), comp);
        break;
      }
      case 'abuelo': {
        // Abuelito: algo más grave y con temblor en la voz
        const p = pitch(0.92) || gain(1);
        const trem = gain(1);
        chain(p, filt('peaking', 2500, 1, 3), trem);
        lfo(6, 0.28, trem.gain);
        break;
      }
      default:
        this.fxIn.connect(this.fxOut);
    }
  }

  /** Escala de "Oírme" según tu tira de la mesa (0..1.5). */
  setMonitorScale(k) {
    this.monitorScale = k;
    if (this.monitorOn) this.monitor.gain.setTargetAtTime(k, this.ctx.currentTime, 0.03);
  }
  setMonitor(on) {
    this.monitorOn = !!on;
    try { localStorage.setItem('rp_oirme', on ? '1' : '0'); } catch {}
    if (this.monitor) this.monitor.gain.setTargetAtTime(on ? (this.monitorScale ?? 1) : 0, this.ctx.currentTime, 0.02);
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
    clearInterval(this.agcIv);
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
