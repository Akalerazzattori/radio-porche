// Pantalla de un porche: Oyente (con chat y pedir micro), Invitado con micro,
// Camerino (antes de salir) y Cabina (en directo) para quien presenta.
import { api, session } from '../api.js';
import { LIMITS, VOICE_FX, BROADCAST_MODES, QUICK_REACTIONS, SOUND_TABS } from '../config.js';
import { html, mount, icon, raw, toast, sheet, confirmSheet, fmtTime, fmtShortDur, fmtDate, haptic, canShareTab, setPct, esc, on } from '../util.js';
import { porchCover, requireIdentity, personMenu, shareUrl, isBlocked, nameColor, avatar } from '../common.js';
import { live, onLive } from '../live.js';
import { meterHtml, setMeter, audioCtx } from '../audio/voice.js';
 '../audio/sounds.js';
import { getSetting, setSetting } from '../db.js';
import { makeCtl, onPreview, stopPreview, previewKey } from '../cabina-ctl.js';
import { myPrograms, programSheet, programPickerHtml } from '../programs.js';

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
    // El anfitrión, en cualquier aparato, siempre ve el Estudio (emita desde aquí o no)
    // (si este aparato pasa a emitir o deja de hacerlo, se vuelve a montar: cambian los mandos disponibles)
    if (live.role === 'host' || live.isOwner) return (live.state.live ? 'cabina' : 'camerino') + (live.role === 'host' ? '' : ':r');
    return 'oyente';
  }
  const outer = view;
  function build() {
    cleanup.forEach((f) => f()); cleanup = [];
    outer.innerHTML = '';
    view = document.createElement('div');
    view.className = 'porch-root';
    outer.appendChild(view);
    mode = decide();
    if (mode === 'loading') mount(view, html`<section class="screen"><div class="top"><div><h1 class="h1">${porch.name}</h1><div class="sub mono">${porch.freq.toFixed(1)} FM</div></div><button class="icon-btn" data-act="x">${icon('close')}</button></div><div class="empty"><div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><p>Sintonizando…</p></div></section>`);
    else if (mode === 'fatal') mount(view, html`<section class="screen"><div class="top"><h1 class="h1">${porch.name}</h1><button class="icon-btn" data-act="x">${icon('close')}</button></div><div class="empty"><img src="/img/scenes/escena-4.webp" alt=""><p>${live.fatal.msg}</p><button class="btn ghost" data-act="x">Volver</button></div></section>`);
    else if (mode === 'oyente') cleanup.push(buildListener(view, porch, ctx));
    else if (mode.startsWith('camerino')) cleanup.push(buildGreenRoom(view, porch, ctx));
    else if (mode.startsWith('cabina')) cleanup.push(buildBooth(view, porch, ctx));
    view.querySelectorAll('[data-act=x]').forEach((b) => (b.onclick = () => leave()));
  }
  function leave() {
    if (live.role === 'host' && live.state.live) { ctx.go('/'); return; } // el directo sigue (mini barra para volver)
    if (live.role === 'guest') { ctx.go('/'); return; }
    if (live.role !== 'host' && !live.remote) { ctx.go('/'); return; } // oyente: sigue sonando en el mini reproductor
    live.disconnect(); ctx.go('/mi-porche');
  }
  sub('update', () => { if (decide() !== mode) build(); });

  sub('resumed', (ms) => resumedOverlay(ms));
  build();

  if (params.get('micro') === '1' && !live.speaking) {
    const off = onLive('update', () => { if (live.role === 'listener') { off(); setTimeout(() => micRequestSheet(), 300); } });
    offs.push(off);
  }
  return () => { cleanup.forEach((f) => f()); offs.forEach((f) => f()); };
}

// ============================================================ comunes
/** Cambiar desde qué aparato se emite. */
function roleSheet() {
  const others = live.myOtherDevices();
  const k = live.kind;
  if (!others.length) {
    sheet(html`<h2 class="h2">Emite este ${k}</h2><p class="muted">No tienes otro aparato tuyo conectado. Si abres el Estudio en tu ordenador (vincúlalo con el código de Perfil), podrás emitir desde él y manejarlo todo desde los dos.</p><button class="btn yellow" data-close="">Entendido</button>`);
    return;
  }
  sheet(html`
    <h2 class="h2">¿Desde dónde se emite?</h2>
    <p class="muted small">Ahora emite este ${k}. Los mandos del estudio siguen funcionando en todos tus aparatos.</p>
    ${others.map((o) => html`<button class="role-opt ${o.kind === 'ordenador' ? 'rec' : ''}" data-close="${o.cid}"><b>Emitir desde tu ${o.kind}${o.kind === 'ordenador' ? html` <span class="chip patio">Más estable</span>` : ''}</b><span>Si aquí estás hablando, este ${k} sigue siendo tu micro.</span></button>`)}
    <button class="btn ghost" data-close="">Seguir emitiendo desde aquí</button>`).done.then((cid) => {
    if (cid) { live.send({ t: 'handoff', to: cid }); toast('Pasando la emisión…'); }
  });
}

/** Barra del aparato: desde dónde se emite + interruptores Micro / Escuchar de ESTE aparato. */
function roleBadge() {
  const k = live.kind;
  const host = live.role === 'host';
  const where = host ? `este ${k}` : `tu ${live.state.studioKind || 'otro aparato'}`;
  const offline = !host && live.state.hostOnline === false;
  return html`<div class="dev-bar">
    <div class="emit-line"><span class="dot ${offline ? 'off' : ''}"></span><span class="grow">Emite desde <b>${where}</b>${offline ? ' · desconectado' : ''}</span>
      ${host ? html`<button class="link-btn" data-act="role">Cambiar</button>` : html`<button class="link-btn" data-act="takestudio">Emitir desde aquí</button>`}
      <button class="info-btn sm" data-act="roleinfo" aria-label="Cómo funciona">i</button></div>
    <div class="dev-toggles">
      <label class="row gap-s small"><span class="switch"><input type="checkbox" data-act="michere" ${live.micHere() ? 'checked' : ''}><span></span></span> Micro aquí</label>
      <label class="row gap-s small"><span class="switch"><input type="checkbox" data-act="listenhere" ${live.listenHere() ? 'checked' : ''}><span></span></span> Escuchar aquí</label>
    </div>
  </div>`;
}

function roleInfoSheet() {
  sheet(html`
    <h2 class="h2">Tu estudio en varios aparatos</h2>
    <p>Puedes tener el Estudio abierto en tu <b>móvil</b> y en tu <b>ordenador</b> a la vez. Los mandos (botonera, volúmenes, invitados, salir al aire, pausa y fin) funcionan en los dos.</p>
    <p>En cada aparato eliges: <b>Micro aquí</b> (hablar por él) y <b>Escuchar aquí</b> (oír la emisión).</p>
    <p><b>Emite</b> uno de ellos: el que junta el sonido y lo manda a los oyentes. Antes de salir al aire emite el que tienes delante; si los dos están a la vista, el ordenador (no se duerme). Ya en el aire, si el móvil que emite se bloquea o cambias de app, la emisión pasa sola al ordenador.</p>
    <p class="muted small">Para usar el ordenador: en el móvil, Perfil → «Vincular otro aparato», y escribe el código en el ordenador. Luego abre allí el Estudio. Consejo: en el aparato que emite, no cierres la tapa ni lo bloquees.</p>
    <button class="btn yellow" data-close="">Entendido</button>`);
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
    mount($el('avs'), html`${guests.map((g) => avatar(g, 'sm'))}`);
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
        ${live.isOwner ? html`<div class="role-badge mic"><span class="dot"></span><span class="grow"><b>Este ${live.kind} es MICRO</b> · el estudio es tu ${live.state.studioKind || 'otro aparato'}</span></div>` : ''}
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
    el.innerHTML = `<div class="h1">${esc(porch.name)}</div><p class="b">${live.state.live ? 'Está en directo ahora mismo.' : 'Aún no ha empezado: te sonará en cuanto salga al aire.'}</p><button class="btn red big">▶ Empezar a escuchar</button>`;
    document.body.appendChild(el);
    el.onclick = () => { live.audio?.play().catch(() => {}); el.remove(); };
  })];
  paint();
  return () => { offs.forEach((f) => f()); offChat(); cancelAnimationFrame(meterRaf); };
}

// ============================================================ CAMERINO (estudio o mando a distancia)
function goLiveOverlay() {
  const el = document.createElement('div');
  el.className = 'full-overlay onair-flash';
  el.innerHTML = '<span class="live-chip glow">En el aire</span><div class="h1">¡Estás en el aire!</div><p class="b">Todo lo que se oiga en el estudio llega a los oyentes.</p>';
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 1600);
  setTimeout(() => el.remove(), 2100);
}

function buildGreenRoom(view, porch, ctx) {
  const ctl = makeCtl();
  const remote = ctl.remote;
  let headphones = localStorage.getItem('rp_hp') !== '0';
  mount(view, html`
    <section class="screen">
      <div class="top">
        <button class="btn sm ghost" data-act="x" aria-label="Volver">${icon('back')} Volver</button>
        <div class="grow right"><h1 class="h1">Estudio</h1><div class="sub ellip">Preparación · aún no estás en el aire</div></div>
      </div>
      <div data-el="role">${roleBadge()}</div>
      <div class="banner teal" data-el="status">${icon('lock')} <span>Aún no estás en el aire</span></div>
      <div class="fill scroll col gap">
        ${remote ? html`<div class="card row gap"><span class="grow"><b>Micro del estudio</b><div class="muted small" data-el="studiomic">…</div></span></div>` : html`
        <div class="card col gap-s">
          <div class="row between"><b>1 · Prueba tu voz</b><span class="muted small" data-el="probe">Toca «Probar micro»</span></div>
          ${raw(meterHtml())}
          <div data-el="voice"></div>
          <button class="btn yellow pulse-hint full" data-act="startmic">${icon('mic')} Probar micro</button>
          <div class="row gap two">
            <label class="row gap-s small grow"><span class="switch"><input type="checkbox" data-act="monitor" ${headphones && localStorage.getItem('rp_oirme') !== '0' ? 'checked' : ''}><span></span></span> Oírme</label>
            <label class="row gap-s small grow"><span class="switch"><input type="checkbox" data-act="hp" ${headphones ? 'checked' : ''}><span></span></span> Llevo cascos</label>
          </div>
          <div class="muted tiny">«Oírme»: tu voz en tus cascos. Con Bluetooth llega con unas décimas de retraso; con cascos de cable, al instante.</div>
        </div>`}
        <div class="h3">2 · ¿Qué programa emites?</div>
        <div data-el="progs"><p class="muted small">Cargando tus programas…</p></div>
        <input class="input" data-el="title" maxlength="${LIMITS.TITLE_MAX}" placeholder="Título de este episodio (p. ej. Marta y el bar)" value="${localStorage.getItem('rp_lasttitle') || ''}">
        <div class="h3">3 · ¿Cómo sales?</div>
        <div class="modes">${BROADCAST_MODES.map((m) => html`
          <label class="radio-opt"><input type="radio" name="mode" value="${m.id}" ${m.id === 'rec' ? 'checked' : ''}><div class="grow"><div class="t">${m.name}</div><div class="d">${m.hint}</div></div>${m.id === 'rec' ? html`<span class="rec-chip">REC</span>` : ''}</label>`)}</div>
        <div class="h3">Al salir al aire suena</div>
        <button class="btn ghost cat-btn" data-act="intro"><span class="grow ellip" data-el="introlbl">Nada</span>${icon('down')}</button>
        <div class="row between"><div class="h3">Contigo en el estudio</div><button class="btn sm yellow" data-act="invite">${icon('plus')} Invitar al micro</button></div>
        <div class="col gap-s" data-el="guests"></div>
        <div class="col gap-s" data-el="reqs"></div>
      </div>
      <button class="hold" data-el="hold" aria-label="Mantén pulsado 3 segundos para salir en antena"><span class="num" data-el="num">3</span><span class="txt"><span>Mantén para<br>salir en antena</span><span class="bar"><i></i></span></span></button>
      <div class="muted tiny center">Mantén pulsado 3 segundos. Nada sale al aire con un toque sin querer. Quien entre al micro verá si se graba.</div>
    </section>`);
  const $el = (n) => view.querySelector(`[data-el=${n}]`);
  let raf = 0;
  if (!remote) {
    const vs = voiceSelector(() => live.voice);
    mount($el('voice'), vs.tpl);
    vs.bind($el('voice'));
    const meter = view.querySelector('.meter');
    const loop = () => { const l = live.voice?.level() || 0; setMeter(meter, l); if (live.voice) $el('probe').textContent = l > 0.1 ? '¡Te oigo!' : 'Habla para probar'; raf = requestAnimationFrame(loop); };
    loop();
  }
  $el('title').addEventListener('input', (e) => localStorage.setItem('rp_lasttitle', e.target.value));
  let programId = localStorage.getItem('rp_lastprog') || '';
  let programs = [];
  async function paintProgs(force = false) {
    programs = await myPrograms(force);
    if (!programs.some((p) => p.id === programId)) programId = programs[0]?.id || '';
    mount($el('progs'), programPickerHtml(programs, programId));
  }
  paintProgs();
  $el('progs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-prog]');
    if (!b) return;
    if (b.dataset.prog === '__new') {
      const p = await programSheet();
      if (p && typeof p === 'object') { programId = p.id; localStorage.setItem('rp_lastprog', programId); await paintProgs(true); }
      return;
    }
    programId = b.dataset.prog; localStorage.setItem('rp_lastprog', programId);
    $el('progs').querySelectorAll('[data-prog]').forEach((x) => x.classList.toggle('on', x === b));
  });
  let allItems = [];
  const offPv = onPreview(() => { document.querySelectorAll('[data-prev]').forEach((el) => mount(el, icon(el.dataset.prev === previewKey() ? 'pause' : 'play'))); });
  let introKey = localStorage.getItem('rp_intro') || '';
  const paintIntro = () => { const it = allItems.find((x) => x.key === introKey); $el('introlbl').textContent = it ? it.name : 'Nada (sales en silencio)'; };
  let lastSoundsN = -1;
  const loadSounds = () => ctl.sounds().then((items) => {
    if (items.length === lastSoundsN) return;
    lastSoundsN = items.length;
    allItems = items;
    paintIntro();
  });
  loadSounds();

  async function startMic() {
    try {
      audioCtx();
      await live.startVoice(headphones);
      const b = view.querySelector('[data-act=startmic]');
      if (b) { b.textContent = '✓ Micro listo'; b.classList.remove('pulse-hint'); }
      return true;
    } catch { toast('No se ha podido abrir el micro. Revisa los permisos del navegador.', 'bad'); return false; }
  }

  function paint() {
    mount($el('role'), roleBadge());
    const waiting = live.counts.listeners;
    $el('status').innerHTML = `${icon('lock').html} <span>Aún no estás en el aire · ${waiting} ${waiting === 1 ? 'persona espera' : 'personas esperan'}</span>`;
    if (remote && $el('studiomic')) $el('studiomic').textContent = live.remoteState ? (live.remoteState.hasVoice ? 'Activo en el estudio' : 'Aún no activado en el estudio (se activará al salir)') : 'Esperando al estudio…';
    const guests = live.people.filter((p) => p.role === 'guest');
    mount($el('guests'), guests.length ? html`<div class="row gap wrap">${guests.map((g) => html`
      <div class="guest-chip">${avatar(g)}<div><div class="n">${g.name}</div><div class="d">${g.mode === 'patio' ? 'Patio · sin retorno' : 'Casa · cascos'}</div></div></div>`)}</div>`
      : html`<div class="muted small">Nadie aún. Pulsa «Invitar al micro» y manda el enlace.</div>`);
    const reqs = live.people.filter((p) => p.micReq);
    mount($el('reqs'), html`${reqs.map((r) => html`<div class="banner dash req"><span class="grow"><b class="orange-t">${r.name}</b> pide micro · ${r.micReq.mode === 'patio' ? 'en el patio' : 'desde casa'}${r.micReq.hp ? '' : ' (sin cascos)'}</span><button class="btn sm yellow" data-grant="${r.cid}">Dar paso</button></div>`)}`);
  }

  // Mantén para salir: cuenta atrás 3-2-1. Nada sale sin querer.
  const hold = $el('hold');
  let holdStart = 0, holdRaf = 0, lastN = 4;
  const beep = (f, d = 0.12) => { try { const c = audioCtx(); const o = c.createOscillator(); const g = c.createGain(); o.frequency.value = f; g.gain.value = 0.15; o.connect(g); g.connect(c.destination); o.start(); g.gain.setTargetAtTime(0, c.currentTime + d * 0.6, 0.03); o.stop(c.currentTime + d + 0.1); } catch {} };
  const tick = () => {
    const k = Math.min(1, (performance.now() - holdStart) / 3000);
    hold.style.setProperty('--k', String(k));
    const n = Math.max(1, 3 - Math.floor(k * 3));
    $el('num').textContent = n;
    if (n !== lastN) { lastN = n; beep(n === 1 ? 880 : 660); haptic(25); }
    if (k >= 1) { done(); return; }
    holdRaf = requestAnimationFrame(tick);
  };
  const cancel = () => { cancelAnimationFrame(holdRaf); hold.classList.remove('pressing'); hold.style.setProperty('--k', '0'); $el('num').textContent = '3'; lastN = 4; holdStart = 0; };
  hold.addEventListener('pointerdown', async (e) => {
    e.preventDefault();
    hold.setPointerCapture(e.pointerId);
    if (!remote && !live.voice && !(await startMic())) return;
    if (remote && live.state.hostOnline === false) return toast('El estudio está desconectado', 'bad');
    holdStart = performance.now(); lastN = 4; hold.classList.add('pressing'); tick();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => hold.addEventListener(ev, () => { if (holdStart) cancel(); }));
  hold.addEventListener('contextmenu', (e) => e.preventDefault());
  function done() {
    stopPreview();
    cancelAnimationFrame(holdRaf); holdStart = 0; hold.classList.remove('pressing');
    const title = $el('title').value.trim();
    localStorage.setItem('rp_lasttitle', title);
    const jingle = allItems.some((x) => x.key === introKey) ? introKey : '';
    const prog = programs.find((p) => p.id === programId);
    ctl.golive(view.querySelector('input[name=mode]:checked').value, title || prog?.name || '', jingle, programId);
    beep(1200, 0.3);
    goLiveOverlay();
  }

  view.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-grant]');
    if (g) { live.send({ t: 'grant', cid: g.dataset.grant }); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'startmic') startMic();
    if (b.dataset.act === 'role') roleSheet();
    if (b.dataset.act === 'roleinfo') roleInfoSheet();
    if (b.dataset.act === 'intro') {
      let tab = (allItems.find((x) => x.key === introKey) && SOUND_TABS.find((t) => t.zones.includes(allItems.find((x) => x.key === introKey).zone))?.id) || 'jingle';
      const v = await sheet(html`<h2 class="h2">Sonido al salir al aire</h2><p class="muted small">Suena justo al entrar en antena. Toca ▶ para oírlo antes.</p>
        <button class="opt" data-close="__none">${introKey ? '' : '✓ '}Nada (sales en silencio)</button>
        <div class="seg">${SOUND_TABS.map((t) => html`<button data-itab="${t.id}">${t.label}</button>`)}</div>
        <div class="col gap-s intro-list" data-el="ilist"></div>`, {
        onMount(a) {
          const paintList = () => {
            a.el.querySelectorAll('[data-itab]').forEach((x) => x.classList.toggle('on', x.dataset.itab === tab));
            const T = SOUND_TABS.find((t) => t.id === tab);
            const opts = allItems.filter((x) => T.zones.includes(x.zone));
            const secs = [...new Set(opts.map((x) => x.section || ''))];
            mount(a.el.querySelector('[data-el=ilist]'), opts.length ? html`${secs.map((sec) => html`${sec ? html`<div class="sec-title">${sec}</div>` : ''}${opts.filter((x) => (x.section || '') === sec).map((x) => html`<div class="row gap"><button class="opt grow ${x.key === introKey ? 'yellow-t' : ''}" data-close="${x.key}">${x.key === introKey ? '✓ ' : ''}${x.name}</button><button class="mini-ic" data-prev="${x.key}" aria-label="Escuchar">${icon(x.key === previewKey() ? 'pause' : 'play')}</button></div>`)}`)}` : html`<p class="muted small">No hay nada en ${T.label.toLowerCase()}.</p>`);
          };
          paintList();
          a.el.addEventListener('click', (ev) => {
            const t = ev.target.closest('[data-itab]'); if (t) { tab = t.dataset.itab; paintList(); return; }
            const pv = ev.target.closest('[data-prev]'); if (pv) { ev.stopPropagation(); const it = allItems.find((y) => y.key === pv.dataset.prev); if (it) ctl.cue(it); }
          });
        },
      }).done;
      stopPreview();
      if (v) { introKey = v === '__none' ? '' : v; localStorage.setItem('rp_intro', introKey); paintIntro(); }
    }
    if (b.dataset.act === 'invite') inviteSheet(porch);
    if (b.dataset.act === 'takestudio') live.takeStudio();
  });
  view.addEventListener('change', async (e) => {
    if (e.target.matches('[data-act=hp]')) {
      headphones = e.target.checked; localStorage.setItem('rp_hp', headphones ? '1' : '0');
      if (!headphones) toast('Sin cascos activamos la cancelación de eco (algo menos de calidad).');
      if (live.voice) await live.startVoice(headphones);
    }
    if (e.target.matches('[data-act=monitor]')) live.voice?.setMonitor(e.target.checked);
    if (e.target.matches('[data-act=michere]')) live.setMicHere(e.target.checked).catch(() => toast('No se ha podido abrir el micro', 'bad'));
    if (e.target.matches('[data-act=listenhere]')) { live.setListenHere(e.target.checked); view.querySelectorAll('[data-act=monitor]').forEach((x) => (x.checked = !!live.voice?.monitorOn)); }
  });
  const offs = [onLive('update', paint), onLive('remote', () => { paint(); loadSounds(); }), offPv];
  paint();
  return () => { stopPreview(); offs.forEach((f) => f()); cancelAnimationFrame(raf); cancelAnimationFrame(holdRaf); };
}

function inviteSheet(porch) {
  const link = `${location.origin}/porche/${porch.slug}?i=${encodeURIComponent(live.inviteKey)}&micro=1`;
  sheet(html`
    <h2 class="h2">Invitar al micro</h2>
    <p class="muted small">Manda este enlace a quien quieras en el programa (también sirve para los ensayos privados). Al abrirlo elige <b>Patio</b> (está contigo) o <b>Casa</b> (desde su casa, con cascos) y <b>entra directo al micro</b>, sin que tengas que darle paso. Si se le corta o cambia de app, vuelve a entrar solo. El enlace sirve para todo el programa y para los siguientes, hasta que lo cambies.</p>
    <div class="card mono tiny ellip">${link}</div>
    <button class="btn yellow" data-a="share">${icon('share')} Enviar enlace</button>
    ${live.role === 'host' ? html`<button class="btn ghost" data-a="rotate">Cambiar enlace (anula el anterior)</button>` : ''}`, {
    onMount(a) {
      a.el.querySelector('[data-a=share]').onclick = () => shareUrl(link, `Ven a ${porch.name}`);
      const r = a.el.querySelector('[data-a=rotate]');
      if (r) r.onclick = () => { live.send({ t: 'rotateInvite' }); a.close(); toast('Enlace nuevo creado. Vuelve a pulsar Invitar.'); };
    },
  });
}

// ============================================================ CABINA (en el aire)
function buildBooth(view, porch, ctx) {
  const ctl = makeCtl();
  const remote = ctl.remote;
  let tab = 'voces';
  let stab = 'jingle', origin = 'serie';
  let items = [];
  mount(view, html`
    <section class="screen is-live">
      <div class="onair-top">
        <button class="band-back" data-act="x" aria-label="Salir del estudio (la emisión sigue)">${icon('back')}</button>
        <div class="onair-sign" data-el="sign"><span class="lamp"></span><span data-el="onair">En el aire</span></div>
        <div class="onair-meta"><span class="mono clock" data-el="clock">00:00:00</span><span class="rec-chip off" data-el="rec">REC</span></div>
      </div>
      <div data-el="role">${roleBadge()}</div>
      <div class="row between small" data-el="partrow"></div>
      <div class="col gap-s" data-el="reqs"></div>
      <div class="seg">
        <button data-tab="voces" class="on">Voces</button><button data-tab="sonidos">Sonidos</button><button data-tab="mesa">Volumen</button><button data-tab="chat">Chat <span data-el="nchat"></span></button>
      </div>
      <div class="fill scroll" data-el="panel"></div>
      <div class="quick">
        <button data-q="selfmute">${icon('micoff')}<span>Cortar mi micro</span></button>
        <button data-q="solo">${icon('music')}<span>Solo música</span></button>
        <button data-q="up">▲<span>Música alta</span></button>
        <button data-q="down">▼<span>Música de fondo</span></button>
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
    if (!header.t || Date.now() - header.t > 3000) { header.t = Date.now(); mount($el('role'), roleBadge()); }
    $el('clock').textContent = fmtTime(s.since ? (Date.now() - s.since) / 1000 : 0, true);
    const onair = $el('onair');
    onair.textContent = s.paused ? 'En pausa' : 'En el aire';
    view.querySelector('.onair-sign').classList.toggle('paused', !!s.paused);
    const rec = ctl.rec();
    $el('rec').classList.toggle('off', !rec);
    const pr = $el('partrow');
    if (rec) {
      pr.innerHTML = `<span class="muted">Grabando · Parte ${rec.part}</span><span class="mono ${rec.elapsed > LIMITS.WARN_1_MIN * 60 ? 'red-t' : 'muted'}">${fmtTime(rec.elapsed)} / ${LIMITS.MAX_PART_MIN}:00</span><span class="muted">${live.counts.listeners} oyentes</span>`;
    } else if (ctl.partClosed()) {
      pr.innerHTML = `<span class="muted">Parte guardada en Grabaciones.</span><button class="btn sm yellow" data-act="nextpart">Grabar Parte ${ctl.lastPart() + 1}</button>`;
    } else pr.innerHTML = `<span class="muted">${s.mode === 'ensayo' ? 'Ensayo privado · no se graba' : s.mode === 'rec' ? 'No se está grabando' : 'Solo directo · no se graba'}</span><span class="muted">${live.counts.listeners} oyentes</span>`;
    mount(view.querySelector('[data-act=pause]'), s.paused ? 'Reanudar' : 'Pausa');
    view.querySelector('[data-q=selfmute]').classList.toggle('on', ctl.selfMuted());
    view.querySelector('[data-q=solo]').classList.toggle('on', ctl.solo());
  }
  function reqs() {
    const r = live.people.filter((p) => p.micReq);
    mount($el('reqs'), html`${!remote && !live.voice ? html`<div class="banner red"><span class="grow">Tu micro no está activo.</span><button class="btn sm yellow" data-act="activatemic">Activar micro</button></div>` : ''}${r.map((p) => html`<div class="banner dash req"><span class="grow ellip"><b class="orange-t">${p.name}</b> pide micro · ${p.micReq.mode === 'patio' ? 'en el patio' : 'desde casa'}</span><button class="btn sm yellow" data-grant="${p.cid}">Dar paso</button><button class="btn sm ghost" data-deny="${p.cid}" aria-label="Rechazar">✕</button></div>`)}`);
  }

  // ---------- Paneles
  function voicesPanel() {
    const guests = live.people.filter((p) => p.role === 'guest');
    const rows = [{ cid: 'me', name: `${session.name} (estudio)`, me: true, dev: session.deviceId, av: session.get()?.avatar || 0 }, ...guests];
    const hp = localStorage.getItem('rp_hp') !== '0';
    mount(panel, html`<div class="list">
      ${remote ? '' : html`<div class="card col gap-s">
        <b>Tu micro y tus cascos</b>
        <div class="row gap wrap">
          <label class="row gap-s small"><span class="switch"><input type="checkbox" data-act="hp" ${hp ? 'checked' : ''}><span></span></span> Llevo cascos</label>
          <label class="row gap-s small"><span class="switch"><input type="checkbox" data-act="monitor" ${live.voice?.monitorOn ? 'checked' : ''}><span></span></span> Oírme</label>
        </div>
        <div class="muted tiny">Sin cascos, deja «Escuchar aquí» apagado: si suena por el altavoz, el micro lo recoge y se acopla. Con gente alrededor, usa siempre cascos.</div>
        <div data-el="vsel"></div>
      </div>`}
      ${rows.map((g) => html`
      <div class="voice-row" data-cid="${g.cid}">
        ${avatar(g)}
        <div class="grow col gap-s">
          <div class="name"><span class="ellip">${g.name}</span>${g.me ? '' : html`<span class="chip ${g.mode}">${g.mode === 'patio' ? 'Patio' : 'Casa · cascos'}</span>`}${!g.me && !g.hp ? html`<span class="chip dark">sin cascos</span>` : ''}</div>
          ${raw(meterHtml())}
        </div>
        <button class="mic-btn" data-mute="${g.cid}" aria-label="Micro de ${g.name}">${icon('mic')}</button>
        ${g.me ? '' : html`<button class="icon-btn" data-menu="${g.cid}" aria-label="Opciones">${icon('more')}</button>`}
      </div>`)}
      ${guests.length ? '' : html`<p class="muted small center">Aquí aparecerá cada persona a la que des paso al micro, con su medidor.</p>`}
      <button class="btn ghost" data-act="invite">${icon('plus')} Invitar al micro</button>
    </div>`);
    const paintMute = () => {
      for (const b of panel.querySelectorAll('[data-mute]')) {
        const cid = b.dataset.mute;
        const muted = cid === 'me' ? ctl.selfMuted() : live.people.find((p) => p.cid === cid)?.muted;
        b.classList.toggle('off', !!muted);
        mount(b, icon(muted ? 'micoff' : 'mic'));
      }
    };
    paintMute();
    const vselEl = panel.querySelector('[data-el=vsel]');
    if (vselEl) { const vs = voiceSelector(() => live.voice); mount(vselEl, vs.tpl); vs.bind(vselEl); }
    const loop = () => {
      for (const row of panel.querySelectorAll('[data-cid]')) setMeter(row.querySelector('.meter'), ctl.voiceLevel(row.dataset.cid));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return paintMute;
  }

  async function soundsPanel() {
    items = await ctl.sounds();
    const paintPads = () => {
      const T = SOUND_TABS.find((x) => x.id === stab);
      const list = items.filter((i) => T.zones.includes(i.zone) && i.origin === origin);
      const groups = [];
      for (const z of T.zones) {
        const inZ = list.filter((i) => i.zone === z);
        for (const sec of [...new Set(inZ.map((i) => i.section || ''))]) {
          const title = [T.zones.length > 1 ? (z === 'bg' ? 'De fondo · en bucle' : 'Canciones') : '', sec].filter(Boolean).join(' · ');
          groups.push({ title, items: inZ.filter((i) => (i.section || '') === sec) });
        }
      }
      const music = ctl.music();
      const fxKeys = new Set(ctl.fxKeys());
      let idx = 0;
      const padHtml = (it) => {
        const playing = fxKeys.has(it.key) || (music && music.key === it.key);
        return html`<button class="pad c${idx++ % 6} ${playing ? 'playing' : ''}" data-pad="${it.key}">
          <span class="n">${it.name}</span><span class="d">${fmtShortDur(it.duration)}${it.zone === 'bg' ? ' · bucle' : ''}</span><span class="p"></span><span class="zone-ic" aria-hidden="true">${it.zone === 'fx' ? '⚡' : it.zone === 'jingle' ? '📻' : it.zone === 'bg' ? '♫' : '♪'}</span>
          <span class="cue" data-cue="${it.key}" role="button" aria-label="Pre-escuchar ${it.name} solo en tus cascos">${icon('hp')}</span>
        </button>`;
      };
      mount(panel, html`
        <div class="col gap">
          <div class="seg">${SOUND_TABS.map((t) => html`<button data-stab="${t.id}" class="${stab === t.id ? 'on' : ''}">${t.label}</button>`)}</div>
          <div class="row between gap">
            <div class="seg dark grow"><button data-origin="serie" class="${origin === 'serie' ? 'on' : ''}">De serie</button><button data-origin="mias" class="${origin === 'mias' ? 'on' : ''}">Mías</button></div>
            ${remote ? '' : html`<a class="btn sm ghost" href="/mi-porche?tab=sonidos" aria-label="Añadir sonidos">${icon('plus')}</a>`}
          </div>
          <div class="muted tiny">${T.hint} ${stab === 'music' ? 'Toca para que suene; toca otra vez para pararla.' : 'Toca para que suene. Círculo de cascos: lo oyes solo tú antes de lanzarlo.'}</div>
          ${stab === 'music' ? html`<div class="card tight now">
            <div class="vinyl ${music ? 'spin' : ''}"></div>
            <div class="grow"><div class="b ellip">${music ? music.name : 'Sin música sonando'}</div><div class="muted small mono" data-el="mpos">—</div></div>
            ${music ? html`<button class="btn sm ghost" data-act="stopmusic">Parar</button>` : ''}
          </div>` : ''}
          <div class="pads">${list.length ? groups.map((g) => html`${g.title ? html`<div class="sec-title">${g.title}</div>` : ''}${g.items.map(padHtml)}`) : html`<p class="muted small sec-title">${origin === 'mias' ? (remote ? 'Los sonidos propios del estudio aparecen aquí.' : 'Aún no has añadido nada aquí. Pulsa + para subir MP3, vídeo o grabar.') : 'No hay sonidos de serie en esta pestaña.'}</p>`}</div>
        </div>`);
    };
    paintPads();
    let lastSig = '';
    const loop = () => {
      const keys = ctl.fxKeys();
      const mu = ctl.music();
      const sig = keys.join('|') + '#' + (mu ? mu.key : '');
      if (sig !== lastSig) { lastSig = sig; for (const el of panel.querySelectorAll('[data-pad]')) { const k = el.dataset.pad; const on = keys.includes(k) || (mu && mu.key === k); el.classList.toggle('playing', !!on); if (!keys.includes(k)) setPct(el, '--p', 0); } }
      for (const k of keys) { const el = panel.querySelector(`[data-pad="${CSS.escape(k)}"]`); if (el) setPct(el, '--p', (ctl.fxProgress(k) || 0) * 100); }
      const mp = panel.querySelector('[data-el=mpos]');
      if (mp) mp.textContent = mu ? `${fmtShortDur(mu.pos)} / ${fmtShortDur(mu.dur)}` : '—';
      raf = requestAnimationFrame(loop);
    };
    loop();
    soundsPanel.repaint = paintPads;
  }

  function mesaPanel() {
    const f = ctl.faders();
    const fader = (id, label, val, max = 1) => html`<div class="fader"><span class="l ellip">${label}</span><input class="slider" type="range" min="0" max="${max}" step="0.01" value="${val}" data-fader="${id}" aria-label="${label}"><span class="v">${Math.round((val / max) * 100)}</span></div>`;
    mount(panel, html`<div class="col gap">
      <div class="h3">Volumen de cada cosa en antena</div>
      ${fader('music', 'Música', f.music)}
      ${fader('fx', 'Efectos', f.fx)}
      ${f.tab != null ? fader('tab', 'Pestaña', f.tab) : ''}
      ${f.voices.map((v) => fader('v:' + v.id, v.id === 'me' ? 'Micro estudio' : v.name || 'Invitado', v.gain, 1.5))}
      <div class="toggle-row"><div class="grow"><b>La música baja sola cuando alguien habla</b><div class="muted tiny">Y vuelve al callar. Si mueves el deslizador de Música, manda tu mano.</div></div><span class="switch"><input type="checkbox" data-act="ducking" ${ctl.ducking() ? 'checked' : ''}><span></span></span></div>
      ${!remote && canShareTab() ? html`<div class="card col gap-s">
        <b>${icon('tab')} Compartir pestaña con audio</b>
        <div class="muted tiny">Mete en la emisión el sonido de una pestaña de Chrome (p. ej. un vídeo que comentáis). Marca «Compartir audio» al elegirla. Solo fragmentos breves para comentar: emitir contenido completo puede vulnerar derechos.</div>
        ${live.mixer?.tabSrc ? html`<button class="btn sm ghost" data-act="stoptab">Dejar de compartir</button>` : html`<button class="btn sm yellow" data-act="sharetab">Elegir pestaña</button>`}
      </div>` : ''}
      <p class="muted tiny">Hasta unos 15–20 oyentes y 8 micros a la vez. Con wifi va casi siempre; con datos móviles alguna conexión puede fallar.</p>
    </div>`);
    panel.querySelectorAll('.slider').forEach((s) => s.style.setProperty('--v', (s.value / s.max) * 100 + '%'));
  }

  function chatPanel() {
    mount(panel, html`<div class="col gap chat-panel">
      <div class="pinned" data-el="pin" ${live.state.pinned ? '' : 'hidden'}></div>
      <div class="chat" data-el="chatbox"></div>
      <div class="composer"><input class="input" maxlength="${LIMITS.CHAT_MAX}" placeholder="Escribe a tus oyentes…" aria-label="Mensaje"><button class="btn yellow" data-act="pinmsg" title="Fijar mensaje">📌</button></div>
      <p class="muted tiny">Toca un nombre para fijar su mensaje, silenciar, expulsar o bloquear.</p>
    </div>`);
    const box = panel.querySelector('[data-el=chatbox]');
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

  function fire(key, cue) {
    const it = items.find((i) => i.key === key);
    if (!it) return;
    haptic(8);
    if (cue) { ctl.cue(it).then((on) => { if (on) toast(`Pre-escucha: ${it.name} (solo tú). Toca otra vez para parar.`); }); return; }
    ctl.fire(key, { loop: it.zone === 'bg' ? true : it.zone === 'song' ? false : undefined });
    setTimeout(() => soundsPanel.repaint?.(), remote ? 900 : 80);
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
    if ((b = t.closest('[data-pad]'))) { if (pressed) { pressed = false; return; } b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 120); return fire(b.dataset.pad, false); }
    if ((b = t.closest('[data-stab]'))) { stab = b.dataset.stab; return soundsPanel.repaint(); }
    if ((b = t.closest('[data-origin]'))) { origin = b.dataset.origin; return soundsPanel.repaint(); }
    if ((b = t.closest('[data-mute]'))) {
      const cid = b.dataset.mute;
      const muted = cid === 'me' ? ctl.selfMuted() : live.people.find((x) => x.cid === cid)?.muted;
      ctl.muteVoice(cid, !muted);
      setTimeout(() => { header(); voicesPanel.paint?.(); }, remote ? 900 : 60);
      return;
    }
    if ((b = t.closest('[data-menu]'))) {
      const p = live.people.find((x) => x.cid === b.dataset.menu);
      if (p) personMenu({ name: p.name, dev: p.dev, cid: p.cid, canMod: true, isHost: true, onMod: (act, x) => {
        if (act === 'mute') ctl.muteVoice(x.cid, true);
        if (act === 'kick' || act === 'ban') live.send({ t: 'kick', cid: x.cid, ban: act === 'ban' });
      } });
      return;
    }
    if ((b = t.closest('[data-q]'))) {
      const q = b.dataset.q;
      if (q === 'selfmute') ctl.setSelfMute(!ctl.selfMuted());
      if (q === 'solo') ctl.setSolo(!ctl.solo());
      if (q === 'up') { ctl.up(); toast('Música en primer plano'); }
      if (q === 'down') { ctl.down(); toast('Música de fondo, bajo las voces'); }
      haptic(8);
      setTimeout(() => { header(); if (tab === 'voces') voicesPanel.paint?.(); }, remote ? 900 : 60);
      return;
    }
    if (!(b = t.closest('[data-act]'))) return;
    switch (b.dataset.act) {
      case 'invite': inviteSheet(porch); break;
      case 'role': roleSheet(); break;
      case 'roleinfo': roleInfoSheet(); break;
      case 'takestudio': live.takeStudio(); break;
      case 'activatemic':
        try { audioCtx(); await live.startVoice(localStorage.getItem('rp_hp') !== '0'); reqs(); toast('Micro activo', 'good'); } catch { toast('No se ha podido abrir el micro', 'bad'); }
        break;
      case 'stopmusic': ctl.stopMusic(); setTimeout(() => soundsPanel.repaint?.(), remote ? 900 : 80); break;
      case 'sharetab':
        try { await live.mixer.shareTab(); live.mixer.onTabEnd = () => tab === 'mesa' && mesaPanel(); mesaPanel(); toast('Pestaña en antena', 'good'); } catch (err) { toast(err.message || 'No se ha compartido', 'bad'); }
        break;
      case 'stoptab': live.mixer?.stopTab(); mesaPanel(); break;
      case 'pause': ctl.pause(!live.state.paused); break;
      case 'nextpart': ctl.nextPart(); toast('Grabando la parte siguiente', 'good'); break;
      case 'pinmsg': { const inp = panel.querySelector('.composer input'); const txt = inp?.value.trim(); if (txt) { live.send({ t: 'pin', text: txt }); inp.value = ''; } else toast('Escribe el mensaje que quieres fijar'); break; }
      case 'unpin': live.send({ t: 'pin', text: '' }); break;
      case 'end': {
        const rec = ctl.rec();
        const min = LIMITS.MIN_PUBLISH_MIN;
        let msg = 'Los oyentes dejarán de oírte.';
        if (rec) {
          msg = 'Los oyentes dejarán de oírte. La grabación se guarda en Mi porche → Grabaciones, en el aparato que emite.';
          if (rec.elapsed < min * 60) msg += ` Ojo: esta parte dura ${fmtTime(rec.elapsed)}. Con menos de ${min} minutos no podrás publicarla, solo guardarla en privado.`;
        }
        if (!(await confirmSheet('¿Terminar la emisión?', msg, { ok: 'Fin emisión', danger: true }))) return;
        if (remote) { live.ctl('end'); toast('Emisión terminada'); return; }
        await live.endBroadcast(true);
        const parts = live.recParts.slice();
        live.disconnect();
        if (parts.length) { toast('Guardado en Grabaciones', 'good'); ctx.go(`/editor/${parts[0].id}`); }
        else ctx.go('/mi-porche');
        break;
      }
    }
  });
  view.addEventListener('input', (e) => {
    const s = e.target.closest('[data-fader]');
    if (!s) return;
    const v = Number(s.value);
    s.style.setProperty('--v', (v / s.max) * 100 + '%');
    s.parentElement.querySelector('.v').textContent = Math.round((v / s.max) * 100);
    ctl.setFader(s.dataset.fader, v);
  });
  view.addEventListener('change', async (e) => {
    if (e.target.matches('[data-act=hp]')) {
      const on = e.target.checked; localStorage.setItem('rp_hp', on ? '1' : '0');
      if (live.voice) { try { await live.startVoice(on); } catch {} }
      live.setListenHere(on);
      view.querySelectorAll('[data-act=listenhere]').forEach((x) => (x.checked = on));
      view.querySelectorAll('[data-act=monitor]').forEach((x) => (x.checked = !!live.voice?.monitorOn));
      toast(on ? 'Con cascos: oyes la emisión y la voz suena más limpia.' : 'Sin cascos: tu móvil no suena (evita acoples) y se activa la cancelación de eco.');
    }
    if (e.target.matches('[data-act=michere]')) { live.setMicHere(e.target.checked).catch(() => toast('No se ha podido abrir el micro', 'bad')); setTimeout(() => voicesPanel.paint?.(), 300); }
    if (e.target.matches('[data-act=listenhere]')) { live.setListenHere(e.target.checked); view.querySelectorAll('[data-act=monitor]').forEach((x) => (x.checked = !!live.voice?.monitorOn)); }
    if (e.target.matches('[data-act=ducking]')) ctl.setDucking(e.target.checked);
    if (e.target.matches('[data-act=monitor]')) live.voice?.setMonitor(e.target.checked);
  });

  const clockIv = setInterval(header, 1000);
  let soundsSig = '';
  const offs = [
    onLive('update', () => { header(); reqs(); if (tab === 'voces') { const before = panel.querySelectorAll('[data-cid]').length; const now = live.people.filter((p) => p.role === 'guest').length + 1; if (before !== now) showTab('voces'); else voicesPanel.paint?.(); } }),
    onLive('remote', () => {
      header();
      if (tab === 'voces') voicesPanel.paint?.();
      const sig = live.remoteSounds.length + ':' + (live.remoteSounds[0]?.key || '');
      if (tab === 'sonidos' && sig !== soundsSig) { soundsSig = sig; items = live.remoteSounds; soundsPanel.repaint?.(); }
    }),
    onLive('chat', () => { if (tab !== 'chat') { unread++; $el('nchat').textContent = `(${unread})`; } }),
    onLive('warn', (msg) => { haptic(200); toast(msg, 'bad'); }),
    onLive('partClosed', (part) => {
      sheet(html`<h2 class="h2">Parte ${part} guardada</h2><p class="muted">Has llegado a ${LIMITS.MAX_PART_MIN} minutos. Esta parte se ha cerrado y está en Grabaciones. El directo sigue sonando para los oyentes.</p><button class="btn yellow big" data-close="go">Grabar Parte ${part + 1}</button><button class="btn ghost" data-close="">Seguir sin grabar</button>`).done.then((v) => { if (v === 'go') live.continueNextPart(); });
    }),
  ];
  header(); reqs(); showTab('voces');
  return () => { stopPreview(); clearInterval(clockIv); cancelAnimationFrame(raf); panelCleanup?.(); offs.forEach((f) => f()); };
}
