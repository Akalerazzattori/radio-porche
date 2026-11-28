// Mi porche: ir al camerino, grabaciones (borradores y privados), publicados (editar),
// sonidos propios (efectos, música de fondo, canciones) y datos del porche.
import { api, session } from '../api.js';
import { LIMITS, ZONES, SOUND_TABS } from '../config.js';
import { html, mount, icon, toast, sheet, confirmSheet, promptSheet, fmtDur, fmtDate, fmtShortDur, fmtBytes, setPct, esc } from '../util.js';
import { requireIdentity, porchCover, podcastCover, shareUrl, copy } from '../common.js';
import { db } from '../db.js';
import { live } from '../live.js';
import { loadStandard, loadMine, importSound, deleteSound, renameSound, recordMic, saveRecordedSound, decode } from '../audio/sounds.js';
import { audioCtx } from '../audio/voice.js';
import { shrinkPhoto, SCENES } from '../cover.js';
import { recordingThumb, recordingDetailsSheet } from './editor.js';

export async function render(view, _p, { go }) {
  if (!session.token) {
    mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Mi porche</h1></div>
      <div class="empty fill"><img src="/img/scenes/escena-3.webp" alt=""><p class="b">Abre tu porche y emite con tus amigos desde el móvil.</p><button class="btn red big" data-act="login">Entrar con mi nombre</button></div></section>`);
    view.querySelector('[data-act=login]').onclick = async () => { if (await requireIdentity()) go('/mi-porche', { replace: true }); };
    return;
  }
  let me;
  try { me = await api('/api/me'); } catch (e) { mount(view, html`<section class="screen"><h1 class="h1">Mi porche</h1><p class="muted">${e.message}</p></section>`); return; }
  let porch = me.porch;
  const params = new URLSearchParams(location.search);
  let tab = params.get('tab') || 'grabaciones';
  if (!porch) {
    mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Mi porche</h1></div>
      <div class="empty fill"><img src="/img/scenes/escena-1.webp" alt=""><p>Aún no tienes porche.</p><button class="btn red big" data-act="create">Crear mi porche</button></div></section>`);
    view.querySelector('[data-act=create]').onclick = async () => {
      try { await api('/api/porch/create', { method: 'POST', body: {} }); go('/mi-porche', { replace: true }); } catch (e) { toast(e.message, 'bad'); }
    };
    return;
  }
  const onAir = live.active && live.role === 'host' && live.state.live;
  mount(view, html`
    <section class="screen">
      <div class="top">
        <img class="brand-ic" src="/img/app-icon-192.png" alt="" width="40" height="40">
        <div class="grow"><h1 class="h1">Mi porche</h1><div class="sub ellip"><span class="chip freq">${porch.freq.toFixed(1)}</span> ${porch.name}</div></div>
        <button class="icon-btn" data-act="share" aria-label="Compartir mi porche">${icon('share')}</button>
      </div>
      ${onAir
        ? html`<a class="btn red big" href="/porche/${porch.slug}">${icon('radio')} Estás en el aire · volver a la cabina</a>`
        : html`<a class="btn red big" href="/porche/${porch.slug}">${icon('mic')} Ir a la cabina</a>`}
      <div class="seg">
        <button data-tab="grabaciones">Grabaciones</button><button data-tab="publicados">Publicados</button><button data-tab="sonidos">Botonera</button><button data-tab="porche">Porche</button>
      </div>
      <div class="fill scroll" data-el="panel"></div>
    </section>`);
  const panel = view.querySelector('[data-el=panel]');

  async function show(t) {
    tab = t;
    stopRec?.();
    stopPrev?.();
    history.replaceState(history.state, '', `/mi-porche?tab=${t}`);
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'grabaciones') await recordingsTab();
    if (t === 'publicados') await publishedTab();
    if (t === 'sonidos') await soundsTab();
    if (t === 'porche') porchTab();
  }
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  view.querySelector('[data-act=share]').onclick = () => shareUrl(`${location.origin}/porche/${porch.slug}`, porch.name);

  // ---------- Grabaciones (en el móvil). Toca la foto o el título para escucharla aquí mismo.
  let recAudio = null, recPlaying = null, recRaf = 0;
  function stopRec() { try { recAudio?.pause(); } catch {} if (recAudio?.src) URL.revokeObjectURL(recAudio.src); recAudio = null; recPlaying = null; cancelAnimationFrame(recRaf); }
  async function recordingsTab() {
    stopRec();
    const list = (await db.all('recordings')).sort((a, b) => b.created - a.created);
    const left = (r) => Math.max(0, Math.ceil((r.created + LIMITS.DRAFT_DAYS * 86400000 - Date.now()) / 86400000));
    mount(panel, html`<div class="list">
      <div class="banner yellow small">${icon('lock')} Lo grabado vive solo en este móvil hasta que lo publiques. Los borradores se borran solos a los ${LIMITS.DRAFT_DAYS} días.</div>
      ${list.length ? list.map((r) => html`
        <div class="item rec-row" data-play="${r.id}">
          <div class="thumb-play"><img class="rec-thumb" src="${recordingThumb(r)}" alt=""><span class="pp" data-pp="${r.id}">${icon('play')}</span></div>
          <div class="grow">
            <div class="row gap-s"><div class="t ellip grow">${r.title}${r.part > 1 ? ` · Parte ${r.part}` : ''}</div><button class="mini-ic" data-det="${r.id}" aria-label="Cambiar título y foto">${icon('edit')}</button></div>
            <div class="m">${r.kind === 'draft' ? `Borrador · se borra en ${left(r)} días` : 'Privado'} · ${fmtDur(r.duration)} · ${fmtDate(r.created)}</div>
            ${r.duration < LIMITS.MIN_PUBLISH_MIN * 60 ? html`<div class="m orange-t">Menos de ${LIMITS.MIN_PUBLISH_MIN} min: no se puede publicar.</div>` : ''}
            <div class="prog" data-prog="${r.id}"><i></i></div>
            <div class="rec-actions">
              ${r.duration >= LIMITS.MIN_PUBLISH_MIN * 60 ? html`<a class="btn sm red" href="/editor/${r.id}?publicar=1">Publicar</a>` : ''}
              <a class="btn sm yellow" href="/editor/${r.id}">${icon('scissors')} Recortar</a>
              <button class="btn sm ghost" data-del="${r.id}" aria-label="Borrar">${icon('trash')}</button>
            </div>
          </div>
        </div>`) : html`<div class="empty"><img src="/img/scenes/escena-2.webp" alt=""><p>Aún no hay grabaciones. Sal al aire en modo <b>Directo + grabación</b> y aparecerán aquí.</p></div>`}
    </div>`);
    const paintPP = () => {
      panel.querySelectorAll('[data-pp]').forEach((el) => mount(el, icon(recPlaying === el.dataset.pp && recAudio && !recAudio.paused ? 'pause' : 'play')));
    };
    panel.onclick = async (e) => {
      if (e.target.closest('a')) return;
      const d = e.target.closest('[data-det]');
      if (d) { const r = list.find((x) => x.id === d.dataset.det); if ((await recordingDetailsSheet(r)) === 'ok') recordingsTab(); return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        if (!(await confirmSheet('¿Borrar esta grabación?', 'Se borra de este móvil y no se puede recuperar.', { ok: 'Borrar', danger: true }))) return;
        stopRec(); await db.del('recordings', del.dataset.del); recordingsTab(); return;
      }
      const prog = e.target.closest('[data-prog]');
      if (prog && recAudio && recPlaying === prog.dataset.prog) {
        const rc = prog.getBoundingClientRect();
        recAudio.currentTime = ((e.clientX - rc.left) / rc.width) * (recAudio.duration || 0);
        return;
      }
      const row = e.target.closest('[data-play]');
      if (!row) return;
      const id = row.dataset.play;
      if (recPlaying === id && recAudio) { recAudio.paused ? recAudio.play() : recAudio.pause(); paintPP(); return; }
      stopRec();
      const r = list.find((x) => x.id === id);
      recAudio = new Audio(URL.createObjectURL(r.blob));
      recPlaying = id;
      recAudio.onended = () => paintPP();
      try { await recAudio.play(); } catch { toast('No se puede reproducir en este navegador', 'bad'); }
      paintPP();
      const bar = panel.querySelector(`[data-prog="${id}"]`);
      const loop = () => { if (!recAudio) return; setPct(bar, '--p', recAudio.duration && isFinite(recAudio.duration) ? (recAudio.currentTime / recAudio.duration) * 100 : (recAudio.currentTime / r.duration) * 100); recRaf = requestAnimationFrame(loop); };
      loop();
    };
  }

  // ---------- Publicados (servidor)
  async function publishedTab() {
    panel.innerHTML = '<p class="muted center small">Cargando…</p>';
    let r;
    try { r = await api('/api/mine'); } catch (e) { panel.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    mount(panel, html`<div class="list">
      <div class="card tight"><div class="row between small"><span class="muted">Espacio de tu porche</span><span class="mono">${fmtBytes(r.used)} / ${fmtBytes(r.cap)}</span></div><div class="progress mt-s" data-p="${(r.used / r.cap) * 100}"><i></i></div></div>
      ${r.podcasts.length ? r.podcasts.map((p) => html`
        <div class="item">
          <img class="thumb" src="${podcastCover(p)}" alt="">
          <div class="grow">
            <div class="t ellip">${p.title}${p.part > 1 ? ` · Parte ${p.part}` : ''}</div>
            <div class="m">${fmtDate(p.created)} · ${fmtDur(p.duration)}</div>
            <div class="m">${p.listens} escuchas · ♥ ${p.likes} · ${p.comments} comentarios</div>
            ${p.hidden ? html`<div class="m red-t">Oculto por reportes (solo lo ves tú). Si crees que es un error, escríbenos.</div>` : ''}
          </div>
          <div class="col gap-s">
            <button class="btn sm yellow" data-edit="${p.id}">Editar</button>
            <a class="btn sm ghost" href="/p/${p.id}">Ver</a>
          </div>
        </div>`) : html`<div class="empty"><p>Aún no has publicado nada. Edita una grabación y pulsa <b>Publicar</b>.</p></div>`}
    </div>`);
    panel.querySelectorAll('.progress').forEach((el) => setPct(el, '--p', Number(el.dataset.p)));
    panel.onclick = (e) => {
      const b = e.target.closest('[data-edit]');
      if (b) editPublished(r.podcasts.find((x) => x.id === b.dataset.edit));
    };
  }

  function editPublished(p) {
    const s = sheet(html`
      <h2 class="h2">Editar podcast</h2>
      <label class="field">Título<input class="input" name="title" maxlength="${LIMITS.TITLE_MAX}" value="${p.title}"></label>
      <label class="field">Descripción<textarea class="input" name="desc" maxlength="${LIMITS.DESC_MAX}" rows="4">${p.description}</textarea></label>
      <div class="h3">Capítulos</div>
      <div class="col gap-s" data-el="chaps">${(p.chapters || []).map((c) => html`<div class="row gap-s"><input class="input mono" data-ct value="${fmtShortDur(c.t)}" maxlength="8"><input class="input" data-cn value="${c.title}" maxlength="60"></div>`)}</div>
      <button class="btn sm ghost" data-a="addchap">${icon('plus')} Añadir capítulo</button>
      <button class="btn yellow" data-a="save">Guardar cambios</button>
      <button class="btn ghost red-t" data-a="del">${icon('trash')} Borrar del servidor</button>`, {
      onMount(a) {
        a.el.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-a]');
          if (!b) return;
          if (b.dataset.a === 'addchap') {
            a.el.querySelector('[data-el=chaps]').insertAdjacentHTML('beforeend', '<div class="row gap-s"><input class="input mono" data-ct placeholder="12:30" maxlength="8"><input class="input" data-cn placeholder="Título del capítulo" maxlength="60"></div>');
          }
          if (b.dataset.a === 'save') {
            const chapters = [...a.el.querySelectorAll('[data-el=chaps] > div')].map((row) => {
              const [m, s2] = row.querySelector('[data-ct]').value.split(':').map(Number);
              return { t: (m || 0) * 60 + (s2 || 0), title: row.querySelector('[data-cn]').value.trim() };
            }).filter((c) => c.title);
            try {
              await api(`/api/podcasts/${p.id}/edit`, { method: 'POST', body: { title: a.el.querySelector('[name=title]').value, description: a.el.querySelector('[name=desc]').value, chapters } });
              toast('Guardado', 'good'); a.close(); publishedTab();
            } catch (err) { toast(err.message, 'bad'); }
          }
          if (b.dataset.a === 'del') {
            if (!(await confirmSheet('¿Borrar este podcast?', 'Se borra del servidor con sus comentarios y me gusta.', { ok: 'Borrar', danger: true }))) return;
            try { await api(`/api/podcasts/${p.id}/delete`, { method: 'POST', body: {} }); toast('Borrado'); a.close(); publishedTab(); } catch (err) { toast(err.message, 'bad'); }
          }
        });
      },
    });
    return s.done;
  }

  // ---------- Botonera: Cortinillas · Efectos · Música
  let stab = 'jingle';
  let prevSrc = null, prevKey = null;
  const stopPrev = () => { try { prevSrc?.stop(); } catch {} prevSrc = null; prevKey = null; };
  async function soundsTab() {
    stopPrev();
    const [std, mine] = await Promise.all([loadStandard(), loadMine()]);
    const T = SOUND_TABS.find((t) => t.id === stab);
    const myList = mine.filter((x) => T.zones.includes(x.zone));
    const stdList = std.filter((x) => T.zones.includes(x.zone));
    const kind = (x) => (x.zone === 'bg' ? ' · de fondo, en bucle' : x.zone === 'song' ? ' · canción' : '');
    const row = (x, own) => html`
      <div class="item">
        <button class="play-dot" data-prev="${x.origin}:${x.id}" aria-label="Escuchar o parar">${icon('play')}</button>
        <div class="grow"><div class="t ellip">${x.name}</div><div class="m">${fmtShortDur(x.duration)}${kind(x)}${x.section ? ` · ${x.section}` : ''}${own ? '' : ' · libre de derechos'}</div></div>
        ${own ? html`<button class="icon-btn" data-ren="${x.id}" aria-label="Renombrar">${icon('edit')}</button><button class="icon-btn" data-delsnd="${x.id}" aria-label="Borrar">${icon('trash')}</button>` : ''}
      </div>`;
    mount(panel, html`<div class="col gap">
      <div class="seg">${SOUND_TABS.map((t) => html`<button data-stab="${t.id}" class="${t.id === stab ? 'on' : ''}">${t.label}</button>`)}</div>
      <div class="muted small">${T.hint}</div>
      ${stab === 'music' ? html`<div class="banner red small">Las canciones comerciales en podcasts publicados pueden tener problemas de derechos. Usa fragmentos breves o música libre.</div>` : ''}
      <div class="row gap">
        <label class="btn yellow grow">${icon('upload')} Subir archivo<input type="file" accept="audio/*,video/mp4,video/quicktime,.mp3,.m4a,.wav,.ogg,.mp4,.mov" hidden data-act="file"></label>
        <button class="btn ghost grow" data-act="rec">${icon('mic')} Grabar</button>
      </div>
      <div class="muted tiny">MP3 o cualquier audio, y también vídeo MP4/MOV: sacamos el audio aquí, en tu móvil. No se descarga nada de YouTube.</div>
      <div class="h3">Mías · ${myList.length}</div>
      <div class="list">${myList.length ? myList.map((x) => row(x, true)) : html`<p class="muted small">Aún no has añadido nada aquí. Se guarda solo en este móvil.</p>`}</div>
      <div class="h3">De serie · ${stdList.length}</div>
      <div class="list">${stdList.map((x) => row(x, false))}</div>
    </div>`);
    const all = [...std, ...mine];
    const paintBtns = () => panel.querySelectorAll('[data-prev]').forEach((el) => mount(el, icon(el.dataset.prev === prevKey ? 'pause' : 'play')));
    const askZone = async () => (stab === 'music' ? await sheet(html`<h2 class="h2">¿Cómo la vas a usar?</h2><button class="opt" data-close="bg">♫ Música de fondo <span class="muted small">· en bucle, baja sola cuando habláis</span></button><button class="opt" data-close="song">♪ Canción <span class="muted small">· suena una vez</span></button>`).done : T.zones[0]);
    panel.onclick = async (e) => {
      let b;
      if ((b = e.target.closest('[data-stab]'))) { stab = b.dataset.stab; return soundsTab(); }
      if ((b = e.target.closest('[data-prev]'))) {
        const key = b.dataset.prev;
        if (prevKey === key) { stopPrev(); paintBtns(); return; }
        stopPrev();
        const it = all.find((x) => x.origin + ':' + x.id === key);
        const c = audioCtx();
        const buf = await decode(it);
        prevSrc = c.createBufferSource(); prevSrc.buffer = buf; prevSrc.connect(c.destination); prevSrc.start();
        prevKey = key;
        const me2 = prevSrc;
        prevSrc.onended = () => { if (prevSrc === me2) { prevSrc = null; prevKey = null; paintBtns(); } };
        paintBtns();
        return;
      }
      if ((b = e.target.closest('[data-ren]'))) {
        const x = mine.find((y) => y.id === b.dataset.ren);
        const name = await promptSheet('Nombre en la botonera', { value: x.name, max: 40 });
        if (name === null || name === undefined) return;
        const section = await promptSheet('Sección del programa (opcional)', { value: x.section || '', max: 40, placeholder: '¿Pero usted quién es?' });
        await renameSound(x.id, { name: name || x.name, section: section || '' });
        return soundsTab();
      }
      if ((b = e.target.closest('[data-delsnd]'))) {
        if (!(await confirmSheet('¿Borrar este sonido?', 'Se borra de este móvil.', { ok: 'Borrar', danger: true }))) return;
        await deleteSound(b.dataset.delsnd); return soundsTab();
      }
      if (e.target.closest('[data-act=rec]')) { const z = await askZone(); if (!z) return; return recordSoundSheet(z).then(soundsTab); }
    };
    panel.querySelector('[data-act=file]').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const z = await askZone();
      if (!z) return;
      const name = await promptSheet('Nombre en la botonera', { value: f.name.replace(/\.[^.]+$/, '').slice(0, 40), max: 40 });
      if (name === null || name === undefined) return;
      toast('Preparando el audio…');
      try { await importSound(f, { zone: z, name }); toast('Añadido a tu botonera', 'good'); } catch (err) { toast(err.message, 'bad'); }
      soundsTab();
    };
  }

  // ---------- Datos del porche
  function porchTab() {
    mount(panel, html`<div class="col gap">
      <div class="row gap">
        <img class="thumb" src="${porchCover(porch)}" alt="" width="84" height="84" data-el="cov">
        <div class="col gap-s grow">
          <label class="btn sm yellow">${icon('camera')} Foto<input type="file" accept="image/*" capture="environment" hidden data-act="photo"></label>
          <label class="btn sm ghost">${icon('upload')} Subir<input type="file" accept="image/*" hidden data-act="photo"></label>
        </div>
      </div>
      <div class="row gap-s">${SCENES.map((s, i) => html`<button data-scene="${i + 1}" class="grow"><img src="${s}" alt="Escena ${i + 1}" class="${porch.scene === i + 1 && !porch.hasCover ? '' : ''}"></button>`)}</div>
      <div class="muted tiny">Sin foto usamos una de las escenas. Toca una para elegirla.</div>
      <label class="field">Nombre del porche<input class="input" name="name" maxlength="${LIMITS.PORCH_NAME_MAX}" value="${porch.name}"></label>
      <label class="field">Descripción<textarea class="input" name="desc" maxlength="${LIMITS.DESC_MAX}" rows="3">${porch.description}</textarea></label>
      <label class="field">Próximo programa<input class="input" name="next" maxlength="${LIMITS.NEXT_SHOW_MAX}" placeholder="el jueves, 22:00" value="${porch.nextShow}"></label>
      <button class="btn yellow" data-act="save">Guardar</button>
      <div class="card col gap-s">
        <b>${icon('shield')} Enlace de moderador</b>
        <div class="muted tiny">Quien lo abra podrá silenciar y expulsar en tu chat. Es secreto: dáselo solo a gente de confianza.</div>
        <div class="row gap"><button class="btn sm ghost grow" data-act="modcopy">Copiar enlace</button><button class="btn sm ghost grow" data-act="modrot">Regenerar</button></div>
      </div>
      <div class="muted tiny">Tu frecuencia fija es <b class="mono">${porch.freq.toFixed(1)}</b>. Tu porche pertenece a este dispositivo: guarda tu enlace de recuperación en Perfil.</div>
    </div>`);
    panel.onclick = async (e) => {
      let b;
      if ((b = e.target.closest('[data-scene]'))) {
        try {
          await api('/api/porch/update', { method: 'POST', body: { scene: Number(b.dataset.scene) } });
          if (porch.hasCover) await api('/api/porch/cover', { method: 'POST', raw: new Blob([]) });
          porch = (await api('/api/me')).porch; toast('Escena elegida'); porchTab();
        } catch (err) { toast(err.message, 'bad'); }
        return;
      }
      if (e.target.closest('[data-act=save]')) {
        try {
          const r = await api('/api/porch/update', { method: 'POST', body: { name: panel.querySelector('[name=name]').value, description: panel.querySelector('[name=desc]').value, nextShow: panel.querySelector('[name=next]').value } });
          porch = r.porch; toast('Guardado', 'good');
          view.querySelector('.sub').lastChild.textContent = ' ' + porch.name;
        } catch (err) { toast(err.message, 'bad'); }
      }
      if (e.target.closest('[data-act=modcopy]')) { const k = (await api('/api/me')).modKey; copy(`${location.origin}/porche/${porch.slug}?m=${k}`, 'Enlace de moderador copiado'); }
      if (e.target.closest('[data-act=modrot]')) {
        if (!(await confirmSheet('¿Regenerar el enlace?', 'El enlace anterior dejará de funcionar.'))) return;
        const r = await api('/api/porch/modkey', { method: 'POST', body: {} });
        copy(`${location.origin}/porche/${porch.slug}?m=${r.modKey}`, 'Nuevo enlace copiado');
      }
    };
    panel.querySelectorAll('[data-act=photo]').forEach((inp) => (inp.onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const blob = await shrinkPhoto(f);
        await api('/api/porch/cover', { method: 'POST', raw: blob });
        porch = (await api('/api/me')).porch;
        toast('Portada actualizada', 'good'); porchTab();
      } catch (err) { toast(err.message || 'No se ha podido subir', 'bad'); }
    }));
  }

  show(tab);
  return () => { stopRec(); stopPrev(); };
}

// Grabar un corte con el móvil y recortarlo
async function recordSoundSheet(zone) {
  let rec = null, buf = null, src = null, t0 = 0, iv = null;
  const s = sheet(html`
    <h2 class="h2">Grabar un corte</h2>
    <div class="center big-num mono" data-el="time">0:00</div>
    <button class="btn red big" data-a="rec">${icon('rec')} Grabar</button>
    <div data-el="trim" hidden class="col gap-s">
      <label class="field">Inicio <input class="slider" type="range" min="0" max="1" step="0.01" value="0" data-el="a"></label>
      <label class="field">Final <input class="slider" type="range" min="0" max="1" step="0.01" value="1" data-el="b"></label>
      <div class="muted small mono" data-el="len"></div>
      <button class="btn ghost" data-a="play">${icon('play')} Escuchar recorte</button>
      <input class="input" data-el="name" maxlength="40" placeholder="Nombre del corte">
      <button class="btn yellow" data-a="save">Guardar en mis sonidos</button>
    </div>`, {
    onMount(a) {
      const $ = (n) => a.el.querySelector(`[data-el=${n}]`);
      const len = () => { const A = +$('a').value, B = +$('b').value; $('len').textContent = `Recorte: ${fmtShortDur(buf.duration * A)} → ${fmtShortDur(buf.duration * B)} (${(buf.duration * (B - A)).toFixed(1)} s)`; };
      a.el.addEventListener('input', (e) => { if (buf && e.target.matches('.slider')) { if (+$('a').value >= +$('b').value - 0.01) e.target.value = e.target === $('a') ? +$('b').value - 0.02 : +$('a').value + 0.02; len(); } });
      a.el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        if (b.dataset.a === 'rec') {
          if (!rec) {
            try { rec = await recordMic(); } catch { toast('No se ha podido abrir el micro', 'bad'); return; }
            t0 = Date.now(); b.innerHTML = '■ Parar';
            iv = setInterval(() => { $('time').textContent = fmtShortDur((Date.now() - t0) / 1000); }, 200);
          } else {
            clearInterval(iv);
            buf = await rec.stop(); rec = null;
            b.hidden = true; $('trim').hidden = false; len();
          }
        }
        if (b.dataset.a === 'play' && buf) {
          try { src?.stop(); } catch {}
          const c = audioCtx();
          src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
          const A = buf.duration * +$('a').value, B = buf.duration * +$('b').value;
          src.start(0, A, B - A);
        }
        if (b.dataset.a === 'save' && buf) {
          const sr = buf.sampleRate, ch = buf.getChannelData(0);
          const pcm = ch.slice(Math.floor(buf.duration * +$('a').value * sr), Math.floor(buf.duration * +$('b').value * sr));
          await saveRecordedSound(pcm, sr, { zone, name: $('name').value.trim() || 'Mi corte' });
          toast('Corte guardado', 'good');
          a.close('ok');
        }
      });
    },
  });
  await s.done;
  clearInterval(iv);
  if (rec) { try { await rec.stop(); } catch {} }
}
