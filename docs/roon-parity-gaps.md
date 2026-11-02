# Roon ↔ escucharrr — ledger de paridad (ingeniería inversa profunda)

Objetivo: conocer *cada detalle* de las tripas de Roon para anticipar los huecos
(como las portadas embebidas y el Focus acotado) antes de que se noten como error.

**Método.** Byte-mining del bundle de UI compilado `ui.brooxgz` (gzip → contenedor BROO v1,
20,3 MB, 99 pantallas `.broo`). El cuerpo compilado de las `.broo` NO está decodificado;
lo que se extrae es la **tabla de cadenas** (identificadores de widgets, campos, opciones,
etiquetas) con `tr -c '[:print:]' '\n'`. Eso basta para reconstruir *qué* ofrece cada
pantalla. Complementa las notas de motor/licencia/RAAT en la memoria `roon-analysis`.

Estado: ✅ hecho · ◑ parcial · ❌ falta · N/A no aplica (propietario/cloud).
Prioridad: **P1** detalle silencioso que se notará pronto · **P2** valor claro · **P3** más adelante.

---

## 1. Biblioteca de álbumes (`albumbrowser.broo` / `focus.broo`)

### Focus — facetas (de `albumbrowser_focus_*`, `trackfocus_*`, `workfocus_*`)
Roon ofrece MUCHAS más facetas que nosotros. Inventario real extraído:

| Faceta Roon | nuestro estado | gap | prio |
|---|---|---|---|
| genres (+ sort alfabético / por biblioteca, "view more") | ✅ género (+ buscador) | sort alfabético opcional | P3 |
| rating | ✅ valoración | — | — |
| format | ✅ formato | — | — |
| decade / **released (rango de año min/máx)** | ✅ década + **rango de año (desde/hasta)** | — (Roon: `menu_focus_year` con botones de década + steppers min/máx; mi primera mina solo vio `decade_option` y lo di por cubierto — corregido) | — |
| bit_depth (profundidad de bits) | ✅ Profundidad | — | — |
| **sample_rate (frecuencia)** | ✅ Frecuencia | — | — |
| channels / channel_layout | ✅ Canales | — | — |
| added (últimos 3/6 meses…) | ✅ Añadido | — | — |
| most_played (25/50/100…) | ✅ faceta Reproducciones (buckets 1/2–5/6–10/11+) + **sort Más reproducido** | Roon usa "top N"; nuestros buckets por recuento son equivalentes útiles | — |
| last_played (día/semana/mes/año) | ✅ Último play | — | — |
| album_type | ◑ tipo | mapear tipos finos (EP/single/live/comp) | P3 |
| **has_cover / has_liner_notes / has_pdf / has_additional_images** | ❌ | solo has_cover es viable (arte embebido); el resto no lo trackeamos | P3 |
| **countries (países) / labels (sellos)** | ❌ | `release.country`/tabla `label`; datos pobres hoy | P3 |
| multiple_formats / contiguous_tracks | ❌ | nicho; el escáner fusiona a un formato por álbum | P3 |
| **Inspector** (facetas de salud, ver §6) | ◑ Identificado, Con género, **Con versiones**, **Multidisco** | faltan corrupto/sin audio(ya cubierto por "Audio local")/ubicaciones de almacenamiento/exportable | P3 |

Revisión EXHAUSTIVA del Focus (Nov 2 2026): inventario completo de `albumbrowser_focus_*`
cotejado. Facetas principales de álbum ya cubiertas; solo quedan las de datos pobres/caros
(has_*, países, sellos) o nicho, más ampliar el Inspector. El Focus de pista/obra/compositor
(trackbrowser/workbrowser/composerbrowser) aún no tiene pantalla propia en escucharrr.

### Ordenar (`albumbrowser_sort_*`)
Roon: album_title, artist, **date**, **date_added**, **most_played**, **random**.
Nosotros: título, año, artista, tier, valoración. Faltan: **date_added**, **most_played**, **random**. → **P1/P2**

### Layout del panel Focus
Roon: `menu_focus_column_dropdown_*` (cada faceta es una columna con cabecera + lista
desplazable; "view more"), `focus_panel_bottomfade`. ✅ ya replicado (columnas acotadas
44vh + buscador). Pendiente: "view more" progresivo y fade inferior. P3.

---

## 2. Ficha de álbum (`albumdetails.broo`)
Campos/secciones reales (`album_details_*`, `albumdetails_*`):

| Elemento Roon | nuestro estado | gap | prio |
|---|---|---|---|
| título, artista, portada, año, formato (`format_core`, `format_length`) | ✅ | — | — |
| **review_section** + **review_source** (icono/etiqueta/selector de fuente) + toggle | ◑ reseña (about) | falta selector de FUENTE y plegado | **P1** |
| **production_credits** (fila + toggle) / **composer_credits** toggle | ◑ créditos | plegado por secciones | P2 |
| **release_info_toggle** (info de edición) | ❌ | sello, país, catálogo, barcode | P2 |
| **select_version / disc_versions** (varias ediciones del mismo álbum) | ❌ | agrupar versiones | P2 |
| **disc_header / disc_cover / disc_play** (multi-disco) | ◑ medium | cabecera por disco + play de disco | P2 |
| **performance_count / library_performance_count** | ❌ | nº de interpretaciones (clásica) | P3 |
| genre_tag_chip / track_tags | ✅ chips de género / tags | — | — |
| **explicit** (flag) | ❌ | marca explícito | P3 |
| **view_photos / view_documents** | ❌ | galería de fotos/booklet | P3 |
| pestañas **For You / Latest / Most Popular / New Releases / More from artist** | ❌ | descubrimiento contextual (cloud) | N/A/P3 |
| rating / clear_rating | ✅ estrellas + ✕ | — | — |
| **classical defaults** (layout distinto para clásica) | ❌ | obra/movimientos | P3 |
| tracks_from_here / play_now / add | ◑ | "reproducir desde aquí" | P3 |

**Review (responde a la pregunta del usuario).** Roon muestra la reseña con un **selector
de fuente** (`review_source_option`): editorial de su nube, de archivo, etc. Al guardar una
reseña en Roon se almacena en SU base de datos del Core (no reescribe tus ficheros).
En escucharrr: ver §7.

---

## 3. Ficha de artista (`artistdetails.broo`)
`artist_details_*`: **bio** con selector de fuente (`bio_source_option/row`) + toggle;
**add_photo / improve_photo**; **discography** (sort date/title/popularity, flip) con
tabs clásicos (composer/performer); **compositions** (clásica); **library tabs**:
main, **appearances, bootlegs, compilations, production**, latest, popular;
ensemble_performers; catalog_system.
Nosotros: álbumes + "aparece en" + bio + géneros + obras. Gaps: **tabs de biblioteca
(apariciones/compilaciones/producción)** P2; selector de fuente de bio P2; foto de artista P3.

---

## 4. Edición y corrección (`edit.broo` / `correction.broo`)
Roon permite editar MUCHO (`edit_album_*`):
- **identify / reidentify** (wizard de identificación: `identify_album`, `identify_results`, `identify_suggestions`) — ✅ **HECHO (Nov 2 2026)**: `data-layer/identify-album.js` empareja por nº de pistas + perfil de duraciones contra MusicBrainz; `GET /api/identify` + `POST /api/identify/apply` (fija MBID + procedencia + encadena `enrich --rg`); botón "Identificar" + modal en la ficha. Probado en vivo.
- **merge / fix_grouping / group_versions** (unir ediciones/versiones) — ❌ P2.
- **edit_cover** + fuente de imagen: **use_file / use_meta / use_best / clear** — ◑ (ya extraemos arte de archivo; falta la *preferencia*). **P1**.
- **hide / unhide / delete** álbum — ❌ P2.
- **rescan / reanalyze** — ◑ (tenemos reescaneo global; falta por-álbum) P3.
- **import date** por pista: roon / creation / modification / clear — ❌ P3.
- **correction** (`correction_*`): mover/unir discos, renumerar, keep_disc_numbers,
  manual_search, "none look right" — ❌ P3 (corrección manual de pistas/discos).

---

## 5. Identificación y preferencias de metadatos (clave del modelo)
Cita literal del bundle:
> "Roon uses data from its own metadata databases and your files to present you with the
> data you see. If you prefer some fields to come from files vs [Roon]…"
y
> "…then identifies the metadata for your albums, and retrieves reviews, biographies,
> lyrics, credits, covers, photos, and other metadata."

- **Preferencias de contenido** (`dialog_metadata_content_preferences`). **Corrección (RE Nov 2
  2026, `Roon.Metadata.dll`):** NO es campo-a-campo como suponía esta nota. El modelo real es
  GRUESO — clase `ContentPreferences` con solo: `EditedContentPreference` (enum `Prefer` ≈
  `{Roon, files, None}`: por categoría, gana la nube de Roon o tus ficheros), `MqaContentPreference`
  y `PreferredStreamingService` (`Tidal`/`Qobuz`). La elección de origen "por texto" es la
  **localización** (`LocalizedText.Source`, `LocalizedName/Title/AlbumArtist`), no una matriz de
  campos. Procedencia por objeto: `Source*Ids` (`SourceAlbumIds/TrackIds/WorkIds/PerformerIds/
  PerformanceIds`). → Para escucharrr basta un toggle de categoría (prefiere tus tags vs enriquecido),
  no un diálogo por-campo. Nuestro "user_edit SIEMPRE gana" ya cubre el caso de ediciones; el gap
  real es el toggle tags-vs-enriquecido por álbum. Rebajado a **P3** (el modelo granular era un
  espejismo del naming de la UI).
- **Localización** (`dialog_metadata_localization_preferences`): idioma de metadatos. P3.
- Identificado vs no identificado: un álbum "identificado" gana créditos/letras/portada
  de la nube; si "revert to basic info stored in your files" pierdes esa capa. Nosotros:
  todo sale de tags/Obsidian; el enriquecido externo es parcial. ◑.

---

## 6. Inspector (facetas de salud de la biblioteca)
`inspector_*`: available, banned, corrupt, duplicates, exportable, has_genres,
**identified**, media_count, storage_locations, track_count, performance_count.
Es un Focus especial para auditar la colección. ✅ **HECHO (Nov 2 2026)**: pantalla
`inspector.html` + `GET /api/inspector` con buckets sin identificar / sin género / sin audio
local / posibles duplicados (mismo artista+título) / multidisco / identificados, con drill-down
paginado; los "sin identificar" enlazan a la ficha (wizard). Descartada "sin portada"
(cover_path solo se rellena al descargar; el arte embebido se sirve bajo demanda → señal falsa).

---

## 7. Nuestro modelo de edición (qué se genera al guardar) — referencia
Al guardar en la app (tier, estrellas, favorito, escuchar-más-tarde, **reseña**, bio):
`POST /api/edit` → `handleEditSync` → fila en **SQLite `app/escucharrr.db`**:
- reseña/bio → tabla **`user_edit`** (subject_type, subject_id, field='about'|'bio', value, updated_at), UPSERT.
- + fila en **`provenance`** (source='user') para marcar que el dato es tuyo.
- tier → `rating_tier` (+`rating_event`), estrellas → `rating`, favorito/later → `flag`.
NO se reescriben los ficheros de audio ni la nota de Obsidian. El valor de usuario GANA al
enriquecido (Obsidian/Wikipedia). Igual que Roon guarda en la BD del Core, no en tus ficheros.
Gap vs Roon: Roon ofrece **selector de fuente** de la reseña; nosotros solo user vs externo. P2.

---

## 8. Ajustes de biblioteca/almacenamiento (`settings_library/storage.broo`)
Roon: múltiples carpetas (enable/disable, force rescan, iTunes), **genre_mappings** (mapear
géneros), import settings, maintenance, cleanup, **skipped_files** (ficheros saltados),
unmerge artists/compositions. Nosotros: carpetas configurables + reescaneo. Gaps:
**ficheros saltados visibles** (¡tenemos el log de ENOENT del NAS!) P2; mapeo de géneros P3.

---

## 9. Motor / multi-room / licencia (ya en memoria `roon-analysis`)
roonmedia.dll (codecs + DSP + raíz de confianza Curve25519/Ed25519 + HMAC-SHA512),
RAAT (SOOD/UDP 9003, firmado, NO replicable), licencia por cuenta/asiento. Camino abierto
para multi-room: UPnP/DLNA/AirPlay. Sin cambios aquí.

---

## Cola de trabajo priorizada
Hecho (Nov 2 2026): portadas desde arte embebido FLAC; Focus acotado + buscador por columna;
facetas **bit depth / canales / añadido** + sort **date_added / random**; **Inspector: Identificado + Con género**;
render de markdown de notas (reseña/bio); **write-back a Obsidian** (guardar la reseña en el .md, preservando frontmatter — va MÁS ALLÁ de Roon, que no reescribe tus ficheros); virtualización del grid; **pestañas de artista** (Discografía/Apariciones/Producción/Obras); **"Otras versiones"** de álbum (release_groups hermanos: deluxe/remaster/año/país; 302 grupos / 615 álbumes).
Pendiente:
- **P1 → HECHO (Nov 2)**: reseña con **selector de fuente** (tuya/Obsidian/editorial), **plegado** de reseñas/bios largas, y **preferencia de portada** por álbum (Auto/Archivo/Descargada/Ninguna). El bloque P1 queda completo.
- **Pantalla de pistas (trackbrowser) → HECHO (Nov 2)**: vista "Pistas" con búsqueda/orden/paginación en el servidor (dos pasadas; 143ms/página), scroll infinito, reproducción, y **Focus de pista** (formato/profundidad/frecuencia/canales; facetas cacheadas + filtros server-side). Pendiente menor: faceta de género/década en pista (necesita join al álbum) y keyset para offsets muy profundos (hoy ~600ms a offset 50k).
### Empujón "todo lo que queda" (bloques 1→6, Nov 2 2026) — HECHO
- **B1 navegación**: **navegador de carpetas** (folders.html, /api/folders con extracción de segmentos en SQL + caché; 4628 carpetas); **navegador de obras** mínimo (works.html). Compositor NO como pantalla propia (son artistas; además 5 obras en la biblioteca).
- **B2 ficha de álbum**: **cabeceras de disco** + "reproducir disco" en multidisco; "reproducir desde aquí" ya estaba. Info de edición (sello/país/barcode) y obra/compositor: ahora POBLADAS por el enriquecido de MusicBrainz (ver "Empujón mi orden").
- **B3 edición**: **ocultar/mostrar álbumes** (flag hidden + faceta "Oculto"; no borra del disco). Identify wizard, merge/fusionar, prefs por-campo: DIFERIDOS (API de MusicBrainz / complejos).
- **B4 ajustes**: **ficheros saltados** del escaneo persistidos (tabla skipped_file) y mostrados en Ajustes. Mapeo de géneros: diferido (bajo valor). UI de varias carpetas: ya existía.
- **B5 infra**: **obsidian-sync incremental** (`--only <nota>`, ~0,3s vs varios segundos; el watcher lo usa). Keyset: no (poco valor real). Reescaneo NAS: botón existente + ahora muestra lo saltado.
- **B6 multi-room**: **descubrimiento mDNS** (Chromecast/AirPlay) + DLNA en paralelo, siempre visibles en el selector de zona con su tipo. Reproducir: DLNA y ahora **Chromecast** (ver "Empujón mi orden"); AirPlay sigue como "detectado".

### Empujón "mi orden" (Nov 2 2026) — HECHO
- **Enriquecido de MusicBrainz** (`enrich.js` ampliado): por MBID (`--have-mbid`, los 248 álbumes identificados) rellena la **edición** (fecha/país/barcode/**sello** → tabla `label`), **géneros**, **créditos de grabación** y **obras + compositor** (`work` + `recording.work_id` + `credit` de la obra, con una petición extra por obra nueva, cacheada). Respeta 1,1 s/petición y User-Agent. La ficha de álbum muestra ahora **Sello / País / Barcode** y, por pista, **obra + compositor** (ya existía la query, ahora con datos). Esto habilita compositor/obra e info de edición de las secciones B1/B2 antes omitidas.
- **Chromecast / Google Cast** (`engine/cast.js`): protocolo **CASTV2** dependency-free — TLS a :8009, framing con prefijo de longitud + **CastMessage de Protobuf codificado a mano** (campos 1–6), namespaces connection/heartbeat/receiver/media, lanza el Default Media Receiver (CC1AD845) y le pasa la MISMA URL de `/api/stream` que DLNA. Mismo contrato que `UpnpRenderer` (connect/load/play/pause/stop/seek/volume/getState); enganchado en `/api/upnp/*` con estado `_cast`. Chromecast pasa a **castable** en el selector de zona. Round-trip de encode/decode verificado; no probado en vivo (no hay Chromecast en esta LAN, sí un DLNA Eversolo).

### Genuinamente diferido (necesita esfuerzo grande o datos/claves que no tenemos)
- **Enriquecido de MusicBrainz por búsqueda difusa** (los ~25k álbumes SIN MBID): artista+título es ruidoso y son horas a 1,1 s/req; hecho el camino fiable (por MBID). Identify wizard interactivo: pendiente.
- **AirPlay** (protocolo propietario, distinto de cast) y **RAAT** (firmado, NDA). Chromecast ya reproduce.
- **Preferencias de metadatos por-campo**; **correcciones manuales** de pistas/discos; **import date**; **localización**; keyset para offsets profundos; mapeo de géneros.

### RE profundo (Nov 2 2026, mientras corría el reescaneo del NAS) — modelo de IDENTIFICACIÓN
Fuente: `Identifier.Messages.dll` (contratos del flujo) + `Roon.Metadata.dll`/`Metadata.Messages.dll`
(preferencias/procedencia), ingeniería inversa con REA (managed static, shipped-artifact, observado).

**Contrato del wizard de identificación (namespace `Sooloos.Msg.Identifier`):**
- `IdentifyAlbumRequest { RequestId, Files[]:FileInfo, Collection, ReturnTidal, WithTrace }`
  → `IdentifyAlbumResult { IdentifyStatus, Tracks[]:TrackResult, Metadata[]:MetadataResult }`.
  **Identifica el ÁLBUM ENTERO de una vez** (todas las pistas juntas), no fichero a fichero.
- `IdentifyStatus = { Identified, TemporaryFailure, PermanentFailure, Messaging_Unknown }`
  (misma filosofía que el escáner: distingue fallo transitorio de permanente → reintentable).
- `FileInfo { FileId, Tags }`. **`Tags`** (la señal que envía por pista): `Album, Artist, AlbumArtist,
  Title, TrackNumber, MediaNumber, LengthMs, Length, Toc, TocIndex, CdSectorLength, ProductCode
  (barcode/UPC), Label, CatalogNumber, ReleaseDate, AlbumUid, IsMusic, TrackId`.
- `TrackResult { FileId, TrackId, ContentHash }` (mapea cada fichero local a la pista emparejada +
  hash de contenido). `MetadataResult { ObjectId, ContentHash, ObjectType }`.
- CD: `IdentifyTocRequest { Toc }` → `IdentifyTocResult { Success, TrackTags[] }` (disc-id por TOC).

**La clave (y por qué nuestra búsqueda difusa es ruidosa):** Roon empareja por **nº de pistas +
perfil de DURACIONES** (`LengthMs` por pista) + geometría de disco (`Toc`/`CdSectorLength`), con
`ProductCode`/`Label`/`CatalogNumber` como refuerzos — NO por texto artista+título. Es el enfoque
clásico de disc-id/álbum-fingerprint, mucho más robusto.

**Plan para el wizard de escucharrr (reemplaza la "búsqueda difusa" diferida):**
1. Agrupar las pistas del álbum (ya las tenemos por carpeta/medium) y construir el perfil:
   nº de pistas + duración (ms) de cada una (orden por track/disc). Barcode/catalog/label de tags
   si existen.
2. Consultar MusicBrainz por candidatos y **puntuar por coincidencia del perfil de duraciones**
   (suma de |Δms| por pista, tolerancia ~±4 s) + igualdad de nº de pistas; barcode/catalog como
   desempate fuerte. Para CD real, usar el disc-id/TOC de MusicBrainz directamente.
3. Presentar `identify_suggestions` ordenadas (como `IdentifyAlbumResult.Metadata[]`), elegir →
   fijar `release.mbid`/`release_group.mbid` y disparar el enriquecido por MBID que ya tenemos.
4. Estado `Identified | TemporaryFailure(reintentar) | PermanentFailure(marcar "no identificado")`.
Esto convierte los ~25k álbumes sin MBID de "horas de búsqueda ruidosa" en un match fiable por
duraciones, y encaja con `enrich.js --have-mbid` existente. Pendiente de implementar (P2).

### RE de la capa de REPRODUCCIÓN (Roon now-playing/DSP) + Plexamp (Nov 2 2026)
Mina del bundle de Roon (`ui.brooxgz`, 20,3 MB descomprimido) enfocada en now-playing/DSP/cola/
display, y del bundle de Plexamp (`app.asar` Electron, 14,4 MB) por léxico de features.

**Roon — now-playing/DSP (identificadores reales):** `component_fullscreen_nowplaying` con
PÁGINAS deslizables (`atom_nowplaying_{image,lyrics,lrclyrics,credits,review,bio,composition,disc}`);
**waveform** scrubber (`atom_waveform_bar`, `atom_waveform_slider_fg`, `WaveForming`);
**DSP** (`component_dsp`, `signal_path`×70, EQ **parametric** con bandas de color `*_peq_circle`,
`convolution`, `crossfeed`, `room_correction`, `procedural_eq`, `sample_rate_conversion`/`upsampl`,
`headroom`/`clipping`); **volume leveling**/`Loudness`/`LoudnessRange`/`album_loudness_range`/
`replaygain`; **crossfade**; **sleep timer** (`auto_sleep_*`); zonas (`group_zone`/`transfer_zone`);
radio con thumbs-down (`Gradiobar`, `bad_for_radio`).

**Plexamp — léxico (nº de runs):** download/offline 1206/103, star/rating 849/211, **mix/sonic/
sonically/similar 411/410/116/211** (análisis sónico → Instant Mix/Library Radio/similares — su
joya), radio 368, **key/tempo/bpm 274/81/6** (mezcla armónica), mood 180, **analysis 137**,
**equalizer/preamp 116/102**, loudness/replaygain/normaliz/boost/silence 92/37/20/39/81,
**nerd (stats) 83**, **visualizer 67**, **palette (de la portada) 50**, **sweet fade/crossfade/
gapless 25/9/1**, **sleep timer 26**, bit-perfect/asio/exclusive 70/31/2.

**Realidad de nuestros datos (verificado):** `credit` 10.312 (ok). PERO `gain_db`/`album_gain_db`/
`peak_dbfs`/`peaks` solo en **14 / 255.272** ficheros (las columnas existen; el análisis NO se
ha corrido sobre el NAS). `lyrics.found` = 0 (se baja bajo demanda vía LRCLIB). → nivelado de
volumen y waveform están GATEADOS por una pasada de `analyze.js` (horas sobre SMB), no son gratis.

**Las 5 siguientes (propuesta priorizada):**
1. **Pantalla "Now Playing" a pantalla completa con páginas** (carátula grande + **letra
   sincronizada LRC** + créditos + reseña + bio), modelo `component_fullscreen_nowplaying`/
   `atom_nowplaying_*` de Roon y el now-playing de Plexamp. Solo UI + endpoints existentes
   (`/api/lyrics`, `/api/album`). Barato, alto valor. **P1**.
2. **Nivelado de volumen (ReplayGain/R128)**: correr/ampliar `analyze.js` para poblar gain/peak y
   aplicar ganancia por pista/álbum en el reproductor (web + nativo) con toggle. Roon `volume
   leveling`, Plexamp `loudness leveling`. Alto valor; coste = pasada de análisis (incremental). **P1/P2**.
3. **Barra de onda (waveform) para buscar**: poblar `peaks` en la misma pasada y pintar el scrubber
   (Roon `atom_waveform_bar`; ya existe `/api/peaks`). **P2**.
4. **EQ paramétrico + Signal Path (WebAudio)**: editor de bandas (BiquadFilter) sobre `dsp_preset`
   ya guardado + panel de ruta de señal (formato/profundidad/frecuencia/ganancia/bit-perfect).
   Roon `component_dsp`/`parametric`/`signal_path`. **P2**.
5. **Pack reproducción tipo Plexamp (web, dependency-free)**: **crossfade/Sweet Fades** + **sleep
   timer** + **visualizador audio-reactivo** (AnalyserNode→canvas) + **paleta dinámica de la
   portada**. **P2/P3**.

Diferido (joya pero caro): **similitud sónica / Instant Mix** de Plexamp — necesita pipeline de
análisis de audio (loudness+espectral+tempo/clave) sobre 255k ficheros; hoy solo 337 con Chromaprint.

_Documento vivo: el RE del cuerpo compilado de las `.broo` y del modelo de datos del Core
sigue abierto; esto recoge la capa de UI (99 pantallas) a un nivel mucho más fino que antes._
