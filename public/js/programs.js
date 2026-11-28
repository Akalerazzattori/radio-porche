// Programas (los "shows" de un porche) y categorías.
import { api, session } from './api.js';
import { LIMITS } from './config.js';
import { html, sheet, toast, icon } from './util.js';
import { SCENES, shrinkPhoto } from './cover.js';

let catCache = null;
export async function getCategories(force = false) {
  if (!catCache || force) {
    try { catCache = (await api('/api/categories')).categories; } catch { catCache = []; }
  }
  return catCache;
}
/** Nombres de las categorías (sin emojis). Acepta "humor,charla". */
export function catName(cats, ids) {
  return String(ids || '').split(',').map((id) => cats.find((x) => x.id === id)?.name).filter(Boolean).join(' · ');
}

/** Elegir hasta 3 categorías. Devuelve la lista de ids o null si se cancela. */
export async function categoryPicker(current = []) {
  const cats = await getCategories();
  let sel = current.filter((id) => cats.some((c) => c.id === id));
  const s = sheet(html`
    <h2 class="h2">Categorías</h2>
    <p class="muted small">Elige hasta 3. Sirven para que la gente encuentre tu programa.</p>
    <div class="cat-list">${cats.map((c) => html`<button class="cat-opt ${sel.includes(c.id) ? 'on' : ''}" data-c="${c.id}"><span class="box">${icon('check')}</span>${c.name}</button>`)}</div>
    <button class="btn yellow big" data-a="ok">Listo</button>`, {
    onMount(a) {
      a.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-c]');
        if (b) {
          const id = b.dataset.c;
          if (sel.includes(id)) sel = sel.filter((x) => x !== id);
          else if (sel.length >= 3) { toast('Máximo 3 categorías'); return; }
          else sel.push(id);
          b.classList.toggle('on', sel.includes(id));
          return;
        }
        if (e.target.closest('[data-a=ok]')) a.close(sel.slice());
      });
    },
  });
  const v = await s.done;
  return Array.isArray(v) ? v : null;
}

export function programCover(p) {
  return p.hasCover ? `/api/program/${p.id}/cover` : SCENES[((p.scene || 1) - 1) % 4];
}

let mineCache = null;
export async function myPrograms(force = false) {
  if (!session.porchId && !force) {
    try { const me = await api('/api/me'); session.update({ porchId: me.porch?.id || null }); } catch {}
  }
  if (!session.porchId) return [];
  if (!mineCache || force) {
    try { mineCache = (await api(`/api/programs?porch=${session.porchId}`)).programs.filter((p) => p.owner === session.deviceId); } catch { mineCache = []; }
  }
  return mineCache;
}

/** Crear o editar un programa. Devuelve el programa guardado (o null). */
export async function programSheet(existing = null) {
  const cats = await getCategories();
  let scene = existing?.scene || 1, photo = null;
  const s = sheet(html`
    <h2 class="h2">${existing ? 'Editar programa' : 'Nuevo programa'}</h2>
    <p class="muted small">Un programa es tu "show": por ejemplo «La noche del porche». Cada vez que lo emites y publicas, es un episodio nuevo.</p>
    <label class="field">Nombre<input class="input" name="name" maxlength="60" value="${existing?.name || ''}" placeholder="La noche del porche"></label>
    <label class="field">De qué va<textarea class="input" name="desc" maxlength="${LIMITS.DESC_MAX}" rows="3" placeholder="Charla de barrio los jueves por la noche…">${existing?.description || ''}</textarea></label>
    <div class="h3">Categorías</div>
    <button class="btn ghost cat-btn" data-a="cats"><span class="grow ellip" data-el="catlbl">${catName(cats, existing?.category || '') || 'Elegir categorías (máx. 3)'}</span>${icon('down')}</button>
    <div class="h3">Portada del programa</div>
    <div class="row gap-s">${SCENES.map((u, i) => html`<button data-sc="${i + 1}" class="grow ${!existing?.hasCover && scene === i + 1 ? 'on' : ''}" aria-label="Escena ${i + 1}"><img src="${u}" alt=""></button>`)}</div>
    <label class="btn sm ghost">${icon('camera')} Usar una foto mía<input type="file" accept="image/*" hidden data-ph></label>
    <button class="btn yellow big" data-a="save">${existing ? 'Guardar' : 'Crear programa'}</button>
    ${existing ? html`<button class="btn ghost red-t" data-a="del">${icon('trash')} Borrar programa (los episodios se quedan sueltos)</button>` : ''}`, {
    onMount(a) {
      let cat = existing?.category ? String(existing.category).split(',') : [];
      a.el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-a=cats]')) {
          const v = await categoryPicker(cat);
          if (v) { cat = v; a.el.querySelector('[data-el=catlbl]').textContent = catName(cats, cat.join(',')) || 'Elegir categorías (máx. 3)'; }
          return;
        }
        const sc = e.target.closest('[data-sc]');
        if (sc) { scene = Number(sc.dataset.sc); photo = null; a.el.querySelectorAll('[data-sc]').forEach((x) => x.classList.toggle('on', x === sc)); return; }
        if (e.target.closest('[data-a=del]')) {
          if (!confirm('¿Borrar este programa? Sus episodios seguirán publicados, pero sin programa.')) return;
          try { await api(`/api/programs/${existing.id}/delete`, { method: 'POST', body: {} }); mineCache = null; toast('Programa borrado'); a.close('deleted'); } catch (err) { toast(err.message, 'bad'); }
          return;
        }
        if (!e.target.closest('[data-a=save]')) return;
        const body = { name: a.el.querySelector('[name=name]').value.trim(), description: a.el.querySelector('[name=desc]').value.trim(), categories: cat, scene };
        if (!body.name) return toast('Ponle nombre al programa', 'bad');
        try {
          const r = existing
            ? await api(`/api/programs/${existing.id}/edit`, { method: 'POST', body })
            : await api('/api/programs', { method: 'POST', body });
          if (photo) await api(`/api/programs/${r.program.id}/cover`, { method: 'POST', raw: photo });
          else if (existing?.hasCover && !photo && a.el.querySelector('[data-sc].on')) await api(`/api/programs/${r.program.id}/cover`, { method: 'POST', raw: new Blob([]) });
          mineCache = null;
          toast(existing ? 'Programa guardado' : 'Programa creado', 'good');
          a.resolve(r.program); a.close(r.program);
        } catch (err) { toast(err.message, 'bad'); }
      });
      a.el.querySelector('[data-ph]').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { photo = await shrinkPhoto(f, 1080); a.el.querySelectorAll('[data-sc]').forEach((x) => x.classList.remove('on')); toast(`Foto lista (${Math.round(photo.size / 1024)} KB)`); } catch { toast('No se ha podido leer la foto', 'bad'); }
      };
    },
  });
  const v = await s.done;
  return v && typeof v === 'object' ? v : v === 'deleted' ? 'deleted' : null;
}

/** Selector de programa (para el camerino y al publicar). */
export function programPickerHtml(list, selected) {
  return html`<div class="prog-pick">
    ${list.map((p) => html`<button class="prog-opt ${p.id === selected ? 'on' : ''}" data-prog="${p.id}"><img src="${programCover(p)}" alt=""><span class="ellip">${p.name}</span></button>`)}
    <button class="prog-opt ${!selected ? 'on' : ''}" data-prog=""><span class="none">—</span><span>Sin programa</span></button>
    <button class="prog-opt add" data-prog="__new"><span class="none">＋</span><span>Nuevo</span></button>
  </div>`;
}
