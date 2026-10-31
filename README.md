# escucharrr

Reproductor de música **abierto y local-first**, inspirado en las mejores decisiones de
Roon (página de álbum rica, facetas de biblioteca, grafo relacional de metadatos) pero
sobre componentes libres y **sin dependencia de licencia ni nube**.

## Estado

- `docs/` — documentos de diseño: arquitectura y ajustes, cada decisión comparada con Roon.
  - `diseno-vs-roon.md` — datos, página de álbum, motor de audio, transporte, local-first.
  - `ajustes-vs-roon.md` — auditoría de ajustes (qué se puede replicar y qué no), Spotify/scrobbling.
- `data-layer/` — modelo de datos y herramientas de ingesta (**funcionando**, sin dependencias).
  - `schema.sql` — esquema SQLite (grafo estilo MusicBrainz; `tier` y `rating` de primera
    clase e indexados; créditos tipados; mapeo de ficheros; procedencia; FTS5; vistas).
  - `obsidian-sync.js` — sincroniza un vault de Obsidian al grafo (bio/tier/rating; tus notas mandan).
  - `scan.js` — escanea ficheros locales (FLAC/WAV) → `local_file` + mapeo por tags al grafo
    (también lee identificadores embebidos: `MUSICBRAINZ_*`, `ACOUSTID_*`, `ISRC`).
  - `identify.js` — identifica grabaciones por identificador fuerte: **ISRC → MusicBrainz**
    (sin binario ni key) y **huella Chromaprint → AcoustID → MusicBrainz** (necesita `fpcalc` + API key).
  - `enrich.js` — enriquece desde MusicBrainz: mbid, tipo, fecha, géneros y **créditos por rol**.
  - `discogs.js` — **créditos por pista desde Discogs** (intérpretes/roles/instrumentos que MB no
    cubre en sellos pequeños); mapea por posición a nuestras grabaciones. Funciona sin token.
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
  - `public/` — biblioteca (Focus por tier/género/década/tipo/formato/valoración, orden, filtro),
    página de álbum (tier, valoración, créditos por rol, bio con procedencia), **página de artista**
    (avatar, géneros, discografía propia y "aparece en" con sus roles), **página de género**
    (álbumes del género + géneros relacionados), **índice de géneros** y **Descubrir**
    (sugerencias desde tu propio grafo: álbumes por valorar, joyas de tier alto sin reproducir,
    filas por tus géneros dominantes y una tirada al azar — sin nube), y **listas de reproducción**
    (crear, añadir un álbum o una pista suelta desde su página, reordenar ↑↓, quitar, renombrar, borrar
    y reproducir; tablas `playlist`/`playlist_item`, rutas `/api/playlist(s)`). Todo internavegable:
    álbum → artista → género, y los artistas del buscador abren su página.

- `engine/` — **motor de audio nativo** (esqueleto; §4 del diseño: decode → float32 → DSP → salida).
  Es la parte que SÍ tiene que ser nativa (salida de baja latencia / bit-perfect, fuera del navegador).
  - `escucharrr-engine.cpp` — renderizador **WASAPI** en float32 (C++, solo Windows SDK, **sin libs externas**):
    enumera dispositivos de salida (con su formato de mezcla) y reproduce PCM `f32le` en **modo compartido**
    (con **ganancia maestra** + **ecualizador de 7 bandas** `biquad` — mismas frecuencias que el player web)
    o **exclusivo = bit-perfect** (sin tocar la muestra), con prioridad de hilo de audio (MMCSS). Recibe el PCM
    por un **named pipe** y acepta **control en vivo por stdin** (`gain`/`eq`/`pause`/`resume`/`flush`/`stop`):
    así el motor y el dispositivo quedan vivos toda la reproducción. Ranuras de resample (soxr), convolución y
    dither, y el bit-perfect entero 16/24-bit, documentadas para más adelante.
  - `native-player.js` — bridge Node: la **decodificación** la pone **ffmpeg** (ranura de decoder; libFLAC/dr_flac
    en el futuro) y el **transporte** lo lleva el bridge — como el "core" de Roon posee las zonas y la UI es un
    mando. Salida nativa = **zona del servidor**. Volumen y pausa son **inmediatos** (un comando, sin relanzar);
    el **seek** solo hace flush del buffer y reposiciona ffmpeg sobre el mismo pipe (el dispositivo no se corta);
    el **cambio de pista reutiliza el motor** (mismo dispositivo en compartido) sin reinicializar WASAPI (casi sin
    corte); el fin real de la pista se detecta por duración (ffmpeg decodifica mucho antes de que acabe el audio).
    Al volver de la zona nativa al navegador, la reproducción **reanuda en la posición** (no desde cero).
  - `build.ps1` — compila con MSVC (VS Build Tools + workload C++); `cli.js` — demo: `node engine/cli.js devices|play`.
  - El servidor expone `/api/native/{devices,state,play,pause,resume,stop,seek,volume,eq,output}` para manejarlo
    (aplica ReplayGain × volumen; si el binario no está compilado, lo avisa sin romper nada). El **player** tiene
    un conmutador "Motor nativo (este equipo)" en el panel 🔈 que enruta el transporte a esas rutas, con selector
    de dispositivo y casilla **exclusivo (bit-perfect)**; el cambio de modo hace handoff en la posición actual.

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
