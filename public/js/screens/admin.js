// Panel de administración oculto (enlace secreto del dueño de la app).
// Reportes, ocultar/restaurar/borrar, bloquear dispositivos, pausas, filtro de palabras,
// biblioteca "de serie" (subir sonidos para todos) y registro de acciones.
import { html, mount, icon, toast, confirmSheet, fmtBytes, fmtDateLong } from '../util.js';
import { ZONES, REPORT_REASONS } from '../config.js';
import { copy } from '../common.js';
import { audioCtx } from '../audio/voice.js';

const reasonName = (id) => REPORT_REASONS.find((r) => r.id === id)?.name || id;

export async function render(view, _p, { go }) {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('k')) { sessionStorage.setItem('rp_admin', h.get('k')); history.replaceState(null, '', '/admin'); }
  let key = sessionStorage.getItem('rp_admin') || '';
  const call = async (path, opts = {}) => {
    const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), 'x-admin-key': key } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Error');
    return d;
  };

  if (!key) {
    const st = await (await fetch('/api/admin/status')).json().catch(() => ({ claimed: true }));
    mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Admin</h1><button class="icon-btn" data-x>${icon('close')}</button></div>
      <div class="col gap">
        ${st.claimed ? '' : html`<div class="card col gap-s"><b>El panel aún no tiene dueño</b><p class="muted small">Si eres quien ha desplegado Radio Porche, reclámalo ahora. Recibirás un enlace secreto: guárdalo, es la única forma de entrar.</p><button class="btn red" data-act="claim">Reclamar panel</button></div>`}
        <label class="field">Clave de administración<input class="input" type="password" data-el="k" autocomplete="off"></label>
        <button class="btn yellow" data-act="enter">Entrar</button>
      </div></section>`);
    view.querySelector('[data-x]').onclick = () => go('/');
    view.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act=enter]')) { key = view.querySelector('[data-el=k]').value.trim(); sessionStorage.setItem('rp_admin', key); render(view, _p, { go }); }
      if (e.target.closest('[data-act=claim]')) {
        try {
          const r = await (await fetch('/api/admin/claim', { method: 'POST' })).json();
          if (!r.key) throw new Error(r.error || 'No se pudo');
          sessionStorage.setItem('rp_admin', r.key);
          await copy(`${location.origin}/admin#k=${r.key}`, 'Enlace secreto copiado. ¡Guárdalo!');
          alert(`Tu enlace secreto de administración (guárdalo):\n\n${location.origin}/admin#k=${r.key}`);
          render(view, _p, { go });
        } catch (err) { toast(err.message, 'bad'); }
      }
    });
    return;
  }

  let tab = 'reportes', data;
  mount(view, html`<section class="screen">
    <div class="top"><div><h1 class="h1">Admin</h1><div class="sub" data-el="sum"></div></div><button class="icon-btn" data-x>${icon('close')}</button></div>
    <div class="seg"><button data-tab="reportes">Reportes</button><button data-tab="podcasts">Podcasts</button><button data-tab="biblioteca">Biblioteca</button><button data-tab="ajustes">Ajustes</button></div>
    <div class="fill scroll" data-el="panel"></div>
  </section>`);
  const panel = view.querySelector('[data-el=panel]');
  view.querySelector('[data-x]').onclick = () => go('/');

  async function load() {
    try { data = await call('/api/admin/overview'); }
    catch (e) { toast(e.message, 'bad'); sessionStorage.removeItem('rp_admin'); key = ''; render(view, _p, { go }); return false; }
    try { localStorage.setItem('rp_isadmin', '1'); } catch {} // así Perfil enseña «Administración» solo en tus aparatos
    const c = data.counts;
    view.querySelector('[data-el=sum]').textContent = `${c.identities} personas · ${c.porches} porches · ${c.podcasts} podcasts · ${c.live} en directo`;
    return true;
  }
  const act = async (body) => { try { await call('/api/admin/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); toast('Hecho', 'good'); await load(); show(tab); } catch (e) { toast(e.message, 'bad'); } };

  function show(t) {
    tab = t;
    view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'reportes') {
      mount(panel, html`<div class="list">${data.reports.length ? data.reports.map((r) => html`
        <div class="card col gap-s">
          <div class="row between"><span class="chip dark">${r.kind}</span><span class="muted tiny">${fmtDateLong(r.last)} · ${r.n} reportes</span></div>
          <div class="b">${r.title}</div>
          ${r.snapshot ? html`<div class="muted small">«${r.snapshot}»</div>` : ''}
          <div class="small">Motivos: ${String(r.reasons || '').split(',').map(reasonName).join(', ')}</div>
          ${r.hidden ? html`<div class="red-t small b">Oculto</div>` : ''}
          <div class="row gap wrap">
            ${r.kind === 'podcast' ? html`<a class="btn sm ghost" href="/api/podcasts/${r.obj}/audio?k=${encodeURIComponent(key)}" target="_blank" rel="noopener">Escuchar</a>` : ''}
            ${r.kind !== 'chat' ? (r.hidden ? html`<button class="btn sm teal" data-a="restore" data-k="${r.kind}" data-o="${r.obj}">Restaurar</button>` : html`<button class="btn sm yellow" data-a="hide" data-k="${r.kind}" data-o="${r.obj}">Ocultar</button>`) : ''}
            ${r.kind === 'podcast' || r.kind === 'comment' ? html`<button class="btn sm red" data-a="delete" data-k="${r.kind}" data-o="${r.obj}">Borrar</button>` : ''}
            ${r.target ? html`<button class="btn sm ghost" data-a="block" data-o="${r.target}">Bloquear autor</button>` : ''}
            <button class="btn sm ghost" data-a="dismiss" data-k="${r.kind}" data-o="${r.obj}">Descartar</button>
          </div>
        </div>`) : html`<p class="muted center">No hay reportes pendientes. 🎉</p>`}
        ${data.blocked.length ? html`<div class="h3 mt">Dispositivos bloqueados</div>${data.blocked.map((b) => html`<div class="row between card tight"><span>${b.name}</span><button class="btn sm ghost" data-a="unblock" data-o="${b.device_id}">Desbloquear</button></div>`)}` : ''}
      </div>`);
    }
    if (t === 'podcasts') {
      mount(panel, html`<div class="col gap"><input class="input" placeholder="Buscar por título…" data-el="q"><div class="list" data-el="res"></div></div>`);
      const q = panel.querySelector('[data-el=q]');
      const run = async () => {
        const r = await call(`/api/admin/podcasts?q=${encodeURIComponent(q.value)}`);
        mount(panel.querySelector('[data-el=res]'), html`${r.podcasts.map((p) => html`<div class="card tight row gap"><div class="grow"><div class="b ellip">${p.title}</div><div class="muted tiny">${p.porch} · ${fmtDateLong(p.created)}${p.hidden ? ' · OCULTO' : ''}</div></div>
          ${p.hidden ? html`<button class="btn sm teal" data-a="restore" data-k="podcast" data-o="${p.id}">Restaurar</button>` : html`<button class="btn sm yellow" data-a="hide" data-k="podcast" data-o="${p.id}">Ocultar</button>`}
          <button class="btn sm red" data-a="delete" data-k="podcast" data-o="${p.id}">Borrar</button></div>`)}`);
      };
      q.oninput = () => run();
      run();
    }
    if (t === 'biblioteca') {
      mount(panel, html`<div class="col gap">
        <div class="card col gap-s">
          <b>Añadir sonidos "de serie" (para todos)</b>
          <div class="h3">1 · ¿Qué tipo son?</div>
          <div class="seg dark" data-el="zoneseg">${Object.entries(ZONES).map(([k, z], i) => html`<button data-zone="${k}" class="${i === 0 ? 'on' : ''}">${z.label}</button>`)}</div>
          <div class="h3">2 · Arrastra aquí los archivos o carpetas</div>
          <label class="dropzone" data-el="drop">
            <input type="file" multiple accept="audio/*,.mp3,.m4a,.ogg,.webm,.wav" hidden data-el="files">
            <span class="dz-big">⬇</span>
            <b>Suelta aquí todos los archivos o carpetas de golpe</b>
            <span class="muted small">o toca para elegirlos (puedes marcar muchos a la vez)</span>
          </label>
          <label class="check"><input type="checkbox" data-el="folderSec" checked><span>Usar el nombre de cada carpeta como <b>sección</b> (agrupa los botones en el Estudio)</span></label>
          <input class="input" data-el="section" maxlength="40" placeholder="O una sección para todos (opcional)">
          <p class="muted tiny">MP3, M4A, WAV, WebM u Ogg, máx. 8 MB cada uno. El silencio del principio y del final se quita solo al sonar. El nombre del botón sale del nombre del archivo (lo puedes cambiar después). Usa solo audio libre de derechos o tuyo.</p>
          <div class="col gap-s" data-el="queue"></div>
        </div>
        <div class="h3">Subidos desde el panel</div>
        ${data.library.length ? data.library.map((l) => html`<div class="card tight row gap"><span class="chip dark">${ZONES[l.zone]?.label || l.zone}</span><div class="grow"><div class="b ellip">${l.name}</div><div class="muted tiny">${l.section || 'sin sección'} · ${fmtBytes(l.bytes)} · ${Math.round(l.duration)} s</div></div>
          <button class="btn sm ghost" data-ren="${l.id}" data-zone="${l.zone}" data-name="${l.name}" data-section="${l.section}">${icon('edit')}</button>
          <button class="btn sm red" data-a="library-delete" data-o="${l.id}">${icon('trash')}</button></div>`) : html`<p class="muted small">Ninguno aún. Los incluidos en el repo aparecen siempre.</p>`}
      </div>`);
    }
    if (t === 'ajustes') {
      const s = data.settings, st = data.storage;
      mount(panel, html`<div class="col gap">
        <div class="card col gap-s">
          <div class="row between"><b>Almacenamiento</b><span class="mono small">${fmtBytes(st.used)} / ${fmtBytes(st.total)}</span></div>
          <div class="progress" data-p="${(st.used / st.total) * 100}"><i></i></div>
          ${st.used / st.total > 0.8 ? html`<div class="red-t small b">Cerca del límite del plan gratuito.</div>` : ''}
        </div>
        <div class="card">
          <div class="toggle-row"><b class="grow">Pausar publicaciones</b><span class="switch"><input type="checkbox" data-p="publish" ${s.pausePublish ? 'checked' : ''}><span></span></span></div>
          <div class="toggle-row"><b class="grow">Pausar nuevos porches</b><span class="switch"><input type="checkbox" data-p="porches" ${s.pausePorches ? 'checked' : ''}><span></span></span></div>
        </div>
        <div class="card col gap-s">
          <b>Entrar con Google</b>
          <p class="muted tiny">Pega aquí el «ID de cliente» de Google Cloud (termina en <span class="mono">.apps.googleusercontent.com</span>). Con él, aparece el botón «Entrar con Google». Déjalo vacío para quitarlo.</p>
          <input class="input mono" data-el="gid" value="${s.googleClientId || ''}" placeholder="1234567890-abc….apps.googleusercontent.com" autocomplete="off">
          <button class="btn yellow" data-act="gid">Guardar</button>
        </div>
        <div class="card col gap-s">
          <b>Categorías de podcast</b>
          <p class="muted tiny">Una por línea (p. ej. «Rock»). En la app solo se ven las que ya tienen algún episodio.</p>
          <textarea class="input" rows="8" data-el="cats">${data.categories.map((c) => c.name).join('\n')}</textarea>
          <button class="btn yellow" data-act="cats">Guardar categorías</button>
        </div>
        <div class="card col gap-s">
          <b>Filtro de insultos y spam</b>
          <p class="muted tiny">Una palabra o expresión por línea. Se sustituyen por asteriscos en chat y comentarios.</p>
          <textarea class="input" rows="8" data-el="words">${s.badwords.join('\n')}</textarea>
          <button class="btn yellow" data-act="words">Guardar lista</button>
        </div>
        <div class="card col gap-s">
          <b>Clave de administración</b>
          <button class="btn ghost" data-act="rotate">Regenerar enlace secreto</button>
          <button class="btn ghost" data-act="logout">Salir del panel</button>
        </div>
        <div class="h3">Registro de acciones</div>
        <table class="adm-table">${data.audit.map((a) => html`<tr><td class="mono tiny muted">${fmtDateLong(a.ts)}</td><td><b>${a.action}</b><div class="muted tiny">${a.detail}</div></td></tr>`)}</table>
      </div>`);
      panel.querySelectorAll('.progress').forEach((el) => el.style.setProperty('--p', Math.min(100, el.dataset.p) + '%'));
    }
  }

  // ---------- Subida en bloque (arrastrar archivos o carpetas)
  const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|opus|webm|wav)$/i;
  const prettyName = (fn) => fn.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/^\d+[\s.-]+/, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Sonido';
  async function readEntries(entry, folder, out) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      if (AUDIO_RE.test(f.name) || f.type.startsWith('audio/')) out.push({ file: f, folder });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        for (const ch of batch) await readEntries(ch, entry.name, out);
      } while (batch.length);
    }
  }
  let uploading = false;
  async function uploadMany(list) {
    if (uploading) return toast('Espera a que termine la subida en curso');
    if (!list.length) return toast('No hay archivos de audio ahí', 'bad');
    uploading = true;
    const zone = panel.querySelector('[data-el=zoneseg] button.on')?.dataset.zone || 'fx';
    const useFolder = panel.querySelector('[data-el=folderSec]').checked;
    const secAll = panel.querySelector('[data-el=section]').value.trim();
    const q = panel.querySelector('[data-el=queue]');
    q.innerHTML = list.map((x, i) => `<div class="row gap small" data-q="${i}"><span class="mono muted" data-st>…</span><span class="ellip grow">${x.file.name.replace(/[<>&"]/g, '')}</span></div>`).join('');
    let ok = 0, bad = 0;
    for (let i = 0; i < list.length; i++) {
      const { file, folder } = list[i];
      const st = q.querySelector(`[data-q="${i}"] [data-st]`);
      st.textContent = '⏳';
      try {
        if (file.size > 8 * 1024 * 1024) throw new Error('más de 8 MB');
        let duration = 0;
        try { duration = (await audioCtx().decodeAudioData(await file.arrayBuffer())).duration; } catch { throw new Error('no se puede leer'); }
        const fd = new FormData();
        fd.append('file', file); fd.append('zone', zone);
        fd.append('name', prettyName(file.name));
        fd.append('section', (useFolder && folder ? folder : secAll).slice(0, 40));
        fd.append('duration', String(duration));
        await call('/api/admin/library', { method: 'POST', body: fd });
        st.textContent = '✅'; ok++;
      } catch (err) { st.textContent = '❌'; st.title = err.message; st.parentElement.insertAdjacentHTML('beforeend', `<span class="red-t tiny">${String(err.message).replace(/[<>&"]/g, '')}</span>`); bad++; }
    }
    uploading = false;
    toast(`Subidos ${ok}${bad ? ` · ${bad} con error` : ''}`, bad ? 'bad' : 'good');
    await load();
    const keep = q.innerHTML;
    show('biblioteca');
    panel.querySelector('[data-el=queue]').innerHTML = keep;
  }
  panel.addEventListener('dragover', (e) => { const dz = e.target.closest('[data-el=drop]'); if (dz) { e.preventDefault(); dz.classList.add('over'); } });
  panel.addEventListener('dragleave', (e) => { const dz = e.target.closest('[data-el=drop]'); if (dz) dz.classList.remove('over'); });
  panel.addEventListener('drop', async (e) => {
    const dz = e.target.closest('[data-el=drop]');
    if (!dz) return;
    e.preventDefault(); dz.classList.remove('over');
    const out = [];
    const items = [...(e.dataTransfer.items || [])];
    if (items.length && items[0].webkitGetAsEntry) {
      const entries = items.map((it) => it.webkitGetAsEntry()).filter(Boolean);
      for (const en of entries) await readEntries(en, '', out);
    } else for (const f of e.dataTransfer.files) if (AUDIO_RE.test(f.name) || f.type.startsWith('audio/')) out.push({ file: f, folder: '' });
    uploadMany(out);
  });
  panel.addEventListener('change', (e) => {
    if (e.target.matches('[data-el=files]')) {
      const out = [...e.target.files].filter((f) => AUDIO_RE.test(f.name) || f.type.startsWith('audio/')).map((f) => ({ file: f, folder: (f.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '' }));
      uploadMany(out);
      e.target.value = '';
    }
  });

  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (b) {
      if ((b.dataset.a === 'delete' || b.dataset.a === 'library-delete') && !(await confirmSheet('¿Seguro?', 'Esta acción no se puede deshacer.', { ok: 'Borrar', danger: true }))) return;
      return act({ action: b.dataset.a, kind: b.dataset.k, obj: b.dataset.o });
    }
    const r = e.target.closest('[data-ren]');
    if (r) {
      const name = prompt('Nombre', r.dataset.name); if (!name) return;
      const section = prompt('Sección (opcional)', r.dataset.section || '') || '';
      return act({ action: 'library-rename', obj: r.dataset.ren, name, section, zone: r.dataset.zone });
    }
    const zb = e.target.closest('[data-zone]');
    if (zb && zb.closest('[data-el=zoneseg]')) { panel.querySelectorAll('[data-el=zoneseg] button').forEach((x) => x.classList.toggle('on', x === zb)); return; }
    if (e.target.closest('[data-act=cats]')) {
      const prev = data.categories;
      const list = panel.querySelector('[data-el=cats]').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = /^(\S+)\s+(.+)$/.exec(l);
        const hasEmoji = m && /\p{Extended_Pictographic}/u.test(m[1]);
        const name = hasEmoji ? m[2] : l;
        const old = prev.find((c) => c.name.toLowerCase() === name.toLowerCase());
        return { id: old ? old.id : name, name, emoji: hasEmoji ? m[1] : '📻' };
      });
      return act({ action: 'categories', categories: list });
    }
    if (e.target.closest('[data-act=gid]')) act({ action: 'google', clientId: panel.querySelector('[data-el=gid]').value.trim() });
    if (e.target.closest('[data-act=words]')) act({ action: 'badwords', words: panel.querySelector('[data-el=words]').value.split('\n').map((w) => w.trim()).filter(Boolean) });
    if (e.target.closest('[data-act=rotate]')) {
      if (!(await confirmSheet('¿Regenerar?', 'El enlace anterior dejará de funcionar.'))) return;
      const r2 = await call('/api/admin/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rotate' }) });
      key = r2.key; sessionStorage.setItem('rp_admin', key);
      await copy(`${location.origin}/admin#k=${key}`, 'Nuevo enlace copiado. ¡Guárdalo!');
    }
    if (e.target.closest('[data-act=logout]')) { sessionStorage.removeItem('rp_admin'); try { localStorage.removeItem('rp_isadmin'); } catch {} go('/'); }
  });
  panel.addEventListener('change', (e) => {
    const p = e.target.closest('[data-p]');
    if (p && p.type === 'checkbox') act({ action: 'pause', [p.dataset.p]: p.checked });
  });
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  if (await load()) show('reportes');
}
