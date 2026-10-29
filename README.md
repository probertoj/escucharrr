# escucharrr

Reproductor de música **abierto y local-first**, inspirado en las mejores decisiones de
Roon (página de álbum rica, facetas de biblioteca, grafo relacional de metadatos) pero
sobre componentes libres y **sin dependencia de licencia ni nube**.

## Estado

- `docs/` — documentos de diseño: arquitectura y ajustes, cada decisión comparada con Roon.
  - `diseno-vs-roon.md` — datos, página de álbum, motor de audio, transporte, local-first.
  - `ajustes-vs-roon.md` — auditoría de ajustes (qué se puede replicar y qué no), Spotify/scrobbling.
- `data-layer/` — modelo de datos y sincronización con Obsidian (**funcionando**).
  - `schema.sql` — esquema SQLite (grafo estilo MusicBrainz; `tier` y `rating` de primera
    clase e indexados; créditos tipados; mapeo de ficheros; procedencia; FTS5; vistas).
  - `obsidian-sync.js` — sincroniza un vault de Obsidian al grafo. Sin dependencias
    (usa `node:sqlite`, Node ≥ 22.5 / 24).
  - `config.example.json`, `obsidian-mapping.md`, `sample-vault/` — configuración, spec y ejemplo.

## Probar el data-layer

```bash
cd data-layer
node obsidian-sync.js --db escucharrr.db --config config.example.json --demo
```

Principios: la biblioteca es una proyección sobre un grafo canónico (no un reflejo de los
tags); **tus notas de Obsidian mandan** sobre las fuentes externas; `tier`/`rating` son
campos consultables para filtrar y clasificar.
