// Pantalla de un porche: Oyente (con chat y pedir micro), Invitado con micro,
// Camerino (antes de salir) y Cabina (en directo) para quien presenta.
import { api, session } from '../api.js';
import { LIMITS, VOICE_FX, BROADCAST_MODES, QUICK_REACTIONS, ZONES } from '../config.js';
import { html, mount, icon, raw, toast, sheet, confirmSheet, fmtTime, fmtShortDur, fmtDate, initial, avatarColor, haptic, canShareTab, setPct, esc, on } from '../util.js';
import { porchCover, requireIdentity, personMenu, shareUrl, isBlocked, nameColor, copy } from '../common.js';
import { live, onLive } from '../live.js';
import { meterHtml, setMeter, audioCtx } from '../audio/voice.js';
import { loadAll, decode } from '../audio/sounds.js';
import { getSetting, setSetting } from '../db.js';

export async function render(view, [slug], ctx) {
  const params = new URLSearchParams(location.search);
  let porch;
  try {
    porch = slug === '__mine' ? (await api('/api/me')).porch : (await api(`/api/porch/${encodeURIComponent(slug)}`)).porch;
    if (!porch) throw new Error('Aún no tienes porche');
  } catch (e) {
    mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Porche</h1><button class="icon-btn" data-act="x">${icon('close')}</button></div><div class="empty"><img src="/img/scenes/escena-2.webp" alt=""><p>${e.message}</p></div></section>`);
    view.querySelector('[data-act=x]').onclick = ctx.back;
    return;
  }
  document.title = `${porch.freq.toFixed(1)} · ${porch.name} · Radio Porche`;
  const invite = params.get('i') || '';
  const mod = params.get('m') || '';
  if (!live.active || live.porch?.id !== porch.id) {
    live.fatal = null;
    live.connect(porch, { invite, mod });
  }

  let mode = '';
  let cleanup = [];
  const offs = [];
  const sub = (ev, fn) => offs.push(onLive(ev, fn));

  function decide() {
    if (live.fatal) return 'fatal';
    if (!live.role) return 'loading';
    if (live.role === 'host') return live.state.live ? 'cabina' : 'camerino';
    return 'oyente';
  }
  function build() {
    cleanup.forEach((f) => f()); cleanup = [];
    mode = decide();
    if (mode === 'loading') mount(view, html`<section class="screen"><div class="top"><div><h1 class="h1">${porch.name}</h1><div class="sub mono">${porch.freq.toFixed(1)} FM</div></div><button class="icon-btn" data-act="x">${icon('close')}</button></div><div class="empty"><div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><p>Sintonizando…</p></div></section>`);
    else if (mode === 'fatal') mount(view, html`<section class="screen"><div class="top"><h1 class="h1">${porch.name}</h1><button class="icon-btn" data-act="x">${icon('close')}</button></div><div class="empty"><img src="/img/scenes/escena-4.webp" alt=""><p>${live.fatal.msg}</p><button class="btn ghost" data-act="x">Volver</button></div></section>`);
    else if (mode === 'oyente') cleanup.push(buildListener(view, porch, ctx));
    else if (mode === 'camerino') cleanup.push(buildGreenRoom(view, porch, ctx));
    else if (mode === 'cabina') cleanup.push(buildBooth(view, porch, ctx));
    view.querySelectorAll('[data-act=x]').forEach((b) => (b.onclick = () => leave()));
  }
  function leave() {
    if (live.role === 'host' && live.state.live) { ctx.go('/'); return; } // el directo sigue
    if (live.role === 'guest') { ctx.go('/'); return; }
    if (live.role !== 'host') { ctx.go('/'); return; } // oyente: sigue sonando en el mini reproductor
    live.disconnect(); ctx.go('/mi-porche');
  }
  sub('update', () => { if (decide() !== mode) build(); });
  sub('studioBusy', () => studioBusySheet());
  sub('resumed', (ms) => resumedOverlay(ms));
  build();

  if (params.get('micro') === '1' && !live.speaking) {
    const off = onLive('update', () => { if (live.role === 'listener') { off(); setTimeout(() => micRequestSheet(), 300); } });
    offs.push(off);
  }
  return () => { cleanup.forEach((f) => f()); offs.forEach((f) => f()); };
}

// ============================================================ comunes
function studioBusySheet() {
  sheet(html`
    <h2 class="h2">Ya estás emitiendo desde otro dispositivo</h2>
    <p class="muted">Solo puede haber un estudio a la vez. ¿Qué quieres hacer en este?</p>
    <button class="btn red" data-close="take">Pasar el estudio a este</button>
    <button class="btn yellow" data-close="patio">Entrar como micro (modo Patio)</button>
    <button class="btn ghost" data-close="listen">Solo escuchar</button>`, { dismissable: false }).done.then((v) => {
    if (v === 'take') live.takeStudio();
    else if (v === 'patio') live.ownerAsGuest(true);
    else if (live.audio) live.audio.muted = false;
  });
}

function resumedOverlay(ms) {
  const el = document.createElement('div');
  el.className = 'full-overlay';
  el.innerHTML = `<div class="h1">¡Has vuelto!</div><p class="b">${ms > 4000 ? 'Mientras el móvil estaba bloqueado o en otra app, el audio pudo cortarse.' : 'Has cambiado de app un momento.'}</p><p class="muted">Reconectando automáticamente… Para no cortar, deja la app abierta y la pantalla encendida mientras emites.</p><button class="btn yellow big">Entendido</button>`;
  document.body.appendChild(el);
  el.querySelector('button').onclick = () => el.remove();
  setTimeout(() => el.remove(), 6000);
}

function chatMsgHtml(m) {
  if (m.sys) return `<div class="msg sys">${esc(m.text)} · ${new Date(m.ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>`;
  if (isBlocked(m.dev)) return '';
  const cls = ['msg'];
  if (m.host) cls.push('host');
  if (m.dev && m.dev === session.deviceId) cls.push('mine');
  return `<div class="${cls.join(' ')}" data-mid="${esc(m.id)}"><b class="${m.host ? 'yellow-t' : nameColor(m.dev)}" data-who="${esc(m.id)}">${esc(m.name)}${m.mod ? ' 🛡' : ''}</b>${esc(m.text)}</div>`;
}

function mountChat(box, canMod) {
  const paint = () => {
    box.innerHTML = live.chat.map(chatMsgHtml).join('');
    box.scrollTop = box.scrollHeight;
  };
  paint();
  const off1 = onLive('chat', (m) => {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.insertAdjacentHTML('beforeend', chatMsgHtml(m));
    while (box.children.length > 150) box.firstChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  });
  const onBlock = () => paint();
  window.addEventListener('rp:blocked', onBlock);
  box.addEventListener('click', (e) => {
    const w = e.target.closest('[data-who]');
    if (!w) return;
    const m = live.chat.find((x) => x.id === w.dataset.who);
    if (!m || (m.dev === session.deviceId && !canMod)) return;
    personMenu({
      name: m.name, dev: m.dev, cid: m.cid, msg: m, canMod: canMod && m.dev !== session.deviceId, isHost: live.role === 'host',
      onMod: (act, x) => {
        if (act === 'pin') live.send({ t: 'pin', text: `${m.name}: ${m.text}` });
        if (act === 'mute') live.send({ t: 'mute', cid: x.cid, on: true });
        if (act === 'kick' || act === 'ban') live.send({ t: 'kick', cid: x.cid, ban: act === 'ban' });
      },
    });
  });
  return () => { off1(); window.removeEventListener('rp:blocked', onBlock); };
}

function sendChat(input) {
  const text = input.value.trim();
  if (!text) return;
  if (!session.token) { requireIdentity('Para escribir en el chat, entra con tu nombre.').then((ok) => ok && reconnectWithIdentity()); return; }
  live.send({ t: 'chat', text: text.slice(0, LIMITS.CHAT_MAX) });
  input.value = '';
}
function reconnectWithIdentity() {
  const p = live.porch, o = live.opts;
  live.disconnect();
  live.connect(p, o);
}

function floatReaction(root, e) {
  const el = document.createElement('div');
  el.className = 'float-react';
  el.textContent = e;
  el.style.setProperty('--dx', String(Math.round((Math.random() - 0.5) * 80)));
  root.appendChild(el);
  setTimeout(() => el.remove(), 2100);
}

/** Desplegable de voz: Mejorada / Efectos ▾ */
function voiceSelector(getVoice) {
  return {
    tpl: html`
      <div class="seg dark" data-el="vsel">
        <button data-v="" class="on">${icon('check')} Mejorada</button>
        <button data-v="fx">Efectos ▾</button>
      </div>
      <div class="muted tiny" data-el="vdesc">Locución limpia de estudio, con presencia.</div>`,
    async bind(root) {
      const seg = root.querySelector('[data-el=vsel]');
      const desc = root.querySelector('[data-el=vdesc]');
      const cur = await getSetting('voiceFx', null);
      const paint = (id) => {
        const fx = VOICE_FX.find((f) => f.id === id);
        seg.children[0].classList.toggle('on', !fx);
        seg.children[1].classList.toggle('on', !!fx);
        seg.children[0].innerHTML = (!fx ? '✓ ' : '') + 'Mejorada';
        seg.children[1].textContent = fx ? `${fx.name} ▾` : 'Efectos ▾';
        desc.textContent = fx ? `Efecto ${fx.name.toLowerCase()}: ${fx.hint}.` : 'Locución limpia de estudio, con presencia.';
      };
      paint(cur);
      seg.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-v]');
        if (!b) return;
        if (b.dataset.v === '') { await setSetting('voiceFx', null); getVoice()?.setEffect(null); paint(null); return; }
        const choice = await sheet(html`<div class="h3">Efectos</div>${VOICE_FX.map((f) => html`<button class="opt" data-close="${f.id}"><span class="grow b">${f.name}</span><span class="mono small muted">${f.hint}</span></button>`)}`).done;
        if (!choice) return;
        await setSetting('voiceFx', choice);
        getVoice()?.setEffect(choice);
        paint(choice);
      });
    },
  };
}

function micRequestSheet() {
  if (!session.token) { requireIdentity('Para pedir micro, entra con tu nombre.').then((ok) => ok && reconnectWithIdentity()); return; }
  const rec = live.state.rec;
  sheet(html`
    <h2 class="h2">Pedir micro</h2>
    ${rec ? html`<div class="banner red">${icon('rec')} Este programa se está grabando y puede publicarse.</div>` : ''}
    <div class="h3">¿Dónde estás?</div>
    <label class="radio-opt"><input type="radio" name="m" value="patio"><div><div class="t">Patio</div><div class="d">Estoy junto al presentador. Mi móvil es solo micro (no suena la emisión).</div></div></label>
    <label class="radio-opt"><input type="radio" name="m" value="casa" checked><div><div class="t">Casa</div><div class="d">Lo escucho desde mi casa. Oigo la emisión por cascos.</div></div></label>
    <label class="check"><input type="checkbox" name="hp" checked><span>${icon('hp')} Llevo <b>cascos</b> (de cable o Bluetooth). Como en una radio de verdad: todo el que habla lleva cascos.</span></label>
    ${rec ? html`<label class="check"><input type="checkbox" name="ok"><span>Sé que se está grabando y acepto que mi voz se grabe y pueda publicarse.</span></label>` : ''}
    <p class="muted tiny">Con wifi va casi siempre. Con datos móviles, alguna conexión directa puede fallar.</p>
    <button class="btn red big" data-a="go">${icon('mic')} Pedir micro</button>`, {
    onMount(a) {
      a.el.querySelector('[data-a=go]').onclick = () => {
        if (rec && !a.el.querySelector('input[name=ok]').checked) return toast('Acepta el aviso de grabación para entrar al micro', 'bad');
        const m = a.el.querySelector('input[name=m]:checked').value;
        const hp = a.el.querySelector('input[name=hp]').checked;
        if (!hp && m === 'casa') toast('Sin cascos activamos la cancelación de eco, pero puede acoplarse.');
        live.requestMic(m, hp);
        toast('Petición enviada. Espera a que te den paso.', 'good');
        a.close('ok');
      };
    },
  });
}

// ============================================================ OYENTE (+ invitado)
function buildListener(view, porch, ctx) {
  const st = live.state;
  mount(view, html`
    <section class="screen">
      <div class="top">
        <button class="icon-btn" data-act="x" aria-label="Salir">${icon('down')}</button>
        <div class="grow center"><span class="h1 small"><span>${porch.freq.toFixed(1)}</span></span></div>
        <span data-el="livechip"></span>
      </div>
      <div class="live-cover">
        <img src="${porchCover(porch)}" alt="">
        <div class="inner">
          <span class="chip freq" data-el="when"></span>
          <div class="ttl" data-el="title"></div>
        </div>
      </div>
      <div class="row between">
        <div class="row gap-s"><div class="avs" data-el="avs"></div><span class="small"><b class="yellow-t" data-el="n">0</b> escuchando</span></div>
        <div class="row gap-s">
          <button class="btn sm ghost" data-act="share" aria-label="Compartir">${icon('share')}</button>
          <div class="wave" data-el="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        </div>
      </div>
      <div class="pinned" data-el="pinned" hidden></div>
      <div class="chat" data-el="chat" aria-live="polite"></div>
      <div class="reacts">${QUICK_REACTIONS.slice(0, 3).map((e) => html`<button data-react="${e}" aria-label="Reaccionar ${e}">${e}</button>`)}</div>
      <div data-el="bottom"></div>
    </section>`);
  const $el = (n) => view.querySelector(`[data-el=${n}]`);
  const section = view.querySelector('.screen');
  const offChat = mountChat($el('chat'), live.isMod);
  let meterRaf = 0, bottomMode = '';

  function paint() {
    const s = live.state;
    mount($el('livechip'), s.live && s.mode !== 'ensayo' ? html`<span class="live-chip">En directo</span>` : s.live ? html`<span class="live-chip off">Ensayo</span>` : html`<span class="live-chip off">Apagado</span>`);
    $el('when').textContent = s.live ? `${fmtDate(s.since).toUpperCase()} · ${porch.name.toUpperCase()}` : porch.name.toUpperCase();
    $el('title').textContent = s.live ? s.title || porch.name : s.hostOnline ? 'Empieza en breve' : porch.nextShow ? `Vuelve ${porch.nextShow}` : 'Aún no ha empezado';
    $el('n').textContent = live.counts.listeners;
    const guests = live.people.filter((p) => p.role === 'guest' || p.role === 'host').slice(0, 4);
    $el('avs').innerHTML = guests.map((g) => `<span class="av sm ${avatarColor(g.name)}">${esc(initial(g.name))}</span>`).join('');
    $el('wave').classList.toggle('stop', !(s.live && !s.paused && live.rtcState === 'connected'));
    const pin = $el('pinned');
    pin.hidden = !s.pinned;
    if (s.pinned) pin.innerHTML = `📌 <b class="yellow-t">${esc(s.pinned.name)}</b> ${esc(s.pinned.text)}`;
    paintBottom();
  }

  function paintBottom() {
    const me = live.people.find((p) => p.cid === live.cid);
    const want = live.role === 'guest' ? 'guest' : me?.micReq ? 'waiting' : 'composer';
    if (want === bottomMode) { if (want === 'guest') paintGuestState(); return; }
    bottomMode = want;
    cancelAnimationFrame(meterRaf);
    const b = $el('bottom');
    if (want === 'composer') {
      mount(b, html`<div class="composer">
        <input class="input" maxlength="${LIMITS.CHAT_MAX}" placeholder="Escribe al porche…" enterkeyhint="send" aria-label="Mensaje">
        <button class="btn red" data-act="mic">${icon('mic')} Pedir micro</button></div>`);
      const inp = b.querySelector('input');
      inp.addEventListener('keydown', (e) => e.key === 'Enter' && sendChat(inp));
    } else if (want === 'waiting') {
      mount(b, html`<div class="banner dash"><span class="grow">${icon('mic')} Has pedido micro${me.micReq.mode === 'patio' ? ' · patio' : ' · desde casa'}. Esperando paso…</span><button class="btn sm ghost" data-act="cancelmic">Cancelar</button></div>`);
    } else {
      const vs = voiceSelector(() => live.guestVoice);
      mount(b, html`<div class="mic-panel">
        <div class="row between gap">
          <div class="row gap-s"><span class="chip ${live.guestMode}">${live.guestMode === 'patio' ? 'Patio · solo micro' : 'Casa · cascos'}</span>${live.state.rec ? html`<span class="rec-chip">REC</span>` : ''}</div>
          <button class="btn sm ghost" data-act="leavemic">Dejar el micro</button>
        </div>
        ${raw(meterHtml())}
        ${vs.tpl}
        <div class="row gap">
          <label class="row gap-s grow small"><span class="switch"><input type="checkbox" data-act="monitor"><span></span></span> Oírme <span class="muted tiny">(con cascos de cable suena sin retraso)</span></label>
          <button class="mic-btn" data-act="selfmute" aria-label="Silenciarme">${icon('mic')}</button>
        </div>
        <div class="composer"><input class="input" maxlength="${LIMITS.CHAT_MAX}" placeholder="Escribe al porche…" aria-label="Mensaje"></div>
      </div>`);
      vs.bind(b);
      const inp = b.querySelector('.composer input');
      inp.addEventListener('keydown', (e) => e.key === 'Enter' && sendChat(inp));
      const meter = b.querySelector('.meter');
      const loop = () => { setMeter(meter, live.guestVoice?.level() || 0); meterRaf = requestAnimationFrame(loop); };
      loop();
      paintGuestState();
    }
  }
  function paintGuestState() {
    const btn = view.querySelector('[data-act=selfmute]');
    if (!btn) return;
    const muted = live.guestVoice?.muted;
    btn.classList.toggle('off', !!muted);
    mount(btn, icon(muted ? 'micoff' : 'mic'));
    if (live.mutedByHost) btn.disabled = true; else btn.disabled = false;
  }

  section.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act],[data-react]');
    if (!b) return;
    if (b.dataset.react) { live.send({ t: 'react', e: b.dataset.react }); return; }
    switch (b.dataset.act) {
      case 'mic': micRequestSheet(); break;
      case 'cancelmic': live.cancelMic(); break;
      case 'leavemic': live.leaveMic(); break;
      case 'selfmute': if (!live.mutedByHost) { live.guestVoice?.setMuted(!live.guestVoice.muted); paintGuestState(); } break;
      case 'share': shareUrl(`${location.origin}/porche/${porch.slug}`, porch.name); break;
    }
  });
  section.addEventListener('change', (e) => {
    if (e.target.matches('[data-act=monitor]')) live.guestVoice?.setMonitor(e.target.checked);
  });
  const offs = [onLive('update', paint), onLive('react', (e) => floatReaction(section, e)), onLive('needTap', () => {
    const el = document.createElement('div');
    el.className = 'full-overlay';
    el.innerHTML = '<div class="h1">Toca para escuchar</div><button class="btn red big">▶ Escuchar</button>';
    document.body.appendChild(el);
    el.onclick = () => { live.audio?.play().catch(() => {}); el.remove(); };
  })];
  paint();
  return () => { offs.forEach((f) => f()); offChat(); cancelAnimationFrame(meterRaf); };
}

// ============================================================ CAMERINO
function buildGreenRoom(view, porch, ctx) {
  let chosen = 'rec';
  let headphones = localStorage.getItem('rp_hp') !== '0';
  mount(view, html`
    <section class="screen">
      <div class="top">
        <div class="grow"><h1 class="h1">Camerino</h1><div class="sub ellip">${porch.name} · <span class="mono">${porch.freq.toFixed(1)}</span></div></div>
        <button class="icon-btn" data-act="x" aria-label="Cerrar">${icon('close')}</button>
      </div>
      <div class="banner teal" data-el="status">${icon('lock')} <span>Aún no estás en el aire</span></div>
      <div class="fill scroll col gap">
        <div class="card col gap-s">
          <div class="row between"><b>Tu voz</b><span class="muted small" data-el="probe">Toca «Probar micro»</span></div>
          ${raw(meterHtml())}
          <div data-el="voice"></div>
          <div class="row gap wrap">
            <button class="btn sm yellow" data-act="startmic">${icon('mic')} Probar micro</button>
            <label class="row gap-s small"><span class="switch"><input type="checkbox" data-act="hp" ${headphones ? 'checked' : ''}><span></span></span> Llevo cascos</label>
            <label class="row gap-s small"><span class="switch"><input type="checkbox" data-act="monitor"><span></span></span> Oírme</label>
          </div>
          <div class="muted tiny">«Oírme» viene apagado: con Bluetooth hay unas décimas de retraso. Con cascos de cable suena sin retraso.</div>
        </div>
        <input class="input" data-el="title" maxlength="${LIMITS.TITLE_MAX}" placeholder="Título del programa (p. ej. La tarde del porche #42)" value="${localStorage.getItem('rp_lasttitle') || ''}">
        <div class="h3">¿Cómo sales?</div>
        <div class="modes">${BROADCAST_MODES.map((m) => html`
          <label class="radio-opt"><input type="radio" name="mode" value="${m.id}" ${m.id === chosen ? 'checked' : ''}><div class="grow"><div class="t">${m.name}</div><div class="d">${m.hint}</div></div>${m.id === 'rec' ? html`<span class="rec-chip">REC</span>` : ''}</label>`)}</div>
        <div class="row between"><div class="h3">Cortes cargados</div><span class="yellow-t b" data-el="ncortes"></span></div>
        <a class="cassettes" href="/mi-porche?tab=sonidos">
          ${[1, 2, 3, 4].map((n) => html`<img src="/img/cassettes/cassette-${n}.webp" alt="" width="64" height="38">`)}
          <span class="muted small" data-el="more"></span>
        </a>
        <div class="row between"><div class="h3">Contigo en el camerino</div><button class="yellow-t b small" data-act="invite">Invitar</button></div>
        <div class="col gap-s" data-el="guests"></div>
        <div class="col gap-s" data-el="reqs"></div>
      </div>
      <button class="hold" data-el="hold" aria-label="Mantén pulsado para salir al aire"><i class="fillbar"></i><span class="num" data-el="num">3</span><span>Mantén para salir</span></button>
      <div class="muted tiny center">Quien entre al micro verá que se está grabando</div>
    </section>`);
  const $el = (n) => view.querySelector(`[data-el=${n}]`);
  const vs = voiceSelector(() => live.voice);
  mount($el('voice'), vs.tpl);
  vs.bind($el('voice'));
  let raf = 0;
  const meter = view.querySelector('.meter');
  const loop = () => { const l = live.voice?.level() || 0; setMeter(meter, l); if (live.voice) $el('probe').textContent = l > 0.1 ? '¡Te oigo!' : 'Prueba: habla ahora'; raf = requestAnimationFrame(loop); };
  loop();

  loadAll().then((items) => {
    const fx = items.filter((i) => i.zone === 'fx');
    $el('ncortes').textContent = fx.length;
    $el('more').textContent = items.length > 4 ? `+${items.length - 4} en tu biblioteca` : 'Añadir sonidos';
  });

  async function startMic() {
    try {
      audioCtx();
      await live.startVoice(headphones);
      view.querySelector('[data-act=startmic]').textContent = '✓ Micro listo';
      return true;
    } catch { toast('No se ha podido abrir el micro. Revisa los permisos del navegador.', 'bad'); return false; }
  }

  function paint() {
    const waiting = live.counts.listeners;
    $el('status').innerHTML = `${icon('lock').html} <span>Aún no estás en el aire · ${waiting} ${waiting === 1 ? 'persona espera' : 'personas esperan'}</span>`;
    const guests = live.people.filter((p) => p.role === 'guest');
    mount($el('guests'), guests.length ? html`<div class="row gap wrap">${guests.map((g) => html`
      <div class="guest-chip"><span class="av ${avatarColor(g.name)}">${initial(g.name)}</span><div><div class="n">${g.name}</div><div class="d">${g.mode === 'patio' ? 'Patio · sin retorno' : 'Casa · cascos'}</div></div></div>`)}</div>`
      : html`<div class="muted small">Nadie aún. Pulsa «Invitar» y manda el enlace a tus amigos.</div>`);
    const reqs = live.people.filter((p) => p.micReq);
    mount($el('reqs'), html`${reqs.map((r) => html`<div class="banner dash req"><span class="grow"><b class="orange-t">${r.name}</b> pide micro · ${r.micReq.mode === 'patio' ? 'en el patio' : 'desde casa'}${r.micReq.hp ? '' : ' (sin cascos)'}</span><button class="btn sm yellow" data-grant="${r.cid}">Dar paso</button></div>`)}`);
  }

  // Botón "Mantén para salir": cuenta atrás 3-2-1 con sintonía. Nada sale sin querer.
  const hold = $el('hold');
  let holdT = null, holdStart = 0, holdRaf = 0;
  const beep = (f, d = 0.12) => { try { const c = audioCtx(); const o = c.createOscillator(); const g = c.createGain(); o.frequency.value = f; g.gain.value = 0.15; o.connect(g); g.connect(c.destination); o.start(); g.gain.setTargetAtTime(0, c.currentTime + d * 0.6, 0.03); o.stop(c.currentTime + d + 0.1); } catch {} };
  let lastN = 4;
  const tick = () => {
    const k = Math.min(1, (performance.now() - holdStart) / 3000);
    hold.style.setProperty('--k', String(k));
    const n = Math.max(1, 3 - Math.floor(k * 3));
    $el('num').textContent = n;
    if (n !== lastN) { lastN = n; beep(n === 1 ? 880 : 660); haptic(25); }
    if (k >= 1) { done(); return; }
    holdRaf = requestAnimationFrame(tick);
  };
  const cancel = () => { cancelAnimationFrame(holdRaf); hold.style.setProperty('--k', '0'); $el('num').textContent = '3'; lastN = 4; holdStart = 0; };
  hold.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    hold.setPointerCapture(e.pointerId);
    if (!live.voice && !(await startMic())) return;
    holdStart = performance.now(); lastN = 4; tick();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => hold.addEventListener(ev, () => { if (holdStart) cancel(); }));
  hold.addEventListener('contextmenu', (e) => e.preventDefault());
  async function done() {
    cancelAnimationFrame(holdRaf);
    const title = $el('title').value.trim();
    localStorage.setItem('rp_lasttitle', title);
    const modeSel = view.querySelector('input[name=mode]:checked').value;
    live.goLive(modeSel, title);
    // sintonía de entrada
    try {
      const items = await loadAll();
      const s = items.find((i) => i.id === 'sintonia') || items.find((i) => i.zone === 'fx');
      if (s && live.mixer) live.mixer.playFx(await decode(s));
    } catch {}
    beep(1200, 0.3);
  }

  view.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-grant]');
    if (g) { live.send({ t: 'grant', cid: g.dataset.grant }); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'startmic') startMic();
    if (b.dataset.act === 'invite') inviteSheet(porch);
  });
  view.addEventListener('change', async (e) => {
    if (e.target.matches('[data-act=hp]')) {
      headphones = e.target.checked; localStorage.setItem('rp_hp', headphones ? '1' : '0');
      if (!headphones) toast('Sin cascos activamos la cancelación de eco (algo menos de calidad).');
      if (live.voice) await live.startVoice(headphones);
    }
    if (e.target.matches('[data-act=monitor]')) live.voice?.setMonitor(e.target.checked);
  });
  const off = onLive('update', paint);
  paint();
  return () => { off(); cancelAnimationFrame(raf); cancelAnimationFrame(holdRaf); };
}

function inviteSheet(porch) {
  const link = `${location.origin}/porche/${porch.slug}?i=${encodeURIComponent(live.inviteKey)}&micro=1`;
  sheet(html`
    <h2 class="h2">Invitar al micro</h2>
    <p class="muted small">Manda este enlace a quien quieras en el programa (también sirve para los ensayos privados). Al abrirlo podrá pedir micro y elegir <b>Patio</b> o <b>Casa</b>.</p>
    <div class="card mono tiny ellip">${link}</div>
    <button class="btn yellow" data-a="share">${icon('share')} Enviar enlace</button>
    <button class="btn ghost" data-a="rotate">Cambiar enlace (anula el anterior)</button>`, {
    onMount(a) {
      a.el.querySelector('[data-a=share]').onclick = () => shareUrl(link, `Ven a ${porch.name}`);
      a.el.querySelector('[data-a=rotate]').onclick = () => { live.send({ t: 'rotateInvite' }); a.close(); toast('Enlace nuevo creado. Vuelve a pulsar Invitar.'); };
    },
  });
}

// ============================================================ CABINA
function buildBooth(view, porch, ctx) {
  let tab = 'voces';
  let zone = 'fx', origin = 'serie';
  let items = [];
  const fxProgress = new Map(); // key -> handle
  mount(view, html`
    <section class="screen">
      <div class="top">
        <div class="grow">
          <h1 class="h1">Cabina</h1>
          <div class="sub mono"><span data-el="clock">00:00:00</span> en antena</div>
        </div>
        <div class="col gap-s">
          <span class="live-chip glow" data-el="onair">On air</span>
          <span class="rec-chip off" data-el="rec">REC</span>
        </div>
      </div>
      <div class="row between small" data-el="partrow"></div>
      <div class="col gap-s" data-el="reqs"></div>
      <div class="seg">
        <button data-tab="voces" class="on">Voces</button><button data-tab="sonidos">Sonidos</button><button data-tab="mesa">Mesa</button><button data-tab="chat">Chat <span data-el="nchat"></span></button>
      </div>
      <div class="fill scroll" data-el="panel"></div>
      <div class="quick">
        <button data-q="selfmute">${icon('mic')}<span>Silenciarme</span></button>
        <button data-q="solo">${icon('music')}<span>Solo música</span></button>
        <button data-q="up">▲<span>Subir música</span></button>
        <button data-q="down">▼<span>Bajar música</span></button>
      </div>
      <div class="bottom-bar">
        <button class="btn ghost big" data-act="pause">Pausa</button>
        <button class="btn red big" data-act="end">Fin emisión</button>
      </div>
    </section>`);
  const $el = (n) => view.querySelector(`[data-el=${n}]`);
  const panel = $el('panel');
  let raf = 0, panelCleanup = null, unread = 0;

  function header() {
    const s = live.state;
    $el('clock').textContent = fmtTime(s.since ? (Date.now() - s.since) / 1000 : 0, true);
    const onair = $el('onair');
    onair.textContent = s.paused ? 'En pausa' : 'On air';
    onair.classList.toggle('off', !!s.paused);
    onair.classList.toggle('glow', !s.paused);
    const rec = $el('rec');
    rec.classList.toggle('off', !live.rec);
    const pr = $el('partrow');
    if (live.rec) {
      const el = live.partElapsed();
      pr.innerHTML = `<span class="muted">Parte ${live.rec.part} · grabando</span><span class="mono ${el > LIMITS.WARN_1_MIN * 60 ? 'red-t' : 'muted'}">${fmtTime(el)} / ${LIMITS.MAX_PART_MIN}:00</span>`;
    } else if (live.partClosed) {
      pr.innerHTML = `<span class="muted">Parte guardada en borradores.</span><button class="btn sm yellow" data-act="nextpart">Continuar en Parte ${(live.recParts.at(-1)?.part || 0) + 1}</button>`;
    } else if (s.mode === 'rec' && live.recParts.length) {
      pr.innerHTML = '';
    } else pr.innerHTML = `<span class="muted">${s.mode === 'ensayo' ? 'Ensayo privado · no se graba' : 'Solo directo · no se graba'}</span><span class="muted">${live.counts.listeners} oyentes</span>`;
    mount(view.querySelector('[data-act=pause]'), s.paused ? 'Reanudar' : 'Pausa');
    view.querySelector('[data-q=selfmute]').classList.toggle('on', !!live.voice?.muted);
    view.querySelector('[data-q=solo]').classList.toggle('on', !!live.mixer?.soloMusic);
  }
  function reqs() {
    const r = live.people.filter((p) => p.micReq);
    mount($el('reqs'), html`${!live.voice ? html`<div class="banner red"><span class="grow">Tu micro no está activo (se ha recargado la app).</span><button class="btn sm yellow" data-act="activatemic">Activar micro</button></div>` : ''}${r.map((p) => html`<div class="banner dash req"><span class="grow ellip"><b class="orange-t">${p.name}</b> pide micro · ${p.micReq.mode === 'patio' ? 'en el patio' : 'desde casa'}</span><button class="btn sm yellow" data-grant="${p.cid}">Dar paso</button><button class="btn sm ghost" data-deny="${p.cid}" aria-label="Rechazar">✕</button></div>`)}`);
  }

  // ---------- Paneles
  function voicesPanel() {
    const guests = live.people.filter((p) => p.role === 'guest');
    const rows = [{ cid: 'me', name: `${session.name} (tú)`, mode: '', me: true }, ...guests];
    mount(panel, html`<div class="list">${rows.map((g) => html`
      <div class="voice-row" data-cid="${g.cid}">
        <span class="av ${avatarColor(g.name)}">${initial(g.name)}</span>
        <div class="grow col gap-s">
          <div class="name"><span class="ellip">${g.name}</span>${g.me ? html`<span class="chip dark">Estudio</span>` : html`<span class="chip ${g.mode}">${g.mode === 'patio' ? 'Patio · sin retorno' : 'Casa · cascos'}</span>`}${!g.me && !g.hp ? html`<span class="chip dark">sin cascos</span>` : ''}</div>
          ${raw(meterHtml())}
        </div>
        <button class="mic-btn" data-mute="${g.cid}" aria-label="Micro">${icon('mic')}</button>
        ${g.me ? '' : html`<button class="icon-btn" data-menu="${g.cid}" aria-label="Opciones">${icon('more')}</button>`}
      </div>`)}
      ${guests.length ? '' : html`<p class="muted small center">Cuando des paso a alguien aparecerá aquí con su medidor. Invita desde el enlace del camerino.</p>`}
      <button class="btn ghost" data-act="invite">${icon('plus')} Invitar al micro</button>
    </div>`);
    const paintMute = () => {
      for (const b of panel.querySelectorAll('[data-mute]')) {
        const cid = b.dataset.mute;
        const muted = cid === 'me' ? live.voice?.muted : live.people.find((p) => p.cid === cid)?.muted;
        b.classList.toggle('off', !!muted);
        mount(b, icon(muted ? 'micoff' : 'mic'));
      }
    };
    paintMute();
    const loop = () => {
      for (const row of panel.querySelectorAll('[data-cid]')) {
        const cid = row.dataset.cid;
        setMeter(row.querySelector('.meter'), cid === 'me' ? live.voice?.level() || 0 : live.mixer?.voiceLevel(cid) || 0);
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return paintMute;
  }

  async function soundsPanel() {
    items = await loadAll();
    const paintPads = () => {
      const list = items.filter((i) => i.zone === zone && i.origin === origin);
      const sections = [...new Set(list.map((i) => i.section || ''))];
      const music = live.mixer?.music;
      const padHtml = (it, idx) => {
        const key = it.origin + ':' + it.id;
        const playing = (zone === 'fx' && fxProgress.has(key)) || (music && music.id === key);
        return html`<button class="pad c${idx % 6} ${playing ? 'playing' : ''}" data-pad="${key}">
          <span class="n">${it.name}</span><span class="d">${fmtShortDur(it.duration)}</span><span class="p"></span><span class="tape"></span>
          <span class="cue" data-cue="${key}" role="button" aria-label="Pre-escuchar ${it.name}">${icon('hp')}</span>
        </button>`;
      };
      let idx = 0;
      mount(panel, html`
        <div class="col gap">
          <div class="seg">${Object.entries(ZONES).map(([k, z]) => html`<button data-zone="${k}" class="${zone === k ? 'on' : ''}">${z.label}</button>`)}</div>
          <div class="row between gap">
            <div class="seg dark grow"><button data-origin="serie" class="${origin === 'serie' ? 'on' : ''}">De serie</button><button data-origin="mias" class="${origin === 'mias' ? 'on' : ''}">Mías</button></div>
            <a class="btn sm ghost" href="/mi-porche?tab=sonidos">${icon('plus')}</a>
          </div>
          <div class="muted tiny">${ZONES[zone].hint}${zone !== 'fx' ? ' Toca para sonar; toca otra vez para parar.' : ' Toca para disparar · cascos = pre-escucha.'}</div>
          ${zone !== 'fx' ? html`<div class="card tight now" data-el="now">
            <div class="vinyl ${music ? 'spin' : ''}"></div>
            <div class="grow"><div class="b ellip">${music ? music.name : 'Sin música sonando'}</div><div class="muted small mono" data-el="mpos">${music ? '' : '—'}</div></div>
            <label class="row gap-s small">Bucle <span class="switch"><input type="checkbox" data-act="loop" ${zone === 'bg' ? 'checked' : ''}><span></span></span></label>
            ${music ? html`<button class="btn sm ghost" data-act="stopmusic">Parar</button>` : ''}
          </div>` : ''}
          <div class="pads">${list.length ? sections.map((s) => html`${s ? html`<div class="sec-title">${s}</div>` : ''}${list.filter((i) => (i.section || '') === s).map((it) => padHtml(it, idx++))}`) : html`<p class="muted small sec-title">${origin === 'mias' ? 'Aún no has añadido sonidos propios. Pulsa + para subir MP3, vídeo o grabar.' : 'No hay sonidos de serie en esta zona.'}</p>`}</div>
        </div>`);
    };
    paintPads();
    const loop = () => {
      for (const [key, h] of fxProgress) {
        const el = panel.querySelector(`[data-pad="${CSS.escape(key)}"]`);
        if (el) setPct(el, '--p', h.progress() * 100);
      }
      const m = live.mixer?.music;
      const mp = panel.querySelector('[data-el=mpos]');
      if (m && mp) mp.textContent = `${fmtShortDur(live.mixer.musicPosition())} / ${fmtShortDur(m.duration)}`;
      raf = requestAnimationFrame(loop);
    };
    loop();
    soundsPanel.repaint = paintPads;
  }

  function mesaPanel() {
    const m = live.mixer;
    const voices = [...(m?.voices.values() || [])];
    const fader = (id, label, val, max = 1) => html`<div class="fader"><span class="l ellip">${label}</span><input class="slider" type="range" min="0" max="${max}" step="0.01" value="${val}" data-fader="${id}" aria-label="${label}"><span class="v">${Math.round((val / max) * 100)}</span></div>`;
    mount(panel, html`<div class="col gap">
      <div class="h3">Volumen en antena</div>
      ${fader('music', 'Música', m?.musicLevel ?? 0.28)}
      ${fader('fx', 'Efectos', m?.fxBus.gain.value ?? 0.9)}
      ${m?.tabSrc ? fader('tab', 'Pestaña', m.tabBus.gain.value) : ''}
      ${voices.map((v) => fader('v:' + v.id, v.id === 'me' ? 'Tu micro' : v.name || 'Invitado', v.gain.gain.value, 1.5))}
      <div class="toggle-row"><div class="grow"><b>Ducking automático</b><div class="muted tiny">La música baja sola cuando alguien habla y vuelve al callar. Si mueves el deslizador, manda el manual.</div></div><span class="switch"><input type="checkbox" data-act="ducking" ${m?.ducking ? 'checked' : ''}><span></span></span></div>
      <div class="toggle-row"><div class="grow"><b>Oírme</b><div class="muted tiny">Tu voz en tus cascos. Con cascos de cable suena sin retraso.</div></div><span class="switch"><input type="checkbox" data-act="monitor" ${live.voice?.monitorOn ? 'checked' : ''}><span></span></span></div>
      ${canShareTab() ? html`<div class="card col gap-s">
        <b>${icon('tab')} Compartir pestaña con audio</b>
        <div class="muted tiny">Mete en la mezcla el sonido de una pestaña de Chrome (p. ej. un vídeo que comentáis). Marca «Compartir audio» al elegirla. Usa solo fragmentos breves para comentar: emitir contenido completo puede vulnerar derechos.</div>
        ${m?.tabSrc ? html`<button class="btn sm ghost" data-act="stoptab">Dejar de compartir</button>` : html`<button class="btn sm yellow" data-act="sharetab">Elegir pestaña</button>`}
      </div>` : ''}
      <p class="muted tiny">Capacidad orientativa: 15–20 oyentes. Con wifi va casi siempre; con datos móviles alguna conexión puede fallar.</p>
    </div>`);
    panel.querySelectorAll('.slider').forEach((s) => s.style.setProperty('--v', (s.value / s.max) * 100 + '%'));
  }

  function chatPanel() {
    mount(panel, html`<div class="col gap fill">
      <div class="pinned" data-el="pin" ${live.state.pinned ? '' : 'hidden'}></div>
      <div class="chat" data-el="chatbox"></div>
      <div class="composer"><input class="input" maxlength="${LIMITS.CHAT_MAX}" placeholder="Escribe a tus oyentes…" aria-label="Mensaje"><button class="btn yellow" data-act="pinmsg" title="Fijar">📌</button></div>
      <p class="muted tiny">Toca un nombre para fijar, silenciar, expulsar o bloquear.</p>
    </div>`);
    const box = panel.querySelector('[data-el=chatbox]');
    box.style.minHeight = '200px';
    const pin = panel.querySelector('[data-el=pin]');
    if (live.state.pinned) pin.innerHTML = `📌 <b class="yellow-t">${esc(live.state.pinned.name)}</b> ${esc(live.state.pinned.text)} <button class="muted small" data-act="unpin">Quitar</button>`;
    const inp = panel.querySelector('.composer input');
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && sendChat(inp));
    unread = 0; $el('nchat').textContent = '';
    return mountChat(box, true);
  }

  async function showTab(t) {
    tab = t;
    cancelAnimationFrame(raf);
    panelCleanup?.(); panelCleanup = null;
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'voces') voicesPanel.paint = voicesPanel();
    else if (t === 'sonidos') await soundsPanel();
    else if (t === 'mesa') mesaPanel();
    else if (t === 'chat') panelCleanup = chatPanel();
  }

  // ---------- Eventos
  async function fire(key, cue) {
    const it = items.find((i) => i.origin + ':' + i.id === key);
    if (!it || !live.mixer) return;
    let buf;
    try { buf = await decode(it); } catch { toast('No se ha podido cargar este sonido', 'bad'); return; }
    haptic(8);
    if (cue) { live.mixer.cue(buf); toast(`Pre-escucha: ${it.name} (solo en tus cascos)`); return; }
    if (it.zone === 'fx') {
      const h = live.mixer.playFx(buf, { onEnd: () => { fxProgress.delete(key); const el = panel.querySelector(`[data-pad="${CSS.escape(key)}"]`); el?.classList.remove('playing'); setPct(el, '--p', 0); } });
      fxProgress.set(key, h);
      panel.querySelector(`[data-pad="${CSS.escape(key)}"]`)?.classList.add('playing');
    } else {
      const m = live.mixer.music;
      if (m && m.id === key) { live.mixer.stopMusic(); }
      else {
        const loop = panel.querySelector('[data-act=loop]')?.checked ?? it.zone === 'bg';
        live.mixer.playMusic(buf, { loop, id: key, name: it.name, onEnd: () => soundsPanel.repaint?.() });
      }
      soundsPanel.repaint?.();
    }
  }
  // Mantener pulsado un cassette = pre-escucha
  let pressT = null, pressed = false;
  panel.addEventListener('pointerdown', (e) => {
    const pad = e.target.closest('[data-pad]');
    if (!pad || e.target.closest('[data-cue]')) return;
    pressed = false;
    pressT = setTimeout(() => { pressed = true; fire(pad.dataset.pad, true); }, 550);
  });
  panel.addEventListener('pointerup', () => clearTimeout(pressT));
  panel.addEventListener('pointercancel', () => clearTimeout(pressT));

  view.addEventListener('click', async (e) => {
    const t = e.target;
    let b;
    if ((b = t.closest('[data-tab]'))) return showTab(b.dataset.tab);
    if ((b = t.closest('[data-grant]'))) return live.send({ t: 'grant', cid: b.dataset.grant });
    if ((b = t.closest('[data-deny]'))) return live.send({ t: 'deny', cid: b.dataset.deny });
    if ((b = t.closest('[data-cue]'))) { e.stopPropagation(); return fire(b.dataset.cue, true); }
    if ((b = t.closest('[data-pad]'))) { if (pressed) { pressed = false; return; } return fire(b.dataset.pad, false); }
    if ((b = t.closest('[data-zone]'))) { zone = b.dataset.zone; return soundsPanel.repaint(); }
    if ((b = t.closest('[data-origin]'))) { origin = b.dataset.origin; return soundsPanel.repaint(); }
    if ((b = t.closest('[data-mute]'))) {
      const cid = b.dataset.mute;
      if (cid === 'me') live.voice?.setMuted(!live.voice.muted);
      else { const p = live.people.find((x) => x.cid === cid); live.send({ t: 'mute', cid, on: !p?.muted }); live.mixer?.muteVoice(cid, !p?.muted); }
      setTimeout(header, 50);
      return voicesPanel.paint?.();
    }
    if ((b = t.closest('[data-menu]'))) {
      const p = live.people.find((x) => x.cid === b.dataset.menu);
      if (p) personMenu({ name: p.name, dev: p.dev, cid: p.cid, canMod: true, isHost: true, onMod: (act, x) => {
        if (act === 'mute') { live.send({ t: 'mute', cid: x.cid, on: true }); live.mixer?.muteVoice(x.cid, true); }
        if (act === 'kick' || act === 'ban') live.send({ t: 'kick', cid: x.cid, ban: act === 'ban' });
      } });
      return;
    }
    if ((b = t.closest('[data-q]'))) {
      const q = b.dataset.q, m = live.mixer;
      if (q === 'selfmute') live.voice?.setMuted(!live.voice.muted);
      if (q === 'solo') m?.setSoloMusic(!m.soloMusic);
      if (q === 'up') m?.musicUp();
      if (q === 'down') m?.musicDown();
      haptic(8); header();
      if (tab === 'voces') showTab('voces');
      return;
    }
    if (!(b = t.closest('[data-act]'))) return;
    switch (b.dataset.act) {
      case 'invite': inviteSheet(porch); break;
      case 'activatemic':
        try { audioCtx(); await live.startVoice(localStorage.getItem('rp_hp') !== '0'); reqs(); toast('Micro activo', 'good'); } catch { toast('No se ha podido abrir el micro', 'bad'); }
        break;
      case 'stopmusic': live.mixer?.stopMusic(); soundsPanel.repaint?.(); break;
      case 'sharetab':
        try { await live.mixer.shareTab(); live.mixer.onTabEnd = () => tab === 'mesa' && mesaPanel(); mesaPanel(); toast('Pestaña en antena', 'good'); } catch (err) { toast(err.message || 'No se ha compartido', 'bad'); }
        break;
      case 'stoptab': live.mixer?.stopTab(); mesaPanel(); break;
      case 'pause': live.pause(!live.state.paused); break;
      case 'nextpart': live.continueNextPart(); toast(`Grabando Parte ${live.rec.part}`, 'good'); break;
      case 'pinmsg': { const inp = panel.querySelector('.composer input'); const txt = inp?.value.trim(); if (txt) { live.send({ t: 'pin', text: txt }); inp.value = ''; } else toast('Escribe el mensaje a fijar'); break; }
      case 'unpin': live.send({ t: 'pin', text: '' }); break;
      case 'end': {
        if (!(await confirmSheet('¿Terminar la emisión?', live.rec ? 'Se cerrará la grabación y se guardará en tus borradores.' : 'Los oyentes dejarán de oírte.', { ok: 'Fin emisión', danger: true }))) return;
        const saved = await live.endBroadcast(true);
        const parts = live.recParts.slice();
        live.disconnect();
        if (parts.length) { toast('Guardado en Borradores', 'good'); ctx.go(`/editor/${parts[0].id}`); }
        else ctx.go('/mi-porche');
        break;
      }
    }
  });
  view.addEventListener('input', (e) => {
    const s = e.target.closest('[data-fader]');
    if (!s || !live.mixer) return;
    const v = Number(s.value), id = s.dataset.fader;
    s.style.setProperty('--v', (v / s.max) * 100 + '%');
    s.parentElement.querySelector('.v').textContent = Math.round((v / s.max) * 100);
    if (id === 'music') live.mixer.setMusicLevel(v, true);
    else if (id === 'fx') live.mixer.setFxLevel(v);
    else if (id === 'tab') live.mixer.setTabLevel(v);
    else if (id.startsWith('v:')) live.mixer.setVoiceGain(id.slice(2), v);
  });
  view.addEventListener('change', (e) => {
    if (e.target.matches('[data-act=ducking]')) live.mixer.ducking = e.target.checked;
    if (e.target.matches('[data-act=monitor]')) live.voice?.setMonitor(e.target.checked);
  });

  const clockIv = setInterval(header, 1000);
  const offs = [
    onLive('update', () => { header(); reqs(); if (tab === 'voces') { const before = panel.querySelectorAll('[data-cid]').length; const now = live.people.filter((p) => p.role === 'guest').length + 1; if (before !== now) showTab('voces'); else voicesPanel.paint?.(); } }),
    onLive('chat', () => { if (tab !== 'chat') { unread++; $el('nchat').textContent = `(${unread})`; } }),
    onLive('warn', (msg) => { haptic(200); toast(msg, 'bad'); }),
    onLive('partClosed', (part) => {
      sheet(html`<h2 class="h2">Parte ${part} guardada</h2><p class="muted">Has llegado a ${LIMITS.MAX_PART_MIN} minutos. La grabación de esta parte se ha cerrado y está en tus borradores. El directo sigue sonando para los oyentes.</p><button class="btn yellow big" data-close="go">Continuar en Parte ${part + 1}</button><button class="btn ghost" data-close="">Seguir sin grabar</button>`).done.then((v) => { if (v === 'go') live.continueNextPart(); });
    }),
  ];
  header(); reqs(); showTab('voces');
  return () => { clearInterval(clockIv); cancelAnimationFrame(raf); panelCleanup?.(); offs.forEach((f) => f()); };
}
