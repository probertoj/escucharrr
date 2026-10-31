'use strict';
// escucharrr — carátulas reales desde COVER ART ARCHIVE (abierto, sin clave).
// Por MBID de release-group pedimos la portada frontal (atajo /front-<size>, que
// redirige al almacenamiento de archive.org) y la CACHEAMOS en local con PROCEDENCIA.
// Sin dependencias (node:https + node:sqlite). El SVG geométrico queda de respaldo
// (lo sirve el servidor cuando no hay carátula cacheada).
//
//   node covers.js --db ../app/escucharrr.db [--size 500] [--limit N] [--rg ID] [--force]
//
// Entidades sin MBID se saltan (identificador fuerte; no adivinamos por nombre).

const { DatabaseSync } = require('node:sqlite');
const https = require('node:https');
const fs = require('fs');
const path = require('path');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', path.join(__dirname, '..', 'app', 'escucharrr.db'));
const SIZE = String(arg('size', '500'));                 // 250 | 500 | 1200
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const ONE_RG = arg('rg', null) != null ? parseInt(arg('rg'), 10) : null;
const FORCE = process.argv.includes('--force');
const APP_DIR = path.join(__dirname, '..', 'app');
const CACHE_DIR = path.join(APP_DIR, 'cache', 'covers');

const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

// GET binario siguiendo redirecciones (CAA → archive.org). Devuelve {status, buf, mime}.
function getBuffer(url, depth) {
  depth = depth || 0;
  return new Promise(resolve => {
    if (depth > 6) return resolve({ status: 0, buf: null, mime: null });
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'image/*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(getBuffer(new URL(res.headers.location, url).toString(), depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, buf: null, mime: null }); }
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: 200, buf: Buffer.concat(chunks), mime: (res.headers['content-type'] || '').split(';')[0].trim() || null }));
    });
    req.on('error', () => resolve({ status: 0, buf: null, mime: null }));
    req.setTimeout(30000, () => req.destroy());
  });
}

const db = new DatabaseSync(DB_PATH);
require('./migrate').migrate(db);                         // garantiza release_group.cover_path/cover_mime

const S = {
  albums: db.prepare(`SELECT id, title, mbid FROM release_group WHERE mbid IS NOT NULL${ONE_RG != null ? ' AND id=?' : ''} ORDER BY id`),
  provGet: db.prepare("SELECT 1 FROM provenance WHERE subject_type='release_group' AND subject_id=? AND field='cover'"),
  setCover: db.prepare("UPDATE release_group SET cover_path=?, cover_mime=?, updated_at=datetime('now') WHERE id=?"),
  clearCover: db.prepare("UPDATE release_group SET cover_path=NULL, cover_mime=NULL WHERE id=?"),
  prov: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at)
     VALUES('release_group',?,'cover',?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`),
};

async function run() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let found = 0, miss = 0, skip = 0, done = 0;
  const rows = ONE_RG != null ? S.albums.all(ONE_RG) : S.albums.all();
  for (const a of rows) {
    if (LIMIT && done >= LIMIT) break;
    if (!FORCE && S.provGet.get(a.id)) { skip++; continue; }       // ya consultado (hubo o no portada)
    done++;
    const page = `https://coverartarchive.org/release-group/${a.mbid}`;
    const r = await getBuffer(`${page}/front-${SIZE}`);
    await sleep(1000);                                             // cortesía con CAA/archive.org
    if (r.status === 404 || !r.buf) {                              // sin carátula frontal
      miss++; S.prov.run(a.id, 'none', page); console.log(`  —  ${a.title} (sin carátula)`);
      continue;
    }
    if (r.status !== 200) { miss++; console.log(`  …  ${a.title} (CAA ${r.status})`); continue; }
    const ext = EXT[r.mime] || 'jpg';
    const rel = path.join('cache', 'covers', `${a.id}.${ext}`);    // relativa a app/
    fs.writeFileSync(path.join(APP_DIR, rel), r.buf);
    S.setCover.run(rel.replace(/\\/g, '/'), r.mime || 'image/jpeg', a.id);
    S.prov.run(a.id, 'coverartarchive', page);
    found++;
    console.log(`  ✓  ${a.title} → ${rel} (${(r.buf.length / 1024).toFixed(0)} KiB)`);
  }
  console.log(`\nCarátulas: ${found} descargada(s), ${miss} sin carátula, ${skip} ya en caché (de ${rows.length} con MBID) -> ${CACHE_DIR}`);
  db.close();
}
run();
