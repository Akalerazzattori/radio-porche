// Cambio de tono en tiempo real (Pitufo / Gigante): dos lecturas de una línea de
// retardo con fundido cruzado. Ligero, pensado para móvil.
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.4, maxValue: 2.5 }];
  }
  constructor() {
    super();
    this.N = Math.round(sampleRate * 0.05); // ventana de 50 ms
    this.L = this.N * 2 + 4;
    this.buf = new Float32Array(this.L);
    this.w = 0;
    this.phase = 0;
  }
  read(d) {
    let p = this.w - d;
    while (p < 0) p += this.L;
    const i = Math.floor(p), f = p - i;
    const a = this.buf[i % this.L], b = this.buf[(i + 1) % this.L];
    return a + (b - a) * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    if (!inp) { out.fill(0); return true; }
    const ratio = params.ratio.length > 1 ? params.ratio[0] : params.ratio[0];
    const step = (1 - ratio) / this.N;
    for (let i = 0; i < inp.length; i++) {
      this.buf[this.w] = inp[i];
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      if (this.phase < 0) this.phase += 1;
      const p2 = (this.phase + 0.5) % 1;
      const g1 = Math.sin(Math.PI * this.phase) ** 2;
      const g2 = Math.sin(Math.PI * p2) ** 2;
      out[i] = this.read(this.phase * this.N + 1) * g1 + this.read(p2 * this.N + 1) * g2;
      this.w = (this.w + 1) % this.L;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor('pitch-shifter', PitchShifter);
