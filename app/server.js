'use strict';
// escucharrr — servidor mínimo: API JSON desde SQLite + sirve las páginas.
//   node app/server.js    (lee app/escucharrr.db; genérala con las herramientas de data-layer)
// Sin dependencias (node:http + node:sqlite).

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// Motor de audio NATIVO (opcional): salida WASAPI local controlada por el
// servidor — el "core" posee la zona, la UI es un mando (modelo Roon). Si el
// binario no está compilado, las rutas /api/native/* lo avisan sin romper nada.
const NATIVE = (() => { try { return require('../engine/native-player'); } catch (e) { return null; } })();
let _np = null;
function np() {
  if (!NATIVE) return null;
  if (!_np) { _np = new NATIVE.NativePlayer(); _np.on('ended', () => sseBroadcast('native')); _np.on('state', () => sseBroadcast('native')); }
  return _np;
}

const PORT = process.env.PORT || 7733;
const DB_PATH = path.join(__dirname, 'escucharrr.db');
const PUB = path.join(__dirname, 'public');
if (!fs.existsSync(DB_PATH)) { console.error('No existe', DB_PATH, '\nGenera la BD con las herramientas de ../data-layer.'); process.exit(1); }
const db = new DatabaseSync(DB_PATH);
try { db.exec('PRAGMA journal_mode=WAL'); db.exec('PRAGMA busy_timeout=5000'); } catch (e) {}

const genresOf = db.prepare(`SELECT group_concat(g.name,'|') gs FROM release_group_genre rgg JOIN genre g ON g.id=rgg.genre_id WHERE rgg.release_group_id=?`);
const formatOf = db.prepare(`SELECT rel.format f FROM "release" rel WHERE rel.release_group_id=? LIMIT 1`);
const Q = {
  library: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.tier_rank,
      (SELECT label FROM tier WHERE key=a.tier_key) tier_label, a.album_stars, a.is_favorite
     FROM v_album a ORDER BY a.title`),
  album: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.tier_rank,
      (SELECT label FROM tier WHERE key=a.tier_key) tier_label, a.album_stars, a.is_favorite,
      (SELECT acn.artist_id FROM artist_credit_name acn JOIN release_group rg ON rg.artist_credit_id=acn.artist_credit_id
         WHERE rg.id=a.id ORDER BY acn.position LIMIT 1) artist_id
     FROM v_album a WHERE a.id=?`),
  about: db.prepare(`SELECT value v FROM user_edit WHERE subject_type='release_group' AND subject_id=? AND field='about'`),
  prov: db.prepare(`SELECT field,source,source_ref FROM provenance WHERE subject_type='release_group' AND subject_id=?`),
  editions: db.prepare(`SELECT format,date,country FROM "release" WHERE release_group_id=? ORDER BY date`),
  tracks: db.prepare(`SELECT tr.id trackId, m.position disc, tr.position pos, tr.title, tr.length_ms,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=tr.artist_credit_id ORDER BY acn.position LIMIT 1) artist,
      EXISTS(SELECT 1 FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id) playable,
      (SELECT lf.gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) gain_db,
      (SELECT lf.peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) peak_dbfs
     FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
     WHERE rel.release_group_id=? ORDER BY m.position,tr.position`),
  fileByTrack: db.prepare('SELECT path, format, gain_db FROM local_file WHERE track_id=? LIMIT 1'),
  fileByRec: db.prepare('SELECT path, format, gain_db FROM local_file WHERE recording_id=? LIMIT 1'),
  credits: db.prepare(`SELECT role, instrument, group_concat(DISTINCT artist_name) artists FROM v_album_credits WHERE release_group_id=? GROUP BY role, instrument ORDER BY role, instrument`),
  search: db.prepare(`SELECT name, kind, subject_type, subject_id FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT ?`),
  recAlbum: db.prepare(`SELECT rel.release_group_id id FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE tr.recording_id=? LIMIT 1`),
  cArtists: db.prepare('SELECT count(*) n FROM artist'),
  cAlbums: db.prepare('SELECT count(*) n FROM release_group'),
  cTracks: db.prepare('SELECT count(*) n FROM track'),
  cGenres: db.prepare('SELECT count(*) n FROM genre'),
  recent: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.tier_key FROM v_album a JOIN release_group rg ON rg.id=a.id ORDER BY rg.created_at DESC, rg.id DESC LIMIT 10`),
  tiers: db.prepare(`SELECT key, label, (SELECT count(*) FROM rating_tier rt WHERE rt.subject_type='release_group' AND rt.tier_key=tier.key) n FROM tier ORDER BY rank DESC`),
  topGenres: db.prepare(`SELECT g.name, count(*) n FROM release_group_genre rgg JOIN genre g ON g.id=rgg.genre_id GROUP BY g.id ORDER BY n DESC, g.name LIMIT 8`),
  trackInfo: db.prepare('SELECT recording_id, length_ms FROM track WHERE id=?'),
  insPlay: db.prepare('INSERT INTO play(recording_id,track_id,local_file_id,ms_played,source,zone) VALUES(?,?,?,?,?,?)'),
  totalPlays: db.prepare('SELECT COUNT(*) n, COALESCE(SUM(ms_played),0) ms FROM play'),
  daily: db.prepare(`SELECT date(played_at) d, SUM(ms_played) ms, COUNT(*) c FROM play WHERE played_at>=date('now','-27 days') GROUP BY d ORDER BY d`),
  topArtists: db.prepare(`SELECT acn.artist_id aid, acn.name artist, SUM(p.ms_played) ms, COUNT(*) plays FROM play p JOIN recording r ON r.id=p.recording_id JOIN artist_credit_name acn ON acn.artist_credit_id=r.artist_credit_id AND acn.position=1 GROUP BY acn.artist_id ORDER BY ms DESC, plays DESC LIMIT 5`),
  topReleases: db.prepare(`SELECT rg.id, rg.title, (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1) artist, SUM(p.ms_played) ms, COUNT(*) plays FROM play p JOIN track tr ON tr.id=p.track_id JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id JOIN release_group rg ON rg.id=rel.release_group_id GROUP BY rg.id ORDER BY ms DESC LIMIT 5`),
  // ── artista ──
  artist: db.prepare(`SELECT id,name,sort_name,type,country,founded,bio,disambiguation FROM artist WHERE id=?`),
  artistBioProv: db.prepare(`SELECT source,source_ref FROM provenance WHERE subject_type='artist' AND subject_id=? AND field='bio'`),
  artistBioEdit: db.prepare(`SELECT value v FROM user_edit WHERE subject_type='artist' AND subject_id=? AND field='bio'`),
  artistTier: db.prepare(`SELECT tier_key FROM rating_tier WHERE subject_type='artist' AND subject_id=?`),
  artistAlbums: db.prepare(`SELECT DISTINCT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a JOIN release_group rg ON rg.id=a.id
     JOIN artist_credit_name acn ON acn.artist_credit_id=rg.artist_credit_id
     WHERE acn.artist_id=? ORDER BY a.first_release DESC, a.title`),
  artistAppears: db.prepare(`SELECT rg.id, rg.title, substr(rg.first_release,1,4) year,
       (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1) artist,
       group_concat(DISTINCT c.role) roles
     FROM credit c
     JOIN track tr ON tr.recording_id=c.entity_id AND c.entity_type='recording'
     JOIN medium m ON m.id=tr.medium_id
     JOIN "release" rel ON rel.id=m.release_id
     JOIN release_group rg ON rg.id=rel.release_group_id
     WHERE c.artist_id=? GROUP BY rg.id ORDER BY year DESC, rg.title`),
  artistGenres: db.prepare(`SELECT g.name, count(*) n FROM release_group rg
     JOIN artist_credit_name acn ON acn.artist_credit_id=rg.artist_credit_id
     JOIN release_group_genre rgg ON rgg.release_group_id=rg.id
     JOIN genre g ON g.id=rgg.genre_id
     WHERE acn.artist_id=? GROUP BY g.id ORDER BY n DESC, g.name LIMIT 8`),
  // ── género ──
  genreAlbums: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a JOIN release_group_genre rgg ON rgg.release_group_id=a.id
     JOIN genre g ON g.id=rgg.genre_id WHERE g.name=? ORDER BY a.first_release DESC, a.title`),
  genreRelated: db.prepare(`SELECT g2.name, count(*) n FROM release_group_genre x
     JOIN release_group_genre y ON y.release_group_id=x.release_group_id AND y.genre_id!=x.genre_id
     JOIN genre g1 ON g1.id=x.genre_id JOIN genre g2 ON g2.id=y.genre_id
     WHERE g1.name=? GROUP BY g2.id ORDER BY n DESC, g2.name LIMIT 10`),
  allGenres: db.prepare(`SELECT g.name, count(*) n FROM genre g JOIN release_group_genre rgg ON rgg.genre_id=g.id GROUP BY g.id ORDER BY n DESC, g.name`),
  // ── descubrir (recomendaciones sobre el grafo local) ──
  discUnrated: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a WHERE a.tier_key IS NULL ORDER BY a.first_release DESC, a.title LIMIT 18`),
  discUnratedCount: db.prepare(`SELECT count(*) n FROM v_album WHERE tier_key IS NULL`),
  discRevisit: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a
     WHERE a.tier_rank>=4 AND NOT EXISTS(
       SELECT 1 FROM play p JOIN track tr ON (p.track_id=tr.id OR p.recording_id=tr.recording_id)
       JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
       WHERE rel.release_group_id=a.id)
     ORDER BY a.tier_rank DESC, RANDOM() LIMIT 12`),
  discRandom: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a ORDER BY RANDOM() LIMIT 6`),
};
function logPlay(j) {
  let recId = j.recording_id || null, trackId = j.track_id || null, ms = j.ms_played;
  if (trackId) { const t = Q.trackInfo.get(trackId); if (t) { recId = recId || t.recording_id; if (ms == null) ms = t.length_ms; } }
  if (!recId && !trackId) return { ok: false, error: 'falta track_id o recording_id' };
  Q.insPlay.run(recId, trackId, null, ms || 0, j.source || 'ui', j.zone || null);
  return { ok: true };
}
function home() {
  return {
    counts: { artists: Q.cArtists.get().n, albums: Q.cAlbums.get().n, tracks: Q.cTracks.get().n, genres: Q.cGenres.get().n },
    recent: Q.recent.all(),
    tiers: Q.tiers.all(),
    genres: Q.topGenres.all(),
    listening: {
      total: Q.totalPlays.get(),
      daily: Q.daily.all(),
      topArtists: Q.topArtists.all(),
      topReleases: Q.topReleases.all(),
    },
  };
}

// Búsqueda FTS5: prefijo por token (instantánea) + ranking bm25 (completa).
function search(q, n) {
  const toks = String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!toks.length) return [];
  const match = toks.map(t => t.replace(/"/g, '') + '*').join(' ');
  let rows; try { rows = Q.search.all(match, n); } catch (e) { return []; }
  return rows.map(r => ({
    kind: r.kind, name: r.name, subject_type: r.subject_type, subject_id: r.subject_id,
    album_id: r.subject_type === 'release_group' ? r.subject_id
      : (r.subject_type === 'recording' ? ((Q.recAlbum.get(r.subject_id) || {}).id || null) : null),
  }));
}

function album(id) {
  const a = Q.album.get(id); if (!a) return null;
  a.genres = (genresOf.get(id).gs || '').split('|').filter(Boolean);
  a.format = (formatOf.get(id) || {}).f || null;
  const ab = Q.about.get(id);
  a.about = ab ? ab.v : null;
  a.about_source = Q.prov.all(id).find(p => p.field === 'about');
  a.editions = Q.editions.all(id);
  a.tracks = Q.tracks.all(id);
  a.credits = Q.credits.all(id).map(c => ({ role: c.role, instrument: c.instrument, artists: (c.artists || '').split(',') }));
  return a;
}
function libraryList() {
  return Q.library.all().map(a => { a.genres = (genresOf.get(a.id).gs || '').split('|').filter(Boolean); a.format = (formatOf.get(a.id) || {}).f || null; return a; });
}
function artist(id) {
  const a = Q.artist.get(id); if (!a) return null;
  const edit = Q.artistBioEdit.get(id);
  a.bio = edit ? edit.v : a.bio;
  a.bio_source = edit ? { source: 'user' } : (Q.artistBioProv.get(id) || null);
  a.tier_key = (Q.artistTier.get(id) || {}).tier_key || null;
  a.genres = Q.artistGenres.all(id);
  a.albums = Q.artistAlbums.all(id);
  const own = new Set(a.albums.map(x => x.id));
  a.appears = Q.artistAppears.all(id)
    .filter(x => !own.has(x.id))
    .map(x => ({ id: x.id, title: x.title, year: x.year, artist: x.artist, roles: (x.roles || '').split(',').filter(Boolean) }));
  return a;
}
function genre(name) {
  const albums = Q.genreAlbums.all(name);
  if (!albums.length) return null;
  return { name, albums, related: Q.genreRelated.all(name) };
}
function discover() {
  let tg = Q.topGenres.all();
  let sel = tg.filter(g => g.n >= 2);
  if (!sel.length) sel = tg.slice(0, 3);
  const byGenre = sel.slice(0, 4).map(g => ({ name: g.name, n: g.n, albums: Q.genreAlbums.all(g.name).slice(0, 12) }));
  return {
    unrated: Q.discUnrated.all(),
    unratedCount: Q.discUnratedCount.get().n,
    revisit: Q.discRevisit.all(),
    random: Q.discRandom.all(),
    byGenre,
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const AUDIO_MIME = { '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' };

// Streaming del fichero real con soporte de Range (necesario para seek y para que
// Chromium arranque FLAC). Resuelve la pista -> su local_file (por track o por grabación).
function streamAudio(req, res, trackId) {
  if (!trackId) { res.writeHead(400); res.end('falta ?track'); return; }
  let row = Q.fileByTrack.get(trackId);
  if (!row) { const t = Q.trackInfo.get(trackId); if (t && t.recording_id) row = Q.fileByRec.get(t.recording_id); }
  if (!row || !fs.existsSync(row.path)) { res.writeHead(404); res.end('sin fichero local'); return; }
  const stat = fs.statSync(row.path);
  const type = AUDIO_MIME[path.extname(row.path).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const baseHdr = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    res.writeHead(206, { ...baseHdr, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(row.path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...baseHdr, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(row.path).pipe(res);
  }
}
function sendJSON(res, obj) { const b = JSON.stringify(obj); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(b); }
function readBody(req) { return new Promise(resolve => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } }); }); }

// ── motor nativo: salida WASAPI como zona del servidor ──────────────────────
function resolveFileByTrack(trackId) {
  let row = Q.fileByTrack.get(trackId);
  if (!row) { const t = Q.trackInfo.get(trackId); if (t && t.recording_id) row = Q.fileByRec.get(t.recording_id); }
  return row || null;
}
async function handleNative(req, res, u) {
  const sub = u.pathname.slice('/api/native/'.length);
  const P = np();
  if (!P) return sendJSON(res, { ok: false, error: 'motor nativo no disponible en esta build' });
  try {
    if (req.method === 'GET' && sub === 'devices') {
      if (!fs.existsSync(NATIVE.ENGINE)) return sendJSON(res, { ok: false, built: false, error: 'motor sin compilar: ejecuta engine/build.ps1' });
      return sendJSON(res, { ok: true, built: true, items: await P.listDevices() });
    }
    if (req.method === 'GET' && sub === 'state') return sendJSON(res, { ok: true, state: P.state });
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (sub === 'play') {
      const row = resolveFileByTrack(body.track_id);
      if (!row || !fs.existsSync(row.path)) return sendJSON(res, { ok: false, error: 'pista sin fichero local' });
      // Ganancia: el cliente puede mandar la suya (ReplayGain × volumen); si no, el RG de la pista.
      const opts = { gainDb: body.gainDb != null ? body.gainDb : (row.gain_db != null ? row.gain_db : 0) };
      if (body.deviceId !== undefined) opts.deviceId = body.deviceId || null;
      if (body.exclusive !== undefined) opts.exclusive = !!body.exclusive;
      if (body.seekSec) opts.seekSec = body.seekSec;
      const state = await P.play(row.path, opts);
      logPlay({ track_id: body.track_id, source: 'native', zone: body.zone || 'este equipo (nativo)' });
      return sendJSON(res, { ok: true, state });
    }
    if (sub === 'pause') return sendJSON(res, { ok: true, state: P.pause() });
    if (sub === 'resume') return sendJSON(res, { ok: true, state: await P.resume() });
    if (sub === 'stop') return sendJSON(res, { ok: true, state: P.stop() });
    if (sub === 'seek') return sendJSON(res, { ok: true, state: await P.seek(Number(body.sec) || 0) });
    if (sub === 'volume') return sendJSON(res, { ok: true, state: await P.setGainDb(Number(body.db) || 0) });
    if (sub === 'output') { if (body.deviceId !== undefined) P.setDevice(body.deviceId || null); if (body.exclusive !== undefined) P.setExclusive(!!body.exclusive); return sendJSON(res, { ok: true, state: P.state }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}
function sendFile(res, file) {
  const p = path.join(PUB, file);
  if (!p.startsWith(PUB) || !fs.existsSync(p)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}

// ── biblioteca en vivo: watcher de carpetas + eventos SSE a la UI ───────────────
const sseClients = new Set();
function sseBroadcast(type) { const line = `data: ${JSON.stringify({ type, t: Date.now() })}\n\n`; for (const r of sseClients) { try { r.write(line); } catch (e) {} } }
function startWatching() {
  const cfgPath = path.join(__dirname, 'watch.json');
  if (!fs.existsSync(cfgPath)) { console.log('biblioteca en vivo: desactivada (crea app/watch.json a partir de watch.example.json)'); return; }
  let cfg; try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { console.error('watch.json inválido:', e.message); return; }
  const music = cfg.music || [];
  const obsidianConfig = cfg.obsidianConfig ? path.resolve(__dirname, cfg.obsidianConfig) : null;
  let vault = null;
  if (obsidianConfig && fs.existsSync(obsidianConfig)) { try { const oc = JSON.parse(fs.readFileSync(obsidianConfig, 'utf8')); vault = path.resolve(path.dirname(obsidianConfig), oc.vault); } catch (e) {} }
  const DL = path.join(__dirname, '..', 'data-layer');
  const pending = new Set(); let timer = null, running = false;
  const schedule = (kind) => { pending.add(kind); clearTimeout(timer); timer = setTimeout(run, 1500); };   // debounce 1.5 s
  const spawnIngest = (args) => new Promise(r => { const p = cp.spawn(process.execPath, args, { cwd: DL }); let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d); p.on('close', () => r(o.trim().split('\n').pop() || '')); });
  async function run() {
    if (running) { pending.add('rerun'); return; }
    running = true; const kinds = new Set(pending); pending.clear();
    try {
      if (kinds.has('music')) for (const root of music) console.log('  [watch] música:', await spawnIngest([path.join(DL, 'scan.js'), '--db', DB_PATH, '--root', root]));
      if (kinds.has('vault') && obsidianConfig) console.log('  [watch] vault:', await spawnIngest([path.join(DL, 'obsidian-sync.js'), '--db', DB_PATH, '--config', obsidianConfig]));
      sseBroadcast('library');
    } catch (e) { console.error('  [watch] error:', e.message); }
    finally { running = false; if (pending.size) { const r = [...pending][0]; pending.delete('rerun'); schedule(r === 'rerun' ? 'music' : r); } }
  }
  const AUD = /\.(flac|wav|mp3|m4a|ogg|opus|aiff?)$/i;
  for (const root of music) if (fs.existsSync(root)) { try { fs.watch(root, { recursive: true }, (ev, f) => { if (!f || AUD.test(f)) schedule('music'); }); console.log('biblioteca en vivo: vigilando música', root); } catch (e) { console.error('no se pudo vigilar', root, e.message); } }
  if (vault && fs.existsSync(vault)) { try { fs.watch(vault, { recursive: true }, (ev, f) => { if (!f || /\.md$/i.test(f)) schedule('vault'); }); console.log('biblioteca en vivo: vigilando vault', vault); } catch (e) {} }
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('retry: 3000\n\n'); sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api/play') {
    let body = ''; req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { sendJSON(res, logPlay(JSON.parse(body || '{}'))); } catch (e) { res.writeHead(400); res.end(String(e.message)); } });
    return;
  }
  if (u.pathname.startsWith('/api/native/')) return void handleNative(req, res, u);
  try {
    if (u.pathname === '/api/stream') return streamAudio(req, res, parseInt(u.searchParams.get('track'), 10));
    if (u.pathname === '/api/library') return sendJSON(res, libraryList());
    if (u.pathname === '/api/album') { const a = album(parseInt(u.searchParams.get('id'), 10)); return a ? sendJSON(res, a) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/search') return sendJSON(res, search(u.searchParams.get('q'), Math.min(parseInt(u.searchParams.get('n') || '20', 10) || 20, 100)));
    if (u.pathname === '/api/artist') { const a = artist(parseInt(u.searchParams.get('id'), 10)); return a ? sendJSON(res, a) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/genre') { const g = genre(u.searchParams.get('name')); return g ? sendJSON(res, g) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/genres') return sendJSON(res, Q.allGenres.all());
    if (u.pathname === '/api/discover') return sendJSON(res, discover());
    if (u.pathname === '/api/home') return sendJSON(res, home());
    if (u.pathname === '/' || u.pathname === '') return sendFile(res, 'index.html');
    return sendFile(res, u.pathname.replace(/^\//, ''));
  } catch (e) { res.writeHead(500); res.end(String(e.message)); }
}).listen(PORT, () => { console.log('escucharrr en http://localhost:' + PORT); startWatching(); });
