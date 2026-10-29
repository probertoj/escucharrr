# Integración con Obsidian — mapeo nota ↔ grafo

Cómo `obsidian-sync.js` lleva tu vault al esquema de [schema.sql](schema.sql). Validado con `sample-vault/`.

## Qué hace

Por cada `.md` dentro de `<vault>/<albumsFolder>`:
1. Parsea el **frontmatter** (YAML plano + listas `[a, b]`) y el **cuerpo** (markdown).
2. Resuelve **artista** y **álbum** desde los campos del frontmatter; si faltan, del **nombre de fichero** (`{artist} - {album}`).
3. Crea/encuentra `artist` → `artist_credit` → `release_group` (idempotente por título+crédito).
4. Enlaza **géneros** (`release_group_genre`).
5. Fija **tier** y **rating** con `source='obsidian'`, registra **procedencia** (`provenance`), guarda el **override de usuario** (`user_edit`), y añade un **evento al historial** (`rating_event`) solo si el valor cambió.
6. Usa el **cuerpo de la nota** como campo `about` del álbum (la descripción de la página de álbum, en vez de Wikipedia).
7. Guarda la nota cruda (`obsidian_note`) y el enlace nota↔álbum (`obsidian_link`).
8. Reconstruye el índice **FTS5** (búsqueda instantánea por prefijo + completa por bm25).

«Tus datos mandan»: lo que venga de Obsidian queda marcado como tal y gana a las fuentes externas (MusicBrainz, tags) en la resolución de conflictos.

## Configuración (`config.example.json`)

```json
{
  "vault": "./sample-vault",
  "albumsFolder": "Discos",
  "filenamePattern": "{artist} - {album}",
  "fields": {
    "artist": ["artist", "artista"],
    "album":  ["album", "título", "title"],
    "year":   ["year", "año"],
    "tier":   ["tier", "nivel"],
    "rating": ["rating", "estrellas", "nota"],
    "genre":  ["genre", "género", "generos", "géneros"]
  },
  "tierMap": { "excel":"excel","excelente":"excel","sí":"si","si":"si","ok":"ok","meh":"meh","no":"no" }
}
```

- `fields`: cada campo lógico acepta **varias claves** de frontmatter (así te adaptas a tu vault sin renombrar nada).
- `tierMap`: normaliza los valores (Excel/Sí/Ok/Meh/No, con o sin acento) al enum `tier`.
- Si una nota trae `mbid` en el frontmatter, el enlace se marca con confianza 1.0 (identificación exacta).

## Uso

```bash
node obsidian-sync.js --db escucharrr.db --config config.example.json [--demo]
```

Requiere Node ≥ 22.5 / 24 (usa `node:sqlite`, **sin dependencias**). Es idempotente: re-sincronizar no duplica nada y solo añade al historial los cambios.

## Resultado comprobado (vault de ejemplo)

- `Excel sin valorar` (tier=Excel y sin estrellas) → **Marea baja** (consulta trivial).
- `4★ o más` → Abisal (5), Cartografía del silencio (5), Noche química (4).
- Conteo por tier (faceta del Focus): Excel 3 · Sí 1 · Ok 1 · Meh 1.
- Búsqueda por prefijo `mar*` → Marosa (artista), Marea baja (álbum).
- Procedencia de "Marea baja": tier y about vienen de la nota de Obsidian.

## Pendiente (siguientes pasos del data layer)

- **Ingesta de ficheros locales**: escanear carpetas → `local_file` (formato, SR, bit depth) + tags (TagLib).
- **Identificación**: Chromaprint/AcoustID → MBID → traer subgrafo de MusicBrainz y casar `file ↔ recording/track`.
- **Enriquecimiento**: créditos por rol y relaciones desde MusicBrainz (alimenta la página de álbum y Discover).
- **Vigilancia en tiempo real** del vault y de las carpetas de música (watcher).
