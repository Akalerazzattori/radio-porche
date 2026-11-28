// Editor al terminar, pensado para entenderse a la primera:
//  · dos tiradores amarillos = dónde empieza y dónde acaba
//  · «Quitar trozo» + marcar con el dedo = fuera ese trozo del medio
//  · deshacer, escuchar, capítulos y zoom
// Todo en el navegador: no se sube nada hasta publicar.
import { api, turnstileWidget } from '../api.js';
import { LIMITS } from '../config.js';
import { html, mount, icon, toast, sheet, confirmSheet, promptSheet, fmtTime, setPct } from '../util.js';
import { requireIdentity } from '../common.js';
import { db } from '../db.js';
import { audioCtx } from '../audio/voice.js';
import { renderSegments, mixToMono, encodeBest, canEncodeOpus } from '../audio/encode.js';
import { composeCover, SCENES, shrinkPhoto } from '../cover.js';
import { myPrograms, programSheet, programPickerHtml } from '../programs.js';

const SR = 24000; // suficiente para voz y música de fondo, y ligero en memoria

/** Miniatura de una grabación (su foto o su escena). */
export function recordingThumb(r) {
  return r.photo ? URL.createObjectURL(r.photo) : SCENES[((r.scene || 1) - 1) % 4];
}

/** Título, descripción y foto de una grabación guardada en el móvil. */
export function recordingDetailsSheet(rec) {
  let photo = rec.photo || null, scene = rec.scene || 1;
  const s = sheet(html`
    <h2 class="h2">Título y portada</h2>
    <div class="row gap">
      <img data-el="prev" class="cover-prev" alt="Portada" width="96" height="96">
      <div class="col gap-s grow">
        <label class="btn sm yellow">${icon('camera')} Hacer foto<input type="file" accept="image/*" capture="environment" hidden data-ph></label>
        <label class="btn sm ghost">${icon('upload')} Subir foto<input type="file" accept="image/*" hidden data-ph></label>
      </div>
    </div>
    <div class="row gap-s">${SCENES.map((u, i) => html`<button data-sc="${i + 1}" class="grow" aria-label="Escena ${i + 1}"><img src="${u}" alt=""></button>`)}</div>
    <p class="muted tiny">Sin foto usamos una escena. Al publicar ponemos encima el título y la fecha con el estilo de Radio Porche.</p>
    <label class="field">Título<input class="input" name="title" maxlength="${LIMITS.TITLE_MAX}" value="${rec.title || ''}"></label>
    <label class="field">Descripción<textarea class="input" name="desc" maxlength="${LIMITS.DESC_MAX}" rows="3" placeholder="De qué va, quién sale…">${rec.description || ''}</textarea></label>
    <button class="btn yellow big" data-a="save">Guardar</button>`, {
    onMount(a) {
      const prev = a.el.querySelector('[data-el=prev]');
      const refresh = async () => {
        a.el.querySelectorAll('[data-sc]').forEach((b) => b.classList.toggle('on', !photo && Number(b.dataset.sc) === scene));
        const blob = await composeCover({ photo, scene, title: a.el.querySelector('[name=title]').value, date: rec.created });
        prev.src = URL.createObjectURL(blob);
      };
      refresh();
      a.el.querySelector('[name=title]').addEventListener('change', refresh);
      a.el.querySelectorAll('[data-ph]').forEach((i) => (i.onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { photo = await shrinkPhoto(f, 1080); refresh(); toast(`Foto lista (${Math.round(photo.size / 1024)} KB)`); } catch { toast('No se ha podido leer la foto', 'bad'); }
      }));
      a.el.addEventListener('click', async (e) => {
        const sc = e.target.closest('[data-sc]');
        if (sc) { scene = Number(sc.dataset.sc); photo = null; refresh(); return; }
        if (!e.target.closest('[data-a=save]')) return;
        Object.assign(rec, { title: a.el.querySelector('[name=title]').value.trim() || rec.title, description: a.el.querySelector('[name=desc]').value.trim(), photo, scene });
        const stored = await db.get('recordings', rec.id);
        if (stored) await db.put('recordings', { ...stored, title: rec.title, description: rec.description, photo, scene });
        toast('Guardado', 'good');
        a.close('ok');
      });
    },
  });
  return s.done;
}

export async function render(view, [id], { go }) {
  const rec = await db.get('recordings', id);
  if (!rec) { mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Editor</h1><button class="icon-btn" data-x>${icon('close')}</button></div><div class="empty"><p>Esta grabación ya no está en este móvil.</p></div></section>`); view.querySelector('[data-x]').onclick = () => go('/mi-porche'); return; }

  mount(view, html`
    <section class="screen">
      <div class="top">
        <button class="btn sm ghost" data-act="back">${icon('back')} Volver</button>
        <div class="grow right"><div class="h3">Editar grabación</div><button class="b ellip" data-act="details" data-el="title">${rec.title} ✎</button></div>
      </div>
      <div class="editor-help" data-el="help">Arrastra los <b>tiradores amarillos</b> para elegir <b>dónde empieza</b> y <b>dónde acaba</b>. Toca la onda para escuchar desde ahí.</div>
      <div class="wavebox" data-el="box"><canvas data-el="cv"></canvas><div class="empty" data-el="loading"><div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><p>Cargando la grabación…</p></div></div>
      <div class="zoombar" data-el="zb"><i></i></div>
      <div class="row between small"><span class="mono" data-el="pos">0:00</span><span class="b">Durará <span class="mono yellow-t" data-el="dur">--:--</span></span><span class="row gap-s"><button class="btn sm ghost" data-t="zout" aria-label="Alejar">${icon('zoomout')}</button><button class="btn sm ghost" data-t="zin" aria-label="Acercar">${icon('zoomin')}</button></span></div>
      <div class="tools">
        <button data-t="play">${icon('play')}<span>Escuchar</span></button>
        <button data-t="cut">${icon('scissors')}<span>Quitar un trozo</span></button>
        <button data-t="undo" disabled>${icon('undo')}<span>Deshacer</span></button>
        <button data-t="chap">${icon('flag')}<span>Marcar capítulo</span></button>
      </div>
      <div class="banner yellow small" data-el="hint" hidden></div>
      <div class="row gap">
        <button class="btn ghost" data-act="delete" aria-label="Borrar grabación">${icon('trash')}</button>
        <button class="btn ghost grow" data-act="private">Guardar privado</button>
        <button class="btn red grow title" data-act="publish">Publicar</button>
      </div>
    </section>`);
  const $el = (n) => view.querySelector(`[data-el=${n}]`);
  const cv = $el('cv'), box = $el('box');

  // --- Decodificar a 24 kHz mono
  let buffer;
  try {
    const ab = await rec.blob.arrayBuffer();
    const oc = new OfflineAudioContext(1, 1, SR);
    const dec = await oc.decodeAudioData(ab);
    if (dec.numberOfChannels > 1) {
      const m = mixToMono(dec);
      buffer = new AudioBuffer({ length: m.length, sampleRate: SR, numberOfChannels: 1 });
      buffer.copyToChannel(m, 0);
    } else buffer = dec;
  } catch {
    $el('loading').innerHTML = '<p>No se ha podido leer esta grabación en este navegador.</p>';
    return;
  }
  $el('loading').remove();
  const total = buffer.duration;

  const PPS = 100, hop = Math.floor(SR / PPS);
  const data = buffer.getChannelData(0);
  const peaks = new Float32Array(Math.ceil(data.length / hop));
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    const s = i * hop, e = Math.min(data.length, s + hop);
    for (let j = s; j < e; j += 4) { const v = Math.abs(data[j]); if (v > m) m = v; }
    peaks[i] = m;
  }

  // --- Estado (no destructivo). Tiempos "editados" = tras quitar trozos.
  let segs = [[0, total]];
  let chapters = (rec.chapters || []).slice();
  let trimA = 0, trimB = total;
  const undo = [];
  let edited = false, cutMode = false;
  let head = 0, selA = null, selB = null;
  let viewStart = 0, viewLen = total;
  const len = () => segs.reduce((a, [s, e]) => a + (e - s), 0);
  const toOrig = (t) => { for (const [s, e] of segs) { const d = e - s; if (t <= d) return s + t; t -= d; } return segs.length ? segs.at(-1)[1] : 0; };
  const snapshot = () => undo.push({ segs: segs.map((x) => x.slice()), chapters: chapters.map((c) => ({ ...c })), trimA, trimB });

  function removePiece(a, b) {
    if (b - a < 0.05) return;
    snapshot();
    const out = [];
    let acc = 0;
    for (const [s, e] of segs) {
      const d = e - s, s0 = acc, e0 = acc + d;
      if (e0 <= a || s0 >= b) out.push([s, e]);
      else { if (a > s0) out.push([s, s + (a - s0)]); if (b < e0) out.push([s + (b - s0), e]); }
      acc = e0;
    }
    segs = out.filter(([s, e]) => e - s > 0.01);
    const shift = (x) => (x >= b ? x - (b - a) : x > a ? a : x);
    trimA = shift(trimA); trimB = shift(trimB);
    chapters = chapters.filter((c) => c.t < a || c.t >= b).map((c) => ({ ...c, t: shift(c.t) }));
    edited = true;
    selA = selB = null;
    head = Math.min(a, len());
    viewLen = Math.min(viewLen, len()); viewStart = Math.max(0, Math.min(viewStart, len() - viewLen));
    setCutMode(false);
    toast('Trozo quitado. Puedes deshacerlo.');
    paint();
  }
  /** Trozos originales que quedan entre los tiradores. */
  function finalSegs() {
    const out = [];
    let acc = 0;
    for (const [s, e] of segs) {
      const d = e - s, s0 = acc, e0 = acc + d;
      const a = Math.max(s0, trimA), b = Math.min(e0, trimB);
      if (b > a) out.push([s + (a - s0), s + (b - s0)]);
      acc = e0;
    }
    return out;
  }
  const finalLen = () => trimB - trimA;
  const finalChapters = () => chapters.filter((c) => c.t >= trimA && c.t < trimB).map((c) => ({ ...c, t: c.t - trimA }));
  const isEdited = () => edited || trimA > 0.05 || trimB < len() - 0.05;

  // --- Dibujo
  const X = (t, W) => ((t - viewStart) / viewLen) * W;
  function paint() {
    const dpr = window.devicePixelRatio || 1;
    const W = box.clientWidth, H = box.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const L = len(), mid = H / 2 - 8;
    for (let x = 0; x < W; x++) {
      const t0 = viewStart + (x / W) * viewLen, t1 = viewStart + ((x + 1) / W) * viewLen;
      if (t0 > L) break;
      let m = 0;
      const steps = Math.max(1, Math.ceil(((t1 - t0) * PPS) / 6));
      for (let k = 0; k < steps; k++) { const v = peaks[Math.floor(toOrig(t0 + ((t1 - t0) * k) / steps) * PPS)] || 0; if (v > m) m = v; }
      const h = Math.max(1, Math.min(1, m * 1.6) * (H * 0.38));
      const inside = t0 >= trimA && t0 <= trimB;
      g.fillStyle = !inside ? '#4a3a35' : t0 < head ? '#ffc72c' : '#e8d3c2';
      g.fillRect(x, mid - h, 1, h * 2);
    }
    // fuera de los tiradores: oscurecido
    g.fillStyle = 'rgba(18,13,12,.55)';
    g.fillRect(0, 0, Math.max(0, X(trimA, W)), H);
    g.fillRect(X(trimB, W), 0, W, H);
    // selección de "quitar trozo"
    if (selA != null && selB != null) {
      const a = Math.min(selA, selB), b = Math.max(selA, selB);
      g.fillStyle = 'rgba(232,50,30,.4)';
      g.fillRect(X(a, W), 0, X(b, W) - X(a, W), H);
      g.fillStyle = '#fbeee0'; g.font = 'bold 12px Archivo'; g.fillText('✂ quitar', X(a, W) + 6, 16);
    }
    // uniones
    g.fillStyle = '#e8321e';
    let acc = 0;
    for (let i = 0; i < segs.length - 1; i++) { acc += segs[i][1] - segs[i][0]; const x = X(acc, W); if (x >= 0 && x <= W) g.fillRect(x - 1, 0, 2, H); }
    // capítulos
    for (const c of chapters) {
      const x = X(c.t, W);
      if (x < 0 || x > W) continue;
      g.fillStyle = '#1fb5a8'; g.fillRect(x - 1, 0, 2, H - 26);
      g.font = '11px "Space Mono"'; g.fillText(c.title.slice(0, 18), x + 4, 30);
    }
    // cabezal
    g.fillStyle = '#fbeee0'; g.fillRect(X(head, W) - 1, 0, 2, H - 26);
    // tiradores
    for (const [t, lbl] of [[trimA, 'EMPIEZA'], [trimB, 'ACABA']]) {
      const x = X(t, W);
      if (x < -20 || x > W + 20) continue;
      g.fillStyle = '#ffc72c';
      g.fillRect(x - 2, 0, 4, H);
      g.beginPath(); g.roundRect ? g.roundRect(x - 18, H - 26, 36, 24, 8) : g.rect(x - 18, H - 26, 36, 24); g.fill();
      g.fillStyle = '#120d0c'; g.font = 'bold 14px Archivo'; g.textAlign = 'center'; g.fillText(t === trimA ? '◀▶' : '◀▶', x, H - 9);
      g.fillStyle = '#ffc72c'; g.font = 'bold 10px Archivo'; g.fillText(lbl, Math.max(28, Math.min(W - 28, x)), H - 32); g.textAlign = 'left';
    }
    $el('dur').textContent = fmtTime(finalLen());
    $el('pos').textContent = fmtTime(head);
    setPct($el('zb'), '--l', (viewStart / L) * 100); setPct($el('zb'), '--w', (viewLen / L) * 100);
    view.querySelector('[data-t=undo]').disabled = !undo.length;
    const hasSel = selA != null && selB != null && Math.abs(selB - selA) > 0.05;
    const cutBtn = view.querySelector('[data-t=cut]');
    mount(cutBtn, hasSel ? html`${icon('scissors')}<span>Quitar este trozo</span>` : cutMode ? html`${icon('close')}<span>Cancelar</span>` : html`${icon('scissors')}<span>Quitar un trozo</span>`);
    cutBtn.classList.toggle('on', cutMode);
    const hint = $el('hint');
    if (finalLen() < LIMITS.MIN_PUBLISH_MIN * 60) { hint.hidden = false; hint.textContent = `Dura menos de ${LIMITS.MIN_PUBLISH_MIN} minutos: puedes guardarla en privado o borrarla, pero no publicarla.`; }
    else hint.hidden = true;
    view.querySelector('[data-act=publish]').disabled = finalLen() < LIMITS.MIN_PUBLISH_MIN * 60;
  }
  function setCutMode(on) {
    cutMode = on; selA = selB = null;
    box.classList.toggle('mode-cut', on);
    $el('help').innerHTML = on
      ? 'Marca con el dedo el <b>trozo que quieres quitar</b> (se pondrá en rojo) y pulsa <b>Quitar este trozo</b>.'
      : 'Arrastra los <b>tiradores amarillos</b> para elegir <b>dónde empieza</b> y <b>dónde acaba</b>. Toca la onda para escuchar desde ahí.';
    paint();
  }
  new ResizeObserver(() => paint()).observe(box);

  // --- Gestos
  const xToT = (clientX) => { const r = box.getBoundingClientRect(); return Math.max(0, Math.min(len(), viewStart + ((clientX - r.left) / r.width) * viewLen)); };
  let drag = null, downX = 0;
  box.addEventListener('pointerdown', (e) => {
    box.setPointerCapture(e.pointerId);
    downX = e.clientX;
    const W = box.clientWidth, r = box.getBoundingClientRect(), x = e.clientX - r.left;
    const da = Math.abs(x - X(trimA, W)), db = Math.abs(x - X(trimB, W));
    if (Math.min(da, db) < 26) { snapshot(); drag = da <= db ? 'A' : 'B'; if (playing) stopPlay(); return; }
    if (cutMode) { drag = 'sel'; selA = xToT(e.clientX); selB = null; return; }
    drag = 'head'; head = Math.max(trimA, Math.min(trimB, xToT(e.clientX))); paint();
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const t = xToT(e.clientX);
    if (drag === 'A') { trimA = Math.max(0, Math.min(t, trimB - 1)); head = trimA; }
    else if (drag === 'B') { trimB = Math.min(len(), Math.max(t, trimA + 1)); head = Math.max(trimA, trimB - 3); }
    else if (drag === 'sel') { if (Math.abs(e.clientX - downX) > 6) selB = t; }
    else if (drag === 'head') head = Math.max(trimA, Math.min(trimB, t));
    paint();
  });
  box.addEventListener('pointerup', () => {
    if (drag === 'A' || drag === 'B') { const u = undo.at(-1); if (u && u.trimA === trimA && u.trimB === trimB) undo.pop(); }
    if (drag === 'head' && playing) { stopPlay(); startPlay(); }
    drag = null; paint();
  });
  const zb = $el('zb');
  zb.addEventListener('pointerdown', (e) => {
    zb.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = zb.getBoundingClientRect(); const k = (ev.clientX - r.left) / r.width; viewStart = Math.max(0, Math.min(len() - viewLen, k * len() - viewLen / 2)); paint(); };
    move(e); zb.onpointermove = move; zb.onpointerup = () => { zb.onpointermove = null; };
  });

  // --- Escuchar (desde el cabezal hasta el tirador final)
  let playing = false, srcs = [], playT0 = 0, playFrom = 0, raf = 0;
  function startPlay() {
    const c = audioCtx();
    if (head >= trimB - 0.2 || head < trimA) head = trimA;
    let t = c.currentTime + 0.05, acc = 0;
    srcs = [];
    for (const [s, e] of segs) {
      const d = e - s, s0 = acc, e0 = acc + d;
      acc = e0;
      const a = Math.max(s0, head), b = Math.min(e0, trimB);
      if (b <= a) continue;
      const src = c.createBufferSource(); src.buffer = buffer; src.connect(c.destination);
      src.start(t, s + (a - s0), b - a);
      srcs.push(src);
      t += b - a;
    }
    playing = true; playT0 = c.currentTime + 0.05; playFrom = head;
    mount(view.querySelector('[data-t=play]'), html`${icon('pause')}<span>Pausa</span>`);
    const loop = () => {
      head = Math.min(trimB, playFrom + (c.currentTime - playT0));
      if (head >= trimB) stopPlay();
      if (head > viewStart + viewLen) viewStart = Math.min(len() - viewLen, head);
      paint();
      if (playing) raf = requestAnimationFrame(loop);
    };
    loop();
  }
  function stopPlay() {
    srcs.forEach((s) => { try { s.stop(); } catch {} }); srcs = [];
    playing = false; cancelAnimationFrame(raf);
    mount(view.querySelector('[data-t=play]'), html`${icon('play')}<span>Escuchar</span>`);
  }

  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = b.dataset.t;
    if (t === 'play') { playing ? stopPlay() : startPlay(); return; }
    if (playing) stopPlay();
    if (t === 'cut') {
      if (selA != null && selB != null && Math.abs(selB - selA) > 0.05) removePiece(Math.min(selA, selB), Math.max(selA, selB));
      else setCutMode(!cutMode);
    }
    if (t === 'undo' && undo.length) { const u = undo.pop(); segs = u.segs; chapters = u.chapters; trimA = u.trimA; trimB = u.trimB; head = Math.max(trimA, Math.min(head, trimB)); paint(); }
    if (t === 'zin') { viewLen = Math.max(5, viewLen / 2); viewStart = Math.max(0, Math.min(len() - viewLen, head - viewLen / 2)); paint(); }
    if (t === 'zout') { viewLen = Math.min(len(), viewLen * 2); viewStart = Math.max(0, Math.min(len() - viewLen, viewStart)); paint(); }
    if (t === 'chap') {
      const name = await promptSheet(`Capítulo en el ${fmtTime(head - trimA)}`, { max: 60, placeholder: 'p. ej. Marta entra al micro' });
      if (name) { chapters.push({ t: head, title: name }); chapters.sort((a, c) => a.t - c.t); paint(); }
    }
  });

  // --- Guardar / publicar / borrar
  async function rendered(onProgress) {
    if (!isEdited() && !(await canEncodeOpus(SR))) return { blob: rec.blob, duration: finalLen() };
    const pcm = renderSegments(buffer, finalSegs());
    const blob = await encodeBest(pcm, SR, { bitrate: 48000, onProgress });
    return { blob, duration: pcm.length / SR };
  }
  function progressSheet(title) {
    const s = sheet(html`<h2 class="h2">${title}</h2><div class="progress"><i></i></div><p class="muted small" data-el="msg">Preparando el audio en tu móvil…</p>`, { dismissable: false });
    const bar = s.el.querySelector('.progress');
    return { set: (k, msg) => { setPct(bar, '--p', k * 100); if (msg) s.el.querySelector('[data-el=msg]').textContent = msg; }, close: () => s.close() };
  }

  view.querySelector('[data-act=back]').onclick = async () => {
    stopPlay();
    if (isEdited() && !(await confirmSheet('¿Salir sin guardar los cortes?', 'La grabación sigue en Grabaciones tal como estaba.', { ok: 'Salir', cancel: 'Seguir editando' }))) return;
    go('/mi-porche?tab=grabaciones');
  };
  view.querySelector('[data-act=details]').onclick = async () => {
    if ((await recordingDetailsSheet(rec)) === 'ok') $el('title').textContent = `${rec.title} ✎`;
  };
  view.querySelector('[data-act=delete]').onclick = async () => {
    if (!(await confirmSheet('¿Borrar la grabación?', 'Se borra de este móvil para siempre.', { ok: 'Borrar', danger: true }))) return;
    stopPlay(); await db.del('recordings', rec.id); toast('Borrada'); go('/mi-porche?tab=grabaciones');
  };
  view.querySelector('[data-act=private]').onclick = async () => {
    stopPlay();
    const ps = progressSheet('Guardando en privado');
    try {
      const r = isEdited() ? await rendered((k) => ps.set(k)) : { blob: rec.blob, duration: finalLen() };
      const stored = (await db.get('recordings', rec.id)) || rec;
      await db.put('recordings', { ...stored, kind: 'private', blob: r.blob, mime: r.blob.type, duration: r.duration, chapters: finalChapters() });
      ps.close(); toast('Guardado en privado (solo en este móvil). Puedes volver a editarlo cuando quieras.', 'good'); go('/mi-porche?tab=grabaciones');
    } catch (e) { ps.close(); toast('No se ha podido guardar: ' + e.message, 'bad'); }
  };
  view.querySelector('[data-act=publish]').onclick = async () => {
    stopPlay();
    if (finalLen() < LIMITS.MIN_PUBLISH_MIN * 60) return toast(`Mínimo ${LIMITS.MIN_PUBLISH_MIN} minutos para publicar`, 'bad');
    if (!(await requireIdentity())) return;
    publishSheet();
  };

  function publishSheet() {
    let getTs = () => '';
    const s = sheet(html`
      <h2 class="h2">Publicar</h2>
      <div class="row gap">
        <img data-el="prev" class="cover-prev" alt="Portada" width="96" height="96">
        <div class="grow col gap-s"><b class="ellip">${rec.title}</b><span class="muted small">${fmtTime(finalLen())} · ${finalChapters().length} capítulos</span><button class="btn sm ghost" data-a="details">${icon('edit')} Cambiar título o foto</button></div>
      </div>
      <div class="h3">Programa</div>
      <div data-el="progs"></div>
      <p class="muted tiny">Se publicará como el siguiente episodio del programa. Si no eliges ninguno, queda como episodio suelto de tu porche.</p>
      <label class="check"><input type="checkbox" name="ok"><span>Las personas que salen saben que se publica, y la música o vídeos de otros son solo fragmentos breves para comentar.</span></label>
      <div class="ts"></div>
      <button class="btn red big" data-a="go">Publicar en el archivo</button>`, {
      async onMount(a) {
        getTs = await turnstileWidget(a.el.querySelector('.ts'));
        let programs = await myPrograms();
        let programId = rec.programId && programs.some((p) => p.id === rec.programId) ? rec.programId : programs[0]?.id || '';
        const progsEl = a.el.querySelector('[data-el=progs]');
        const paintProgs = () => mount(progsEl, programPickerHtml(programs, programId));
        paintProgs();
        progsEl.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-prog]');
          if (!b) return;
          if (b.dataset.prog === '__new') { const p = await programSheet(); if (p && typeof p === 'object') { programs = await myPrograms(true); programId = p.id; paintProgs(); } return; }
          programId = b.dataset.prog; paintProgs();
        });
        a.publishProgram = () => programId;
        const prev = a.el.querySelector('[data-el=prev]');
        const refresh = async () => { prev.src = URL.createObjectURL(await composeCover({ photo: rec.photo, scene: rec.scene || 1, title: rec.title, date: rec.created })); };
        refresh();
        a.el.addEventListener('click', async (e) => {
          if (e.target.closest('[data-a=details]')) { await recordingDetailsSheet(rec); $el('title').textContent = `${rec.title} ✎`; a.el.querySelector('b.ellip').textContent = rec.title; refresh(); return; }
          if (!e.target.closest('[data-a=go]')) return;
          if (!a.el.querySelector('[name=ok]').checked) return toast('Confirma el aviso antes de publicar', 'bad');
          const ts = getTs();
          a.close('go');
          const ps = progressSheet('Publicando');
          try {
            const r = await rendered((k) => ps.set(k * 0.8, 'Comprimiendo el audio en tu móvil…'));
            if (r.blob.size > LIMITS.MAX_UPLOAD_BYTES) throw new Error('El audio pesa demasiado. Recórtalo un poco.');
            ps.set(0.85, 'Creando la portada…');
            const cover = await composeCover({ photo: rec.photo, scene: rec.scene || 1, title: rec.title, date: rec.created });
            ps.set(0.9, 'Subiendo…');
            const fd = new FormData();
            fd.append('meta', JSON.stringify({ title: rec.title, description: rec.description || '', chapters: finalChapters(), part: rec.part || 1, series: rec.series || '', scene: rec.scene || 1, programId: a.publishProgram?.() || '' }));
            fd.append('audio', r.blob, 'audio.' + (r.blob.type.includes('mp4') ? 'm4a' : 'webm'));
            fd.append('cover', cover, 'cover.' + (cover.type === 'image/webp' ? 'webp' : 'jpg'));
            fd.append('turnstile', ts);
            const res = await api('/api/podcasts', { method: 'POST', form: fd });
            ps.set(1, '¡Publicado!');
            await db.del('recordings', rec.id);
            ps.close();
            toast('¡Publicado en el archivo!', 'good');
            go(`/p/${res.podcast.id}`);
          } catch (err) {
            ps.close();
            toast(err.message || 'No se ha podido publicar', 'bad');
          }
        });
      },
    });
    return s.done;
  }
  paint();
  if (new URLSearchParams(location.search).get('publicar') === '1') setTimeout(() => view.querySelector('[data-act=publish]')?.click(), 200);
  return () => stopPlay();
}
