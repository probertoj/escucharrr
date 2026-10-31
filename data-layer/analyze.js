'use strict';
// escucharrr — análisis de loudness EBU R128 (ReplayGain) con ffmpeg.
// Para cada fichero sin medir: mide el loudness integrado (LUFS) y el pico real (dBFS)
// con el filtro `ebur128` y guarda loudness_lufs + gain_db (ref -18 LUFS, ReplayGain 2.0)
// + peak_dbfs. El player aplica gain_db en el nodo de ganancia, limitando con el pico.
// No modifica los ficheros de audio. Necesita ffmpeg en el PATH (o --ffmpeg <ruta>).
//   node analyze.js --db escucharrr.db [--limit N] [--force] [--demo] [--ffmpeg ffmpeg]

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
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
// mide un ÁLBUM entero como un solo programa: concatena sus ficheros (demuxer concat)
// y pasa ebur128 una vez -> I y pico del disco completo. Null si ffmpeg no pudo.
function measureAlbum(paths) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrg-'));
  const listPath = path.join(dir, 'list.txt');
  fs.writeFileSync(listPath, paths.map(p => "file '" + p.replace(/'/g, "'\\''") + "'").join('\n'), 'utf8');
  try {
    const r = cp.spawnSync(FFMPEG, ['-nostats', '-hide_banner', '-vn', '-f', 'concat', '-safe', '0', '-i', listPath, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 256 << 20 });
    const err = r.stderr || '';
    const i = err.lastIndexOf('Summary:'); if (i < 0) return null;
    const tail = err.slice(i);
    const mI = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(tail);
    const mP = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(tail);
    if (!mI) return null;
    return { I: parseFloat(mI[1]), peak: mP ? parseFloat(mP[1]) : null };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
}
// fallback si el concat falla (p. ej. rates distintos): loudness de álbum ≈ media de
// energía ponderada por duración de las pistas ya medidas (ignora el re-gating entre temas).
function albumFallback(rows) {
  let num = 0, den = 0, peak = null;
  for (const r of rows) {
    if (r.loudness_lufs == null || !r.duration_ms) return null;
    const z = Math.pow(10, (r.loudness_lufs + 0.691) / 10);         // media cuadrática de la pista
    num += z * r.duration_ms; den += r.duration_ms;
    if (r.peak_dbfs != null) peak = peak == null ? r.peak_dbfs : Math.max(peak, r.peak_dbfs);
  }
  if (!den) return null;
  return { I: -0.691 + 10 * Math.log10(num / den), peak };
}

const S = {
  pending: db.prepare(`SELECT id, path FROM local_file WHERE path IS NOT NULL${FORCE ? '' : ' AND loudness_lufs IS NULL'} ORDER BY id${LIMIT ? ' LIMIT ' + LIMIT : ''}`),
  update: db.prepare('UPDATE local_file SET loudness_lufs=?, gain_db=?, peak_dbfs=? WHERE id=?'),
  updateAlbum: db.prepare('UPDATE local_file SET album_gain_db=?, album_peak_dbfs=? WHERE id=?'),
  // ficheros mapeados a su álbum (release_group), por pista y, si no, por grabación
  albumByTrack: db.prepare(`SELECT lf.id fid, lf.path, lf.album_gain_db, lf.loudness_lufs, lf.duration_ms, lf.peak_dbfs,
       rel.release_group_id rgid, m.position disc, tr.position pos
     FROM local_file lf JOIN track tr ON tr.id=lf.track_id JOIN medium m ON m.id=tr.medium_id
     JOIN "release" rel ON rel.id=m.release_id WHERE lf.path IS NOT NULL`),
  albumByRec: db.prepare(`SELECT lf.id fid, lf.path, lf.album_gain_db, lf.loudness_lufs, lf.duration_ms, lf.peak_dbfs,
       rel.release_group_id rgid, MIN(m.position) disc, MIN(tr.position) pos
     FROM local_file lf JOIN recording rc ON rc.id=lf.recording_id JOIN track tr ON tr.recording_id=rc.id
     JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
     WHERE lf.track_id IS NULL AND lf.path IS NOT NULL GROUP BY lf.id`),
};

if (!ffmpegAvailable()) {
  console.log('ffmpeg no está disponible. Instálalo y ponlo en el PATH, o pásalo con --ffmpeg <ruta>.');
  console.log('  (en Windows: https://ffmpeg.org/download.html; con él, el filtro ebur128 mide el loudness R128).');
  db.close(); process.exit(0);
}

// ── pasada por pista ──
const files = S.pending.all();
if (!files.length) {
  console.log('Por pista: nada que medir (todos medidos; usa --force para recalcular).');
} else {
  console.log(`Analizando loudness R128 de ${files.length} fichero(s) con ffmpeg…`);
  let ok = 0;
  for (const f of files) {
    if (!fs.existsSync(f.path)) { console.log('  · (falta) ' + path.basename(f.path)); continue; }
    try {
      const m = measure(f.path);
      if (!m) { console.log('  ✗ ' + path.basename(f.path) + ': sin medida'); continue; }
      const gain = +(REF_LUFS - m.I).toFixed(2);                         // ganancia para llevar el tema a -18 LUFS
      S.update.run(m.I, gain, m.peak, f.id);
      ok++;
      console.log(`  ✓ ${path.basename(f.path)}  I=${m.I} LUFS  ganancia=${gain >= 0 ? '+' : ''}${gain} dB  pico=${m.peak != null ? m.peak + ' dBFS' : '—'}`);
    } catch (e) { console.log('  ✗ ' + path.basename(f.path) + ': ' + e.message); }
  }
  console.log(`Medidos ${ok}/${files.length}.`);
}

// ── pasada por álbum (misma ganancia para todo el disco; conserva la dinámica relativa) ──
const groups = new Map();
for (const r of [...S.albumByTrack.all(), ...S.albumByRec.all()]) {
  if (r.rgid == null) continue;
  if (!groups.has(r.rgid)) groups.set(r.rgid, []);
  groups.get(r.rgid).push(r);
}
let aOk = 0, aTot = 0;
for (const [rgid, rows] of groups) {
  const existing = rows.filter(r => fs.existsSync(r.path)).sort((a, b) => (a.disc - b.disc) || (a.pos - b.pos) || (a.fid - b.fid));
  if (!existing.length) continue;
  if (!FORCE && !existing.some(r => r.album_gain_db == null)) continue;   // ya medido
  aTot++;
  let res = measureAlbum(existing.map(r => r.path));
  if (!res) res = albumFallback(existing);
  if (!res) { console.log(`  ✗ álbum ${rgid}: sin medida`); continue; }
  const aGain = +(REF_LUFS - res.I).toFixed(2);
  for (const r of existing) S.updateAlbum.run(aGain, res.peak, r.fid);
  aOk++;
  console.log(`  ✓ álbum ${rgid} (${existing.length} pistas)  I=${res.I.toFixed(1)} LUFS  ganancia=${aGain >= 0 ? '+' : ''}${aGain} dB  pico=${res.peak != null ? res.peak + ' dBFS' : '—'}`);
}
if (aTot) console.log(`Álbumes medidos ${aOk}/${aTot}.`); else console.log('Por álbum: nada que medir.');

if (DEMO) {
  console.log('\n== ReplayGain pista vs álbum (ganancia que aplicará el player) ==');
  console.log('  pista    álbum    título');
  db.prepare(`SELECT COALESCE(r.title, lf.path) t, lf.gain_db, lf.album_gain_db
     FROM local_file lf LEFT JOIN recording r ON r.id=lf.recording_id
     WHERE lf.gain_db IS NOT NULL ORDER BY lf.id LIMIT 16`).all()
    .forEach(r => { const f = v => v == null ? '  —  ' : ((v >= 0 ? '+' : '') + v.toFixed(1)).padStart(6); console.log(`  ${f(r.gain_db)}   ${f(r.album_gain_db)}   ${r.t}`); });
}
db.close();
