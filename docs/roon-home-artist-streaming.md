# RE de Roon: novedades Qobuz/Tidal en el Inicio y discografía con streaming → adaptar a escucharrr↔Liderarrr

RE con REA (modelo de datos, autoridad *shipped-artifact*) + minado de cadenas del bundle de UI
`ui.brooxgz`, sobre Roon 2.74.1716. Fecha 2026-11-03.

## 1. Cómo integra Roon las novedades de Qobuz/Tidal en el Inicio

**Dos cajas en el overview, ambas personalizadas:**
- **New Releases For You (NRFY)** — widgets `Goverview_nrfy_box_promise`, `compute_nrfy_tabs_data`,
  `compute_new_releases`, `album_details_new_releases_tab`, `album_new_release`. Novedades recientes
  filtradas a tus gustos.
- **Daily Picks** — sistema `daily_picks_*`: `Gbit_supports_daily_picks`, `Gdaily_picks_day_key`
  (set estable por día), `daily_picks_new_releases_only` y `daily_picks_recently_added_only`
  (dos modos: novedades de streaming vs recién añadido a tu biblioteca), `daily_picks_performer`,
  `get_daily_picks_seed_line` / `get_daily_picks_reason_sentence` / `get_daily_picks_reason_prefix`
  (cada tarjeta lleva un **motivo**, p. ej. «Porque escuchaste…»), `seed_album`/`seed_performer`
  (semillas), `daily_picks_blacklist` (descartar).

**De dónde salen los discos:** del Core + la nube de metadatos de Roon, que **une** tu biblioteca con
los catálogos de **Tidal/Qobuz** según `PreferredStreamingService` (de `Roon.Metadata.dll`, visto en
RE previo). El modelo de identidad (REA, `Metadata.Messages.dll`, tipo `Sooloos.Msg.Metadata.AlbumLite`):
un álbum tiene `_RoonReleaseId` + **`_SourceAlbumIds`** (lista de ids por FUENTE: biblioteca, Tidal,
Qobuz) + `_ReleaseDate`/`_OriginalReleaseDate`, `_Popularity`, `_Type`. Es decir: una sola identidad de
álbum con N fuentes; «novedad de streaming» = un AlbumLite cuya fuente es Tidal/Qobuz y cuya fecha es
reciente. El icono de servicio en la fila es `track_row_tidal_icon` / `track_row_qobuz_icon_top`.

## 2. Cómo integra Roon los discos que te faltan en la ficha de artista (con streaming)

**Dos discografías superpuestas** (widgets de `artistdetails`): `library_discography` (lo que TIENES)
y `discography` = **`Ideal discography`** / **`Qobuz ideal discography`** / `Selected discography`
(todo lo que el artista editó, resuelto desde metadatos + catálogo de streaming). Secciones
`local_main_albums`, `show_all_main_albums`, `show_all_other_albums`, `appears_on_albums`,
`get_artist_recent_releases`. La discografía se arma con `build_discography_items` sobre las relaciones
`Sooloos.Msg.Metadata.AlbumRelationship` (`_RelationshipType`, `_Basis`, `_AuthoringReleaseId`, `_Sequence`).

**Lo que no posees:** se pinta **en gris / insensible** (`atom_tile_grey`, `bounding_box_grey4_insensitive`,
`atom_track_geek_grey_link`) con el icono del servicio, y es **reproducible en streaming** porque existe
un `_SourceAlbumId` de Tidal/Qobuz (datos de pista en `TidalTrackData`). Acción para «hacerlo tuyo»:
**`add_to_library`** (`album_add_to_library`, `album_version_add_to_library`, `add_menu__can_add_to_library`,
`add_menu_show__in_library`, `selection_supports_add_to_library`) — importa esa edición de streaming a tu
biblioteca. Por versión: «TIDAL versions» / «Qobuz versions».

**Resumen del mecanismo Roon:** identidad de álbum única con multi-fuente → el Inicio y la discografía
muestran TODO (tengas o no), lo no-poseído gris pero **oíble al instante por streaming**, con un botón que
lo **añade a tu biblioteca**.

---

## Cómo adaptarlo a escucharrr ↔ Liderarrr

escucharrr reproduce solo lo que posees y **no tiene derechos de streaming** de Tidal/Qobuz. La
traducción fiel cambia «oír en streaming al instante» por «**pedirlo y que Liderarrr lo consiga**» —
que ya tenemos cableado (`POST /api/liderarrr/wanted`). El rol de «catálogo externo» de Tidal/Qobuz lo
hace **Liderarrr** (sabe qué hay fuera: novedades de artistas seguidos, discografía completa, afinidad).

### A. Novedades en el Inicio (= NRFY + Daily Picks)
Añadir al `home.html` una fila **«Novedades para ti»** y, opcionalmente, **«Elegidos del día»**:
- **Datos:** ya existen vía el puente. `GET /api/liderarrr/newreleases` (novedades de tus artistas
  seguidos; trae `release_date`, `cover`, `owned`) y `GET /api/liderarrr/globalreleases` (afinidad; trae
  **`reason`** = «Sigues a X» / «En tu sello Y» — exactamente la *reason_sentence* de Roon, ya hecha).
- **Daily Picks estable por día:** como `Gdaily_picks_day_key`, sembrar un PRNG con la fecha para elegir
  siempre los mismos ~8 de globalreleases ese día (rotación diaria, sin pedir nada nuevo al abrir).
- **Acción por tarjeta:** si `owned` → reproducir (resolver a rg_id con `/api/liderarrr/resolve`); si no →
  **«Quiero»** (el análogo de `add_to_library`: en vez de añadir una edición de streaming, Liderarrr lo
  **descarga** y acaba siendo un álbum real reproducible). Estado por `wanted/keys` (vigilando/pedido/en disco).
- **Descartar:** como `daily_picks_blacklist`, un «no me interesa» → `POST /api/liderarrr/globalreleases/:id/dismiss`.

### B. Discografía del artista con lo que te falta
En `artist.html`, además de «Discografía» (lo que tienes) mostrar la **discografía ideal** y marcar los huecos:
- **Fuente de la discografía completa** (dos opciones, elegir una):
  1. **Liderarrr** es un panel de *completismo*: ya sabe, por artista, qué tienes y qué te falta. Lo ideal
     es exponer en Liderarrr un endpoint tipo `GET /api/artist/:mbid/discography` (tiene `tracked`,
     `discography.js`, `editions.js`) y que escucharrr lo pinte. (Requiere un pequeño añadido en Liderarrr.)
  2. **MusicBrainz** (ya lo usamos en `enrich.js`): pedir los release-groups del artista por su MBID y
     **resolver contra tu biblioteca** con el `matchKey` que ya replicamos (`/api/liderarrr/resolve` o uno
     equivalente local). Cero cambios en Liderarrr; respeta el límite 1,1 s/UA.
- **Render (como Roon):** los que posees, en sólido y reproducibles (link a la ficha / ▶); los que faltan,
  **en gris** con `release_date`/año y un botón **«Quiero»** (= `add_to_library` de Roon, pero asíncrono:
  al conseguirlo Liderarrr, deja de estar gris y pasa a reproducible). Estado por `wanted/keys`.
  Secciones «Álbumes principales» / «Aparece en» / «Otros», como `main_albums`/`appears_on`/`other`.
- **«Streaming» honesto:** escucharrr no puede reproducir lo que no tienes. Dos caminos, no excluyentes:
  (a) el real de la integración — **«Quiero» → Liderarrr lo adquiere → se vuelve reproducible**; (b) un
  enlace de *preview* externo (las novedades ya traen `url` de Deezer) para escuchar fuera mientras llega.

### Mapa de equivalencias
| Roon | escucharrr ↔ Liderarrr |
|---|---|
| `AlbumLite._SourceAlbumIds` (biblioteca + Tidal + Qobuz) | álbum en tu biblioteca (reproducible) **o** conocido solo por Liderarrr/MB (hueco → «Quiero») |
| NRFY / Daily Picks (nube + streaming) | `/api/liderarrr/newreleases` + `/api/globalreleases` (con `reason`) |
| `add_to_library` (añade edición de streaming) | `POST /api/liderarrr/wanted` (Liderarrr lo **descarga**; asíncrono) |
| `Ideal discography` / `Qobuz ideal discography` | discografía MB del artista (o endpoint de Liderarrr) resuelta contra tu biblioteca |
| Tarjeta gris + icono de servicio | hueco en gris + estado de «Quiero» (vigilando/pedido/en disco) |
| `daily_picks_blacklist` | `globalreleases/:id/dismiss` |

**Diferencia irreductible:** Roon **reproduce** al instante lo que no tienes (licencia Tidal/Qobuz);
escucharrr lo **pide** y Liderarrr lo **consigue** (minutos/horas). El resto del patrón —identidad única,
mostrar todo, marcar huecos, un botón para «hacerlo tuyo», motivos de recomendación— se replica entero.

_Fuentes: REA `inspect_managed_artifact`/`inspect_managed_members` sobre `Metadata.Messages.dll`
(sha256 484a4632…e87995) y minado de `ui.brooxgz`. Nada ejecutado; análisis estático._
