# escucharrr — listo para standalone (.exe de Windows) + QA de arquitectura

Revisión estática (4 nov 2026) de qué falta para empaquetar escucharrr como ejecutable de Windows
probable standalone, y hallazgos de arquitectura/seguridad. No sustituye a la QA de UX en vivo (esa
necesita la app corriendo); esto es la parte de **arquitectura**.

## Lo que YA juega a favor

- **Cero dependencias npm.** Solo módulos core: `node:http(s)`, `node:sqlite`, `fs`, `path`, `os`,
  `child_process`. No hay `node_modules`, no hay cadena de suministro que auditar. (Verificado: `require`
  de no-core = 0.)
- **BD autocontenida** (`app/escucharrr.db`, ruta relativa a `app/`), WAL + `busy_timeout`.
- **Escaneo endurecido** contra el flaqueo del share (SMB): diferir+reintentar, detección de caída,
  protección anti-borrado (commit 443e6fd).

## Empaquetado — opciones (node:sqlite exige Node ≥ 22.5; el equipo usa 24.22.1)

`node:sqlite` es un módulo nativo DENTRO del binario de Node, así que el empaquetado debe llevar un Node
moderno. Opciones, de más simple a más integrada:

1. **Node portátil + carpeta + lanzador** (recomendado para la primera prueba standalone). Se mete
   `node.exe` (v24) + el árbol del proyecto en una carpeta y un `escucharrr.exe`/`.cmd` que hace
   `node.exe app\server.js` y abre el navegador en `http://localhost:7733`. Cero build, funciona ya.
   Contras: es una carpeta, no un único fichero.
2. **Node SEA (Single Executable Applications)** — build oficial de Node: inyecta un blob en una copia de
   `node.exe` → un único `.exe`. Como no hay deps npm, el blob es nuestro propio bundle. Hay que:
   (a) agrupar el multi-fichero (app/, data-layer/, engine/, app/public/*) — o bien con la API de
   **assets de SEA** (`sea.getAsset`) sirviendo los estáticos desde el blob, o concatenando el JS de
   servidor en un entry único y embebiendo `public/` como assets; (b) resolver que `node:sqlite` siga
   disponible (lo está: viaja en el `node.exe` base). Es el camino a "un `.exe`".
3. **pkg / nexe**: NO recomendados aquí — su soporte de `node:sqlite` (módulo nativo interno) y de Node 24
   es frágil; además SEA es la vía soportada oficialmente.

### Dependencia externa: **ffmpeg**
`app/server.js` lanza `ffmpeg` (p. ej. transcodificar DSD→FLAC en `/api/stream`) y el motor nativo lo usa.
Un standalone NO puede asumir ffmpeg en el PATH. Opciones: (a) **empaquetar un `ffmpeg.exe` estático**
junto al .exe y pasarle la ruta; (b) degradar con elegancia si falta (servir crudo con Range —el navegador
decodifica casi todo— y avisar en Settings que sin ffmpeg no hay DSD/transcode). El `spawn` ya usa
**args en array (sin shell) → sin inyección de comandos**; solo falta localizar el binario.

## Seguridad / robustez — ANTES de exponerlo (y crítico para la versión móvil/remota)

1. **Escucha en todas las interfaces.** `…).listen(PORT)` sin host → bind a `0.0.0.0`/`::`, es decir
   **ya es accesible desde la LAN** (aunque el log diga "localhost"). No hay autenticación. Combinado con:
2. **`/api/config/listdirs` enumera TODO el árbol de ficheros** del servidor (todas las unidades en
   Windows) — es intencionado para el selector de carpetas y es **solo-lectura de nombres de carpeta**,
   pero es divulgación de información si el puerto está expuesto.
3. **Endpoints que escriben secretos/config** (`/api/config/*`: tokens de scrobbling, claves de Spotify,
   URL/credenciales de Liderarrr, AcoustID) y **acciones con efecto** (reescaneo, restaurar copia, borrar
   copia) no tienen auth.
   → **Plan (se implementa en el paso móvil/remoto, con verificación en vivo):** por defecto **bind a
   `127.0.0.1`**; exposición a LAN/remota **opt-in** (env `ESC_HOST`/ajuste) y SOLO con un **token/clave de
   acceso** exigido a las rutas que mutan o divulgan. No se cambia el bind a ciegas ahora porque el propio
   objetivo "versión móvil + acceso remoto" es habilitar el acceso desde fuera: se diseña junto.
4. **Manejadores de proceso. [HECHO, commit 59040bc]** `server.js` registra ya
   `process.on('uncaughtException')` y `'unhandledRejection'` que vuelcan a `app/escucharrr-error.log`
   y mantienen el servidor en pie — un .exe sin terminal no muere por un error suelto. (Compromiso
   consciente: seguir vivo tras un error no capturado; el log permite diagnosticar.)

## Checklist para "casi listo para probar standalone"

- [x] **Lanzador (opción 1)** para una prueba standalone inmediata: `escucharrr.cmd` en la raíz (busca
      `node\node.exe` empaquetado o el del PATH, pone `ESC_OPEN_BROWSER=1`, detecta `bin\ffmpeg.exe`).
      Guía completa + ruta a **SEA** (opción 2, `.exe` único) en [`../packaging/README.md`](../packaging/README.md). HECHO.
- [x] **Localizar/empaquetar ffmpeg; degradar si falta.** `resolveFfmpeg()` al arrancar: `ESC_FFMPEG` →
      `bin\ffmpeg.exe` → PATH. Sin ffmpeg, DSD devuelve 415 con aviso y el resto reproduce normal; Ajustes →
      Audio muestra el estado. HECHO. (El motor nativo sigue usando su propia resolución.)
- [ ] Bind por defecto a 127.0.0.1 + exposición opt-in con token (en el paso móvil/remoto).
- [x] `uncaughtException`/`unhandledRejection` + log a fichero (`app/escucharrr-error.log`). HECHO.
- [x] `Cache-Control: no-cache` en estáticos → las actualizaciones de shell/JS se recogen sin vaciar caché. HECHO.
- [x] **Primer arranque sin BD:** ya NO hace `process.exit(1)`. `freshDb` crea la BD vacía, aplica
      `data-layer/schema.sql` antes de las vistas, y la UI muestra un **banner de onboarding** (shell) que
      lleva a Ajustes → Biblioteca. `ESC_DB` permite mover la BD a una carpeta escribible. HECHO.
- [x] **Abrir el navegador por defecto al arrancar** (`maybeOpenBrowser`, opt-in `ESC_OPEN_BROWSER=1` que pone
      el lanzador; `ESC_NO_BROWSER` lo anula). HECHO.
- [x] **QA de UX en vivo** del empaquetado: verificado (ver abajo).

## QA en vivo del empaquetado (5 nov 2026)

Verificado con dos servidores: el real (`:7733`, BD poblada) y uno de primer arranque (`:7799`, `ESC_DB` a una
BD vacía temporal, borrada al terminar — no se tocó la BD real):

- **Sin regresión (BD real):** `/api/config` → `ffmpeg:true, empty:false, firstRun:false`; biblioteca carga; sin
  banner; Ajustes → Audio muestra «ffmpeg: disponible (en el PATH)».
- **Primer arranque (BD vacía):** el servidor NO aborta; log «primer arranque: … creando BD vacía»; `/api/config`
  → `empty:true, firstRun:true`. El **banner de onboarding** aparece alineado en la columna de contenido
  (corregido un solape con el menú lateral fijo), sobrio y sin emojis. Clic real en «Añadir carpeta de música»
  → enruta (SPA) a `settings.html#biblioteca` con el selector de carpeta listo. «No ahora» lo oculta y no
  reaparece al navegar. ffmpeg: fila de estado correcta.
- **Pendiente de dispositivo/navegador real:** registro del service worker / instalación PWA (el panel embebido
  no registra SW); y armar la carpeta portátil con `node.exe`/`ffmpeg.exe` reales para un `.exe` de doble clic.

Relacionado: [[library-playback-coverage]] (cobertura funcional), versiones/escaneo endurecido.
