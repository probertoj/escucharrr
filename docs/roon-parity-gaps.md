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
- **identify / reidentify** (wizard de identificación: `identify_album`, `identify_results`, `identify_suggestions`) — ❌ (nosotros: match por tags/MBID).
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

- **Preferencias de contenido por campo** (`dialog_metadata_content_preferences`): el
  usuario elige, campo a campo, si gana el archivo o la nube. Nuestro "tus datos mandan"
  es global (user_edit SIEMPRE gana). Gap: **preferencia por-campo (archivo vs enriquecido)**. P2.
- **Localización** (`dialog_metadata_localization_preferences`): idioma de metadatos. P3.
- Identificado vs no identificado: un álbum "identificado" gana créditos/letras/portada
  de la nube; si "revert to basic info stored in your files" pierdes esa capa. Nosotros:
  todo sale de tags/Obsidian; el enriquecido externo es parcial. ◑.

---

## 6. Inspector (facetas de salud de la biblioteca)
`inspector_*`: available, banned, corrupt, duplicates, exportable, has_genres,
**identified**, media_count, storage_locations, track_count, performance_count.
Es un Focus especial para auditar la colección. Nosotros: ❌. Útil y barato con nuestros
datos (identificado=has MBID, duplicados por path, sin género, etc.). **P2**.

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
- **Pantalla de pistas (trackbrowser) → HECHO (Nov 2)**: vista "Pistas" con búsqueda/orden/paginación en el servidor (/api/tracks, dos pasadas para que el ORDER BY/LIMIT no recorra 250k ficheros; 143ms/página), scroll infinito y reproducción. Pendiente: facetas Focus de pista (bit depth/formato/década/canales — requieren faceting server-side con la paginación) y keyset para offsets muy profundos.
- **Siguiente mayor**: Focus de pista server-side; pantalla de compositor/obra (composerbrowser/workbrowser) para clásica.
- **P2** Inspector: duplicados, corrupto, sin audio, ubicaciones; "más/último reproducido"; agrupar/fusionar versiones (edit); ficheros saltados en Ajustes (tenemos el log de ENOENT del NAS); write-back de bio de artista.

Infra (Nov 2 2026): el watcher ya NO re-sincroniza el vault por nuestras propias escrituras (supresión por fichero, ~10s); los cambios externos sí. Pendiente mayor: el obsidian-sync es un pase COMPLETO del vault en una transacción (bloquea la BD); hacerlo incremental (solo la nota cambiada) es el siguiente nivel.
- **P3** Correcciones manuales de pistas/discos, fotos/booklet, clásica (obras/movimientos), import date, localización, preferencias de metadatos por-campo.

_Documento vivo: el RE del cuerpo compilado de las `.broo` y del modelo de datos del Core
sigue abierto; esto recoge la capa de UI (99 pantallas) a un nivel mucho más fino que antes._
