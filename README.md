# escucharrr

Reproductor de música **abierto y local-first**, inspirado en las mejores decisiones de
Roon (página de álbum rica, facetas de biblioteca, grafo relacional de metadatos) pero
sobre componentes libres y **sin dependencia de licencia ni nube**.

## Estado

- `docs/` — documentos de diseño: arquitectura y ajustes, cada decisión comparada con Roon.
  - `diseno-vs-roon.md` — datos, página de álbum, motor de audio, transporte, local-first.
  - `ajustes-vs-roon.md` — auditoría de ajustes (qué se puede replicar y qué no), Spotify/scrobbling.
  - `dispositivos-de-red-y-roon.md` — cómo hace Roon el multi-dispositivo (RAAT, ingeniería inversa) y
    el plan de salida de red de escucharrr (UPnP/DLNA al Eversolo; RAAT es cerrado/certificado).
- `data-layer/` — modelo de datos y herramientas de ingesta (**funcionando**, sin dependencias).
  - `schema.sql` — esquema SQLite (grafo estilo MusicBrainz; `tier` y `rating` de primera
    clase e indexados; créditos tipados; mapeo de ficheros; procedencia; FTS5; vistas).
  - `obsidian-sync.js` — sincroniza un vault de Obsidian al grafo (bio/tier/rating; tus notas mandan).
    Al **borrar** una nota, deshace justo lo que aportó (tier/rating/"acerca de" con `source='obsidian'`,
    según `provenance`) y la quita; un álbum que solo existía por su nota desaparece (ver `prune.js`).
  - `scan.js` — escanea ficheros locales (FLAC/WAV) → `local_file` + mapeo por tags al grafo
    (también lee identificadores embebidos: `MUSICBRAINZ_*`, `ACOUSTID_*`, `ISRC`). Al **borrar** un
    fichero del disco, quita su `local_file` y recoge la basura del grafo que queda sin anclar.
  - `prune.js` — **poda** (cierra el ciclo de la biblioteca en vivo): quita los `local_file` cuyo fichero
    ya no existe y recoge la basura del grafo (álbum → grabación → género/crédito/artista) que ya no ancla
    nada. **Conservador**: nunca borra algo que aún sostiene un fichero, una nota, datos del usuario
    (tier/rating/favorito/edición) o una lista; el historial de escucha se conserva (se desvincula, no se
    borra). A prueba de unidades desmontadas (si la raíz entera no está, no poda bajo ella). `--no-prune`
    desactiva la poda en `scan.js`/`obsidian-sync.js`.
  - `identify.js` — identifica grabaciones por identificador fuerte: **ISRC → MusicBrainz**
    (sin binario ni key) y **huella Chromaprint → AcoustID → MusicBrainz** (necesita `fpcalc` + API key).
  - `enrich.js` — enriquece desde MusicBrainz: mbid, tipo, fecha, géneros y **créditos por rol**.
  - `discogs.js` — **créditos por pista desde Discogs** (intérpretes/roles/instrumentos que MB no
    cubre en sellos pequeños); mapea por posición a nuestras grabaciones. Funciona sin token.
  - `editorial.js` — **editorial desde fuentes abiertas**: bio del artista + contexto/reseña del álbum
    desde **Wikipedia** (texto), resuelta por **Wikidata** vía las relaciones de MusicBrainz (sin clave).
    Cadena por MBID: MB `url-rels` → `wikidata` (Q…) → sitelink al idioma preferido (`--lang`, por defecto
    `es`, con fallback a inglés) → resumen REST de Wikipedia. Guarda el texto (`artist.bio` /
    `release_group.about`) con **procedencia** (tabla `provenance`, `source='wikipedia'`, enlace al artículo).
    **Tus notas de Obsidian mandan**: solo rellena lo externo; el `user_edit` sigue ganando al leer. Entidades
    sin MBID se saltan (identificador fuerte, sin adivinar por nombre). Cacheado; `--force` re-consulta.
  - `covers.js` — **carátulas reales** desde **Cover Art Archive** (abierto, sin clave): por MBID de
    release-group pide la portada frontal (atajo `/front-<size>`, redirige a archive.org) y la **cachea en local**
    (`app/cache/covers/<id>.jpg`, gitignored) con **procedencia** (`provenance`, `source='coverartarchive'`; o
    `'none'` si no hay, para no reconsultar). `--size 250|500|1200`, `--rg ID`, `--limit`, `--force`. El servidor
    sirve la carátula por `/api/cover?rg=ID` y, si no hay, devuelve el **SVG geométrico de respaldo** (mismo por id).
  - `spotify.js` — **¿tengo este disco en mi Spotify?** Compara tu biblioteca local con tus **álbumes guardados**
    en Spotify (Web API, scope `user-library-read`; **no reproduce nada**). Necesita una app propia de
    `developer.spotify.com` (clientId/secret en `app/spotify.json`, gitignored, a partir de `spotify.example.json`)
    y tu OK (OAuth; el token se guarda en `app/.spotify-token`). El servidor expone `/api/spotify/{status,auth,
    callback,sync}`; `sync` trae tus álbumes guardados y los **empareja** con los locales (por `artista|título`
    normalizado —quita acentos, `(remaster)`, artículos— y por **UPC** si lo hay), marcando `release_group.
    spotify_album_id`. La página de álbum muestra **«● En tu biblioteca de Spotify»** o «○ No está»; se conecta y
    sincroniza desde Configuración → Servicios.
  - `analyze.js` — **loudness EBU R128 / ReplayGain** con ffmpeg (`ebur128`): por pista mide LUFS integrado y
    pico → `gain_db` (ref −18 LUFS) + `peak_dbfs`; y **por álbum** mide el disco entero como un solo programa
    (concatena sus ficheros con el demuxer `concat`) → `album_gain_db` + `album_peak_dbfs`, iguales para todas
    sus pistas (conserva la dinámica relativa del disco). El player normaliza con ello (modo pista/álbum/off).
  - `config.example.json`, `obsidian-mapping.md`, `sample-vault/` — configuración, spec y ejemplo.
- `app/` — vista web mínima que lee de la BD (**funcionando**): servidor + biblioteca + página de álbum.
  - `server.js` — API JSON (`/api/library`, `/api/album?id=`, …) desde SQLite y **streaming de
    audio** (`/api/stream?track=` con soporte de `Range` para seek) (node:http + node:sqlite).
  - `public/player.js` — **reproductor real**: doble "deck" `<audio>` → grafo Web Audio
    (ganancia por pista con ReplayGain → **EQ** de 7 bandas `BiquadFilter` → ganancia maestra → salida),
    **crossfade** real entre pistas al auto-avanzar (solapa los dos decks con rampas de ganancia),
    cola persistente al estilo "Swim" de Roon (historial de lo reproducido, **radio** que auto-extiende la
    cola con pistas afines de tu grafo cuando se acaba, y **deshacer** cambios de cola),
    barra de "ahora suena" con progreso/seek/volumen y auto-avance, panel de
    ecualizador (presets) + crossfade + **normalización ReplayGain pista/álbum/off**,
    y **selector de salida/zona** (`AudioContext.setSinkId`;
    la "zona" es nombrable y persistente, base para el multi-sala futuro; cada reproducción se registra con su zona),
    con un **conmutador de motor nativo** que enruta el transporte (play/pausa/seek/volumen) a la salida WASAPI
    del servidor (`/api/native/*`) en vez del navegador, silenciando los decks para no duplicar el sonido.
  - **Biblioteca en vivo**: con `app/watch.json` (copia de `watch.example.json`), el servidor vigila
    tus carpetas de música y el vault de Obsidian, reescanea/sincroniza al vuelo y refresca la UI por SSE.
    El ciclo está **cerrado**: borrar un fichero o una nota **poda** su pista/álbum del grafo (ver `prune.js`),
    no solo añadir/actualizar.
  - **Scrobbling local-first** (`data-layer/scrobble.js`): cada escucha que supera el umbral (mitad de la
    pista o 4 min; ≥ 30 s) se encola en SQLite (`scrobble_queue`, instantánea de metadata con MBIDs) y un
    drenador la envía a **Last.fm** y **ListenBrainz** con reintentos + backoff, tolerando estar sin conexión;
    "sonando ahora" al empezar cada pista. Sin paquetes externos (firma md5 de Last.fm propia). Con
    `app/scrobble.json` (copia de `scrobble.example.json`); credenciales con `node data-layer/scrobble-auth.js`
    (`--listenbrainz --token …`, o `--lastfm` → autorizar en el navegador → `--lastfm-finish`). Sin claves,
    desactivado. Rutas `/api/scrobble/{nowplaying,submit,status}`.
  - **Letras** (`data-layer/lyrics.js` + `/api/lyrics?track=`): letra de la pista desde **LRCLIB** (fuente
    abierta, sin clave), con **sincronización** (karaoke: la línea en curso se resalta y centra según la
    reproducción) cuando LRCLIB la tiene, o texto plano si no. Cacheada en local (tabla `lyrics`, con caché
    negativa para no repetir consultas). Panel 📝 en la barra del player, en cualquier página.
  - `public/` — biblioteca (Focus por tier/género/**etiqueta**/década/tipo/formato/valoración, orden, filtro),
    **etiquetas de usuario** (tags libres estilo Roon: se añaden/quitan en cada álbum y filtran la biblioteca;
    tablas `tag`/`tag_item`, rutas `/api/tags`, `/api/tag`, `/api/tag/{add,remove}`, página `tag.html`),
    página de álbum (tier, valoración, créditos por rol, bio con procedencia), **página de artista**
    (avatar, géneros, discografía propia y "aparece en" con sus roles), **página de género**
    (álbumes del género + géneros relacionados), **índice de géneros** y **Descubrir**
    (sugerencias desde tu propio grafo: álbumes por valorar, joyas de tier alto sin reproducir,
    filas por tus géneros dominantes y una tirada al azar — sin nube), y **listas de reproducción**
    (crear, añadir un álbum o una pista suelta desde su página, reordenar ↑↓, quitar, renombrar, borrar
    y reproducir; tablas `playlist`/`playlist_item`, rutas `/api/playlist(s)`; **exportar/importar M3U**:
    `/api/playlist/export?id=` vuelca un `.m3u8` con rutas reales, e importar un `.m3u/.m3u8` crea una lista
    mapeando cada entrada por **ruta** y, si no la encuentra, por **artista–título** del `#EXTINF`). Todo internavegable:
    álbum → artista → género, y los artistas del buscador abren su página.

- `engine/` — **motor de audio nativo** (esqueleto; §4 del diseño: decode → float32 → DSP → salida).
  Es la parte que SÍ tiene que ser nativa (salida de baja latencia / bit-perfect, fuera del navegador).
  - `escucharrr-engine.cpp` — renderizador **WASAPI** en float32 (C++, solo Windows SDK, **sin libs externas**):
    enumera dispositivos de salida (con su formato de mezcla) y reproduce PCM `f32le` en **modo compartido**
    o **exclusivo = bit-perfect** (sin tocar la muestra), con prioridad de hilo de audio (MMCSS). Grafo DSP:
    **resample** (sinc enventanado **Kaiser**, polifásico) → **ganancia maestra** → **EQ de 7 bandas** `biquad`
    (mismas frecuencias que el player web), y **cuantización con dither TPDF** si la salida es PCM entero. El
    resample iguala la entrada (tasa **nativa** del fichero) a la tasa de mezcla del dispositivo para que **WASAPI
    no vuelva a remuestrear** (sustituye su SRC por uno de alta calidad: banda de paso plana a ~20 kHz, rechazo de
    alias ~98–109 dB — medible con `escucharrr-engine --selftest`). Recibe el PCM por un **named pipe** y acepta
    **control en vivo por stdin** (`gain`/`eq`/`inrate`/`pause`/`resume`/`flush`/`stop`): así el motor y el
    dispositivo quedan vivos toda la reproducción. Ranuras de convolución y noise-shaping, documentadas para después.
  - `native-player.js` — bridge Node: la **decodificación** la pone **ffmpeg** (ranura de decoder; libFLAC/dr_flac
    en el futuro) a la **tasa nativa** del fichero y el **resample** lo hace el motor; el **transporte** lo lleva el
    bridge — como el "core" de Roon posee las zonas y la UI es un
    mando. Salida nativa = **zona del servidor**. Volumen y pausa son **inmediatos** (un comando, sin relanzar);
    el **seek** solo hace flush del buffer y reposiciona ffmpeg sobre el mismo pipe (el dispositivo no se corta);
    el **cambio de pista reutiliza el motor** (mismo dispositivo en compartido) sin reinicializar WASAPI (casi sin
    corte), reconfigurando el resampler al vuelo (`inrate`) si la nueva pista tiene otra tasa; el fin real de la
    pista se detecta por duración (ffmpeg decodifica mucho antes de que acabe el audio).
    Al volver de la zona nativa al navegador, la reproducción **reanuda en la posición** (no desde cero).
  - `build.ps1` — compila con MSVC (VS Build Tools + workload C++); `cli.js` — demo: `node engine/cli.js devices|play`.
    Autoprueba numérica del DSP (resample + dither, sin hardware de audio): `escucharrr-engine.exe --selftest`.
  - El servidor expone `/api/native/{devices,state,play,pause,resume,stop,seek,volume,eq,output}` para manejarlo
    (aplica ReplayGain × volumen; si el binario no está compilado, lo avisa sin romper nada). El **player** tiene
    un conmutador "Motor nativo (este equipo)" en el panel 🔈 que enruta el transporte a esas rutas, con selector
    de dispositivo y casilla **exclusivo (bit-perfect)**; el cambio de modo hace handoff en la posición actual.
  - `upnp.js` — **salida de red UPnP/DLNA** (sin dependencias: `node:dgram` + `node:http`). Descubre MediaRenderers
    por **SSDP**, lee su `description.xml` y controla **AVTransport** (`SetAVTransportURI` + Play/Pause/Stop/Seek) y
    **RenderingControl** (volumen). **Gapless real**: encola la siguiente pista con `SetNextAVTransportURI` y el
    aparato transiciona SOLO al acabar; el servidor lo detecta comparando la `TrackURI` que reporta con la que cebó,
    avanza la cola y ceba la próxima (`/api/upnp/setnext`). El dispositivo (p. ej. un **Eversolo**)
    **descarga** la música de `/api/stream` (que ya hace Range), así que no se reencodea nada: FLAC/WAV van tal
    cual con metadatos DIDL-Lite y carátula. El servidor expone `/api/upnp/{devices,state,play,pause,resume,stop,
    seek,volume}` (construye la URL con la **IP de la LAN** que ve el aparato); el **player** lista los renderers
    en el panel 🔈 bajo "Salida de red" y enruta el transporte allí. Es la vía ABIERTA a dispositivos "Roon Ready"
    (RAAT es cerrado/certificado, no replicable — ver `docs/dispositivos-de-red-y-roon.md`). Nota: en red el
    ReplayGain y el EQ no se aplican (el aparato reproduce el fichero y gestiona su volumen).

Todo usa `node:sqlite` (Node ≥ 22.5 / 24), **sin paquetes externos**. El motor nativo añade, solo para la
salida local nativa, **MSVC + Windows SDK** (compilación) y **ffmpeg** en el PATH (decodificación); la app web
y el resto del pipeline no los necesitan.

## Construir la BD y arrancar la app

```bash
# 1. generar la base de datos (data-layer/)
cd data-layer
node obsidian-sync.js --db ../app/escucharrr.db --config config.example.json
node scan.js         --db ../app/escucharrr.db --root "/ruta/a/tu/musica"
node identify.js     --db ../app/escucharrr.db --isrc            # ISRC -> MusicBrainz (gratis)
# huella acústica (opcional): necesita fpcalc en el PATH + API key de AcoustID
node identify.js     --db ../app/escucharrr.db --acoustid --acoustid-key TU_KEY
node enrich.js       --db ../app/escucharrr.db --limit 50
node discogs.js      --db ../app/escucharrr.db --rg 1   # créditos por pista (donde MB no llega)
node editorial.js    --db ../app/escucharrr.db          # bio/reseña desde Wikipedia (abierto, sin clave)
node covers.js       --db ../app/escucharrr.db          # carátulas reales desde Cover Art Archive (cacheadas)
node analyze.js      --db ../app/escucharrr.db          # loudness R128/ReplayGain (necesita ffmpeg)

# 2. arrancar la vista web
cd ..
node app/server.js            # http://localhost:7733

# 3. (opcional) motor nativo: compilar y probar la salida WASAPI local
powershell -ExecutionPolicy Bypass -File engine\build.ps1   # necesita VS Build Tools (C++)
node engine/cli.js devices                                   # lista dispositivos de salida
node engine/cli.js play "/ruta/a/pista.flac" 10              # reproduce 10 s por el predeterminado (ffmpeg en PATH)
```

Probado de punta a punta con datos reales: FLAC/WAV escaneados con sus propiedades, álbum
resuelto en MusicBrainz con géneros y créditos por rol, consultas "Excel sin valorar" /
"4★ o más" sobre `tier`/`rating`, y la biblioteca + página de álbum renderizando desde SQLite.

Principios: la biblioteca es una proyección sobre un grafo canónico (no un reflejo de los
tags); **tus notas de Obsidian mandan** sobre las fuentes externas; `tier`/`rating` son
campos consultables para filtrar y clasificar.
