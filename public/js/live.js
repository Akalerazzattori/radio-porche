// Sesión de directo (una a la vez). Sigue viva aunque se cambie de pantalla.
// Roles: host (estudio), guest (micro, modo Patio/Casa) y listener.
import { session } from './api.js';
import { LIMITS } from './config.js';
import { Voice, audioCtx } from './audio/voice.js';
import { Mixer } from './audio/mixer.js';
import { StudioPeers, ClientPeer } from './audio/rtc.js';
import { recorderMime } from './audio/encode.js';
import { loadAll, decode } from './audio/sounds.js';
import { db, uid, getSetting } from './db.js';
import { toast, DEVICE_KIND } from './util.js';
import { markUsed, hasUsed, sendRecording } from './inbox.js';

const listeners = new Map();
export function onLive(ev, fn) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
  return () => listeners.get(ev).delete(fn);
}
function emit(ev, data) { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } } }

// ---------- Que el aparato no se duerma mientras se emite ----------
// 1) Wake Lock (pantalla encendida). 2) Si no existe o falla: un vídeo mudo en bucle (truco que funciona en iPhone).
let wakeLock = null, wantAwake = false, sleepVideo = null;
function videoFallback(on) {
  if (on) {
    if (!sleepVideo) {
      sleepVideo = document.createElement('video');
      sleepVideo.src = '/media/nosleep.mp4';
      sleepVideo.muted = true; sleepVideo.loop = true; sleepVideo.playsInline = true;
      sleepVideo.setAttribute('playsinline', ''); sleepVideo.setAttribute('muted', '');
      sleepVideo.className = 'sleep-video';
      document.body.appendChild(sleepVideo);
    }
    sleepVideo.play().catch(() => document.addEventListener('pointerdown', () => sleepVideo?.play().catch(() => {}), { once: true }));
  } else if (sleepVideo) { sleepVideo.pause(); sleepVideo.remove(); sleepVideo = null; }
}
async function keepAwake(on) {
  wantAwake = on;
  try {
    if (on) {
      if ('wakeLock' in navigator) {
        if (!wakeLock) {
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; if (wantAwake && document.visibilityState === 'visible') keepAwake(true); });
        }
      } else videoFallback(true);
    } else {
      if (wakeLock) { await wakeLock.release(); wakeLock = null; }
      videoFallback(false);
    }
  } catch { if (on) videoFallback(true); }
}

export const live = {
  ws: null, porch: null, cid: null, role: null, isOwner: false, isMod: false,
  state: { live: false }, people: [], counts: { listeners: 0, mics: 0 }, chat: [], inviteKey: '',
  opts: {}, retry: 0, closedByUser: false, studioBusy: false,
  // estudio
  mixer: null, voice: null, studio: null, rec: null, recParts: [], partStart: 0, recPausedMs: 0, series: '', warned: {}, partClosed: false,
  // cliente
  peer: null, audio: null, guestMode: '', guestVoice: null, mutedByHost: false, linkState: '',
  // mando a distancia (otro aparato del anfitrión)
  remote: false, remoteState: null, remoteSounds: [], hearHere: true, soundsSentTo: new Set(),
  // sonidos del estudio
  items: [], fxPlaying: new Map(),

  kind: DEVICE_KIND,
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
    let tab = sessionStorage.getItem('rp_tab');
    if (!tab) { tab = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('rp_tab', tab); }
    q.set('c', tab);
    q.set('d', this.kind);
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
      if (this.closedByUser || e.code === 4000 || e.code === 4001 || e.code === 4003) return;
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
    clearInterval(this.stateIv);
    this.remote = false; this.remoteState = null; this.remoteSounds = [];
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
        if (m.isOwner && document.visibilityState !== 'visible') this.send({ t: 'vis', v: false });
        if (m.role !== 'host' && m.state.hostOnline) this.want();
        emit('update');
        break;
      case 'error':
        toast(m.msg, 'bad');
        emit('error', m);
        if (['blocked', 'banned', 'full', 'ip', 'private', 'noporch'].includes(m.code)) { this.fatal = m; this.closedByUser = true; emit('update'); }
        break;
      case 'info': toast(m.msg); break;
      case 'people': this.people = m.people; this.counts = { listeners: m.listeners, mics: m.mics }; for (const p of m.people) if (p.owner && p.cid !== this.cid) markUsed(p.kind); this.guardEcho(); emit('update'); break;
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
      case 'studioBusy': this.studioBusy = false; this.becomeRemote(); break;
      case 'youAreStudio': {
        // Este aparato pasa a emitir. Si era tu micro, sigue siéndolo (ahora dentro del estudio).
        const wasMic = !!this.guestVoice || m.wasMic;
        const hp = this.guestHp !== false && localStorage.getItem('rp_hp') !== '0';
        this.studioBusy = false; this.state = m.state; this.inviteKey = m.inviteKey; this.remote = false;
        this.setRole('host');
        if (wasMic) this.startVoice(hp).catch(() => {});
        if (this.state.live && this.state.mode === 'rec' && !this.rec) this.startRecorder((this.state.part || 1) + 1);
        toast(this.kind === 'ordenador' ? 'Ahora emite este ordenador.' : 'Ahora emite este móvil.', 'good');
        emit('update');
        break;
      }
      case 'studioLost': {
        // Otro aparato tuyo pasa a emitir. Si aquí estabas hablando, sigues siendo micro sin hacer nada.
        const hadMic = !!this.voice && !this.voice.muted;
        this.guestHp = this.headphones !== false;
        this.hearHere = hadMic ? this.guestHp : false;
        this.teardownStudio(); this.setRole('listener'); this.remote = true;
        if (this.audio) this.audio.muted = !this.hearHere;
        if (hadMic) this.ownerAsGuest(this.guestHp);
        toast(`Ahora emite tu ${this.state.studioKind || 'otro aparato'}. ${hadMic ? 'Aquí sigues siendo micro.' : ''}`);
        emit('update');
        break;
      }
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
      case 'ctl': if (this.role === 'host') this.runCtl(m.cmd, m.args || {}); break;
      case 'gfx': {
        // Un invitado lanza un efecto: solo efectos y cortinillas de serie, y si lo permites
        if (this.role !== 'host' || !this.mixer || localStorage.getItem('rp_guestfx') === '0') break;
        const it = this.findItem(m.key);
        if (!it || !['fx', 'jingle'].includes(it.zone)) break;
        this.fireSound(m.key);
        toast(`${m.name || 'Un invitado'} ha lanzado «${it.name}»`);
        break;
      }
      case 'handoff': if (this.role !== 'host' && this.isOwner) { if (this.role === 'guest') this.leaveMic(true); this.takeStudio(); } break;
      case 'studioState': this.remoteState = m.s; emit('remote'); break;
      case 'studioSounds': {
        const s = m.s || {};
        if (s.part === 0) this._snd = [];
        this._snd = (this._snd || []).concat(Array.isArray(s.items) ? s.items : []);
        if (s.part === s.total - 1) { this.remoteSounds = this._snd; emit('remote'); }
        break;
      }
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
          this.audioBlocked = false;
          this.audio.muted = (this.role === 'guest' && this.guestMode === 'patio' && !this.guestHp) || ((this.remote || this.isOwner) && this.role !== 'host' && !this.hearHere);
          this.audio.play().catch(() => {
            // El navegador no deja sonar sin un toque: el primer toque en cualquier sitio lo arranca.
            this.audioBlocked = true;
            const go = () => { this.audio?.play().then(() => { this.audioBlocked = false; emit('update'); }).catch(() => {}); };
            document.addEventListener('pointerdown', go, { once: true, capture: true });
            if (!this.isOwner) emit('needTap');
          });
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
    if (this.guestVoice && this.role === 'guest') { this.peer?.close(); this.peer?.setMic(this.guestVoice.track); this.want(); emit('update'); return; }
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
      if (this.isOwner) toast('Micro activo en este aparato', 'good');
      else toast(mode === 'patio' ? '¡Tienes micro! Estás a su lado: este aparato es solo micro.' : '¡Tienes micro! Ponte los cascos.', 'good');
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
  /** Tu micro en un aparato que no emite: modo Casa (recibes todo menos tu voz; suena si "Escuchar" está activo). */
  ownerAsGuest(hp) { this.guestHp = hp; this.remote = true; this.send({ t: 'ownerGuest', hp, mode: 'casa' }); },
  /** Interruptor "Micro aquí" de este aparato. */
  async setMicHere(on) {
    const hp = localStorage.getItem('rp_hp') !== '0';
    if (this.role === 'host') {
      if (on) { if (!this.voice) await this.startVoice(hp); this.voice.setMuted(false); }
      else this.voice?.setMuted(true);
    } else if (on) this.ownerAsGuest(hp);
    else { this.leaveMic(); this.remote = true; }
    localStorage.setItem(`rp_mic_${this.kind}`, on ? '1' : '0');
    emit('update');
  },
  micHere() { return this.role === 'host' ? !!this.voice && !this.voice.muted : this.role === 'guest'; },
  /** Interruptor "Escuchar aquí". */
  setListenHere(on) {
    if (this.role === 'host') this.mixer?.setMonitor(on);
    else { this.hearHere = on; if (this.audio) this.audio.muted = !on; }
    // Escuchar aquí = lo oyes todo, también tu voz (si llevas cascos)
    const v = this.role === 'host' ? this.voice : this.guestVoice;
    if (v) v.setMonitor(on && v.headphones !== false);
    emit('update');
  },
  listenHere() { return this.role === 'host' ? !!this.mixer?.monitorOn : !!this.hearHere; },
  /** Otros aparatos tuyos conectados (uno por tipo). */
  myOtherDevices() {
    const seen = new Map();
    for (const p of this.people) if (p.owner && p.cid !== this.cid) seen.set(p.kind, p);
    return [...seen.values()];
  },
  takeStudio() { this.send({ t: 'takeStudio' }); },
  /** Si otro aparato tuyo hace de micro, el que emite deja de sonar: escuchas en el que tiene el micro.
   *  Así tu voz no sale por un altavoz y vuelve a entrar (eco que se repite). */
  guardEcho() {
    if (this.role !== 'host' || !this.mixer) return;
    const otherMic = this.people.some((p) => p.owner && p.cid !== this.cid && p.role === 'guest');
    if (otherMic && !this._otherMic && this.mixer.monitorOn) { this.mixer.setMonitor(false); toast('Escuchas en el aparato del micro. Este deja de sonar para que no haya eco.'); }
    this._otherMic = otherMic;
  },

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
    if (this.voice) { this.mixer.addVoice('me', { node: this.voice.node, local: true, name: session.name }); this.mixer.selfVoice = this.voice; this.mixer.syncSelf(); }
    this._otherMic = false;
    this.mixer.setMonitor(localStorage.getItem('rp_hp') !== '0');
    this.guardEcho();
    if (this.state.live) this.mixer.setOnAir(!this.state.paused);
    keepAwake(true);
    this.remote = false;
    this.loadItems();
    clearInterval(this.stateIv);
    this.stateIv = setInterval(() => this.pushStudioState(), 700);
    emit('update');
  },

  // ---------- Sonidos del estudio (los usa la cabina local y el mando a distancia)
  async loadItems(force = false) {
    if (!this.items.length || force) { this.items = await loadAll(); this.soundsSentTo = new Set(); }
    return this.items;
  },
  findItem(key) { return this.items.find((i) => i.origin + ':' + i.id === key); },
  /** Dispara un efecto o pone/quita una música. Devuelve false si no se pudo. */
  async fireSound(key, { cue = false, loop } = {}) {
    if (!this.mixer) return false;
    let it = this.findItem(key);
    if (!it) { await this.loadItems(true); it = this.findItem(key); }
    if (!it) return false;
    const buf = await decode(it);
    if (cue) { this.mixer.cue(buf); return true; }
    if (it.zone === 'fx' || it.zone === 'jingle') {
      const h = this.mixer.playFx(buf, { onEnd: () => { this.fxPlaying.delete(key); emit('sounds'); } });
      this.fxPlaying.set(key, h);
    } else {
      const m = this.mixer.music;
      if (m && m.id === key) this.mixer.stopMusic();
      else this.mixer.playMusic(buf, { loop: loop ?? it.zone === 'bg', id: key, name: it.name, onEnd: () => emit('sounds') });
    }
    emit('sounds');
    return true;
  },
  hasRemote() { return this.people.some((p) => p.owner && p.cid !== this.cid); },
  pushStudioState() {
    if (this.role !== 'host' || !this.mixer || !this.hasRemote()) return;
    const m = this.mixer;
    const owners = this.people.filter((p) => p.owner && p.cid !== this.cid).map((p) => p.cid);
    if (this.items.length && owners.some((c) => !this.soundsSentTo.has(c))) {
      owners.forEach((c) => this.soundsSentTo.add(c));
      const list = this.items.slice(0, 200).map((i) => ({ key: (i.origin + ':' + i.id).slice(0, 60), name: String(i.name).slice(0, 40), zone: i.zone, origin: i.origin, duration: i.duration, section: String(i.section || '').slice(0, 40), src: String(i.src || '').slice(0, 120) }));
      const total = Math.max(1, Math.ceil(list.length / 15));
      for (let k = 0; k < total; k++) this.send({ t: 'studioSounds', s: { part: k, total, items: list.slice(k * 15, k * 15 + 15) } });
    }
    const levels = {}, gains = {}, names = {};
    for (const [id, v] of m.voices) { levels[id] = Math.round(m.voiceLevel(id) * 100) / 100; gains[id] = Math.round(v.gain.gain.value * 100) / 100; names[id] = v.name || ''; }
    const fx = {};
    for (const [k, h] of this.fxPlaying) fx[k] = Math.round(h.progress() * 100) / 100;
    const mu = m.music;
    this.send({ t: 'studioState', s: {
      music: mu ? { key: mu.id, name: mu.name, pos: Math.round(m.musicPosition()), dur: Math.round(mu.duration), loop: mu.loop } : null,
      fx, levels, gains, names, bus: { music: Math.round(m.busLevel('music') * 100) / 100, fx: Math.round(m.busLevel('fx') * 100) / 100, tab: Math.round(m.busLevel('tab') * 100) / 100 },
      musicLevel: m.musicLevel ?? 0.28, fxLevel: Math.round(m.fxBus.gain.value * 100) / 100, tab: m.tabSrc ? Math.round(m.tabBus.gain.value * 100) / 100 : null,
      ducking: m.ducking, solo: m.soloMusic, selfMuted: !!this.voice?.muted, hasVoice: !!this.voice,
      rec: this.rec ? { part: this.rec.part, elapsed: Math.round(this.partElapsed()) } : null,
      partClosed: this.partClosed, lastPart: this.recParts.at(-1)?.part || 0,
    } });
  },
  /** Órdenes del mando a distancia, ejecutadas en el estudio. */
  async runCtl(cmd, a) {
    const m = this.mixer;
    if (!m) return;
    const num = (v, max = 1.5) => Math.max(0, Math.min(max, Number(v) || 0));
    switch (cmd) {
      case 'fire': if (typeof a.key === 'string') await this.fireSound(a.key, { loop: typeof a.loop === 'boolean' ? a.loop : undefined }); break;
      case 'stopMusic': m.stopMusic(); emit('sounds'); break;
      case 'fader':
        if (a.id === 'music') m.setMusicLevel(num(a.v, 1), true);
        else if (a.id === 'fx') m.setFxLevel(num(a.v, 1));
        else if (a.id === 'tab') m.setTabLevel(num(a.v, 1));
        else if (typeof a.id === 'string' && a.id.startsWith('v:')) m.setVoiceGain(a.id.slice(2), num(a.v, 2));
        emit('update');
        break;
      case 'ducking': m.ducking = !!a.on; break;
      case 'guestfx': localStorage.setItem('rp_guestfx', a.on ? '1' : '0'); break;
      case 'solo': m.setSoloMusic(!!a.on); break;
      case 'up': m.musicUp(); break;
      case 'down': m.musicDown(); break;
      case 'selfmute': this.voice?.setMuted(!!a.on); break;
      case 'mutevoice': if (typeof a.cid === 'string') { this.send({ t: 'mute', cid: a.cid, on: !!a.on }); m.muteVoice(a.cid, !!a.on); } break;
      case 'pause': this.pause(!!a.on); break;
      case 'nextpart': if (!this.rec) this.continueNextPart(); break;
      case 'golive':
        if (!this.state.live) {
          if (!this.voice) { try { await this.startVoice(localStorage.getItem('rp_hp') !== '0'); } catch {} }
          this.goLive(['ensayo', 'directo', 'rec'].includes(a.mode) ? a.mode : 'directo', String(a.title || '').slice(0, 80), typeof a.programId === 'string' ? a.programId.slice(0, 40) : '');
          if (typeof a.intro === 'string' && a.intro) this.introJingle(a.intro);
        }
        break;
      case 'end': if (this.state.live) { await this.endBroadcast(true); toast('Has terminado la emisión desde otro aparato. La grabación está en Mi porche → Grabaciones (en el aparato que emitía).'); } break;
    }
    emit('update');
    this.pushStudioState();
  },
  /** Sonido de entrada al salir al aire (el que elijas en el camerino). */
  async introJingle(key) {
    if (!key) return;
    try {
      await this.loadItems();
      const s = this.findItem(key);
      if (s && this.mixer) this.mixer.playFx(await decode(s));
    } catch {}
  },
  ctl(cmd, args = {}) { this.send({ t: 'ctl', cmd, args }); },
  becomeRemote() {
    this.remote = true; this.studioBusy = false;
    if (this.audio) this.audio.muted = !this.hearHere;
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
    this.headphones = headphones;
    if (this.mixer) { this.mixer.addVoice('me', { node: v.node, local: true, name: session.name }); this.mixer.selfVoice = v; this.mixer.syncSelf(); this.mixer.setMonitor(headphones); }
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
  /** Este aparato deja de emitir. Si estaba grabando, la parte SE GUARDA (nunca se tira) antes de apagar nada. */
  teardownStudio() {
    clearInterval(this.stateIv);
    this.fxPlaying.clear();
    const studio = this.studio, mixer = this.mixer, voice = this.voice;
    this.studio = null; this.mixer = null; this.voice = null;
    const saving = this.rec ? this.stopRecorder(true).then((it) => { if (it) toast(`Parte ${it.part} guardada en Grabaciones de este aparato.`, 'good'); }) : Promise.resolve();
    return saving.catch(() => {}).finally(() => { studio?.closeAll(); mixer?.destroy(); voice?.stop(); });
  },

  goLive(mode, title, programId = '') {
    this.programId = programId || '';
    this.series = uid();
    this.recParts = [];
    this.warned = {};
    this.send({ t: 'golive', mode, title, programId: this.programId });
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
    this.rec = { id: uid(), created: Date.now(), mr, chunks, part, start: Date.now(), pausedMs: 0, pausedAt: 0, mime: (mime || 'audio/webm').split(';')[0] };
    // Copia de seguridad cada 30 s: si el aparato se apaga, se cuelga o el navegador lo cierra, lo grabado no se pierde
    const r0 = this.rec;
    r0.saveIv = setInterval(() => this.saveProgress(r0), 30_000);
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
  recItem(r, extra = {}) {
    return {
      id: r.id, kind: 'draft', created: r.created, title: this.state.title || 'Programa sin título', description: '',
      part: r.part, series: this.series, duration: (Date.now() - r.start - r.pausedMs - (r.pausedAt ? Date.now() - r.pausedAt : 0)) / 1000,
      mime: r.mime, blob: new Blob(r.chunks, { type: r.mime }), scene: this.porch?.scene || 1, porchName: this.porch?.name || '', chapters: [],
      programId: this.programId || '', ...extra,
    };
  },
  async saveProgress(r) {
    if (this.rec !== r || !r.chunks.length) return;
    try { await db.put('recordings', this.recItem(r, { partial: true })); } catch {}
  },
  async stopRecorder(save) {
    clearInterval(this.recIv);
    const r = this.rec;
    if (!r) return null;
    this.rec = null;
    clearInterval(r.saveIv);
    const duration = (Date.now() - r.start - r.pausedMs - (r.pausedAt ? Date.now() - r.pausedAt : 0)) / 1000;
    const done = new Promise((res) => (r.mr.onstop = res));
    try { r.mr.stop(); } catch {}
    await Promise.race([done, new Promise((res) => setTimeout(res, 3000))]);
    if (!save) { try { await db.del('recordings', r.id); } catch {} return null; }
    if (!r.chunks.length) return null;
    const item = { ...this.recItem(r), duration };
    try { await db.put('recordings', item); this.recParts.push(item); } catch { toast('No se ha podido guardar la grabación en este aparato', 'bad'); }
    // Emitiendo desde el ordenador: la grabación llega sola a tu móvil (tu casa). En el ordenador también se queda.
    if (DEVICE_KIND === 'ordenador' && hasUsed('móvil')) sendRecording(item, 'móvil', { quiet: true }).then((ok) => { if (ok) toast(`Parte ${item.part} enviada a tu móvil.`, 'good'); });
    emit('update');
    return item;
  },
};

// Si el móvil se bloquea o se cambia de app mientras se emite: aviso grande y reconexión.
document.addEventListener('visibilitychange', () => {
  if (!live.active) return;
  if (live.isOwner) live.send({ t: 'vis', v: document.visibilityState === 'visible' });
  if (document.visibilityState === 'hidden') {
    if (live.speaking) live.wasHidden = Date.now();
    // El móvil que emite se va a dormir o cambias de app: si tienes el ordenador conectado, emite él.
    if (live.role === 'host' && live.kind === 'móvil' && !live.state.paused) {
      const pc = live.myOtherDevices().find((d) => d.kind === 'ordenador');
      if (pc) live.send({ t: 'handoff', to: pc.cid });
    }
  } else {
    if (live.speaking) keepAwake(true);
    if (live.wasHidden) { emit('resumed', Date.now() - live.wasHidden); live.wasHidden = 0; }
    if (!live.ws || live.ws.readyState > 1) { live.closedByUser = false; live.open(); }
    else if (live.role !== 'host' && live.rtcState && live.rtcState !== 'connected') { live.peer?.close(); live.want(); }
  }
});

// Han llegado sonidos de tu otro aparato: el Estudio los recarga para la botonera
window.addEventListener('rp:inbox', (e) => { if (e.detail?.snds && live.items.length) live.loadItems(true).then(() => emit('sounds')).catch(() => {}); });
