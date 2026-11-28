# Radio Porche — traspaso de contexto (28-11-2026)

Documento para continuar el trabajo en una conversación nueva sin perder nada. Léelo entero antes de tocar código.

## Cómo trabajar con Marc (el dueño)
- Responder **siempre en castellano**, claro y sencillo, pensando en móvil. Marc no es programador.
- **No hacer capturas ni revisiones visuales** (ahorro de tokens). Comprobar con: `node --check`, `npx esbuild public/js/app.js --bundle --format=esm --outfile=/tmp/b.js`, `npx esbuild public/css/app.css --outfile=/tmp/a.css`, `npx wrangler deploy --dry-run`, y pruebas locales con `npx wrangler dev --port 8799 --local` + curl / WebSocket (node 22 tiene WebSocket global).
- A Marc le gusta **hablar antes de cambios grandes**; los fallos claros se arreglan directamente.
- Al terminar: resumen corto de qué cambia para él, sin detalles técnicos.
- Cada cambio: subir `CACHE` en `public/sw.js` (rp-vNN), commit en `main` y push (Cloudflare Workers Builds despliega solo). Comprobar despliegue: `gh api repos/Akalerazzattori/radio-porche/commits/<sha>/check-runs`.
- Los commits terminan con las líneas de atribución que indique el sistema.
- Secretos: el enlace de admin (`/admin#k=…`) y el de recuperación de Marc **no van en el repo**. Si Marc pierde el de admin: secreto `ADMIN_KEY` en Cloudflare (Workers → radio-porche → Variables y secretos) y abrir `/admin#k=<valor>`.

## Qué es
Red de radios de barrio: cada persona tiene su «porche», emite en directo desde el móvil (o el ordenador) con amigos; oyentes con chat; pedir micro; programas grabados que se publican como podcasts. URL: https://radio-porche.marcfont1991.workers.dev · Repo: Akalerazzattori/radio-porche · Datos legales en `public/js/config.js` (Marc Font, NIF 38884935P, phawna.info@gmail.com, Escoles 51, 08380). Solo mayores de 18.

## Arquitectura
- **Cloudflare Worker + static assets** (`wrangler.jsonc`, `run_worker_first`), sin Pages ni Supabase. Bindings: `HUB`, `ROOM`, `LOCKER` (Durable Objects SQLite; migraciones v1 Hub/Room, v2 Locker), `CF_VERSION_METADATA` (la app se recarga sola con versión nueva, nunca en directo).
- `src/worker.js`: router, cabeceras/CSP (permite Turnstile y Google GSI; COOP same-origin-allow-popups), `/api/*` → Hub, `/api/cloud/*` → Locker del usuario (auth vía Hub `/internal/whoami`), `/api/share/:dev/:key` público, vistas previas SEO (`/p/:id`, `/porche/:slug`, `/programa/:id`, `/escucha/:dev/:key` con noindex), `/api/version`.
- `src/hub.js` (único, `idFromName('main')`): identidades (token HMAC), porches, programas, podcasts (audio nuevo en el Locker del dueño: columna `store='lk'`; antiguos en el Hub), comentarios, likes, reportes, admin, biblioteca, categorías, **Google** (`google_links` con hash del `sub`, `/api/google/login|link|unlink`, ID de cliente en Admin → Ajustes, guardado en kv `googleClientId`), vecinos (avatar < 0 = vecino nº −avatar), portada editable de episodios (`/api/podcasts/:id/cover`, `cover_v`), clips (meta.clipOf: 20 s–10 min).
- `src/room.js` (uno por porche): WebSocket hibernation, señalización WebRTC en estrella, chat, micros, moderación, estudio multi-aparato (`promote`, `handoff`, relevo, `vis` = aparato a la vista antes del directo), `gfx` (invitado pide efecto de serie, 1 cada 1,5 s), pausa con `pausedAt/pausedTotal` (el reloj descuenta pausas).
- `src/locker.js` (uno por identidad): **buzón de paso** entre tus aparatos (rec/snd/del; se borra al recogerlo; límites 3 h / 50 MB en config), preferencias (favoritos), audio de podcasts publicados (`/internal/pod`), **enlaces privados** para amigos (`shr_*`, 30 días, portada propia).
- Cliente `public/js/`: `app.js` (router, mini reproductor con ✕, recarga por versión, buzón, prefs, copia de identidad en IndexedDB), `live.js` (sesión de directo, mezcla, grabación por partes de 40 min **con copia cada 30 s y que nunca se tira al cambiar de aparato**, relevo, eco), `audio/` (mixer con medidores por bus y «Protege las voces» que baja música y sonidos largos; voice con 15 voces de personaje + igualador de volumen; sounds con normalización de volumen y recorte de silencios), `cabina-ctl.js` (mando local/remoto, pre-escucha, `cueSource`), `inbox.js` (buzón y prefs), `google.js`, `screenshare.js` (compartir pantalla/pestaña con PREPARADO/AL AIRE, desde estudio, otro aparato tuyo o invitado; solo Chrome de ordenador), `screens/` (porch = Estudio/oyente, myporch, editor, player, listen = escucha privada, profile, admin, onair, archive, program, legal).
- Imágenes: 20 escenas `public/img/scenes/escena-N.webp|jpg`, 12 vecinos `public/img/vecinos/vecino-N.webp`, icono de app nuevo `icon2-*` (la pestaña usa `favicon-v1.png`). Biblioteca de serie: `public/library/manifest.json` (efectos sintetizados; los aplausos se quitaron por sonar mal).

## Decisiones de producto tomadas
- Vocabulario: todo es **Estudio**; el aparato puede ser micro / escuchar / emitir. Antes del directo emite el aparato que tienes delante (si ambos, el ordenador). En pausa no hay relevo.
- Móvil = casa; ordenador = apoyo. Grabaciones viven en el aparato que graba; lo grabado en el ordenador llega solo al móvil; botón «Ordenador/Móvil» para pasar una grabación; al publicar en uno se quita del otro. **No** guardamos las grabaciones de todos en la nube (salvo enlace privado 30 días y buzón de paso).
- Grabaciones nunca se borran solas (`DRAFT_DAYS: null`). Publicar exige 5 min (clips 20 s).
- Fila de grabación: lápiz junto al título; botones Borrar · Ordenador · Recortar · Compartir (privado) · **Publicar** (grande, rojo, a la derecha).
- Botonera: Favoritos ⭐ (en la cuenta), pestañas Cortinillas/Efectos/Música, carpetas = secciones, lupa, color por tipo y duración en cada sonido. **Pre-escucha = botón de cascos de cada sonido** (otra vez = parar; sin interruptor general, Marc lo pidió así); franja violeta con «Parar» mientras suena solo para ti. Invitados: botón «Efectos» (serie, mismos cascos) si el anfitrión lo permite (Mesa → «Los invitados pueden lanzar efectos»). Invitados solo se silencian a sí mismos.
- Mesa: tira por línea (tus micros como «Tú · móvil/ordenador», invitados, Música, Cortinillas y efectos, Pestaña), medidor, deslizador vertical con **normal en el medio**, botón de silencio en **todas** las tiras (micros y líneas). La mesa siempre enseña lo que suena: «Música alta/de fondo», «Solo música» y los silencios mueven tiras y botones. «Solo música» silencia todos los micros. El invitado ve siempre «EN ANTENA» / «NO ESTÁS EN ANTENA» con el motivo (silenciado, micro cortado, solo música, pausa).
- Pausa: corta la salida, para la música donde iba (sigue desde ahí al reanudar) y corta efectos.
- Voz de personaje: es por aparato. El micro tiene una puerta que baja la voz lejana (dos personas en la misma habitación se cuelan en el micro del otro).
- Mi porche → Programas: «Nuevo capítulo» abre el Estudio con ese programa elegido.
- Publicar: si falla, el motivo sale en una hoja fija con «Probar otra vez» (antes era un aviso de 3 s y parecía un bucle).
- Invitados eligen «Estoy a su lado» / «Estoy en otro sitio» (antes Patio/Casa).
- Portada de episodio: foto del programa + «PROGRAMA · EPISODIO N» + título del episodio.
- Logo: se mantiene el actual en la cabecera (cabecera común `brandHead` en common.js). El icono de la app es el de la torre y el barrio.

## Pendiente / por verificar con Marc
1. **Entrar con Google**: ya funciona (28‑nov el cordobés unió su usuario). Queda comprobar que la app está «En producción» en Google Cloud. ID `319749056185-fb23eiek427qih4guvsm649d3of53pjd.apps.googleusercontent.com`; debe pegarlo en Admin → Ajustes (su enlace de admin le daba «no válida»: usar el secreto `ADMIN_KEY` si hace falta) y publicar la app en Google Cloud («Público» → En producción). Luego Perfil → unir con Google.
2. Probar en real (prueba 28‑nov hecha: arreglados publicar, pausa, voces, mesa, pre-escucha): grabación con pausa/bloqueo/relevo, compartir pantalla, efectos de invitados, pre-escucha, mesa sincronizada, enlace privado con portada en WhatsApp.
3. Revisar efectos sintetizados (timbre, puerta, pasos, teléfono…) y sustituir los malos; Marc subirá risas/aplausos reales (Pixabay, Freesound CC0) en Admin → Biblioteca por carpetas.
4. Ideas aparcadas: podcasts por cercanía, más oyentes (repetidor de pago), TURN, notificaciones push, premium, más hojas de ilustraciones/vecinos.
5. Límites conocidos: ~15–20 oyentes y 8 micros; avisos solo con la app abierta; con datos móviles alguna conexión puede fallar; en iPhone la app instalada no comparte datos con Safari.
