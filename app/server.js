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
// Salida de RED (UPnP/DLNA): el servidor controla un renderer (p. ej. Eversolo) que descarga
// la música de /api/stream. Ver engine/upnp.js y docs/dispositivos-de-red-y-roon.md.
const UPNP = (() => { try { return require('../engine/upnp'); } catch (e) { return null; } })();
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

// Scrobbling local-first (Last.fm + ListenBrainz): cola en SQLite + drenador con reintentos.
const scrobble = require('../data-layer/scrobble');
db.exec(`CREATE TABLE IF NOT EXISTS scrobble_queue (
  id INTEGER PRIMARY KEY, recording_id INTEGER, track_id INTEGER, artist TEXT NOT NULL, title TEXT NOT NULL,
  album TEXT, album_artist TEXT, recording_mbid TEXT, release_mbid TEXT, duration_ms INTEGER,
  listened_at INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')),
  lastfm_done INTEGER DEFAULT 0, lbz_done INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, next_try TEXT, last_error TEXT);
  CREATE INDEX IF NOT EXISTS ix_scrobble_pending ON scrobble_queue(lastfm_done, lbz_done);
  CREATE TABLE IF NOT EXISTS lyrics (recording_id INTEGER PRIMARY KEY, found INTEGER DEFAULT 0, instrumental INTEGER DEFAULT 0, plain TEXT, synced TEXT, source TEXT, fetched_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS tag (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS tag_item (tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE, subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (tag_id, subject_type, subject_id));
  CREATE INDEX IF NOT EXISTS ix_tag_item ON tag_item(subject_type, subject_id);
  CREATE TABLE IF NOT EXISTS bookmark (id INTEGER PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));`);
const lyrics = require('../data-layer/lyrics');
let scrobCfg = null;
function loadScrobbleCfg() { const p = path.join(__dirname, 'scrobble.json'); try { scrobCfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (e) { scrobCfg = null; } return scrobCfg; }
loadScrobbleCfg();

// Spotify (SOLO comparar biblioteca local ↔ álbumes guardados del usuario; no reproduce).
const spotify = require('../data-layer/spotify');
const SPOTIFY_TOKEN_PATH = path.join(__dirname, '.spotify-token');
let spotifyCfg = null, spotifyTok = null, spotifyState = '', spotifyLastSync = null;
function loadSpotify() {
  try { const p = path.join(__dirname, 'spotify.json'); spotifyCfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (e) { spotifyCfg = null; }
  try { spotifyTok = fs.existsSync(SPOTIFY_TOKEN_PATH) ? JSON.parse(fs.readFileSync(SPOTIFY_TOKEN_PATH, 'utf8')) : null; } catch (e) { spotifyTok = null; }
}
loadSpotify();
function saveSpotifyTok(t) { spotifyTok = t; try { fs.writeFileSync(SPOTIFY_TOKEN_PATH, JSON.stringify(t)); } catch (e) {} }
function spotifyConfigured() { return !!(spotifyCfg && spotifyCfg.clientId && spotifyCfg.clientSecret && spotifyCfg.redirectUri); }
async function spotifyAccessToken() {
  if (!spotifyConfigured() || !spotifyTok) return null;
  if (spotify.expired(spotifyTok)) { try { saveSpotifyTok(await spotify.refresh(spotifyCfg, spotifyTok.refresh_token)); } catch (e) { return null; } }
  return spotifyTok.access_token;
}

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
  aboutExt: db.prepare(`SELECT about v FROM release_group WHERE id=?`),   // reseña editorial externa (Wikipedia)
  coverOf: db.prepare(`SELECT cover_path, cover_mime FROM release_group WHERE id=?`),   // carátula cacheada (Cover Art Archive)
  albumIdOf: db.prepare(`SELECT rel.release_group_id aid FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE tr.id=?`),
  spotifyLocal: db.prepare(`SELECT rg.id, rg.title, (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1) artist, (SELECT barcode FROM "release" rel WHERE rel.release_group_id=rg.id AND rel.barcode IS NOT NULL LIMIT 1) barcode FROM release_group rg`),
  spotifySet: db.prepare(`UPDATE release_group SET spotify_album_id=?, spotify_url=? WHERE id=?`),
  spotifyClear: db.prepare(`UPDATE release_group SET spotify_album_id=NULL, spotify_url=NULL`),
  spotifyOf: db.prepare(`SELECT spotify_album_id, spotify_url FROM release_group WHERE id=?`),
  spotifyCount: db.prepare(`SELECT COUNT(*) n FROM release_group WHERE spotify_album_id IS NOT NULL`),
  filesForIndex: db.prepare(`SELECT lf.path, COALESCE(lf.track_id, (SELECT id FROM track WHERE recording_id=lf.recording_id LIMIT 1)) tid FROM local_file lf`),
  trackTags: db.prepare(`SELECT tr.id tid, COALESCE(tr.title, r.title) title, (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=COALESCE(tr.artist_credit_id, r.artist_credit_id) ORDER BY acn.position LIMIT 1) artist FROM track tr JOIN recording r ON r.id=tr.recording_id`),
  // ── tags de usuario (etiquetas libres sobre álbumes, estilo Roon) ──
  tagsOfAlbum: db.prepare(`SELECT t.name FROM tag t JOIN tag_item ti ON ti.tag_id=t.id WHERE ti.subject_type='release_group' AND ti.subject_id=? ORDER BY t.name`),
  allTags: db.prepare(`SELECT t.name, count(*) n FROM tag t JOIN tag_item ti ON ti.tag_id=t.id AND ti.subject_type='release_group' GROUP BY t.id ORDER BY n DESC, t.name`),
  tagAlbums: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite FROM v_album a JOIN tag_item ti ON ti.subject_type='release_group' AND ti.subject_id=a.id JOIN tag t ON t.id=ti.tag_id WHERE t.name=? ORDER BY a.title`),
  tagCreate: db.prepare(`INSERT OR IGNORE INTO tag(name) VALUES(?)`),
  tagLink: db.prepare(`INSERT OR IGNORE INTO tag_item(tag_id, subject_type, subject_id) VALUES((SELECT id FROM tag WHERE name=?), 'release_group', ?)`),
  tagUnlink: db.prepare(`DELETE FROM tag_item WHERE tag_id=(SELECT id FROM tag WHERE name=?) AND subject_type='release_group' AND subject_id=?`),
  tagGc: db.prepare(`DELETE FROM tag WHERE NOT EXISTS (SELECT 1 FROM tag_item ti WHERE ti.tag_id=tag.id)`),
  // ── marcadores: un Focus guardado (estado de facetas) con nombre, estilo Roon ──
  bmList: db.prepare(`SELECT id, name, state FROM bookmark ORDER BY name`),
  bmCreate: db.prepare(`INSERT INTO bookmark(name, state) VALUES(?, ?)`),
  bmDelete: db.prepare(`DELETE FROM bookmark WHERE id=?`),
  prov: db.prepare(`SELECT field,source,source_ref FROM provenance WHERE subject_type='release_group' AND subject_id=?`),
  editions: db.prepare(`SELECT format,date,country FROM "release" WHERE release_group_id=? ORDER BY date`),
  tracks: db.prepare(`SELECT tr.id trackId, tr.recording_id, m.position disc, tr.position pos, tr.title, tr.length_ms,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=tr.artist_credit_id ORDER BY acn.position LIMIT 1) artist,
      EXISTS(SELECT 1 FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id) playable,
      (SELECT lf.gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) gain_db,
      (SELECT lf.peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) peak_dbfs,
      (SELECT lf.album_gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) album_gain_db,
      (SELECT lf.album_peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) album_peak_dbfs,
      (SELECT work_id FROM recording WHERE id=tr.recording_id) work_id,
      (SELECT w.title FROM work w WHERE w.id=(SELECT work_id FROM recording WHERE id=tr.recording_id)) work,
      (SELECT group_concat(DISTINCT a.name) FROM credit c JOIN artist a ON a.id=c.artist_id WHERE c.entity_type='work' AND c.entity_id=(SELECT work_id FROM recording WHERE id=tr.recording_id) AND c.role='composición') composers
     FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
     WHERE rel.release_group_id=? ORDER BY m.position,tr.position`),
  fileByTrack: db.prepare('SELECT path, format, gain_db FROM local_file WHERE track_id=? LIMIT 1'),
  fileByRec: db.prepare('SELECT path, format, gain_db FROM local_file WHERE recording_id=? LIMIT 1'),
  peaksByTrack: db.prepare('SELECT peaks FROM local_file WHERE track_id=? AND peaks IS NOT NULL LIMIT 1'),
  peaksByRec: db.prepare('SELECT peaks FROM local_file WHERE recording_id=? AND peaks IS NOT NULL LIMIT 1'),
  credits: db.prepare(`SELECT role, instrument, group_concat(DISTINCT artist_name) artists FROM v_album_credits WHERE release_group_id=? GROUP BY role, instrument ORDER BY role, instrument`),
  // ── obras y compositores (modelo obra/interpretación, estilo Roon) ──
  workGet: db.prepare('SELECT id, title, type FROM work WHERE id=?'),
  workCredits: db.prepare(`SELECT a.id, a.name, c.role FROM credit c JOIN artist a ON a.id=c.artist_id WHERE c.entity_type='work' AND c.entity_id=? ORDER BY c.position`),
  workPerf: db.prepare(`SELECT DISTINCT rg.id albumId, rg.title album, substr(rg.first_release,1,4) year, tr.id trackId, tr.title tracktitle,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1) artist
     FROM recording rec JOIN track tr ON tr.recording_id=rec.id JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id JOIN release_group rg ON rg.id=rel.release_group_id WHERE rec.work_id=? ORDER BY rg.first_release, rg.title`),
  artistWorks: db.prepare(`SELECT DISTINCT w.id, w.title FROM work w JOIN credit c ON c.entity_type='work' AND c.entity_id=w.id WHERE c.artist_id=? AND c.role='composición' ORDER BY w.title`),
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
  // metadatos para scrobble (por track_id)
  scrobbleMeta: db.prepare(`SELECT tr.recording_id, COALESCE(tr.title, r.title) title, r.mbid recording_mbid,
       COALESCE(tr.length_ms, r.length_ms) duration_ms, rel.mbid release_mbid, rg.title album,
       (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=COALESCE(tr.artist_credit_id, r.artist_credit_id) ORDER BY acn.position LIMIT 1) artist,
       (SELECT acn2.name FROM artist_credit_name acn2 WHERE acn2.artist_credit_id=rg.artist_credit_id ORDER BY acn2.position LIMIT 1) album_artist
     FROM track tr JOIN recording r ON r.id=tr.recording_id JOIN medium m ON m.id=tr.medium_id
     JOIN "release" rel ON rel.id=m.release_id JOIN release_group rg ON rg.id=rel.release_group_id WHERE tr.id=?`),
  // ── listas de reproducción ──
  playlists: db.prepare(`SELECT p.id, p.name, p.created_at, (SELECT count(*) FROM playlist_item pi WHERE pi.playlist_id=p.id) n FROM playlist p ORDER BY p.created_at DESC, p.id DESC`),
  playlist: db.prepare('SELECT id, name, created_at FROM playlist WHERE id=?'),
  plItems: db.prepare(`SELECT pi.position, pi.track_id trackId, COALESCE(tr.recording_id, pi.recording_id) recording_id,
       COALESCE(tr.title, r.title) title, COALESCE(tr.length_ms, r.length_ms) length_ms,
       (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=COALESCE(tr.artist_credit_id, r.artist_credit_id) ORDER BY acn.position LIMIT 1) artist,
       rg.id albumId, rg.title album,
       EXISTS(SELECT 1 FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=COALESCE(tr.recording_id, pi.recording_id)) playable,
       (SELECT lf.gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=COALESCE(tr.recording_id, pi.recording_id) LIMIT 1) gain_db,
       (SELECT lf.peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=COALESCE(tr.recording_id, pi.recording_id) LIMIT 1) peak_dbfs,
       (SELECT lf.album_gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=COALESCE(tr.recording_id, pi.recording_id) LIMIT 1) album_gain_db,
       (SELECT lf.album_peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=COALESCE(tr.recording_id, pi.recording_id) LIMIT 1) album_peak_dbfs
     FROM playlist_item pi LEFT JOIN track tr ON tr.id=pi.track_id
     LEFT JOIN recording r ON r.id=COALESCE(tr.recording_id, pi.recording_id)
     LEFT JOIN medium m ON m.id=tr.medium_id LEFT JOIN "release" rel ON rel.id=m.release_id LEFT JOIN release_group rg ON rg.id=rel.release_group_id
     WHERE pi.playlist_id=? ORDER BY pi.position`),
  plMaxPos: db.prepare('SELECT COALESCE(MAX(position),0) m FROM playlist_item WHERE playlist_id=?'),
  plInsert: db.prepare('INSERT INTO playlist_item(playlist_id,position,track_id,recording_id) VALUES(?,?,?,?)'),
  plCreate: db.prepare('INSERT INTO playlist(name) VALUES(?)'),
  plRename: db.prepare('UPDATE playlist SET name=? WHERE id=?'),
  plDelete: db.prepare('DELETE FROM playlist WHERE id=?'),
  plDeleteItems: db.prepare('DELETE FROM playlist_item WHERE playlist_id=?'),
  plRemoveAt: db.prepare('DELETE FROM playlist_item WHERE playlist_id=? AND position=?'),
  albumTrackIds: db.prepare(`SELECT tr.id FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE rel.release_group_id=? ORDER BY m.position, tr.position`),
  // ── radio (auto-extensión de la cola desde el grafo local) ──
  trackAlbum: db.prepare(`SELECT rel.release_group_id id FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE tr.id=? LIMIT 1`),
  albumGenreIds: db.prepare('SELECT genre_id FROM release_group_genre WHERE release_group_id=?'),
  // ── letras (caché de LRCLIB) ──
  lyricsGet: db.prepare('SELECT * FROM lyrics WHERE recording_id=?'),
  lyricsUpsert: db.prepare(`INSERT INTO lyrics(recording_id,found,instrumental,plain,synced,source,fetched_at) VALUES(?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(recording_id) DO UPDATE SET found=excluded.found,instrumental=excluded.instrumental,plain=excluded.plain,synced=excluded.synced,source=excluded.source,fetched_at=datetime('now')`),
};
function logPlay(j) {
  let recId = j.recording_id || null, trackId = j.track_id || null, ms = j.ms_played;
  if (trackId) { const t = Q.trackInfo.get(trackId); if (t) { recId = recId || t.recording_id; if (ms == null) ms = t.length_ms; } }
  if (!recId && !trackId) return { ok: false, error: 'falta track_id o recording_id' };
  Q.insPlay.run(recId, trackId, null, ms || 0, j.source || 'ui', j.zone || null);
  return { ok: true };
}
// Radio: dado un track semilla, recomienda N pistas reproducibles del grafo local
// (álbumes que comparten género, por tier, con algo de azar), excluyendo lo que ya suena.
function radio(seedTrackId, excludeRecIds, n) {
  n = Math.min(Math.max(parseInt(n, 10) || 5, 1), 20);
  const sa = Q.trackAlbum.get(seedTrackId);
  const genreIds = sa ? Q.albumGenreIds.all(sa.id).map(r => r.genre_id) : [];
  const ex = (excludeRecIds || []).filter(x => Number.isFinite(x));
  const gp = genreIds.length ? genreIds.map(() => '?').join(',') : 'NULL';
  const exClause = ex.length ? ' AND tr.recording_id NOT IN (' + ex.map(() => '?').join(',') + ')' : '';
  const sql = `SELECT tr.id trackId, tr.recording_id, COALESCE(tr.title,r.title) title,
       (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=COALESCE(tr.artist_credit_id,r.artist_credit_id) ORDER BY acn.position LIMIT 1) artist,
       rg.id albumId, COALESCE(tr.length_ms,r.length_ms) length_ms,
       (SELECT lf.gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) gain_db,
       (SELECT lf.peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) peak_dbfs,
       (SELECT lf.album_gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) album_gain_db,
       (SELECT lf.album_peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) album_peak_dbfs,
       (SELECT count(*) FROM release_group_genre g WHERE g.release_group_id=rg.id AND g.genre_id IN (${gp})) shared
     FROM track tr JOIN recording r ON r.id=tr.recording_id JOIN medium m ON m.id=tr.medium_id
     JOIN "release" rel ON rel.id=m.release_id JOIN release_group rg ON rg.id=rel.release_group_id
     WHERE EXISTS(SELECT 1 FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id)${exClause}
     GROUP BY tr.recording_id
     ORDER BY shared DESC, COALESCE((SELECT tier_rank FROM v_album WHERE id=rg.id),0) DESC, RANDOM() LIMIT ?`;
  const rows = db.prepare(sql).all(...genreIds, ...ex, n);
  return rows.map(t => ({ trackId: t.trackId, recording_id: t.recording_id, title: t.title, artist: t.artist, albumId: t.albumId, length_ms: t.length_ms, playable: true, gain_db: t.gain_db, peak_dbfs: t.peak_dbfs, album_gain_db: t.album_gain_db, album_peak_dbfs: t.album_peak_dbfs }));
}
// Letra de una pista: caché local (incl. caché negativa) y, si no, LRCLIB.
async function getLyrics(trackId) {
  const meta = Q.scrobbleMeta.get(trackId);
  if (!meta || !meta.recording_id) return { found: false };
  const rec = meta.recording_id;
  const c = Q.lyricsGet.get(rec);
  const recent = c && c.fetched_at && (Date.now() - Date.parse(c.fetched_at.replace(' ', 'T') + 'Z') < 7 * 864e5);
  if (c && (c.found || recent)) return { found: !!c.found, instrumental: !!c.instrumental, plain: c.plain, synced: c.synced, source: c.source, cached: true };
  const r = await lyrics.fetchLyrics(meta);
  try { Q.lyricsUpsert.run(rec, r.found ? 1 : 0, r.instrumental ? 1 : 0, r.plain, r.synced, 'lrclib'); } catch (e) {}
  return { found: r.found, instrumental: r.instrumental, plain: r.plain, synced: r.synced, source: 'lrclib', cached: false };
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
  // "Acerca de": la nota de Obsidian (user_edit) MANDA; si no hay, cae a la reseña editorial externa.
  const ab = Q.about.get(id);
  if (ab) { a.about = ab.v; a.about_source = Q.prov.all(id).find(p => p.field === 'about') || null; }
  else { const ext = Q.aboutExt.get(id); a.about = (ext && ext.v) || null; a.about_source = a.about ? (Q.prov.all(id).find(p => p.field === 'about_editorial') || null) : null; }
  a.editions = Q.editions.all(id);
  a.tracks = Q.tracks.all(id);
  a.credits = Q.credits.all(id).map(c => ({ role: c.role, instrument: c.instrument, artists: (c.artists || '').split(',') }));
  a.tags = Q.tagsOfAlbum.all(id).map(r => r.name);   // etiquetas de usuario
  const sp = Q.spotifyOf.get(id) || {};   // ¿este disco está en tu biblioteca de Spotify?
  a.spotify_enabled = spotifyConfigured() && !!spotifyTok;
  a.spotify_saved = !!sp.spotify_album_id;
  a.spotify_url = sp.spotify_url || null;
  return a;
}
function libraryList() {
  return Q.library.all().map(a => { a.genres = (genresOf.get(a.id).gs || '').split('|').filter(Boolean); a.format = (formatOf.get(a.id) || {}).f || null; a.tags = Q.tagsOfAlbum.all(a.id).map(r => r.name); return a; });
}
function work(id) {
  const w = Q.workGet.get(id); if (!w) return null;
  w.credits = Q.workCredits.all(id);       // compositores/letristas/arreglistas
  w.performances = Q.workPerf.all(id);     // versiones de la obra en tu biblioteca
  return w;
}
function artist(id) {
  const a = Q.artist.get(id); if (!a) return null;
  a.composed = Q.artistWorks.all(id);      // obras compuestas por este artista
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
function peaksOf(trackId) {
  let row = Q.peaksByTrack.get(trackId);
  if (!row) { const t = Q.trackInfo.get(trackId); if (t && t.recording_id) row = Q.peaksByRec.get(t.recording_id); }
  if (!row || !row.peaks) return null;
  return Array.from(Buffer.from(row.peaks, 'base64'));
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
      if (body.eq) opts.eq = body.eq;
      const state = await P.play(row.path, opts);
      logPlay({ track_id: body.track_id, source: 'native', zone: body.zone || 'este equipo (nativo)' });
      return sendJSON(res, { ok: true, state });
    }
    if (sub === 'pause') return sendJSON(res, { ok: true, state: P.pause() });
    if (sub === 'resume') return sendJSON(res, { ok: true, state: await P.resume() });
    if (sub === 'stop') return sendJSON(res, { ok: true, state: P.stop() });
    if (sub === 'seek') return sendJSON(res, { ok: true, state: await P.seek(Number(body.sec) || 0) });
    if (sub === 'volume') return sendJSON(res, { ok: true, state: await P.setGainDb(Number(body.db) || 0) });
    if (sub === 'eq') return sendJSON(res, { ok: true, state: P.setEq(!!body.on, Array.isArray(body.gains) ? body.gains : []) });
    if (sub === 'output') { if (body.deviceId !== undefined) P.setDevice(body.deviceId || null); if (body.exclusive !== undefined) P.setExclusive(!!body.exclusive); return sendJSON(res, { ok: true, state: P.state }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── salida de red UPnP/DLNA: el servidor controla el renderer (mismo patrón que la zona nativa) ──
let _upnpDevs = { at: 0, items: [] };
let _upnp = { renderer: null, dev: null, trackId: null, nextTrackId: null, nextUrl: '', durationSec: 0, playing: false, paused: false };
async function upnpDevices(force) {
  if (!UPNP) return [];
  if (!force && Date.now() - _upnpDevs.at < 8000 && _upnpDevs.items.length) return _upnpDevs.items;
  let items = []; try { items = await UPNP.discover({ timeoutMs: 3000 }); } catch (e) {}
  if (items.length || force) _upnpDevs = { at: Date.now(), items };
  return items.length ? items : _upnpDevs.items;
}
function upnpMetaOf(trackId) {
  const row = resolveFileByTrack(trackId); if (!row || !fs.existsSync(row.path)) return null;
  const m = Q.scrobbleMeta.get(trackId) || {};
  const a = Q.albumIdOf.get(trackId);
  return { title: m.title || path.basename(row.path), artist: m.artist || '', album: m.album || '', durationSec: Math.round((m.duration_ms || 0) / 1000), mime: AUDIO_MIME[path.extname(row.path).toLowerCase()] || 'application/octet-stream', albumId: a ? a.aid : null };
}
function upnpStreamBase(dev) { return 'http://' + UPNP.lanIp(dev.ip) + ':' + PORT; }
function upnpLight() {   // estado optimista (sin consultar al aparato) para las respuestas de mutación
  const s = _upnp;
  return { kind: 'upnp', playing: !!s.trackId && s.playing && !s.paused, paused: !!s.paused, device: s.dev ? s.dev.name : null, deviceId: s.dev ? s.dev.id : null, trackId: s.trackId, durationSec: s.durationSec, positionSec: 0, advanced: false };
}
// verdad del aparato: posición/estado reales y DETECCIÓN del salto gapless (el aparato pasó solo a la
// pista que cebamos con SetNextAVTransportURI → avanzamos nuestro "actual" y lo registramos).
async function upnpState() {
  const s = _upnp;
  if (!s.renderer || !s.trackId) return { kind: 'upnp', playing: false, paused: false, device: s.dev ? s.dev.name : null, deviceId: s.dev ? s.dev.id : null, trackId: s.trackId, durationSec: s.durationSec, positionSec: 0, advanced: false };
  let st = {}; try { st = await s.renderer.getState(); } catch (e) {}
  let advanced = false;
  if (s.nextUrl && st.trackUri && st.trackUri === s.nextUrl) {
    s.trackId = s.nextTrackId; s.nextTrackId = null; s.nextUrl = ''; advanced = true;
    try { logPlay({ track_id: s.trackId, source: 'upnp', zone: s.dev.name }); } catch (e) {}   // la pista auto-avanzada cuenta en el historial
  }
  s.playing = !!st.playing; s.paused = !!st.paused;
  return { kind: 'upnp', playing: s.playing, paused: s.paused, device: s.dev.name, deviceId: s.dev.id, trackId: s.trackId, durationSec: st.durationSec || s.durationSec, positionSec: st.positionSec || 0, state: st.state, advanced };
}
// ceba (o limpia) la siguiente pista en el aparato para el gapless
async function upnpPrimeNext(trackId) {
  const s = _upnp; if (!s.renderer || !s.dev) return false;
  if (!trackId) { s.nextTrackId = null; s.nextUrl = ''; return true; }
  const meta = upnpMetaOf(trackId); if (!meta) return false;
  const base = upnpStreamBase(s.dev), url = base + '/api/stream?track=' + trackId;
  try { await s.renderer.setNextUri({ url, mime: meta.mime, title: meta.title, artist: meta.artist, album: meta.album, durationSec: meta.durationSec, coverUrl: meta.albumId ? base + '/api/cover?rg=' + meta.albumId : '' }); s.nextTrackId = trackId; s.nextUrl = url; return true; } catch (e) { return false; }
}
async function handleUpnp(req, res, u) {
  const sub = u.pathname.slice('/api/upnp/'.length);
  if (!UPNP) return sendJSON(res, { ok: false, error: 'salida de red no disponible en esta build' });
  try {
    if (req.method === 'GET' && sub === 'devices') {
      const items = await upnpDevices(u.searchParams.get('refresh') === '1');
      return sendJSON(res, { ok: true, items: items.map(d => ({ id: d.id, name: d.name, manufacturer: d.manufacturer, model: d.model, ip: d.ip })) });
    }
    if (req.method === 'GET' && sub === 'state') return sendJSON(res, { ok: true, state: await upnpState() });
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (sub === 'play') {
      const items = await upnpDevices(false);
      const dev = (body.deviceId && items.find(d => d.id === body.deviceId)) || _upnp.dev || items[0];
      if (!dev) return sendJSON(res, { ok: false, error: 'no hay ningún dispositivo de red' });
      const meta = upnpMetaOf(body.track_id);
      if (!meta) return sendJSON(res, { ok: false, error: 'pista sin fichero local' });
      const ip = UPNP.lanIp(dev.ip), base = 'http://' + ip + ':' + PORT, seek = body.seekSec || 0;
      const r = new UPNP.UpnpRenderer(dev);
      await r.setUriAndPlay({ url: base + '/api/stream?track=' + body.track_id, mime: meta.mime, title: meta.title, artist: meta.artist, album: meta.album, durationSec: meta.durationSec, coverUrl: meta.albumId ? base + '/api/cover?rg=' + meta.albumId : '' });
      if (seek) { try { await r.seek(seek); } catch (e) {} }
      _upnp = { renderer: r, dev, trackId: body.track_id, nextTrackId: null, nextUrl: '', durationSec: meta.durationSec, playing: true, paused: false };
      if (body.next_track_id) { try { await upnpPrimeNext(body.next_track_id); } catch (e) {} }   // ceba la siguiente → gapless
      logPlay({ track_id: body.track_id, source: 'upnp', zone: dev.name });
      return sendJSON(res, { ok: true, state: upnpLight() });
    }
    if (sub === 'setnext') { const ok = await upnpPrimeNext(body.track_id || null); return sendJSON(res, { ok }); }
    const R = _upnp.renderer;
    if (sub === 'pause') { if (R) { try { await R.pause(); } catch (e) {} _upnp.paused = true; _upnp.playing = false; } return sendJSON(res, { ok: true, state: upnpLight() }); }
    if (sub === 'resume') { if (R) { try { await R.play(); } catch (e) {} _upnp.paused = false; _upnp.playing = true; } return sendJSON(res, { ok: true, state: upnpLight() }); }
    if (sub === 'stop') { if (R) { try { await R.stop(); } catch (e) {} } _upnp = { renderer: null, dev: _upnp.dev, trackId: null, nextTrackId: null, nextUrl: '', durationSec: 0, playing: false, paused: false }; return sendJSON(res, { ok: true, state: upnpLight() }); }
    if (sub === 'seek') { const sec = Number(body.sec) || 0; if (R) { try { await R.seek(sec); } catch (e) {} } return sendJSON(res, { ok: true, state: upnpLight() }); }
    if (sub === 'volume') { const pct = body.pct != null ? Number(body.pct) : (body.v != null ? Math.round(Number(body.v) * 100) : null); if (R && pct != null) { try { await R.setVolume(pct); } catch (e) {} } return sendJSON(res, { ok: true, state: upnpLight() }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── Spotify: comparar la biblioteca local con tus álbumes guardados (no reproduce) ──
async function spotifySync() {
  const token = await spotifyAccessToken(); if (!token) throw new Error('no autorizado');
  const saved = await spotify.fetchSavedAlbums(token);
  const matches = spotify.matchLocal(Q.spotifyLocal.all(), saved);
  db.exec('BEGIN');
  try { Q.spotifyClear.run(); for (const m of matches) if (m.spotify_album_id) Q.spotifySet.run(m.spotify_album_id, m.spotify_url, m.id); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  const matched = matches.filter(m => m.spotify_album_id).length;
  spotifyLastSync = { at: Date.now(), saved: saved.length, matched };
  return { saved: saved.length, matched };
}
async function handleSpotify(req, res, u) {
  const sub = u.pathname.slice('/api/spotify/'.length);
  try {
    if (sub === 'status') return sendJSON(res, { ok: true, configured: spotifyConfigured(), authorized: !!spotifyTok, matched: Q.spotifyCount.get().n, lastSync: spotifyLastSync });
    if (sub === 'auth') {
      if (!spotifyConfigured()) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Configura app/spotify.json (clientId/clientSecret/redirectUri) a partir de spotify.example.json.'); }
      spotifyState = Math.random().toString(36).slice(2);
      res.writeHead(302, { Location: spotify.authorizeUrl(spotifyCfg, spotifyState) }); return res.end();
    }
    if (sub === 'callback') {
      const code = u.searchParams.get('code'), err = u.searchParams.get('error');
      if (err || !code) { res.writeHead(302, { Location: '/settings.html?spotify=error' }); return res.end(); }
      try { saveSpotifyTok(await spotify.exchangeCode(spotifyCfg, code)); } catch (e) { res.writeHead(302, { Location: '/settings.html?spotify=error' }); return res.end(); }
      spotifySync().catch(() => {});                           // sincroniza en segundo plano tras conectar
      res.writeHead(302, { Location: '/settings.html?spotify=ok' }); return res.end();
    }
    if (sub === 'sync' && req.method === 'POST') { const r = await spotifySync(); return sendJSON(res, { ok: true, ...r }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── scrobbling: now-playing (efímero) + submit (cola) + estado ──────────────
function scrobbleMetaOf(trackId) { const m = Q.scrobbleMeta.get(trackId); if (!m || !m.artist || !m.title) return null; m.track_id = trackId; return m; }
async function handleScrobble(req, res, u) {
  const sub = u.pathname.slice('/api/scrobble/'.length);
  const services = scrobble.enabledServices(scrobCfg || {});
  if (req.method === 'GET' && sub === 'status') return sendJSON(res, { ok: true, enabled: services, pending: scrobble.pendingCount(db, scrobCfg || {}) });
  const body = req.method === 'POST' ? await readBody(req) : {};
  if (!services.length) return sendJSON(res, { ok: true, enabled: [] });   // sin claves: no-op
  const meta = scrobbleMetaOf(body.track_id);
  if (!meta) return sendJSON(res, { ok: false, error: 'pista sin metadatos' });
  if (sub === 'nowplaying') { scrobble.nowPlaying(scrobCfg, meta).catch(() => {}); return sendJSON(res, { ok: true, enabled: services }); }
  if (sub === 'submit') {
    meta.listened_at = parseInt(body.listened_at, 10) || Math.floor(Date.now() / 1000);
    scrobble.enqueue(db, meta);
    scrobble.drain(db, scrobCfg, () => {}).catch(() => {});   // intenta enviar ya; si falla, queda en cola
    return sendJSON(res, { ok: true, enabled: services });
  }
  res.writeHead(404); res.end('{}');
}

// ── listas de reproducción ─────────────────────────────────────────────────
function playlistItems(id) {
  return Q.plItems.all(id).map(t => ({ trackId: t.trackId, title: t.title, artist: t.artist, albumId: t.albumId, album: t.album, length_ms: t.length_ms, playable: t.playable !== 0, gain_db: t.gain_db, peak_dbfs: t.peak_dbfs, album_gain_db: t.album_gain_db, album_peak_dbfs: t.album_peak_dbfs, position: t.position, recording_id: t.recording_id }));
}
function plAdd(id, b) {
  let trackIds = [];
  if (b.album_id) trackIds = Q.albumTrackIds.all(parseInt(b.album_id, 10)).map(r => r.id);
  else if (Array.isArray(b.track_ids)) trackIds = b.track_ids.map(Number).filter(Boolean);
  if (!trackIds.length) return 0;
  let pos = Q.plMaxPos.get(id).m;
  db.exec('BEGIN');
  try { for (const t of trackIds) Q.plInsert.run(id, ++pos, t, null); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return trackIds.length;
}
function plReorder(id, items) {   // reescritura completa: posiciones 1..n en el orden dado
  db.exec('BEGIN');
  try { Q.plDeleteItems.run(id); let pos = 0; for (const it of items) Q.plInsert.run(id, ++pos, it.trackId || it.track_id || null, it.recording_id || null); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
// ── interoperar listas con M3U (.m3u8): exportar con rutas reales, importar mapeando por ruta y por tags ──
function m3uNormPath(p) { try { return path.resolve(String(p)).replace(/[\\/]+/g, '\\').toLowerCase(); } catch (e) { return String(p).replace(/[\\/]+/g, '\\').toLowerCase(); } }
function parseM3U(text) {
  const out = []; let pend = null;
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim(); if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      const m = /^#EXTINF:\s*(-?\d+)\s*,(.*)$/i.exec(line); let secs = 0, artist = '', title = '';
      if (m) { secs = parseInt(m[1], 10) || 0; const t = m[2]; const d = t.indexOf(' - '); if (d >= 0) { artist = t.slice(0, d).trim(); title = t.slice(d + 3).trim(); } else title = t.trim(); }
      pend = { secs, artist, title };
    } else if (line.startsWith('#')) { continue; }
    else { out.push(Object.assign({ path: line }, pend || {})); pend = null; }
  }
  return out;
}
function buildPathIndex() { const m = new Map(); for (const r of Q.filesForIndex.all()) if (r.tid) m.set(m3uNormPath(r.path), r.tid); return m; }
function buildTagIndex() { const m = new Map(); for (const r of Q.trackTags.all()) { const k = spotify.keyOf(r.artist || '', r.title || ''); if (!m.has(k)) m.set(k, r.tid); } return m; }
function playlistToM3U(id, name) {
  let m = '#EXTM3U\n';
  for (const it of playlistItems(id)) { const row = resolveFileByTrack(it.trackId); if (!row || !row.path) continue; const secs = Math.round((it.length_ms || 0) / 1000); m += '#EXTINF:' + secs + ',' + (it.artist || '') + ' - ' + (it.title || '') + '\n' + row.path + '\n'; }
  return m;
}

async function handlePlaylists(req, res, u) {
  try {
    if (u.pathname === '/api/playlist/export') {
      const id = parseInt(u.searchParams.get('id'), 10); const p = Q.playlist.get(id);
      if (!p) { res.writeHead(404); return res.end('no'); }
      const fn = (p.name || 'playlist').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'playlist';
      res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + fn + '.m3u8"' });
      return res.end(playlistToM3U(id, p.name));
    }
    if (u.pathname === '/api/playlists') {
      if (req.method === 'GET') return sendJSON(res, { ok: true, items: Q.playlists.all() });
      const b = await readBody(req); const name = (b.name || '').trim();
      if (!name) return sendJSON(res, { ok: false, error: 'falta nombre' });
      const r = Q.plCreate.run(name); return sendJSON(res, { ok: true, id: Number(r.lastInsertRowid) });
    }
    if (u.pathname === '/api/playlist') {
      const id = parseInt(u.searchParams.get('id'), 10); const p = Q.playlist.get(id);
      if (!p) { res.writeHead(404); return res.end('{}'); }
      return sendJSON(res, { ok: true, playlist: p, items: playlistItems(id) });
    }
    const sub = u.pathname.slice('/api/playlist/'.length);
    const b = await readBody(req);
    if (sub === 'import') {   // crea una lista nueva desde un .m3u(8): mapea por ruta y, si no, por artista|título
      const entries = parseM3U(b.content); const name = (b.name || 'Lista importada').trim() || 'Lista importada';
      const byPath = buildPathIndex(), byTag = buildTagIndex(); const trackIds = []; let matched = 0;
      for (const e of entries) { let tid = e.path ? byPath.get(m3uNormPath(e.path)) : null; if (!tid && (e.artist || e.title)) tid = byTag.get(spotify.keyOf(e.artist || '', e.title || '')) || null; if (tid) { trackIds.push(tid); matched++; } }
      const r = Q.plCreate.run(name); const pid = Number(r.lastInsertRowid);
      if (trackIds.length) plAdd(pid, { track_ids: trackIds });
      return sendJSON(res, { ok: true, id: pid, name, matched, total: entries.length });
    }
    const id = parseInt(b.id, 10);
    if (!id || !Q.playlist.get(id)) return sendJSON(res, { ok: false, error: 'lista no encontrada' });
    if (sub === 'add') return sendJSON(res, { ok: true, added: plAdd(id, b) });
    if (sub === 'remove') { Q.plRemoveAt.run(id, parseInt(b.position, 10)); return sendJSON(res, { ok: true }); }
    if (sub === 'reorder') { plReorder(id, Array.isArray(b.items) ? b.items : []); return sendJSON(res, { ok: true }); }
    if (sub === 'rename') { const name = (b.name || '').trim(); if (name) Q.plRename.run(name, id); return sendJSON(res, { ok: true }); }
    if (sub === 'delete') { Q.plDeleteItems.run(id); Q.plDelete.run(id); return sendJSON(res, { ok: true }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}
function sendFile(res, file) {
  const p = path.join(PUB, file);
  if (!p.startsWith(PUB) || !fs.existsSync(p)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}

// ── carátula: ráster cacheado (Cover Art Archive) o SVG geométrico de respaldo ──
// Un solo endpoint para toda la UI: /api/cover?rg=ID. Si hay portada descargada la
// sirve; si no, devuelve el mismo SVG determinista por id que usaba el cliente.
const COVER_PAIRS = [['#0F6E56', '#1D9E75'], ['#534AB7', '#7F77DD'], ['#185FA5', '#378ADD'], ['#854F0B', '#BA7517'], ['#72243E', '#D4537E'], ['#5F5E5A', '#888780'], ['#3B6D11', '#639922'], ['#993C1D', '#D85A30']];
function coverSvg(id) {
  const p = COVER_PAIRS[((id || 0) % COVER_PAIRS.length + COVER_PAIRS.length) % COVER_PAIRS.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">` +
    `<rect width="300" height="300" fill="${p[0]}"/><rect y="186" width="300" height="114" fill="${p[1]}"/>` +
    `<circle cx="210" cy="108" r="51" fill="#FAC775"/><rect x="45" y="45" width="18" height="126" fill="#FAECE7"/></svg>`;
}
function serveCover(res, id) {
  const row = Number.isFinite(id) ? Q.coverOf.get(id) : null;
  if (row && row.cover_path) {
    const p = path.join(__dirname, row.cover_path);
    if (p.startsWith(__dirname) && fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': row.cover_mime || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(p).pipe(res);
    }
  }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  res.end(coverSvg(id));
}

// ── estado para la página de Configuración (solo lectura; lo editable va por sus propias rutas) ──
function settingsInfo() {
  const n = sql => { try { return db.prepare(sql).get().n; } catch (e) { return 0; } };
  const library = {
    albums: n('SELECT COUNT(*) n FROM release_group'), artists: n('SELECT COUNT(*) n FROM artist'),
    tracks: n('SELECT COUNT(*) n FROM track'), genres: n('SELECT COUNT(*) n FROM genre'),
    files: n('SELECT COUNT(*) n FROM local_file'), covers: n('SELECT COUNT(*) n FROM release_group WHERE cover_path IS NOT NULL'),
  };
  const watch = { active: false, folders: [], obsidian: null };
  try {
    const wp = path.join(__dirname, 'watch.json');
    if (fs.existsSync(wp)) {
      const w = JSON.parse(fs.readFileSync(wp, 'utf8'));
      watch.active = true; watch.folders = Array.isArray(w.music) ? w.music : [];
      if (w.obsidianConfig) {
        const oc = path.resolve(__dirname, w.obsidianConfig);
        if (fs.existsSync(oc)) { const o = JSON.parse(fs.readFileSync(oc, 'utf8')); watch.obsidian = { vault: path.resolve(path.dirname(oc), o.vault), albumsFolder: o.albumsFolder || '' }; }
      }
    }
  } catch (e) {}
  const scr = { enabled: [], pending: 0 };
  try { scr.enabled = scrobble.enabledServices(scrobCfg || {}); scr.pending = scrobble.pendingCount(db, scrobCfg || {}); } catch (e) {}
  const native = { available: !!NATIVE, built: !!(NATIVE && fs.existsSync(NATIVE.ENGINE)) };
  const spot = { configured: spotifyConfigured(), authorized: !!spotifyTok, matched: (() => { try { return Q.spotifyCount.get().n; } catch (e) { return 0; } })() };
  return { app: { version: '0.1', port: PORT, db: DB_PATH }, library, watch, scrobble: scr, native, spotify: spot };
}

// ── biblioteca en vivo: watcher de carpetas + eventos SSE a la UI ───────────────
const sseClients = new Set();
function sseBroadcast(type) { const line = `data: ${JSON.stringify({ type, t: Date.now() })}\n\n`; for (const r of sseClients) { try { r.write(line); } catch (e) {} } }
const _DL = path.join(__dirname, '..', 'data-layer');
const _AUD = /\.(flac|wav|mp3|m4a|ogg|opus|aiff?)$/i;
let _watchers = [];
// lee app/watch.json + resuelve el config de Obsidian (vault/albumsFolder)
function watchConfig() {
  const cfgPath = path.join(__dirname, 'watch.json');
  if (!fs.existsSync(cfgPath)) return null;
  let cfg; try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { return null; }
  const music = Array.isArray(cfg.music) ? cfg.music : [];
  const obsidianConfig = cfg.obsidianConfig ? path.resolve(__dirname, cfg.obsidianConfig) : null;
  let vault = null, obs = null;
  if (obsidianConfig && fs.existsSync(obsidianConfig)) { try { obs = JSON.parse(fs.readFileSync(obsidianConfig, 'utf8')); vault = path.resolve(path.dirname(obsidianConfig), obs.vault); } catch (e) {} }
  return { cfgPath, music, obsidianConfig, vault, obs };
}
function _spawnIngest(args) { return new Promise(r => { const p = cp.spawn(process.execPath, args, { cwd: _DL }); let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d); p.on('close', () => r(o.trim().split('\n').pop() || '')); }); }
let _ingPending = new Set(), _ingTimer = null, _ingRunning = false;
function _ingSchedule(kind) { _ingPending.add(kind); clearTimeout(_ingTimer); _ingTimer = setTimeout(_ingRun, 1500); }   // debounce 1.5 s
async function _ingRun() {
  if (_ingRunning) { _ingPending.add('rerun'); return; }
  const c = watchConfig(); if (!c) { _ingPending.clear(); return; }
  _ingRunning = true; const kinds = new Set(_ingPending); _ingPending.clear();
  try {
    if (kinds.has('music')) for (const root of c.music) console.log('  [watch] música:', await _spawnIngest([path.join(_DL, 'scan.js'), '--db', DB_PATH, '--root', root]));
    if (kinds.has('vault') && c.obsidianConfig) console.log('  [watch] vault:', await _spawnIngest([path.join(_DL, 'obsidian-sync.js'), '--db', DB_PATH, '--config', c.obsidianConfig]));
    sseBroadcast('library');
  } catch (e) { console.error('  [watch] error:', e.message); }
  finally { _ingRunning = false; if (_ingPending.size) { const r = [..._ingPending][0]; _ingPending.delete('rerun'); _ingSchedule(r === 'rerun' ? 'music' : r); } }
}
function stopWatching() { for (const w of _watchers) { try { w.close(); } catch (e) {} } _watchers = []; }
function startWatching() {   // (re)aplica el watcher según la config actual; se puede llamar tras editarla
  stopWatching();
  const c = watchConfig();
  if (!c) { console.log('biblioteca en vivo: desactivada (crea app/watch.json a partir de watch.example.json, o configúrala en Ajustes)'); return; }
  for (const root of c.music) if (fs.existsSync(root)) { try { _watchers.push(fs.watch(root, { recursive: true }, (ev, f) => { if (!f || _AUD.test(f)) _ingSchedule('music'); })); console.log('biblioteca en vivo: vigilando música', root); } catch (e) { console.error('no se pudo vigilar', root, e.message); } }
  if (c.vault && fs.existsSync(c.vault)) { try { _watchers.push(fs.watch(c.vault, { recursive: true }, (ev, f) => { if (!f || /\.md$/i.test(f)) _ingSchedule('vault'); })); console.log('biblioteca en vivo: vigilando vault', c.vault); } catch (e) {} }
}
async function rescanNow(kinds) {   // reescaneo manual inmediato
  const c = watchConfig(); if (!c) throw new Error('No hay carpetas configuradas (crea/edita la configuración de Biblioteca).');
  const out = { music: [], vault: null };
  if (kinds.includes('music')) for (const root of c.music) out.music.push({ root, result: await _spawnIngest([path.join(_DL, 'scan.js'), '--db', DB_PATH, '--root', root]) });
  if (kinds.includes('vault') && c.obsidianConfig) out.vault = await _spawnIngest([path.join(_DL, 'obsidian-sync.js'), '--db', DB_PATH, '--config', c.obsidianConfig]);
  sseBroadcast('library');
  return out;
}
// ── escritura de la config desde la UI (carpetas vigiladas + Obsidian) ──
function writeWatchFolders(folders) {
  const cfgPath = path.join(__dirname, 'watch.json');
  let cfg = {}; try { if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
  const seen = new Set();
  cfg.music = (folders || []).map(f => String(f || '').trim()).filter(f => f && !seen.has(f) && seen.add(f));
  if (!cfg.obsidianConfig) cfg.obsidianConfig = './obsidian.json';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}
function writeObsidian(vault, albumsFolder) {
  const cfgPath = path.join(__dirname, 'watch.json');
  let wcfg = {}; try { if (fs.existsSync(cfgPath)) wcfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
  let base = {};   // preserva fields/tierMap del config actual o del ejemplo
  const curPath = wcfg.obsidianConfig ? path.resolve(__dirname, wcfg.obsidianConfig) : null;
  try { if (curPath && fs.existsSync(curPath)) base = JSON.parse(fs.readFileSync(curPath, 'utf8')); } catch (e) {}
  if (!base.fields) { try { base = JSON.parse(fs.readFileSync(path.join(_DL, 'config.example.json'), 'utf8')); } catch (e) {} }
  base.vault = vault; base.albumsFolder = albumsFolder;
  fs.writeFileSync(path.join(__dirname, 'obsidian.json'), JSON.stringify(base, null, 2));
  if (!wcfg.music) wcfg.music = [];
  wcfg.obsidianConfig = './obsidian.json';
  fs.writeFileSync(cfgPath, JSON.stringify(wcfg, null, 2));
}
function configInfo() {
  const c = watchConfig();
  return { active: !!c, folders: (c && c.music) || [], obsidian: (c && c.obs) ? { vault: c.vault, albumsFolder: c.obs.albumsFolder || '' } : null };
}
async function handleConfig(req, res, u) {
  const sub = u.pathname.slice('/api/config'.length).replace(/^\//, '');
  try {
    if (req.method === 'GET' && sub === '') return sendJSON(res, { ok: true, ...configInfo() });
    const body = await readBody(req);
    if (sub === 'folders') { writeWatchFolders(Array.isArray(body.folders) ? body.folders : []); startWatching(); return sendJSON(res, { ok: true, ...configInfo() }); }
    if (sub === 'obsidian') { writeObsidian(String(body.vault || '').trim(), String(body.albumsFolder || '').trim()); startWatching(); return sendJSON(res, { ok: true, ...configInfo() }); }
    if (sub === 'rescan') { const r = await rescanNow(Array.isArray(body.what) ? body.what : ['music', 'vault']); return sendJSON(res, { ok: true, ...r }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
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
  if (req.method === 'POST' && (u.pathname === '/api/tag/add' || u.pathname === '/api/tag/remove')) {
    let body = ''; req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}'); const id = parseInt(b.album_id, 10); const name = String(b.name || '').trim().toLowerCase().slice(0, 40);
        if (!id || !name) { res.writeHead(400); return res.end('{}'); }
        if (u.pathname.endsWith('/add')) { Q.tagCreate.run(name); Q.tagLink.run(name, id); } else { Q.tagUnlink.run(name, id); Q.tagGc.run(); }
        sendJSON(res, { ok: true, tags: Q.tagsOfAlbum.all(id).map(r => r.name) });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });
    return;
  }
  if (req.method === 'POST' && (u.pathname === '/api/bookmarks' || u.pathname === '/api/bookmark/delete')) {
    let body = ''; req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body || '{}');
        if (u.pathname === '/api/bookmark/delete') { Q.bmDelete.run(parseInt(b.id, 10)); return sendJSON(res, { ok: true }); }
        const name = String(b.name || '').trim().slice(0, 60); if (!name) { res.writeHead(400); return res.end('{}'); }
        const r = Q.bmCreate.run(name, JSON.stringify(b.state || {})); return sendJSON(res, { ok: true, id: Number(r.lastInsertRowid) });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });
    return;
  }
  if (u.pathname.startsWith('/api/native/')) return void handleNative(req, res, u);
  if (u.pathname.startsWith('/api/upnp/')) return void handleUpnp(req, res, u);
  if (u.pathname.startsWith('/api/spotify/')) return void handleSpotify(req, res, u);
  if (u.pathname === '/api/config' || u.pathname.startsWith('/api/config/')) return void handleConfig(req, res, u);
  if (u.pathname.startsWith('/api/scrobble/')) return void handleScrobble(req, res, u);
  if (u.pathname === '/api/lyrics') return void getLyrics(parseInt(u.searchParams.get('track'), 10)).then(r => sendJSON(res, r)).catch(() => sendJSON(res, { found: false }));
  if (u.pathname === '/api/playlists' || u.pathname === '/api/playlist' || u.pathname.startsWith('/api/playlist/')) return void handlePlaylists(req, res, u);
  try {
    if (u.pathname === '/api/stream') return streamAudio(req, res, parseInt(u.searchParams.get('track'), 10));
    if (u.pathname === '/api/cover') return serveCover(res, parseInt(u.searchParams.get('rg'), 10));
    if (u.pathname === '/api/peaks') { const pk = peaksOf(parseInt(u.searchParams.get('track'), 10)); return pk ? sendJSON(res, { peaks: pk }) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/settings') return sendJSON(res, settingsInfo());
    if (u.pathname === '/api/library') return sendJSON(res, libraryList());
    if (u.pathname === '/api/album') { const a = album(parseInt(u.searchParams.get('id'), 10)); return a ? sendJSON(res, a) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/search') return sendJSON(res, search(u.searchParams.get('q'), Math.min(parseInt(u.searchParams.get('n') || '20', 10) || 20, 100)));
    if (u.pathname === '/api/artist') { const a = artist(parseInt(u.searchParams.get('id'), 10)); return a ? sendJSON(res, a) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/work') { const w = work(parseInt(u.searchParams.get('id'), 10)); return w ? sendJSON(res, w) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/genre') { const g = genre(u.searchParams.get('name')); return g ? sendJSON(res, g) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/genres') return sendJSON(res, Q.allGenres.all());
    if (u.pathname === '/api/bookmarks') return sendJSON(res, { items: Q.bmList.all().map(b => ({ id: b.id, name: b.name, state: (() => { try { return JSON.parse(b.state || '{}'); } catch (e) { return {}; } })() })) });
    if (u.pathname === '/api/tags') return sendJSON(res, Q.allTags.all());
    if (u.pathname === '/api/tag') { const name = u.searchParams.get('name'); const albums = Q.tagAlbums.all(name); return albums.length ? sendJSON(res, { name, albums }) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/discover') return sendJSON(res, discover());
    if (u.pathname === '/api/radio') { const seed = parseInt(u.searchParams.get('seed'), 10); const ex = (u.searchParams.get('exclude') || '').split(',').map(x => parseInt(x, 10)).filter(Boolean); return sendJSON(res, { tracks: seed ? radio(seed, ex, u.searchParams.get('n')) : [] }); }
    if (u.pathname === '/api/home') return sendJSON(res, home());
    if (u.pathname === '/' || u.pathname === '') return sendFile(res, 'index.html');
    return sendFile(res, u.pathname.replace(/^\//, ''));
  } catch (e) { res.writeHead(500); res.end(String(e.message)); }
}).listen(PORT, () => {
  console.log('escucharrr en http://localhost:' + PORT);
  startWatching();
  const svc = scrobble.enabledServices(scrobCfg || {});
  if (svc.length) { console.log('scrobbling activo:', svc.join(', ')); setInterval(() => scrobble.drain(db, scrobCfg, console.log).catch(() => {}), 30000); }
  else console.log('scrobbling: desactivado (crea app/scrobble.json a partir de scrobble.example.json)');
});
