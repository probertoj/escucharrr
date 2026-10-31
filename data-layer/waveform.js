'use strict';
// escucharrr — waveform: picos por pista para la barra de onda (estilo Roon). Usa ffmpeg para
// decodificar a PCM mono de baja tasa y resume en ~200 picos (0-255) que se guardan en
// local_file.peaks (base64). Sin dependencias (node:sqlite + ffmpeg en el PATH).
//
//   node waveform.js --db ../app/escucharrr.db [--bins 200] [--limit N] [--rg ID] [--force]

const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const path = require('path');
const fs = require('fs');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', path.join(__dirname, '..', 'app', 'escucharrr.db'));
const BINS = parseInt(arg('bins', '200'), 10) || 200;
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const ONE_RG = arg('rg', null) != null ? parseInt(arg('rg'), 10) : null;
const FORCE = process.argv.includes('--force');

// Decodifica a u8 mono 4 kHz y resume en BINS picos (máx |muestra-128| por bucket, escalado a 0-255).
function peaksFor(file) {
  let r; try { r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', '4000', '-f', 'u8', '-'], { maxBuffer: 1 << 28 }); } catch (e) { return null; }
  if (!r || r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  const buf = r.stdout, total = buf.length, bucket = Math.max(1, Math.floor(total / BINS)), out = Buffer.alloc(BINS);
  for (let i = 0; i < BINS; i++) {
    let mx = 0; const s = i * bucket, e = i === BINS - 1 ? total : Math.min(total, s + bucket);
    for (let j = s; j < e; j++) { const a = Math.abs(buf[j] - 128); if (a > mx) mx = a; }
    out[i] = Math.min(255, mx * 2);
  }
  return out.toString('base64');
}

const db = new DatabaseSync(DB_PATH);
require('./migrate').migrate(db);

const rows = db.prepare(`SELECT lf.id, lf.path, lf.peaks, lf.track_id FROM local_file lf
  WHERE lf.path IS NOT NULL${ONE_RG != null ? ` AND lf.track_id IN (SELECT tr.id FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE rel.release_group_id=${ONE_RG})` : ''} ORDER BY lf.id`).all();
const upd = db.prepare('UPDATE local_file SET peaks=? WHERE id=?');

let done = 0, ok = 0, miss = 0, skip = 0;
for (const r of rows) {
  if (LIMIT && done >= LIMIT) break;
  if (r.peaks && !FORCE) { skip++; continue; }
  if (!fs.existsSync(r.path)) { miss++; continue; }
  done++;
  const p = peaksFor(r.path);
  if (!p) { miss++; console.log('  —  sin waveform:', path.basename(r.path)); continue; }
  upd.run(p, r.id); ok++;
  console.log('  ✓ ', path.basename(r.path));
}
console.log(`\nWaveform: ${ok} generada(s), ${miss} sin waveform, ${skip} ya hechas (de ${rows.length}) -> ${DB_PATH}`);
db.close();
