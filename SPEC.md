# Radio Porche: especificación completa

Documento único de referencia. Todo lo decidido en la fase de diseño está aquí. Quien construya la app debe leerlo entero y seguirlo; las imágenes de `design/` son la referencia visual.

## 1. Qué es

Una red de "radios de barrio". Cada persona tiene su **porche** (su emisora). Puede emitir en directo desde el móvil con amigos, que hablan usando **su propio móvil como micrófono**, estén en el mismo patio o en sus casas. Los oyentes escuchan desde un enlace, comentan en un chat estilo Twitch y pueden pedir micro. Los programas pueden grabarse y publicarse como podcasts.

Inspiración: la radio de barrio de *Do the Right Thing* (Spike Lee): verano, calor, ladrillo, vecinos. Sonido de emisora profesional con espíritu de radio patio. Uso inicial: grupo de amigos, pero preparada para que cualquiera abra su porche.

Principio rector: **sencillez**. Una acción principal por pantalla, nada técnico a la vista, lo avanzado en Ajustes.

## 2. Plataforma y despliegue (decidido, no cambiar)

- **Web app** (PWA instalable en la pantalla de inicio). Sin tiendas de apps por ahora.
- **Cloudflare Workers + Durable Objects con SQLite**, plan gratuito (5 GB de almacenamiento por cuenta). Un solo Worker sirve la web estática, los WebSockets (salas, chat, señalización) y los datos.
- **Sin Supabase, sin SQL manual, sin claves ni variables secretas.** El usuario solo importa el repo en Cloudflare (Workers & Pages → Importar repositorio → Deploy). Cada push a `main` redespliega solo.
- Código en este repo (GitHub de Akalerazzattori).
- Grabaciones guardadas troceadas en SQLite de Durable Objects (filas ≤ 2 MB). Voz comprimida: ~30 MB/hora (Opus ~64 kbps mono).
- Al terminar: comprobar que compila (`wrangler deploy --dry-run`). **No hacer capturas ni revisiones visuales** para ahorrar tokens.

## 3. Audio en directo (sin servidor de medios)

- WebRTC **en estrella con centro en el móvil de quien presenta**:
  - Los invitados con micro envían su audio solo al presentador.
  - El presentador mezcla en Web Audio: micros + cortes + música, y envía **una sola mezcla** a cada oyente.
- Señalización por WebSocket en el Durable Object de la sala. STUN público de Google. Capacidad orientativa: ~15–20 oyentes.
- Invitados en dos modos, elegidos al entrar al micro:
  - **Patio**: está junto al presentador. Su móvil es solo micro y **no reproduce la emisión** (evita acoples).
  - **Casa**: oye la emisión; se le pide usar **cascos**.
- **Wake Lock**: mientras se emite (presentador o invitado con micro), la pantalla no se apaga. Si el móvil se bloquea o se cambia de app: aviso grande y **reconexión automática** al volver.
- Calidad adaptable a la conexión. Aviso si se detecta acople.
- Limitaciones a comunicar con honestidad en la UI o ayuda: en datos móviles alguna conexión directa puede fallar; con wifi va casi siempre.

## 3b. Escucha con cascos (retorno) y acoples

Como en una radio real: **todo el que habla lleva cascos** (cable o Bluetooth). La UI lo pide al entrar al micro.
- **Presentador**: oye en sus cascos la mezcla local (cortes y música sin retraso, porque la mezcla está en su móvil) + las voces de los invitados.
- **Invitado en casa**: recibe la mezcla del presentador **menos su propia voz** (mix-minus: el presentador genera una mezcla por invitado sin su voz). Retraso tipo videollamada.
- **Invitado en el patio**: las voces las oye en directo en la sala, así que por sus cascos recibe **solo música y cortes** (sin voces, para no oírlas dos veces). Su móvil no reproduce nada por el altavoz.
- **"Oírme"** (todos: presentador e invitados): botón para oír tu propia voz en tus cascos, monitorizada en local (micro → cascos en el mismo móvil, sin pasar por la red). **Apagado por defecto** (con Bluetooth el retraso de unas décimas molesta). Nota en la UI: "Con cascos de cable suena sin retraso".
- Como todos llevan cascos: desactivar `echoCancellation` del navegador (mejor calidad de voz y música); mantener supresión de ruido en "Mejorada". Si alguien entra sin cascos, reactivar la cancelación de eco para esa persona.
- Oyentes: 1–3 s de retraso, sin importancia.

## 3c. Mesa de mezclas del presentador

- **Deslizadores de volumen en antena**: Música, Cortes y cada micro. Grandes y cómodos con el pulgar.
- Botones rápidos con fundido suave (~1,5 s): **Subir música** / **Bajar música** (a nivel de fondo).
- **Ducking automático** (interruptor, activado por defecto): la música baja sola cuando alguien habla y vuelve al callar. Si se mueve el deslizador a mano, manda el manual.
- **Silenciarme** (un toque) y **Solo música**: silencia todos los micros y sube la música; al quitarlo, la música vuelve a fondo y los micros se abren.
- **Pre-escucha** (cue): oír un corte o una canción solo en tus cascos antes de lanzarlo al aire (icono de cascos en cada cassette, o mantener pulsado).
- **Efectos y música son dos zonas distintas** en la cabina: **Efectos/cortes** = cassettes de un disparo, cortos, pueden sonar varios y encima de la música; **Música de fondo** = una pista a la vez, en bucle opcional, con su deslizador. Cada cassette lleva escrito en su etiqueta el **nombre del audio y su duración**; se pueden agrupar por sección del programa (p. ej. "¿Pero usted quién es?").

## 3d. Fuentes de audio externas (noticias, vídeos)

- Cortes y música aceptan **MP3/audio y también vídeo (MP4/MOV)**: la app extrae el audio en el navegador. Así se puede grabar la pantalla del móvil con el vídeo y subirlo como corte.
- **"Compartir pestaña con audio"** (solo presentador desde ordenador con Chrome, `getDisplayMedia` con audio): el sonido de una pestaña (p. ej. un vídeo de YouTube que se está comentando) entra en la mezcla con su propio deslizador. En móvil no existe esta opción; ocultarla.
- No descargar de URLs de YouTube. Aviso breve sobre derechos (cita breve para comentar ≠ emitir contenido completo).

## 3e. Un solo estudio por programa

- El **estudio** es el único dispositivo que mezcla y emite (móvil u ordenador). Para programas con vídeo/pestaña con audio, el estudio es el ordenador con Chrome.
- Si el anfitrión abre su sala desde otro dispositivo mientras está en el aire, preguntar: "Ya estás emitiendo desde otro dispositivo. ¿Pasar el estudio a este?". Si acepta, el anterior pasa a oyente (silenciado). Nunca dos estudios a la vez.
- El móvil del anfitrión puede entrar a su propia sala como **invitado en modo Patio** (solo micro) mientras el ordenador es el estudio.
- Audio de "Compartir pestaña": no enviarlo a los cascos de invitados en modo Patio (ya lo oyen en directo en la tele). Sí a invitados en modo Casa.

## 4. Voz

Procesado en el propio móvil antes de enviar.
- **Mejorada** (por defecto): locución limpia de radio profesional (supresión de ruido del navegador, filtro paso alto, compresor, EQ de presencia, de-esser suave).
- **Efectos ▾** (desplegable, nombres de una palabra): **Pitufo** (agudo), **Robot** (metálico), **Walkie** (radio vieja), **Burbuja** (bajo el agua), **Gigante** (grave), **Eco** (cueva).

## 5. Pantallas (4 pestañas + botón central)

Barra inferior: **En el aire · Archivo · [botón central rojo: Mi porche / salir al aire] · Avisos · Perfil**.

### 5.1 En el aire (inicio)
- Contadores: **porches en directo** y **podcasts grabados**.
- Emisora sintonizada en grande: portada, frecuencia y nombre ("96.4 · PORCHE DE LUCÍA"), título del programa, oyentes, micros, botón **Escuchar**.
- **Dial de radio** horizontal (88–108) deslizable con el dedo: inercia, se engancha en cada emisora, vibración en cada paso (Android). Cada porche tiene su frecuencia fija. Muy fluido.
- Con poca gente en directo, el dial muestra también **porches apagados** con su próximo programa ("Vuelve el jueves, 22:00") y botón **Avísame**. Nunca debe verse vacío.

### 5.2 Camerino (antes de salir al aire)
- Estado arriba: "Aún no estás en el aire · N personas esperan". Quien abre un porche antes de que empiece ve "Empieza en breve" y recibe aviso al empezar. Una vez en el aire, cualquiera entra a escuchar sin pedir permiso (salvo Ensayo).
- Prueba de micro con medidor y voz **Mejorada / Efectos ▾**.
- **¿Cómo sales?** tres modos:
  - **Ensayo**: privado, solo invitados, no se graba.
  - **Solo directo**: público, no se graba nada.
  - **Directo + grabación**: público, se graba en Borradores.
- Cortes cargados (cassettes) y "Contigo en el camerino" (invitados con su modo Patio/Casa) + **Invitar** (enlace).
- Botón grande **"Mantén para salir"**: cuenta atrás 3-2-1 con sintonía. Nunca se sale al aire con un toque accidental.
- Texto: "Quien entre al micro verá que se está grabando".

### 5.3 Cabina (en directo, presentador)
- Indicadores separados y siempre visibles: **EN EL AIRE** y **REC**.
- Tiempo en antena.
- Voces en antena: nombre, chip Patio/Casa, medidor, botón de micro (silenciar).
- Peticiones de micro: "Marta pide micro · desde casa" → **Dar paso**. Expulsar/silenciar.
- **Botonera de cortes** (cassettes de colores) que se disparan con un toque, con progreso.
- **Modo música**: interruptor; la música baja sola cuando alguien habla (ducking) y los micros se pueden silenciar.
- Pausa / Fin de emisión.

### 5.4 Oyente
- Portada grande con título y fecha, "EN DIRECTO", oyentes conectados (avatares), onda animada.
- **Chat** en directo con mensajes de sistema ("Pepe se ha unido"), mensaje fijado del presentador, reacciones rápidas.
- **Pedir micro** (rojo) junto al campo de texto.

### 5.5 Archivo
- Podcasts publicados: más escuchados, nuevos, búsqueda.
- Ranking por **escuchas reales** (más de 1 minuto), no solo por me gusta.
- Cada episodio: portada, título, porche, fecha, duración, progreso de escucha.

### 5.6 Reproductor
- Portada, título, porche, me gusta (contador).
- Línea de tiempo con **capítulos** y **comentarios clavados en el minuto exacto** (marcadores de colores que aparecen al escucharlo).
- Velocidad (1×, 1,2×, 1,5×, 2×), −15 s / +30 s, play/pausa, temporizador para dormir.
- Clip (fase futura, dejar el botón preparado), comentarios, descargar, enviar.
- Retomar donde se dejó. Controles en la pantalla bloqueada (Media Session API).

### 5.7 Mi porche / Borradores
- Lo grabado va a **Borradores** (privado). Recorte rápido de inicio y final, portada y título, **Publicar** o **Borrar**.
- Si dura menos de 5 min se sugiere descartar. Los borradores se borran solos a los **7 días**.
- **Portada**: foto con la cámara o subida; la app pone encima título y fecha con el estilo de la marca. Si no hay foto, una de las 4 escenas por defecto (`design/scenes/`).
- Biblioteca de cortes: **subir MP3** o **grabar con el móvil** y recortar. (No importar desde URLs de YouTube.)
- Música: archivos propios del usuario.

### 5.8 Perfil y Avisos
- Entrar **solo con un nombre** (sin email ni contraseña). Identidad guardada en el dispositivo; el porche pertenece a ese dispositivo (con enlace de recuperación).
- Seguir porches; avisos de "X está en directo" y de programas anunciados.
- Ajustes: aquí va lo avanzado.

## 6. Comunidad y moderación (automoderada)

- Cada porche se modera solo: el presentador silencia, expulsa y nombra moderadores.
- **Reportar** y **bloquear** a un toque. Varios reportes ocultan el contenido automáticamente hasta revisión.
- Filtro de insultos y spam en el chat.
- Aviso claro de grabación a todo el que entre al micro.
- Edad: 18+ (indicarlo al entrar).

## 7. Música y derechos

- El modo música usa archivos propios. Aviso breve: las canciones comerciales en podcasts publicados pueden tener problemas de derechos.

## 8. Diseño visual

- Referencias en `design/`: `radio-porche-v3.png` (pantallas En el aire, Camerino, Reproductor), `radio-porche-v1.png` (Cabina, Oyente, Archivo), `logo/radio-porche-logo-final.png` (logo definitivo: usar tal cual, no redibujar), `scenes/` (4 portadas por defecto), `cassettes/` (cortes), `icon.png`.
- Paleta: rojo `#e8321e`, naranja `#f47a1f`, amarillo sol `#ffc72c`, turquesa `#1fb5a8`, crema `#fbeee0`, casi negro `#120d0c`; paneles `#1f1716`, líneas `#3a2a26`, texto apagado `#b8a196`.
- Tema oscuro casi negro con acentos cálidos. Tipografías: **Anton** (títulos en mayúsculas), **Archivo** (texto), **Space Mono** (tiempos y frecuencias).
- Botones grandes (mín. 44 px), mucho contraste, una sola acción principal por pantalla.
- Movimiento: dial con inercia y "clic" por emisora; luz ON AIR con resplandor rojo.

## 9. Fuera de alcance por ahora

App de tiendas (requiere cuenta de desarrollador de Apple), publicación en Spotify/Apple Podcasts vía RSS, clips de vídeo para redes, transcripción con IA, servidor de audio para audiencias grandes.
