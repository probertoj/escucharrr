'use strict';
// escucharrr — descarga de carátula frontal desde COVER ART ARCHIVE por MBID de release-group,
// con caché local y procedencia. Compartido entre covers.js (lote) y el servidor (descarga perezosa).
// Sin dependencias (node:https). El SVG geométrico queda de respaldo cuando no hay carátula.
const https = require('node:https');
const fs = require('fs');
const path = require('path');

const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
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

// Descarga y cachea la portada de UN release_group. db = conexión node:sqlite; appDir = carpeta app/.
// Marca provenance 'cover' (none | coverartarchive) para no reconsultar. En error transitorio (no 404)
// NO marca, para poder reintentar más tarde. Devuelve { found, miss?, status?, path?, mime? }.
async function fetchCoverFor(db, { id, mbid, appDir, size = 500 }) {
  if (!mbid) return { found: false };
  try { fs.mkdirSync(path.join(appDir, 'cache', 'covers'), { recursive: true }); } catch (e) {}
  const page = `https://coverartarchive.org/release-group/${mbid}`;
  const r = await getBuffer(`${page}/front-${size}`);
  const prov = db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at)
     VALUES('release_group',?,'cover',?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`);
  if (r.status === 404 || (r.status === 200 && !r.buf)) {   // CAA no tiene carátula → marcador negativo (si la BD está ocupada, reintentable)
    try { prov.run(id, 'none', page); return { found: false, miss: true }; } catch (e) { return { found: false, status: 'db' }; }
  }
  if (r.status !== 200 || !r.buf) return { found: false, status: r.status || 'net' };   // transitorio → reintentable
  const ext = EXT[r.mime] || 'jpg';
  const rel = path.join('cache', 'covers', `${id}.${ext}`).replace(/\\/g, '/');   // relativa a app/
  try { fs.writeFileSync(path.join(appDir, rel), r.buf); } catch (e) { return { found: false, status: 'write' }; }
  // Escrituras en BD tolerantes a bloqueo (SQLITE_BUSY con otro escritor): si fallan, es transitorio y
  // reintentable — el fichero ya está, solo falta apuntarlo. No dejamos el error propagar (atascaría la cola).
  try {
    db.prepare("UPDATE release_group SET cover_path=?, cover_mime=?, updated_at=datetime('now') WHERE id=?").run(rel, r.mime || 'image/jpeg', id);
    prov.run(id, 'coverartarchive', page);
  } catch (e) { return { found: false, status: 'db' }; }
  return { found: true, path: rel, mime: r.mime };
}

module.exports = { getBuffer, fetchCoverFor };
