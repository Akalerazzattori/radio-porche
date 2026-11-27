// Portadas con el estilo de la marca: foto (o escena por defecto) + fecha + título.
import { LIMITS } from './config.js';
import { fmtDate } from './util.js';

export const SCENES = [1, 2, 3, 4].map((n) => `/img/scenes/escena-${n}.webp`);

function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

function wrap(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Devuelve un Blob JPEG/WebP ≤ 500 KB. */
export async function composeCover({ photo, scene = 1, title = '', date = Date.now(), label = '' }) {
  await Promise.all([document.fonts.load('120px Anton'), document.fonts.load('bold 40px "Space Mono"')]).catch(() => {});
  const S = 1080;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const src = photo ? URL.createObjectURL(photo) : SCENES[(scene - 1) % 4];
  try {
    const img = await loadImg(src);
    const r = Math.max(S / img.width, S / img.height);
    const w = img.width * r, h = img.height * r;
    x.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
  } catch {
    x.fillStyle = '#f47a1f'; x.fillRect(0, 0, S, S);
  } finally { if (photo) URL.revokeObjectURL(src); }
  // degradado para que el título se lea
  const g = x.createLinearGradient(0, S * 0.4, 0, S);
  g.addColorStop(0, 'rgba(18,13,12,0)');
  g.addColorStop(1, 'rgba(18,13,12,0.88)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  // fecha
  const chip = (label ? label + ' · ' : '') + fmtDate(date).toUpperCase();
  x.font = 'bold 40px "Space Mono", monospace';
  const cw = x.measureText(chip).width + 44;
  x.fillStyle = '#120d0c'; x.fillRect(48, 48, cw, 70);
  x.fillStyle = '#ffc72c'; x.fillText(chip, 70, 97);
  // título
  const t = (title || 'Radio Porche').toUpperCase();
  let size = 150;
  let lines;
  do { x.font = `${size}px Anton, Impact, sans-serif`; lines = wrap(x, t, S - 120); size -= 8; } while ((lines.length > 3 || lines.some((l) => x.measureText(l).width > S - 110)) && size > 60);
  size += 8;
  const lh = size * 1.0;
  let y = S - 70 - (lines.length - 1) * lh;
  x.textBaseline = 'alphabetic';
  for (const l of lines) {
    x.fillStyle = '#120d0c'; x.fillText(l, 66, y + 7);
    x.fillStyle = '#fbeee0'; x.fillText(l, 60, y);
    y += lh;
  }
  return compress(c);
}

async function compress(canvas) {
  for (const [type, q] of [['image/webp', 0.82], ['image/jpeg', 0.82], ['image/jpeg', 0.7], ['image/jpeg', 0.55]]) {
    const b = await new Promise((r) => canvas.toBlob(r, type, q));
    if (b && b.size <= LIMITS.COVER_MAX_BYTES && (b.type === type)) return b;
  }
  const small = document.createElement('canvas');
  small.width = small.height = 720;
  small.getContext('2d').drawImage(canvas, 0, 0, 720, 720);
  return new Promise((r) => small.toBlob(r, 'image/jpeg', 0.6));
}

/** Reduce una foto cualquiera (para la portada del porche). */
export async function shrinkPhoto(file, max = 900) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const r = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return compress(c);
  } finally { URL.revokeObjectURL(url); }
}
