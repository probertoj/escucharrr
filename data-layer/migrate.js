'use strict';
// escucharrr — migraciones idempotentes para BD ya creadas.
// `CREATE TABLE IF NOT EXISTS` no añade columnas nuevas a una tabla existente, así que
// aquí las agregamos con ALTER TABLE solo si faltan (SQLite no tiene ADD COLUMN IF NOT EXISTS).

function cols(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
}
function addCol(db, table, name, decl) {
  if (cols(db, table).has(name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  return true;
}

// Modelo de VERSIONES (estilo Roon): varias copias locales del mismo lanzamiento comparten el MBID del
// release-group. El `UNIQUE` original en release_group.mbid lo prohibía (y reventaba al identificar). Aquí lo
// quitamos reconstruyendo la tabla a partir de SU PROPIO `CREATE TABLE` (solo se borra el UNIQUE de mbid), de
// modo que se preservan TODAS las columnas (incluidas las añadidas por migración) y los ids (las FKs apuntan a
// release_group.id). Guardado: solo corre si el UNIQUE sigue ahí. Deja un índice NO único para buscar por mbid.
function dropMbidUnique(db) {
  const hasUniq = db.prepare('PRAGMA index_list(release_group)').all().some(i => i.origin === 'u' && i.unique);
  if (!hasUniq) return false;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='release_group'").get();
  if (!row || !row.sql) return false;
  let newSql = row.sql.replace(/CREATE TABLE\s+["`\[]?release_group["`\]]?/i, 'CREATE TABLE release_group_new');
  newSql = newSql.replace(/(\bmbid\b\s+TEXT)\s+UNIQUE/i, '$1');
  if (/\bmbid\b\s+TEXT\s+UNIQUE/i.test(newSql) || !/release_group_new/.test(newSql)) return false;   // la edición no salió → no tocar
  const colList = db.prepare('PRAGMA table_info(release_group)').all().map(c => '"' + c.name + '"').join(',');
  // Soltar vistas/triggers antes del rebuild (SQLite revalida los objetos del esquema al soltar/renombrar la
  // tabla y fallaría porque referencian release_group); se recrean idénticos desde su propio SQL al terminar.
  const objs = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('view','trigger') AND sql IS NOT NULL").all();
  db.exec('PRAGMA foreign_keys=OFF');   // (no-op dentro de transacción, por eso va antes del BEGIN)
  db.exec('BEGIN');
  try {
    for (const o of objs) db.exec('DROP ' + (o.type === 'view' ? 'VIEW' : 'TRIGGER') + ' IF EXISTS "' + o.name + '"');
    db.exec(newSql);
    db.exec(`INSERT INTO release_group_new (${colList}) SELECT ${colList} FROM release_group`);
    db.exec('DROP TABLE release_group');
    db.exec('ALTER TABLE release_group_new RENAME TO release_group');
    db.exec('CREATE INDEX IF NOT EXISTS ix_rg_mbid ON release_group(mbid)');
    for (const o of objs) db.exec(o.sql);   // recrear vistas/triggers idénticos
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} try { db.exec('PRAGMA foreign_keys=ON'); } catch (_) {} throw e; }
  try { db.exec('PRAGMA foreign_keys=ON'); } catch (_) {}
  return true;
}

// Añade las columnas de identificación (ISRC / AcoustID / fingerprint) si faltan.
function migrate(db) {
  // WAL + espera: permite 1 escritor + varios lectores a la vez (servidor + watcher + herramientas).
  try { db.exec('PRAGMA journal_mode=WAL'); db.exec('PRAGMA busy_timeout=5000'); } catch (e) {}
  const added = [];
  if (addCol(db, 'recording', 'isrc', 'TEXT')) added.push('recording.isrc');
  if (addCol(db, 'recording', 'acoustid', 'TEXT')) added.push('recording.acoustid');
  if (addCol(db, 'local_file', 'isrc', 'TEXT')) added.push('local_file.isrc');
  if (addCol(db, 'local_file', 'acoustid', 'TEXT')) added.push('local_file.acoustid');
  if (addCol(db, 'local_file', 'fingerprint', 'TEXT')) added.push('local_file.fingerprint');
  if (addCol(db, 'credit', 'source', 'TEXT')) added.push('credit.source');
  if (addCol(db, 'local_file', 'peak_dbfs', 'REAL')) added.push('local_file.peak_dbfs');
  if (addCol(db, 'local_file', 'album_gain_db', 'REAL')) added.push('local_file.album_gain_db');
  if (addCol(db, 'local_file', 'album_peak_dbfs', 'REAL')) added.push('local_file.album_peak_dbfs');
  if (addCol(db, 'local_file', 'peaks', 'TEXT')) added.push('local_file.peaks');   // waveform
  if (addCol(db, 'release_group', 'about', 'TEXT')) added.push('release_group.about');   // reseña editorial externa (Wikipedia); el user_edit 'about' de Obsidian manda
  if (addCol(db, 'release_group', 'cover_path', 'TEXT')) added.push('release_group.cover_path');   // carátula cacheada (Cover Art Archive)
  if (addCol(db, 'release_group', 'cover_mime', 'TEXT')) added.push('release_group.cover_mime');
  if (addCol(db, 'release_group', 'spotify_album_id', 'TEXT')) added.push('release_group.spotify_album_id');   // guardado en la biblioteca de Spotify
  if (addCol(db, 'release_group', 'spotify_url', 'TEXT')) added.push('release_group.spotify_url');
  // Escaneo tolerante a red (modelo Roon, ver memoria roon-storage-scanner): no equiparar "no lo vi"
  // con "ya no está". scan_seq = generación del último escaneo que VIO el fichero (en una carpeta
  // leída con éxito); missing_since/_count = lápida: solo se retira tras N escaneos limpios sin verlo.
  if (addCol(db, 'local_file', 'scan_seq', 'INTEGER')) added.push('local_file.scan_seq');
  if (addCol(db, 'local_file', 'missing_since', 'TEXT')) added.push('local_file.missing_since');
  if (addCol(db, 'local_file', 'missing_count', 'INTEGER DEFAULT 0')) added.push('local_file.missing_count');
  // Modelo de VERSIONES por carpeta (estilo Roon): cada copia física (carpeta de álbum) es un `release`
  // distinto bajo el mismo release_group. source_dir = carpeta del álbum normalizada (clave de la copia).
  // NULL en releases antiguos (pre-migración): se tratan como la única copia (primaria) hasta reescanear.
  if (addCol(db, 'release', 'source_dir', 'TEXT')) added.push('release.source_dir');
  db.exec('CREATE INDEX IF NOT EXISTS ix_release_rg_dir ON "release"(release_group_id, source_dir)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_recording_isrc ON recording(isrc)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_recording_acoustid ON recording(acoustid)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_file_size ON local_file(size_bytes)');   // para reconciliar movimientos/renombrados por identidad
  if (dropMbidUnique(db)) added.push('release_group.mbid: UNIQUE quitado (modelo de versiones, estilo Roon)');
  // v_album.title ahora prioriza el título editado por el usuario (user_edit field='title') sobre rg.title.
  // Recreamos la vista en BD existentes (CREATE VIEW IF NOT EXISTS no la actualizaría). El título original
  // queda como orig_title: ensureRg sigue casando por rg.title, así que un reescaneo NO duplica el álbum.
  try {
    const def = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_album'").get();
    if (def && !/orig_title/.test(def.sql || '')) {
      db.exec('DROP VIEW v_album');
      db.exec(`CREATE VIEW v_album AS
SELECT rg.id,
       COALESCE((SELECT ue.value FROM user_edit ue
                   WHERE ue.subject_type='release_group' AND ue.subject_id=rg.id AND ue.field='title'),
                rg.title) AS title,
       rg.title AS orig_title,
       rg.primary_type, rg.first_release,
       substr(rg.first_release,1,4) AS year,
       (SELECT group_concat(acn.name || acn.join_phrase,'')
          FROM artist_credit_name acn WHERE acn.artist_credit_id = rg.artist_credit_id
          ORDER BY acn.position) AS artist,
       rt.tier_key, t.rank AS tier_rank,
       (SELECT AVG(stars) FROM rating r WHERE r.subject_type='release_group' AND r.subject_id=rg.id) AS album_stars,
       EXISTS(SELECT 1 FROM flag f WHERE f.subject_type='release_group' AND f.subject_id=rg.id AND f.flag='favorite') AS is_favorite
FROM release_group rg
LEFT JOIN rating_tier rt ON rt.subject_type='release_group' AND rt.subject_id=rg.id
LEFT JOIN tier t ON t.key = rt.tier_key`);
      added.push('view:v_album(title override)');
    }
  } catch (e) {}
  return added;
}

module.exports = { migrate, dropMbidUnique };
