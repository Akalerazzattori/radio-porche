// Hub: Durable Object central con SQLite. Identidades, porches, podcasts publicados
// (troceados en filas ≤ 2 MB), comentarios, me gusta, escuchas, reportes, límites,
// biblioteca "de serie", panel de administración y registro de acciones.
import { DurableObject } from 'cloudflare:workers';
import { LIMITS, LEGAL, REPORT_REASONS, SERIOUS_REASONS, DEFAULT_BADWORDS, ZONES } from '../public/js/config.js';
import {
  json, err, b64u, unb64u, randomId, safeEqual, sha256, hmac,
  cleanText, cleanName, cleanInt, cleanNum, cleanId, slugify, filterChat, now,
} from './lib/util.js';
import { sniffAudio, sniffLibraryAudio, sniffImage, audioDuration } from './lib/media.js';

const CHUNK = 1900 * 1024; // < 2 MB por fila
const HOUR = 3600, DAY = 86400;
const REASON_IDS = new Set(REPORT_REASONS.map((r) => r.id));
const KINDS = new Set(['podcast', 'comment', 'chat', 'porch', 'identity']);

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  // ------------------------------------------------------------ esquema
  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS identities (
        device_id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL,
        tv INTEGER NOT NULL DEFAULT 1, blocked INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
        terms TEXT);
      CREATE TABLE IF NOT EXISTS porches (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        freq REAL NOT NULL UNIQUE, description TEXT DEFAULT '', next_show TEXT DEFAULT '', next_ts INTEGER DEFAULT 0,
        mod_key TEXT NOT NULL, has_cover INTEGER DEFAULT 0, scene INTEGER DEFAULT 1, hidden INTEGER DEFAULT 0,
        live INTEGER DEFAULT 0, live_mode TEXT DEFAULT '', live_title TEXT DEFAULT '', live_since INTEGER DEFAULT 0,
        listeners INTEGER DEFAULT 0, mics INTEGER DEFAULT 0, waiting INTEGER DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS podcasts (
        id TEXT PRIMARY KEY, porch_id TEXT NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT DEFAULT '', chapters TEXT DEFAULT '[]', created INTEGER NOT NULL, duration REAL NOT NULL,
        bytes INTEGER NOT NULL, mime TEXT NOT NULL, cover_mime TEXT DEFAULT '', scene INTEGER DEFAULT 1,
        part INTEGER DEFAULT 1, prev_id TEXT DEFAULT '', series TEXT DEFAULT '',
        listens INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS podcasts_owner ON podcasts(owner);
      CREATE INDEX IF NOT EXISTS podcasts_porch ON podcasts(porch_id);
      CREATE TABLE IF NOT EXISTS chunks (pid TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY (pid, kind, seq));
      CREATE TABLE IF NOT EXISTS likes (pid TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY (pid, device));
      CREATE TABLE IF NOT EXISTS listens (pid TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY (pid, device));
      CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL, device TEXT NOT NULL,
        name TEXT NOT NULL, t REAL NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, hidden INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS comments_pid ON comments(pid);
      CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, obj TEXT NOT NULL,
        target TEXT DEFAULT '', reporter TEXT NOT NULL, reason TEXT NOT NULL, snapshot TEXT DEFAULT '',
        created INTEGER NOT NULL, resolved INTEGER DEFAULT 0, UNIQUE (kind, obj, reporter));
      CREATE TABLE IF NOT EXISTS follows (device TEXT NOT NULL, porch_id TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY (device, porch_id));
      CREATE TABLE IF NOT EXISTS porch_bans (porch_id TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY (porch_id, device));
      CREATE TABLE IF NOT EXISTS rl (key TEXT PRIMARY KEY, exp INTEGER NOT NULL, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS library (id TEXT PRIMARY KEY, zone TEXT NOT NULL, name TEXT NOT NULL, section TEXT DEFAULT '',
        mime TEXT NOT NULL, bytes INTEGER NOT NULL, duration REAL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT);
    `);
  }

  one(q, ...a) { const r = this.sql.exec(q, ...a).toArray(); return r[0] || null; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  run(q, ...a) { this.sql.exec(q, ...a); }
  kvGet(k, d = null) { const r = this.one('SELECT v FROM kv WHERE k=?', k); return r ? r.v : d; }
  kvSet(k, v) { this.run('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v)); }
  audit(action, detail = '') { this.run('INSERT INTO audit (ts,action,detail) VALUES (?,?,?)', now(), action, String(detail).slice(0, 500)); }

  secret() {
    let s = this.kvGet('secret');
    if (!s) { s = randomId(32); this.kvSet('secret', s); }
    return s;
  }
  settings() {
    return {
      pausePublish: this.kvGet('pausePublish') === '1',
      pausePorches: this.kvGet('pausePorches') === '1',
      badwords: JSON.parse(this.kvGet('badwords', JSON.stringify(DEFAULT_BADWORDS))),
    };
  }

  async alarm() {
    const t = Math.floor(Date.now() / 1000);
    this.run('DELETE FROM rl WHERE exp < ?', t);
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
  }

  // ------------------------------------------------------------ límites
  /** Ventana fija. Devuelve true si se permite (y cuenta si consume). Sin histórico de IP. */
  limit(key, windowSec, max, consume = true) {
    const t = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(t / windowSec);
    const k = `${key}:${windowSec}:${bucket}`;
    const row = this.one('SELECT n FROM rl WHERE key=?', k);
    const n = row ? row.n : 0;
    if (n >= max) return false;
    if (consume) {
      this.run('INSERT INTO rl (key,exp,n) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET n=n+1', k, (bucket + 1) * windowSec);
    }
    return true;
  }

  // ------------------------------------------------------------ identidad
  async signToken(deviceId, tv) {
    const payload = b64u(new TextEncoder().encode(JSON.stringify({ d: deviceId, v: tv, i: Math.floor(Date.now() / 1000) })));
    return payload + '.' + (await hmac(this.secret(), payload));
  }
  async verifyToken(token) {
    if (typeof token !== 'string' || token.length > 400) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const good = await hmac(this.secret(), payload);
    if (!safeEqual(good, sig)) return null;
    let data;
    try { data = JSON.parse(new TextDecoder().decode(unb64u(payload))); } catch { return null; }
    const ident = this.one('SELECT * FROM identities WHERE device_id=?', String(data.d));
    if (!ident || ident.tv !== data.v) return null;
    return ident;
  }
  async auth(req) {
    const h = req.headers.get('authorization') || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    return t ? this.verifyToken(t) : null;
  }
  isNew(ident) { return now() - ident.created < LIMITS.NEW_IDENTITY_HOURS * 3600_000; }

  async turnstile(token, ip) {
    const secret = this.env.TURNSTILE_SECRET;
    if (!secret) return true; // sin clave configurada: no se bloquea
    if (typeof token !== 'string' || !token) return false;
    try {
      const fd = new FormData();
      fd.append('secret', secret);
      fd.append('response', token);
      if (ip) fd.append('remoteip', ip);
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd });
      const d = await r.json();
      return !!d.success;
    } catch { return false; }
  }

  async isAdmin(req, url) {
    const key = req.headers.get('x-admin-key') || url.searchParams.get('k') || '';
    if (!key || key.length > 200) return false;
    if (this.env.ADMIN_KEY && safeEqual(key, this.env.ADMIN_KEY)) return true;
    const h = this.kvGet('adminHash');
    if (!h) return false;
    return safeEqual(await sha256(key), h);
  }

  pickFreq() {
    const used = new Set(this.all('SELECT freq FROM porches').map((r) => Math.round(r.freq * 10)));
    const free = [];
    for (let f = 881; f <= 1079; f += 2) if (!used.has(f)) free.push(f);
    if (!free.length) for (let f = 880; f <= 1080; f++) if (!used.has(f)) free.push(f);
    if (!free.length) return null;
    return free[Math.floor(Math.random() * free.length)] / 10;
  }

  createPorch(ident) {
    const freq = this.pickFreq();
    if (freq == null) return null;
    const id = randomId(6);
    const name = `Porche de ${ident.name}`.slice(0, LIMITS.PORCH_NAME_MAX);
    let slug = slugify(name);
    if (this.one('SELECT 1 FROM porches WHERE slug=?', slug)) slug = `${slug}-${randomId(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    this.run(
      'INSERT INTO porches (id,owner,name,slug,freq,mod_key,scene,created) VALUES (?,?,?,?,?,?,?,?)',
      id, ident.device_id, name, slug, freq, randomId(16), 1 + Math.floor(Math.random() * 4), now(),
    );
    return this.one('SELECT * FROM porches WHERE id=?', id);
  }

  porchPublic(p, viewer = null) {
    if (!p) return null;
    const owner = this.one('SELECT name FROM identities WHERE device_id=?', p.owner);
    const pub = {
      id: p.id, name: p.name, slug: p.slug, freq: p.freq, description: p.description,
      nextShow: p.next_show, nextTs: p.next_ts, hasCover: !!p.has_cover, scene: p.scene,
      owner: p.owner, ownerName: owner ? owner.name : '',
      live: !!p.live && p.live_mode !== 'ensayo', liveMode: p.live_mode === 'ensayo' ? '' : p.live_mode,
      liveTitle: p.live_title, liveSince: p.live_since, listeners: p.listeners, mics: p.mics, waiting: p.waiting,
      followers: this.one('SELECT COUNT(*) AS n FROM follows WHERE porch_id=?', p.id).n,
      podcasts: this.one('SELECT COUNT(*) AS n FROM podcasts WHERE porch_id=? AND hidden=0', p.id).n,
      hidden: !!p.hidden,
    };
    if (viewer) pub.following = !!this.one('SELECT 1 FROM follows WHERE device=? AND porch_id=?', viewer, p.id);
    return pub;
  }

  podcastPublic(r, viewer = null) {
    const porch = this.one('SELECT name, slug, freq FROM porches WHERE id=?', r.porch_id);
    const o = {
      id: r.id, porchId: r.porch_id, porchName: porch ? porch.name : '', porchSlug: porch ? porch.slug : '',
      title: r.title, description: r.description, chapters: JSON.parse(r.chapters || '[]'),
      created: r.created, duration: r.duration, bytes: r.bytes, mime: r.mime, hasCover: !!r.cover_mime, scene: r.scene,
      part: r.part, prevId: r.prev_id, series: r.series, listens: r.listens, likes: r.likes, comments: r.comments,
      hidden: !!r.hidden, owner: r.owner,
    };
    if (viewer) o.liked = !!this.one('SELECT 1 FROM likes WHERE pid=? AND device=?', r.id, viewer);
    const next = this.one('SELECT id FROM podcasts WHERE prev_id=? AND hidden=0', r.id);
    o.nextId = next ? next.id : '';
    return o;
  }

  storageUsed() {
    const a = this.one('SELECT COALESCE(SUM(bytes),0) AS n FROM podcasts').n;
    const b = this.one('SELECT COALESCE(SUM(bytes),0) AS n FROM library').n;
    return a + b;
  }

  // ------------------------------------------------------------ trozos
  putBlob(pid, kind, u8) {
    this.run('DELETE FROM chunks WHERE pid=? AND kind=?', pid, kind);
    for (let i = 0, seq = 0; i < u8.length; i += CHUNK, seq++) {
      this.run('INSERT INTO chunks (pid,kind,seq,data) VALUES (?,?,?,?)', pid, kind, seq, u8.slice(i, i + CHUNK).buffer);
    }
  }
  getChunk(pid, kind, seq) {
    const r = this.one('SELECT data FROM chunks WHERE pid=? AND kind=? AND seq=?', pid, kind, seq);
    return r ? new Uint8Array(r.data) : null;
  }
  streamBlob(req, pid, kind, total, mime, extraHeaders = {}) {
    const range = req.headers.get('range');
    let start = 0, end = total - 1, status = 200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m) return new Response('Rango no válido', { status: 416, headers: { 'content-range': `bytes */${total}` } });
      if (m[1] === '') { start = Math.max(0, total - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(total - 1, Number(m[2])); }
      if (start > end || start >= total) return new Response('', { status: 416, headers: { 'content-range': `bytes */${total}` } });
      status = 206;
    }
    let seq = Math.floor(start / CHUNK);
    let pos = start;
    const hub = this;
    const body = new ReadableStream({
      pull(c) {
        if (pos > end) { c.close(); return; }
        const data = hub.getChunk(pid, kind, seq);
        if (!data) { c.close(); return; }
        const base = seq * CHUNK;
        const from = pos - base;
        const to = Math.min(data.length, end - base + 1);
        c.enqueue(data.subarray(from, to));
        pos = base + to;
        seq++;
      },
    });
    const headers = {
      'content-type': mime, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...extraHeaders,
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`;
    return new Response(body, { status, headers });
  }

  // ------------------------------------------------------------ router
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const ip = req.headers.get('x-rp-ip') || '0.0.0.0';
    const m = req.method;
    try {
      if (p.startsWith('/internal/')) return await this.internal(req, url, ip);
      if (p.startsWith('/api/admin')) return await this.admin(req, url, ip);

      if (p === '/api/config' && m === 'GET') {
        const s = this.settings();
        return json({
          turnstileSiteKey: this.env.TURNSTILE_SITEKEY || '', termsVersion: LEGAL.TERMS_VERSION,
          pausePublish: s.pausePublish, pausePorches: s.pausePorches,
        });
      }
      if (p === '/api/stats' && m === 'GET') {
        return json({
          live: this.one("SELECT COUNT(*) AS n FROM porches WHERE live=1 AND live_mode!='ensayo' AND hidden=0").n,
          podcasts: this.one('SELECT COUNT(*) AS n FROM podcasts WHERE hidden=0').n,
        });
      }
      if (p === '/api/identity' && m === 'POST') return await this.createIdentity(req, ip);

      // --- lectura pública
      if (p === '/api/porches' && m === 'GET') {
        const ident = await this.auth(req);
        const rows = this.all('SELECT * FROM porches WHERE hidden=0 ORDER BY freq LIMIT 300');
        return json({ porches: rows.map((r) => this.porchPublic(r, ident?.device_id)) });
      }
      let mm;
      if ((mm = /^\/api\/porch\/([A-Za-z0-9_-]+)$/.exec(p)) && m === 'GET') {
        const ident = await this.auth(req);
        const r = this.one('SELECT * FROM porches WHERE id=? OR slug=?', mm[1], mm[1]);
        if (!r || (r.hidden && r.owner !== ident?.device_id)) return err(404, 'Este porche no existe');
        return json({ porch: this.porchPublic(r, ident?.device_id) });
      }
      if ((mm = /^\/api\/porch\/([A-Za-z0-9_-]+)\/cover$/.exec(p)) && m === 'GET') {
        const r = this.one('SELECT id, has_cover FROM porches WHERE id=?', mm[1]);
        const d = r && r.has_cover ? this.getChunk(r.id, 'p', 0) : null;
        if (!d) return err(404, 'Sin portada');
        return new Response(d, { headers: { 'content-type': sniffImage(d) || 'image/jpeg', 'cache-control': 'public, max-age=300' } });
      }
      if (p === '/api/podcasts' && m === 'GET') return await this.listPodcasts(req, url);
      if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)$/.exec(p)) && m === 'GET') {
        const ident = await this.auth(req);
        const r = this.one('SELECT * FROM podcasts WHERE id=?', mm[1]);
        if (!r || (r.hidden && r.owner !== ident?.device_id)) return err(404, 'Este podcast no existe o se ha retirado');
        return json({ podcast: this.podcastPublic(r, ident?.device_id) });
      }
      if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)\/audio$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
        const r = this.one('SELECT * FROM podcasts WHERE id=?', mm[1]);
        if (!r || (r.hidden && !(await this.isAdmin(req, url)))) return err(404, 'No disponible');
        const ext = r.mime === 'audio/mp4' ? 'm4a' : r.mime === 'audio/ogg' ? 'ogg' : 'webm';
        const extra = { 'cache-control': 'public, max-age=3600' };
        if (url.searchParams.get('dl') === '1') {
          extra['content-disposition'] = `attachment; filename="${slugify(r.title)}.${ext}"`;
        }
        return this.streamBlob(req, r.id, 'a', r.bytes, r.mime, extra);
      }
      if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)\/cover$/.exec(p)) && m === 'GET') {
        const r = this.one('SELECT id, cover_mime, hidden FROM podcasts WHERE id=?', mm[1]);
        if (!r || !r.cover_mime) return err(404, 'Sin portada');
        const d = this.getChunk(r.id, 'c', 0);
        return new Response(d, { headers: { 'content-type': r.cover_mime, 'cache-control': 'public, max-age=86400' } });
      }
      if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)\/comments$/.exec(p)) && m === 'GET') {
        const ident = await this.auth(req);
        const rows = this.all('SELECT id, device, name, t, text, created, hidden FROM comments WHERE pid=? ORDER BY t LIMIT 500', mm[1]);
        return json({
          comments: rows
            .filter((c) => !c.hidden || c.device === ident?.device_id)
            .map((c) => ({ id: c.id, device: c.device, name: c.name, t: c.t, text: c.text, created: c.created, hidden: !!c.hidden })),
        });
      }
      if (p === '/api/library' && m === 'GET') {
        return json({ items: this.all('SELECT id, zone, name, section, mime, bytes, duration, created FROM library ORDER BY zone, section, name') });
      }
      if ((mm = /^\/api\/library\/([A-Za-z0-9_-]+)\/audio$/.exec(p)) && m === 'GET') {
        const r = this.one('SELECT * FROM library WHERE id=?', mm[1]);
        if (!r) return err(404, 'No existe');
        return this.streamBlob(req, r.id, 'l', r.bytes, r.mime, { 'cache-control': 'public, max-age=86400' });
      }

      // --- a partir de aquí, todo exige token
      const ident = await this.auth(req);
      if (!ident) return err(401, 'Necesitas entrar con tu nombre');
      if (ident.blocked) return err(403, 'Este dispositivo está bloqueado');
      return await this.authed(req, url, ip, ident);
    } catch (e) {
      console.error(e);
      return err(500, 'Algo ha fallado. Inténtalo de nuevo.');
    }
  }

  async createIdentity(req, ip) {
    if (!this.limit(`id:ip:${ip}`, HOUR, LIMITS.IDENTITIES_PER_HOUR_IP)) return err(429, 'Demasiados intentos. Prueba dentro de un rato.');
    const body = await req.json().catch(() => ({}));
    const name = cleanName(body.name);
    if (!name) return err(400, `El nombre debe tener entre ${LIMITS.NAME_MIN} y ${LIMITS.NAME_MAX} caracteres (letras, números, espacios y . _ - ').`);
    if (body.adult !== true) return err(400, 'Radio Porche es solo para mayores de 18 años.');
    if (body.terms !== LEGAL.TERMS_VERSION) return err(400, 'Acepta las condiciones para continuar.');
    if (!(await this.turnstile(body.turnstile, ip))) return err(403, 'No hemos podido comprobar que eres una persona.');
    const deviceId = randomId(16);
    this.run('INSERT INTO identities (device_id,name,created,terms) VALUES (?,?,?,?)', deviceId, name, now(), LEGAL.TERMS_VERSION);
    const ident = this.one('SELECT * FROM identities WHERE device_id=?', deviceId);
    const porch = this.settings().pausePorches ? null : this.createPorch(ident);
    return json({ token: await this.signToken(deviceId, ident.tv), deviceId, name, porch: this.porchPublic(porch, deviceId) });
  }

  async listPodcasts(req, url) {
    const ident = await this.auth(req);
    const sort = url.searchParams.get('sort') === 'top' ? 'top' : 'new';
    const q = cleanText(url.searchParams.get('q') || '', 60);
    const porch = cleanId(url.searchParams.get('porch') || '');
    const limit = cleanInt(url.searchParams.get('limit'), 1, 50, 30);
    const offset = cleanInt(url.searchParams.get('offset'), 0, 10000, 0);
    const where = ['p.hidden=0'];
    const args = [];
    if (q) { where.push('(p.title LIKE ? OR h.name LIKE ? OR p.description LIKE ?)'); const l = `%${q.replace(/[%_]/g, '')}%`; args.push(l, l, l); }
    if (porch) { where.push('p.porch_id=?'); args.push(porch); }
    const order = sort === 'top' ? 'p.listens DESC, p.likes DESC, p.created DESC' : 'p.created DESC';
    const rows = this.all(
      `SELECT p.* FROM podcasts p LEFT JOIN porches h ON h.id=p.porch_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...args, limit, offset,
    );
    return json({ podcasts: rows.map((r) => this.podcastPublic(r, ident?.device_id)) });
  }

  // ------------------------------------------------------------ con token
  async authed(req, url, ip, ident) {
    const p = url.pathname, m = req.method, me = ident.device_id;
    let mm;

    if (p === '/api/me' && m === 'GET') {
      const porch = this.one('SELECT * FROM porches WHERE owner=?', me);
      const following = this.all('SELECT porch_id FROM follows WHERE device=?', me).map((r) => r.porch_id);
      return json({
        deviceId: me, name: ident.name, created: ident.created, terms: ident.terms, isNew: this.isNew(ident),
        porch: this.porchPublic(porch, me), modKey: porch ? porch.mod_key : null, following,
      });
    }
    if (p === '/api/me/name' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      const name = cleanName(b.name);
      if (!name) return err(400, 'Nombre no válido');
      this.run('UPDATE identities SET name=? WHERE device_id=?', name, me);
      return json({ ok: true, name });
    }
    if (p === '/api/me/terms' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (b.terms !== LEGAL.TERMS_VERSION) return err(400, 'Versión no válida');
      this.run('UPDATE identities SET terms=? WHERE device_id=?', LEGAL.TERMS_VERSION, me);
      return json({ ok: true });
    }
    if (p === '/api/me/export' && m === 'GET') return json(this.exportData(ident));
    if (p === '/api/me/delete' && m === 'POST') {
      this.deleteAll(me);
      return json({ ok: true });
    }
    if (p === '/api/porch/create' && m === 'POST') {
      if (this.settings().pausePorches) return err(503, 'La creación de porches nuevos está en pausa ahora mismo.');
      const ex = this.one('SELECT * FROM porches WHERE owner=?', me);
      if (ex) return json({ porch: this.porchPublic(ex, me) });
      const pr = this.createPorch(ident);
      if (!pr) return err(503, 'No quedan frecuencias libres');
      return json({ porch: this.porchPublic(pr, me) });
    }
    if (p === '/api/porch/update' && m === 'POST') {
      const pr = this.one('SELECT * FROM porches WHERE owner=?', me);
      if (!pr) return err(404, 'No tienes porche');
      const b = await req.json().catch(() => ({}));
      const name = cleanText(b.name ?? pr.name, LIMITS.PORCH_NAME_MAX) || pr.name;
      const description = cleanText(b.description ?? pr.description, LIMITS.DESC_MAX, { multiline: true });
      const nextShow = cleanText(b.nextShow ?? pr.next_show, LIMITS.NEXT_SHOW_MAX);
      const nextTs = cleanInt(b.nextTs ?? pr.next_ts, 0, 4102444800000, 0);
      const scene = cleanInt(b.scene ?? pr.scene, 1, 4, 1);
      this.run('UPDATE porches SET name=?, description=?, next_show=?, next_ts=?, scene=? WHERE id=?', name, description, nextShow, nextTs, scene, pr.id);
      return json({ porch: this.porchPublic(this.one('SELECT * FROM porches WHERE id=?', pr.id), me) });
    }
    if (p === '/api/porch/cover' && m === 'POST') {
      const pr = this.one('SELECT * FROM porches WHERE owner=?', me);
      if (!pr) return err(404, 'No tienes porche');
      const u8 = new Uint8Array(await req.arrayBuffer());
      if (u8.length === 0) { this.run('UPDATE porches SET has_cover=0 WHERE id=?', pr.id); this.run("DELETE FROM chunks WHERE pid=? AND kind='p'", pr.id); return json({ ok: true }); }
      if (u8.length > LIMITS.COVER_MAX_BYTES || !sniffImage(u8)) return err(400, 'La portada debe ser JPEG o WebP de menos de 500 KB');
      this.putBlob(pr.id, 'p', u8);
      this.run('UPDATE porches SET has_cover=1 WHERE id=?', pr.id);
      return json({ ok: true });
    }
    if (p === '/api/porch/modkey' && m === 'POST') {
      const pr = this.one('SELECT * FROM porches WHERE owner=?', me);
      if (!pr) return err(404, 'No tienes porche');
      const k = randomId(16);
      this.run('UPDATE porches SET mod_key=? WHERE id=?', k, pr.id);
      return json({ modKey: k });
    }
    if (p === '/api/follow' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      const pid = cleanId(b.porchId);
      if (!pid || !this.one('SELECT 1 FROM porches WHERE id=?', pid)) return err(404, 'Porche no encontrado');
      if (b.on) this.run('INSERT OR IGNORE INTO follows (device,porch_id,created) VALUES (?,?,?)', me, pid, now());
      else this.run('DELETE FROM follows WHERE device=? AND porch_id=?', me, pid);
      return json({ ok: true, on: !!b.on });
    }
    if (p === '/api/notices' && m === 'GET') return json(this.notices(me));
    if (p === '/api/mine' && m === 'GET') {
      const rows = this.all('SELECT * FROM podcasts WHERE owner=? ORDER BY created DESC', me);
      return json({ podcasts: rows.map((r) => this.podcastPublic(r, me)), used: rows.reduce((a, r) => a + r.bytes, 0), cap: LIMITS.PORCH_MAX_BYTES });
    }
    if (p === '/api/podcasts' && m === 'POST') return await this.publish(req, ip, ident);
    if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)\/edit$/.exec(p)) && m === 'POST') {
      const r = this.one('SELECT * FROM podcasts WHERE id=? AND owner=?', mm[1], me);
      if (!r) return err(404, 'No es tuyo o no existe');
      const b = await req.json().catch(() => ({}));
      const title = cleanText(b.title ?? r.title, LIMITS.TITLE_MAX) || r.title;
      const description = cleanText(b.description ?? r.description, LIMITS.DESC_MAX, { multiline: true });
      const chapters = b.chapters !== undefined ? JSON.stringify(cleanChapters(b.chapters, r.duration)) : r.chapters;
      this.run('UPDATE podcasts SET title=?, description=?, chapters=? WHERE id=?', title, description, chapters, r.id);
      return json({ podcast: this.podcastPublic(this.one('SELECT * FROM podcasts WHERE id=?', r.id), me) });
    }
    if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)\/delete$/.exec(p)) && m === 'POST') {
      const r = this.one('SELECT id FROM podcasts WHERE id=? AND owner=?', mm[1], me);
      if (!r) return err(404, 'No es tuyo o no existe');
      this.deletePodcast(r.id);
      return json({ ok: true });
    }
    if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)\/like$/.exec(p)) && m === 'POST') {
      const r = this.one('SELECT id, hidden FROM podcasts WHERE id=?', mm[1]);
      if (!r || r.hidden) return err(404, 'No disponible');
      if (!this.limit(`like:${me}`, 60, 30)) return err(429, 'Más despacio');
      const b = await req.json().catch(() => ({}));
      if (b.on) this.run('INSERT OR IGNORE INTO likes (pid,device) VALUES (?,?)', r.id, me);
      else this.run('DELETE FROM likes WHERE pid=? AND device=?', r.id, me);
      const n = this.one('SELECT COUNT(*) AS n FROM likes WHERE pid=?', r.id).n;
      this.run('UPDATE podcasts SET likes=? WHERE id=?', n, r.id);
      return json({ likes: n, liked: !!b.on });
    }
    if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)\/listen$/.exec(p)) && m === 'POST') {
      const r = this.one('SELECT id, owner FROM podcasts WHERE id=?', mm[1]);
      if (!r) return err(404, 'No disponible');
      if (r.owner !== me && this.limit(`listen:ip:${ip}`, HOUR, 60)) {
        this.run('INSERT OR IGNORE INTO listens (pid,device) VALUES (?,?)', r.id, me);
        const n = this.one('SELECT COUNT(*) AS n FROM listens WHERE pid=?', r.id).n;
        this.run('UPDATE podcasts SET listens=? WHERE id=?', n, r.id);
      }
      return json({ ok: true });
    }
    if ((mm = /^\/api\/podcasts\/([A-Za-z0-9_-]+)\/comments$/.exec(p)) && m === 'POST') {
      const r = this.one('SELECT id, hidden, duration FROM podcasts WHERE id=?', mm[1]);
      if (!r || r.hidden) return err(404, 'No disponible');
      if (!this.limit(`cm:${me}`, 60, this.isNew(ident) ? 3 : LIMITS.COMMENTS_PER_MIN) || !this.limit(`cm:ip:${ip}`, 60, 20)) {
        return err(429, 'Vas muy rápido. Espera un poco.');
      }
      const b = await req.json().catch(() => ({}));
      let text = cleanText(b.text, LIMITS.COMMENT_MAX);
      if (!text) return err(400, 'Escribe algo');
      text = filterChat(text, this.settings().badwords).text;
      const t = cleanNum(b.t, 0, r.duration, 0);
      this.run('INSERT INTO comments (pid,device,name,t,text,created) VALUES (?,?,?,?,?,?)', r.id, me, ident.name, t, text, now());
      this.run('UPDATE podcasts SET comments=(SELECT COUNT(*) FROM comments WHERE pid=? AND hidden=0) WHERE id=?', r.id, r.id);
      return json({ ok: true });
    }
    if (p === '/api/report' && m === 'POST') return await this.report(req, ident);
    return err(404, 'Ruta no encontrada');
  }

  // ------------------------------------------------------------ publicar
  async publish(req, ip, ident) {
    const me = ident.device_id;
    const s = this.settings();
    if (s.pausePublish) return err(503, 'Las publicaciones están en pausa ahora mismo. Guárdalo en privado y prueba más tarde.');
    const porch = this.one('SELECT * FROM porches WHERE owner=?', me);
    if (!porch) return err(400, 'Necesitas un porche para publicar');
    if (LIMITS.MAX_PUBLICADOS != null && this.one('SELECT COUNT(*) AS n FROM podcasts WHERE owner=?', me).n >= LIMITS.MAX_PUBLICADOS) {
      return err(403, 'Has llegado al máximo de podcasts publicados');
    }
    const perDay = this.isNew(ident) ? LIMITS.PUBLISH_PER_DAY_NEW : LIMITS.PUBLISH_PER_DAY;
    if (!this.limit(`pub:${me}`, DAY, perDay, false)) return err(429, `Máximo ${perDay} publicaciones al día.`);
    if (!this.limit('pub:global', HOUR, LIMITS.GLOBAL_PUBLISH_PER_HOUR, false)) return err(503, 'Mucha actividad ahora mismo. Prueba dentro de un rato.');

    const len = Number(req.headers.get('content-length') || 0);
    if (len > LIMITS.MAX_UPLOAD_BYTES + LIMITS.COVER_MAX_BYTES + 64 * 1024) return err(413, 'El archivo es demasiado grande');
    const form = await req.formData();
    if (!(await this.turnstile(form.get('turnstile'), ip))) return err(403, 'No hemos podido comprobar que eres una persona.');

    let meta = {};
    try { meta = JSON.parse(String(form.get('meta') || '{}')); } catch { meta = {}; }
    const audio = form.get('audio');
    if (!audio || typeof audio === 'string') return err(400, 'Falta el audio');
    if (audio.size > LIMITS.MAX_UPLOAD_BYTES) return err(413, 'El audio supera el tamaño máximo (~40 min)');
    const u8 = new Uint8Array(await audio.arrayBuffer());
    const mime = sniffAudio(u8);
    if (!mime) return err(400, 'Formato de audio no admitido (Opus/WebM/MP4)');
    const dur = audioDuration(u8, mime);
    if (dur == null) return err(400, 'No se ha podido comprobar la duración del audio');
    if (dur < LIMITS.MIN_PUBLISH_MIN * 60) return err(400, `Dura menos de ${LIMITS.MIN_PUBLISH_MIN} minutos. Guárdalo en privado.`);
    if (dur > LIMITS.SERVER_MAX_MIN * 60) return err(400, `Dura más de ${LIMITS.MAX_PART_MIN} minutos. Divídelo en partes.`);

    let cover = null, coverMime = '';
    const cf = form.get('cover');
    if (cf && typeof cf !== 'string' && cf.size > 0) {
      if (cf.size > LIMITS.COVER_MAX_BYTES) return err(400, 'La portada pesa demasiado');
      cover = new Uint8Array(await cf.arrayBuffer());
      coverMime = sniffImage(cover);
      if (!coverMime) return err(400, 'La portada debe ser JPEG o WebP');
    }

    const used = this.one('SELECT COALESCE(SUM(bytes),0) AS n FROM podcasts WHERE porch_id=?', porch.id).n;
    if (used + u8.length > LIMITS.PORCH_MAX_BYTES) return err(507, 'Tu porche ha llegado a su espacio máximo. Borra algún podcast antiguo.');
    if (this.storageUsed() + u8.length > LIMITS.GLOBAL_STORAGE_BYTES * 0.97) {
      this.audit('storage-full', 'publicación rechazada por espacio global');
      return err(507, 'El servidor está casi lleno. Avisa al administrador.');
    }

    const title = cleanText(meta.title, LIMITS.TITLE_MAX) || 'Programa sin título';
    const description = cleanText(meta.description, LIMITS.DESC_MAX, { multiline: true });
    const chapters = JSON.stringify(cleanChapters(meta.chapters, dur));
    const part = cleanInt(meta.part, 1, 50, 1);
    const series = cleanText(meta.series, 40);
    const scene = cleanInt(meta.scene, 1, 4, porch.scene || 1);
    let prev = cleanId(meta.prevId || '');
    if (prev && !this.one('SELECT 1 FROM podcasts WHERE id=? AND owner=?', prev, me)) prev = '';
    if (!prev && series && part > 1) {
      const r = this.one('SELECT id FROM podcasts WHERE owner=? AND series=? AND part=? ORDER BY created DESC', me, series, part - 1);
      if (r) prev = r.id;
    }

    this.limit(`pub:${me}`, DAY, perDay, true);
    this.limit('pub:global', HOUR, LIMITS.GLOBAL_PUBLISH_PER_HOUR, true);
    const id = randomId(8);
    this.putBlob(id, 'a', u8);
    if (cover) this.putBlob(id, 'c', cover);
    this.run(
      `INSERT INTO podcasts (id,porch_id,owner,title,description,chapters,created,duration,bytes,mime,cover_mime,scene,part,prev_id,series)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, porch.id, me, title, description, chapters, now(), dur, u8.length, mime, coverMime, scene, part, prev || '', series,
    );
    const total = this.storageUsed();
    if (total > LIMITS.GLOBAL_STORAGE_BYTES * LIMITS.STORAGE_WARN_RATIO) this.audit('storage-warn', `${Math.round(total / 1048576)} MB usados`);
    return json({ podcast: this.podcastPublic(this.one('SELECT * FROM podcasts WHERE id=?', id), me) });
  }

  deletePodcast(id) {
    this.run('DELETE FROM chunks WHERE pid=?', id);
    this.run('DELETE FROM likes WHERE pid=?', id);
    this.run('DELETE FROM listens WHERE pid=?', id);
    this.run('DELETE FROM comments WHERE pid=?', id);
    this.run("UPDATE podcasts SET prev_id='' WHERE prev_id=?", id);
    this.run('DELETE FROM podcasts WHERE id=?', id);
  }

  // ------------------------------------------------------------ reportes
  async report(req, ident) {
    const me = ident.device_id;
    const b = await req.json().catch(() => ({}));
    const kind = KINDS.has(b.kind) ? b.kind : null;
    const reason = REASON_IDS.has(b.reason) ? b.reason : null;
    const obj = typeof b.obj === 'string' ? b.obj.slice(0, 80) : '';
    if (!kind || !reason || !obj) return err(400, 'Reporte no válido');
    let target = '';
    if (kind === 'podcast') { const r = this.one('SELECT owner FROM podcasts WHERE id=?', obj); if (!r) return err(404, 'No existe'); target = r.owner; }
    else if (kind === 'comment') { const r = this.one('SELECT device FROM comments WHERE id=?', Number(obj)); if (!r) return err(404, 'No existe'); target = r.device; }
    else if (kind === 'porch') { const r = this.one('SELECT owner FROM porches WHERE id=?', obj); if (!r) return err(404, 'No existe'); target = r.owner; }
    else if (kind === 'identity') { target = obj; }
    else if (kind === 'chat') { target = cleanId(String(b.target || '')) || ''; }
    if (target && target === me) return err(400, 'No puedes reportar lo tuyo');
    if (this.one('SELECT 1 FROM reports WHERE kind=? AND obj=? AND reporter=?', kind, obj, me)) return json({ ok: true, already: true });
    const max = this.isNew(ident) ? LIMITS.REPORTS_PER_DAY_NEW : LIMITS.REPORTS_PER_DAY;
    if (!this.limit(`rep:${me}`, DAY, max)) return err(429, 'Has llegado al máximo de reportes de hoy');
    const snapshot = cleanText(b.snapshot, 400);
    this.run('INSERT INTO reports (kind,obj,target,reporter,reason,snapshot,created) VALUES (?,?,?,?,?,?,?)', kind, obj, target, me, reason, snapshot, now());

    // Ocultación automática: solo cuentan identidades con más de 24 h
    const cutoff = now() - LIMITS.NEW_IDENTITY_HOURS * 3600_000;
    const rows = this.all(
      `SELECT r.reason FROM reports r JOIN identities i ON i.device_id=r.reporter
       WHERE r.kind=? AND r.obj=? AND r.resolved=0 AND i.created < ?`, kind, obj, cutoff,
    );
    const serious = rows.filter((r) => SERIOUS_REASONS.includes(r.reason)).length;
    if (rows.length >= LIMITS.AUTO_HIDE_REPORTS || serious >= LIMITS.AUTO_HIDE_REPORTS_SERIOUS) {
      this.setHidden(kind, obj, 1);
      this.audit('auto-hide', `${kind}:${obj} (${rows.length} reportes)`);
    }
    return json({ ok: true });
  }

  setHidden(kind, obj, v) {
    if (kind === 'podcast') this.run('UPDATE podcasts SET hidden=? WHERE id=?', v, obj);
    else if (kind === 'comment') {
      this.run('UPDATE comments SET hidden=? WHERE id=?', v, Number(obj));
      const c = this.one('SELECT pid FROM comments WHERE id=?', Number(obj));
      if (c) this.run('UPDATE podcasts SET comments=(SELECT COUNT(*) FROM comments WHERE pid=? AND hidden=0) WHERE id=?', c.pid, c.pid);
    } else if (kind === 'porch') this.run('UPDATE porches SET hidden=? WHERE id=?', v, obj);
    else if (kind === 'identity') this.run('UPDATE identities SET flagged=? WHERE device_id=?', v, obj);
  }

  // ------------------------------------------------------------ avisos
  notices(me) {
    const items = [];
    const fol = this.all('SELECT p.* FROM follows f JOIN porches p ON p.id=f.porch_id WHERE f.device=? AND p.hidden=0', me);
    for (const p of fol) {
      if (p.live && p.live_mode !== 'ensayo') items.push({ type: 'live', porch: this.porchPublic(p), ts: p.live_since });
      else if (p.next_ts && p.next_ts > now() - 3600_000) items.push({ type: 'scheduled', porch: this.porchPublic(p), ts: p.next_ts });
      else if (p.next_show) items.push({ type: 'scheduled', porch: this.porchPublic(p), ts: 0 });
    }
    const since = now() - 14 * DAY * 1000;
    const pods = this.all(
      `SELECT p.* FROM podcasts p JOIN follows f ON f.porch_id=p.porch_id WHERE f.device=? AND p.hidden=0 AND p.created>? ORDER BY p.created DESC LIMIT 20`,
      me, since,
    );
    for (const r of pods) items.push({ type: 'podcast', podcast: this.podcastPublic(r), ts: r.created });
    const hid = this.all('SELECT id, title FROM podcasts WHERE owner=? AND hidden=1', me);
    for (const h of hid) items.push({ type: 'hidden', podcast: { id: h.id, title: h.title }, ts: now() });
    return { items };
  }

  // ------------------------------------------------------------ mis datos
  exportData(ident) {
    const me = ident.device_id;
    return {
      exportado: new Date().toISOString(),
      identidad: { id: me, nombre: ident.name, creada: new Date(ident.created).toISOString(), condiciones: ident.terms },
      porche: this.one('SELECT id,name,slug,freq,description,next_show,created FROM porches WHERE owner=?', me),
      podcasts: this.all('SELECT id,title,description,chapters,created,duration,bytes,listens,likes,hidden FROM podcasts WHERE owner=?', me),
      comentarios: this.all('SELECT pid,t,text,created FROM comments WHERE device=?', me),
      meGusta: this.all('SELECT pid FROM likes WHERE device=?', me).map((r) => r.pid),
      sigues: this.all('SELECT porch_id FROM follows WHERE device=?', me).map((r) => r.porch_id),
      reportesHechos: this.all('SELECT kind,obj,reason,created FROM reports WHERE reporter=?', me),
      nota: 'Los borradores, podcasts privados, cortes y música propios están solo en tu móvil (usa "Exportar copia").',
    };
  }

  deleteAll(me) {
    for (const r of this.all('SELECT id FROM podcasts WHERE owner=?', me)) this.deletePodcast(r.id);
    const pr = this.one('SELECT id FROM porches WHERE owner=?', me);
    if (pr) {
      this.run('DELETE FROM chunks WHERE pid=?', pr.id);
      this.run('DELETE FROM follows WHERE porch_id=?', pr.id);
      this.run('DELETE FROM porch_bans WHERE porch_id=?', pr.id);
      this.run('DELETE FROM porches WHERE id=?', pr.id);
    }
    for (const c of this.all('SELECT DISTINCT pid FROM comments WHERE device=?', me)) {
      this.run('DELETE FROM comments WHERE pid=? AND device=?', c.pid, me);
      this.run('UPDATE podcasts SET comments=(SELECT COUNT(*) FROM comments WHERE pid=? AND hidden=0) WHERE id=?', c.pid, c.pid);
    }
    for (const l of this.all('SELECT pid FROM likes WHERE device=?', me)) {
      this.run('DELETE FROM likes WHERE pid=? AND device=?', l.pid, me);
      this.run('UPDATE podcasts SET likes=(SELECT COUNT(*) FROM likes WHERE pid=?) WHERE id=?', l.pid, l.pid);
    }
    this.run('DELETE FROM listens WHERE device=?', me);
    this.run('DELETE FROM follows WHERE device=?', me);
    this.run("UPDATE reports SET reporter='anon-' || id WHERE reporter=?", me);
    this.run("UPDATE reports SET target='' WHERE target=?", me);
    this.run('DELETE FROM identities WHERE device_id=?', me);
    this.audit('delete-me', 'Una persona ha borrado todos sus datos');
  }

  // ------------------------------------------------------------ interno (solo Worker y salas)
  async internal(req, url, ip) {
    const p = url.pathname;
    if (p === '/internal/auth') {
      const b = await req.json();
      const pr = this.one('SELECT * FROM porches WHERE id=?', String(b.porchId || ''));
      if (!pr || pr.hidden) return json({ ok: false, error: 'Este porche no existe' });
      const ident = b.token ? await this.verifyToken(b.token) : null;
      const isOwner = !!ident && ident.device_id === pr.owner;
      const isMod = !isOwner && typeof b.mod === 'string' && b.mod.length > 0 && safeEqual(b.mod, pr.mod_key);
      const banned = !!ident && !!this.one('SELECT 1 FROM porch_bans WHERE porch_id=? AND device=?', pr.id, ident.device_id);
      return json({
        ok: true,
        ident: ident ? { deviceId: ident.device_id, name: ident.name, isNew: this.isNew(ident), blocked: !!ident.blocked } : null,
        isOwner, isMod, banned,
        porch: { id: pr.id, name: pr.name, freq: pr.freq, owner: pr.owner, scene: pr.scene, hasCover: !!pr.has_cover },
        badwords: this.settings().badwords,
      });
    }
    if (p === '/internal/live') {
      const b = await req.json();
      const id = String(b.porchId || '');
      this.run(
        'UPDATE porches SET live=?, live_mode=?, live_title=?, live_since=?, listeners=?, mics=?, waiting=? WHERE id=?',
        b.live ? 1 : 0, String(b.mode || '').slice(0, 10), cleanText(b.title || '', LIMITS.TITLE_MAX), cleanInt(b.since, 0, 9e15, 0),
        cleanInt(b.listeners, 0, 999, 0), cleanInt(b.mics, 0, 99, 0), cleanInt(b.waiting, 0, 999, 0), id,
      );
      return json({ ok: true });
    }
    if (p === '/internal/ban') {
      const b = await req.json();
      if (b.on === false) this.run('DELETE FROM porch_bans WHERE porch_id=? AND device=?', String(b.porchId), String(b.deviceId));
      else this.run('INSERT OR IGNORE INTO porch_bans (porch_id,device) VALUES (?,?)', String(b.porchId), String(b.deviceId));
      return json({ ok: true });
    }
    if (p === '/internal/meta') {
      const pid = url.searchParams.get('p');
      const slug = url.searchParams.get('porch');
      if (pid) {
        const r = this.one('SELECT * FROM podcasts WHERE id=? AND hidden=0', pid);
        return json({ podcast: r ? this.podcastPublic(r) : null });
      }
      if (slug) {
        const r = this.one('SELECT * FROM porches WHERE (slug=? OR id=?) AND hidden=0', slug, slug);
        return json({ porch: r ? this.porchPublic(r) : null });
      }
      return json({});
    }
    if (p === '/internal/sitemap') {
      return json({
        podcasts: this.all('SELECT id, created FROM podcasts WHERE hidden=0 ORDER BY created DESC LIMIT 2000'),
        porches: this.all('SELECT slug, created FROM porches WHERE hidden=0 LIMIT 1000'),
      });
    }
    return err(404, 'no');
  }

  // ------------------------------------------------------------ administración
  async admin(req, url, ip) {
    const p = url.pathname, m = req.method;
    if (p === '/api/admin/status' && m === 'GET') {
      return json({ claimed: !!this.kvGet('adminHash') || !!this.env.ADMIN_KEY });
    }
    if (p === '/api/admin/claim' && m === 'POST') {
      if (!this.limit(`admclaim:${ip}`, HOUR, 5)) return err(429, 'Demasiados intentos');
      if (this.kvGet('adminHash') || this.env.ADMIN_KEY) return err(403, 'El panel ya tiene dueño');
      const key = randomId(24);
      this.kvSet('adminHash', await sha256(key));
      this.audit('admin-claim', 'Panel reclamado');
      return json({ key });
    }
    if (!this.limit(`adm:${ip}`, 60, 120)) return err(429, 'Más despacio');
    if (!(await this.isAdmin(req, url))) {
      this.limit(`admfail:${ip}`, HOUR, 1000);
      return err(403, 'Clave de administración no válida');
    }

    if (p === '/api/admin/overview' && m === 'GET') {
      const reports = this.all(
        `SELECT kind, obj, MAX(target) AS target, COUNT(*) AS n, GROUP_CONCAT(DISTINCT reason) AS reasons,
                MAX(snapshot) AS snapshot, MAX(created) AS last
         FROM reports WHERE resolved=0 GROUP BY kind, obj ORDER BY last DESC LIMIT 200`,
      ).map((r) => ({ ...r, hidden: this.isHidden(r.kind, r.obj), title: this.objTitle(r.kind, r.obj) }));
      const s = this.settings();
      return json({
        reports, settings: s,
        storage: { used: this.storageUsed(), total: LIMITS.GLOBAL_STORAGE_BYTES },
        counts: {
          identities: this.one('SELECT COUNT(*) AS n FROM identities').n,
          porches: this.one('SELECT COUNT(*) AS n FROM porches').n,
          podcasts: this.one('SELECT COUNT(*) AS n FROM podcasts').n,
          live: this.one('SELECT COUNT(*) AS n FROM porches WHERE live=1').n,
        },
        blocked: this.all('SELECT device_id, name, created FROM identities WHERE blocked=1 LIMIT 200'),
        hiddenPodcasts: this.all('SELECT id, title, owner FROM podcasts WHERE hidden=1 LIMIT 200'),
        library: this.all('SELECT id, zone, name, section, bytes, duration FROM library ORDER BY zone, name'),
        audit: this.all('SELECT ts, action, detail FROM audit ORDER BY id DESC LIMIT 100'),
      });
    }
    if (p === '/api/admin/podcasts' && m === 'GET') {
      const q = cleanText(url.searchParams.get('q') || '', 60);
      const rows = this.all(
        `SELECT p.id, p.title, p.owner, p.hidden, p.created, p.duration, h.name AS porch FROM podcasts p LEFT JOIN porches h ON h.id=p.porch_id
         WHERE p.title LIKE ? ORDER BY p.created DESC LIMIT 100`, `%${q}%`,
      );
      return json({ podcasts: rows });
    }
    if (p === '/api/admin/action' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      const a = String(b.action || '');
      const kind = KINDS.has(b.kind) ? b.kind : null;
      const obj = typeof b.obj === 'string' ? b.obj.slice(0, 80) : '';
      switch (a) {
        case 'hide': case 'restore':
          if (!kind || !obj) return err(400, 'Falta objeto');
          this.setHidden(kind, obj, a === 'hide' ? 1 : 0);
          if (a === 'restore') this.run('UPDATE reports SET resolved=1 WHERE kind=? AND obj=?', kind, obj);
          break;
        case 'dismiss':
          this.run('UPDATE reports SET resolved=1 WHERE kind=? AND obj=?', kind, obj);
          break;
        case 'delete':
          if (kind === 'podcast') this.deletePodcast(obj);
          else if (kind === 'comment') this.run('DELETE FROM comments WHERE id=?', Number(obj));
          else return err(400, 'Solo podcasts o comentarios');
          this.run('UPDATE reports SET resolved=1 WHERE kind=? AND obj=?', kind, obj);
          break;
        case 'block': case 'unblock':
          this.run('UPDATE identities SET blocked=? WHERE device_id=?', a === 'block' ? 1 : 0, obj);
          if (a === 'block') for (const r of this.all('SELECT id FROM podcasts WHERE owner=?', obj)) this.setHidden('podcast', r.id, 1);
          break;
        case 'pause':
          if (typeof b.publish === 'boolean') this.kvSet('pausePublish', b.publish ? '1' : '0');
          if (typeof b.porches === 'boolean') this.kvSet('pausePorches', b.porches ? '1' : '0');
          break;
        case 'badwords': {
          const list = Array.isArray(b.words) ? b.words.map((w) => cleanText(String(w), 40).toLowerCase()).filter(Boolean).slice(0, 500) : null;
          if (!list) return err(400, 'Lista no válida');
          this.kvSet('badwords', JSON.stringify(list));
          break;
        }
        case 'library-rename': {
          const id = cleanId(obj);
          const name = cleanText(b.name, 40);
          const section = cleanText(b.section || '', 40);
          const zone = ZONES[b.zone] ? b.zone : null;
          if (!id || !name) return err(400, 'Datos no válidos');
          this.run('UPDATE library SET name=?, section=?, zone=COALESCE(?, zone) WHERE id=?', name, section, zone, id);
          break;
        }
        case 'library-delete':
          this.run('DELETE FROM chunks WHERE pid=? AND kind=?', obj, 'l');
          this.run('DELETE FROM library WHERE id=?', obj);
          break;
        case 'rotate': {
          const key = randomId(24);
          this.kvSet('adminHash', await sha256(key));
          this.audit('admin-rotate', 'Clave de administración regenerada');
          return json({ key });
        }
        default:
          return err(400, 'Acción desconocida');
      }
      this.audit(a, `${kind || ''}:${obj}`);
      return json({ ok: true });
    }
    if (p === '/api/admin/library' && m === 'POST') {
      const form = await req.formData();
      const f = form.get('file');
      if (!f || typeof f === 'string') return err(400, 'Falta archivo');
      if (f.size > LIMITS.LIBRARY_MAX_BYTES) return err(413, 'Máximo 8 MB por sonido');
      const u8 = new Uint8Array(await f.arrayBuffer());
      const mime = sniffLibraryAudio(u8);
      if (!mime) return err(400, 'Formato no admitido (MP3, M4A, WebM u Ogg)');
      const zone = ZONES[form.get('zone')] ? form.get('zone') : 'fx';
      const name = cleanText(String(form.get('name') || ''), 40) || 'Sonido';
      const section = cleanText(String(form.get('section') || ''), 40);
      const duration = cleanNum(form.get('duration'), 0, 3600, 0);
      if (this.storageUsed() + u8.length > LIMITS.GLOBAL_STORAGE_BYTES * 0.97) return err(507, 'Sin espacio');
      const id = randomId(8);
      this.putBlob(id, 'l', u8);
      this.run('INSERT INTO library (id,zone,name,section,mime,bytes,duration,created) VALUES (?,?,?,?,?,?,?,?)', id, zone, name, section, mime, u8.length, duration, now());
      this.audit('library-add', `${zone}:${name}`);
      return json({ ok: true, id });
    }
    return err(404, 'Ruta no encontrada');
  }

  isHidden(kind, obj) {
    if (kind === 'podcast') return !!this.one('SELECT hidden FROM podcasts WHERE id=?', obj)?.hidden;
    if (kind === 'comment') return !!this.one('SELECT hidden FROM comments WHERE id=?', Number(obj))?.hidden;
    if (kind === 'porch') return !!this.one('SELECT hidden FROM porches WHERE id=?', obj)?.hidden;
    if (kind === 'identity') return !!this.one('SELECT flagged FROM identities WHERE device_id=?', obj)?.flagged;
    return false;
  }
  objTitle(kind, obj) {
    if (kind === 'podcast') return this.one('SELECT title FROM podcasts WHERE id=?', obj)?.title || '(borrado)';
    if (kind === 'comment') return this.one('SELECT text FROM comments WHERE id=?', Number(obj))?.text || '(borrado)';
    if (kind === 'porch') return this.one('SELECT name FROM porches WHERE id=?', obj)?.name || '(borrado)';
    if (kind === 'identity') return this.one('SELECT name FROM identities WHERE device_id=?', obj)?.name || '(borrada)';
    return '';
  }
}

function cleanChapters(list, duration) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, LIMITS.CHAPTERS_MAX)
    .map((c) => ({ t: cleanNum(c?.t, 0, duration || 1e6, 0), title: cleanText(c?.title, 60) }))
    .filter((c) => c.title)
    .sort((a, b) => a.t - b.t);
}
