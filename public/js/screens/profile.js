// Perfil y ajustes: identidad, recuperación, copia para cambiar de móvil, mis datos, textos legales y ayuda.
import { api, session } from '../api.js';
import { LEGAL } from '../config.js';
import { html, mount, icon, toast, sheet, confirmSheet, promptSheet, initial, avatarColor, fmtBytes } from '../util.js';
import { requireIdentity, recoveryLink, copy, recoverSheet, unblockAll, blockedList, linkDeviceSheet } from '../common.js';
import { exportBackup, importBackup, wipeLocal, storageEstimate, requestPersist } from '../db.js';
import { avatarBlob } from '../cover.js';
import { avatar } from '../common.js';
import { live } from '../live.js';

export async function render(view, _p, { go }) {
  const logged = !!session.token;
  const est = await storageEstimate();
  mount(view, html`
    <section class="screen">
      <div class="top"><div class="row gap-s"><img class="brand-ic" src="/img/app-icon-192.png" alt="" width="40" height="40"><div><h1 class="h1">Perfil</h1><div class="sub">Lo avanzado está aquí</div></div></div></div>
      <div class="fill scroll col gap">
        ${logged ? html`
          <div class="card row gap">
            <label class="avatar-edit" aria-label="Cambiar foto de perfil">${avatar({ name: session.name, dev: session.deviceId, av: session.get()?.avatar || 0 }, 'xl')}<span class="cam">${icon('camera')}</span><input type="file" accept="image/*" hidden data-act="avatar"></label>
            <div class="grow"><div class="b">${session.name}</div><div class="muted tiny">Toca la foto para cambiarla. Se guarda muy reducida.</div></div>
            <button class="btn sm ghost" data-act="rename" aria-label="Cambiar nombre">${icon('edit')}</button>
          </div>`
        : html`<div class="card col gap-s"><b>Aún no has entrado</b><p class="muted small">Puedes escuchar sin entrar. Para chatear, pedir micro o abrir tu porche, entra solo con un nombre.</p><button class="btn yellow" data-act="login">Entrar con mi nombre</button><button class="btn ghost" data-act="recover">Ya tengo porche en otro aparato</button></div>`}

        <div class="h3">Otros aparatos</div>
        <div class="group">
          ${logged ? html`<button class="li" data-act="link">${icon('link')} <span class="grow">Vincular otro aparato (ordenador)</span></button>` : html`<button class="li" data-act="recover">${icon('link')} <span class="grow">Ya tengo porche en otro aparato</span></button>`}
          ${logged ? html`<button class="li" data-act="recovery">${icon('shield')} <span class="grow">Copiar enlace de recuperación</span></button>` : ''}
          <button class="li" data-act="export">${icon('dl')} <span class="grow">Exportar copia (borradores, sonidos y ajustes)</span></button>
          <label class="li">${icon('upload')} <span class="grow">Importar copia</span><input type="file" hidden data-act="import" accept=".rpbk,application/octet-stream,*/*"></label>
        </div>
        <p class="muted tiny">La app web <b>no se traspasa sola</b> al cambiar de iPhone o Android, y borrar los datos del navegador la borra. Guarda la copia en iCloud, Drive o pásala por AirDrop, y en el móvil nuevo pulsa «Importar copia».${est ? ` Ocupas ${fmtBytes(est.usage || 0)} en este móvil.` : ''}</p>

        <div class="h3">Mis datos</div>
        <div class="group">
          ${logged ? html`<button class="li" data-act="mydata">${icon('dl')} <span class="grow">Descargar mis datos</span></button>` : ''}
          ${blockedList().length ? html`<button class="li" data-act="unblock">${icon('block')} <span class="grow">Desbloquear a todos (${blockedList().length})</span></button>` : ''}
          <button class="li danger" data-act="wipe">${icon('trash')} <span class="grow">Borrar todos mis datos</span></button>
        </div>

        <div class="h3">Ayuda</div>
        <div class="group">
          <button class="li" data-act="help">${icon('hp')} <span class="grow">Cómo emitir bien (cascos, wifi…)</span></button>
          <a class="li" href="/admin">${icon('settings')} <span class="grow">Administración</span></a>
        </div>

        <div class="h3">Legal</div>
        <div class="group">
          <a class="li" href="/legal/aviso-legal">Aviso legal</a>
          <a class="li" href="/legal/privacidad">Privacidad y almacenamiento</a>
          <a class="li" href="/legal/condiciones">Condiciones de uso</a>
          <a class="li" href="/legal/normas">Normas de la comunidad</a>
        </div>
        <p class="muted tiny center">Radio Porche · condiciones v${LEGAL.TERMS_VERSION} · solo mayores de 18 · sin cookies de seguimiento</p>
      </div>
    </section>`);

  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'login': if (await requireIdentity()) go('/perfil', { replace: true }); break;
      case 'recover': if (await recoverSheet()) go('/perfil', { replace: true }); break;
      case 'link': linkDeviceSheet(); break;
      case 'rename': {
        const n = await promptSheet('Tu nombre', { value: session.name, max: 30 });
        if (!n) return;
        try { const r = await api('/api/me/name', { method: 'POST', body: { name: n } }); session.update({ name: r.name }); go('/perfil', { replace: true }); } catch (err) { toast(err.message, 'bad'); }
        break;
      }
      case 'recovery':
        await copy(recoveryLink(), 'Enlace copiado. Guárdalo en un sitio seguro: quien lo tenga controla tu porche.');
        break;
      case 'export': {
        toast('Preparando la copia…');
        try {
          await requestPersist();
          const blob = await exportBackup();
          const file = new File([blob], `radio-porche-copia-${new Date().toISOString().slice(0, 10)}.rpbk`, { type: 'application/octet-stream' });
          if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Copia de Radio Porche' }); break; } catch (err) { if (err.name === 'AbortError') break; } }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 30000);
          toast(`Copia lista (${fmtBytes(blob.size)})`, 'good');
        } catch (err) { toast('No se ha podido crear la copia', 'bad'); }
        break;
      }
      case 'mydata': {
        try {
          const d = await api('/api/me/export');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
          a.download = 'mis-datos-radio-porche.json'; document.body.appendChild(a); a.click(); a.remove();
        } catch (err) { toast(err.message, 'bad'); }
        break;
      }
      case 'unblock': unblockAll(); toast('Has desbloqueado a todos'); go('/perfil', { replace: true }); break;
      case 'wipe': {
        if (!(await confirmSheet('¿Borrar todos tus datos?', 'Se borran del servidor tus podcasts publicados, tu porche y tu identidad (los reportes quedan anonimizados), y de este móvil tus borradores, sonidos y ajustes. No se puede deshacer.', { ok: 'Borrar todo', danger: true }))) return;
        try {
          if (session.token) await api('/api/me/delete', { method: 'POST', body: {} });
          live.disconnect();
          await wipeLocal();
          session.clear();
          toast('Todos tus datos se han borrado');
          go('/', { replace: true });
        } catch (err) { toast(err.message, 'bad'); }
        break;
      }
      case 'help': helpSheet(); break;
    }
  });
  const avIn = view.querySelector('[data-act=avatar]');
  if (avIn) avIn.onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const blob = await avatarBlob(f);
      const r = await api('/api/me/avatar', { method: 'POST', raw: blob });
      session.update({ avatar: r.avatar });
      toast(`Foto actualizada (${Math.round(blob.size / 1024)} KB)`, 'good');
      go('/perfil', { replace: true });
    } catch (err) { toast(err.message || 'No se ha podido subir la foto', 'bad'); }
  };
  view.querySelector('[data-act=import]').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await importBackup(f);
      await requestPersist();
      toast(`Copia importada: ${r.count} elementos`, 'good');
      if (r.identity?.token && !session.token) {
        const { useRecoveryToken } = await import('../common.js');
        await useRecoveryToken(r.identity.token);
      }
      go('/perfil', { replace: true });
    } catch (err) { toast(err.message || 'No se ha podido importar', 'bad'); }
  };
}

function helpSheet() {
  sheet(html`
    <h2 class="h2">Cómo emitir bien</h2>
    <p><b>Todos los que hablan, con cascos</b> (de cable o Bluetooth). Así no hay acoples y suena a radio de verdad.</p>
    <p><b>Patio</b>: estás junto al presentador. Tu móvil es solo micro y no suena por el altavoz; por los cascos oyes solo la música y los cortes.</p>
    <p><b>Casa</b>: oyes la emisión por cascos (sin tu propia voz), con un pequeño retraso como en una videollamada.</p>
    <p><b>Oírme</b>: escuchas tu voz en tus cascos. Con Bluetooth hay unas décimas de retraso; con cable, no.</p>
    <p><b>Wifi mejor que datos</b>: con datos móviles alguna conexión directa entre móviles puede fallar. Con wifi va casi siempre.</p>
    <p><b>Pantalla encendida</b>: mientras emites, la app mantiene la pantalla encendida. Si bloqueas el móvil o cambias de app, el audio puede cortarse; al volver se reconecta solo.</p>
    <p><b>Capacidad</b>: pensada para unos 15–20 oyentes a la vez por porche.</p>
    <p><b>Programas con vídeo</b>: usa un ordenador con Chrome como estudio y «Compartir pestaña con audio». Tu móvil puede entrar como micro en modo Patio.</p>
    <button class="btn yellow" data-close="">Entendido</button>`);
}
