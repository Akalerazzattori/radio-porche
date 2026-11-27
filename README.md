# Radio Porche

Red de radios de barrio: cada persona abre su **porche** y emite en directo desde el móvil con sus amigos (cada uno usa su móvil como micro). Los oyentes escuchan desde un enlace, comentan en el chat y piden micro. Los programas se graban y se publican como podcasts.

- Web app instalable (PWA), sin tiendas.
- **Un solo Cloudflare Worker** + **Durable Objects con SQLite** (plan gratuito). Sin Supabase, sin SQL manual, sin claves obligatorias.
- Audio en directo por WebRTC en estrella (el móvil del presentador mezcla y emite). Señalización por WebSocket.

La especificación completa está en [`SPEC.md`](SPEC.md) y los diseños en [`design/`](design/).

---

## Desplegar en Cloudflare (como Worker, NO como Pages)

1. Entra en el panel de Cloudflare → **Workers & Pages**.
2. Pulsa **Create application** (Crear aplicación).
3. En la pestaña **Workers**, elige **Import a repository** (Importar un repositorio).
   ⚠️ No uses el asistente de **Pages**: este proyecto es un Worker con recursos estáticos y Durable Objects.
4. Elige tu cuenta de GitHub y el repositorio **radio-porche**.
5. En la configuración:
   - Project name: `radio-porche` (debe coincidir con `name` en `wrangler.jsonc`).
   - Build command: déjalo **vacío**.
   - Deploy command: `npx wrangler deploy` (es el que viene por defecto).
   - Root directory: `/` (raíz).
6. Pulsa **Deploy**. Cloudflare lee `wrangler.jsonc`, crea los Durable Objects (`Hub` y `Room`, con SQLite) y publica la web.
7. Al terminar verás la dirección `https://radio-porche.<tu-subdominio>.workers.dev`.

Cada `git push` a `main` vuelve a desplegar solo.

### Primer paso después de desplegar: reclama el panel de administración

Abre `https://…workers.dev/admin` y pulsa **Reclamar panel**. Te dará un **enlace secreto** (`/admin#k=…`). Guárdalo: es la única forma de entrar. Hazlo nada más desplegar (el primero que lo reclama se queda el panel). Desde el panel puedes regenerarlo.

> Alternativa: crea un *secret* llamado `ADMIN_KEY` en el Worker (Settings → Variables and Secrets → Add → tipo *Secret*). Esa clave siempre funciona y bloquea el "reclamar".

### Opcional: Cloudflare Turnstile (anti-bots)

La app funciona sin esto. Si quieres activarlo:

1. Cloudflare → **Turnstile** → Add widget → dominio de tu Worker → copia la *Site key* y la *Secret key*.
2. En `wrangler.jsonc`, pon la *Site key* en `vars.TURNSTILE_SITEKEY` y haz push.
3. En el Worker → Settings → Variables and Secrets → **Add** → tipo **Secret**, nombre `TURNSTILE_SECRET`, valor la *Secret key*.

Se pide al crear la identidad y al publicar.

---

## Hacer cambios sin gastar mucho

Todo está pensado para tocar **un solo archivo** en la mayoría de los casos:

| Quiero cambiar… | Dónde |
|---|---|
| Textos legales: titular, NIF, correo, domicilio | `public/js/config.js` → `LEGAL` |
| Que se vuelvan a aceptar las condiciones | sube `LEGAL.TERMS_VERSION` en `config.js` |
| Límites (40 min por parte, 5 min mínimo, chat, salas, espacio…) | `public/js/config.js` → `LIMITS` |
| Cupo de publicaciones (premium futuro) | `LIMITS.MAX_PUBLICADOS` (ahora `null` = sin cupo) |
| Nombres de efectos de voz, modos, motivos de reporte | `public/js/config.js` |
| Lista de insultos del filtro | Panel admin → Ajustes (sin tocar código) |
| Colores y tipografías | `public/css/app.css` (variables al principio) |
| Textos legales completos | `public/js/screens/legal.js` |

No hay paso de compilación: los archivos de `public/` se sirven tal cual. Editar en GitHub y hacer *commit* basta para redesplegar.

### Sonidos "de serie" (para todos)

En la cabina hay **tres zonas**, cada una con **De serie** (para todos) y **Mías** (en el móvil de cada uno):

- **Efectos**: cortos, de un toque, pueden sonar varios a la vez encima de la música.
- **Música de fondo**: una pista a la vez, en bucle, baja sola cuando alguien habla.
- **Canciones**: temas completos que suenan una vez (aviso de derechos al publicar).

Hay dos formas de añadir sonidos de serie:

1. **Desde el panel admin** (lo más cómodo, sin redesplegar): Admin → Biblioteca → elige zona, nombre y sección, sube el MP3. Se guarda en el Durable Object y aparece al momento para todos.
2. **En el repo**: copia el archivo en `public/library/` y añade una línea en `public/library/manifest.json`:
   ```json
   { "id": "aplausos-2", "zone": "fx", "name": "Aplausos fuertes", "file": "/library/aplausos-2.mp3", "duration": 4.2, "section": "" }
   ```
   `zone` es `fx` (efectos), `bg` (música de fondo) o `song` (canciones). `section` agrupa los cassettes (p. ej. "¿Pero usted quién es?").

Los 11 sonidos incluidos están **sintetizados** para el proyecto (libres de derechos): cámbialos por los que quieras.

Cada persona añade los suyos en **Mi porche → Sonidos** (MP3/audio o vídeo MP4/MOV, del que se extrae el audio en el móvil; o grabando con el micro). Se guardan solo en su móvil.

---

## Qué se guarda dónde

- **En el móvil (IndexedDB)**: borradores (se borran a los 7 días), podcasts privados, sonidos propios y ajustes. **Exportar copia / Importar copia** en Perfil para cambiar de móvil.
- **En el servidor (Durable Objects SQLite, troceado en filas < 2 MB)**: solo los podcasts publicados con su portada y datos, la biblioteca de serie subida desde el panel, identidades, comentarios, me gusta, escuchas, reportes y contadores temporales.

## Seguridad (resumen)

Identidad sin cuentas con token HMAC firmado por el servidor (el secreto se genera solo dentro del Durable Object). Límites por dispositivo y por IP en el servidor, límite global de emergencia y pausas desde el panel. Validación por lista blanca, tipo de archivo por cabecera, duración real del audio comprobada en el servidor. Cabeceras CSP estrictas (sin `unsafe-inline`), HSTS, nosniff, Permissions-Policy. Fuentes alojadas en el propio Worker. Reportes con ocultación automática, bloqueo, moderadores con enlace secreto y panel de administración con registro de acciones.

## Probar en local

```bash
npm install
npm run dev          # http://localhost:8787
npm run check        # comprueba que compila (wrangler deploy --dry-run)
```

## Antes de abrir al público

⚖️ **Revisa los textos legales con un abogado** (Aviso legal, Privacidad, Condiciones, Normas) y rellena `[TITULAR]`, `[NIF]`, `[CORREO]` y `[DOMICILIO]` en `public/js/config.js`.

## Limitaciones conocidas

- Pensado para ~15–20 oyentes por porche (sin servidor de medios).
- Con datos móviles alguna conexión directa puede fallar; con wifi va casi siempre (solo STUN, sin TURN).
- Si el presentador bloquea el móvil o cambia de app, el navegador puede cortar el audio; al volver se reconecta.
- Los avisos funcionan con la app abierta (no hay notificaciones push con la app cerrada todavía).
