// Mi porche: ir al camerino, grabaciones (borradores y privados), publicados (editar),
// sonidos propios (efectos, música de fondo, canciones) y datos del porche.
import { api, session } from '../api.js';
import { LIMITS, ZONES } from '../config.js';
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
        <div class="grow"><h1 class="h1">Mi porche</h1><div class="sub ellip"><span class="chip freq">${porch.freq.toFixed(1)}</span> ${porch.name}</div></div>
        <button class="icon-btn" data-act="share" aria-label="Compartir mi porche">${icon('share')}</button>
      </div>
      ${onAir
        ? html`<a class="btn red big" href="/porche/${porch.slug}">${icon('radio')} Estás en el aire · volver a la cabina</a>`
        : html`<a class="btn red big" href="/porche/${porch.slug}">${icon('mic')} Ir al camerino</a>`}
      <div class="seg">
        <button data-tab="grabaciones">Grabaciones</button><button data-tab="publicados">Publicados</button><button data-tab="sonidos">Sonidos</button><button data-tab="porche">Porche</button>
      </div>
      <div class="fill scroll" data-el="panel"></div>
    </section>`);
  const panel = view.querySelector('[data-el=panel]');

  async function show(t) {
    tab = t;
    history.replaceState(history.state, '', `/mi-porche?tab=${t}`);
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'grabaciones') await recordingsTab();
    if (t === 'publicados') await publishedTab();
    if (t === 'sonidos') await soundsTab();
    if (t === 'porche') porchTab();
  }
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  view.querySelector('[data-act=share]').onclick = () => shareUrl(`${location.origin}/porche/${porch.slug}`, porch.name);

  // ---------- Grabaciones (en el móvil)
  async function recordingsTab() {
    const list = (await db.all('recordings')).sort((a, b) => b.created - a.created);
    const left = (r) => Math.max(0, Math.ceil((r.created + LIMITS.DRAFT_DAYS * 86400000 - Date.now()) / 86400000));
    mount(panel, html`<div class="list">
      <div class="banner yellow small">${icon('lock')} Lo grabado vive solo en este móvil hasta que lo publiques. Los borradores se borran solos a los ${LIMITS.DRAFT_DAYS} días.</div>
      ${list.length ? list.map((r) => html`
        <div class="item">
          <img class="rec-thumb" src="${recordingThumb(r)}" alt="">
          <div class="grow">
            <div class="t ellip">${r.title}${r.part > 1 ? ` · Parte ${r.part}` : ''}</div>
            <div class="m">${r.kind === 'draft' ? `Borrador · se borra en ${left(r)} días` : 'Privado'} · ${fmtDur(r.duration)} · ${fmtDate(r.created)}</div>
            ${r.duration < LIMITS.MIN_PUBLISH_MIN * 60 ? html`<div class="m orange-t">Dura menos de ${LIMITS.MIN_PUBLISH_MIN} min: te sugerimos descartarlo.</div>` : ''}
          </div>
          <div class="col gap-s">
            <a class="btn sm yellow" href="/editor/${r.id}">${icon('scissors')} Editar audio</a>
            <button class="btn sm ghost" data-det="${r.id}">${icon('edit')} Título y foto</button>
            <button class="btn sm ghost" data-del="${r.id}">${icon('trash')} Borrar</button>
          </div>
        </div>`) : html`<div class="empty"><img src="/img/scenes/escena-2.webp" alt=""><p>Aún no hay grabaciones. Sal al aire en modo <b>Directo + grabación</b> y aparecerán aquí.</p></div>`}
    </div>`);
    panel.onclick = async (e) => {
      const d = e.target.closest('[data-det]');
      if (d) { const r = list.find((x) => x.id === d.dataset.det); if ((await recordingDetailsSheet(r)) === 'ok') recordingsTab(); return; }
      const b = e.target.closest('[data-del]');
      if (!b) return;
      if (!(await confirmSheet('¿Borrar esta grabación?', 'Se borra de este móvil y no se puede recuperar.', { ok: 'Borrar', danger: true }))) return;
      await db.del('recordings', b.dataset.del);
      recordingsTab();
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

  // ---------- Sonidos
  let zone = 'fx';
  let previewSrc = null;
  async function soundsTab() {
    const [std, mine] = await Promise.all([loadStandard(), loadMine()]);
    const z = ZONES[zone];
    const myList = mine.filter((s) => s.zone === zone);
    const stdList = std.filter((s) => s.zone === zone);
    mount(panel, html`<div class="col gap">
      <div class="seg">${Object.entries(ZONES).map(([k, v]) => html`<button data-zone="${k}" class="${k === zone ? 'on' : ''}">${v.label}</button>`)}</div>
      <div class="muted small">${z.hint}</div>
      ${zone === 'song' ? html`<div class="banner red small">Las canciones comerciales en podcasts publicados pueden tener problemas de derechos. Usa fragmentos breves o música libre.</div>` : ''}
      <div class="row gap">
        <label class="btn yellow grow">${icon('upload')} Subir archivo<input type="file" accept="audio/*,video/mp4,video/quicktime,.mp3,.m4a,.wav,.ogg,.mp4,.mov" hidden data-act="file"></label>
        <button class="btn ghost grow" data-act="rec">${icon('mic')} Grabar</button>
      </div>
      <div class="muted tiny">MP3 o cualquier audio, y también vídeo MP4/MOV (graba la pantalla con el vídeo y súbelo: extraemos el audio aquí, en tu móvil). No se descarga nada de YouTube.</div>
      <div class="h3">Mías · ${myList.length}</div>
      <div class="list">${myList.length ? myList.map((s) => html`
        <div class="item">
          <button class="play-dot" data-prev="mias:${s.id}" aria-label="Escuchar">${icon('play')}</button>
          <div class="grow"><div class="t ellip">${s.name}</div><div class="m">${fmtShortDur(s.duration)}${s.section ? ` · ${s.section}` : ''}</div></div>
          <button class="icon-btn" data-ren="${s.id}" aria-label="Renombrar">${icon('edit')}</button>
          <button class="icon-btn" data-delsnd="${s.id}" aria-label="Borrar">${icon('trash')}</button>
        </div>`) : html`<p class="muted small">Aún no has añadido nada en esta zona.</p>`}</div>
      <div class="h3">De serie · ${stdList.length}</div>
      <div class="list">${stdList.map((s) => html`
        <div class="item"><button class="play-dot" data-prev="serie:${s.id}" aria-label="Escuchar">${icon('play')}</button><div class="grow"><div class="t ellip">${s.name}</div><div class="m">${fmtShortDur(s.duration)}${s.section ? ` · ${s.section}` : ''} · libre de derechos</div></div></div>`)}</div>
    </div>`);
    const all = [...std, ...mine];
    panel.onclick = async (e) => {
      let b;
      if ((b = e.target.closest('[data-zone]'))) { zone = b.dataset.zone; return soundsTab(); }
      if ((b = e.target.closest('[data-prev]'))) {
        const it = all.find((x) => x.origin + ':' + x.id === b.dataset.prev);
        try { previewSrc?.stop(); } catch {}
        const c = audioCtx();
        const buf = await decode(it);
        previewSrc = c.createBufferSource(); previewSrc.buffer = buf; previewSrc.connect(c.destination); previewSrc.start();
        setTimeout(() => { try { previewSrc.stop(); } catch {} }, Math.min(buf.duration, 20) * 1000);
        return;
      }
      if ((b = e.target.closest('[data-ren]'))) {
        const s = mine.find((x) => x.id === b.dataset.ren);
        const name = await promptSheet('Nombre del sonido', { value: s.name, max: 40 });
        if (name === null || name === undefined) return;
        const section = await promptSheet('Sección del programa (opcional)', { value: s.section || '', max: 40, placeholder: '¿Pero usted quién es?' });
        await renameSound(s.id, { name: name || s.name, section: section || '' });
        return soundsTab();
      }
      if ((b = e.target.closest('[data-delsnd]'))) {
        if (!(await confirmSheet('¿Borrar este sonido?', 'Se borra de este móvil.', { ok: 'Borrar', danger: true }))) return;
        await deleteSound(b.dataset.delsnd); return soundsTab();
      }
      if (e.target.closest('[data-act=rec]')) return recordSoundSheet(zone).then(soundsTab);
    };
    panel.querySelector('[data-act=file]').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const name = await promptSheet('Nombre para el cassette', { value: f.name.replace(/\.[^.]+$/, '').slice(0, 40), max: 40 });
      if (name === null || name === undefined) return;
      toast('Preparando el audio…');
      try { await importSound(f, { zone, name }); toast('Añadido a tus sonidos', 'good'); } catch (err) { toast(err.message, 'bad'); }
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
