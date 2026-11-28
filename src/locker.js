// Locker: el "buzón de paso" de cada cuenta (un Durable Object por identidad).
// Lleva grabaciones y sonidos de un aparato tuyo a otro (del ordenador al móvil y al revés):
// el archivo espera aquí SOLO hasta que el otro aparato lo recoge, y entonces se borra.
// También guarda tus preferencias del Estudio (favoritos de la botonera…), que son muy pequeñas.
// Cada cuenta tiene su propio espacio, así nunca se llena el almacén común (Hub).
import { DurableObject } from 'cloudflare:workers';
import { LIMITS } from '../public/js/config.js';
import { json, err, cleanId, now } from './lib/util.js';

const CHUNK = 1900 * 1024; // < 2 MB por fila
const KINDS = new Set(['rec', 'snd', 'del']); // del = aviso de borrado (sin audio)
const SHARE_DAYS = 30; // un enlace privado para un amigo dura 30 días
const MAX_META = 16 * 1024;
const MAX_PREFS = 16 * 1024;
const BYTES_PER_MIN = 64000 / 8 * 60; // grabación a 64 kbps

function randomKey() {
  const b = new Uint8Array(15); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function cloudLimits() {
  return {
    recBytes: Math.round((LIMITS.CLOUD_REC_MIN || 180) * BYTES_PER_MIN * 1.05),
    sndBytes: (LIMITS.CLOUD_SND_MB || 50) * 1024 * 1024,
    recMin: LIMITS.CLOUD_REC_MIN || 180,
    sndMB: LIMITS.CLOUD_SND_MB || 50,
  };
}

export class Locker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, kind TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
        a_bytes INTEGER NOT NULL DEFAULT 0, a_mime TEXT NOT NULL DEFAULT '', p_bytes INTEGER NOT NULL DEFAULT 0, p_mime TEXT NOT NULL DEFAULT '',
        created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (fid TEXT NOT NULL, part TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (fid, part, seq));
      CREATE TABLE IF NOT EXISTS prefs (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }
  all(q, ...a) { return [...this.sql.exec(q, ...a)]; }
  one(q, ...a) { return this.all(q, ...a)[0] || null; }
  run(q, ...a) { this.sql.exec(q, ...a); }

  usage() {
    const r = this.one("SELECT COALESCE(SUM(a_bytes + p_bytes),0) AS n FROM files WHERE kind IN ('rec','shr')").n;
    const s = this.one("SELECT COALESCE(SUM(a_bytes + p_bytes),0) AS n FROM files WHERE kind='snd'").n;
    return { recBytes: r, sndBytes: s };
  }
  /** Quita los enlaces privados caducados. */
  purgeShares() {
    for (const f of this.all("SELECT id, meta FROM files WHERE kind='shr'")) {
      let exp = 0; try { exp = JSON.parse(f.meta).exp || 0; } catch {}
      if (exp && exp < now()) { this.run('DELETE FROM chunks WHERE fid=?', f.id); this.run('DELETE FROM files WHERE id=?', f.id); }
    }
  }
  out(f) {
    let meta = {};
    try { meta = JSON.parse(f.meta); } catch {}
    return { id: f.id, kind: f.kind, meta, aBytes: f.a_bytes, aMime: f.a_mime, pBytes: f.p_bytes, updated: f.updated, created: f.created };
  }

  stream(req, fid, part, total, mime) {
    const range = req.headers.get('range');
    let start = 0, end = total - 1, status = 200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        if (m[1] === '') start = Math.max(0, total - Number(m[2]));
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(total - 1, Number(m[2])); }
        if (start > end || start >= total) return new Response('', { status: 416, headers: { 'content-range': `bytes */${total}` } });
        status = 206;
      }
    }
    let seq = Math.floor(start / CHUNK), pos = start;
    const self = this;
    const body = new ReadableStream({
      pull(c) {
        if (pos > end) { c.close(); return; }
        const r = self.one('SELECT data FROM chunks WHERE fid=? AND part=? AND seq=?', fid, part, seq);
        if (!r) { c.close(); return; }
        const data = new Uint8Array(r.data);
        const base = seq * CHUNK;
        const to = Math.min(data.length, end - base + 1);
        c.enqueue(data.subarray(pos - base, to));
        pos = base + to; seq++;
      },
    });
    const headers = { 'content-type': mime || 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), 'cache-control': 'private, no-store' };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
    return new Response(body, { status, headers });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    try {
      // Audio de tus podcasts publicados (solo el Hub llega aquí: el Worker nunca reenvía /internal)
      let pm;
      if ((pm = /^\/internal\/pod\/([A-Za-z0-9_-]{4,40})(\/delete)?$/.exec(p))) {
        const id = 'pod_' + cleanId(pm[1]);
        if (pm[2] && m === 'POST') { this.run('DELETE FROM chunks WHERE fid=?', id); this.run('DELETE FROM files WHERE id=?', id); return json({ ok: true }); }
        if (m === 'POST') {
          const u8 = new Uint8Array(await req.arrayBuffer());
          const mime = String(req.headers.get('content-type') || 'audio/webm').slice(0, 80);
          this.run('DELETE FROM chunks WHERE fid=?', id); this.run('DELETE FROM files WHERE id=?', id);
          for (let i = 0, seq = 0; i < u8.length; i += CHUNK, seq++) this.run('INSERT INTO chunks (fid, part, seq, data) VALUES (?,?,?,?)', id, 'a', seq, u8.slice(i, i + CHUNK).buffer);
          this.run("INSERT INTO files (id, kind, meta, a_bytes, a_mime, created, updated) VALUES (?, 'pod', '{}', ?, ?, ?, ?)", id, u8.length, mime, now(), now());
          return json({ ok: true });
        }
        if (m === 'GET' || m === 'HEAD') {
          const f = this.one('SELECT * FROM files WHERE id=?', id);
          if (!f) return err(404, 'No existe');
          const res = this.stream(req, id, 'a', f.a_bytes, f.a_mime);
          res.headers.set('cache-control', 'public, max-age=3600');
          return res;
        }
      }
      // Escuchar una grabación compartida en privado (la oye quien tenga el enlace)
      if ((pm = /^\/internal\/share\/([A-Za-z0-9_-]{8,40})(\/audio|\/cover)?$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
        this.purgeShares();
        const f = this.one("SELECT * FROM files WHERE id=? AND kind='shr'", 'shr_' + cleanId(pm[1]));
        if (!f) return err(404, 'Este enlace ya no está disponible');
        if (!pm[2]) { let meta = {}; try { meta = JSON.parse(f.meta); } catch {} return json({ title: meta.title || 'Grabación', porchName: meta.porchName || '', duration: meta.duration || 0, exp: meta.exp || 0, created: f.created, hasCover: !!f.p_bytes, scene: meta.scene || 1 }); }
        if (pm[2] === '/cover') {
          if (!f.p_bytes) return err(404, 'Sin portada');
          const r2 = this.stream(req, f.id, 'p', f.p_bytes, f.p_mime);
          r2.headers.set('cache-control', 'public, max-age=86400');
          return r2;
        }
        const res = this.stream(req, f.id, 'a', f.a_bytes, f.a_mime);
        res.headers.set('cache-control', 'private, max-age=600');
        return res;
      }
      // Compartir en privado con un amigo: crear o quitar el enlace
      if (p === '/api/cloud/share' && m === 'POST') {
        this.purgeShares();
        const u8 = new Uint8Array(await req.arrayBuffer());
        if (!u8.length) return err(400, 'Falta el audio');
        const lim = cloudLimits();
        if (this.usage().recBytes + u8.length > lim.recBytes) return err(413, `No queda sitio para compartir más (${lim.recMin / 60} h). Deja de compartir alguna grabación.`, { full: true });
        const key = randomKey();
        const dec = (h) => { try { return decodeURIComponent(req.headers.get(h) || ''); } catch { return ''; } };
        const exp = now() + SHARE_DAYS * 86400_000;
        const meta = JSON.stringify({ title: dec('x-title').slice(0, 120), porchName: dec('x-porch').slice(0, 60), duration: Number(req.headers.get('x-duration')) || 0, scene: Number(req.headers.get('x-scene')) || 1, exp });
        const id = 'shr_' + key;
        for (let i = 0, seq = 0; i < u8.length; i += CHUNK, seq++) this.run('INSERT INTO chunks (fid, part, seq, data) VALUES (?,?,?,?)', id, 'a', seq, u8.slice(i, i + CHUNK).buffer);
        this.run("INSERT INTO files (id, kind, meta, a_bytes, a_mime, created, updated) VALUES (?, 'shr', ?, ?, ?, ?, ?)", id, meta, u8.length, String(req.headers.get('content-type') || 'audio/webm').slice(0, 80), now(), now());
        return json({ key, exp });
      }
      // Portada de la grabación compartida (para que el enlace se vea con su foto y su título)
      if ((pm = /^\/api\/cloud\/share\/([A-Za-z0-9_-]{8,40})\/cover$/.exec(p)) && m === 'POST') {
        const id = 'shr_' + cleanId(pm[1]);
        if (!this.one("SELECT id FROM files WHERE id=? AND kind='shr'", id)) return err(404, 'No existe');
        const u8 = new Uint8Array(await req.arrayBuffer());
        const isImg = u8.length > 12 && ((u8[0] === 0xff && u8[1] === 0xd8) || (u8[0] === 0x52 && u8[8] === 0x57));
        if (!isImg || u8.length > 600 * 1024) return err(400, 'La portada debe ser JPEG o WebP de menos de 600 KB');
        this.run("DELETE FROM chunks WHERE fid=? AND part='p'", id);
        for (let i = 0, seq = 0; i < u8.length; i += CHUNK, seq++) this.run("INSERT INTO chunks (fid, part, seq, data) VALUES (?, 'p', ?, ?)", id, seq, u8.slice(i, i + CHUNK).buffer);
        this.run('UPDATE files SET p_bytes=?, p_mime=?, updated=? WHERE id=?', u8.length, u8[0] === 0xff ? 'image/jpeg' : 'image/webp', now(), id);
        return json({ ok: true });
      }
      if ((pm = /^\/api\/cloud\/share\/([A-Za-z0-9_-]{8,40})\/delete$/.exec(p)) && m === 'POST') {
        const id = 'shr_' + cleanId(pm[1]);
        this.run('DELETE FROM chunks WHERE fid=?', id); this.run("DELETE FROM files WHERE id=? AND kind='shr'", id);
        return json({ ok: true });
      }
      // Todo: lista + espacio usado
      if (p === '/api/cloud' && m === 'GET') {
        return json({ files: this.all("SELECT * FROM files WHERE kind IN ('rec','snd','del') ORDER BY created DESC").map((f) => this.out(f)), usage: this.usage(), limits: cloudLimits() });
      }
      // Preferencias del Estudio (favoritos, sonido de entrada…)
      if (p === '/api/cloud/prefs') {
        if (m === 'GET') {
          const out = {};
          for (const r of this.all('SELECT k, v FROM prefs')) { try { out[r.k] = JSON.parse(r.v); } catch {} }
          return json({ prefs: out });
        }
        if (m === 'POST') {
          const b = await req.json().catch(() => null);
          if (!b || typeof b !== 'object') return err(400, 'Datos no válidos');
          for (const [k, v] of Object.entries(b)) {
            if (!/^[a-z][a-z0-9_]{0,30}$/i.test(k)) continue;
            const s = JSON.stringify(v ?? null);
            if (s.length > MAX_PREFS) return err(413, 'Demasiados datos');
            if (v === null) this.run('DELETE FROM prefs WHERE k=?', k);
            else this.run('INSERT INTO prefs (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, s);
          }
          return json({ ok: true });
        }
      }
      // Borrar todo (cuando se borra la identidad)
      if (p === '/api/cloud/wipe' && m === 'POST') {
        this.run("DELETE FROM chunks WHERE fid NOT LIKE 'pod\_%' ESCAPE '\\'"); this.run("DELETE FROM files WHERE kind != 'pod'"); this.run('DELETE FROM prefs');
        return json({ ok: true });
      }

      let mm;
      // Crear o actualizar los datos de un archivo
      if ((mm = /^\/api\/cloud\/([A-Za-z0-9_-]{4,40})\/meta$/.exec(p)) && m === 'POST') {
        const id = cleanId(mm[1]);
        const b = await req.json().catch(() => null);
        if (!b || !KINDS.has(b.kind)) return err(400, 'Datos no válidos');
        const meta = JSON.stringify(b.meta || {});
        if (meta.length > MAX_META) return err(413, 'Demasiados datos');
        const ex = this.one('SELECT id, kind FROM files WHERE id=?', id);
        if (ex && ex.kind !== b.kind) return err(400, 'Datos no válidos');
        if (ex) this.run('UPDATE files SET meta=?, updated=? WHERE id=?', meta, now(), id);
        else this.run('INSERT INTO files (id, kind, meta, created, updated) VALUES (?,?,?,?,?)', id, b.kind, meta, now(), now());
        return json({ ok: true });
      }
      // Subir el audio (a) o la foto (p) de un archivo
      if ((mm = /^\/api\/cloud\/([A-Za-z0-9_-]{4,40})\/(a|p)$/.exec(p)) && m === 'POST') {
        const id = cleanId(mm[1]), part = mm[2];
        const f = this.one('SELECT * FROM files WHERE id=?', id);
        if (!f) return err(404, 'No existe');
        const u8 = new Uint8Array(await req.arrayBuffer());
        const lim = cloudLimits();
        const use = this.usage();
        const prev = part === 'a' ? f.a_bytes : f.p_bytes;
        const used = (f.kind === 'rec' ? use.recBytes : use.sndBytes) - prev;
        const max = f.kind === 'rec' ? lim.recBytes : lim.sndBytes;
        if (used + u8.length > max) return err(413, f.kind === 'rec' ? `Tu espacio de grabaciones está lleno (${lim.recMin / 60} h). Publica o borra alguna.` : `Tu espacio de sonidos está lleno (${lim.sndMB} MB). Borra alguno.`, { full: true });
        const mime = String(req.headers.get('content-type') || '').slice(0, 80);
        this.run('DELETE FROM chunks WHERE fid=? AND part=?', id, part);
        for (let i = 0, seq = 0; i < u8.length; i += CHUNK, seq++) this.run('INSERT INTO chunks (fid, part, seq, data) VALUES (?,?,?,?)', id, part, seq, u8.slice(i, i + CHUNK).buffer);
        if (part === 'a') this.run('UPDATE files SET a_bytes=?, a_mime=?, updated=? WHERE id=?', u8.length, mime, now(), id);
        else this.run('UPDATE files SET p_bytes=?, p_mime=?, updated=? WHERE id=?', u8.length, mime, now(), id);
        return json({ ok: true, usage: this.usage() });
      }
      // Descargar
      if ((mm = /^\/api\/cloud\/([A-Za-z0-9_-]{4,40})\/(a|p)$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
        const f = this.one('SELECT * FROM files WHERE id=?', cleanId(mm[1]));
        const part = mm[2];
        const total = f ? (part === 'a' ? f.a_bytes : f.p_bytes) : 0;
        if (!f || !total) return err(404, 'No existe');
        return this.stream(req, f.id, part, total, part === 'a' ? f.a_mime : f.p_mime);
      }
      // Quitar la foto
      if ((mm = /^\/api\/cloud\/([A-Za-z0-9_-]{4,40})\/p\/delete$/.exec(p)) && m === 'POST') {
        const id = cleanId(mm[1]);
        this.run("DELETE FROM chunks WHERE fid=? AND part='p'", id);
        this.run("UPDATE files SET p_bytes=0, p_mime='', updated=? WHERE id=?", now(), id);
        return json({ ok: true });
      }
      // Borrar
      if ((mm = /^\/api\/cloud\/([A-Za-z0-9_-]{4,40})\/delete$/.exec(p)) && m === 'POST') {
        const id = cleanId(mm[1]);
        this.run('DELETE FROM chunks WHERE fid=?', id);
        this.run('DELETE FROM files WHERE id=?', id);
        return json({ ok: true, usage: this.usage() });
      }
      return err(404, 'No encontrado');
    } catch (e) {
      return err(500, 'Error en tu espacio: ' + (e?.message || e));
    }
  }
}
