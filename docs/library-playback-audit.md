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
| **AIFF** | ✓ | ✗ | ✓ (mime listo) | **ingesta** |
| **OGG Vorbis** | ✓ | ✗ | ✓ (mime listo) | **ingesta** |
| **Opus** | ✓ | ✗ | ✓ (mime listo) | **ingesta** |
| **WMA** | ✓ | ✗ | solo motor/ffmpeg | **ingesta + navegador** |
| MQA (core decode) | ✓ | ✗ (lo trata como FLAC) | — | baja prioridad |

**Huecos de ingesta reales: AIFF, OGG Vorbis, Opus, WMA.** Baratos: OGG/Opus usan Vorbis comments
(igual que FLAC, ya tenemos el lector) + carátula en `METADATA_BLOCK_PICTURE`; AIFF es IFF + ID3 (ya
tenemos ID3). WMA es ASF (más trabajo, formato en retirada).

## B. Metadatos / etiquetas

El escáner lee: album, albumartist, artist, title, track, disc, date, genre, MBIDs, ISRC, AcoustID,
y carátula embebida (FLAC/MP3/M4A). Huecos vs el modelo de Roon:

- **Varios artistas por crédito** (`A feat. B`, split/join): el esquema lo soporta (artist_credit), pero
  el escáner mete **1 artista por crédito** → no separa colaboraciones. **Prioridad media.**
- **Compilations / Various Artists**: usa `ALBUMARTIST || ARTIST`; si el tag no trae ALBUMARTIST=«Various
  Artists», una recopilación se **parte por artista**. **Prioridad media.**
- **Compositor por pista** (`COMPOSER`): no se lee; Roon lo usa para clásica (compositor/obra).
- Menores: lyrics embebidas (USLT/©lyr), subtítulo de disco, sort-names, fecha original vs edición,
  sello/catálogo desde tags, ReplayGain embebido (lo calculamos con analyze.js, ok).

## C. Agrupación / corrección de biblioteca

- **Duplicados de artista por variantes de tag** (`astrud`/`Astrud`): **resuelto** con «Unir artistas».
- **Álbumes partidos por typo/edición** (`Perfomance`/`Performance`): se arregla editando; Roon agrupa
  ediciones (`disc_versions`). Tenemos «otras versiones» pero la agrupación automática es básica.
- **Multi-disc / box sets**: por `DISCNUMBER` → ok.

## D. Reproducción — fundamentos (aquí estamos cerca de Roon)

Bien: gapless (prime-next/crossfade), **ReplayGain** (pista/álbum/off), crossfade, **bit-perfect**
(exclusivo nativo), **DSD**, EQ gráfico + paramétrico + convolución, fader en dB, zonas + grupos de red,
ruta de señal. Huecos vs Roon (no bloqueantes): resample/upsampling configurable (polyphase), crossfeed,
MQA, gestión de headroom avanzada, procesado por-zona fino.

**Veredicto reproducción: fundamentos ~90% de Roon.** Lo que falta es «nice-to-have» de DSP, no base.

## Recomendación (antes de más features de superficie)

Cerrar la BASE, por orden:
1. **Ingesta AIFF + OGG + Opus** (barato, reusa Vorbis/ID3 que ya tenemos). WMA al final (o nunca).
2. **Compilations / Various Artists** bien agrupadas.
3. **Multi-artista por crédito** (separar `feat.`/`&`).
4. **Compositor desde tags** (abre la parte clásica).

Lo demás de Roon que falta (MQA, crossfeed, resample) es DSP opcional, no fundamento.
