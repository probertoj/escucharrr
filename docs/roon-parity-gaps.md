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
1. ✅ **HECHO (Nov 3 2026)** — **Pantalla "Now Playing" a pantalla completa con páginas**
   (Carátula · Letra LRC sincronizada · Créditos · Reseña · Artista), modelo
   `component_fullscreen_nowplaying`/`atom_nowplaying_*`. En `player.js` (npfs): pestañas +
   transporte/waveform fijos; letra reutiliza `parseLRC`/`lyCache`; créditos/reseña/bio de
   `/api/album`+`/api/artist`. Nota del RE: `npfs` ya existía (carátula+waveform+cola); esto
   le añadió las páginas. Probado en vivo con Kind of Blue.
2. **Nivelado de volumen (ReplayGain/R128)**: correr/ampliar `analyze.js` para poblar gain/peak y
   aplicar ganancia por pista/álbum en el reproductor (web + nativo) con toggle. Roon `volume
   leveling`, Plexamp `loudness leveling`. Alto valor; coste = pasada de análisis (incremental). **P1/P2**.
3. ✅ **HECHO (Nov 3 2026)** — **Barra de onda (waveform) para buscar**: la pasada de análisis
   de la #2 pobló `peaks` (4485/4485 en los identificados) y el scrubber ya pintaba los picos
   (`wfSvg`) con relleno de progreso y seek al clic, en el reproductor compacto (`#npwf`) y en la
   pantalla completa (`#npfswf`). Esto le añadió la parte Roon que faltaba (`atom_waveform_slider_fg`):
   **arrastrar para buscar** (pointerdown/move/up delegados; el relleno sigue al cursor y el seek se
   aplica al soltar) + **burbuja de tiempo** flotante en hover (solo tiempo) y en arrastre;
   `progress()` se inhibe mientras se arrastra. Probado con PointerEvent reales (hover 1:02,
   arrastre 25%→75%, seek real al soltar).
4. ✅ **HECHO (Nov 3 2026)** — **EQ paramétrico + Signal Path (WebAudio)**. Ya existían el grafo
   WebAudio con EQ paramétrico (BiquadFilters), convolución y presets, y la ruta de señal (página
   "Señal", feature de la pasada anterior). Esto añade la pieza estrella de Roon
   (`component_dsp`/`parametric`/`*_peq_circle`): un **editor gráfico** sobre los mismos `peqBands`:
   curva de respuesta EXACTA (suma en dB de `BiquadFilterNode.getFrequencyResponse`, reusa el
   `AudioContext` vivo o un `OfflineAudioContext`; eje X log 20 Hz–20 kHz, eje Y ±18 dB), un punto
   de color por banda — arrastrar = freq+ganancia, rueda = Q, doble clic = añadir — con sincronía en
   vivo de curva/punto/inputs y ajuste del nodo biquad sin reconstruir el subgrafo. Probado:
   la curva hunde -6 dB justo en 2 kHz para una banda peaking 2 kHz/-6 dB.
5. ✅ **HECHO (Nov 3 2026)** — **Pack reproducción tipo Plexamp (web, dependency-free)**. El
   **crossfade** ya existía (slider 0–12 s). Esto añadió los otros tres: **sleep timer**
   (15/30/45/60 min o fin de pista, cuenta atrás en vivo + desvanecido suave de ~4 s antes de
   pausar, en el panel de audio); **visualizador audio-reactivo** (`AnalyserNode` tras la maestra,
   fftSize 2048 → canvas de 56 barras log bajo la portada del fullscreen, toggle persistido, rAF
   solo en la página Carátula); **paleta dinámica de la portada** (color dominante + acento
   vibrante en HSL legible, tiñe SOLO `#npfs` — gradiente + `--accent` acotado — el chrome intacto,
   respetando la regla de diseño). Iconos de línea nuevos: `sleep`, `visualizer`. Probado:
   acento rgb(228,58,58) de la portada, toggle persistido, sleep "30:00" y fin de pista "2:03".

Diferido (joya pero caro): **similitud sónica / Instant Mix** de Plexamp — necesita pipeline de
análisis de audio (loudness+espectral+tempo/clave) sobre 255k ficheros; hoy solo 337 con Chromaprint.

_Documento vivo: el RE del cuerpo compilado de las `.broo` y del modelo de datos del Core
sigue abierto; esto recoge la capa de UI (99 pantallas) a un nivel mucho más fino que antes._

---

## RE pasada 2 (Nov 3 2026) — descubrimiento / cola / radio / zonas / DJ → próximas 5

Segundo byte-mining enfocado en lo que las pasadas previas NO tocaron. Roon `ui.brooxgz`
(20,3 MB, 44.366 runs) y Plexamp `app.asar` (77.038 runs). Método: tabla de cadenas + léxico.

**Roon — identificadores nuevos (área : evidencia):**
- **Overview/home editorial**: `Goverview_nrfy_box_promise` (`NewReleasesForYou`), `Goverview_recents_box`,
  `ForYou`, `Discover`, `GMS_go_discover_viewall`, `new_release` (53), `recent` (156), `for_you` (24).
- **Roon Radio (continuación + feedback)**: `Gradiobar`, `Gshowradiobar`, `Gradiothumbdowntrack`,
  `Gshowthumbsdown`, `Gradiotrackid`, `start_radio` (8), `seed` (40), `bad_for_radio` (2), `thumbs` (52).
- **Tags / Bookmarks**: `GMS_go_tag_browser`/`_details`, `Gcreate_tag`/`Gaddtag_tag`/`Gremove_tag`,
  `GMS_save_bookmark`/`GMS_restore_bookmark`, `Gbookmarks`, `TagsAndFavorites` (tag 439, bookmark 81).
- **Historial**: `Ghistorybrowser`, `PlayedInTheLastDays`, `LastPlayed`, `MostPlayed`, `PlayedTracks`.
- **Búsqueda unificada**: `GMS_go_search`, `Gsearch_home_input`, `search_results`, `autocomplete` (42).
- **Clásica/obras**: `Gworkbrowser_focus_data`, `Gcomposerbrowser_focus_data`, `Ensemble`/`conductor`,
  `InterestingWorkCount`, `Gtotal_work_count` (work 523, composer 252, composition 173).
- **Zonas**: `group_zone` (14), `transfer_zone` (6), `Ungroup`, `Transferring`, `standby` (23).
- **Perfiles / sync**: `Profiles` (multi-usuario), `Gplaylistsync_{tidal,qobuz,kkbox}_timer`, `Backups`.

**Plexamp — léxico nuevo (nº runs):** **dj 564** (+ `narrat` 39, `tts` 10, `announce` 1, personas
"Sonic Sage"/"Sonic Adventure") = **DJ con voz** que presenta las pistas; **sonic/sonically 410/116**
+ **similar 211** + **mix 411** (análisis sónico → similares/mezclas); **preset 148** + **visuali 67**
(presets de visualizador); **mood 180**; **preamp 102**; **key/tempo/bpm 274/81/6** (mezcla armónica);
download/offline/cache/sync 1206/103/685/372 (sync offline — N/A local-first).

**Cotejo con escucharrr (ya existe, NO re-hacer):** auto-radio local ya está (modelo "Swim":
`maybeRadio()` extiende la cola desde el grafo vía `/api/radio?seed=&exclude=`); **tags de usuario**
(`/api/tag*`, `tag.html`) y **bookmarks** (`/api/bookmarks`) ya están; home con "Añadido
recientemente"; Historial, Buscar, Obras (mínimo), zonas native/UPnP/Chromecast.

### Las próximas 5 (propuesta priorizada) — 2–5 HECHAS (Nov 3 2026), #1 descartada por el usuario
1. ⛔ **DESCARTADA (el usuario no la quiere)** — **DJ con voz (Web Speech API, dependency-free)** — joya de Plexamp, nada equivalente en la app.
   Entre pistas (durante el hueco del crossfade) `speechSynthesis` del navegador anuncia la siguiente
   con una frase de contexto tomada de bio/reseña/créditos/año que YA almacenamos ("A continuación,
   X de Y, de su disco Z de 1975…"). Toggle + selección de voz/volumen/frecuencia en el panel de
   audio. 100% local, sin dependencias ni nube. Modelo Roon/Plexamp `dj`/`narrat`/`tts`. **P1/P2**.
2. ✅ **HECHO (Nov 3 2026, commit 7af9322)** — **Roon Radio: thumbs-down + sembrar desde aquí**. La
   continuación automática ya existía (modelo "Swim"); faltaba el bucle de feedback. `radio()` excluye
   grabaciones `bad_for_radio`; `POST /api/radio/thumbdown` fija/quita el flag (tabla `flag`,
   subject_type='recording'). Reproductor: `thumbDown()` marca y salta (quita duplicados de la cola);
   **pulgar-abajo** + **toggle de Radio** en el transporte del fullscreen; `radioFrom(albumId)` siembra
   (reproduce + enciende radio); botón "Radio" en la ficha de álbum; icono `thumb-down`. Probado: el
   thumbdown excluye la grabación del motor y salta de pista.
3. ✅ **HECHO (Nov 3 2026, commit 4300fa3)** — **Instant Mix / "más como esto"**. `mix(kind,id,n)`
   reutiliza el núcleo de similitud de la radio (géneros + artista + tier) sobre-pidiendo y aplicando
   **diversidad** (máx 3/artista, 2/álbum) para ~40 pistas; excluye `bad_for_radio`. Ruta
   `GET /api/mix?album=|artist=|track=&n=`; `playMix()`; botones "Mezcla" en álbum y artista. Versión
   factible hoy de la similitud sónica diferida (metadatos, sin pipeline espectral). Probado: mezcla de
   álbum 21 pistas / 15 artistas / tope 2+2; de artista 16.
4. ✅ **HECHO (Nov 3 2026, commit 587b6d0)** — **Transferir reproducción entre zonas**. El cambio de
   salida ya arrastraba cola+posición+estado (`setNativeMode`/`setUpnpMode` llevan `posSec`/`wasPlaying`);
   encima se añadió el modelo de zonas de Roon: **presets de zona con nombre** (localStorage) con la
   activa marcada; tocar una **transfiere** la reproducción en curso allí (`applyZone` reutiliza los
   setters); "Guardar la zona actual" y quitar. El sync muestra-a-muestra multi-room (RAAT) queda fuera.
   Probado (local): guardar/activar/transferir sin corte/borrar.
5. ✅ **HECHO (Nov 3 2026, commit 5c9fed6)** — **Overview curado**. `home()` añade **Sigue escuchando**
   (`homeRecentlyPlayed`), **Redescubre** (`discNotRecent`, sin sonar >90 días) y **Porque escuchaste X**
   (`albumsByGenreIds` sobre los géneros del artista más escuchado, excluye al propio). `home.html`
   pinta las filas con tarjetas; cada una se oculta si viene vacía. Probado: resume 12, "Porque escuchaste
   Le Mans" 12, redescubre 0 (oculta), recientes 10.

Bonus barato (pendiente): **presets de visualizador** (espectro/osciloscopio/partículas) sobre el
`AnalyserNode` que ya existe. Diferido pesado: **mezcla armónica (key/BPM/Camelot)** y **similitud
sónica espectral** completas — requieren análisis de audio sobre 255k ficheros que hoy no tenemos
(solo 337 Chromaprint). **#1 DJ con voz**: descartada por el usuario.

---

## RE pasada 3 (Nov 3 2026) — listas inteligentes / cola / atajos / vistas → próximas 5

Tercer byte-mining (Roon 44.366 runs, Plexamp 77.038). Enfoque: listas/colecciones, cola, clásica,
ajustes/atajos, vistas de biblioteca.

**Roon:** `playlist` 1127, `SmartPlaylistType`, `rules`, `G_check_playlist_duplicates`,
`Gplaylist_improver_alert` (mejorador de listas), carpetas de listas, `Gplaylistsync_{tidal,qobuz,kkbox}`;
clásica fuerte (`Composition`/`CompositionDate`/`Conductor`/`Ensemble`/`Period`/`Orchestra`/
`PerformanceCount`/`ArtistCompositions`); búsqueda (`category` 31, `autocomplete` 42, `G_search_page_filter`);
`Shortcuts`/`Keyboard`/`gesture` 23; cola (`move` 298, `reorder` 11, `add_next` 15); `device_setup` 51.
**Plexamp:** `list` 1211, `collection` 336, `smart playlist` 26, `filter` 422, `view` 387, `grid` 109,
`sort` 108; `theme` 150/`skin` 24/`blur` 86/`backdrop` 13; salida `output` 535/`device` 471/`buffer` 294/
`preamp` 102/`headroom` 26/`sample rate` 74; `cast`/`group` 204/163; `artist radio` 98; `play next` 26.

**Cotejo (ya existe):** listas básicas (`playlists.html`), tags, bookmarks (= Focus guardado),
radio/mix, zonas, overview, historial, Inspector, búsqueda FTS, cola (`queue.html`). Faltan: reglas,
densidad/orden unificados, atajos, clásica a fondo, ajustes de salida finos.

### Las próximas 5 — TODAS HECHAS (Nov 3 2026)
1. ✅ **Listas inteligentes (reglas que se autoactualizan)** — `smart_playlist` + `evalSmart` (SQL sobre
   v_album: género/década/año/tier/estrellas/favorito/tipo/añadido + post-filtro de reproducciones y
   "sin sonar en N días"; match todas/cualquiera, orden, límite), página `smartlists.html` con
   constructor de reglas + vista previa + «Reproducir todo» (`tracksForAlbums`). Commit 11763bc.
2. ✅ **Cola avanzada** — `moveInQueue` (reordenar arrastrando), `addNext`/`enqueue` («A continuación»/
   «A la cola» en la ficha de álbum), «Guardar como lista» en la cola. Commit 0ce9b4d.
3. ✅ **Atajos de teclado + overlay de ayuda** — espacio/flechas/Shift+flechas/↑↓/M/F/L/R//? en
   player.js, con guard de "no al escribir". Commit 59f880e.
4. ✅ **Vistas: densidad rejilla/lista** en la Biblioteca (toggle persistido, integrado con la
   virtualización). Orden/filtro/Focus ya existían. Commit 9153060.
5. ✅ **Ajustes de salida finos (parcial) + presets de visualizador** — preamp/headroom (nodo dedicado
   + slider en el panel DSP) y presets de visualizador (barras/espectro/osciloscopio). Prebuffer/máx
   sample-rate/exclusivo-por-dispositivo quedan para el motor nativo (diferidos). Commit 30b1290.

Diferido: **clásica/obras a fondo** (la biblioteca tiene ~5 obras; bajo ROI hoy), **temas/skins**
avanzados, **sync de listas** a Tidal/Qobuz (sin cuentas), **mezcla armónica** (key/BPM).

---

## RE pasada 4 (Nov 3 2026) — géneros/mantenimiento/temas/notificaciones → próximas 5

Cuarto byte-mining enfocado en lo último sin cubrir. **Roon:** mapeo de géneros fuerte
(`component_edit_genre_mappings`, `dialog_edit_genre_mapping`, `edit_genre_mapping_hide/option/save`,
`add_genre_mapping` — renombrar/ocultar etiquetas crudas a un género canónico); mantenimiento
(`dialog_library_maintenance`, `edit_album_reanalyze`, `edit_track_reanalyze`, `component_skipped_files`);
origen de metadatos (`import_settings_prefer_file|metadata|best`); temas/display (`current_theme`,
`themes`, `background_image_blur/spec`, `display_settings_menu`); perfiles multi-usuario fuerte
(`Profiles`, `create/edit/delete_profile`, `dialog_profile_stats_*`, `edit_move_plays_profile_row`);
`notification` 56/`alert` 267; clásica (composition 173, conductor 44, period 40, ensemble 40).
**Plexamp:** temas/skins (theme 104, color 168, palette 41, skin 20, accent 7, backdrop 13), mood 127,
armónica (key 228/tempo 56/bpm 6 — necesita análisis), dj 435 (descartado).

**Cotejo:** escucharrr tiene géneros crudos de tags (ruidosos), análisis global (no por-álbum desde la
UI), tema claro/oscuro/auto (sin color de acento), eventos SSE de biblioteca (sin toasts), single-user.

### Las próximas 5 (propuesta priorizada)
1. **Mapeo y limpieza de géneros** — renombrar etiquetas crudas a un género canónico y ocultar ruido;
   convierte "sin clasificar" en algo accionable. Alto valor con una biblioteca de 25k álbumes de tags
   dispares. Roon `component_edit_genre_mappings`/`edit_genre_mapping_hide`. **P2**.
2. **Reanálisis por álbum desde la UI** — botón que corre `analyze.js`/`waveform.js --rg` en segundo
   plano para un disco (loudness/waveform), sin tocar el escaneo global. Roon `edit_album_reanalyze`. **P3**.
3. **Temas: color de acento (+ "del disco")** sobre el claro/oscuro/auto ya existente. Plexamp
   themes/skins/accent/palette. **P3**.
4. **Notificaciones in-app (toasts)** para eventos de fondo: escaneo terminado, deseo **conseguido** vía
   Liderarrr, scrobble en cola enviado. Surfacing de SSE + estado de Liderarrr. Roon `notification`/`alert`. **P3**.
5. **Preferencia de origen de metadatos por álbum** (tus tags vs enriquecido) — el toggle grueso que la
   RE del modelo de Roon (`ContentPreferences`) reveló como real. Roon `import_settings_prefer_*`. **P3**.

Diferido: **perfiles multi-usuario** (ROI bajo en una app personal), **clásica/obras a fondo** (pocas
obras), **mezcla armónica/similitud sónica espectral** (necesitan análisis que no tenemos), **ARC/
remoto** (N/A), **DJ con voz** (descartado).
