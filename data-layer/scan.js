'use strict';
// escucharrr — escaneo de ficheros locales -> local_file + mapeo por tags al grafo.
// Sin dependencias: parsea cabeceras FLAC (STREAMINFO + VORBIS_COMMENT) y WAV (fmt/data).
//   node scan.js --db escucharrr.db --root "C:\\ruta\\a\\musica" [--demo]
// Los ficheros no se modifican (solo lectura).

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const TAGS = require('./tags');   // MP3 (ID3v2) y M4A/MP4 (átomos): etiquetas + info, sin dependencias

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', 'escucharrr.db');
const ROOT = arg('root');
const DEMO = process.argv.includes('--demo');
const PRUNE = !process.argv.includes('--no-prune');   // poda ficheros ausentes + GC del grafo
// Umbral de lápida (modelo Roon): nº de escaneos limpios consecutivos sin ver un fichero antes de
// retirarlo. Por defecto 2 (un fallo transitorio nunca basta). --prune-now fuerza 1 (retirada en
// la primera pasada limpia) para cuando el usuario sabe que el montaje está sano.
const MISS_THRESHOLD = process.argv.includes('--prune-now') ? 1 : parseInt(arg('miss-threshold', '2'), 10) || 2;
// Generación de este escaneo: identifica los ficheros VISTOS (en carpetas leídas con éxito) ahora.
const SCAN_SEQ = Date.now();
if (!ROOT) { console.error('Falta --root <carpeta de música>'); process.exit(1); }

// Normaliza una ruta para comparar bajo Windows (separadores + minúsculas). Igual que prune.js.
const nrm = (p) => path.resolve(p).replace(/[\\/]+/g, '\\').toLowerCase();

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
require('./migrate').migrate(db);              // columnas isrc/acoustid/fingerprint si faltan
// Registro de ficheros/carpetas saltados (errores de lectura, p. ej. SMB del NAS) para mostrarlo en Ajustes.
db.exec(`CREATE TABLE IF NOT EXISTS skipped_file (path TEXT, reason TEXT, at TEXT DEFAULT (datetime('now')))`);
db.exec('DELETE FROM skipped_file');
const insSkip = db.prepare('INSERT INTO skipped_file(path, reason) VALUES(?, ?)');

// ── parsers de cabecera (solo lectura, sin cargar el fichero entero) ──────────
function readFlac(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4); fs.readSync(fd, magic, 0, 4, 0);
    if (magic.toString('latin1') !== 'fLaC') return null;
    let off = 4, info = null, tags = {};
    for (;;) {
      const h = Buffer.alloc(4); if (fs.readSync(fd, h, 0, 4, off) < 4) break; off += 4;
      const last = (h[0] & 0x80) !== 0, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
      if (type === 0) {                              // STREAMINFO
        const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off);
        const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
        const channels = ((b[12] >> 1) & 0x07) + 1;
        const bits = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
        const totalSamples = (b[13] & 0x0f) * 2 ** 32 + (b[14] * 2 ** 24 + b[15] * 2 ** 16 + b[16] * 2 ** 8 + b[17]);
        info = { sampleRate, channels, bits, durationMs: sampleRate ? Math.round(totalSamples / sampleRate * 1000) : null };
      } else if (type === 4) {                       // VORBIS_COMMENT
        const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off);
        let p = 0; const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
        { const vlen = u32(); p += vlen; }           // saltar vendor (longitud + string)
        const count = u32();
        for (let i = 0; i < count; i++) { const l = u32(); const s = b.toString('utf8', p, p + l); p += l; const eq = s.indexOf('='); if (eq > 0) tags[s.slice(0, eq).toUpperCase()] = s.slice(eq + 1); }
      }
      off += len;
      if (last) break;
    }
    return info ? { info, tags } : null;
  } finally { fs.closeSync(fd); }
}
function readWav(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096); const n = fs.readSync(fd, head, 0, 4096, 0);
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;
    let p = 12, fmt = null, dataSize = null;
    while (p + 8 <= n) {
      const id = head.toString('latin1', p, p + 4), sz = head.readUInt32LE(p + 4);
      if (id === 'fmt ') fmt = { channels: head.readUInt16LE(p + 10), sampleRate: head.readUInt32LE(p + 12), byteRate: head.readUInt32LE(p + 16), bits: head.readUInt16LE(p + 22) };
      else if (id === 'data') { dataSize = sz; break; }
      p += 8 + sz + (sz & 1);
    }
    if (!fmt) return null;
    return { info: { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, durationMs: (dataSize && fmt.byteRate) ? Math.round(dataSize / fmt.byteRate * 1000) : null }, tags: {} };
  } finally { fs.closeSync(fd); }
}

// DSF (Sony): cabecera DSD+fmt → tasa DSD (p.ej. 2822400), canales, duración. Las etiquetas
// van en ID3v2 (al final, en metadataPtr); de momento no se leen (se cae al nombre de fichero).
function readDsf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const h = Buffer.alloc(80); const n = fs.readSync(fd, h, 0, 80, 0);
    if (n < 80 || h.toString('latin1', 0, 4) !== 'DSD ' || h.toString('latin1', 28, 32) !== 'fmt ') return null;
    const channels = h.readUInt32LE(52), rate = h.readUInt32LE(56), sampleCount = Number(h.readBigUInt64LE(64));
    return { info: { sampleRate: rate, channels, bits: 1, durationMs: rate ? Math.round(sampleCount / rate * 1000) : null }, tags: {} };
  } finally { fs.closeSync(fd); }
}
// DFF (Philips DSDIFF, big-endian): busca el chunk 'FS  ' (tasa) y 'CHNL' (canales) en la cabecera.
function readDff(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, 4096, 0);
    if (n < 16 || b.toString('latin1', 0, 4) !== 'FRM8') return null;
    let rate = 2822400, channels = 2;
    const fsi = b.indexOf(Buffer.from('FS  ')); if (fsi >= 0 && fsi + 16 <= n) rate = b.readUInt32BE(fsi + 12);
    const ci = b.indexOf(Buffer.from('CHNL')); if (ci >= 0 && ci + 14 <= n) channels = b.readUInt16BE(ci + 12);
    return { info: { sampleRate: rate, channels, bits: 1, durationMs: null }, tags: {} };   // duración real la da ffmpeg al reproducir
  } finally { fs.closeSync(fd); }
}
// Etiqueta de formato legible para DSD según la tasa (como el "DSD64/128/256" de Roon).
function dsdLabel(rate) { return rate >= 22579200 ? 'DSD512' : rate >= 11289600 ? 'DSD256' : rate >= 5644800 ? 'DSD128' : rate >= 2822400 ? 'DSD64' : 'DSD'; }
// ── Fallback SIN ETIQUETAS: deriva artista/álbum/título de la carpeta y el nombre de fichero, para que
// un álbum sin tags (descargas, rips crudos) APAREZCA agrupado por carpeta en vez de quedar invisible. ──
const _RELJUNK = /\b(web|webrip|flac|mp3|m4a|aac|wav|ape|alac|vinyl|cd|cdrip|vbr|cbr|v0|v2|320|256|128|24bit|16bit|\d{2,3}\s?khz|hi-?res|lossless|scene|promo|advance|reissue|remaster(?:ed)?|deluxe|premaxxxing)\b/ig;
const _clean = s => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const _stripRel = s => _clean(String(s || '').replace(/\[[^\]]*\]/g, ' ').replace(/\((?:19|20)\d{2}\)/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(_RELJUNK, ' ').replace(/\s*[-–]\s*$/, ''));
function folderMeta(dir) {   // "Artista - Álbum" (con espacios o pegado) → {artist, album}; si no, solo álbum
  const base = path.basename(dir);
  let parts = base.split(/\s+[-–]\s+/);
  if (parts.length < 2) parts = base.split(/(?<=[\p{L}\p{N}])-(?=\p{L})/u);
  if (parts.length >= 2) { const artist = _stripRel(parts[0]), album = _stripRel(parts.slice(1).join(' ')); if (artist.length >= 2 && album) return { artist, album }; }
  return { artist: null, album: _stripRel(base) || _clean(base) };
}
// ── Multi-disco (estilo Roon): varias subcarpetas CD1/CD2 (o un marcador "CDn" en el título) son DISCOS de
// UN álbum, no álbumes distintos. Detectamos la carpeta de disco (→ el álbum es la carpeta padre) y quitamos
// el "CDn/Disc n" del final del título para que todos los discos resuelvan al MISMO release_group (medium por disco). ──
// Carpeta de disco: "CD1", "Disc 2", "Vol. 1", "Digital Media 01" (nombre de soporte MusicBrainz, muy común en
// descargas multidisco), y también con texto descriptivo tras el número —muy común en cajas— como
// "Disc 1 (Original Album)" o "CD2 - Bonus". El texto solo cuenta tras un separador (espacio/.-:(), etc.), así
// que "Discovery" (sin dígito) y "Use Your Illusion II" (no empieza por cd/disc/vol/digital media) NO casan.
const _DISC_DIR_RE = /^(?:cd|dis[ck]|disco|disque|volume|vol|digital\s*media)\s*\.?\s*0*(\d{1,2})(?:[\s._\-–—:()\[\]].*)?$/i;
const _DISC_TITLE_RE = /[\s\-–—_]*[\[(]?\s*(?:cd|dis[ck]|disco|disque)\s*\.?\s*0*(\d{1,2})\s*[)\]]?\s*$/i;   // "… CD1", "… (Disc 2)" al final del título
// Artista del ÁLBUM cuando NO hay ALBUMARTIST: quita el "feat./ft./featuring…" del ARTIST de la pista, para que
// todas las colaboraciones de un mismo disco resuelvan al MISMO release_group (bug Charli XCX: 11 pistas con
// distinto «feat.» → 11 álbumes). El crédito de CADA PISTA conserva su ARTIST completo (tcid, abajo).
const _FEAT_RE = /\s*[\(\[]?\s*(?:feat\.?|ft\.?|featuring|f\/)\s+.*$/i;
function _albumArtistBase(s) { if (!s) return s; const b = String(s).replace(_FEAT_RE, '').trim(); return b || String(s).trim(); }
// Carpeta-ARTISTA que marca recopilatorio (convención MB/Roon). Estricto: NO incluye "desconocido/unknown"
// (eso es artista desconocido, no VA) ni "varios" a secas.
const _VA_FOLDER_RE = /^(?:various\s*artists|varios\s*artistas|v\.?\s*a\.?|va)$/i;
function discInfo(dir, rawAlbum) {
  let discFolder = null, albumDir = dir;
  const dm = _DISC_DIR_RE.exec(path.basename(dir));
  if (dm) { discFolder = parseInt(dm[1], 10) || null; albumDir = path.dirname(dir); }   // la carpeta es un disco → el álbum es la de arriba
  let album = String(rawAlbum || ''), titleDisc = null;
  const tm = _DISC_TITLE_RE.exec(album);
  if (tm) { const base = album.slice(0, tm.index).trim(); if (base.length >= 2) { titleDisc = parseInt(tm[1], 10) || null; album = base; } }   // quita "CDn" solo si queda un título con sentido
  return { albumDir, discFolder, album: album || String(rawAlbum || ''), titleDisc };
}
function titleFromName(file, artistName) {
  let n = path.basename(file).replace(/\.[^.]+$/, '');
  n = n.replace(/^\s*\d{1,3}\s*[-._)\s]\s*/, '');        // nº de pista inicial
  n = n.replace(/[-_][a-z0-9]{5,8}$/i, '');              // hash de release al final (p. ej. -14ajwq)
  if (artistName && artistName !== 'Artista desconocido') { const re = new RegExp('^' + artistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–_\\s]+', 'i'); n = n.replace(re, ''); }   // quita "Artista-" si va delante
  return _clean(n) || path.basename(file);
}

// ── statements / helpers del grafo ────────────────────────────────────────────
const S = {
  artistByName: db.prepare('SELECT id FROM artist WHERE name=?'),
  insArtist: db.prepare('INSERT INTO artist(name,sort_name) VALUES(?,?)'),
  creditFor: db.prepare(`SELECT acn.artist_credit_id id FROM artist_credit_name acn WHERE acn.position=1 AND acn.artist_id=? AND acn.name=? AND (SELECT COUNT(*) FROM artist_credit_name x WHERE x.artist_credit_id=acn.artist_credit_id)=1 LIMIT 1`),
  insCredit: db.prepare('INSERT INTO artist_credit DEFAULT VALUES'),
  insCreditName: db.prepare("INSERT INTO artist_credit_name(artist_credit_id,position,artist_id,name,join_phrase) VALUES(?,1,?,?,'')"),
  rgBy: db.prepare('SELECT id FROM release_group WHERE title=? AND artist_credit_id=?'),
  insRg: db.prepare('INSERT INTO release_group(title,artist_credit_id,primary_type,first_release) VALUES(?,?,?,?)'),
  relByRgDir: db.prepare('SELECT id FROM "release" WHERE release_group_id=? AND source_dir=?'),   // la copia exacta (carpeta)
  relUnclaimed: db.prepare('SELECT id FROM "release" WHERE release_group_id=? AND source_dir IS NULL LIMIT 1'),  // release antiguo (pre-versiones) a adoptar
  claimRel: db.prepare('UPDATE "release" SET source_dir=? WHERE id=?'),
  insRel: db.prepare('INSERT INTO "release"(release_group_id,title,artist_credit_id,date,format,source_dir) VALUES(?,?,?,?,?,?)'),
  medBy: db.prepare('SELECT id FROM medium WHERE release_id=? AND position=?'),
  insMed: db.prepare('INSERT INTO medium(release_id,position,format) VALUES(?,?,?)'),
  recBy: db.prepare('SELECT id FROM recording WHERE title=? AND artist_credit_id=?'),
  insRec: db.prepare('INSERT INTO recording(title,artist_credit_id,length_ms) VALUES(?,?,?)'),
  trackBy: db.prepare('SELECT id FROM track WHERE medium_id=? AND position=?'),
  insTrack: db.prepare('INSERT INTO track(medium_id,position,recording_id,title,artist_credit_id,length_ms) VALUES(?,?,?,?,?,?)'),
  genreBy: db.prepare('SELECT id FROM genre WHERE name=?'),
  insGenre: db.prepare('INSERT INTO genre(name) VALUES(?)'),
  linkGenre: db.prepare('INSERT OR IGNORE INTO release_group_genre(release_group_id,genre_id) VALUES(?,?)'),
  insFile: db.prepare(`INSERT INTO local_file(path,format,sample_rate,bit_depth,channels,duration_ms,size_bytes,mtime,isrc,acoustid,fingerprint,track_id,recording_id,match_by,match_conf,scan_seq,missing_since,missing_count)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,0)
     ON CONFLICT(path) DO UPDATE SET format=excluded.format,sample_rate=excluded.sample_rate,bit_depth=excluded.bit_depth,channels=excluded.channels,duration_ms=excluded.duration_ms,size_bytes=excluded.size_bytes,mtime=excluded.mtime,isrc=excluded.isrc,acoustid=excluded.acoustid,fingerprint=excluded.fingerprint,track_id=excluded.track_id,recording_id=excluded.recording_id,
       -- visto en este escaneo: estampa la generación y limpia cualquier lápida
       scan_seq=excluded.scan_seq, missing_since=NULL, missing_count=0,
       -- no degradar: conserva el match si el existente es más fuerte (p. ej. 'acoustid'/'isrc' de identify.js frente a 'tags' de un reescaneo)
       match_by=CASE WHEN COALESCE(excluded.match_conf,0)>=COALESCE(local_file.match_conf,0) THEN excluded.match_by ELSE local_file.match_by END,
       match_conf=CASE WHEN COALESCE(excluded.match_conf,0)>=COALESCE(local_file.match_conf,0) THEN excluded.match_conf ELSE local_file.match_conf END`),
  // Reconciliación de movimientos/renombrados (modelo Roon: rebind por identidad, no borrar+recrear).
  fileByPath: db.prepare('SELECT id FROM local_file WHERE path=?'),
  fileByNorm: db.prepare('SELECT id, path FROM local_file WHERE path=? OR path=?'),   // formas NFC/NFD
  moveByFinger: db.prepare('SELECT id, path FROM local_file WHERE fingerprint IS NOT NULL AND fingerprint=?'),
  moveByIsrcSize: db.prepare('SELECT id, path FROM local_file WHERE isrc IS NOT NULL AND isrc=? AND size_bytes=?'),
  moveBySizeDur: db.prepare('SELECT id, path FROM local_file WHERE size_bytes=? AND duration_ms IS NOT NULL AND duration_ms=?'),
  renamePath: db.prepare('UPDATE local_file SET path=? WHERE id=?'),
  setRgMbid: db.prepare('UPDATE release_group SET mbid=? WHERE id=? AND mbid IS NULL'),
  setRelMbid: db.prepare('UPDATE "release" SET mbid=? WHERE id=? AND mbid IS NULL'),
  setRecMbid: db.prepare('UPDATE recording SET mbid=? WHERE id=? AND mbid IS NULL'),
  setRecIsrc: db.prepare('UPDATE recording SET isrc=COALESCE(isrc,?), acoustid=COALESCE(acoustid,?) WHERE id=?'),
};
// mbid es UNIQUE: si otra fila ya lo tiene, el tag está duplicado -> lo ignoramos sin romper.
const trySet = (stmt, ...a) => { try { stmt.run(...a); } catch (e) { if (!/UNIQUE/i.test(e.message)) throw e; } };
const ensureArtist = (name) => { const r = S.artistByName.get(name); return r ? r.id : Number(S.insArtist.run(name, name).lastInsertRowid); };
const ensureCredit = (aid, name) => { const r = S.creditFor.get(aid, name); if (r) return r.id; const c = Number(S.insCredit.run().lastInsertRowid); S.insCreditName.run(c, aid, name); return c; };
const ensureRg = (title, cid, year) => { const r = S.rgBy.get(title, cid); return r ? r.id : Number(S.insRg.run(title, cid, 'album', year).lastInsertRowid); };
// Versiones por carpeta (estilo Roon): un `release` por copia física (carpeta de álbum). Clave = (rg, source_dir).
// Si ya existe esa carpeta, se reutiliza; si no, se ADOPTA un release antiguo sin source_dir (migración, para no
// dejarlo huérfano al reescanear la única copia); si tampoco, se crea uno nuevo (segunda copia = otra versión).
const ensureRel = (rg, title, cid, date, fmt, srcDir) => {
  const r = S.relByRgDir.get(rg, srcDir); if (r) return r.id;
  const u = S.relUnclaimed.get(rg); if (u) { S.claimRel.run(srcDir, u.id); return u.id; }
  return Number(S.insRel.run(rg, title, cid, date, fmt, srcDir).lastInsertRowid);
};
const ensureMed = (rel, pos, fmt) => { const r = S.medBy.get(rel, pos); return r ? r.id : Number(S.insMed.run(rel, pos, fmt).lastInsertRowid); };
const ensureRec = (title, cid, len) => { const r = S.recBy.get(title, cid); return r ? r.id : Number(S.insRec.run(title, cid, len).lastInsertRowid); };
const ensureGenre = (name) => { const r = S.genreBy.get(name); return r ? r.id : Number(S.insGenre.run(name).lastInsertRowid); };

// ── recorrido ─────────────────────────────────────────────────────────────────
// Espera síncrona (bloqueante) para reintentos sobre rutas de red (SMB): un readdir/stat sobre
// \\Diskstation puede fallar de forma transitoria (timeout, ENOENT fugaz) y recuperarse enseguida.
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} }
function readdirRetry(dir, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { last = e; if (i < tries - 1) sleepSync(400 * (i + 1)); }   // 400/800/1200/1600/2000ms (SMB se recupera lento)
  }
  throw last;
}
function statRetry(file, tries = 4) {   // stat de un fichero de red con reintentos (flaqueo SMB transitorio)
  let last;
  for (let i = 0; i < tries; i++) {
    try { return fs.statSync(file); }
    catch (e) { last = e; if (i < tries - 1) sleepSync(300 * (i + 1)); }
  }
  throw last;
}
// okDirs: carpetas enumeradas CON ÉXITO en este escaneo. seenPaths: ficheros de música VISTOS en
// disco (normalizados), se parseen o no. La poda solo retira un fichero si su carpeta está en
// okDirs y su ruta NO está en seenPaths — así un fallo de lectura (SMB) nunca marca nada ausente.
const okDirs = new Set();
const seenPaths = new Set();
const AUDIO_RE = /\.(flac|wav|dsf|dff|mp3|m4a|aac|aiff|aif|ogg|oga|opus)$/i;   // sin pérdida + MP3/M4A/AAC/AIFF/OGG/Opus
// Extensiones que SON audio pero que aún no sabemos leer: se registran como "formato no soportado" para que el
// usuario vea que esos ficheros existen pero no entraron (como "Skipped Files" de Roon), en vez de ignorarlos en
// silencio. NO incluye audiolibros DRM (.m4p) ni material no musical (.cue/.log/.jpg): solo audio reproducible.
const UNSUPPORTED_AUDIO_RE = /\.(wma|ape|wv|tak|tta|mpc|m4b|mka|spx|mp2|mp1|shn|caf|aifc|au|snd|ra|amr|alac)$/i;
const skippedUnsup = new Set();   // evita duplicar un mismo fichero si su carpeta se re-visita en una pasada de recuperación
const deferredDirs = [];        // carpetas ilegibles tras los reintentos cortos → se reintentan en pasadas posteriores
let consecFail = 0;             // carpetas ilegibles CONSECUTIVAS: señal de que el montaje/red cayó
// Enumera una carpeta; si falla tras los reintentos cortos, la DIFIERE (aún no la salta). Ante una racha de
// fallos (share caído), espera a que el montaje reconecte en vez de quemar cientos de carpetas a 6 reintentos.
function enumDir(dir) {
  try { const ents = readdirRetry(dir); okDirs.add(nrm(dir)); consecFail = 0; return ents; }
  catch (e) {
    if (++consecFail === 5 || (consecFail > 5 && consecFail % 25 === 0)) {
      console.warn('  [share] ' + consecFail + ' carpetas seguidas ilegibles: el montaje parece caído; espero reconexión (15s)…');
      sleepSync(15000);
      try { fs.readdirSync(path.resolve(ROOT)); consecFail = 0; } catch (x) {}   // la raíz respondió → el share volvió
    }
    deferredDirs.push({ dir, code: e.code || e.message });
    return null;
  }
}
function walk(dir, out) {
  const ents = enumDir(dir);
  if (!ents) return;            // diferida: se reintentará; sus ficheros NO entran en seenPaths → quedan protegidos
  for (const e of ents) {
    const f = path.join(dir, e.name);
    let isDir = false; try { isDir = e.isDirectory(); } catch (x) {}
    if (isDir) walk(f, out);
    else if (AUDIO_RE.test(e.name)) { out.push(f); seenPaths.add(nrm(f)); }
    else { const m = e.name.match(UNSUPPORTED_AUDIO_RE); if (m && !skippedUnsup.has(nrm(f))) { skippedUnsup.add(nrm(f)); try { insSkip.run(f, 'formato no soportado (.' + m[1].toLowerCase() + ')'); } catch (x) {} } }
  }
}
const files = []; walk(path.resolve(ROOT), files);
// Pasadas de recuperación sobre carpetas DIFERIDAS por flaqueo transitorio del SMB: hasta 3, con backoff
// creciente. Re-enumerar una diferida re-descubre su subárbol (al fallar no añadió nada, así que no duplica).
// Las que sigan ilegibles al final quedan FUERA de okDirs → sus ficheros están protegidos de la poda.
for (let pass = 1; pass <= 3 && deferredDirs.length; pass++) {
  const retry = deferredDirs.splice(0);   // vaciar; walk re-añade las que sigan fallando, para la pasada siguiente
  console.warn('  [share] recuperación pasada ' + pass + '/3: reintentando ' + retry.length + ' carpeta(s) diferida(s)…');
  sleepSync(5000 * pass);                  // 5s / 10s / 15s: da margen al SMB para reconectar
  consecFail = 0;
  for (const d of retry) walk(d.dir, files);
}
if (deferredDirs.length) {
  console.warn('  [share] ' + deferredDirs.length + ' carpeta(s) siguen ilegibles tras todas las pasadas (sus ficheros quedan PROTEGIDOS de la poda):');
  for (const d of deferredDirs) { console.warn('    ' + d.dir + ' (' + d.code + ')'); try { insSkip.run(d.dir, 'carpeta ilegible: ' + d.code); } catch (x) {} }
}
// Gate de montaje (modelo Roon "available but does not exist"): solo se puede podar si la RAÍZ se
// enumeró con éxito y vimos algún fichero. Si no, el volumen/red está caído o incompleto → no restar.
const mountHealthy = okDirs.has(nrm(ROOT)) && seenPaths.size > 0;
if (!mountHealthy) console.warn('  [montaje] raíz no enumerada o sin ficheros: se OMITE toda poda (posible red/volumen caído)');

// Reconciliación de movimientos/renombrados (modelo Roon: rebind por identidad, no borrar+recrear).
// Si una ruta es "nueva" pero corresponde a un fichero que ya teníamos (misma forma NFC/NFD, o misma
// huella/ISRC+tamaño/tamaño+duración y su ruta antigua ya no está), renombramos la fila existente en
// vez de insertar una nueva. Así se conserva el id, el análisis (loudness/peaks/gain) y el match, y
// la ruta antigua no queda como "ausente" para podar. Solo paga coste una ruta nueva.
function reconcileMove(file, size, durMs, isrc, fp) {
  if (S.fileByPath.get(file)) return null;                 // ya existe por ruta exacta → upsert normal
  try {                                                     // 1) misma ruta salvo normalización Unicode (carpetas acentuadas)
    const nfc = file.normalize('NFC'), nfd = file.normalize('NFD');
    if (nfc !== file || nfd !== file) { const r = S.fileByNorm.get(nfc, nfd); if (r && r.path !== file) { S.renamePath.run(file, r.id); return 'norm'; } }
  } catch (e) {}
  const gone = (p) => !seenPaths.has(nrm(p));               // la ruta antigua no se ha visto en este escaneo
  const uniqueGone = (rows) => { const c = rows.filter(r => gone(r.path) && nrm(r.path) !== nrm(file)); return c.length === 1 ? c[0] : null; };
  let src = fp ? uniqueGone(S.moveByFinger.all(fp)) : null;                                   // 2a) huella de audio: identidad exacta
  if (!src && isrc && size != null) src = uniqueGone(S.moveByIsrcSize.all(isrc, size));       // 2b) ISRC + tamaño
  if (!src && size != null && durMs != null) src = uniqueGone(S.moveBySizeDur.all(size, durMs)); // 2c) tamaño + duración
  if (src) { S.renamePath.run(file, src.id); return 'move'; }
  return null;
}

let ok = 0, ident = 0, moved = 0, normed = 0;
db.exec('BEGIN');
try {
  for (const file of files) {
   try {
    const ext = path.extname(file).slice(1).toLowerCase();
    const parseOne = () => ext === 'flac' ? readFlac(file) : ext === 'dsf' ? readDsf(file) : ext === 'dff' ? readDff(file)
      : ext === 'mp3' ? TAGS.readMp3(file) : (ext === 'm4a' || ext === 'aac') ? TAGS.readMp4(file)
      : (ext === 'aiff' || ext === 'aif') ? TAGS.readAiff(file) : (ext === 'ogg' || ext === 'oga' || ext === 'opus') ? TAGS.readOgg(file) : readWav(file);
    let parsed = null, perr = null;
    for (let i = 0; i < 2 && !parsed; i++) { try { parsed = parseOne(); } catch (e) { perr = e; if (i === 0) sleepSync(200); } }   // un reintento (SMB transitorio)
    if (!parsed && perr) { console.warn('  error leyendo', path.basename(file), perr.message); try { insSkip.run(file, 'error al leer: ' + (perr.code || perr.message)); } catch (x) {} }
    // Fichero de formato soportado cuya cabecera no se pudo reconocer (corrupto o mal nombrado): el parser
    // devuelve null sin lanzar. Antes desaparecía en silencio; ahora se registra para que se vea en "saltados".
    else if (!parsed) { try { insSkip.run(file, 'cabecera no reconocida (.' + ext + ')'); } catch (x) {} }
    if (!parsed) continue;
    const fmtLabel = (ext === 'dsf' || ext === 'dff') ? dsdLabel(parsed.info.sampleRate) : ext.toUpperCase();
    const st = statRetry(file), t = parsed.tags, inf = parsed.info;
    const dir = path.dirname(file);
    // Multi-disco: si el fichero está en una carpeta de disco (CD1/CD2…), el álbum es la carpeta padre.
    const bnDir = path.basename(dir);
    const discDirM = _DISC_DIR_RE.exec(bnDir);
    const albumDir = discDirM ? path.dirname(dir) : dir;      // directorio del ÁLBUM (no el del disco)
    const discFolder = discDirM ? (parseInt(discDirM[1], 10) || null) : null;
    // Recopilación (Various Artists): flag COMPILATION/cpil/TCMP, ALBUMARTIST = «Various Artists», o la
    // CARPETA-ARTISTA del álbum es "Various Artists"/"Varios Artistas"/"VA" (convención MB/Roon para comps;
    // NO "desconocido/unknown", que son álbumes de artista desconocido, no recopilatorios). Se agrupa TODO
    // el álbum bajo «Various Artists» (si no, cada pista con distinto ARTIST crea su propio release_group);
    // el crédito de cada PISTA conserva su artista real (abajo, tcid).
    const isComp = /^\s*(1|true|yes|y)\s*$/i.test(String(t.COMPILATION || ''))
      || /^\s*(various\s*artists|varios\s*artistas|v\.?\s*a\.?|varios|verschiedene(\s*interpreten)?|multi[\s-]?artist)\s*$/i.test(String(t.ALBUMARTIST || '').trim())
      || _VA_FOLDER_RE.test(path.basename(path.dirname(albumDir)));
    // derivación desde carpeta/fichero cuando faltan etiquetas (sobre el directorio del ÁLBUM)
    const fm = (!t.ALBUM || (!t.ALBUMARTIST && !t.ARTIST && !isComp)) ? folderMeta(albumDir) : { artist: null, album: null };
    const rawAlbum = t.ALBUM || fm.album || path.basename(albumDir);
    const di = discInfo(albumDir, rawAlbum);                  // quita "CDn/Disc n" del final del título
    const album = di.album;
    let artistName = t.ALBUMARTIST || _albumArtistBase(t.ARTIST) || fm.artist;   // sin ALBUMARTIST: base sin «feat.» (no partir el álbum)
    if (!artistName && !isComp) { const gp = path.dirname(albumDir); if (nrm(gp) !== nrm(ROOT) && path.basename(gp)) artistName = _clean(path.basename(gp)); }   // carpeta abuela del álbum = artista
    artistName = isComp ? 'Various Artists' : (artistName || 'Artista desconocido');
    const title = t.TITLE || titleFromName(file, artistName);
    const trackNo = parseInt(t.TRACKNUMBER, 10) || (ok + 1);
    const discNo = parseInt(t.DISCNUMBER, 10) || discFolder || di.titleDisc || 1;   // tag > carpeta de disco > marcador del título > 1
    const identified = !!(t.ALBUM && (t.ARTIST || t.ALBUMARTIST) && t.TITLE);   // "identificado" POR ETIQUETAS (Inspector)
    const haveGraph = !!(album && title);                                        // crea el álbum/pista aunque falten tags
    // identificadores embebidos (convención Picard) + ISRC + AcoustID
    const recMbid = t.MUSICBRAINZ_TRACKID || null;          // MBID de la grabación
    const relMbid = t.MUSICBRAINZ_ALBUMID || null;          // MBID de la edición
    const rgMbid = t.MUSICBRAINZ_RELEASEGROUPID || null;    // MBID del release-group
    const isrc = (t.ISRC || '').split(/[;,/]/)[0].trim() || null;
    const acoustid = t.ACOUSTID_ID || null;
    const fingerprint = t.ACOUSTID_FINGERPRINT || null;

    let trackId = null, recId = null;
    if (haveGraph) {
      const aid = ensureArtist(artistName), cid = ensureCredit(aid, artistName);
      const rg = ensureRg(album, cid, (t.DATE || '').slice(0, 4) || null);
      if (t.GENRE) S.linkGenre.run(rg, ensureGenre(t.GENRE.toLowerCase()));  // minúscula: convención común con MB/Discogs
      const rel = ensureRel(rg, album, cid, t.DATE || null, fmtLabel, nrm(albumDir));   // una copia (versión) por carpeta de álbum
      const med = ensureMed(rel, discNo, fmtLabel);
      const tcid = t.ARTIST ? ensureCredit(ensureArtist(t.ARTIST), t.ARTIST) : cid;
      recId = ensureRec(title, tcid, inf.durationMs);
      const ex = S.trackBy.get(med, trackNo);
      trackId = ex ? ex.id : Number(S.insTrack.run(med, trackNo, recId, title, tcid, inf.durationMs).lastInsertRowid);
      // propagar los MBID/ISRC del tag al grafo (solo si aún no los tiene)
      if (rgMbid) trySet(S.setRgMbid, rgMbid, rg);
      if (relMbid) trySet(S.setRelMbid, relMbid, rel);
      if (recMbid) trySet(S.setRecMbid, recMbid, recId);
      if (isrc || acoustid) S.setRecIsrc.run(isrc, acoustid, recId);
      if (identified) ident++;
    }
    const matchBy = recMbid ? 'mb-tag' : (identified ? 'tags' : (haveGraph ? 'folder' : null));
    const matchConf = recMbid ? 0.95 : (identified ? 0.7 : (haveGraph ? 0.35 : null));
    const rec = reconcileMove(file, st.size, inf.durationMs, isrc, fingerprint);   // rebind si es un movimiento/renombrado
    if (rec === 'move') moved++; else if (rec === 'norm') normed++;
    S.insFile.run(file, fmtLabel, inf.sampleRate, inf.bits, inf.channels, inf.durationMs, st.size, String(st.mtimeMs), isrc, acoustid, fingerprint, trackId, recId, matchBy, matchConf, SCAN_SEQ);
    ok++;
   } catch (fileErr) {   // error transitorio en un fichero (stat/lectura): no abortar todo el escaneo, saltarlo y seguir
    console.warn('  error procesando', path.basename(file), '(' + (fileErr.code || fileErr.message) + ')'); try { insSkip.run(file, 'error al procesar: ' + (fileErr.code || fileErr.message)); } catch (x) {}
   }
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

// Poda: quita de la biblioteca los ficheros borrados del disco (bajo esta raíz) y recoge la
// basura del grafo que ya no ancla nada. Así el ciclo de la biblioteca en vivo se cierra:
// borrar un .flac ya no deja su pista/álbum colgando. (--no-prune para desactivarla.)
if (PRUNE) {
  const prune = require('./prune');
  // Poda tolerante a red: solo retira un fichero cuya carpeta se enumeró OK (okDirs) y que no se vio
  // (seenPaths), y aun así con lápida (missing_count >= umbral). Gated al montaje sano.
  prune.pruneMissingFiles(db, [path.resolve(ROOT)], (m) => console.log('  ' + m), { seenPaths, okDirs, mountHealthy, scanSeq: SCAN_SEQ, missThreshold: MISS_THRESHOLD, nrm });
  prune.pruneEmptyReleases(db, (m) => console.log('  ' + m));   // retira copias (releases) sin ficheros tras reagrupar por carpeta
  prune.pruneGraph(db, (m) => console.log('  ' + m));
  prune.collapseBogusDiscs(db, (m) => console.log('  ' + m));   // repara "discos fantasma" de rips con TPOS=TRACKNUMBER
}

// FTS (instantánea por prefijo): artistas + álbumes
db.exec('DELETE FROM search_fts');
db.exec("INSERT INTO search_fts(name,kind,subject_type,subject_id) SELECT name,'artist','artist',id FROM artist");
db.exec("INSERT INTO search_fts(name,kind,subject_type,subject_id) SELECT title,'album','release_group',id FROM release_group");
db.exec("INSERT INTO search_fts(name,kind,subject_type,subject_id) SELECT title,'track','recording',id FROM recording");

const nIsrc = db.prepare('SELECT COUNT(*) n FROM local_file WHERE isrc IS NOT NULL').get().n;
const nMb = db.prepare("SELECT COUNT(*) n FROM local_file WHERE match_by='mb-tag'").get().n;
const nFp = db.prepare('SELECT COUNT(*) n FROM local_file WHERE fingerprint IS NOT NULL').get().n;
console.log(`Escaneados ${ok} ficheros (${ident} identificados por tags) -> ${DB_PATH}`);
console.log(`  identificadores embebidos: ${nMb} con MBID · ${nIsrc} con ISRC · ${nFp} con huella Chromaprint`);
if (moved || normed) console.log(`  reconciliados por identidad: ${moved} movimiento(s)/renombrado(s) · ${normed} por normalización Unicode (sin borrar+recrear)`);

if (DEMO) {
  const show = (l, rows) => { console.log('\n== ' + l + ' =='); rows.forEach(r => console.log('  ' + Object.values(r).join('  |  '))); };
  show('Ficheros (formato, SR, bits, canales, duración s)',
    db.prepare(`SELECT format, sample_rate, bit_depth, channels, round(duration_ms/1000.0,1) dur, substr(replace(path,rtrim(path,replace(path,'\\','')), ''),1,34) file FROM local_file ORDER BY path LIMIT 8`).all());
  show('Álbumes importados',
    db.prepare(`SELECT artist, title, year FROM v_album ORDER BY year`).all());
  show('Pistas del primer álbum',
    db.prepare(`SELECT tr.position, tr.title, round(tr.length_ms/1000.0) s FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE rel.release_group_id=(SELECT id FROM release_group ORDER BY id LIMIT 1) ORDER BY tr.position`).all());
}
db.close();
