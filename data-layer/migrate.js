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
  db.exec('CREATE INDEX IF NOT EXISTS ix_recording_isrc ON recording(isrc)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_recording_acoustid ON recording(acoustid)');
  return added;
}

module.exports = { migrate };
