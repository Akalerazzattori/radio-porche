// Room: un Durable Object por porche. Señalización WebRTC, chat en directo (no se guarda
// al cerrar la sala), peticiones de micro, moderación y estado de emisión.
import { DurableObject } from 'cloudflare:workers';
import { LIMITS, QUICK_REACTIONS, DEFAULT_BADWORDS } from '../public/js/config.js';
import { randomId, filterChat, cleanText, safeEqual } from './lib/util.js';

const HOST_GRACE_MS = 120_000;
const BACKLOG = 60;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.backlog = []; // chat solo en memoria
    this.badwords = DEFAULT_BADWORDS;
    this.lastNotify = 0;
    this.notifyPending = false;
    this.lastCounts = '';
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) || {
        porchId: '', live: false, mode: '', title: '', since: 0, inviteKey: randomId(9), pinned: null,
        paused: false, rec: false, part: 1, studio: null, hostGoneAt: 0, guests: {},
      };
      if (!this.state.guests) this.state.guests = {};
    });
  }

  save() { return this.ctx.storage.put('state', this.state); }
  sockets() {
    return this.ctx.getWebSockets().filter((w) => {
      const a = w.deserializeAttachment();
      return !a || !a.left;
    });
  }
  att(ws) { return ws.deserializeAttachment() || {}; }
  setAtt(ws, a) { ws.serializeAttachment(a); }
  byCid(cid) { return this.sockets().find((w) => this.att(w).cid === cid); }
  host() { return this.sockets().find((w) => this.att(w).role === 'host'); }
  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg, filter) {
    const s = JSON.stringify(msg);
    for (const w of this.sockets()) {
      if (filter && !filter(this.att(w))) continue;
      try { w.send(s); } catch {}
    }
  }

  publicState() {
    const s = this.state;
    const h = this.host();
    return { live: s.live, mode: s.mode, title: s.title, since: s.since, pinned: s.pinned, paused: s.paused, rec: s.rec, part: s.part, studio: s.studio, hostOnline: !!h, studioKind: h ? this.att(h).kind || 'móvil' : '' };
  }
  counts() {
    let listeners = 0, mics = 0;
    for (const w of this.sockets()) {
      const a = this.att(w);
      if (a.role === 'guest') mics++;
      else if (a.role === 'listener') listeners++;
    }
    return { listeners, mics };
  }
  people(full) {
    const out = [];
    for (const w of this.sockets()) {
      const a = this.att(w);
      if (!full && a.role === 'listener') continue;
      out.push({ cid: a.cid, kind: a.kind || 'móvil', av: a.av || 0, owner: !!a.isOwner, name: a.name || 'Oyente', role: a.role, mode: a.mode || '', hp: !!a.hp, muted: !!a.muted, isMod: !!a.isMod, dev: a.dev || '', micReq: a.micReq || null });
    }
    return out;
  }
  pushPeople() {
    const c = this.counts();
    const lite = { t: 'people', people: this.people(false), ...c };
    const full = { t: 'people', people: this.people(true), ...c, full: true };
    for (const w of this.sockets()) {
      const a = this.att(w);
      this.send(w, a.role === 'host' || a.isMod || a.isOwner ? full : lite);
    }
    this.notifyHub();
  }

  async notifyHub(force = false) {
    const c = this.counts();
    const key = JSON.stringify([this.state.live, this.state.mode, this.state.title, c.listeners, c.mics]);
    if (!force && key === this.lastCounts) return;
    if (!force && Date.now() - this.lastNotify < 5000) {
      this.notifyPending = true;
      const al = await this.ctx.storage.getAlarm();
      if (!al) await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    this.lastNotify = Date.now();
    this.notifyPending = false;
    this.lastCounts = key;
    if (!this.state.porchId) return;
    try {
      const hub = this.env.HUB.get(this.env.HUB.idFromName('main'));
      await hub.fetch('https://hub/internal/live', {
        method: 'POST',
        body: JSON.stringify({
          porchId: this.state.porchId, live: this.state.live, mode: this.state.mode, title: this.state.title,
          since: this.state.since, listeners: c.listeners, mics: c.mics, waiting: this.state.live ? 0 : c.listeners,
        }),
      });
    } catch (e) { console.error('notifyHub', e); }
  }

  async fetch(req) {
    if (req.headers.get('upgrade') !== 'websocket') return new Response('Se esperaba WebSocket', { status: 426 });
    let auth;
    try { auth = JSON.parse(req.headers.get('x-rp-auth') || '{}'); } catch { auth = {}; }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const reject = (code, msg) => {
      this.send(server, { t: 'error', code, msg });
      server.close(4000, code);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!auth.porch) return reject('noporch', 'Este porche no existe');
    if (!this.state.porchId) { this.state.porchId = auth.porch.id; await this.save(); }
    if (auth.badwords) this.badwords = auth.badwords;
    if (auth.ident?.blocked) return reject('blocked', 'Este dispositivo está bloqueado');
    if (auth.banned) return reject('banned', 'El presentador te ha bloqueado en este porche');

    const others = this.sockets().filter((w) => w !== server);
    if (others.length >= LIMITS.ROOM_MAX_CONN) return reject('full', 'La sala está llena ahora mismo');
    if (others.filter((w) => this.att(w).ip === auth.ip).length >= LIMITS.ROOM_MAX_PER_IP) {
      return reject('ip', 'Demasiadas conexiones desde tu red');
    }
    const hasInvite = typeof auth.invite === 'string' && auth.invite && safeEqual(auth.invite, this.state.inviteKey);
    if (this.state.live && this.state.mode === 'ensayo' && !auth.isOwner && !auth.isMod && !hasInvite) {
      return reject('private', 'Es un ensayo privado. Solo entra quien tiene invitación.');
    }

    // La misma pestaña reconectando: cerrar su conexión vieja (evita fantasmas y avisos repetidos)
    const tab = typeof auth.tab === 'string' ? auth.tab.slice(0, 24) : '';
    let rejoin = false;
    if (tab) for (const w of others) { const x = this.att(w); if (x.tab === tab) { rejoin = true; x.left = true; this.setAtt(w, x); try { w.close(4003, 'replaced'); } catch {} if (x.role === 'host') { this.state.studio = null; } } }
    const devAlready = !!auth.ident && this.sockets().some((w) => w !== server && this.att(w).dev === auth.ident.deviceId);
    const cid = randomId(6);
    const a = {
      tab, kind: auth.kind || 'móvil',
      cid, ip: auth.ip, dev: auth.ident?.deviceId || '', name: auth.ident?.name || '', av: auth.ident?.avatar || 0, isNew: !!auth.ident?.isNew,
      isOwner: !!auth.isOwner, isMod: !!auth.isMod, invited: hasInvite, role: 'listener', mode: '', hp: false,
      muted: false, last: Date.now(), lastChat: 0, chatWin: 0, chatN: 0, lastMic: 0, lastReact: 0, micReq: null,
    };
    let studioBusy = false;
    if (a.isOwner) {
      const h = this.host();
      if (h) studioBusy = true;
      else { a.role = 'host'; this.state.studio = cid; this.state.hostGoneAt = 0; await this.save(); }
    }
    // ¿Ya tenía micro en este programa? (reconexión, cambio de app…) → lo recupera sin pedirlo otra vez
    // (el anfitrión usa la misma identidad en varios aparatos: para él se recuerda por pestaña)
    const gk = this.guestKey(a);
    const prevGuest = gk && a.role !== 'host' ? this.state.guests[gk] : null;
    if (prevGuest && this.counts().mics < LIMITS.ROOM_MAX_MICS) { a.role = 'guest'; a.mode = prevGuest.mode; a.hp = !!prevGuest.hp; studioBusy = false; }
    this.setAtt(server, a);
    this.send(server, {
      t: 'welcome', cid, role: a.role, isOwner: a.isOwner, isMod: a.isMod, invited: hasInvite,
      state: this.publicState(), chat: this.backlog.slice(-40), porch: auth.porch,
      inviteKey: a.isOwner ? this.state.inviteKey : undefined,
    });
    if (studioBusy) this.send(server, { t: 'studioBusy' });
    if (a.role === 'guest') this.send(server, { t: 'granted', mode: a.mode, host: this.state.studio, rec: this.state.rec, restored: true });
    if (a.role === 'host') this.broadcast({ t: 'studio', cid, state: this.publicState() }, (x) => x.cid !== cid);
    if (a.name && a.role !== 'host' && this.state.live && !rejoin && !devAlready) this.system(`${a.name} se ha unido`);
    this.pushPeople();
    const al = await this.ctx.storage.getAlarm();
    if (!al) await this.ctx.storage.setAlarm(Date.now() + 30_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  system(text) {
    const m = { id: randomId(5), sys: true, text, ts: Date.now() };
    this.backlog.push(m);
    if (this.backlog.length > BACKLOG) this.backlog.shift();
    this.broadcast({ t: 'chat', m });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > LIMITS.WS_MAX_BYTES) { this.send(ws, { t: 'error', code: 'size', msg: 'Mensaje demasiado grande' }); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const a = this.att(ws);
    a.last = Date.now();
    const isHost = a.role === 'host';
    const canMod = isHost || a.isMod || a.isOwner;

    switch (msg.t) {
      case 'chat': {
        if (!a.dev) return this.send(ws, { t: 'error', code: 'noident', msg: 'Entra con tu nombre para escribir' });
        const nowMs = Date.now();
        const gap = a.isNew ? LIMITS.CHAT_MIN_GAP_MS_NEW : LIMITS.CHAT_MIN_GAP_MS;
        const perMin = a.isNew ? LIMITS.CHAT_PER_MIN_NEW : LIMITS.CHAT_PER_MIN;
        if (nowMs - a.lastChat < gap) return this.send(ws, { t: 'error', code: 'slow', msg: 'Espera un momento antes de escribir otra vez' });
        if (nowMs - a.chatWin > 60_000) { a.chatWin = nowMs; a.chatN = 0; }
        if (a.chatN >= perMin) return this.send(ws, { t: 'error', code: 'slow', msg: 'Has escrito mucho. Espera un minuto.' });
        // límite adicional por IP
        const ipN = this.sockets().map((w) => this.att(w)).filter((x) => x.ip === a.ip).reduce((s, x) => s + (nowMs - x.chatWin < 60_000 ? x.chatN : 0), 0);
        if (ipN >= perMin * 2) return this.send(ws, { t: 'error', code: 'slow', msg: 'Demasiados mensajes desde tu red' });
        let text = cleanText(msg.text, LIMITS.CHAT_MAX);
        if (!text) return;
        text = filterChat(text, this.badwords, canMod).text;
        a.lastChat = nowMs; a.chatN++;
        this.setAtt(ws, a);
        const m = { id: randomId(5), cid: a.cid, dev: a.dev, name: a.name, text, ts: nowMs, host: isHost || a.isOwner, mod: a.isMod };
        this.backlog.push(m);
        if (this.backlog.length > BACKLOG) this.backlog.shift();
        this.broadcast({ t: 'chat', m });
        return;
      }
      case 'react': {
        if (!QUICK_REACTIONS.includes(msg.e) || Date.now() - a.lastReact < 800) return;
        a.lastReact = Date.now(); this.setAtt(ws, a);
        this.broadcast({ t: 'react', e: msg.e });
        return;
      }
      case 'pin': {
        if (!canMod) return;
        const text = cleanText(msg.text || '', LIMITS.CHAT_MAX);
        this.state.pinned = text ? { name: a.name || 'Presentador', text } : null;
        await this.save();
        this.broadcast({ t: 'state', state: this.publicState() });
        return;
      }
      case 'micReq': {
        if (!a.dev) return this.send(ws, { t: 'error', code: 'noident', msg: 'Entra con tu nombre para pedir micro' });
        if (a.role !== 'listener') return;
        if (Date.now() - a.lastMic < LIMITS.MIC_REQ_GAP_S * 1000) return this.send(ws, { t: 'error', code: 'slow', msg: 'Ya has pedido micro. Espera un poco.' });
        a.lastMic = Date.now();
        a.micReq = { mode: msg.mode === 'patio' ? 'patio' : 'casa', hp: !!msg.hp, ts: Date.now() };
        this.setAtt(ws, a);
        // Con enlace de invitación: entra directo al micro (sin esperar a "Dar paso")
        if ((a.invited || a.isOwner) && this.counts().mics < LIMITS.ROOM_MAX_MICS) {
          await this.makeGuest(ws, a);
          return;
        }
        const h = this.host();
        if (a.name && this.state.live) this.system(`${a.name} ha pedido micro`);
        this.pushPeople();
        if (!h) this.send(ws, { t: 'info', msg: 'El presentador aún no está. Tu petición queda en espera.' });
        return;
      }
      case 'micCancel': {
        a.micReq = null; this.setAtt(ws, a); this.pushPeople(); return;
      }
      case 'grant': case 'deny': {
        if (!isHost && !a.isOwner) return;
        const tw = this.byCid(msg.cid);
        if (!tw) return;
        const t = this.att(tw);
        if (msg.t === 'deny') { t.micReq = null; this.setAtt(tw, t); this.send(tw, { t: 'denied' }); this.pushPeople(); return; }
        if (!t.micReq) return;
        if (this.counts().mics >= LIMITS.ROOM_MAX_MICS) return this.send(ws, { t: 'error', code: 'mics', msg: `Máximo ${LIMITS.ROOM_MAX_MICS} micros a la vez` });
        await this.makeGuest(tw, t);
        return;
      }
      case 'ownerGuest': {
        // El móvil del anfitrión entra como micro en modo Patio mientras otro dispositivo es el estudio.
        if (!a.isOwner || isHost) return;
        if (this.counts().mics >= LIMITS.ROOM_MAX_MICS) return;
        a.micReq = { mode: 'patio', hp: !!msg.hp };
        await this.makeGuest(ws, a);
        return;
      }
      case 'leaveMic': {
        if (a.role !== 'guest') return;
        a.role = 'listener'; a.mode = ''; this.setAtt(ws, a);
        if (this.guestKey(a)) { delete this.state.guests[this.guestKey(a)]; await this.save(); }
        const h = this.host();
        if (h) this.send(h, { t: 'peerLeft', cid: a.cid });
        this.pushPeople();
        return;
      }
      case 'mute': {
        if (!canMod) return;
        const tw = this.byCid(msg.cid);
        if (!tw) return;
        const t = this.att(tw);
        if (t.role === 'host') return;
        t.muted = !!msg.on; this.setAtt(tw, t);
        this.send(tw, { t: 'muted', on: t.muted });
        const h = this.host();
        if (h && h !== ws) this.send(h, { t: 'muted', cid: t.cid, on: t.muted });
        this.pushPeople();
        return;
      }
      case 'kick': {
        if (!canMod) return;
        const tw = this.byCid(msg.cid);
        if (!tw) return;
        const t = this.att(tw);
        if (t.role === 'host' || t.isOwner) return;
        if (t.isMod && !isHost) return;
        if (this.guestKey(t)) { delete this.state.guests[this.guestKey(t)]; await this.save(); }
        const canBan = isHost || a.isOwner;
        this.send(tw, { t: 'kicked', ban: !!msg.ban && canBan });
        if (msg.ban && canBan && t.dev) {
          try {
            const hub = this.env.HUB.get(this.env.HUB.idFromName('main'));
            await hub.fetch('https://hub/internal/ban', { method: 'POST', body: JSON.stringify({ porchId: this.state.porchId, deviceId: t.dev }) });
          } catch {}
        }
        try { tw.close(4001, 'kicked'); } catch {}
        const h = this.host();
        if (h) this.send(h, { t: 'peerLeft', cid: t.cid });
        if (t.name) this.system(`${t.name} ha salido de la sala`);
        this.pushPeople();
        return;
      }
      case 'signal': {
        const tw = this.byCid(msg.to);
        if (!tw) return;
        const t = this.att(tw);
        if (!isHost && t.role !== 'host') return; // solo con el estudio
        this.send(tw, { t: 'signal', from: a.cid, data: msg.data });
        return;
      }
      case 'ctl': {
        // Mando a distancia: otro aparato del anfitrión controla la cabina del estudio
        if (!a.isOwner || isHost) return;
        const h = this.host();
        if (!h) return this.send(ws, { t: 'error', code: 'nostudio', msg: 'El estudio no está conectado' });
        if (typeof msg.cmd !== 'string' || msg.cmd.length > 20) return;
        this.send(h, { t: 'ctl', cmd: msg.cmd, args: msg.args && typeof msg.args === 'object' ? msg.args : {} });
        return;
      }
      case 'studioState': case 'studioSounds': {
        if (!isHost) return;
        const out = JSON.stringify({ t: msg.t, s: msg.s });
        for (const w of this.sockets()) {
          const x = this.att(w);
          if (x.isOwner && x.role !== 'host') { try { w.send(out); } catch {} }
        }
        return;
      }
      case 'want': {
        // un oyente pide recibir la emisión: avisar al estudio
        const h = this.host();
        if (h && h !== ws) this.send(h, { t: 'want', cid: a.cid, role: a.role, mode: a.mode });
        return;
      }
      case 'golive': {
        if (!isHost) return;
        const mode = ['ensayo', 'directo', 'rec'].includes(msg.mode) ? msg.mode : 'directo';
        this.state.live = true; this.state.mode = mode; this.state.rec = mode === 'rec';
        this.state.title = cleanText(msg.title || '', LIMITS.TITLE_MAX); this.state.since = Date.now(); this.state.part = 1; this.state.paused = false;
        await this.save();
        this.broadcast({ t: 'state', state: this.publicState() });
        this.system('¡Estamos en el aire!');
        this.notifyHub(true);
        return;
      }
      case 'hostState': {
        if (!isHost) return;
        if (typeof msg.paused === 'boolean') this.state.paused = msg.paused;
        if (typeof msg.rec === 'boolean') this.state.rec = msg.rec && this.state.mode === 'rec';
        if (Number.isInteger(msg.part) && msg.part > 0 && msg.part < 50) this.state.part = msg.part;
        if (typeof msg.title === 'string') this.state.title = cleanText(msg.title, LIMITS.TITLE_MAX);
        await this.save();
        this.broadcast({ t: 'state', state: this.publicState() });
        return;
      }
      case 'end': {
        if (!isHost) return;
        await this.endLive('Fin de la emisión. ¡Gracias por escuchar!');
        return;
      }
      case 'takeStudio': {
        if (!a.isOwner || isHost) return;
        const old = this.host();
        if (old) {
          const o = this.att(old);
          o.role = 'listener'; this.setAtt(old, o);
          this.send(old, { t: 'studioLost' });
        }
        a.role = 'host'; a.mode = ''; this.setAtt(ws, a);
        this.state.studio = a.cid; this.state.hostGoneAt = 0;
        await this.save();
        this.send(ws, { t: 'youAreStudio', state: this.publicState(), inviteKey: this.state.inviteKey });
        this.broadcast({ t: 'studio', cid: a.cid, state: this.publicState() }, (x) => x.cid !== a.cid);
        this.pushPeople();
        return;
      }
      case 'rotateInvite': {
        if (!isHost) return;
        this.state.inviteKey = randomId(9); await this.save();
        this.send(ws, { t: 'invite', key: this.state.inviteKey });
        return;
      }
      case 'level': {
        // Medidores de voz: el estudio los reparte (ligero, ≤ 4/s)
        if (!isHost || !msg.levels || typeof msg.levels !== 'object') return;
        this.broadcast({ t: 'level', levels: msg.levels }, (x) => x.role !== 'listener');
        return;
      }
      default:
        return;
    }
  }

  guestKey(a) { return a.isOwner ? (a.tab ? `t:${a.tab}` : '') : a.dev || ''; }

  /** Dar micro a una conexión y recordarlo para el resto del programa. */
  async makeGuest(ws, t) {
    t.role = 'guest'; t.mode = t.micReq?.mode || 'casa'; t.hp = !!t.micReq?.hp; t.micReq = null; t.muted = false;
    this.setAtt(ws, t);
    const gk = this.guestKey(t);
    if (gk) { this.state.guests[gk] = { mode: t.mode, hp: t.hp }; await this.save(); }
    this.send(ws, { t: 'granted', mode: t.mode, host: this.state.studio, rec: this.state.rec });
    this.pushPeople();
  }

  async endLive(text) {
    this.state.live = false; this.state.mode = ''; this.state.rec = false; this.state.title = ''; this.state.pinned = null;
    this.state.paused = false; this.state.since = 0; this.state.hostGoneAt = 0; this.state.guests = {};
    await this.save();
    this.backlog = []; // el chat no se guarda tras cerrar
    for (const w of this.sockets()) {
      const x = this.att(w);
      if (x.role === 'guest') { x.role = 'listener'; x.mode = ''; this.setAtt(w, x); }
      x.micReq = null; this.setAtt(w, x);
    }
    this.broadcast({ t: 'ended', msg: text, state: this.publicState() });
    this.pushPeople();
    this.notifyHub(true);
  }

  async webSocketClose(ws) { await this.onLeave(ws); }
  async webSocketError(ws) { await this.onLeave(ws); }

  async onLeave(ws) {
    const a = this.att(ws);
    if (a.left) return;
    a.left = true;
    try { this.setAtt(ws, a); } catch {}
    if (a.role === 'host') {
      this.state.studio = null;
      if (this.state.live) this.state.hostGoneAt = Date.now();
      await this.save();
      this.broadcast({ t: 'hostGone' }, (x) => x.cid !== a.cid);
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    } else {
      const h = this.host();
      if (h) this.send(h, { t: 'peerLeft', cid: a.cid });
    }
    // recalcular sin este socket
    queueMicrotask(() => this.pushPeople());
  }

  async alarm() {
    const now = Date.now();
    for (const w of this.sockets()) {
      const a = this.att(w);
      const ping = this.ctx.getWebSocketAutoResponseTimestamp(w);
      const last = Math.max(a.last || 0, ping ? ping.getTime() : 0);
      if (now - last > LIMITS.WS_IDLE_SEC * 1000) { try { w.close(4002, 'idle'); } catch {} }
    }
    if (this.state.live && !this.host() && this.state.hostGoneAt && now - this.state.hostGoneAt > HOST_GRACE_MS) {
      await this.endLive('El estudio se ha desconectado. Fin de la emisión.');
    }
    if (this.notifyPending) await this.notifyHub();
    else await this.notifyHub();
    if (this.sockets().length > 0 || this.state.live) await this.ctx.storage.setAlarm(now + 30_000);
  }
}
