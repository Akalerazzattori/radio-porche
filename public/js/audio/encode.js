// Codificación en el navegador: Opus (WebCodecs) dentro de WebM, sin subir nada.
// Si el navegador no tiene WebCodecs, se graba en tiempo real con MediaRecorder.

export async function canEncodeOpus(sampleRate = 48000) {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const r = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 64000 });
    return !!r.supported;
  } catch { return false; }
}

/** Une los trozos conservados de un AudioBuffer (mono) en un Float32Array. */
export function renderSegments(buffer, segments) {
  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  let total = 0;
  const ranges = segments.map(([a, b]) => {
    const s = Math.max(0, Math.floor(a * sr)), e = Math.min(ch.length, Math.floor(b * sr));
    total += Math.max(0, e - s);
    return [s, e];
  });
  const out = new Float32Array(total);
  let o = 0;
  const fade = Math.floor(sr * 0.008); // micro-fundido para que no "clique" el corte
  for (const [s, e] of ranges) {
    if (e <= s) continue;
    out.set(ch.subarray(s, e), o);
    const n = e - s;
    for (let i = 0; i < Math.min(fade, n / 2); i++) {
      const g = i / fade;
      out[o + i] *= g;
      out[o + n - 1 - i] *= g;
    }
    o += n;
  }
  return out;
}

export function mixToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const a = buffer.getChannelData(0), b = buffer.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) * 0.5;
  return out;
}

/** Float32 mono → Blob WebM/Opus. */
export async function encodeOpusWebm(pcm, sampleRate, { bitrate = 64000, onProgress } = {}) {
  const chunks = [];
  let description = null;
  let error = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      chunks.push({ ts: chunk.timestamp, data: d });
      if (meta?.decoderConfig?.description && !description) description = new Uint8Array(meta.decoderConfig.description);
    },
    error: (e) => { error = e; },
  });
  enc.configure({ codec: 'opus', sampleRate, numberOfChannels: 1, bitrate });
  const frame = sampleRate / 2; // medio segundo por bloque
  for (let i = 0; i < pcm.length; i += frame) {
    if (error) throw error;
    const n = Math.min(frame, pcm.length - i);
    const data = pcm.slice(i, i + n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round((i / sampleRate) * 1e6), data });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 0));
    if (onProgress && (i / frame) % 20 === 0) { onProgress(i / pcm.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  await enc.flush();
  enc.close();
  if (error) throw error;
  onProgress?.(1);
  const head = description && description.length >= 19 ? description : opusHead(sampleRate);
  return muxWebm(chunks, head, pcm.length / sampleRate);
}

function opusHead(inputRate) {
  const b = new Uint8Array(19);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // OpusHead
  b[8] = 1; b[9] = 1; // versión, canales
  const dv = new DataView(b.buffer);
  dv.setUint16(10, 312, true); // pre-skip
  dv.setUint32(12, inputRate, true);
  dv.setInt16(16, 0, true);
  b[18] = 0;
  return b;
}

// ---------- Mini escritor WebM ----------
const te = new TextEncoder();
function idBytes(id) {
  const out = [];
  let v = id;
  while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256); }
  return out;
}
function sizeVint(n, len = 0) {
  if (!len) { len = 1; while (n >= 2 ** (7 * len) - 1) len++; }
  const out = new Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  out[0] |= 1 << (8 - len);
  return out;
}
function cat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function el(id, data) {
  const d = data instanceof Uint8Array ? data : new Uint8Array(data);
  return cat([new Uint8Array(idBytes(id)), new Uint8Array(sizeVint(d.length)), d]);
}
function uint(v, len = 0) {
  const out = [];
  let x = v;
  do { out.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0);
  while (len && out.length < len) out.unshift(0);
  return new Uint8Array(out);
}
function f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; }
function str(s) { return te.encode(s); }

function muxWebm(chunks, opusHeadBytes, durationSec) {
  const ebml = el(0x1a45dfa3, cat([
    el(0x4286, uint(1)), el(0x42f7, uint(1)), el(0x42f2, uint(4)), el(0x42f3, uint(8)),
    el(0x4282, str('webm')), el(0x4287, uint(4)), el(0x4285, uint(2)),
  ]));
  const info = el(0x1549a966, cat([
    el(0x2ad7b1, uint(1000000)), el(0x4489, f64(durationSec * 1000)),
    el(0x4d80, str('RadioPorche')), el(0x5741, str('RadioPorche')),
  ]));
  const tracks = el(0x1654ae6b, el(0xae, cat([
    el(0xd7, uint(1)), el(0x73c5, uint(1)), el(0x83, uint(2)), el(0x86, str('A_OPUS')),
    el(0x63a2, opusHeadBytes), el(0x56aa, uint(6500000)), el(0x56bb, uint(80000000)),
    el(0xe1, cat([el(0xb5, f64(48000)), el(0x9f, uint(1))])),
  ])));
  // Clusters de ~5 s
  const clusters = [];
  let cur = null;
  for (const c of chunks) {
    const ms = Math.round(c.ts / 1000);
    if (!cur || ms - cur.tc > 5000) { cur = { tc: ms, blocks: [] }; clusters.push(cur); }
    const rel = ms - cur.tc;
    const hdr = new Uint8Array(4);
    hdr[0] = 0x81;
    new DataView(hdr.buffer).setInt16(1, rel);
    hdr[3] = 0x80;
    cur.blocks.push(el(0xa3, cat([hdr, c.data])));
  }
  const clusterBytes = clusters.map((c) => el(0x1f43b675, cat([el(0xe7, uint(c.tc)), ...c.blocks])));
  const seekEntry = (id, pos) => el(0x4dbb, cat([el(0x53ab, new Uint8Array(idBytes(id))), el(0x53ac, uint(pos, 8))]));
  const seekHeadLen = el(0x114d9b74, cat([seekEntry(0x1549a966, 0), seekEntry(0x1654ae6b, 0), seekEntry(0x1c53bb6b, 0)])).length;
  const infoPos = seekHeadLen;
  const tracksPos = infoPos + info.length;
  let pos = tracksPos + tracks.length;
  const cuePoints = [];
  for (let i = 0; i < clusters.length; i++) {
    cuePoints.push(el(0xbb, cat([el(0xb3, uint(clusters[i].tc)), el(0xb7, cat([el(0xf7, uint(1)), el(0xf1, uint(pos))]))])));
    pos += clusterBytes[i].length;
  }
  const cuesPos = pos;
  const cues = el(0x1c53bb6b, cat(cuePoints));
  const seekHead = el(0x114d9b74, cat([seekEntry(0x1549a966, infoPos), seekEntry(0x1654ae6b, tracksPos), seekEntry(0x1c53bb6b, cuesPos)]));
  const body = [seekHead, info, tracks, ...clusterBytes, cues];
  let bodyLen = 0;
  for (const b of body) bodyLen += b.length;
  const segHead = cat([new Uint8Array(idBytes(0x18538067)), new Uint8Array(sizeVint(bodyLen, 8))]);
  return new Blob([ebml, segHead, ...body], { type: 'audio/webm' });
}

// ---------- WAV (para sonidos cortos si no hay WebCodecs) ----------
export function encodeWav(pcm, sampleRate) {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

export function recorderMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=opus', 'audio/mp4'];
  for (const o of opts) if (window.MediaRecorder?.isTypeSupported?.(o)) return o;
  return '';
}

/** Plan B: reproduce el audio en silencio y lo graba con MediaRecorder (tarda lo que dura). */
export async function recordRealtime(pcm, sampleRate, { onProgress } = {}) {
  const ctx = new AudioContext({ sampleRate });
  const buf = ctx.createBuffer(1, pcm.length, sampleRate);
  buf.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  const mime = recorderMime();
  const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start(1000);
  await ctx.resume();
  src.start();
  const dur = pcm.length / sampleRate;
  const t0 = ctx.currentTime;
  const iv = setInterval(() => onProgress?.(Math.min(1, (ctx.currentTime - t0) / dur)), 500);
  await new Promise((r) => (src.onended = r));
  rec.stop();
  await done;
  clearInterval(iv);
  ctx.close();
  return new Blob(parts, { type: (mime || 'audio/webm').split(';')[0] });
}

/** Codifica con lo mejor disponible. */
export async function encodeBest(pcm, sampleRate, opts = {}) {
  if (await canEncodeOpus(sampleRate)) {
    try { return await encodeOpusWebm(pcm, sampleRate, opts); } catch (e) { console.warn('WebCodecs falló, plan B', e); }
  }
  return recordRealtime(pcm, sampleRate, opts);
}
