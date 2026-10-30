'use strict';
// escucharrr — análisis de loudness EBU R128 (ReplayGain) con ffmpeg.
// Para cada fichero sin medir: mide el loudness integrado (LUFS) y el pico real (dBFS)
// con el filtro `ebur128` y guarda loudness_lufs + gain_db (ref -18 LUFS, ReplayGain 2.0)
// + peak_dbfs. El player aplica gain_db en el nodo de ganancia, limitando con el pico.
// No modifica los ficheros de audio. Necesita ffmpeg en el PATH (o --ffmpeg <ruta>).
//   node analyze.js --db escucharrr.db [--limit N] [--force] [--demo] [--ffmpeg ffmpeg]

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { migrate } = require('./migrate');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', 'escucharrr.db');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const FORCE = process.argv.includes('--force');
const DEMO = process.argv.includes('--demo');
const FFMPEG = arg('ffmpeg') || 'ffmpeg';
const REF_LUFS = -18;                            // referencia ReplayGain 2.0

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
migrate(db);

function ffmpegAvailable() {
  try { const r = cp.spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }); return !r.error && r.status === 0; } catch { return false; }
}
// mide un fichero; devuelve { I, peak } en LUFS / dBFS, o null si no se pudo
function measure(file) {
  const r = cp.spawnSync(FFMPEG, ['-nostats', '-hide_banner', '-vn', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const err = r.stderr || '';
  const i = err.lastIndexOf('Summary:'); if (i < 0) return null;         // el Summary final trae los valores definitivos
  const tail = err.slice(i);
  const mI = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(tail);
  const mP = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(tail);
  if (!mI) return null;
  return { I: parseFloat(mI[1]), peak: mP ? parseFloat(mP[1]) : null };
}

const S = {
  pending: db.prepare(`SELECT id, path FROM local_file WHERE path IS NOT NULL${FORCE ? '' : ' AND loudness_lufs IS NULL'} ORDER BY id${LIMIT ? ' LIMIT ' + LIMIT : ''}`),
  update: db.prepare('UPDATE local_file SET loudness_lufs=?, gain_db=?, peak_dbfs=? WHERE id=?'),
};

if (!ffmpegAvailable()) {
  console.log('ffmpeg no está disponible. Instálalo y ponlo en el PATH, o pásalo con --ffmpeg <ruta>.');
  console.log('  (en Windows: https://ffmpeg.org/download.html; con él, el filtro ebur128 mide el loudness R128).');
  db.close(); process.exit(0);
}

const files = S.pending.all();
if (!files.length) { console.log('Nada que analizar (todos medidos; usa --force para recalcular).'); db.close(); process.exit(0); }
console.log(`Analizando loudness R128 de ${files.length} fichero(s) con ffmpeg…`);
let ok = 0;
for (const f of files) {
  if (!fs.existsSync(f.path)) { console.log('  · (falta) ' + path.basename(f.path)); continue; }
  try {
    const m = measure(f.path);
    if (!m) { console.log('  ✗ ' + path.basename(f.path) + ': sin medida'); continue; }
    const gain = +(REF_LUFS - m.I).toFixed(2);                           // ganancia para llevar el tema a -18 LUFS
    S.update.run(m.I, gain, m.peak, f.id);
    ok++;
    console.log(`  ✓ ${path.basename(f.path)}  I=${m.I} LUFS  ganancia=${gain >= 0 ? '+' : ''}${gain} dB  pico=${m.peak != null ? m.peak + ' dBFS' : '—'}`);
  } catch (e) { console.log('  ✗ ' + path.basename(f.path) + ': ' + e.message); }
}
console.log(`Medidos ${ok}/${files.length}.`);

if (DEMO) {
  console.log('\n== ReplayGain por pista (ganancia que aplicará el player) ==');
  db.prepare(`SELECT COALESCE(r.title, lf.path) t, lf.loudness_lufs, lf.gain_db, lf.peak_dbfs
     FROM local_file lf LEFT JOIN recording r ON r.id=lf.recording_id
     WHERE lf.gain_db IS NOT NULL ORDER BY lf.id LIMIT 16`).all()
    .forEach(r => console.log(`  ${(r.gain_db >= 0 ? '+' : '') + r.gain_db} dB  (I=${r.loudness_lufs}, pico=${r.peak_dbfs})  ${r.t}`));
}
db.close();
