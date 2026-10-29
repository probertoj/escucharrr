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
  - `scan.js` — escanea ficheros locales (FLAC/WAV) → `local_file` (formato, SR, bits, duración)
    y mapea por tags al grafo.
  - `enrich.js` — enriquece desde MusicBrainz: mbid, tipo, fecha, géneros y **créditos por rol**
    (intérpretes/producción/ingeniería) a nivel de grabación.
  - `config.example.json`, `obsidian-mapping.md`, `sample-vault/` — configuración, spec y ejemplo.

Todo usa `node:sqlite` (Node ≥ 22.5 / 24), **sin paquetes externos**.

## Probar el data-layer

```bash
cd data-layer
# 1. tu vault de Obsidian -> grafo (tier / rating / "acerca de")
node obsidian-sync.js --db escucharrr.db --config config.example.json --demo
# 2. escanear ficheros locales -> local_file + grafo (por tags)
node scan.js --db escucharrr.db --root "/ruta/a/tu/musica" --demo
# 3. enriquecer con MusicBrainz (mbid, géneros, créditos por rol)
node enrich.js --db escucharrr.db --demo
```

Probado de punta a punta con datos reales: FLAC/WAV escaneados con sus propiedades,
álbum resuelto en MusicBrainz con géneros y 33 créditos por rol, y consultas como
"Excel sin valorar" o "4★ o más" resueltas sobre `tier`/`rating`.

Principios: la biblioteca es una proyección sobre un grafo canónico (no un reflejo de los
tags); **tus notas de Obsidian mandan** sobre las fuentes externas; `tier`/`rating` son
campos consultables para filtrar y clasificar.
