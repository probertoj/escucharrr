# REA profundo de Roon UI/UX vs escucharrr — auditoría fina y roadmap nuevo

> 5 nov 2026. Re-extracción directa del `ui.broo` de Roon 2.74.1716 (formato BROO decodificado al 100%, ver
> `roon-broo-format.md`). Inventario real: **100 componentes** (`component_*`), **187 strings** de UI,
> **4583 drawables** (iconos), **1242 estilos**. Este documento compara CADA componente y los textos finos de
> la interfaz con lo que tenemos, y deriva un roadmap priorizado. Método: parser reproducible
> `docs/roon-broo/broo-inv.mjs` (ns `component`/`string`), sobre el `ui.broo` crudo (BROO v1, 20,3 MB).

## 1. Matriz de cobertura por componente (100)

### Cubiertos (pantallas núcleo) — 1:1 o equivalente
| Roon component | Nuestra pantalla |
|---|---|
| album_browser / album_details | index.html / album.html |
| all_albums / all_albumversions | biblioteca + versiones por álbum |
| artist_browser / artist_details | artist.html |
| composer_browser | **composers.html (nuevo esta ronda)** |
| work_browser / work_details | works.html / work.html |
| genre_browser | genres.html |
| tag_browser / tag_details | tags |
| playlist_browser(_v2) / playlist_details | playlists.html / playlist.html |
| track_browser | tracks.html |
| folder_browser / folderbrowsertoplevel | folders.html |
| history_browser | history.html |
| home | home.html |
| explore / view_all_discover | discover.html |
| unified_search | search.html |
| queue | queue.html |
| settings / import_settings | settings.html |
| dsp | panel DSP del player |
| fullscreen_nowplaying | fullscreen |
| sidebar / topbar / footer | nav.js + barra del player |
| mix_details | Instant Mix (playMix) |
| edit_genre_mappings | genremap.html |
| skipped_files | **Ajustes → ficheros saltados (nuevo esta ronda)** |
| internetradio_browser/_category_details/_details/_library | **radio.html → Explorar emisoras (nuevo esta ronda)** |
| view_all_collaboration_tracks / view_all_related_artists | **ficha artista: Colaboraciones + Afines (nuevo esta ronda)** |
| view_all_collaboration_albums | ficha artista: «Apariciones» |
| recents_tabs / new_releases_for_you_* | secciones de Inicio |

### No aplican (local-first; servicios de streaming de pago) — 30 componentes
`tidal_*` (13), `qobuz_*` (5), `kkbox_*` (4), `nugs_*` (8) y `editorialplaylist_details`. Fuera de alcance por
diseño (no hay fuente editorial ni catálogo de streaming). `view_all_nugs_search_results` ídem.

### Internos / sin equivalente de usuario — 4
`atom_component_library` (librería de componentes de dev), `loading_bookmark`, `message_hero`, `alertbar` /
`radio_alert` (nuestros toasts cubren el aviso).

### Faltantes o parciales (lo accionable) — ver §2/§3
`artist_toptracks`, `unmerge_artist_settings`, `unmerge_composition_settings`, `view_all_also_from`,
`view_all_artists_with_works`, `view_all_daily_picks`, `view_all_in_their_prime`, `view_all_listen_later`,
`view_all_performing_music_of`, y los `phone_*` (8 componentes de móvil dedicados).

## 2. Gaps finos revelados por los 187 strings de UI

### 2.1 FOCUS facetado — el gap grande (P1)
Roon expone ~34 facetas (`label__focus_cart_*`). Nosotros tenemos **23** (tier, género, formato, sello, país,
profundidad, frecuencia, canales, década, añadido, último play, reproducciones, tipo, etiqueta, favoritos,
escuchar más tarde, audio local, reproducido, identificado, con género, con versiones, multidisco, oculto) +
rango de año y de rating. **Nos faltan** facetas que Roon sí tiene y que son fáciles con nuestros datos:
- `compilation` (recopilatorios VA) — **tenemos el dato `isComp`**, trivial.
- `live`, `bootleg` — por tipo de release / título.
- `has_lyrics` — tenemos letras en algunas pistas.
- `duplicates`, `corrupt`, `multiple_formats` — mantenimiento (enlaza con ficheros saltados).
- `performer`, `performance_count` — clásica (créditos de intérprete).
- `bans` (≈ nuestro `bad_for_radio`).
- `mqa` — lo omitimos a propósito (formato propietario en desuso).

### 2.2 Créditos de álbum agrupados (P2)
Roon agrupa los créditos en 4 cabeceras (`label__credits_header_credits/performers/production/release`).
Nosotros mostramos «Créditos» pero sin esa estructura. Gap de presentación.

### 2.3 Profundidad de música clásica (P2/P3)
Strings: `work_composed_by`, `work_performace_row_performed_ensemble/location`, `performed_by`,
`performance_grouping`, + componentes `view_all_performing_music_of`, `view_all_artists_with_works`.
Tenemos obras + compositores (esta ronda), pero NO: filas de interpretación con conjunto/lugar, agrupación por
interpretación, ni «intérpretes que tocan a este compositor». Nicho pero es donde Roon brilla.

### 2.4 Top tracks del artista (P2)
`component_artist_toptracks` + `label__artist_all_albums`: Roon muestra las pistas más populares del artista en
su ficha. **No lo tenemos** (mostramos discografía/apariciones/colaboraciones/obras, no «top»). Con nuestros
`play_count` es directo.

### 2.5 Unmerge como pantalla persistente (P2)
`component_unmerge_artist_settings` + `component_unmerge_composition_settings`: Roon tiene una PANTALLA de
ajustes que lista las entidades fundidas y permite deshacerlas en cualquier momento. Nosotros tenemos
deshacer-merge pero **transitorio** (toast de 9s) — la tabla `merge_undo` ya guarda el historial; faltaría
surfacearlo como lista en Ajustes (deshacer cuando quieras, no solo justo después).

### 2.6 Recomendación / descubrimiento editorial (P3, limitado)
`view_all_daily_picks`, `view_all_in_their_prime`, `view_all_also_from`, `view_all_listen_later`. «In Their
Prime» y «Daily Picks» dependen de datos editoriales de Roon; podemos aproximarlos con heurística local
(década más reproducida, picks por afinidad). «Listen later» ≈ nuestro bookmark/cola; «Also from» ≈ más del
sello/artista.

### 2.7 Móvil dedicado (P3)
Roon tiene 8 componentes `phone_*` (dsp, footer, queue, track_browser, work_browser, playlist_details,
fullscreen_nowplaying, folder_browser, unified_search). Nuestra estrategia es responsive-CSS (una sola vista
que se adapta). Gap conocido: layouts optimizados para móvil, no solo CSS fluido.

### 2.8 DSP headphone presets (P3, nicho)
~30 strings `label__header_audeze_*`: presets de ecualización por modelo de auriculares Audeze. Muy de nicho;
nuestro EQ/convolución ya cubre lo genérico.

## 3. Roadmap nuevo priorizado

**P1 — alto valor, datos ya disponibles**
1. **Focus: facetas que faltan** — compilation (VA), live, has_lyrics, duplicates/multiple_formats, performer.
   La más barata y útil: `compilation` (ya tenemos `isComp`).
2. **Unmerge persistente** — pantalla en Ajustes que lista `merge_undo` y permite deshacer cuando quieras
   (Roon `unmerge_*_settings`). El backend de undo ya existe.

**P2 — valor claro, algo de trabajo**
3. **Top tracks del artista** — sección «Más escuchadas» en la ficha, con `play_count` (component_artist_toptracks).
4. **Créditos de álbum agrupados** — Intérpretes / Producción / Composición / Edición (4 cabeceras de Roon).
5. **Performing music of / artists with works** — desde la ficha de compositor, los intérpretes que lo tocan.

**P3 — nicho o dependiente de datos externos**
6. **Profundidad clásica** — filas de interpretación (conjunto/lugar), agrupación por interpretación.
7. **Descubrimiento aproximado** — daily picks / in-their-prime con heurística local (sin datos editoriales).
8. **Vistas móviles dedicadas** — más allá del responsive-CSS.
9. **Presets de auriculares en DSP** — nicho.

## 4. Veredicto
Las **pantallas núcleo están cubiertas** y esta ronda cerró los gaps de componente que quedaban (compositores,
colaboraciones/afines, ficheros saltados, radio por emisoras, fundir tracklists, unmerge de artistas). Lo que
Roon aún hace y nosotros no es sobre todo **fino**: más facetas de Focus, créditos agrupados, top tracks,
profundidad clásica y vistas móviles dedicadas. Nada de eso es estructural ni bloqueante; es pulido de paridad.
Los ~30 componentes de Tidal/Qobuz/KKBox/nugs quedan fuera por diseño (local-first).
