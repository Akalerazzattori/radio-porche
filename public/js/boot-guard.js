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
    v.innerHTML = '<div style="padding:24px;font:16px system-ui;color:#f4ead5;line-height:1.4">' +
      '<h2 style="margin:0 0 8px">Radio Porche no ha terminado de cargar</h2>' +
      '<p>Prueba a recargar. Si sigue igual, haz captura de esto y mándala:</p>' +
      '<pre style="white-space:pre-wrap;font:12px monospace;opacity:.8">' + (errs.join('\n') || 'Sin errores: se ha quedado esperando.') + '\n' + navigator.userAgent + '</pre>' +
      '<button style="font:700 16px system-ui;padding:12px 18px;border-radius:12px;border:0;background:#f5c518">Recargar</button></div>';
    v.querySelector('button').onclick = function () { location.reload(); };
  }
  setTimeout(check, 7000);
})();
