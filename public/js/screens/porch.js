// Pantalla de un porche: Oyente (con chat y pedir micro), Invitado con micro,
// Camerino (antes de salir) y Cabina (en directo) para quien presenta.
import { api, session } from '../api.js';
import { LIMITS, VOICE_FX, BROADCAST_MODES, QUICK_REACTIONS, SOUND_TABS } from '../config.js';
import { html, mount, icon, raw, toast, sheet, confirmSheet, fmtTime, fmtShortDur, fmtDate, haptic, setPct, esc, on } from '../util.js';
import { porchCover, requireIdentity, personMenu, shareUrl, isBlocked, nameColor, avatar } from '../common.js';
import { live, onLive } from '../live.js';
import { meterHtml, setMeter, audioCtx } from '../audio/voice.js';
 '../audio/sounds.js';
import { getSetting, setSetting } from '../db.js';
import { makeCtl, onPreview, stopPreview, previewKey, cueSource } from '../cabina-ctl.js';
import { loadStandard } from '../audio/sounds.js';
import { mountShareCard, stopShare } from '../screenshare.js';
import { getPref, setPref } from '../inbox.js';
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
        const now = getVoice()?.effect || '';
        const choice = await sheet(html`<h2 class="h2">Voz de personaje</h2><p class="muted small">Todas suenan al mismo volumen. Cambia cuando quieras, también en el aire.</p>
          <div class="fx-grid">${VOICE_FX.map((f) => html`<button class="fx-opt ${now === f.id ? 'on' : ''}" data-close="${f.id}"><b>${f.name}</b><span>${f.hint}</span></button>`)}</div>`).done;
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
    <label class="radio-opt"><input type="radio" name="m" value="patio"><div><div class="t">Estoy a su lado</div><div class="d">En el mismo sitio que quien presenta. Mi móvil es solo micro: no suena el programa (así no se acopla).</div></div></label>
    <label class="radio-opt"><input type="radio" name="m" value="casa" checked><div><div class="t">Estoy en otro sitio</div><div class="d">En mi casa o en otro lugar. Oigo el programa por cascos.</div></div></label>
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
      mount(b, html`<div class="banner dash"><span class="grow">${icon('mic')} Has pedido micro${me.micReq.mode === 'patio' ? ' · a su lado' : ' · desde otro sitio'}. Esperando paso…</span><button class="btn sm ghost" data-act="cancelmic">Cancelar</button></div>`);
    } else {
      const vs = voiceSelector(() => live.guestVoice);
      mount(b, html`<div class="mic-panel">
        ${live.isOwner ? html`<div class="role-badge mic"><span class="dot"></span><span class="grow"><b>Este ${live.kind} es MICRO</b> · el estudio es tu ${live.state.studioKind || 'otro aparato'}</span></div>` : ''}
        <div class="row between gap">
          <div class="row gap-s"><span class="chip ${live.guestMode}">${live.guestMode === 'patio' ? 'A su lado · solo micro' : 'En otro sitio · cascos'}</span>${live.state.rec ? html`<span class="rec-chip">REC</span>` : ''}</div>
          <button class="btn sm ghost" data-act="leavemic">Dejar el micro</button>
        </div>
        ${raw(meterHtml())}
        ${vs.tpl}
        <div class="row gap">
          <label class="row gap-s grow small"><span class="switch"><input type="checkbox" data-act="monitor"><span></span></span> Oírme <span class="muted tiny">(con cascos de cable suena sin retraso)</span></label>
          <button class="mic-btn" data-act="selfmute" aria-label="Silenciarme">${icon('mic')}</button>
        </div>
        <div class="row gap">${live.isOwner ? '' : html`<button class="btn ghost grow" data-act="gfx">${icon('bolt')} Efectos</button>`}<button class="btn ghost grow" data-act="gshare">${icon('tab')} Compartir pantalla</button></div>
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
      case 'gfx': guestFxSheet(); break;
      case 'gshare': { let off = null; const sh = sheet(html`<h2 class="h2">Compartir pantalla</h2><div data-el="sc"></div>`, { onMount(a) { off = mountShareCard(a.el.querySelector('[data-el=sc]')); } }); sh.done.then(() => off?.()); break; }
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
      <div class="guest-chip">${avatar(g)}<div><div class="n">${g.name}</div><div class="d">${g.mode === 'patio' ? 'A tu lado' : 'A distancia · cascos'}</div></div></div>`)}</div>`
      : html`<div class="muted small">Nadie aún. Pulsa «Invitar al micro» y manda el enlace.</div>`);
    const reqs = live.people.filter((p) => p.micReq);
    mount($el('reqs'), html`${reqs.map((r) => html`<div class="banner dash req"><span class="grow"><b class="orange-t">${r.name}</b> pide micro · ${r.micReq.mode === 'patio' ? 'a tu lado' : 'a distancia'}${r.micReq.hp ? '' : ' (sin cascos)'}</span><button class="btn sm yellow" data-grant="${r.cid}">Dar paso</button></div>`)}`);
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
    <p class="muted small">Manda este enlace a quien quieras en el programa (también sirve para los ensayos privados). Al abrirlo elige <b>Estoy a su lado</b> (está contigo) o <b>Estoy en otro sitio</b> (desde su casa, con cascos) y <b>entra directo al micro</b>, sin que tengas que darle paso. Si se le corta o cambia de app, vuelve a entrar solo. El enlace sirve para todo el programa y para los siguientes, hasta que lo cambies.</p>
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
  let stab = 'jingle', folder = '', query = '', cueMode = false;
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
        <button data-tab="voces" class="on">Voces</button><button data-tab="sonidos">Sonidos</button><button data-tab="mesa">Mesa</button><button data-tab="chat">Chat <span data-el="nchat"></span></button>
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
    mount($el('reqs'), html`${!remote && !live.voice ? html`<div class="banner red"><span class="grow">Tu micro no está activo.</span><button class="btn sm yellow" data-act="activatemic">Activar micro</button></div>` : ''}${r.map((p) => html`<div class="banner dash req"><span class="grow ellip"><b class="orange-t">${p.name}</b> pide micro · ${p.micReq.mode === 'patio' ? 'a tu lado' : 'a distancia'}</span><button class="btn sm yellow" data-grant="${p.cid}">Dar paso</button><button class="btn sm ghost" data-deny="${p.cid}" aria-label="Rechazar">✕</button></div>`)}`);
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
          <div class="name"><span class="ellip">${g.name}</span>${g.me ? '' : html`<span class="chip ${g.mode}">${g.mode === 'patio' ? 'A tu lado' : 'A distancia'}</span>`}${!g.me && !g.hp ? html`<span class="chip dark">sin cascos</span>` : ''}</div>
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
    // Esqueleto fijo (la lupa no pierde el foco al escribir); cada zona se repinta por separado
    mount(panel, html`
      <div class="col gap sb ${cueMode ? 'cue-mode' : ''}" data-el="sb">
        <button class="cue-toggle ${cueMode ? 'on' : ''}" data-act="cuemode" aria-pressed="${cueMode}">${icon('hp')}<span class="grow"><b>Pre-escucha</b><span class="tiny">${cueMode ? 'Activada: lo que toques solo lo oyes tú' : 'Actívala para oír un sonido antes de emitirlo'}</span></span><span class="sw"></span></button>
        <div class="cue-banner ${cueMode ? '' : 'hidden'}" data-el="cueban">${icon('hp')}<span class="grow"><b>PRE-ESCUCHA</b> · solo lo oyes tú · no sale al aire<span class="cue-now" data-el="cuenow"></span></span><button class="btn sm ghost" data-act="cuestop">Parar</button></div>
        <div class="fav-head"><span class="h3">${icon('starf')} Favoritos</span>${remote ? '' : html`<a class="btn sm ghost" href="/mi-porche?tab=sonidos" aria-label="Añadir sonidos propios">${icon('plus')} Añadir</a>`}</div>
        <div class="fav-strip" data-el="favs"></div>
        <div class="row gap-s"><div class="seg grow" data-el="stabs"></div><button class="icon-btn sq ${query ? 'on' : ''}" data-act="search" aria-label="Buscar sonido">${icon('search')}</button></div>
        <div class="search-row ${query ? '' : 'hidden'}" data-el="srow"><input class="input" data-el="sq" placeholder="Buscar sonido…" value="${query}" autocomplete="off"></div>
        <div class="chips-row" data-el="folders"></div>
        <div data-el="now"></div>
        <div class="pads" data-el="grid"></div>
        <div class="muted tiny" data-el="hint"></div>
      </div>`);
    const $p = (n) => panel.querySelector(`[data-el=${n}]`);
    const favKeys = () => getPref('favs', []).filter((k) => items.some((i) => i.key === k));
    const zoneCls = (z) => `z-${z}`;
    const padHtml = (it, F, playingSet, music) => {
      const playing = playingSet.has(it.key) || (music && music.key === it.key);
      const fav = F.includes(it.key);
      return html`<button class="pad ${zoneCls(it.zone)} ${playing ? 'playing' : ''}" data-pad="${it.key}">
        <span class="n">${it.name}</span>
        <span class="d">${fmtShortDur(it.duration)}${it.zone === 'bg' ? ' · bucle' : ''}${it.origin === 'mias' ? ' · tuyo' : ''}</span><span class="p"></span>
        <span class="star ${fav ? 'on' : ''}" data-fav="${it.key}" role="button" aria-label="${fav ? 'Quitar de favoritos' : 'Añadir a favoritos'}">${icon(fav ? 'starf' : 'star')}</span>
        <span class="cue" data-cue="${it.key}" role="button" aria-label="Pre-escuchar ${it.name} solo en tus cascos">${icon('hp')}</span>
      </button>`;
    };
    const paintPads = () => {
      const F = favKeys();
      const music = ctl.music();
      const playingSet = new Set(ctl.fxKeys());
      // Favoritos: siempre arriba, en el orden en que los marcaste
      const favItems = F.map((k) => items.find((i) => i.key === k)).filter(Boolean);
      mount($p('favs'), favItems.length ? html`${favItems.map((it) => padHtml(it, F, playingSet, music))}` : html`<div class="fav-empty">Toca ${icon('star')} en cualquier sonido para tenerlo siempre aquí, a un toque.</div>`);
      // Pestañas
      mount($p('stabs'), html`${SOUND_TABS.map((t) => html`<button data-stab="${t.id}" class="${!query && stab === t.id ? 'on' : ''}">${t.label}</button>`)}`);
      const T = SOUND_TABS.find((x) => x.id === stab);
      const q = query.trim().toLowerCase();
      let list = q ? items.filter((i) => `${i.name} ${i.section || ''}`.toLowerCase().includes(q)) : items.filter((i) => T.zones.includes(i.zone));
      // Carpetas (las secciones): solo si hay más de una
      const folders = q ? [] : [...new Set(list.map((i) => i.section || ''))].filter(Boolean);
      if (!folders.includes(folder)) folder = '';
      mount($p('folders'), folders.length ? html`<button X data-folder="">Todas</button>${folders.map((f) => html`<button class="cat-chip small ${folder === f ? 'on' : ''}" data-folder="${f}">${f}</button>`)}` : '');
      $p('folders').classList.toggle('hidden', !folders.length);
      if (folder) list = list.filter((i) => (i.section || '') === folder);
      if (!q && stab === 'music') list = [...list.filter((i) => i.zone === 'bg'), ...list.filter((i) => i.zone !== 'bg')];
      // Lo que suena ahora (música)
      mount($p('now'), !q && stab === 'music' ? html`<div class="card tight now">
        <div class="vinyl ${music ? 'spin' : ''}"></div>
        <div class="grow"><div class="b ellip">${music ? music.name : 'Sin música sonando'}</div><div class="muted small mono" data-el="mpos">—</div></div>
        ${music ? html`<button class="btn sm ghost" data-act="stopmusic">Parar</button>` : ''}
      </div>` : '');
      mount($p('grid'), list.length ? html`${list.map((it) => padHtml(it, F, playingSet, music))}`
        : html`<p class="muted small sec-title">${q ? `Nada con «${query}».` : remote ? 'No hay sonidos aquí todavía.' : html`Aún no hay nada aquí. Pulsa <b>Añadir</b> para subir MP3, vídeo o grabar.`}</p>`);
      $p('hint').textContent = q ? '' : `${T.hint} ${stab === 'music' ? 'Toca para que suene; otra vez para pararla.' : 'Toca para que suene.'} Cascos: lo oyes solo tú antes. Estrella: a favoritos.`;
    };
    $p('sq').addEventListener('input', (e) => { query = e.target.value; paintPads(); });
    paintPads();
    let lastSig = '';
    const loop = () => {
      const keys = ctl.fxKeys();
      const mu = ctl.music();
      const sig = keys.join('|') + '#' + (mu ? mu.key : '');
      if (sig !== lastSig) { lastSig = sig; for (const el of panel.querySelectorAll('[data-pad]')) { const k = el.dataset.pad; const on = keys.includes(k) || (mu && mu.key === k); el.classList.toggle('playing', !!on); if (!keys.includes(k)) setPct(el, '--p', 0); } }
      for (const k of keys) for (const el of panel.querySelectorAll(`[data-pad="${CSS.escape(k)}"]`)) setPct(el, '--p', (ctl.fxProgress(k) || 0) * 100);
      const mp = panel.querySelector('[data-el=mpos]');
      if (mp) mp.textContent = mu ? `${fmtShortDur(mu.pos)} / ${fmtShortDur(mu.dur)}` : '—';
      raf = requestAnimationFrame(loop);
    };
    loop();
    soundsPanel.repaint = paintPads;
  }

  // ---------- Mesa de mezclas: una tira por línea, con medidor de lo que suena y deslizador vertical
  function mesaPanel() {
    const f = ctl.faders();
    // Tus micros se llaman por el aparato (si tienes dos abiertos, sabes cuál es cuál)
    const studioKind = live.role === 'host' ? live.kind : live.state?.studioKind || '';
    const voiceLabel = (v) => {
      if (v.id === 'me') return `Tú · ${studioKind || 'estudio'}`;
      const p = live.people.find((x) => x.cid === v.id);
      if (p?.owner) return `Tú · ${p.kind || 'otro aparato'}`;
      return v.name || p?.name || 'Invitado';
    };
    const strips = [
      ...f.voices.map((v) => ({ id: 'v:' + v.id, vid: v.id, label: voiceLabel(v), val: v.gain, max: 1.5, kind: 'voz', mute: v.id })),
      { id: 'music', label: 'Música', val: f.music, max: 1, kind: 'music' },
      { id: 'fx', label: 'Cortinillas y efectos', val: f.fx, max: 1, kind: 'fx' },
      ...(f.tab != null ? [{ id: 'tab', label: 'Pestaña', val: f.tab, max: 1, kind: 'tab' }] : []),
    ];
    const muted = (st) => (st.mute === 'me' ? ctl.selfMuted() : !!live.people.find((x) => x.cid === st.mute)?.muted);
    const SEG = 14;
    mount(panel, html`<div class="col gap">
      <div class="mesa">${strips.map((st) => html`
        <div class="strip k-${st.kind}" data-strip="${st.id}">
          <div class="strip-name">${st.label}</div>
          <div class="strip-body">
            <div class="vu" data-vu="${st.id}">${raw('<i></i>'.repeat(SEG))}</div>
            <div class="vfader" data-vf="${st.id}" data-max="${st.max}" style="--v:${Math.min(1, st.val / st.max)}" role="slider" aria-label="Volumen de ${st.label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((st.val / st.max) * 100)}" tabindex="0">
              <div class="vf-track"><div class="vf-fill"></div></div><div class="vf-thumb"></div>
            </div>
          </div>
          <div class="strip-val mono" data-sv="${st.id}">${Math.round((st.val / st.max) * 100)}</div>
          ${st.mute ? html`<button class="strip-mute ${muted(st) ? 'on' : ''}" data-mute="${st.mute}" aria-label="Silenciar ${st.label}">${icon(muted(st) ? 'micoff' : 'mic')}</button>` : html`<span class="strip-mute ghost"></span>`}
        </div>`)}</div>
      <div class="muted tiny">Cada tira es una línea de la emisión: el medidor enseña lo que suena y el deslizador sube o baja su volumen. Lo que oyes en tus cascos de tu propia voz sigue a tu tira.</div>
      <div class="toggle-row"><div class="grow"><b>Los invitados pueden lanzar efectos</b><div class="muted tiny">Efectos y cortinillas de serie, desde su móvil. La música la pones solo tú.</div></div><span class="switch"><input type="checkbox" data-act="guestfx" ${localStorage.getItem('rp_guestfx') !== '0' ? 'checked' : ''}><span></span></span></div>
      <div class="toggle-row"><div class="grow"><b>Protege las voces</b><div class="muted tiny">Cuando alguien habla, la música y los sonidos largos (falcas, cortinillas) bajan solos para que se os entienda, y vuelven al callar. Si mueves una tira, manda tu mano unos segundos.</div></div><span class="switch"><input type="checkbox" data-act="ducking" ${ctl.ducking() ? 'checked' : ''}><span></span></span></div>
      <div data-el="sharecard"></div>
      <p class="muted tiny">Hasta unos 15–20 oyentes y 8 micros a la vez. Con wifi va casi siempre; con datos móviles alguna conexión puede fallar.</p>
    </div>`);
    // Deslizadores verticales (arrastrar o tocar en cualquier punto de la tira)
    let lastSend = 0;
    const setFromY = (el, clientY, final = false) => {
      const r = el.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
      const max = Number(el.dataset.max);
      el.style.setProperty('--v', k);
      el.setAttribute('aria-valuenow', Math.round(k * 100));
      const sv = panel.querySelector(`[data-sv="${CSS.escape(el.dataset.vf)}"]`); if (sv) sv.textContent = Math.round(k * 100);
      const now = Date.now();
      if (final || now - lastSend > (remote ? 120 : 30)) { lastSend = now; ctl.setFader(el.dataset.vf, Math.round(k * max * 100) / 100); }
    };
    panel.querySelectorAll('[data-vf]').forEach((el) => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('drag'); setFromY(el, e.clientY); });
      el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) setFromY(el, e.clientY); });
      const end = (e) => { if (el.hasPointerCapture?.(e.pointerId)) { el.releasePointerCapture(e.pointerId); setFromY(el, e.clientY, true); } el.classList.remove('drag'); };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      el.addEventListener('keydown', (e) => {
        const cur = Number(getComputedStyle(el).getPropertyValue('--v')) || 0;
        const d = e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowDown' ? -0.05 : 0;
        if (!d) return; e.preventDefault();
        const r = el.getBoundingClientRect();
        setFromY(el, r.top + (1 - Math.min(1, Math.max(0, cur + d))) * r.height, true);
      });
    });
    // Medidores en vivo (con caída suave y marca de pico)
    const vus = [...panel.querySelectorAll('[data-vu]')].map((el) => ({ el, id: el.dataset.vu, segs: [...el.children], v: 0, pk: 0, pkT: 0 }));
    const loop = () => {
      const now = performance.now();
      for (const m of vus) {
        const raw = m.id.startsWith('v:') ? ctl.voiceLevel(m.id.slice(2)) : ctl.busLevel(m.id);
        m.v = raw > m.v ? raw : m.v * 0.88;
        if (m.v >= m.pk || now - m.pkT > 900) { m.pk = m.v; m.pkT = now; }
        const lit = Math.round(m.v * SEG), pki = Math.min(SEG - 1, Math.round(m.pk * SEG) - 1);
        m.segs.forEach((sg, i) => { sg.classList.toggle('on', i < lit); sg.classList.toggle('pk', i === pki && i >= lit); });
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
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
    else if (t === 'mesa') { mesaPanel(); const sc = panel.querySelector('[data-el=sharecard]'); if (sc) panelCleanup = mountShareCard(sc); }
    else if (t === 'chat') panelCleanup = chatPanel();
  }

  function fire(key, cue) {
    const it = items.find((i) => i.key === key);
    if (!it) return;
    haptic(8);
    if (cue) { ctl.cue(it).then((on) => { if (on && !cueMode) toast(`Pre-escucha: ${it.name} (solo tú). Toca otra vez para parar.`); }); return; }
    ctl.fire(key, { loop: it.zone === 'bg' ? true : it.zone === 'song' ? false : undefined });
    setTimeout(() => soundsPanel.repaint?.(), remote ? 900 : 80);
  }
  // Mantener pulsado un cassette = pre-escucha
  let pressT = null, pressed = false;
  panel.addEventListener('pointerdown', (e) => {
    const pad = e.target.closest('[data-pad]');
    if (!pad || e.target.closest('[data-cue]') || e.target.closest('[data-fav]')) return;
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
    if ((b = t.closest('[data-fav]'))) {
      e.stopPropagation();
      const k = b.dataset.fav;
      const F = getPref('favs', []);
      const next = F.includes(k) ? F.filter((x) => x !== k) : [...F, k].slice(-24);
      setPref('favs', next);
      haptic(15);
      return soundsPanel.repaint?.();
    }
    if ((b = t.closest('[data-cue]'))) { e.stopPropagation(); return fire(b.dataset.cue, true); }
    if ((b = t.closest('[data-pad]'))) { if (pressed) { pressed = false; return; } b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 120); return fire(b.dataset.pad, cueMode); }
    if ((b = t.closest('[data-stab]'))) { stab = b.dataset.stab; folder = ''; query = ''; const sq = panel.querySelector('[data-el=sq]'); if (sq) sq.value = ''; panel.querySelector('[data-el=srow]')?.classList.add('hidden'); return soundsPanel.repaint(); }
    if ((b = t.closest('[data-folder]'))) { folder = b.dataset.folder; return soundsPanel.repaint(); }
    if ((b = t.closest('[data-mute]'))) {
      const cid = b.dataset.mute;
      const muted = cid === 'me' ? ctl.selfMuted() : live.people.find((x) => x.cid === cid)?.muted;
      ctl.muteVoice(cid, !muted);
      setTimeout(() => { header(); voicesPanel.paint?.(); if (tab === 'mesa') { const nb = panel.querySelector(`.strip-mute[data-mute="${CSS.escape(cid)}"]`); if (nb) { nb.classList.toggle('on', !muted); mount(nb, icon(!muted ? 'micoff' : 'mic')); } } }, remote ? 900 : 60);
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
      case 'cuemode': cueMode = !cueMode; if (!cueMode) stopPreview(); soundsPanel(); break;
      case 'cuestop': stopPreview(); break;
      case 'search': {
        const row = panel.querySelector('[data-el=srow]');
        if (!row) break;
        const open = row.classList.toggle('hidden') === false;
        b.classList.toggle('on', open);
        if (open) panel.querySelector('[data-el=sq]')?.focus();
        else { query = ''; panel.querySelector('[data-el=sq]').value = ''; soundsPanel.repaint?.(); }
        break;
      }
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
    if (e.target.matches('[data-act=guestfx]')) { localStorage.setItem('rp_guestfx', e.target.checked ? '1' : '0'); if (remote) live.ctl('guestfx', { on: e.target.checked }); }
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
    // Pre-escucha: nombre de lo que suena solo para ti y marca en su botón
    onPreview((k) => {
      const it = items.find((i) => i.key === k);
      const now = panel.querySelector('[data-el=cuenow]'); if (now) now.textContent = it ? ` · Suena: ${it.name}` : '';
      panel.querySelectorAll('[data-pad]').forEach((el) => el.classList.toggle('previewing', el.dataset.pad === k));
      if (k && !cueMode && it) { const ban = panel.querySelector('[data-el=cueban]'); if (ban) ban.classList.remove('hidden'); }
      if (!k && !cueMode) panel.querySelector('[data-el=cueban]')?.classList.add('hidden');
    }),
    onLive('partClosed', (part) => {
      sheet(html`<h2 class="h2">Parte ${part} guardada</h2><p class="muted">Has llegado a ${LIMITS.MAX_PART_MIN} minutos. Esta parte se ha cerrado y está en Grabaciones. El directo sigue sonando para los oyentes.</p><button class="btn yellow big" data-close="go">Grabar Parte ${part + 1}</button><button class="btn ghost" data-close="">Seguir sin grabar</button>`).done.then((v) => { if (v === 'go') live.continueNextPart(); });
    }),
  ];
  header(); reqs(); showTab('voces');
  return () => { stopPreview(); stopShare(); clearInterval(clockIv); cancelAnimationFrame(raf); panelCleanup?.(); offs.forEach((f) => f()); };
}

/** Botonera del invitado: efectos y cortinillas de serie, con pre-escucha (solo la oye él) o al aire (lo lanza el estudio). */
async function guestFxSheet() {
  let list = [];
  try { list = (await loadStandard()).filter((i) => i.zone === 'fx' || i.zone === 'jingle'); } catch {}
  let cueMode = false, tab = 'fx', off = () => {};
  const s = sheet(html`
    <h2 class="h2">Efectos y cortinillas</h2>
    <button class="cue-toggle" data-a="cue">${icon('hp')}<span class="grow"><b>Pre-escucha</b><span class="tiny" data-el="ct">Actívala para oír un sonido antes de lanzarlo</span></span><span class="sw"></span></button>
    <div class="cue-banner hidden" data-el="cb">${icon('hp')}<span class="grow"><b>PRE-ESCUCHA</b> · solo lo oyes tú · no sale al aire</span></div>
    <div class="seg"><button data-t="fx" class="on">Efectos</button><button data-t="jingle">Cortinillas</button></div>
    <div class="pads" data-el="pads"></div>
    <p class="muted tiny">Sin pre-escucha, al tocar un sonido suena para todos (si quien presenta lo permite). Uno cada segundo y medio, como mucho.</p>`, {
    onMount(a) {
      const paint = () => {
        const pk = previewKey();
        mount(a.el.querySelector('[data-el=pads]'), html`${list.filter((i) => i.zone === tab).map((i) => html`<button class="pad z-${i.zone} ${pk === 'serie:' + i.id ? 'previewing' : ''}" data-k="${i.id}"><span class="n">${i.name}</span><span class="d">${fmtShortDur(i.duration)}</span><span class="p"></span></button>`)}`);
        a.el.querySelector('[data-el=pads]').parentElement.classList.toggle('cue-mode', cueMode);
      };
      paint();
      off = onPreview(paint);
      a.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a=cue]');
        if (b) {
          cueMode = !cueMode; b.classList.toggle('on', cueMode);
          a.el.querySelector('[data-el=ct]').textContent = cueMode ? 'Activada: lo que toques solo lo oyes tú' : 'Actívala para oír un sonido antes de lanzarlo';
          a.el.querySelector('[data-el=cb]').classList.toggle('hidden', !cueMode);
          if (!cueMode) stopPreview();
          return paint();
        }
        const t = e.target.closest('[data-t]');
        if (t) { tab = t.dataset.t; a.el.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === t)); return paint(); }
        const k = e.target.closest('[data-k]');
        if (!k) return;
        const it = list.find((i) => i.id === k.dataset.k);
        if (cueMode) return cueSource('serie:' + it.id, it);
        haptic(10);
        live.send({ t: 'gfx', key: 'serie:' + it.id });
        toast(`«${it.name}» al aire`);
      });
    },
  });
  await s.done;
  off();
  stopPreview();
}
