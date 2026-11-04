# Auditoría de biblioteca + reproducción vs Roon (Nov 4 2026)

Tras el fallo de «el escáner solo ingería lossless», revisión honesta de dónde estamos de verdad
respecto a Roon en la parte de **biblioteca** (ingesta/metadatos/agrupación) y **reproducción**.

## ¿Cómo se nos pasó lo del MP3?

1. **El dato SÍ estaba en la RE.** La RE de `roonmedia.dll` documentó los decodificadores de Roon
   (`soom_*`): «FLAC/ALAC/AIFF/DFF/DSF/OGG/Opus/WAV + AAC/MP3/WMA (MediaFoundation)». O sea, sabíamos
   que Roon soporta MP3/AAC/etc.
2. **No lo convertimos en checklist para NUESTRO escáner.** La RE fue arquitectónica (entender Roon),
   no una auditoría de conformidad de escucharrr contra Roon. El escáner (hecho a mano, sin dependencias)
   solo implementaba FLAC/WAV/DSF/DFF y nadie cruzó esa lista con la de Roon.
3. **Punto ciego de datos.** La biblioteca de prueba (probertoj) es casi toda FLAC, así que TODOS los
   tests ejercitaban el camino FLAC. El hueco fue invisible hasta que apareció un betatester con MP3.
   «Funciona con mi biblioteca» ≠ «funciona con todas».

**Conclusión de proceso:** no hace falta repetir la RE a fondo (ya tenemos los hechos). Hace falta
convertir lo que la RE ya sabe en una **auditoría de cobertura** y cerrar huecos. Esto es eso.

## A. Formatos — ingesta (escáner) vs reproducción

La reproducción es amplia: `/api/stream` sirve el fichero crudo con Range (el navegador decodifica) y
transcodifica DSD→FLAC; el motor nativo usa ffmpeg (decodifica todo). El cuello de botella es el
**escáner**, que es quien mete el fichero en la biblioteca.

| Formato | Roon | escucharrr: ingesta | escucharrr: reproducción | Hueco |
|---|---|---|---|---|
| FLAC | ✓ | ✓ | ✓ | — |
| WAV | ✓ | ✓ | ✓ | — |
| DSF/DFF (DSD) | ✓ | ✓ | ✓ (transcode) | — |
| MP3 | ✓ | ✓ *(nuevo)* | ✓ | — |
| M4A/AAC | ✓ | ✓ *(nuevo)* | ✓ | — |
| ALAC | ✓ | ✓ (en .m4a, etiquetas) | ✓ (ffmpeg; Safari sí, Chrome no sin motor) | menor |
| AIFF | ✓ | ✓ *(verificado 4 nov)* | ✓ | — |
| OGG Vorbis | ✓ | ✓ *(verificado 4 nov)* | ✓ | — |
| Opus | ✓ | ✓ *(verificado 4 nov; 16 en la bibl.)* | ✓ | — |
| **WMA** | ✓ | ✗ | solo motor/ffmpeg | **ingesta + navegador** |
| MQA (core decode) | ✓ | ✗ (lo trata como FLAC) | — | baja prioridad |

**AIFF, OGG Vorbis y Opus: HECHOS y VERIFICADOS (4 nov 2026).** Implementados en `data-layer/tags.js`
(`readAiff` = IFF COMM + chunk ID3; `readOgg`/`oggScan` = reensambla paquetes OggS, Vorbis `\x03vorbis` +
Opus `OpusTags`, duración por granulepos/preSkip, carátula `METADATA_BLOCK_PICTURE`/`COVERART`) y
despachados en `scan.js`. Verificados con fixtures ffmpeg reales (etiquetas título/artista/álbum/track/
fecha/género + info sr/canales/duración; carátula AIFF por ID3 APIC) **y** escaneo de integración a BD de
prueba. Opus ya presente en la biblioteca real (16 ficheros). **Único hueco de ingesta que queda: WMA**
(ASF, más trabajo, formato en retirada).

> Nota (4 nov): `rel.format` mezcla el códec del fichero (FLAC/MP3/WAV/M4A) con el **formato de soporte de
> MusicBrainz** en releases identificados ("CD" 127, "Digital Media" 69, "12\" Vinyl" 39…). Cosmético: la
> etiqueta FORMATO del álbum puede mostrar el soporte en vez del códec. Revisar al tocar la enriquecer-MB.

## B. Metadatos / etiquetas

El escáner lee: album, albumartist, artist, title, track, disc, date, genre, MBIDs, ISRC, AcoustID,
y carátula embebida (FLAC/MP3/M4A). Huecos vs el modelo de Roon:

- **Varios artistas por crédito** (`A feat. B`, split/join): el esquema lo soporta (artist_credit), pero
  el escáner mete **1 artista por crédito** → no separa colaboraciones. **PENDIENTE (con supervisión):**
  624 de 11543 artistas traen marcador `feat./ft./featuring` (5,4%) → partir en principal + invitados es
  seguro y valioso. Pero **NO** partir por ` & `/`,`: 852 artistas los usan en nombres de banda legítimos
  (Paul McCartney & Wings, Trent Reznor & Atticus Ross, Earth, Wind & Fire). Riesgo: toca el modelo central
  de créditos (idempotencia/dedup de artist_credit multi-nombre) → mejor con supervisión y un reescaneo.
- **Compilations / Various Artists**: PARCIAL (commit 429408c). `isComp` ya iba por flag COMPILATION o
  ALBUMARTIST=«Various Artists»; AÑADIDO: la **carpeta-artista** "Various Artists"/"Varios Artistas"/"VA"
  también marca comp (~3124 ficheros reales), agrupando bajo «Various Artists» con artista real por pista.
  Estricto: NO "desconocido/unknown". **FALTA:** comps repartidos por carpetas de artista REAL que comparten
  título (p. ej. "Rebel Music" en billy bragg/ + bob marley/) → detección estructural por título (2ª pasada).
- **Compositor por pista** (`COMPOSER`): no se lee; Roon lo usa para clásica (compositor/obra). **PENDIENTE.**
- Menores: lyrics embebidas (USLT/©lyr), subtítulo de disco, sort-names, fecha original vs edición,
  sello/catálogo desde tags, ReplayGain embebido (lo calculamos con analyze.js, ok).

## C. Agrupación / corrección de biblioteca

- **Duplicados de artista por variantes de tag** (`astrud`/`Astrud`): **resuelto** con «Unir artistas».
- **Álbumes partidos por typo/edición** (`Perfomance`/`Performance`): se arregla editando; Roon agrupa
  ediciones (`disc_versions`). Tenemos «otras versiones» pero la agrupación automática es básica.
- **Versiones por carpeta (varias copias = 1 álbum, estilo Roon): HECHO + VERIFICADO GLOBALMENTE** (commit
  2db3abd). Cada copia física (carpeta) = un `release` bajo el álbum con una «Principal»; 4.204 álbumes con
  2 copias + 453 con 3; cero pérdida de datos. Ver [[versions-per-folder-gap]].
- **Multi-disc / box sets**: por `DISCNUMBER` → ok. **Mejorado (commit 09fea40):** `_DISC_DIR_RE` ahora
  reconoce subcarpetas "Digital Media NN" (soporte MusicBrainz; ~1172 ficheros: Beach House, Bloc Party…)
  como discos, para que no salgan como copias/versiones falsas. Las subcarpetas por-pista no son arreglables.
- **Colapso de discos-fantasma (TPOS roto)**: `prune.collapseBogusDiscs` (commit 6332c83) → ok.

## D. Reproducción — fundamentos (aquí estamos cerca de Roon)

Bien: gapless (prime-next/crossfade), **ReplayGain** (pista/álbum/off), crossfade, **bit-perfect**
(exclusivo nativo), **DSD**, EQ gráfico + paramétrico + convolución, fader en dB, zonas + grupos de red,
ruta de señal. Huecos vs Roon (no bloqueantes): resample/upsampling configurable (polyphase), crossfeed,
MQA, gestión de headroom avanzada, procesado por-zona fino.

**Veredicto reproducción: fundamentos ~90% de Roon.** Lo que falta es «nice-to-have» de DSP, no base.

## Recomendación (antes de más features de superficie)

Cerrar la BASE, por orden:
1. ~~**Ingesta AIFF + OGG + Opus**~~ **HECHO + VERIFICADO (4 nov 2026).** WMA al final (o nunca).
2. **Compilations / Various Artists** — PARCIAL (VA por carpeta hecho); falta la detección estructural
   por título cruzando carpetas de artista real.
3. **Multi-artista por crédito** — PENDIENTE: partir solo por `feat./ft.` (nunca por ` & `/`,`). Con supervisión.
4. **Compositor desde tags** — PENDIENTE (abre la parte clásica).

Lo demás de Roon que falta (MQA, crossfeed, resample) es DSP opcional, no fundamento.

## Estado operativo (4 nov 2026)

Tres arreglos del escáner de hoy están **commiteados y verificados en fixtures/BD de prueba**, pero
**aún no propagados a la biblioteca real** porque requieren un **reescaneo completo** y NO se lanza sin
supervisión (el share de red flaquea; el reescaneo previo tuvo ~200 carpetas `ENOENT`, aunque la lógica
scan_seq/mountHealthy las protegió sin pérdida de datos):
- `09fea40` — subcarpetas "Digital Media NN" como discos.
- `429408c` — Various Artists por carpeta-artista.
- (`2db3abd` versiones-por-carpeta ya SÍ está propagado por el reescaneo anterior.)

**Siguiente ventana supervisada:** lanzar un reescaneo completo para aplicar `09fea40`+`429408c`, luego
verificar global (copias/versiones, comps agrupadas) y reiniciar el servidor.
