# REA profundo 2 — gaps restantes y roadmap nuevo (tras P1–P3 + rendimiento)

> 6 nov 2026. Segunda pasada de ingeniería inversa sobre `ui.broo` de Roon 2.74.1716 (BROO v1, 20,3 MB),
> con el parser reproducible `docs/roon-broo/broo-inv.mjs`. Inventario fresco confirmado: **100 componentes**
> (`component_*`), **187 strings** de UI, **1242 estilos**, **4583 drawables**. A diferencia de la 1ª auditoría
> (`roon-ux-deep-audit.md`), aquí cada supuesto gap se ha **verificado contra nuestro código** antes de
> declararlo (disciplina REA: no afirmar ausencia desde vista parcial). Mucho de lo que antes faltaba ya está.

## 0. Qué se cerró desde la auditoría 1 (verificado en vivo en :7733)

- **P1**: facetas de Focus nuevas (compilation/live/has_lyrics/duplicates/performer); unmerge persistente.
- **P2**: top tracks del artista; créditos agrupados (Intérpretes/Composición/Producción/Edición);
  performing-music-of (intérpretes del compositor).
- **P3**: fila de interpretación clásica (director/conjunto/solistas); descubrimiento heurístico
  (Selección del día, En su mejor momento); barra inferior móvil; presets de auriculares en el EQ.
- **Rendimiento**: Álbumes 4,7 s/14 MB → 3 ms/1 MB (caché+gzip); Compositores 27 s → 27 ms (índice);
  Inspector 0,9 s → 1 ms (caché); búsqueda de Pistas 480 ms → 9 ms (FTS5); arreglado el orden de Pistas (500).
- **Spotify**: enlace «Buscar en Spotify para añadirlo» en discos no guardados.

## 1. Lo que creíamos gap y NO lo es (ya implementado)

Verificado leyendo el código, para no re-trabajar:
- **Ruta de señal**: existe (página «Señal» en pantalla completa + badge de resolución que la abre;
  `/api/trackinfo`). Lo que falta es *profundidad* de presentación (ver §2.A), no la función.
- **DSP**: EQ gráfico de 7 bandas → **EQ paramétrico (hasta 16 bandas, tipo/freq/Q/ganancia)** →
  **convolución (impulso WAV)** → **preamp/headroom** → maestra. Más análisis de loudness/ReplayGain y waveform.
- **Reproducción**: crossfade y ReplayGain (modo pista/álbum) presentes.
- **Ingesta**: `tags.js` parsea FLAC, MP3, M4A, **AIFF, OGG, Opus, WAV** (el gap viejo de formatos está casi cerrado).
- **Modelo de versiones**: release_groups hermanos por MBID y por título base; `release.source_dir`.
- **Zonas de salida**: equipo (navegador), WASAPI nativo, UPnP/DLNA.

## 2. Gaps reales restantes (verificados), por tema

### A. Profundidad de audio (el terreno fuerte de Roon)
- **Signal path enriquecido**: Roon dibuja la cadena completa con un *badge por etapa* (crossfeed, headroom
  management, parametric EQ, sample-rate conversion, convolución) y un **punto de calidad** (lossless /
  mejorado / alta calidad / de baja resolución). Strings: `signal_path_Source/Equalizer/InvertPhase/Output`,
  `signal_path_header_raat`, `dsp_*_badge`. Nosotros mostramos resolución/tech, no la cadena por etapas.
- **Crossfeed para auriculares**: etapa DSP que Roon tiene (`crossfeed_badge`) y nosotros no. Encaja con los
  presets de auriculares que añadimos.
- **Ajustes por zona/endpoint** (`label__endpoint_settings_*`): modo de volumen (dispositivo/DSP/fijo),
  límite de bits por muestra, modo DSD, prioridad de clock master, resync delay, ajuste de sincronía,
  mezcla de salida. Varios son de RAAT (protocolo propietario de Roon, N/A), pero **modo de volumen**,
  **límite de bits** y **desfase de sincronía** son factibles para WASAPI/UPnP.
- **Conversión de frecuencia / upsampling** (`sample_rate_conversion_badge`): no lo hacemos (passthrough
  nativo). Discutible si merece la pena; de momento, no.

### B. Facetas de Focus que aún faltan (Roon ~34; nosotros ~28)
Factibles con datos que ya tenemos:
- `bootleg` (heurística por título/tipo), `multiple_formats` (álbum con ficheros en >1 formato),
  `has_date` (sin año), `corrupt`/no reproducible (sin `local_file` o marcado), `performance_count` (clásica).
No factibles (no guardamos ese dato): `has_liner_notes`, `has_pdf`, `has_back_cover`, `image_count`,
  `has_additional_images`, `exportable`, `mqa` (omitido a propósito).

### C. Profundidad de música clásica
- **Agrupación por interpretación** (`label__performance_grouping`): agrupar las grabaciones de una misma
  interpretación. No lo tenemos.
- **Ubicación/venue** (`work_performace_row_performed_location`): requiere ingestar relaciones *place* de
  MusicBrainz (no lo hacemos). Gap de datos, no de UI.

### D. Inicio / descubrimiento
- **«Nuevos lanzamientos para ti»** (`new_releases_for_you_tabs/dropdown`): sección de novedades en Inicio.
  Tenemos el calendario de lanzamientos y las heurísticas de Descubrir, pero no este bloque en Inicio.
- **«También de»** (`view_all_also_from`): más del mismo sello/productor/artista relacionado. Menor.

### E. Ficha de álbum/pista
- **Duración total del álbum** (`label__album_length_*`): mostrar el total h/m/s en la ficha. Fácil.
- `unmerge_composition_settings`: deshacer fusiones de *obras/composiciones*. Hoy no fusionamos obras, así que
  N/A salvo que añadamos esa función.

### F. Vistas móviles dedicadas (`phone_*`)
- Añadimos la barra inferior de pestañas (phone footer). Siguen siendo responsive-CSS, no layouts dedicados,
  las 8 vistas `phone_*` (queue, track_browser, nowplaying, dsp, work_browser, folder_browser,
  unified_search, playlist_details).

### G. Fuera del BROO (de la lista de Serge y del modelo de datos)
- **Versiones-por-carpeta** (~18% de la biblioteca): afinar cuándo dos carpetas del mismo álbum son una
  *versión* y cuándo la misma edición. Alto riesgo (acotar un álbum a un release).
- **Visualizador de audio** (Serge #8, enfocado a móvil).
- **Sync de cuenta / nube** (Serge #7).

### No aplican por diseño (local-first)
Los ~30 componentes `tidal_*`/`qobuz_*`/`kkbox_*`/`nugs_*`/`editorialplaylist_details` quedan fuera (sin
catálogo de streaming ni fuente editorial).

## 3. Roadmap nuevo priorizado

**P1 — alto valor, factible, aprovecha lo que ya hay**
1. **Signal path enriquecido**: cadena por etapas con badges (fuente → EQ → paramétrico → convolución →
   headroom → salida) y punto de calidad (lossless/mejorado/alta calidad). Ya hay página «Señal» y etapas;
   es sobre todo presentación + exponer el estado del pipeline.
2. **Facetas de Focus restantes factibles**: bootleg, multiple_formats, sin fecha, no reproducible,
   performance_count.
3. **Duración total del álbum** en la ficha.

**P2 — valor claro, algo más de trabajo**
4. **Crossfeed para auriculares** (etapa DSP) — junto a los presets de auriculares.
5. **Ajustes por zona factibles**: modo de volumen (dispositivo/DSP/fijo), límite de bits, desfase de sincronía.
6. **«Nuevos lanzamientos para ti»** en Inicio + **«También de»** en artista/sello.

**P3 — nicho, datos externos o riesgo**
7. **Clásica**: agrupación por interpretación (`performance_grouping`); venue requiere ingestar *place* de MB.
8. **Vistas móviles dedicadas** (`phone_*`) más allá del responsive.
9. **Afinar versiones-por-carpeta** (~18%, alto riesgo).
10. **Visualizador de audio** (móvil) y **sync de cuenta** — de la lista de Serge.

## 4. Veredicto

Tras P1–P3 y la pasada de rendimiento, escucharrr cubre **todas las pantallas núcleo de Roon y la mayor
parte de su UX**, con rendimiento ya sólido sobre 27K álbumes / 254K pistas. Lo que Roon aún hace mejor es,
sobre todo, **profundidad de audio** (signal path por etapas, crossfeed, ajustes finos por zona) y un puñado
de **facetas/detalles** (más Focus, duración de álbum, agrupación clásica). Nada estructural ni bloqueante:
es pulido de paridad audiófila. El mayor riesgo pendiente sigue siendo el modelo de versiones-por-carpeta.
