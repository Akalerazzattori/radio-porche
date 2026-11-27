// Comprobación real de archivos subidos: tipo por cabecera (no por extensión) y duración.

export function sniffAudio(u8) {
  if (u8.length < 12) return null;
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'audio/webm';
  if (u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) return 'audio/ogg';
  if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return 'audio/mp4';
  return null;
}

// Para la biblioteca "de serie" se admite también MP3.
export function sniffLibraryAudio(u8) {
  const t = sniffAudio(u8);
  if (t) return t;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return 'audio/mpeg'; // ID3
  if (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0) return 'audio/mpeg'; // frame sync
  return null;
}

export function sniffImage(u8) {
  if (u8.length < 12) return null;
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
  return null;
}

/** Devuelve la duración en segundos, o null si no se puede determinar. */
export function audioDuration(u8, mime) {
  try {
    if (mime === 'audio/webm') return webmDuration(u8);
    if (mime === 'audio/ogg') return oggDuration(u8);
    if (mime === 'audio/mp4') return mp4Duration(u8);
  } catch (e) {
    return null;
  }
  return null;
}

// ---------- WebM / Matroska ----------
function readVint(u8, p, keepMarker) {
  const b = u8[p];
  if (b === undefined) return null;
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
  if (len > 8) return null;
  let val = keepMarker ? b : b & (mask - 1);
  let allOnes = (b & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    const x = u8[p + i];
    if (x === undefined) return null;
    if (x !== 0xff) allOnes = false;
    val = val * 256 + x;
  }
  return { val, len, unknown: !keepMarker && allOnes };
}

const MASTER = new Set([0x18538067, 0x1f43b675, 0x1549a966, 0xa0]); // Segment, Cluster, Info, BlockGroup

function webmDuration(u8) {
  let p = 0;
  let scale = 1000000; // ns por tick
  let infoDur = null;
  let clusterTc = 0;
  let maxTc = 0;
  const n = u8.length;
  let guard = 0;
  while (p < n && guard++ < 5e6) {
    const id = readVint(u8, p, true);
    if (!id) break;
    const sz = readVint(u8, p + id.len, false);
    if (!sz) break;
    const dataStart = p + id.len + sz.len;
    const size = sz.unknown ? -1 : sz.val;
    const eid = id.val;
    if (eid === 0x1a45dfa3) { p = dataStart + size; continue; } // EBML header
    if (MASTER.has(eid) || size < 0) { p = dataStart; continue; } // descender
    const end = dataStart + size;
    if (end > n) break;
    if (eid === 0x2ad7b1) scale = readUInt(u8, dataStart, size);
    else if (eid === 0x4489) infoDur = size === 4 ? new DataView(u8.buffer, u8.byteOffset + dataStart, 4).getFloat32(0) : new DataView(u8.buffer, u8.byteOffset + dataStart, 8).getFloat64(0);
    else if (eid === 0xe7) clusterTc = readUInt(u8, dataStart, size);
    else if (eid === 0xa3 || eid === 0xa1) {
      const tr = readVint(u8, dataStart, false);
      if (tr) {
        const rel = new DataView(u8.buffer, u8.byteOffset + dataStart + tr.len, 2).getInt16(0);
        const tc = clusterTc + rel;
        if (tc > maxTc) maxTc = tc;
      }
    }
    p = end;
  }
  const fromBlocks = maxTc > 0 ? (maxTc * scale) / 1e9 + 0.02 : null;
  const fromInfo = infoDur ? (infoDur * scale) / 1e9 : null;
  // Fiarse de los bloques reales; la cabecera solo si no hay bloques.
  return fromBlocks ?? fromInfo;
}

function readUInt(u8, p, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + u8[p + i];
  return v;
}

// ---------- Ogg Opus ----------
function oggDuration(u8) {
  for (let p = u8.length - 27; p >= 0; p--) {
    if (u8[p] === 0x4f && u8[p + 1] === 0x67 && u8[p + 2] === 0x67 && u8[p + 3] === 0x53) {
      const dv = new DataView(u8.buffer, u8.byteOffset + p + 6, 8);
      const lo = dv.getUint32(0, true), hi = dv.getUint32(4, true);
      return (hi * 4294967296 + lo) / 48000;
    }
  }
  return null;
}

// ---------- MP4 (incluido el fragmentado de MediaRecorder en Safari) ----------
function boxes(u8, start, end, cb) {
  let p = start;
  while (p + 8 <= end) {
    const dv = new DataView(u8.buffer, u8.byteOffset + p);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr) break;
    cb(type, p + hdr, Math.min(p + size, end));
    p += size;
  }
}

function mp4Duration(u8) {
  let timescale = 0, mvhdDur = 0, mdhdScale = 0, mdhdDur = 0, mehd = 0;
  let maxEnd = 0;
  const fullVer = (p) => u8[p];
  const walk = (s, e) => boxes(u8, s, e, (t, a, b) => {
    const dv = new DataView(u8.buffer, u8.byteOffset + a);
    if (t === 'moov' || t === 'trak' || t === 'mdia' || t === 'mvex') walk(a, b);
    else if (t === 'mvhd') {
      if (fullVer(a) === 1) { timescale = dv.getUint32(20); mvhdDur = Number(dv.getBigUint64(24)); }
      else { timescale = dv.getUint32(12); mvhdDur = dv.getUint32(16); }
    } else if (t === 'mdhd') {
      if (fullVer(a) === 1) { mdhdScale = dv.getUint32(20); mdhdDur = Number(dv.getBigUint64(24)); }
      else { mdhdScale = dv.getUint32(12); mdhdDur = dv.getUint32(16); }
    } else if (t === 'mehd') {
      mehd = fullVer(a) === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
    } else if (t === 'moof') {
      let base = 0, defDur = 0, sum = 0;
      boxes(u8, a, b, (t2, a2, b2) => {
        if (t2 !== 'traf') return;
        boxes(u8, a2, b2, (t3, a3) => {
          const d3 = new DataView(u8.buffer, u8.byteOffset + a3);
          const flags = (u8[a3 + 1] << 16) | (u8[a3 + 2] << 8) | u8[a3 + 3];
          if (t3 === 'tfdt') base = fullVer(a3) === 1 ? Number(d3.getBigUint64(4)) : d3.getUint32(4);
          else if (t3 === 'tfhd') {
            let q = 8; // version/flags + track_ID
            if (flags & 0x1) q += 8;
            if (flags & 0x2) q += 4;
            if (flags & 0x8) defDur = d3.getUint32(q);
          } else if (t3 === 'trun') {
            const count = d3.getUint32(4);
            let q = 8;
            if (flags & 0x1) q += 4;
            if (flags & 0x4) q += 4;
            for (let i = 0; i < count && i < 200000; i++) {
              let dur = defDur;
              if (flags & 0x100) { dur = d3.getUint32(q); q += 4; }
              if (flags & 0x200) q += 4;
              if (flags & 0x400) q += 4;
              if (flags & 0x800) q += 4;
              sum += dur;
            }
          }
        });
      });
      if (base + sum > maxEnd) maxEnd = base + sum;
    }
  });
  walk(0, u8.length);
  if (maxEnd && mdhdScale) return maxEnd / mdhdScale;
  if (mdhdDur && mdhdScale) return mdhdDur / mdhdScale;
  if (mvhdDur && timescale) return mvhdDur / timescale;
  if (mehd && timescale) return mehd / timescale;
  return null;
}
