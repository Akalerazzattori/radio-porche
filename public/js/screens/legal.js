// Textos legales (borrador en lenguaje claro). Revisar con un abogado antes de abrir al público.
// Los datos [TITULAR], [NIF], [CORREO] y [DOMICILIO] se cambian en js/config.js.
import { LEGAL, LIMITS, APP } from '../config.js';
import { html, raw, icon, mount } from '../util.js';

const T = LEGAL.TITULAR, NIF = LEGAL.NIF, MAIL = LEGAL.CORREO, DOM = LEGAL.DOMICILIO;

export const DOCS = {
  'aviso-legal': {
    title: 'Aviso legal',
    body: `
<h3>Quién está detrás</h3>
<p>Este sitio y la aplicación ${APP.name} (en adelante, "el servicio") son de <b>${T}</b>, con NIF <b>${NIF}</b> y domicilio en ${DOM}. Puedes escribirnos a <b>${MAIL}</b>.</p>
<p>Lo publicamos en cumplimiento de la Ley 34/2002, de Servicios de la Sociedad de la Información y de Comercio Electrónico (LSSI).</p>
<h3>Para qué sirve</h3>
<p>${APP.name} es una red de radios de barrio: cada persona abre su "porche", emite en directo desde el móvil con sus amigos, y los programas pueden grabarse y publicarse como podcasts.</p>
<h3>Propiedad intelectual</h3>
<p>El contenido (voces, programas, portadas, comentarios) es de quien lo crea. Al publicarlo nos das permiso, gratuito y no exclusivo, para alojarlo y mostrarlo dentro del servicio mientras siga publicado. Puedes retirarlo cuando quieras.</p>
<p>El nombre, el logo y el diseño de ${APP.name} son de ${T}. No los uses sin permiso.</p>
<h3>Contenidos ilícitos</h3>
<p>Si ves algo ilegal o que vulnera derechos, usa el botón <b>Reportar</b> que hay en cada programa, comentario y mensaje, o escribe a <b>${MAIL}</b> indicando qué es y dónde está. Actuaremos con diligencia en cuanto tengamos conocimiento efectivo.</p>
<h3>Responsabilidad</h3>
<p>Cada persona responde de lo que dice y publica. Nosotros alojamos el contenido y lo retiramos cuando sabemos que es ilícito.</p>`,
  },
  privacidad: {
    title: 'Política de privacidad',
    body: `
<h3>Quién trata tus datos</h3>
<p><b>${T}</b> (NIF ${NIF}), contacto: <b>${MAIL}</b>.</p>
<h3>Qué datos</h3>
<ul>
<li><b>Nombre</b> que eliges al entrar (no pedimos email ni contraseña).</li>
<li><b>Identificador de dispositivo</b> aleatorio y un token firmado para saber que eres tú.</li>
<li>Lo que <b>publicas</b>: podcasts, portadas, títulos, descripciones, comentarios y me gusta.</li>
<li><b>Reportes</b> que haces o recibes.</li>
<li><b>Dirección IP</b>, solo de forma temporal en contadores contra el abuso (ventanas de minutos u horas, sin histórico).</li>
</ul>
<h3>Para qué y con qué base legal</h3>
<ul>
<li>Prestarte el servicio (emitir, escuchar, publicar): ejecución de las condiciones que aceptas.</li>
<li>Seguridad, límites contra el spam y moderación: interés legítimo en mantener el servicio seguro.</li>
<li>Atender reportes y requerimientos legales: obligación legal.</li>
</ul>
<h3>Cuánto tiempo</h3>
<ul>
<li>Lo publicado: mientras no lo borres tú (o se retire por incumplir las normas).</li>
<li>Tu identidad: hasta que pulses "Borrar todos mis datos".</li>
<li>Contadores con IP: minutos u horas.</li>
<li>El chat del directo no se guarda: desaparece al cerrar la sala.</li>
<li>Los reportes se conservan anonimizados si borras tu cuenta.</li>
</ul>
<h3>Con quién</h3>
<p>Usamos <b>Cloudflare</b> como encargado del tratamiento para alojar la web y los datos. El audio en directo viaja directamente entre móviles (WebRTC) y usa servidores STUN públicos de Google solo para establecer la conexión. No vendemos ni cedemos tus datos.</p>
<h3>Tus derechos</h3>
<p>Puedes acceder, rectificar, suprimir, oponerte, limitar y portar tus datos. Desde <b>Perfil</b> tienes "Descargar mis datos" y "Borrar todos mis datos". Para lo demás, escribe a <b>${MAIL}</b>. Si no te atendemos bien, puedes reclamar ante la <b>Agencia Española de Protección de Datos</b> (aepd.es).</p>
<h3>Qué se guarda en tu aparato</h3>
<p>Tus <b>grabaciones sin publicar</b>${LIMITS.DRAFT_DAYS ? ` (se borran solas a los ${LIMITS.DRAFT_DAYS} días)` : ''}, tus <b>podcasts privados</b>, los <b>sonidos y música</b> que añadas y tus <b>ajustes</b> se quedan en tu aparato (almacenamiento del navegador) y no se suben salvo que publiques, con una excepción: si usas la app en dos aparatos (móvil y ordenador), lo que pasas de uno a otro (una grabación, tus sonidos propios) viaja cifrado y espera en nuestro servidor <b>solo hasta que el otro aparato lo recoge</b>, y entonces se borra. Tus favoritos de la botonera se guardan en tu cuenta para verlos en todos tus aparatos. Si borras los datos del navegador, se borran. Al cambiar de móvil, usa "Exportar copia" e "Importar copia".</p>
<h3>Cookies y almacenamiento</h3>
<p>No usamos cookies de seguimiento, publicidad ni analítica. Solo guardamos en tu dispositivo lo imprescindible para que funcione (tu identidad, tus ajustes y tus archivos privados). Por eso no te mostramos un banner de cookies.</p>`,
  },
  condiciones: {
    title: 'Condiciones de uso',
    body: `
<h3>Quién puede usarlo</h3>
<p>Solo <b>mayores de 18 años</b>. Al entrar confirmas que lo eres.</p>
<h3>Tu responsabilidad</h3>
<p>Cada persona es responsable de lo que dice en directo, escribe en el chat y publica. Respeta las <b>Normas de la comunidad</b>.</p>
<h3>Grabación y publicación</h3>
<ul>
<li>El presentador elige cómo sale: <b>Ensayo</b> (privado, no se graba), <b>Solo directo</b> (no se graba) o <b>Directo + grabación</b>.</li>
<li>Si se graba, todo el que entra al micro lo ve y debe aceptarlo antes de hablar.</li>
<li>La grabación se guarda en el móvil del presentador como borrador. Solo se sube si decide <b>Publicar</b>.</li>
<li>Cada parte dura como máximo ${LIMITS.MAX_PART_MIN} minutos y hace falta un mínimo de ${LIMITS.MIN_PUBLISH_MIN} minutos para publicar.</li>
</ul>
<h3>Retirada y bloqueo</h3>
<p>Podemos ocultar o retirar contenido que incumpla las normas o la ley, y bloquear dispositivos que abusen. Los contenidos con varios reportes se ocultan automáticamente hasta revisarlos. Puedes escribirnos a <b>${MAIL}</b> si crees que nos hemos equivocado.</p>
<h3>El servicio "tal cual"</h3>
<p>Es un proyecto sencillo y gratuito. Lo ofrecemos tal cual, sin garantía de que esté siempre disponible ni de que el audio llegue perfecto. Podemos cambiarlo o cerrarlo avisando con antelación razonable.</p>
<h3>Cambios</h3>
<p>Si cambiamos estas condiciones te lo pediremos aceptar de nuevo al abrir la app.</p>
<h3>Ley aplicable</h3>
<p>Se rigen por la <b>ley española</b>. Para conflictos, los juzgados que correspondan según la ley (si eres consumidor, los de tu domicilio).</p>`,
  },
  normas: {
    title: 'Normas de la comunidad',
    body: `
<h3>Habla libre, con respeto</h3>
<p>Aquí cabe casi todo: humor, opinión, crítica. Pero no:</p>
<ul>
<li><b>Injurias ni calumnias</b>: no acuses a nadie de delitos ni le insultes.</li>
<li><b>Odio</b>: nada contra personas por su origen, religión, género, orientación, discapacidad…</li>
<li><b>Acoso</b>: no persigas ni humilles a nadie.</li>
<li><b>Datos privados de otros</b> sin su permiso (direcciones, teléfonos, fotos…).</li>
<li><b>Menores</b>: nada que les implique ni les ponga en riesgo.</li>
<li><b>Contenido ilegal</b> de cualquier tipo.</li>
</ul>
<h3>Pide permiso antes de grabar</h3>
<p>Si vas a grabar a alguien, que lo sepa y esté de acuerdo. La app avisa, pero díselo tú también.</p>
<h3>Música y vídeos de otros</h3>
<p>Usa solo <b>fragmentos breves para comentarlos</b>. Emitir canciones o vídeos completos puede vulnerar derechos de autor, sobre todo en los podcasts publicados. La música "de serie" de la app es libre de derechos.</p>
<h3>Cada porche se cuida solo</h3>
<p>El presentador puede silenciar, expulsar y bloquear, y nombrar moderadores. Tú puedes <b>Reportar</b> y <b>Bloquear</b> con un toque.</p>`,
  },
};

export function renderLegal(view, slug, { back }) {
  const d = DOCS[slug] || DOCS['aviso-legal'];
  mount(view, html`
    <section class="screen">
      <div class="top">
        <div><h1 class="h1">${d.title}</h1><div class="sub">Versión ${LEGAL.TERMS_VERSION}</div></div>
        <button class="icon-btn" data-act="back" aria-label="Volver">${icon('close')}</button>
      </div>
      <div class="fill scroll legal-body">${raw(d.body)}
        <p class="muted small mt">Otros textos: ${raw(Object.entries(DOCS).filter(([k]) => k !== slug).map(([k, v]) => `<a href="/legal/${k}">${v.title}</a>`).join(' · '))}</p>
      </div>
    </section>`);
  view.querySelector('[data-act=back]').onclick = back;
}
