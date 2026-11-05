'use strict';
// escucharrr — lectura de etiquetas + info de audio para formatos CON PÉRDIDA, sin dependencias:
//   MP3  → ID3v2 (2.3/2.4) + cabecera MPEG (+ Xing/Info para VBR)
//   M4A/MP4 (AAC/ALAC) → átomos moov/ilst + mvhd/mdhd/stsd
// Devuelve la misma forma que readFlac de scan.js: { info:{sampleRate,channels,bits,durationMs}, tags:{...} }
// con las CLAVES EN MAYÚSCULA estilo Vorbis (ALBUM, ARTIST, TITLE, TRACKNUMBER, DATE, GENRE, MUSICBRAINZ_*…),
// para que el ingestor las consuma igual que las de FLAC. Y extractores de carátula embebida (APIC / covr).
const fs = require('fs');

// ── géneros ID3v1 (para TCON numérico «(17)») ──
const ID3V1_GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall'];
function mapGenre(s) {
  s = String(s || '').trim(); if (!s) return null;
  const m = s.match(/^\(?(\d+)\)?$/); if (m) { const g = ID3V1_GENRES[+m[1]]; return g || null; }
  return s.replace(/^\((\d+)\)/, (x, n) => (ID3V1_GENRES[+n] || '') + ' ').trim() || s;
}
const synchsafe = b => (b[0] & 0x7f) * 0x200000 + (b[1] & 0x7f) * 0x4000 + (b[2] & 0x7f) * 0x80 + (b[3] & 0x7f);

// decodifica el texto de un frame ID3 (primer byte = codificación), quita nulos de cola
function id3Text(buf) {
  if (!buf.length) return '';
  const enc = buf[0]; let body = buf.subarray(1);
  let s;
  if (enc === 1) {        // UTF-16 con BOM
    if (body[0] === 0xff && body[1] === 0xfe) s = body.subarray(2).toString('utf16le');
    else if (body[0] === 0xfe && body[1] === 0xff) s = swap16(body.subarray(2)).toString('utf16le');
    else s = body.toString('utf16le');
  } else if (enc === 2) { // UTF-16BE sin BOM
    s = swap16(body).toString('utf16le');
  } else if (enc === 3) { // UTF-8
    s = body.toString('utf8');
  } else {                // ISO-8859-1
    s = body.toString('latin1');
  }
  return s.replace(/\u0000+$/, '');
}
function swap16(b) { const o = Buffer.from(b); for (let i = 0; i + 1 < o.length; i += 2) { const t = o[i]; o[i] = o[i + 1]; o[i + 1] = t; } return o; }
// TXXX / COMM: campos separados por NUL (descripcion, valor)
function id3TextPair(buf) {
  if (!buf.length) return [null, null];
  const enc = buf[0]; const body = buf.subarray(1);
  if (enc === 1 || enc === 2) {   // UTF-16: separador 00 00
    let i = 0; for (; i + 1 < body.length; i += 2) if (body[i] === 0 && body[i + 1] === 0) break;
    return [id3Text(Buffer.concat([Buffer.from([enc]), body.subarray(0, i)])), id3Text(Buffer.concat([Buffer.from([enc]), body.subarray(i + 2)]))];
  }
  const i = body.indexOf(0);
  if (i < 0) return [id3Text(buf), null];
  return [id3Text(Buffer.concat([Buffer.from([enc]), body.subarray(0, i)])), id3Text(Buffer.concat([Buffer.from([enc]), body.subarray(i + 1)]))];
}

const ID3_TEXT = { TIT2: 'TITLE', TPE1: 'ARTIST', TPE2: 'ALBUMARTIST', TALB: 'ALBUM', TRCK: 'TRACKNUMBER', TPOS: 'DISCNUMBER', TCON: 'GENRE', TSRC: 'ISRC', TDRC: 'DATE', TYER: 'DATE', TDRL: 'DATE', TDAT: '_DATE2', TCMP: 'COMPILATION', TCP: 'COMPILATION', TCOM: 'COMPOSER' };
const TXXX_MAP = { 'MUSICBRAINZ ALBUM ID': 'MUSICBRAINZ_ALBUMID', 'MUSICBRAINZ RELEASE GROUP ID': 'MUSICBRAINZ_RELEASEGROUPID', 'MUSICBRAINZ RELEASE TRACK ID': 'MUSICBRAINZ_TRACKID', 'ACOUSTID ID': 'ACOUSTID_ID', 'ACOUSTID FINGERPRINT': 'ACOUSTID_FINGERPRINT', 'TCMP': 'COMPILATION', 'COMPILATION': 'COMPILATION' };

// Analiza el CUERPO de un ID3v2 (bytes tras la cabecera de 10) → { tags, apic }. Compartido por MP3
// (cabecera al principio del fichero) y AIFF (chunk 'ID3 ').
function id3ParseBody(body, ver, flags) {
  const tags = {}; let apic = null; let p = 0;
  if (flags & 0x40) { const es = ver >= 4 ? synchsafe(body.subarray(p, p + 4)) : body.readUInt32BE(p); p += es; }   // extended header
  const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
  while (p + hdrLen <= body.length) {
    const fid = body.toString('latin1', p, p + idLen);
    if (!/^[A-Z0-9]+$/.test(fid)) break;
    let fsize;
    if (ver === 2) fsize = (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5];
    else if (ver >= 4) fsize = synchsafe(body.subarray(p + 4, p + 8));
    else fsize = body.readUInt32BE(p + 4);
    p += hdrLen;
    if (fsize <= 0 || p + fsize > body.length) break;
    const frame = body.subarray(p, p + fsize);
    try {
      if (fid === 'APIC' || fid === 'PIC') apic = parseApic(frame, fid === 'PIC');
      else if (fid === 'TXXX' || fid === 'TXX') { const [desc, val] = id3TextPair(frame); const k = TXXX_MAP[String(desc || '').toUpperCase()]; if (k && val) tags[k] = val; }
      else if (fid[0] === 'T') { const key = ID3_TEXT[fid]; if (key) { let v = id3Text(frame); if (key === 'GENRE') v = mapGenre(v); if (key === 'TRACKNUMBER' || key === 'DISCNUMBER') v = v.split('/')[0]; if (v) tags[key] = key === '_DATE2' ? v : (tags[key] && key === 'DATE' ? tags[key] : v); } }
      else if (fid === 'UFID' || fid === 'UFI') { const z = frame.indexOf(0); const owner = frame.toString('latin1', 0, z < 0 ? 0 : z); if (/musicbrainz/i.test(owner)) tags.MUSICBRAINZ_TRACKID = frame.subarray(z + 1).toString('latin1').replace(/\u0000+$/, ''); }
    } catch (e) {}
    p += fsize;
  }
  return { tags, apic };
}
// ID3v2 desde un buffer completo (cabecera incluida): para el chunk 'ID3 ' de AIFF.
function id3FromBuffer(buf) {
  if (!buf || buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return { tags: {}, apic: null };
  const ver = buf[3], flags = buf[5], size = synchsafe(buf.subarray(6, 10));
  return id3ParseBody(buf.subarray(10, Math.min(buf.length, 10 + size)), ver, flags);
}
// Lee la cabecera ID3v2 al principio del fichero (MP3) y devuelve { tags, apic, end } (end = inicio del audio).
function readId3v2(fd) {
  const h = Buffer.alloc(10); if (fs.readSync(fd, h, 0, 10, 0) < 10 || h.toString('latin1', 0, 3) !== 'ID3') return { tags: {}, apic: null, end: 0 };
  const ver = h[3], flags = h[5], size = synchsafe(h.subarray(6, 10));
  const body = Buffer.alloc(size); fs.readSync(fd, body, 0, size, 10);
  const r = id3ParseBody(body, ver, flags);
  return { tags: r.tags, apic: r.apic, end: 10 + size };
}
// APIC: enc(1) · mime(latin1, NUL) · type(1) · desc(enc, NUL) · imagen
function parseApic(frame, isV2) {
  let p = 0; const enc = frame[p++]; let mime;
  if (isV2) { mime = ({ JPG: 'image/jpeg', PNG: 'image/png' })[frame.toString('latin1', p, p + 3)] || 'image/jpeg'; p += 3; }
  else { const z = frame.indexOf(0, p); mime = frame.toString('latin1', p, z).toLowerCase(); p = z + 1; }
  p += 1;   // picture type
  // descripción: termina en NUL (o 00 00 en UTF-16)
  if (enc === 1 || enc === 2) { while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2; p += 2; }
  else { while (p < frame.length && frame[p] !== 0) p++; p += 1; }
  const data = frame.subarray(p);
  if (!data.length) return null;
  if (!/^image\//.test(mime)) mime = sniffMime(data) || 'image/jpeg';
  return { mime, ext: mimeExt(mime), data: Buffer.from(data) };
}

// ── info de audio MPEG (MP3) ──
const MPEG_BITRATE = { // [versionBits][layerBits] → tabla de bitrate (kbps) por índice
  // V1 L3, V1 L2, V1 L1, V2 L3, V2 L2/L1
};
const BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BR_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SR_TAB = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };   // MPEG1 / MPEG2 / MPEG2.5
function mp3Audio(fd, id3end, fileSize) {
  const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, id3end); if (n < 4) return null;
  let i = 0;
  for (; i < n - 4; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (buf[i + 1] >> 3) & 3, layerBits = (buf[i + 1] >> 1) & 3;
    if (verBits === 1 || layerBits === 0) continue;   // reservado
    const brIdx = (buf[i + 2] >> 4) & 0xf, srIdx = (buf[i + 2] >> 2) & 3, chMode = (buf[i + 3] >> 6) & 3;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const mpeg1 = verBits === 3;
    const bitrate = (mpeg1 ? BR_V1L3 : BR_V2L3)[brIdx] * 1000;
    const sampleRate = (SR_TAB[verBits] || SR_TAB[3])[srIdx];
    const channels = chMode === 3 ? 1 : 2;
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    // Xing/Info (VBR) → nº de frames; si no, estimación CBR por tamaño/bitrate
    let durationMs = null;
    const xoff = i + 4 + (mpeg1 ? (chMode === 3 ? 17 : 32) : (chMode === 3 ? 9 : 17));
    const tag = n >= xoff + 4 ? buf.toString('latin1', xoff, xoff + 4) : '';
    if ((tag === 'Xing' || tag === 'Info') && n >= xoff + 12) {
      const flags = buf.readUInt32BE(xoff + 4);
      if (flags & 1) { const frames = buf.readUInt32BE(xoff + 8); durationMs = Math.round(frames * samplesPerFrame / sampleRate * 1000); }
    }
    if (durationMs == null && bitrate) durationMs = Math.round((fileSize - id3end) * 8 / bitrate * 1000);
    return { sampleRate, channels, bits: null, durationMs };
  }
  return null;
}
function readMp3(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { tags, end } = readId3v2(fd);
    const size = fs.fstatSync(fd).size;
    const info = mp3Audio(fd, end, size) || { sampleRate: null, channels: null, bits: null, durationMs: null };
    return { info, tags };
  } finally { fs.closeSync(fd); }
}
function mp3Picture(file) {
  const fd = fs.openSync(file, 'r');
  try { return readId3v2(fd).apic || null; } finally { fs.closeSync(fd); }
}

// ── MP4 / M4A (átomos) ──
function readMoov(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd); let off = 0; const hdr = Buffer.alloc(16);
    while (off + 8 <= stat.size) {
      if (fs.readSync(fd, hdr, 0, 16, off) < 8) break;
      let size = hdr.readUInt32BE(0); const type = hdr.toString('latin1', 4, 8); let headerLen = 8;
      if (size === 1) { size = Number(hdr.readBigUInt64BE(8)); headerLen = 16; }
      if (size === 0) size = stat.size - off;
      if (size < headerLen) break;
      if (type === 'moov') { const b = Buffer.alloc(size - headerLen); fs.readSync(fd, b, 0, b.length, off + headerLen); return b; }
      off += size;
    }
    return null;
  } finally { fs.closeSync(fd); }
}
// recorre los hijos de un buffer de átomos; cb(type, payload). `meta` lleva 4 bytes de versión/flags antes de sus hijos.
function eachAtom(buf, cb) {
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8); let hl = 8;
    if (size === 1) { if (p + 16 > buf.length) break; size = Number(buf.readBigUInt64BE(p + 8)); hl = 16; }
    if (size === 0) size = buf.length - p;
    if (size < hl || p + size > buf.length) break;
    cb(type, buf.subarray(p + hl, p + size));
    p += size;
  }
}
function findAtom(buf, path) {   // path: ['trak','mdia',...] baja por contenedores (primero que encuentre)
  let cur = buf;
  for (const want of path) {
    let found = null;
    eachAtom(want === 'meta' ? cur : cur, (t, pay) => { if (!found && t === want) found = pay; });
    if (!found) return null;
    cur = want === 'meta' ? found.subarray(4) : found;   // meta: saltar versión/flags
  }
  return cur;
}
const MP4_TEXT = { '\xa9nam': 'TITLE', '\xa9ART': 'ARTIST', 'aART': 'ALBUMARTIST', '\xa9alb': 'ALBUM', '\xa9day': 'DATE', '\xa9gen': 'GENRE', '\xa9wrt': 'COMPOSER', 'cprt': '_C' };
const MP4_FREE = { 'MUSICBRAINZ ALBUM ID': 'MUSICBRAINZ_ALBUMID', 'MUSICBRAINZ RELEASE GROUP ID': 'MUSICBRAINZ_RELEASEGROUPID', 'MUSICBRAINZ RELEASE TRACK ID': 'MUSICBRAINZ_TRACKID', 'ACOUSTID ID': 'ACOUSTID_ID', 'ACOUSTID FINGERPRINT': 'ACOUSTID_FINGERPRINT', 'ISRC': 'ISRC' };
function ilstDataValue(payload) {   // devuelve {type, buf} del subátomo 'data'
  let out = null; eachAtom(payload, (t, pay) => { if (!out && t === 'data') out = { type: pay.readUInt32BE(0) & 0xffffff, buf: pay.subarray(8) }; }); return out;
}
function readMp4(file) {
  const moov = readMoov(file); if (!moov) return null;
  const tags = {};
  // duración: mvhd (timescale + duration)
  let durationMs = null, sampleRate = null, channels = null, bits = null;
  const mvhd = findAtom(moov, ['mvhd']);
  if (mvhd) { const v = mvhd[0]; const ts = v === 1 ? mvhd.readUInt32BE(20) : mvhd.readUInt32BE(12); const dur = v === 1 ? Number(mvhd.readBigUInt64BE(24)) : mvhd.readUInt32BE(16); if (ts) durationMs = Math.round(dur / ts * 1000); }
  // sample rate (timescale del mdhd del track de audio) + canales/bits (stsd)
  const mdhd = findAtom(moov, ['trak', 'mdia', 'mdhd']);
  if (mdhd) { const v = mdhd[0]; sampleRate = v === 1 ? mdhd.readUInt32BE(20) : mdhd.readUInt32BE(12); }
  const stsd = findAtom(moov, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (stsd && stsd.length >= 8 + 28) { const e = stsd.subarray(8); channels = e.readUInt16BE(16 + 8); bits = e.readUInt16BE(16 + 10); const sr = e.readUInt16BE(16 + 16); if (sr) sampleRate = sampleRate || sr; }
  // etiquetas: moov/udta/meta/ilst
  const ilst = findAtom(moov, ['udta', 'meta', 'ilst']);
  if (ilst) {
    eachAtom(ilst, (type, payload) => {
      try {
        if (type === '----') {   // freeform: mean/name/data
          let name = '', data = null;
          eachAtom(payload, (t, pay) => { if (t === 'name') name = pay.subarray(4).toString('utf8'); else if (t === 'data') data = pay.subarray(8).toString('utf8'); });
          const k = MP4_FREE[String(name || '').toUpperCase()]; if (k && data) tags[k] = data;
          return;
        }
        const dv = ilstDataValue(payload); if (!dv) return;
        if (type === 'trkn') { if (dv.buf.length >= 4) tags.TRACKNUMBER = String(dv.buf.readUInt16BE(2)); return; }
        if (type === 'disk') { if (dv.buf.length >= 4) tags.DISCNUMBER = String(dv.buf.readUInt16BE(2)); return; }
        if (type === 'gnre') { if (dv.buf.length >= 2) { const g = ID3V1_GENRES[dv.buf.readUInt16BE(0) - 1]; if (g) tags.GENRE = g; } return; }
        if (type === 'cpil') { tags.COMPILATION = (dv.buf.length && dv.buf[dv.buf.length - 1]) ? '1' : '0'; return; }   // flag de recopilación (iTunes)
        const key = MP4_TEXT[type]; if (!key || key[0] === '_') return;
        let v = dv.buf.toString('utf8').replace(/\u0000+$/, ''); if (key === 'GENRE') v = mapGenre(v); if (v) tags[key] = v;
      } catch (e) {}
    });
  }
  return { info: { sampleRate, channels, bits, durationMs }, tags };
}
function mp4Picture(file) {
  const moov = readMoov(file); if (!moov) return null;
  const ilst = findAtom(moov, ['udta', 'meta', 'ilst']); if (!ilst) return null;
  let pic = null;
  eachAtom(ilst, (type, payload) => { if (pic || type !== 'covr') return; const dv = ilstDataValue(payload); if (!dv || !dv.buf.length) return; const mime = dv.type === 14 ? 'image/png' : sniffMime(dv.buf) || 'image/jpeg'; pic = { mime, ext: mimeExt(mime), data: Buffer.from(dv.buf) }; });
  return pic;
}

function sniffMime(b) { if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'; if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'; if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'; if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'; return null; }
function mimeExt(m) { return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[m] || 'jpg'; }

// ── Vorbis comments (OGG Vorbis / Opus; mismo formato que el bloque VORBIS_COMMENT de FLAC) ──
const VORBIS_KEYS = new Set(['TITLE', 'ALBUM', 'ARTIST', 'ALBUMARTIST', 'TRACKNUMBER', 'DISCNUMBER', 'DATE', 'GENRE', 'ISRC', 'COMPILATION', 'MUSICBRAINZ_TRACKID', 'MUSICBRAINZ_ALBUMID', 'MUSICBRAINZ_RELEASEGROUPID', 'ACOUSTID_ID', 'ACOUSTID_FINGERPRINT']);
function parseVorbisComments(b, start) {
  const tags = {}; let pic = null; let p = start;
  const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
  try {
    if (p + 4 > b.length) return { tags, pic };
    const vlen = u32(); p += vlen;                      // vendor string
    if (p + 4 > b.length) return { tags, pic };
    const count = u32();
    for (let i = 0; i < count && p + 4 <= b.length; i++) {
      const l = u32(); if (p + l > b.length) break;
      const s = b.toString('utf8', p, p + l); p += l;
      const eq = s.indexOf('='); if (eq <= 0) continue;
      const key = s.slice(0, eq).toUpperCase(), val = s.slice(eq + 1);
      if (key === 'METADATA_BLOCK_PICTURE') { if (!pic) { try { pic = parseFlacPictureBody(Buffer.from(val, 'base64')); } catch (e) {} } }
      else if (key === 'COVERART' && !pic) { try { const d = Buffer.from(val, 'base64'); const m = sniffMime(d) || 'image/jpeg'; pic = { mime: m, ext: mimeExt(m), data: d }; } catch (e) {} }
      else if (VORBIS_KEYS.has(key)) { if (key === 'GENRE') { if (!tags.GENRE) tags.GENRE = mapGenre(val); } else if (key === 'TRACKNUMBER' || key === 'DISCNUMBER') tags[key] = String(val).split('/')[0]; else if (!tags[key]) tags[key] = val; }
    }
  } catch (e) {}
  return { tags, pic };
}
// Cuerpo de un bloque PICTURE de FLAC (lo mismo que hay en METADATA_BLOCK_PICTURE codificado en base64)
function parseFlacPictureBody(b) {
  let p = 0; const u = () => { const v = b.readUInt32BE(p); p += 4; return v; };
  u();                                                  // picture type
  const ml = u(); const mime = b.toString('latin1', p, p + ml).toLowerCase(); p += ml;
  const dl = u(); p += dl;                              // description
  p += 16;                                              // width/height/depth/colors
  const il = u(); if (p + il > b.length) return null;
  const data = b.subarray(p, p + il);
  const m = /^image\//.test(mime) ? mime : (sniffMime(data) || 'image/jpeg');
  return { mime: m, ext: mimeExt(m), data: Buffer.from(data) };
}
// ── OGG (Vorbis/Opus): reensambla los primeros paquetes (un solo bitstream lógico, típico en audio) ──
function oggPackets(buf, maxPackets) {
  const packets = []; let p = 0, cur = null;
  while (p + 27 <= buf.length && packets.length < maxPackets) {
    if (buf.toString('latin1', p, p + 4) !== 'OggS') break;
    const nseg = buf[p + 26], segStart = p + 27, dataStart = segStart + nseg;
    if (dataStart > buf.length) break;
    let off = dataStart;
    for (let i = 0; i < nseg; i++) {
      const len = buf[segStart + i];
      if (off + len > buf.length) return packets;        // paquete fuera del buffer leído: devolvemos lo que hay
      cur = cur ? Buffer.concat([cur, buf.subarray(off, off + len)]) : Buffer.from(buf.subarray(off, off + len));
      off += len;
      if (len < 255) { packets.push(cur); cur = null; if (packets.length >= maxPackets) break; }
    }
    p = off;
  }
  return packets;
}
function oggLastGranule(fd, size) {                       // última granulepos (total de muestras) para la duración
  const n = Math.min(size, 65536); const tail = Buffer.alloc(n); fs.readSync(fd, tail, 0, n, size - n);
  for (let i = tail.length - 27; i >= 0; i--) { if (tail[i] === 0x4f && tail.toString('latin1', i, i + 4) === 'OggS') { try { return Number(tail.readBigUInt64LE(i + 6)); } catch (e) { return 0; } } }
  return 0;
}
function oggScan(file, headBytes, wantPic) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, headBytes)); fs.readSync(fd, head, 0, head.length, 0);
    const pkts = oggPackets(head, 3);
    const info = { sampleRate: null, channels: null, bits: null, durationMs: null }; let tags = {}, pic = null, isOpus = false, preSkip = 0, gotComments = false;
    for (const pk of pkts) {
      if (pk.length >= 12 && pk[0] === 1 && pk.toString('latin1', 1, 7) === 'vorbis') { info.channels = pk[11]; info.sampleRate = pk.readUInt32LE(12); }
      else if (pk.length >= 7 && pk[0] === 3 && pk.toString('latin1', 1, 7) === 'vorbis') { const r = parseVorbisComments(pk, 7); tags = r.tags; pic = r.pic; gotComments = true; }
      else if (pk.length >= 19 && pk.toString('latin1', 0, 8) === 'OpusHead') { isOpus = true; info.channels = pk[9]; preSkip = pk.readUInt16LE(10); info.sampleRate = pk.readUInt32LE(12) || 48000; }
      else if (pk.length >= 8 && pk.toString('latin1', 0, 8) === 'OpusTags') { const r = parseVorbisComments(pk, 8); tags = r.tags; pic = r.pic; gotComments = true; }
    }
    if (!wantPic) { const g = oggLastGranule(fd, size); if (g > 0) { if (isOpus) info.durationMs = Math.round(Math.max(0, g - preSkip) / 48000 * 1000); else if (info.sampleRate) info.durationMs = Math.round(g / info.sampleRate * 1000); } }
    return { info, tags, pic, gotComments };
  } finally { fs.closeSync(fd); }
}
function readOgg(file) { const r = oggScan(file, 1 << 20, false); return { info: r.info, tags: r.tags }; }   // 1MB: cubre comentarios con carátula grande
function oggPicture(file) { return oggScan(file, 1 << 20, true).pic || null; }

// ── AIFF (IFF big-endian): COMM (info) + chunk 'ID3 ' (etiquetas/carátula, convención iTunes) ──
function read80BitFloat(b, off) {                        // sample rate en IEEE-754 80-bit extendido (big-endian)
  const exp = (((b[off] & 0x7f) << 8) | b[off + 1]);
  let mant = 0; for (let i = 0; i < 8; i++) mant = mant * 256 + b[off + 2 + i];
  if (exp === 0 && mant === 0) return 0;
  const v = mant * Math.pow(2, exp - 16383 - 63);
  return (b[off] & 0x80) ? -v : v;
}
function readAiff(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const magic = Buffer.alloc(12); if (fs.readSync(fd, magic, 0, 12, 0) < 12 || magic.toString('latin1', 0, 4) !== 'FORM' || !/^AIF[FC]$/.test(magic.toString('latin1', 8, 12))) return null;
    const info = { sampleRate: null, channels: null, bits: null, durationMs: null }; let tags = {}, apic = null;
    const readAt = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return n === len ? b : b.subarray(0, n); };
    let off = 12;
    while (off + 8 <= size) {
      const chdr = readAt(off, 8); if (chdr.length < 8) break;
      const id = chdr.toString('latin1', 0, 4), sz = chdr.readUInt32BE(4), dataPos = off + 8;
      if (id === 'COMM') { const c = readAt(dataPos, Math.min(sz, 64)); if (c.length >= 18) { info.channels = c.readUInt16BE(0); const frames = c.readUInt32BE(2); info.bits = c.readUInt16BE(6); const sr = read80BitFloat(c, 8); info.sampleRate = Math.round(sr) || null; if (sr > 0) info.durationMs = Math.round(frames / sr * 1000); } }
      else if (id === 'ID3 ' || id === 'id3 ') { const c = readAt(dataPos, Math.min(sz, 1 << 20)); const r = id3FromBuffer(c); tags = r.tags; apic = r.apic; }
      if (sz <= 0) break;
      off = dataPos + sz + (sz & 1);                     // los chunks se alinean a byte par
    }
    return { info, tags, apic };
  } finally { fs.closeSync(fd); }
}
function aiffPicture(file) { try { const r = readAiff(file); return (r && r.apic) || null; } catch (e) { return null; } }

module.exports = { readMp3, readMp4, readOgg, readAiff, mp3Picture, mp4Picture, oggPicture, aiffPicture };
