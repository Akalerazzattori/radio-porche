// Editor al terminar: forma de onda con zoom, seleccionar y eliminar, recortar inicio y final,
// deshacer, escuchar, capítulos. Todo en el navegador: no se sube nada hasta publicar.
import { api, session, turnstileWidget } from '../api.js';
import { LIMITS } from '../config.js';
import { html, mount, icon, toast, sheet, confirmSheet, fmtTime, fmtDur, setPct, esc } from '../util.js';
import { requireIdentity } from '../common.js';
import { db } from '../db.js';
import { audioCtx } from '../audio/voice.js';
import { renderSegments, mixToMono, encodeBest, canEncodeOpus } from '../audio/encode.js';
import { composeCover, SCENES } from '../cover.js';

const SR = 24000; // suficiente para voz y música de fondo, y ligero en memoria

export async function render(view, [id], { go, back }) {
  const rec = await db.get('recordings', id);
  if (!rec) { mount(view, html`<section class="screen"><div class="top"><h1 class="h1">Editor</h1><button class="icon-btn" data-x>${icon('close')}</button></div><div class="empty"><p>Esta grabación ya no está en este móvil.</p></div></section>`); view.querySelector('[data-x]').onclick = () => go('/mi-porche'); return; }

  mount(view, html`
    <section class="screen">
      <div class="top">
        <button class="icon-btn" data-act="back" aria-label="Volver">${icon('back')}</button>
        <div class="grow"><h1 class="h1">Editor</h1><div class="sub ellip">${rec.title}${rec.part > 1 ? ` · Parte ${rec.part}` : ''}</div></div>
        <div class="col center"><span class="mono b" data-el="dur">--:--</span><span class="tiny muted">duración</span></div>
      </div>
      <div class="wavebox" data-el="box"><canvas data-el="cv"></canvas><div class="empty" data-el="loading"><div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><p>Cargando la grabación…</p></div></div>
      <div class="zoombar" data-el="zb"><i></i></div>
      <div class="row between mono small"><span data-el="pos">0:00</span><span class="muted" data-el="sel">Arrastra para seleccionar un trozo</span></div>
      <div class="tools">
        <button data-t="play">${icon('play')}<span>Escuchar</span></button>
        <button data-t="del" disabled>${icon('scissors')}<span>Eliminar</span></button>
        <button data-t="trimA">⇤<span>Recortar inicio</span></button>
        <button data-t="trimB">⇥<span>Recortar final</span></button>
        <button data-t="undo" disabled>${icon('undo')}<span>Deshacer</span></button>
        <button data-t="zin">${icon('zoomin')}<span>Acercar</span></button>
        <button data-t="zout">${icon('zoomout')}<span>Alejar</span></button>
        <button data-t="chap">${icon('flag')}<span>Capítulo</span></button>
      </div>
      <div class="banner yellow small" data-el="hint" hidden></div>
      <div class="row gap">
        <button class="btn ghost" data-act="delete" aria-label="Borrar">${icon('trash')}</button>
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
  } catch (e) {
    $el('loading').innerHTML = '<p>No se ha podido leer esta grabación en este navegador.</p>';
    return;
  }
  $el('loading').remove();
  const total = buffer.duration;

  // picos (100 por segundo)
  const PPS = 100, hop = Math.floor(SR / PPS);
  const data = buffer.getChannelData(0);
  const peaks = new Float32Array(Math.ceil(data.length / hop));
  for (let i = 0; i < peaks.length; i++) {
    let m = 0;
    const s = i * hop, e = Math.min(data.length, s + hop);
    for (let j = s; j < e; j += 4) { const v = Math.abs(data[j]); if (v > m) m = v; }
    peaks[i] = m;
  }

  // --- Estado de edición (no destructivo)
  let segs = [[0, total]];
  let chapters = (rec.chapters || []).slice();
  const undo = [];
  let edited = rec.editedOnce || false;
  let head = 0, selA = null, selB = null;
  let viewStart = 0, viewLen = total;
  const len = () => segs.reduce((a, [s, e]) => a + (e - s), 0);
  const toOrig = (t) => { for (const [s, e] of segs) { const d = e - s; if (t <= d) return s + t; t -= d; } return segs.length ? segs.at(-1)[1] : 0; };
  function cut(a, b) {
    if (b - a < 0.05) return;
    undo.push({ segs: segs.map((x) => x.slice()), chapters: chapters.map((c) => ({ ...c })) });
    const out = [];
    let acc = 0;
    for (const [s, e] of segs) {
      const d = e - s, s0 = acc, e0 = acc + d;
      if (e0 <= a || s0 >= b) out.push([s, e]);
      else {
        if (a > s0) out.push([s, s + (a - s0)]);
        if (b < e0) out.push([s + (b - s0), e]);
      }
      acc = e0;
    }
    segs = out.filter(([s, e]) => e - s > 0.01);
    chapters = chapters.filter((c) => c.t < a || c.t >= b).map((c) => (c.t >= b ? { ...c, t: c.t - (b - a) } : c));
    edited = true;
    selA = selB = null;
    head = Math.min(a, len());
    viewLen = Math.min(viewLen, len()); viewStart = Math.max(0, Math.min(viewStart, len() - viewLen));
    paint();
  }

  // --- Dibujo
  function paint() {
    const dpr = window.devicePixelRatio || 1;
    const W = box.clientWidth, H = box.clientHeight;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const L = len();
    const px2t = (x) => viewStart + (x / W) * viewLen;
    // selección
    if (selA != null && selB != null) {
      const a = Math.min(selA, selB), b = Math.max(selA, selB);
      g.fillStyle = 'rgba(232,50,30,.28)';
      g.fillRect(((a - viewStart) / viewLen) * W, 0, ((b - a) / viewLen) * W, H);
    }
    // onda
    const mid = H / 2;
    for (let x = 0; x < W; x++) {
      const t0 = px2t(x), t1 = px2t(x + 1);
      if (t0 > L) break;
      let m = 0;
      const steps = Math.max(1, Math.ceil(((t1 - t0) * PPS) / 6));
      for (let k = 0; k < steps; k++) {
        const o = toOrig(t0 + ((t1 - t0) * k) / steps);
        const v = peaks[Math.floor(o * PPS)] || 0;
        if (v > m) m = v;
      }
      const h = Math.max(1, Math.min(1, m * 1.6) * (H * 0.45));
      g.fillStyle = t0 < head ? '#ffc72c' : '#b8a196';
      g.fillRect(x, mid - h, 1, h * 2);
    }
    // uniones de cortes
    g.fillStyle = '#e8321e';
    let acc = 0;
    for (let i = 0; i < segs.length - 1; i++) { acc += segs[i][1] - segs[i][0]; const x = ((acc - viewStart) / viewLen) * W; if (x >= 0 && x <= W) g.fillRect(x - 1, 0, 2, H); }
    // capítulos
    for (const c of chapters) {
      const x = ((c.t - viewStart) / viewLen) * W;
      if (x < 0 || x > W) continue;
      g.fillStyle = '#1fb5a8'; g.fillRect(x - 1, 0, 2, H);
      g.font = '11px "Space Mono"'; g.fillText(c.title.slice(0, 18), x + 4, 14);
    }
    // cabezal
    const hx = ((head - viewStart) / viewLen) * W;
    g.fillStyle = '#fbeee0'; g.fillRect(hx - 1, 0, 2, H);
    // textos
    $el('dur').textContent = fmtTime(L);
    $el('pos').textContent = fmtTime(head);
    $el('sel').textContent = selA != null && selB != null && Math.abs(selB - selA) > 0.05 ? `Selección: ${fmtTime(Math.min(selA, selB))} – ${fmtTime(Math.max(selA, selB))}` : 'Arrastra para seleccionar un trozo';
    const zb = $el('zb');
    setPct(zb, '--l', (viewStart / L) * 100); setPct(zb, '--w', (viewLen / L) * 100);
    view.querySelector('[data-t=del]').disabled = !(selA != null && selB != null && Math.abs(selB - selA) > 0.05);
    view.querySelector('[data-t=undo]').disabled = !undo.length;
    const hint = $el('hint');
    if (L < LIMITS.MIN_PUBLISH_MIN * 60) { hint.hidden = false; hint.textContent = `Dura menos de ${LIMITS.MIN_PUBLISH_MIN} minutos: solo se puede guardar en privado o borrar. ¿Descartarlo?`; }
    else hint.hidden = true;
    view.querySelector('[data-act=publish]').disabled = L < LIMITS.MIN_PUBLISH_MIN * 60;
  }
  new ResizeObserver(() => paint()).observe(box);

  // --- Gestos en la onda: tocar = cabezal, arrastrar = seleccionar
  let downX = 0, dragging = false;
  const xToT = (clientX) => { const r = box.getBoundingClientRect(); return Math.max(0, Math.min(len(), viewStart + ((clientX - r.left) / r.width) * viewLen)); };
  box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); downX = e.clientX; dragging = true; selA = xToT(e.clientX); selB = null; });
  box.addEventListener('pointermove', (e) => { if (!dragging) return; if (Math.abs(e.clientX - downX) > 6) { selB = xToT(e.clientX); paint(); } });
  box.addEventListener('pointerup', (e) => {
    dragging = false;
    if (selB == null || Math.abs(e.clientX - downX) <= 6) { head = xToT(e.clientX); selA = selB = null; if (playing) { stopPlay(); startPlay(); } }
    paint();
  });
  // barra de zoom: arrastrar para moverse
  const zb = $el('zb');
  zb.addEventListener('pointerdown', (e) => {
    zb.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = zb.getBoundingClientRect(); const k = (ev.clientX - r.left) / r.width; viewStart = Math.max(0, Math.min(len() - viewLen, k * len() - viewLen / 2)); paint(); };
    move(e); zb.onpointermove = move; zb.onpointerup = () => { zb.onpointermove = null; };
  });

  // --- Escuchar
  let playing = false, srcs = [], playT0 = 0, playFrom = 0, raf = 0;
  function startPlay() {
    const c = audioCtx();
    let t = c.currentTime + 0.05;
    let acc = 0;
    srcs = [];
    for (const [s, e] of segs) {
      const d = e - s;
      if (acc + d <= head) { acc += d; continue; }
      const off = Math.max(0, head - acc);
      const src = c.createBufferSource(); src.buffer = buffer; src.connect(c.destination);
      src.start(t, s + off, d - off);
      srcs.push(src);
      t += d - off; acc += d;
    }
    playing = true; playT0 = c.currentTime + 0.05; playFrom = head;
    mount(view.querySelector('[data-t=play]'), html`${icon('pause')}<span>Pausa</span>`);
    const loop = () => { head = Math.min(len(), playFrom + (c.currentTime - playT0)); if (head >= len()) { stopPlay(); } if (head > viewStart + viewLen) viewStart = Math.min(len() - viewLen, head); paint(); if (playing) raf = requestAnimationFrame(loop); };
    loop();
  }
  function stopPlay() {
    srcs.forEach((s) => { try { s.stop(); } catch {} }); srcs = [];
    playing = false; cancelAnimationFrame(raf);
    mount(view.querySelector('[data-t=play]'), html`${icon('play')}<span>Escuchar</span>`);
  }

  view.querySelector('.tools').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = b.dataset.t;
    if (t === 'play') { playing ? stopPlay() : startPlay(); return; }
    if (playing) stopPlay();
    if (t === 'del') cut(Math.min(selA, selB), Math.max(selA, selB));
    if (t === 'trimA') { if (head > 0.1) cut(0, head); else toast('Mueve el cabezal hasta donde quieres que empiece'); }
    if (t === 'trimB') { if (head < len() - 0.1) cut(head, len()); else toast('Mueve el cabezal hasta donde quieres que acabe'); }
    if (t === 'undo' && undo.length) { const u = undo.pop(); segs = u.segs; chapters = u.chapters; paint(); }
    if (t === 'zin') { const c = head; viewLen = Math.max(5, viewLen / 2); viewStart = Math.max(0, Math.min(len() - viewLen, c - viewLen / 2)); paint(); }
    if (t === 'zout') { viewLen = Math.min(len(), viewLen * 2); viewStart = Math.max(0, Math.min(len() - viewLen, viewStart)); paint(); }
    if (t === 'chap') {
      const name = await (await import('../util.js')).promptSheet(`Capítulo en el ${fmtTime(head)}`, { max: 60, placeholder: 'Marta entra al micro' });
      if (name) { chapters.push({ t: head, title: name }); chapters.sort((a, c) => a.t - c.t); edited = edited || false; paint(); }
    }
  });

  // --- Guardar / publicar / borrar
  async function rendered(onProgress) {
    if (!edited && !(await canEncodeOpus(SR))) return { blob: rec.blob, duration: len() };
    const pcm = renderSegments(buffer, segs);
    const blob = await encodeBest(pcm, SR, { bitrate: 48000, onProgress });
    return { blob, duration: pcm.length / SR };
  }
  function progressSheet(title) {
    const s = sheet(html`<h2 class="h2">${title}</h2><div class="progress"><i></i></div><p class="muted small" data-el="msg">Preparando el audio en tu móvil…</p>`, { dismissable: false });
    const bar = s.el.querySelector('.progress');
    return { set: (k, msg) => { setPct(bar, '--p', k * 100); if (msg) s.el.querySelector('[data-el=msg]').textContent = msg; }, close: () => s.close() };
  }

  view.querySelector('[data-act=back]').onclick = () => { stopPlay(); go('/mi-porche?tab=grabaciones'); };
  view.querySelector('[data-act=delete]').onclick = async () => {
    if (!(await confirmSheet('¿Borrar la grabación?', 'Se borra de este móvil para siempre.', { ok: 'Borrar', danger: true }))) return;
    stopPlay(); await db.del('recordings', rec.id); toast('Borrada'); go('/mi-porche?tab=grabaciones');
  };
  view.querySelector('[data-act=private]').onclick = async () => {
    stopPlay();
    const ps = progressSheet('Guardando en privado');
    try {
      const r = edited ? await rendered((k) => ps.set(k)) : { blob: rec.blob, duration: len() };
      await db.put('recordings', { ...rec, kind: 'private', blob: r.blob, mime: r.blob.type, duration: r.duration, chapters });
      ps.close(); toast('Guardado en privado (solo en este móvil)', 'good'); go('/mi-porche?tab=grabaciones');
    } catch (e) { ps.close(); toast('No se ha podido guardar: ' + e.message, 'bad'); }
  };
  view.querySelector('[data-act=publish]').onclick = async () => {
    stopPlay();
    if (len() < LIMITS.MIN_PUBLISH_MIN * 60) return toast(`Mínimo ${LIMITS.MIN_PUBLISH_MIN} minutos para publicar`, 'bad');
    if (!(await requireIdentity())) return;
    publishSheet();
  };

  function publishSheet() {
    let photo = null, scene = rec.scene || 1, getTs = () => '';
    const s = sheet(html`
      <h2 class="h2">Publicar</h2>
      <div class="row gap">
        <img data-el="prev" src="${SCENES[scene - 1]}" alt="Portada" width="96" height="96" class="cover-prev">
        <div class="col gap-s grow">
          <label class="btn sm yellow">${icon('camera')} Hacer foto<input type="file" accept="image/*" capture="environment" hidden data-ph></label>
          <label class="btn sm ghost">${icon('upload')} Subir foto<input type="file" accept="image/*" hidden data-ph></label>
          <div class="row gap-s">${SCENES.map((u, i) => html`<button data-sc="${i + 1}" class="grow"><img src="${u}" alt="Escena ${i + 1}"></button>`)}</div>
        </div>
      </div>
      <p class="muted tiny">Ponemos encima el título y la fecha con el estilo de Radio Porche.</p>
      <label class="field">Título<input class="input" name="title" maxlength="${LIMITS.TITLE_MAX}" value="${rec.title}${rec.part > 1 ? ` · Parte ${rec.part}` : ''}"></label>
      <label class="field">Descripción<textarea class="input" name="desc" maxlength="${LIMITS.DESC_MAX}" rows="3" placeholder="De qué va, quién sale…">${rec.description || ''}</textarea></label>
      ${chapters.length ? html`<p class="small muted">${chapters.length} capítulos marcados.</p>` : ''}
      <label class="check"><input type="checkbox" name="ok"><span>Las personas que salen saben que se publica, y la música o vídeos de otros son solo fragmentos breves para comentar.</span></label>
      <div class="ts"></div>
      <button class="btn red big" data-a="go">Publicar</button>`, {
      async onMount(a) {
        getTs = await turnstileWidget(a.el.querySelector('.ts'));
        const prev = a.el.querySelector('[data-el=prev]');
        const refresh = async () => {
          const blob = await composeCover({ photo, scene, title: a.el.querySelector('[name=title]').value, date: rec.created });
          prev.src = URL.createObjectURL(blob);
        };
        refresh();
        a.el.querySelector('[name=title]').addEventListener('change', refresh);
        a.el.querySelectorAll('[data-ph]').forEach((i) => (i.onchange = (e) => { photo = e.target.files[0] || null; refresh(); }));
        a.el.addEventListener('click', async (e) => {
          const sc = e.target.closest('[data-sc]');
          if (sc) { scene = Number(sc.dataset.sc); photo = null; refresh(); return; }
          if (!e.target.closest('[data-a=go]')) return;
          if (!a.el.querySelector('[name=ok]').checked) return toast('Confirma el aviso antes de publicar', 'bad');
          const title = a.el.querySelector('[name=title]').value.trim() || rec.title;
          const description = a.el.querySelector('[name=desc]').value.trim();
          const ts = getTs();
          a.close('go');
          const ps = progressSheet('Publicando');
          try {
            const r = await rendered((k) => ps.set(k * 0.8, 'Comprimiendo el audio en tu móvil…'));
            if (r.blob.size > LIMITS.MAX_UPLOAD_BYTES) throw new Error('El audio pesa demasiado. Recórtalo un poco.');
            ps.set(0.85, 'Creando la portada…');
            const cover = await composeCover({ photo, scene, title, date: rec.created });
            ps.set(0.9, 'Subiendo…');
            const fd = new FormData();
            fd.append('meta', JSON.stringify({ title, description, chapters, part: rec.part || 1, series: rec.series || '', scene }));
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
  return () => stopPlay();
}
