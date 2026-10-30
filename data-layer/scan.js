'use strict';
// escucharrr — escaneo de ficheros locales -> local_file + mapeo por tags al grafo.
// Sin dependencias: parsea cabeceras FLAC (STREAMINFO + VORBIS_COMMENT) y WAV (fmt/data).
//   node scan.js --db escucharrr.db --root "C:\\ruta\\a\\musica" [--demo]
// Los ficheros no se modifican (solo lectura).

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', 'escucharrr.db');
const ROOT = arg('root');
const DEMO = process.argv.includes('--demo');
if (!ROOT) { console.error('Falta --root <carpeta de música>'); process.exit(1); }

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
require('./migrate').migrate(db);              // columnas isrc/acoustid/fingerprint si faltan

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

// ── statements / helpers del grafo ────────────────────────────────────────────
const S = {
  artistByName: db.prepare('SELECT id FROM artist WHERE name=?'),
  insArtist: db.prepare('INSERT INTO artist(name,sort_name) VALUES(?,?)'),
  creditFor: db.prepare(`SELECT acn.artist_credit_id id FROM artist_credit_name acn WHERE acn.position=1 AND acn.artist_id=? AND acn.name=? AND (SELECT COUNT(*) FROM artist_credit_name x WHERE x.artist_credit_id=acn.artist_credit_id)=1 LIMIT 1`),
  insCredit: db.prepare('INSERT INTO artist_credit DEFAULT VALUES'),
  insCreditName: db.prepare("INSERT INTO artist_credit_name(artist_credit_id,position,artist_id,name,join_phrase) VALUES(?,1,?,?,'')"),
  rgBy: db.prepare('SELECT id FROM release_group WHERE title=? AND artist_credit_id=?'),
  insRg: db.prepare('INSERT INTO release_group(title,artist_credit_id,primary_type,first_release) VALUES(?,?,?,?)'),
  relByRg: db.prepare('SELECT id FROM "release" WHERE release_group_id=? LIMIT 1'),
  insRel: db.prepare('INSERT INTO "release"(release_group_id,title,artist_credit_id,date,format) VALUES(?,?,?,?,?)'),
  medBy: db.prepare('SELECT id FROM medium WHERE release_id=? AND position=?'),
  insMed: db.prepare('INSERT INTO medium(release_id,position,format) VALUES(?,?,?)'),
  recBy: db.prepare('SELECT id FROM recording WHERE title=? AND artist_credit_id=?'),
  insRec: db.prepare('INSERT INTO recording(title,artist_credit_id,length_ms) VALUES(?,?,?)'),
  trackBy: db.prepare('SELECT id FROM track WHERE medium_id=? AND position=?'),
  insTrack: db.prepare('INSERT INTO track(medium_id,position,recording_id,title,artist_credit_id,length_ms) VALUES(?,?,?,?,?,?)'),
  genreBy: db.prepare('SELECT id FROM genre WHERE name=?'),
  insGenre: db.prepare('INSERT INTO genre(name) VALUES(?)'),
  linkGenre: db.prepare('INSERT OR IGNORE INTO release_group_genre(release_group_id,genre_id) VALUES(?,?)'),
  insFile: db.prepare(`INSERT INTO local_file(path,format,sample_rate,bit_depth,channels,duration_ms,size_bytes,mtime,isrc,acoustid,fingerprint,track_id,recording_id,match_by,match_conf)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET format=excluded.format,sample_rate=excluded.sample_rate,bit_depth=excluded.bit_depth,channels=excluded.channels,duration_ms=excluded.duration_ms,size_bytes=excluded.size_bytes,mtime=excluded.mtime,isrc=excluded.isrc,acoustid=excluded.acoustid,fingerprint=excluded.fingerprint,track_id=excluded.track_id,recording_id=excluded.recording_id,
       -- no degradar: conserva el match si el existente es más fuerte (p. ej. 'acoustid'/'isrc' de identify.js frente a 'tags' de un reescaneo)
       match_by=CASE WHEN COALESCE(excluded.match_conf,0)>=COALESCE(local_file.match_conf,0) THEN excluded.match_by ELSE local_file.match_by END,
       match_conf=CASE WHEN COALESCE(excluded.match_conf,0)>=COALESCE(local_file.match_conf,0) THEN excluded.match_conf ELSE local_file.match_conf END`),
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
const ensureRel = (rg, title, cid, date, fmt) => { const r = S.relByRg.get(rg); return r ? r.id : Number(S.insRel.run(rg, title, cid, date, fmt).lastInsertRowid); };
const ensureMed = (rel, pos, fmt) => { const r = S.medBy.get(rel, pos); return r ? r.id : Number(S.insMed.run(rel, pos, fmt).lastInsertRowid); };
const ensureRec = (title, cid, len) => { const r = S.recBy.get(title, cid); return r ? r.id : Number(S.insRec.run(title, cid, len).lastInsertRowid); };
const ensureGenre = (name) => { const r = S.genreBy.get(name); return r ? r.id : Number(S.insGenre.run(name).lastInsertRowid); };

// ── recorrido ─────────────────────────────────────────────────────────────────
function walk(dir, out) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f, out); else if (/\.(flac|wav)$/i.test(e.name)) out.push(f); } }
const files = []; walk(path.resolve(ROOT), files);

let ok = 0, ident = 0;
db.exec('BEGIN');
try {
  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    let parsed = null; try { parsed = ext === 'flac' ? readFlac(file) : readWav(file); } catch (e) { console.warn('  error leyendo', path.basename(file), e.message); }
    if (!parsed) continue;
    const st = fs.statSync(file), t = parsed.tags, inf = parsed.info;
    const album = t.ALBUM || path.basename(path.dirname(file));
    const artistName = t.ALBUMARTIST || t.ARTIST || 'Artista desconocido';
    const title = t.TITLE || path.basename(file).replace(/\.[^.]+$/, '');
    const trackNo = parseInt(t.TRACKNUMBER, 10) || (ok + 1);
    const discNo = parseInt(t.DISCNUMBER, 10) || 1;
    const identified = !!(t.ALBUM && (t.ARTIST || t.ALBUMARTIST) && t.TITLE);
    // identificadores embebidos (convención Picard) + ISRC + AcoustID
    const recMbid = t.MUSICBRAINZ_TRACKID || null;          // MBID de la grabación
    const relMbid = t.MUSICBRAINZ_ALBUMID || null;          // MBID de la edición
    const rgMbid = t.MUSICBRAINZ_RELEASEGROUPID || null;    // MBID del release-group
    const isrc = (t.ISRC || '').split(/[;,/]/)[0].trim() || null;
    const acoustid = t.ACOUSTID_ID || null;
    const fingerprint = t.ACOUSTID_FINGERPRINT || null;

    let trackId = null, recId = null;
    if (identified) {
      const aid = ensureArtist(artistName), cid = ensureCredit(aid, artistName);
      const rg = ensureRg(album, cid, (t.DATE || '').slice(0, 4) || null);
      if (t.GENRE) S.linkGenre.run(rg, ensureGenre(t.GENRE.toLowerCase()));  // minúscula: convención común con MB/Discogs
      const rel = ensureRel(rg, album, cid, t.DATE || null, ext.toUpperCase());
      const med = ensureMed(rel, discNo, ext.toUpperCase());
      const tcid = t.ARTIST ? ensureCredit(ensureArtist(t.ARTIST), t.ARTIST) : cid;
      recId = ensureRec(title, tcid, inf.durationMs);
      const ex = S.trackBy.get(med, trackNo);
      trackId = ex ? ex.id : Number(S.insTrack.run(med, trackNo, recId, title, tcid, inf.durationMs).lastInsertRowid);
      // propagar los MBID/ISRC del tag al grafo (solo si aún no los tiene)
      if (rgMbid) trySet(S.setRgMbid, rgMbid, rg);
      if (relMbid) trySet(S.setRelMbid, relMbid, rel);
      if (recMbid) trySet(S.setRecMbid, recMbid, recId);
      if (isrc || acoustid) S.setRecIsrc.run(isrc, acoustid, recId);
      ident++;
    }
    const matchBy = recMbid ? 'mb-tag' : (identified ? 'tags' : null);
    const matchConf = recMbid ? 0.95 : (identified ? 0.7 : null);
    S.insFile.run(file, ext.toUpperCase(), inf.sampleRate, inf.bits, inf.channels, inf.durationMs, st.size, String(st.mtimeMs), isrc, acoustid, fingerprint, trackId, recId, matchBy, matchConf);
    ok++;
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

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
