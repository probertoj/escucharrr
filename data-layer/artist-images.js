'use strict';
// escucharrr — fotos de artista desde fuentes ABIERTAS, sin clave ni dependencias.
//   MusicBrainz (artist inc=url-rels, 1 req/s + User-Agent)
//     -> relación 'image'  (imagen directa o página de Commons)         [preferida]
//     -> relación 'wikidata' Q… -> Wikidata P18 -> Commons Special:FilePath
//     -> relación 'wikipedia' -> Wikipedia REST summary -> originalimage/thumbnail
//   Se cachea en app/cache/artist/<id>.<ext> con PROCEDENCIA (igual que covers.js).
//
//   node artist-images.js --db ../app/escucharrr.db [--limit N] [--artist ID] [--force]
//
// Artistas sin MBID se saltan (no adivinamos por nombre). El servidor la sirve en /api/artist/image
// y la baja perezosamente la primera vez que se pide (igual que las portadas).

const { DatabaseSync } = require('node:sqlite');
const https = require('node:https');
const fs = require('fs');
const path = require('path');

const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// throttle de MusicBrainz (1,1 s/req, igual que enrich/identify)
let _mbLast = 0;
async function mbGet(url) {
  const wait = 1100 - (Date.now() - _mbLast); if (wait > 0) await sleep(wait);
  _mbLast = Date.now();
  return getJson(url);
}

// GET JSON siguiendo redirecciones. null si falla.
function getJson(url, depth) {
  depth = depth || 0;
  return new Promise(resolve => {
    if (depth > 6) return resolve(null);
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(getJson(new URL(res.headers.location, url).toString(), depth + 1)); }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => req.destroy());
  });
}
// GET binario siguiendo redirecciones. {status, buf, mime}.
function getBuffer(url, depth) {
  depth = depth || 0;
  return new Promise(resolve => {
    if (depth > 6) return resolve({ status: 0, buf: null, mime: null });
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'image/*' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(getBuffer(new URL(res.headers.location, url).toString(), depth + 1)); }
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, buf: null, mime: null }); }
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: 200, buf: Buffer.concat(chunks), mime: (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || null }));
    });
    req.on('error', () => resolve({ status: 0, buf: null, mime: null }));
    req.setTimeout(30000, () => req.destroy());
  });
}

const commonsFilePath = (file) => 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(String(file).replace(/^File:/i, '')) + '?width=500';

// Resuelve una URL de imagen para el MBID del artista (o null). Hace como mucho 3 peticiones.
async function resolveArtistImageUrl(mbid) {
  const a = await mbGet('https://musicbrainz.org/ws/2/artist/' + mbid + '?inc=url-rels&fmt=json');
  if (!a || !Array.isArray(a.relations)) return null;
  let wiki = null, qid = null;
  for (const rel of a.relations) {
    const u = (rel.url && rel.url.resource) || '';
    if (rel.type === 'image' && u) {                       // imagen directa o página de Commons
      const m = u.match(/\/wiki\/(File:[^?#]+)/i) || u.match(/[?&]title=(File:[^&]+)/i);
      if (m) return commonsFilePath(decodeURIComponent(m[1]));   // página de Commons (aunque acabe en .jpg) → imagen real
      if (/\.(jpe?g|png|gif|webp)$/i.test(u)) return u;    // URL de imagen directa
      return commonsFilePath(u.split('/').pop());
    }
    if (rel.type === 'wikidata') { const m = u.match(/(Q\d+)/); if (m) qid = m[1]; }
    else if (rel.type === 'wikipedia') wiki = u;
  }
  if (qid) {                                               // Wikidata P18 → foto en Commons
    const w = await getJson('https://www.wikidata.org/wiki/Special:EntityData/' + qid + '.json');
    try {
      const claim = w.entities[qid].claims.P18[0].mainsnak.datavalue.value;
      if (claim) return commonsFilePath(claim);
    } catch (e) {}
  }
  if (wiki) {                                              // Wikipedia summary → originalimage/thumbnail
    const m = wiki.match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/);
    if (m) {
      const s = await getJson('https://' + m[1] + '.wikipedia.org/api/rest_v1/page/summary/' + m[2]);
      const src = s && ((s.originalimage && s.originalimage.source) || (s.thumbnail && s.thumbnail.source));
      if (src) return src;
    }
  }
  return null;
}

// Descarga y cachea la foto de un artista. Devuelve {found} | {miss} | {status} (transitorio).
async function fetchArtistImageFor(db, { id, mbid, appDir }) {
  const dir = path.join(appDir, 'cache', 'artist');
  const setImg = db.prepare("UPDATE artist SET image_path=?, image_mime=?, updated_at=datetime('now') WHERE id=?");
  const prov = db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at)
     VALUES('artist',?,'image',?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`);
  if (!mbid) { prov.run(id, 'none', null); return { miss: true }; }
  let url = null; try { url = await resolveArtistImageUrl(mbid); } catch (e) { return { status: 1 }; }   // error de red → reintentable
  if (!url) { prov.run(id, 'none', null); return { miss: true }; }
  const r = await getBuffer(url);
  if (r.status !== 200 || !r.buf || !EXT[r.mime]) { if (r.status === 404) { prov.run(id, 'none', url); return { miss: true }; } return { status: r.status || 1 }; }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const rel = path.join('cache', 'artist', id + '.' + EXT[r.mime]);
  try { fs.writeFileSync(path.join(appDir, rel), r.buf); } catch (e) { return { status: 1 }; }
  setImg.run(rel, r.mime, id); prov.run(id, 'wikimedia', url);
  return { found: true };
}

module.exports = { fetchArtistImageFor, resolveArtistImageUrl };

// ── CLI (backfill) ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; };
  const DB_PATH = arg('db', path.join(__dirname, '..', 'app', 'escucharrr.db'));
  const APP_DIR = path.join(path.dirname(path.resolve(DB_PATH)));
  const ONE = arg('artist', null) != null ? parseInt(arg('artist'), 10) : null;
  const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
  const FORCE = process.argv.includes('--force');
  const db = new DatabaseSync(DB_PATH);
  require('./migrate').migrate(db);
  (async () => {
    let q = `SELECT id, name, mbid FROM artist WHERE mbid IS NOT NULL`;
    if (ONE != null) q += ` AND id=${ONE}`;
    else if (!FORCE) q += ` AND image_path IS NULL AND NOT EXISTS(SELECT 1 FROM provenance p WHERE p.subject_type='artist' AND p.subject_id=artist.id AND p.field='image')`;
    q += ` ORDER BY id`; if (LIMIT) q += ` LIMIT ${LIMIT}`;
    const rows = db.prepare(q).all();
    console.log(rows.length + ' artistas a procesar');
    let found = 0, miss = 0, err = 0;
    for (const a of rows) {
      const r = await fetchArtistImageFor(db, { id: a.id, mbid: a.mbid, appDir: APP_DIR });
      if (r.found) { found++; console.log('  ✓ ' + a.name); }
      else if (r.miss) { miss++; console.log('  — ' + a.name + ' (sin foto)'); }
      else { err++; console.log('  ! ' + a.name + ' (reintentable)'); }
    }
    console.log(`listo: ${found} con foto, ${miss} sin foto, ${err} reintentables`);
    db.close();
  })().catch(e => { console.error(e.message); process.exit(1); });
}
