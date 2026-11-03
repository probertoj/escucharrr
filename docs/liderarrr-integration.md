# escucharrr ↔ Liderarrr — integración (retos · calendario · «Quiero»)

Diseño para traer a escucharrr tres ideas de **Liderarrr** (panel de *completismo*,
`github.com/probertoj/Liderarrr`): **retos de escucha**, **calendario de lanzamientos** y el
**botón «Quiero»**. Basado en la RE del código real de Liderarrr (v1.3), clonado y leído el
2026-11-03.

## Principio: dos apps, dos trabajos

- **escucharrr** = *escuchar lo que tienes* (local-first, dependency-free, con historial de
  reproducción propio). Sabe qué **posees** y qué has **oído**.
- **Liderarrr** = *conseguir y ordenar lo que te falta* (Docker, trackers/indexers, descarga).
  Sabe qué hay **ahí fuera** y lo **adquiere**.

La integración respeta esa frontera: escucharrr se queda con la cara de **escucha** (nativa, sin
depender de Liderarrr) y **puentea** a Liderarrr para la cara de **adquisición** (calendario real +
«Quiero» que de verdad descarga). Todo opcional: si no hay Liderarrr, hay un modo nativo degradado.

## Cómo lo hace Liderarrr (modelo real, citado)

**Retos** (`server/src/challenges.js`): listas pegadas de «Artista - Álbum» (1001 Albums, RS500,
charts de RYM — detecta la línea `… - …, Cover art`). Tablas `challenges(id,name,source,item_count,
added_at,hidden)` + `challenge_items(challenge_id,position,artist,album,year,owned_album_id)`. Cruza
cada ítem contra la biblioteca (`matchKey(artista,título)` → `owned_album_id`) y contra los scrobbles
(`listens` de lastfm/listenbrainz) para «lo has oído». Progreso = `owned/item_count`. API:
`GET/POST /api/challenges`, `/api/challenges/membership` (para el botón «añadir a reto» de un disco),
`/api/challenges/next-listens`, `/api/challenges/:id/m3u` (exporta a lista reproducible).

**Calendario** (`server/src/newreleases.js`, `radar.js`, `globalradar.js`): por cada **artista
seguido** (`tracked_artists`) pide la discografía reciente a **Deezer** (sin API key; `release_date`,
`record_type` album/ep/single) y marca lo que **no** tienes y MusicBrainz aún no lista → sale antes que
en ningún sitio; se poda solo cuando lo alcanzas. `is_upcoming = release_date > hoy`. Tablas
`external_releases`, `global_releases`, `radar_items`. API: `GET /api/newreleases`,
`/api/globalreleases`, `/api/radar`, `GET /api/tracked`.

**«Lo quiero»** (`db.js`, tabla `wanted_albums`): lista de deseos **vigilada**. Columnas clave:
`match_key UNIQUE, artist, title, rg_mbid, year, release_date, cover, origin (busqueda|calendario|
radar), status (watching|grabbed|owned), tries, last_reason`. Un barrido (`/api/wanted/run`) la busca
en los indexers hasta encontrarla y la descarga sola (p. ej. un disco que sale el viernes de madrugada
aparece bajado por la mañana). API: `GET /api/wanted`, `/api/wanted/keys` (match_keys, para pintar
estado), `POST /api/wanted`, `/api/wanted/remove`, `/api/wanted/run`.

---

## Qué construir en escucharrr

### 1. Retos de escucha — **nativo** (encaja perfecto)

escucharrr ya tiene biblioteca (`release_group`) **y** historial (`play`), así que puede computar lo
que Liderarrr no tiene fácil: **% oído** de primera clase, no solo % poseído.

- **Datos**: `challenge(id, name, source, item_count, added_at, hidden)` +
  `challenge_item(challenge_id, position, artist, album, year, rg_id)`. `rg_id` se resuelve contra
  `v_album` por artista+título normalizado (reusar el `baseTitle`/normalización ya existente).
- **Oído**: un ítem cuenta como «oído» si su `rg_id` tiene alguna fila en `play` (o ≥N pistas del
  álbum reproducidas). Dos anillos por reto: **tienes** (rg_id no nulo) y **oídos**.
- **Parser**: portar `parseList` (incluye el ancla `…, Cover art` de RYM, numeración, año final).
- **UI**: página `retos.html` (rejilla de retos con anillo doble + %); ficha de reto con la lista
  (poseído/oído/falta), **reproducir los que tienes** y **«Reto radio»** (cola con los poseídos +
  autoplay afín). Botón **«Añadir a reto»** en la ficha de álbum (usa un `membership` como Liderarrr).
- **Fuente**: pegar texto (como Liderarrr) y, si hay Liderarrr conectado, **importar sus retos** por
  `GET /api/challenges` (y reproducir vía su `m3u`).
- **Sin dependencias**: todo en `node:sqlite`.

### 2. Calendario de lanzamientos — **puente primero**, nativo degradado

- **Con Liderarrr conectado**: página `lanzamientos.html` que lee `GET /api/newreleases` +
  `/api/globalreleases` (próximos vs recientes por `release_date`). Cada ítem: si lo tienes → enlaza a
  la ficha; si no → botón **«Quiero»**. Seguir/dejar de seguir artista puentea a `/api/tracked`.
- **Sin Liderarrr (nativo degradado)**: discografía reciente vía **MusicBrainz** (que ya usamos en
  `enrich.js`) de tus **artistas más escuchados** (del historial) → novedades que no posees. Respeta
  el rate-limit 1,1 s/UA que ya tenemos. Sin Deezer para no añadir dependencia/clave (se puede sumar
  después, es sin key).
- **Agenda**: agrupar por mes/semana; marcar `próximamente` lo de fecha futura.

### 3. Botón «Quiero» — **wishlist local + puente**

- **Local siempre**: tabla `wanted(match_key UNIQUE, rg_id, artist, title, year, release_date, cover,
  origin, status, added_at)`. El botón **«Quiero»** aparece en ficha de álbum (no poseído / versión que
  no tienes), en resultados de búsqueda, en el calendario y en los ítems de reto que te faltan. Marca
  deseo aunque no haya Liderarrr; una página `quiero.html` lista los deseos. Al escanear la biblioteca,
  un deseo cuyo `match_key` pase a estar poseído se marca `owned` (se cierra solo).
- **Con Liderarrr conectado**: al marcar «Quiero», además `POST /api/liderarrr/want` → reenvía a
  `POST {LIDERARRR}/api/wanted` (para que lo **descargue** de verdad); y se trae `GET /api/wanted/keys`
  para pintar en cada disco si ya está *vigilado/pedido/en disco* en Liderarrr. El botón «Quiero» pasa a
  decir «Vigilando en Liderarrr» cuando corresponde.

---

## Puente a Liderarrr (configurar con botón — coherente con Ajustes)

Nueva tarjeta en **Configuración → Servicios**: **Liderarrr**.
- Campo **URL** (p. ej. `http://nas:3861`) + botón **Conectar** (hace `GET {url}/api/wanted/keys` para
  validar que responde) y **Desconectar**. Se guarda en `app/liderarrr.json` (gitignored), igual que
  scrobble/spotify, con el mismo patrón de endpoints `GET /api/config/services` + `POST /api/config/
  liderarrr`. Nada de claves: es tu propia LAN.
- El servidor de escucharrr hace de proxy fino (`/api/liderarrr/*`) para evitar CORS y centralizar el
  estado. Sin Liderarrr configurado, los botones «Quiero» siguen funcionando en modo local.

## Plan por fases

1. **Retos de escucha (nativo)** — tablas + parser + `retos.html` + «Añadir a reto» + anillos
   tienes/oídos + «Reto radio». Es el que más valor da con lo que escucharrr ya sabe. **Primero.**
2. **Botón «Quiero» (local)** + página `quiero.html` + cierre automático al poseer.
3. **Puente Liderarrr** (tarjeta en Ajustes + proxy) → «Quiero» descarga de verdad + estado por
   `/api/wanted/keys`.
4. **Calendario de lanzamientos** — puente a `/api/newreleases`/`globalreleases`; nativo degradado por
   MusicBrainz de los artistas más escuchados.

Diferido / de Liderarrr (no cruzan la frontera): descargas, trackers, importación, rate-limit de
indexers — eso se queda en Liderarrr; escucharrr solo **desea** y **enlaza**.

_Documento de diseño; nada implementado aún. Fuente: RE de Liderarrr v1.3 (clonado 2026-11-03)._
