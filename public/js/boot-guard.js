// Chivato de arranque (script clásico, sin módulos): si la app no llega a pintarse
// en unos segundos o falla al cargar, en vez de una pantalla negra enseña qué ha pasado
// y un botón para recargar. Así un fallo en un móvil concreto se puede contar.
(function () {
  var errs = [];
  function note(m) { if (m && errs.length < 4) errs.push(String(m).slice(0, 220)); }
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) note('No carga: ' + (t.src || t.href));
    else note(e.message + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) { note(e.reason && (e.reason.message || e.reason)); });
  function check() {
    var v = document.getElementById('view');
    if (!v || v.querySelector('section, div')) return; // (el <noscript> no cuenta)
    // Sin estilos en línea (la seguridad de la página los bloquea): solo clases de app.css
    // y, por si el CSS tampoco ha cargado, colores puestos desde JS.
    var box = document.createElement('section');
    box.className = 'screen';
    box.innerHTML = '<h1 class="h1">No ha cargado</h1><p>Toca «Reparar». Si sigue igual, haz captura de esta pantalla y mándala.</p><p class="muted tiny"></p><button class="btn yellow big">Reparar</button>';
    box.querySelector('.tiny').textContent = (errs.join(' · ') || 'Sin errores: se ha quedado esperando.') + ' · ' + navigator.userAgent;
    box.style.color = '#f4ead5'; box.style.padding = '24px';
    box.querySelector('button').onclick = function () {
      // Borra la copia guardada de la app (no tus datos: porche, grabaciones y sesión se quedan)
      var jobs = [];
      try { if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })); } catch (e) {}
      try { if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })); } catch (e) {}
      Promise.all(jobs).then(function () { location.reload(); }, function () { location.reload(); });
    };
    v.innerHTML = ''; v.appendChild(box);
    document.body.style.background = '#1a1210';
  }
  setTimeout(check, 7000);
})();
