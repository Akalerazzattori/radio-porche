// WebRTC en estrella con centro en el estudio. La señalización va por el WebSocket de la sala.
import { ICE_SERVERS } from '../config.js';

const HI = 64000, LO = 32000;

function tuneSender(sender, bitrate) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = bitrate;
    p.encodings[0].priority = 'high';
    p.encodings[0].networkPriority = 'high';
    return sender.setParameters(p).catch(() => {});
  } catch {}
}

/** Calidad adaptable: baja el bitrate si hay pérdidas o mucho retardo, y lo recupera. */
function adapt(pc, getSender) {
  let level = HI, good = 0, lastLost = 0, lastSent = 0;
  const iv = setInterval(async () => {
    if (pc.connectionState === 'closed') { clearInterval(iv); return; }
    const s = getSender();
    if (!s) return;
    try {
      const st = await pc.getStats();
      let lost = 0, sent = 0, rtt = 0;
      st.forEach((r) => {
        if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') { lost = r.packetsLost || 0; rtt = r.roundTripTime || 0; }
        if (r.type === 'outbound-rtp' && r.kind === 'audio') sent = r.packetsSent || 0;
      });
      const dl = lost - lastLost, ds = sent - lastSent;
      lastLost = lost; lastSent = sent;
      const loss = ds > 0 ? dl / ds : 0;
      if ((loss > 0.05 || rtt > 0.45) && level !== LO) { level = LO; good = 0; tuneSender(s, LO); }
      else if (loss < 0.01 && rtt < 0.25) { good++; if (good > 6 && level !== HI) { level = HI; tuneSender(s, HI); } }
    } catch {}
  }, 5000);
  return () => clearInterval(iv);
}

/** Lado estudio: una conexión por oyente/invitado. */
export class StudioPeers {
  constructor(sendSignal, { onVoice, onVoiceGone, onState } = {}) {
    this.send = sendSignal;
    this.peers = new Map(); // cid -> {pc, role, mode, stop}
    this.onVoice = onVoice; this.onVoiceGone = onVoiceGone; this.onState = onState;
  }

  /** role: listener | guest ; outStream: lo que le mandamos. */
  async connect(cid, role, outStream) {
    this.close(cid);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
    const track = outStream.getAudioTracks()[0];
    const tr = pc.addTransceiver(track, { direction: role === 'guest' ? 'sendrecv' : 'sendonly', streams: [outStream] });
    const peer = { pc, role, tr, restarts: 0 };
    this.peers.set(cid, peer);
    pc.onicecandidate = (e) => e.candidate && this.send(cid, { type: 'ice', candidate: e.candidate });
    pc.ontrack = (e) => {
      if (role !== 'guest') return;
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.onVoice?.(cid, stream);
    };
    pc.onconnectionstatechange = () => {
      this.onState?.(cid, pc.connectionState);
      if (pc.connectionState === 'failed' && peer.restarts < 3) { peer.restarts++; this.offer(cid, true); }
    };
    peer.stop = adapt(pc, () => tr.sender);
    tuneSender(tr.sender, HI);
    await this.offer(cid);
  }

  async offer(cid, iceRestart = false) {
    const p = this.peers.get(cid);
    if (!p) return;
    const o = await p.pc.createOffer({ iceRestart });
    await p.pc.setLocalDescription(o);
    this.send(cid, { type: 'offer', sdp: p.pc.localDescription.sdp });
  }

  async onSignal(from, data) {
    const p = this.peers.get(from);
    if (!p || !data) return;
    try {
      if (data.type === 'answer' && typeof data.sdp === 'string') await p.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      else if (data.type === 'ice' && data.candidate) await p.pc.addIceCandidate(data.candidate);
    } catch (e) { console.warn('señal', e); }
  }

  replaceOutput(cid, stream) {
    const p = this.peers.get(cid);
    if (p) p.tr.sender.replaceTrack(stream.getAudioTracks()[0]);
  }

  close(cid) {
    const p = this.peers.get(cid);
    if (!p) return;
    p.stop?.();
    try { p.pc.close(); } catch {}
    this.peers.delete(cid);
    if (p.role === 'guest') this.onVoiceGone?.(cid);
  }
  closeAll() { for (const cid of [...this.peers.keys()]) this.close(cid); }
  count(role) { let n = 0; for (const p of this.peers.values()) if (!role || p.role === role) n++; return n; }
}

/** Lado oyente/invitado: una sola conexión con el estudio. */
export class ClientPeer {
  constructor(sendSignal, { onStream, onState } = {}) {
    this.send = sendSignal;
    this.onStream = onStream; this.onState = onState;
    this.pc = null; this.host = null; this.micTrack = null;
  }
  setMic(track) {
    this.micTrack = track;
    const tr = this.pc?.getTransceivers()[0];
    if (tr && track) { tr.sender.replaceTrack(track); }
  }
  async onSignal(from, data) {
    if (!data) return;
    if (data.type === 'offer') {
      if (!this.pc || this.host !== from || this.pc.signalingState === 'closed') this.reset(from);
      const pc = this.pc;
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const tr = pc.getTransceivers()[0];
        if (tr && this.micTrack) {
          await tr.sender.replaceTrack(this.micTrack);
          tr.direction = 'sendrecv';
          tuneSender(tr.sender, HI);
        }
        const a = await pc.createAnswer();
        await pc.setLocalDescription(a);
        this.send(from, { type: 'answer', sdp: pc.localDescription.sdp });
      } catch (e) { console.warn('oferta', e); }
    } else if (data.type === 'ice' && data.candidate && this.pc) {
      try { await this.pc.addIceCandidate(data.candidate); } catch {}
    }
  }
  reset(host) {
    this.close();
    this.host = host;
    const pc = (this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }));
    pc.onicecandidate = (e) => e.candidate && this.send(host, { type: 'ice', candidate: e.candidate });
    pc.ontrack = (e) => this.onStream?.(e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => this.onState?.(pc.connectionState);
    this.stopAdapt = adapt(pc, () => pc.getTransceivers()[0]?.sender);
  }
  close() {
    this.stopAdapt?.();
    try { this.pc?.close(); } catch {}
    this.pc = null;
  }
}
