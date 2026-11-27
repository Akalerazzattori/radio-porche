// Sesión de directo (una a la vez). Sigue viva aunque se cambie de pantalla.
// Roles: host (estudio), guest (micro, modo Patio/Casa) y listener.
import { session } from './api.js';
import { LIMITS } from './config.js';
import { Voice, audioCtx } from './audio/voice.js';
import { Mixer } from './audio/mixer.js';
import { StudioPeers, ClientPeer } from './audio/rtc.js';
import { recorderMime } from './audio/encode.js';
import { db, uid, getSetting } from './db.js';
import { toast } from './util.js';

const listeners = new Map();
export function onLive(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
  return () => listeners.get(ev).delete(fn);
}
function emit(ev, data) { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } } }

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

export const live = {
  ws: null, porch: null, cid: null, role: null, isOwner: false, isMod: false,
  state: { live: false }, people: [], counts: { listeners: 0, mics: 0 }, chat: [], inviteKey: '',
  opts: {}, retry: 0, closedByUser: false, studioBusy: false,
  // estudio
  mixer: null, voice: null, studio: null, rec: null, recParts: [], partStart: 0, recPausedMs: 0, series: '', warned: {}, partClosed: false,
  // cliente
  peer: null, audio: null, guestMode: '', guestVoice: null, mutedByHost: false, linkState: '',

  get active() { return !!this.ws; },
  get onAir() { return this.state.live; },
  get speaking() { return this.role === 'host' || this.role === 'guest'; },

  connect(porch, opts = {}) {
    if (this.ws && this.porch?.id === porch.id) return;
    this.disconnect();
    this.porch = porch; this.opts = opts; this.closedByUser = false; this.chat = [];
    this.open();
  },

  open() {
    const q = new URLSearchParams();
    if (session.token) q.set('t', session.token);
    if (this.opts.mod) q.set('m', this.opts.mod);
    if (this.opts.invite) q.set('i', this.opts.invite);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/room/${this.porch.id}/ws?${q}`);
    this.ws = ws;
    this.linkState = 'connecting'; emit('update');
    ws.onopen = () => { this.retry = 0; this.linkState = 'open'; emit('update'); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this.handle(m); };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingIv);
      this.linkState = 'closed';
      emit('update');
      if (this.closedByUser || e.code === 4000 || e.code === 4001) return;
      const wait = Math.min(15000, 800 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => { if (!this.closedByUser && this.porch) this.open(); }, wait);
    };
    clearInterval(this.pingIv);
    this.pingIv = setInterval(() => ws.readyState === 1 && ws.send('{"t":"ping"}'), 20000);
  },

  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); },

  disconnect() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingIv);
    if (this.role === 'host' && this.state.live) this.endBroadcast(false);
    this.teardownStudio();
    this.teardownClient();
    try { this.ws?.close(1000); } catch {}
    this.ws = null; this.porch = null; this.role = null; this.state = { live: false }; this.people = []; this.chat = [];
    keepAwake(false);
    emit('update');
  },

  handle(m) {
    switch (m.t) {
      case 'welcome':
        this.cid = m.cid; this.isOwner = m.isOwner; this.isMod = m.isMod; this.state = m.state; this.porch = { ...this.porch, ...m.porch };
        this.chat = m.chat || []; if (m.inviteKey) this.inviteKey = m.inviteKey;
        this.setRole(m.role);
        if (m.role !== 'host' && m.state.hostOnline) this.want();
        emit('update');
        break;
      case 'error':
        toast(m.msg, 'bad');
        emit('error', m);
        if (['blocked', 'banned', 'full', 'ip', 'private', 'noporch'].includes(m.code)) { this.fatal = m; this.closedByUser = true; emit('update'); }
        break;
      case 'info': toast(m.msg); break;
      case 'people': this.people = m.people; this.counts = { listeners: m.listeners, mics: m.mics }; emit('update'); break;
      case 'state': this.state = m.state; emit('update'); break;
      case 'chat': this.chat.push(m.m); if (this.chat.length > 200) this.chat.shift(); emit('chat', m.m); break;
      case 'react': emit('react', m.e); break;
      case 'signal':
        if (this.role === 'host') this.studio?.onSignal(m.from, m.data);
        else this.peer?.onSignal(m.from, m.data);
        break;
      case 'want': if (this.role === 'host') this.onWant(m.cid, m.role, m.mode); break;
      case 'peerLeft': if (this.role === 'host') { this.studio?.close(m.cid); this.mixer?.removeCasa(m.cid); } break;
      case 'studio':
        this.state = m.state || this.state;
        if (this.role !== 'host') { this.peer?.close(); this.want(); }
        emit('update');
        break;
      case 'hostGone': this.state.hostOnline = false; this.peer?.close(); emit('update'); break;
      case 'studioBusy': this.studioBusy = true; emit('studioBusy'); break;
      case 'youAreStudio': this.studioBusy = false; this.state = m.state; this.inviteKey = m.inviteKey; this.setRole('host'); emit('update'); break;
      case 'studioLost':
        toast('El estudio ha pasado a otro dispositivo. Aquí quedas como oyente (silenciado).');
        this.teardownStudio(); this.setRole('listener'); if (this.audio) this.audio.muted = true; emit('update');
        break;
      case 'granted': this.onGranted(m.mode); break;
      case 'denied': toast('Ahora no puede darte paso. Prueba más tarde.'); emit('update'); break;
      case 'muted':
        if (m.cid && this.role === 'host') { this.mixer?.muteVoice(m.cid, m.on); emit('update'); }
        else if (!m.cid) { this.mutedByHost = m.on; this.guestVoice?.setMuted(m.on); toast(m.on ? 'Te han silenciado el micro' : 'Ya puedes hablar'); emit('update'); }
        break;
      case 'kicked':
        toast(m.ban ? 'El presentador te ha sacado y bloqueado en este porche.' : 'El presentador te ha sacado de la sala.', 'bad');
        this.closedByUser = true; this.teardownClient(); emit('update');
        break;
      case 'ended':
        this.state = m.state;
        if (this.role === 'guest') this.leaveMic(true);
        toast(m.msg);
        emit('update'); emit('ended');
        break;
      case 'invite': this.inviteKey = m.key; emit('update'); break;
    }
  },

  setRole(role) {
    const prev = this.role;
    this.role = role;
    if (role === 'host' && prev !== 'host') this.setupStudio();
    if (role !== 'host') this.ensureClient();
  },

  // ================= CLIENTE (oyente / invitado)
  ensureClient() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.autoplay = true;
      this.audio.setAttribute('playsinline', '');
    }
    if (!this.peer) {
      this.peer = new ClientPeer((to, data) => this.send({ t: 'signal', to, data }), {
        onStream: (s) => {
          this.audio.srcObject = s;
          this.audio.muted = this.role === 'guest' && this.guestMode === 'patio' && !this.guestHp;
          this.audio.play().catch(() => emit('needTap'));
          emit('stream', s);
        },
        onState: (st) => { this.rtcState = st; emit('update'); },
      });
    }
  },
  want() { if (this.role !== 'host') this.send({ t: 'want' }); },
  teardownClient() {
    this.peer?.close(); this.peer = null;
    if (this.audio) { this.audio.srcObject = null; this.audio = null; }
    this.guestVoice?.stop(); this.guestVoice = null;
  },
  requestMic(mode, hp) { this.guestHp = hp; this.send({ t: 'micReq', mode, hp }); },
  cancelMic() { this.send({ t: 'micCancel' }); },
  async onGranted(mode) {
    this.guestMode = mode;
    try {
      const v = new Voice();
      await v.start({ headphones: this.guestHp !== false });
      const fx = await getSetting('voiceFx', null);
      if (fx) v.setEffect(fx);
      this.guestVoice = v;
      this.role = 'guest';
      this.peer.close();
      this.peer.setMic(v.track);
      this.want();
      keepAwake(true);
      toast(mode === 'patio' ? '¡Tienes micro! Modo Patio: tu móvil es solo micro.' : '¡Tienes micro! Modo Casa: usa cascos.', 'good');
    } catch (e) {
      toast('No se ha podido abrir el micro. Revisa los permisos.', 'bad');
      this.send({ t: 'leaveMic' });
    }
    emit('update');
  },
  leaveMic(silent = false) {
    this.guestVoice?.stop(); this.guestVoice = null;
    if (!silent) this.send({ t: 'leaveMic' });
    this.role = 'listener'; this.guestMode = ''; this.mutedByHost = false;
    this.peer?.setMic(null); this.peer?.close();
    keepAwake(false);
    if (!silent) this.want();
    emit('update');
  },
  ownerAsGuest(hp) { this.guestHp = hp; this.send({ t: 'ownerGuest', hp }); },
  takeStudio() { this.send({ t: 'takeStudio' }); },

  // ================= ESTUDIO
  async setupStudio() {
    this.teardownClient();
    this.mixer = new Mixer();
    this.mixer.onFeedback = () => { toast('Posible acople: ¿alguien tiene el altavoz puesto sin cascos?', 'bad'); emit('feedback'); };
    this.studio = new StudioPeers((to, data) => this.send({ t: 'signal', to, data }), {
      onVoice: (cid, stream) => {
        const p = this.people.find((x) => x.cid === cid);
        this.mixer.addVoice(cid, { stream, name: p?.name || '' });
        emit('update');
      },
      onVoiceGone: (cid) => { this.mixer?.removeVoice(cid); emit('update'); },
      onState: () => emit('update'),
    });
    if (this.voice) this.mixer.addVoice('me', { node: this.voice.node, local: true, name: session.name });
    if (this.state.live) { this.mixer.setOnAir(!this.state.paused); keepAwake(true); }
    emit('update');
  },
  async startVoice(headphones = true) {
    if (this.voice && this.voice.headphones === headphones) return this.voice;
    this.voice?.stop();
    const v = new Voice();
    await v.start({ headphones });
    const fx = await getSetting('voiceFx', null);
    if (fx) v.setEffect(fx);
    this.voice = v;
    if (this.mixer) this.mixer.addVoice('me', { node: v.node, local: true, name: session.name });
    emit('update');
    return v;
  },
  onWant(cid, role, mode) {
    if (!this.mixer) return;
    let out;
    if (role === 'guest') out = mode === 'patio' ? this.mixer.patioStream : this.mixer.addCasa(cid);
    else { this.mixer.removeCasa(cid); out = this.mixer.listenerStream; }
    this.studio.connect(cid, role === 'guest' ? 'guest' : 'listener', out);
  },
  teardownStudio() {
    this.stopRecorder(false);
    this.studio?.closeAll(); this.studio = null;
    this.mixer?.destroy(); this.mixer = null;
    this.voice?.stop(); this.voice = null;
  },

  goLive(mode, title) {
    this.series = uid();
    this.recParts = [];
    this.warned = {};
    this.send({ t: 'golive', mode, title });
    this.mixer?.setOnAir(true);
    audioCtx();
    keepAwake(true);
    if (mode === 'rec') this.startRecorder(1);
  },
  pause(on) {
    this.mixer?.setOnAir(!on);
    if (this.rec) { try { on ? this.rec.mr.pause() : this.rec.mr.resume(); } catch {} if (on) this.rec.pausedAt = Date.now(); else if (this.rec.pausedAt) { this.rec.pausedMs += Date.now() - this.rec.pausedAt; this.rec.pausedAt = 0; } }
    this.send({ t: 'hostState', paused: on });
  },
  async endBroadcast(send = true) {
    const saved = await this.stopRecorder(true);
    if (send) this.send({ t: 'end' });
    this.mixer?.setOnAir(false);
    this.mixer?.stopMusic();
    keepAwake(false);
    return saved;
  },

  // ---------- grabación (troceada en partes de 40 min)
  startRecorder(part) {
    const mime = recorderMime();
    const mr = new MediaRecorder(this.mixer.listenerStream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.start(5000);
    this.rec = { mr, chunks, part, start: Date.now(), pausedMs: 0, pausedAt: 0, mime: (mime || 'audio/webm').split(';')[0] };
    this.partClosed = false;
    this.warned = {};
    this.send({ t: 'hostState', rec: true, part });
    clearInterval(this.recIv);
    this.recIv = setInterval(() => this.checkPart(), 1000);
    emit('update');
  },
  partElapsed() {
    const r = this.rec;
    if (!r) return 0;
    const paused = r.pausedMs + (r.pausedAt ? Date.now() - r.pausedAt : 0);
    return (Date.now() - r.start - paused) / 1000;
  },
  checkPart() {
    const s = this.partElapsed();
    const part = this.rec?.part || 1;
    if (s >= LIMITS.WARN_1_MIN * 60 && !this.warned.w1) { this.warned.w1 = true; emit('warn', `Te quedan ${LIMITS.MAX_PART_MIN - LIMITS.WARN_1_MIN} minutos: despide la Parte ${part}`); }
    if (s >= LIMITS.WARN_2_MIN * 60 && !this.warned.w2) { this.warned.w2 = true; emit('warn', `Último minuto de la Parte ${part}`); }
    if (s >= LIMITS.MAX_PART_MIN * 60) {
      this.stopRecorder(true).then(() => { this.partClosed = true; this.send({ t: 'hostState', rec: false }); emit('partClosed', part); emit('update'); });
    }
  },
  continueNextPart() {
    const next = (this.recParts.length ? Math.max(...this.recParts.map((p) => p.part)) : 0) + 1;
    this.startRecorder(next);
  },
  async stopRecorder(save) {
    clearInterval(this.recIv);
    const r = this.rec;
    if (!r) return null;
    this.rec = null;
    const duration = (Date.now() - r.start - r.pausedMs - (r.pausedAt ? Date.now() - r.pausedAt : 0)) / 1000;
    const done = new Promise((res) => (r.mr.onstop = res));
    try { r.mr.stop(); } catch {}
    await Promise.race([done, new Promise((res) => setTimeout(res, 3000))]);
    if (!save || !r.chunks.length) return null;
    const blob = new Blob(r.chunks, { type: r.mime });
    const item = {
      id: uid(), kind: 'draft', created: Date.now(), title: this.state.title || 'Programa sin título', description: '',
      part: r.part, series: this.series, duration, mime: r.mime, blob, scene: this.porch?.scene || 1, porchName: this.porch?.name || '', chapters: [],
    };
    try { await db.put('recordings', item); this.recParts.push(item); } catch { toast('No se ha podido guardar la grabación en el móvil', 'bad'); }
    emit('update');
    return item;
  },
};

// Si el móvil se bloquea o se cambia de app mientras se emite: aviso grande y reconexión.
document.addEventListener('visibilitychange', () => {
  if (!live.active) return;
  if (document.visibilityState === 'hidden') {
    if (live.speaking) live.wasHidden = Date.now();
  } else {
    if (live.speaking) keepAwake(true);
    if (live.wasHidden) { emit('resumed', Date.now() - live.wasHidden); live.wasHidden = 0; }
    if (!live.ws || live.ws.readyState > 1) { live.closedByUser = false; live.open(); }
    else if (live.role !== 'host' && live.rtcState && live.rtcState !== 'connected') { live.peer?.close(); live.want(); }
  }
});
