# Roon (producto final) vs escucharrr — repaso punto a punto

> Repaso del **1-nov-2026**, con **ingeniería inversa de la Roon instalada** (build 2.74.1716), no de
> marketing. Fuentes: el bundle de UI `ui.brooxgz` (descomprimido → inventario real de **95 pantallas
> `.broo`** y sus strings), los exports de `roonmedia.dll` (motor/DSP), `raatmanager.dll` (transporte RAAT)
> y los ensamblados `Roon.Broker.*` (servicios/licencia). El estado de escucharrr se audita leyendo el repo
> (páginas, rutas `/api`, `data-layer/`, `engine/`), no de memoria. Leyenda: **✅ hecho · 🟡 parcial · ❌ no**.

Evidencia RE de las pantallas de Roon (muestra del inventario `.broo`): `albumbrowser/albumdetails`,
`artistbrowser/artistdetails`, `composerbrowser`, `workbrowser/workdetails`, `playlistbrowser/details`,
`tagbrowser/tagdetails`, `trackbrowser`, `genrebrowser`, `radiobrowser/internetradiodetails`,
`folderbrowser/filebrowser`, `focus`, `search/desktopsearch/phonesearch`, `queue/phonequeue`,
`historybrowser`, `home`, `explore`, `dailypicksviewall`, `listenlaterviewall`, `edit`, `correction`,
`import`, `backup`, `sync`, `device_setup`, `profiles`, `login`, `settings(_audio/_dsp/_library/_storage/_about)`,
`socialshare`, `tidal/qobuz/kkbox/nugs` (+ variantes desktop/phone), `editorialplaylistdetails`.

---

## 1. Biblioteca y navegación

| Función Roon (RE) | Cómo es en Roon | escucharrr | Veredicto |
|---|---|---|---|
| Navegadores de álbum/artista/pista/género | `albumbrowser`, `artistbrowser`, `trackbrowser`, `genrebrowser` | páginas album/artist/genre/library | ✅ |
| **Focus** (facetas) | `focus.broo` — facetas combinables, guardables | Focus por tier/género/etiqueta/década/tipo/formato/valoración | ✅ (menos facetas que Roon, que añade "grabado en", sello, forma…) |
| **Tags** de usuario | `tagbrowser/tagdetails` | tags libres + faceta + `tag.html` | ✅ |
| **Marcadores** (Focus guardado) | bookmarks (Focus/vista guardada) | `/api/bookmarks` + barra de marcadores | ✅ |
| Búsqueda | `search` global (artistas/álbumes/pistas/compositores/obras) | `/api/search` FTS5 por prefijo (artista/álbum/pista) | 🟡 (falta compositor/obra/tag/playlist en resultados) |
| **Historial** de escucha | `historybrowser` — qué y cuándo | tabla `play` registra escuchas; **sin pantalla de historial** | 🟡 |
| Home / Explore / Daily Picks | `home`, `explore`, `dailypicksviewall` | home + discover (sugerencias del propio grafo) | 🟡 (sin "daily picks" editoriales) |
| Navegador de carpetas/ficheros | `folderbrowser/filebrowser` | — | ❌ (no hace falta: modelo relacional, no de carpetas) |

## 2. Metadatos, modelo y clásica

| Función Roon (RE) | Cómo es en Roon | escucharrr | Veredicto |
|---|---|---|---|
| Modelo relacional rico | grafo propio (artistas/álbumes/obras/créditos) | grafo estilo MusicBrainz (artist/credit/release_group/…​) | ✅ |
| **Créditos por rol** | créditos navegables | tabla `credit` por rol (instrumento/voz/producción…) desde MB + Discogs | ✅ |
| Identificación de álbum | metadata server propio + fingerprint **mel** (`roon_mel_*`, audiosignaturecensus) | `identify.js` (AcoustID/Chromaprint) + `enrich.js` (MusicBrainz) | 🟡 (equivalente abierto; sin census propio) |
| **Clásica: compositor + obra** | `composerbrowser`, `workbrowser`, `workdetails` — modelo obra/interpretación | `works.js` + `work.html`: obra por pista, compositores, versiones; "Obras" en el artista | 🟡 (núcleo hecho; faltan movimientos/partes de obra y un navegador de compositores dedicado) |
| Editorial (bios/reseñas) | editorial licenciado | `editorial.js` (Wikipedia vía Wikidata) + Obsidian manda | ✅ (fuentes abiertas) |
| Edición/corrección de metadatos | `edit.broo`, `correction.broo` (identificar, agrupar, corregir) | override por `user_edit` + Obsidian; **sin UI de edición/corrección** | 🟡 |
| "Tus datos mandan" / procedencia | — | provenance + user_edit ganan a lo externo | ✅ **(ventaja nuestra)** |

## 3. Reproducción, cola y radio

| Función Roon (RE) | Cómo es en Roon | escucharrr | Veredicto |
|---|---|---|---|
| Cola + "a continuación" | `queue.broo` | cola persistente + pantalla "Ahora suena" con "a continuación" | ✅ |
| **Roon Radio** (sin fin) | radio por IA desde tu biblioteca+streaming | `/api/radio` (radio desde el grafo, autoplay) | 🟡 (heurística propia, no IA/nube) |
| Internet radio (emisoras en vivo) | `radiobrowser`, `internetradiodetails`, categorías | `radio.html` + proxy ICY (`/api/radio/*`), modelo `is_live`, "ahora suena" por ICY/SSE | ✅ (emisoras propias por URL; falta directorio curado y salida nativa/UPnP) |
| Crossfade / gapless | DSP de crossfade/fade | crossfade (web) + **gapless real** (UPnP SetNextURI; nativo reutiliza motor) | ✅ |
| Volume leveling | normalización por pista/álbum | ReplayGain R128 pista/álbum/off (`analyze.js`) | ✅ |
| **Waveform** (barra de onda) | onda en "ahora suena" | `waveform.js` (picos ffmpeg) + onda en el player | ✅ |
| Letras | — (Roon muestra letras) | `lyrics.js` (LRCLIB) sincronizadas tipo karaoke | ✅ |

## 4. Motor de audio y DSP

Roon (`roonmedia.dll`, exports): **decoders** FLAC/ALAC/AIFF/DFF/DSF(DSD)/OGG/Opus/WAV + AAC/MP3/WMA(MediaFoundation);
**polyphase resample SSE**, **convolución** (`roon_convolution_*`), **IIR/parametric EQ** (`roon_iir_*`),
**DSD** (`roon_dsd2pcm`, `roon_sdm`, dsd_lpf), **dither** (`roon_dsp_truncate_dither`), **remix/channel map**,
**invert phase/polarity**, **crossfeed**, **headroom**, **MQA** (core decoder). Ajustes (`settings_dsp`):
sample_rate_conversion_mode, upsampling, parametric EQ (guardable), convolution/room_correction, crossfeed,
headroom, DSD output gain, channel mapping, exclusive/integer/event mode, resync_delay, bit-perfect.

| Capacidad | Roon | escucharrr (`engine/`) | Veredicto |
|---|---|---|---|
| Decodificación | propia (soom) + MediaFoundation | **ffmpeg** (FLAC/WAV/MP3/M4A/OGG/Opus/AIFF) | 🟡 (dependemos de ffmpeg; decoders propios = pendiente) |
| Salida de baja latencia exclusiva | WASAPI/ASIO/CoreAudio… exclusivo/integer/event | **WASAPI** compartido + **exclusivo (bit-perfect)** | 🟡 (solo Windows; sin ASIO; integer sin DAC para verificar) |
| Resample alta calidad | polyphase SSE | **sinc Kaiser polifásico** (banda plana ~20 kHz, alias ~−100 dB) | ✅ |
| Dither | truncate dither | **TPDF** en la ruta entera | ✅ |
| **EQ paramétrico** | IIR paramétrico, guardable | **EQ de 7 bandas** (biquad RBJ) fijo | 🟡 (no paramétrico libre ni guardable) |
| **Convolución / corrección de sala** | `roon_convolution_*` + room_correction | — | ❌ **(hueco)** |
| **DSD** (reproducir .dsf/.dff, DSD→PCM, SDM) | sí | — (ffmpeg podría, pero no integrado) | ❌ |
| **MQA** | core decoder + device support | — | ❌ (propietario; probablemente no lo queramos) |
| Crossfeed (auriculares) | sí | — | ❌ |
| Headroom / limitador | sí | límite por pico (peak_dbfs) | 🟡 |
| Invert phase / polarity, channel mapping | sí | — | ❌ (menor) |

## 5. Zonas, multi-room y dispositivos

| Función Roon (RE) | Cómo es en Roon | escucharrr | Veredicto |
|---|---|---|---|
| Transporte a endpoints de red | **RAAT** (SOOD/UDP 9003, PCM/FLAC con reloj+drift, firma de código) — cerrado/certificado | **UPnP/DLNA** (AVTransport, descubrimiento SSDP) | 🟡 (vía abierta; RAAT no replicable) |
| **Enviar al Eversolo** | Roon Ready (RAAT) | **UPnP/DLNA** verificado en vivo (DMP-A6) + gapless | ✅ (por la vía abierta) |
| Salida local de este equipo | zona del core | zona navegador (Web Audio) + **zona WASAPI nativa** | ✅ |
| **Multi-room sincronizado** (varias zonas a la vez, un reloj) | sí (RAAT) | — | ❌ **(hueco; requeriría Snapcast u otra infra)** |
| Agrupar zonas / setup de dispositivos | `device_setup`, grouping | selector de salida por zona; **sin agrupar ni setup avanzado** | 🟡 |
| AirPlay / Chromecast | sí | — (el Eversolo los tiene; nosotros aún no) | ❌ |

## 6. Servicios de streaming

| Función Roon (RE) | Cómo es en Roon | escucharrr | Veredicto |
|---|---|---|---|
| Tidal / Qobuz / KKBox / Nugs | integración completa (`tidal/qobuz/kkbox/nugs.broo`): buscar, biblioteca, reproducir integrado | — | ❌ |
| Spotify | Roon **no** integra Spotify | **comparar** tu biblioteca local con tus álbumes **guardados** en Spotify (solo lectura) | ✅ **(enfoque propio; falta conectar tu cuenta)** |
| Playlists editoriales | `editorialplaylistdetails` | — | ❌ |

## 7. Listas, scrobbling, social

| Función | Roon | escucharrr | Veredicto |
|---|---|---|---|
| Playlists | crear/editar; **import/export** | crear/añadir/reordenar/renombrar/borrar + **export/import M3U** | ✅ |
| Scrobbling | Last.fm | **Last.fm + ListenBrainz** (cola local, reintentos) | ✅ |
| Compartir | `socialshare.broo` | — | ❌ (menor) |

## 8. Gestión de biblioteca, cuenta e infraestructura

| Función Roon (RE) | Cómo es en Roon | escucharrr | Veredicto |
|---|---|---|---|
| Carpetas vigiladas / importación | `import.broo`, watched folders | `watch.json` + watcher en vivo (reescanea/sincroniza por SSE) | ✅ |
| **Copia de seguridad / sync** | `backup.broo`, `sync.broo` | — (la BD es un fichero; sin backup/restore en la UI) | 🟡 |
| **Perfiles** (multiusuario) | `profiles.broo` | — (un solo perfil) | ❌ |
| Cuenta / licencia / nube | SSO + **machine allocation** (asignación de equipos) + heartbeat; Curve25519/HMAC-SHA512 | **nada** — local-first, sin login ni gate | ✅ **(ventaja: "Roon se interrumpe", nosotros no)** |
| Acceso remoto (ARC) | app propia + relay | — | ❌ |
| Fuente Obsidian | — | sincroniza un vault (bio/tier/rating; notas mandan) + poda al borrar | ✅ **(ventaja nuestra)** |

## 9. Diseño / UI (directriz del usuario, 1-nov-2026)

| Aspecto | Roon | escucharrr | Veredicto |
|---|---|---|---|
| Estética | editorial, iconografía **monocroma** consistente, mucha carátula | skin editorial propio (serif, tiers, fondo blanco) **pero** con **emojis de Claude** (🏠📚🎚🔈★…) en sidebar/barra/menús | ❌ **(corregir: fuera emojis; iconos de línea monocromos; recuperar los mockups)** |
| Pantalla "ahora suena" | inmersiva | overlay a pantalla completa (carátula/onda/transporte/cola) | ✅ (falta pulir a la estética Roon, sin emojis) |
| Vistas móviles | `phone*` dedicadas | responsive, sin vistas móviles dedicadas | 🟡 |

---

## Resumen para decidir

**Ya estamos a la par o por delante** en: navegación + Focus + tags + marcadores, créditos por rol, editorial
abierta, ReplayGain, crossfade/**gapless**, **waveform**, letras, playlists + **M3U**, scrobbling (2 servicios),
carpetas vigiladas en vivo, **salida de red al Eversolo (UPnP) con gapless**, salida **WASAPI nativa** con
**resample Kaiser + dither**, y —ventajas que Roon no tiene— **sin gate de licencia/nube**, **Obsidian manda**,
y **comparar con tu biblioteca de Spotify**.

**Huecos reales frente a Roon (candidatos a decidir), de más a menos "Roon-defining":**
1. **Diseño fiel a Roon** — quitar los emojis de Claude de menús/sidebar/barra, iconos de línea monocromos,
   recuperar los mockups. *(Directriz del usuario; primero.)*
2. **Clásica: compositor + obra** (`composerbrowser/workbrowser/workdetails`) — modelo obra/interpretación.
3. **DSP avanzado**: **EQ paramétrico** guardable + **convolución/corrección de sala** (ranura del motor
   nativo; difícil de verificar sin impulso/medición/DAC) + **DSD**.
4. **Multi-room sincronizado** (varias zonas con reloj común; Snapcast u otra infra) + AirPlay/Chromecast.
5. **Servicios de streaming** (Tidal/Qobuz — reproducción integrada; requieren cuentas/SDK).
6. **Internet radio** (emisoras en vivo) — relativamente barato.
7. **Historial** (pantalla), **perfiles**, **backup/restore**, **edición/corrección** de metadatos en la UI,
   **acceso remoto**.

**No perseguir** (propietario/cerrado o contra el ethos): **RAAT** (certificado), **MQA** (propietario),
la nube/licencia de Roon, el census de audio propio.
