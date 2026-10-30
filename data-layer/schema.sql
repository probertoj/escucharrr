-- escucharrr — esquema de datos (SQLite)
-- Modelo canónico estilo MusicBrainz: la biblioteca es una proyección sobre un grafo
-- relacional, no un reflejo de los tags. Los ficheros locales se MAPEAN al grafo.
-- tier y rating son campos de primera clase, indexados y con historial.
-- Decisiones: ver diseno-vs-roon.md y ajustes-vs-roon.md.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Grafo canónico (entidades)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS artist (
  id            INTEGER PRIMARY KEY,
  mbid          TEXT UNIQUE,                 -- MusicBrainz id (si identificado)
  name          TEXT NOT NULL,
  sort_name     TEXT,
  type          TEXT,                        -- person | group | orchestra | ...
  disambiguation TEXT,
  country       TEXT,
  founded       TEXT,                        -- fecha / año de formación
  bio           TEXT,                        -- puede venir de Obsidian (ver provenance)
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Un "artist credit" es una lista ordenada de artistas con frases de unión
-- (p. ej. "Vera Solano feat. Nadia Belkin" o "Varios artistas").
CREATE TABLE IF NOT EXISTS artist_credit (
  id INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS artist_credit_name (
  artist_credit_id INTEGER NOT NULL REFERENCES artist_credit(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  artist_id        INTEGER NOT NULL REFERENCES artist(id),
  name             TEXT NOT NULL,            -- nombre tal cual aparece en el crédito
  join_phrase      TEXT DEFAULT '',
  PRIMARY KEY (artist_credit_id, position)
);

-- El "álbum" lógico que agrupa ediciones.
CREATE TABLE IF NOT EXISTS release_group (
  id               INTEGER PRIMARY KEY,
  mbid             TEXT UNIQUE,
  title            TEXT NOT NULL,
  artist_credit_id INTEGER REFERENCES artist_credit(id),
  primary_type     TEXT,                     -- album | ep | single | live | compilation | soundtrack
  first_release    TEXT,                     -- fecha de la 1ª edición (YYYY o YYYY-MM-DD)
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);

-- Edición concreta (remaster, vinilo, hi-res…).
CREATE TABLE IF NOT EXISTS "release" (
  id               INTEGER PRIMARY KEY,
  mbid             TEXT UNIQUE,
  release_group_id INTEGER NOT NULL REFERENCES release_group(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  artist_credit_id INTEGER REFERENCES artist_credit(id),
  date             TEXT,
  country          TEXT,
  label_id         INTEGER REFERENCES label(id),
  barcode          TEXT,
  format           TEXT,                     -- CD | Vinyl | Digital | SACD | ...
  status           TEXT
);

CREATE TABLE IF NOT EXISTS medium (
  id          INTEGER PRIMARY KEY,
  release_id  INTEGER NOT NULL REFERENCES "release"(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  format      TEXT,
  title       TEXT
);

-- La grabación real (una Recording puede aparecer en muchos Tracks/Releases).
CREATE TABLE IF NOT EXISTS recording (
  id               INTEGER PRIMARY KEY,
  mbid             TEXT UNIQUE,
  isrc             TEXT,                         -- código ISRC (identificador de grabación)
  acoustid         TEXT,                         -- AcoustID (huella -> id, agrupa grabaciones equivalentes)
  title            TEXT NOT NULL,
  artist_credit_id INTEGER REFERENCES artist_credit(id),
  length_ms        INTEGER,
  work_id          INTEGER REFERENCES work(id)
);
-- (los índices sobre isrc/acoustid se crean en migrate.js, tras garantizar las columnas)

-- Posición de una grabación en una edición concreta.
CREATE TABLE IF NOT EXISTS track (
  id               INTEGER PRIMARY KEY,
  medium_id        INTEGER NOT NULL REFERENCES medium(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  recording_id     INTEGER NOT NULL REFERENCES recording(id),
  title            TEXT NOT NULL,            -- título en esta edición (puede diferir)
  artist_credit_id INTEGER REFERENCES artist_credit(id),
  length_ms        INTEGER
);

-- La composición (obra); una Recording la interpreta.
CREATE TABLE IF NOT EXISTS work (
  id    INTEGER PRIMARY KEY,
  mbid  TEXT UNIQUE,
  title TEXT NOT NULL,
  type  TEXT
);

CREATE TABLE IF NOT EXISTS label (
  id   INTEGER PRIMARY KEY,
  mbid TEXT UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS genre (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
-- Géneros por release_group (y, si hace falta, por recording).
CREATE TABLE IF NOT EXISTS release_group_genre (
  release_group_id INTEGER NOT NULL REFERENCES release_group(id) ON DELETE CASCADE,
  genre_id         INTEGER NOT NULL REFERENCES genre(id) ON DELETE CASCADE,
  PRIMARY KEY (release_group_id, genre_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Relaciones tipadas (créditos por rol) — lo que hace brillar la página de álbum
--    "artista X hace el rol R (instrumento I) en la entidad Y".
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit (
  id            INTEGER PRIMARY KEY,
  entity_type   TEXT NOT NULL,               -- recording | release | release_group | work | track
  entity_id     INTEGER NOT NULL,
  artist_id     INTEGER NOT NULL REFERENCES artist(id),
  role          TEXT NOT NULL,               -- bass | mixing | production | composer | guest_vocals | ...
  instrument    TEXT,
  detail        TEXT,
  source        TEXT,                        -- musicbrainz | discogs | user (para reinsertar por fuente)
  position      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_credit_entity ON credit(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_credit_artist ON credit(artist_id, role);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Ficheros locales y mapeo (separa "lo que tienes" de "lo que es")
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS local_file (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  hash         TEXT,                          -- p. ej. sha256 o audio hash
  format       TEXT,                          -- FLAC | WAV | MP3 | DSD | ...
  sample_rate  INTEGER,
  bit_depth    INTEGER,
  channels     INTEGER,
  duration_ms  INTEGER,
  size_bytes   INTEGER,
  mtime        TEXT,
  -- resultado del análisis de audio (R128 / ReplayGain / waveform)
  loudness_lufs REAL,                          -- loudness integrado (LUFS, EBU R128)
  gain_db       REAL,                          -- ganancia ReplayGain a aplicar (ref -18 LUFS)
  peak_dbfs     REAL,                          -- pico real (dBFS) para limitar sin clipping
  -- identificadores leídos del fichero (tags) o calculados (fpcalc)
  isrc         TEXT,                          -- ISRC del tag
  acoustid     TEXT,                          -- AcoustID (del tag ACOUSTID_ID o de la consulta)
  fingerprint  TEXT,                          -- huella Chromaprint comprimida (tag o fpcalc), para no recalcular
  -- mapeo al grafo (nullable hasta identificar)
  track_id     INTEGER REFERENCES track(id),
  recording_id INTEGER REFERENCES recording(id),
  match_by     TEXT,                          -- mb-tag | isrc | acoustid | tags | manual
  match_conf   REAL
);
CREATE INDEX IF NOT EXISTS ix_file_recording ON local_file(recording_id);
CREATE INDEX IF NOT EXISTS ix_file_track ON local_file(track_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Tier y rating: campos de PRIMERA CLASE, indexados, con historial
-- ────────────────────────────────────────────────────────────────────────────
-- Enum ordenado de tiers (como la tier-list de hipersónica.com).
CREATE TABLE IF NOT EXISTS tier (
  key   TEXT PRIMARY KEY,                     -- excel | si | ok | meh | no
  label TEXT NOT NULL,
  rank  INTEGER NOT NULL                      -- orden intrínseco (mayor = mejor)
);
INSERT OR IGNORE INTO tier(key,label,rank) VALUES
  ('excel','Excel',5),('si','Sí',4),('ok','Ok',3),('meh','Meh',2),('no','No',1);

-- Tier asignado a un sujeto (normalmente release_group; también vale para artist).
CREATE TABLE IF NOT EXISTS rating_tier (
  subject_type TEXT NOT NULL,                 -- release_group | artist | ...
  subject_id   INTEGER NOT NULL,
  tier_key     TEXT NOT NULL REFERENCES tier(key),
  source       TEXT DEFAULT 'user',           -- user | obsidian
  updated_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS ix_tier_key ON rating_tier(tier_key);

-- Valoración numérica 0–5 (medias permitidas) por pista y/o álbum.
CREATE TABLE IF NOT EXISTS rating (
  subject_type TEXT NOT NULL,                 -- recording | track | release_group
  subject_id   INTEGER NOT NULL,
  stars        REAL NOT NULL CHECK (stars >= 0 AND stars <= 5),
  source       TEXT DEFAULT 'user',
  updated_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS ix_rating_stars ON rating(stars);

-- Historial append-only de cambios de tier/rating (para "clasificar y filtrar" en el tiempo).
CREATE TABLE IF NOT EXISTS rating_event (
  id           INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id   INTEGER NOT NULL,
  kind         TEXT NOT NULL,                 -- tier | stars
  value        TEXT NOT NULL,
  source       TEXT,
  at           TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Marcas, ediciones de usuario y procedencia ("tus datos mandan")
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flag (
  subject_type TEXT NOT NULL,                 -- release_group | artist | track | recording
  subject_id   INTEGER NOT NULL,
  flag         TEXT NOT NULL,                 -- favorite | listen_later | banned
  set_at       TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (subject_type, subject_id, flag)
);

-- Override de usuario: gana a cualquier fuente externa.
CREATE TABLE IF NOT EXISTS user_edit (
  subject_type TEXT NOT NULL,
  subject_id   INTEGER NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT,
  updated_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (subject_type, subject_id, field)
);

-- De dónde salió cada dato (para mostrar procedencia).
CREATE TABLE IF NOT EXISTS provenance (
  subject_type TEXT NOT NULL,
  subject_id   INTEGER NOT NULL,
  field        TEXT NOT NULL,
  source       TEXT NOT NULL,                 -- obsidian | musicbrainz | tags | user | discogs
  source_ref   TEXT,                          -- ruta de la nota, MBID, etc.
  fetched_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (subject_type, subject_id, field)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Integración con Obsidian
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS obsidian_note (
  id              INTEGER PRIMARY KEY,
  vault           TEXT NOT NULL,
  path            TEXT NOT NULL UNIQUE,       -- ruta relativa dentro del vault
  mtime           TEXT,
  frontmatter_json TEXT,                      -- frontmatter crudo (YAML -> JSON)
  body_md         TEXT,                       -- cuerpo (se usa como "acerca de")
  imported_at     TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS obsidian_link (
  note_id      INTEGER NOT NULL REFERENCES obsidian_note(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,                 -- release_group | artist
  subject_id   INTEGER NOT NULL,
  match_by     TEXT,                          -- frontmatter_mbid | artist_title | manual
  match_conf   REAL,
  PRIMARY KEY (note_id, subject_type, subject_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Escucha (historial) y playlists
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS play (
  id            INTEGER PRIMARY KEY,
  recording_id  INTEGER REFERENCES recording(id),
  track_id      INTEGER REFERENCES track(id),
  local_file_id INTEGER REFERENCES local_file(id),
  played_at     TEXT DEFAULT (datetime('now')),
  ms_played     INTEGER,
  zone          TEXT,
  source        TEXT                          -- local | spotify | ...
);
CREATE INDEX IF NOT EXISTS ix_play_time ON play(played_at);
CREATE INDEX IF NOT EXISTS ix_play_rec ON play(recording_id);

CREATE TABLE IF NOT EXISTS playlist (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS playlist_item (
  playlist_id  INTEGER NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  recording_id INTEGER REFERENCES recording(id),
  track_id     INTEGER REFERENCES track(id),
  PRIMARY KEY (playlist_id, position)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Búsqueda (FTS5). La instantánea usa prefijo; la completa, ranking bm25.
-- ────────────────────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  name, kind UNINDEXED, subject_type UNINDEXED, subject_id UNINDEXED,
  prefix = '2 3 4', tokenize = 'unicode61 remove_diacritics 2'
);

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Vistas de conveniencia para las consultas de la app
-- ────────────────────────────────────────────────────────────────────────────

-- Álbum con su artista, tier, rank de tier, media de estrellas, año y favorito.
CREATE VIEW IF NOT EXISTS v_album AS
SELECT rg.id, rg.title, rg.primary_type, rg.first_release,
       substr(rg.first_release,1,4) AS year,
       (SELECT group_concat(acn.name || acn.join_phrase,'')
          FROM artist_credit_name acn WHERE acn.artist_credit_id = rg.artist_credit_id
          ORDER BY acn.position) AS artist,
       rt.tier_key, t.rank AS tier_rank,
       (SELECT AVG(stars) FROM rating r WHERE r.subject_type='release_group' AND r.subject_id=rg.id) AS album_stars,
       EXISTS(SELECT 1 FROM flag f WHERE f.subject_type='release_group' AND f.subject_id=rg.id AND f.flag='favorite') AS is_favorite
FROM release_group rg
LEFT JOIN rating_tier rt ON rt.subject_type='release_group' AND rt.subject_id=rg.id
LEFT JOIN tier t ON t.key = rt.tier_key;

-- Créditos por rol de un álbum (vía sus grabaciones).
CREATE VIEW IF NOT EXISTS v_album_credits AS
SELECT rg.id AS release_group_id, c.role, a.id AS artist_id, a.name AS artist_name,
       c.instrument, c.detail
FROM release_group rg
JOIN "release" rel ON rel.release_group_id = rg.id
JOIN medium m ON m.release_id = rel.id
JOIN track tr ON tr.medium_id = m.id
JOIN credit c ON c.entity_type='recording' AND c.entity_id = tr.recording_id
JOIN artist a ON a.id = c.artist_id
GROUP BY rg.id, c.role, a.id;

-- Facetas del Focus de biblioteca (conteos por tier / género / década / formato).
CREATE VIEW IF NOT EXISTS v_focus_tier AS
SELECT rt.tier_key, t.label, t.rank, COUNT(*) AS n
FROM rating_tier rt JOIN tier t ON t.key=rt.tier_key
WHERE rt.subject_type='release_group'
GROUP BY rt.tier_key ORDER BY t.rank DESC;
