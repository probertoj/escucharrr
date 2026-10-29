# escucharrr

Reproductor de música **abierto y local-first**, inspirado en las mejores decisiones de
Roon (página de álbum rica, facetas de biblioteca, grafo relacional de metadatos) pero
sobre componentes libres y **sin dependencia de licencia ni nube**.

## Estado

- `docs/` — documentos de diseño: arquitectura y ajustes, cada decisión comparada con Roon.
  - `diseno-vs-roon.md` — datos, página de álbum, motor de audio, transporte, local-first.
  - `ajustes-vs-roon.md` — auditoría de ajustes (qué se puede replicar y qué no), Spotify/scrobbling.
- `data-layer/` — modelo de datos y herramientas de ingesta (**funcionando**, sin dependencias).
  - `schema.sql` — esquema SQLite (grafo estilo MusicBrainz; `tier` y `rating` de primera
    clase e indexados; créditos tipados; mapeo de ficheros; procedencia; FTS5; vistas).
  - `obsidian-sync.js` — sincroniza un vault de Obsidian al grafo (bio/tier/rating; tus notas mandan).
  - `scan.js` — escanea ficheros locales (FLAC/WAV) → `local_file` + mapeo por tags al grafo.
  - `enrich.js` — enriquece desde MusicBrainz: mbid, tipo, fecha, géneros y **créditos por rol**.
  - `config.example.json`, `obsidian-mapping.md`, `sample-vault/` — configuración, spec y ejemplo.
- `app/` — vista web mínima que lee de la BD (**funcionando**): servidor + biblioteca + página de álbum.
  - `server.js` — API JSON (`/api/library`, `/api/album?id=`) desde SQLite (node:http + node:sqlite).
  - `public/` — biblioteca (Focus por tier/género/década/tipo/formato/valoración, orden, filtro)
    y página de álbum (tier, valoración, créditos por rol, bio con procedencia).

Todo usa `node:sqlite` (Node ≥ 22.5 / 24), **sin paquetes externos**.

## Construir la BD y arrancar la app

```bash
# 1. generar la base de datos (data-layer/)
cd data-layer
node obsidian-sync.js --db ../app/escucharrr.db --config config.example.json
node scan.js         --db ../app/escucharrr.db --root "/ruta/a/tu/musica"
node enrich.js       --db ../app/escucharrr.db --limit 50

# 2. arrancar la vista web
cd ..
node app/server.js            # http://localhost:7733
```

Probado de punta a punta con datos reales: FLAC/WAV escaneados con sus propiedades, álbum
resuelto en MusicBrainz con géneros y créditos por rol, consultas "Excel sin valorar" /
"4★ o más" sobre `tier`/`rating`, y la biblioteca + página de álbum renderizando desde SQLite.

Principios: la biblioteca es una proyección sobre un grafo canónico (no un reflejo de los
tags); **tus notas de Obsidian mandan** sobre las fuentes externas; `tier`/`rating` son
campos consultables para filtrar y clasificar.
