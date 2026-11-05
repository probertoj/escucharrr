'use strict';
// escucharrr — servidor mínimo: API JSON desde SQLite + sirve las páginas.
//   node app/server.js    (lee app/escucharrr.db; genérala con las herramientas de data-layer)
// Sin dependencias (node:http + node:sqlite).

const http = require('node:http');
const https = require('node:https');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// Manejadores de proceso: en un .exe sin terminal que lo vigile, un error no capturado MATARÍA la app.
// Los registramos cuanto antes: vuelcan a un log en la carpeta de la app (para diagnosticar sin consola)
// y mantienen el servidor en pie. Es un compromiso consciente para un reproductor que no debe morir solo;
// ver docs/standalone-readiness.md.
const ERR_LOG = path.join(__dirname, 'escucharrr-error.log');
function logFatal(kind, err) {
  const line = '[' + new Date().toISOString() + '] ' + kind + ': ' + ((err && err.stack) || err) + '\n';
  try { fs.appendFileSync(ERR_LOG, line); } catch (e) {}
  try { console.error(line.trim()); } catch (e) {}
}
process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

// Motor de audio NATIVO (opcional): salida WASAPI local controlada por el
// servidor — el "core" posee la zona, la UI es un mando (modelo Roon). Si el
// binario no está compilado, las rutas /api/native/* lo avisan sin romper nada.
const NATIVE = (() => { try { return require('../engine/native-player'); } catch (e) { return null; } })();
// Salida de RED (UPnP/DLNA): el servidor controla un renderer (p. ej. Eversolo) que descarga
// la música de /api/stream. Ver engine/upnp.js y docs/dispositivos-de-red-y-roon.md.
const UPNP = (() => { try { return require('../engine/upnp'); } catch (e) { return null; } })();
const MDNS = (() => { try { return require('../engine/mdns'); } catch (e) { return null; } })();   // descubre Chromecast/AirPlay (solo visibles)
const CAST = (() => { try { return require('../engine/cast'); } catch (e) { return null; } })();   // reproduce en Chromecast (protocolo CASTV2)
let _np = null;
function np() {
  if (!NATIVE) return null;
  if (!_np) { _np = new NATIVE.NativePlayer(); _np.on('ended', () => sseBroadcast('native')); _np.on('state', () => sseBroadcast('native')); }
  return _np;
}

const PORT = process.env.PORT || 7733;
// Ruta de la BD: por defecto junto a la app, pero ESC_DB permite moverla a una carpeta escribible
// (p. ej. %LOCALAPPDATA% en un standalone instalado en Archivos de programa). También facilita el QA.
const DB_PATH = process.env.ESC_DB ? path.resolve(process.env.ESC_DB) : path.join(__dirname, 'escucharrr.db');
const PUB = path.join(__dirname, 'public');

// ffmpeg (opcional): sólo hace falta para transcodificar lo que el navegador no decodifica (DSD) y para el
// motor nativo. Un standalone NO puede asumirlo en el PATH. Lo localizamos UNA vez al arrancar:
//   1) ESC_FFMPEG (ruta explícita);  2) un ffmpeg(.exe) empaquetado en ./bin o ../bin;  3) el PATH del sistema.
// Si no está, la app sigue viva: servimos el audio crudo (el navegador decodifica casi todo) y Ajustes lo avisa.
function resolveFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cand = [];
  if (process.env.ESC_FFMPEG) cand.push(process.env.ESC_FFMPEG);
  cand.push(path.join(__dirname, 'bin', exe), path.join(__dirname, '..', 'bin', exe));
  for (const c of cand) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  // En el PATH: probamos a ejecutarlo (barato y definitivo). Si responde, usamos el nombre pelado.
  try { const r = cp.spawnSync('ffmpeg', ['-version'], { windowsHide: true, timeout: 4000 }); if (r && r.status === 0) return 'ffmpeg'; } catch (e) {}
  return null;
}
const FFMPEG = resolveFfmpeg();

// Abrir el navegador por defecto al arrancar (UX de doble-clic en el .exe/lanzador). Opt-IN con
// ESC_OPEN_BROWSER=1 (lo pone el lanzador) para que un `node app/server.js` de desarrollo NO lo abra
// en cada reinicio. ESC_NO_BROWSER lo fuerza a no abrir aunque el lanzador lo pida.
function maybeOpenBrowser() {
  if (process.env.ESC_OPEN_BROWSER !== '1') return;
  if (process.env.ESC_NO_BROWSER === '1') return;
  const url = 'http://localhost:' + PORT + '/';
  try {
    if (process.platform === 'win32') cp.spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
}

// Primer arranque sin biblioteca: NO abortamos (un .exe de doble-clic no debe cerrarse con un error). Creamos
// la BD vacía con el esquema canónico y arrancamos hacia el onboarding ("añade tu carpeta de música"). Ver
// docs/standalone-readiness.md. freshDb marca este caso para aplicar schema.sql antes de las vistas.
const freshDb = !fs.existsSync(DB_PATH);
if (freshDb) console.log('primer arranque: aún no hay biblioteca; creando BD vacía en', DB_PATH);
// Scrobbling local-first (Last.fm + ListenBrainz): cola en SQLite + drenador con reintentos.
const scrobble = require('../data-layer/scrobble');
const TAGS = require('../data-layer/tags');   // carátula embebida en MP3 (APIC) y M4A (covr)
// Wizard de IDENTIFICACIÓN de álbum (modelo Roon: empareja por nº de pistas + perfil de duraciones
// contra MusicBrainz). Ver data-layer/identify-album.js y docs/roon-parity-gaps.md.
const identifyAlbum = require('../data-layer/identify-album');
// Esquema de las tablas propias de la app (idempotente). Extraído a función para poder re-aplicarlo
// al REABRIR la BD tras una restauración de copia de seguridad.
function initAppSchema(d) {
  try { d.exec('PRAGMA journal_mode=WAL'); d.exec('PRAGMA busy_timeout=5000'); } catch (e) {}
  d.exec(`CREATE TABLE IF NOT EXISTS scrobble_queue (
  id INTEGER PRIMARY KEY, recording_id INTEGER, track_id INTEGER, artist TEXT NOT NULL, title TEXT NOT NULL,
  album TEXT, album_artist TEXT, recording_mbid TEXT, release_mbid TEXT, duration_ms INTEGER,
  listened_at INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')),
  lastfm_done INTEGER DEFAULT 0, lbz_done INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, next_try TEXT, last_error TEXT);
  CREATE INDEX IF NOT EXISTS ix_scrobble_pending ON scrobble_queue(lastfm_done, lbz_done);
  CREATE TABLE IF NOT EXISTS lyrics (recording_id INTEGER PRIMARY KEY, found INTEGER DEFAULT 0, instrumental INTEGER DEFAULT 0, plain TEXT, synced TEXT, source TEXT, fetched_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS tag (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS tag_item (tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE, subject_type TEXT NOT NULL, subject_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (tag_id, subject_type, subject_id));
  CREATE INDEX IF NOT EXISTS ix_tag_item ON tag_item(subject_type, subject_id);
  CREATE TABLE IF NOT EXISTS bookmark (id INTEGER PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS dsp_preset (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, state TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS radio_station (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, homepage TEXT, favicon TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS skipped_file (path TEXT, reason TEXT, at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS smart_playlist (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, rules TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS genre_map (raw TEXT PRIMARY KEY, canonical TEXT, hidden INTEGER DEFAULT 0);`);
  // Índices sobre las claves foráneas del grafo: sin ellos, recorrer release_group -> release -> medium -> track -> local_file
  // hace scans anidados por álbum (inviable con decenas de miles de discos). Cada uno en su try por si el grafo aún no existe.
  for (const ix of [
    `CREATE INDEX IF NOT EXISTS ix_release_rg ON "release"(release_group_id)`,
    `CREATE INDEX IF NOT EXISTS ix_medium_release ON medium(release_id)`,
    `CREATE INDEX IF NOT EXISTS ix_track_medium ON track(medium_id)`,
    `CREATE INDEX IF NOT EXISTS ix_track_recording ON track(recording_id)`,
    `CREATE INDEX IF NOT EXISTS ix_recording_title ON recording(title)`,   // explorador de pistas: orden/paginación por título
    `CREATE INDEX IF NOT EXISTS ix_rgg_rg ON release_group_genre(release_group_id)`,
    `CREATE INDEX IF NOT EXISTS ix_flag_subject ON flag(subject_type, subject_id)`,
    `CREATE INDEX IF NOT EXISTS ix_rating_subject ON rating(subject_type, subject_id)`,
  ]) { try { d.exec(ix); } catch (e) {} }
  // Modelo de versiones (estilo Roon): quita el UNIQUE de release_group.mbid si sigue puesto (una sola vez).
  // El servidor no pasa por migrate.js, así que lo aplicamos aquí también. Recrea las vistas por dentro.
  // require perezoso: initAppSchema se llama antes de los require de módulo de más abajo.
  // migrate() es idempotente y añade columnas que faltan (incl. release.source_dir del modelo de versiones)
  // y llama internamente a dropMbidUnique. Así el servidor tiene el esquema al día aunque aún no se haya escaneado.
  try { require('../data-layer/migrate').migrate(d); } catch (e) { console.error('  [migrate]:', e.message); }
  // v_album.title prioriza el título editado por el usuario (user_edit field='title') sobre rg.title, y expone
  // orig_title. El escaneo corre migrate.js, pero el servidor puede arrancar solo: recrea aquí la vista si está
  // en la forma antigua (CREATE VIEW IF NOT EXISTS no la actualizaría). rg.title queda intacto → ensureRg no duplica.
  try {
    const def = d.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_album'").get();
    if (def && !/orig_title/.test(def.sql || '')) {
      d.exec('DROP VIEW v_album');
      d.exec(`CREATE VIEW v_album AS
SELECT rg.id,
       COALESCE((SELECT ue.value FROM user_edit ue
                   WHERE ue.subject_type='release_group' AND ue.subject_id=rg.id AND ue.field='title'),
                rg.title) AS title,
       rg.title AS orig_title,
       rg.primary_type, rg.first_release,
       substr(rg.first_release,1,4) AS year,
       (SELECT group_concat(acn.name || acn.join_phrase,'')
          FROM artist_credit_name acn WHERE acn.artist_credit_id = rg.artist_credit_id
          ORDER BY acn.position) AS artist,
       rt.tier_key, t.rank AS tier_rank,
       (SELECT AVG(stars) FROM rating r WHERE r.subject_type='release_group' AND r.subject_id=rg.id) AS album_stars,
       EXISTS(SELECT 1 FROM flag f WHERE f.subject_type='release_group' AND f.subject_id=rg.id AND f.flag='favorite') AS is_favorite
FROM release_group rg
LEFT JOIN rating_tier rt ON rt.subject_type='release_group' AND rt.subject_id=rg.id
LEFT JOIN tier t ON t.key = rt.tier_key`);
    }
  } catch (e) {}
}
let db = new DatabaseSync(DB_PATH);
// BD recién creada: aplica el esquema canónico (schema.sql, todo CREATE TABLE IF NOT EXISTS) ANTES de
// initAppSchema, que crea vistas (v_album) sobre release_group. Idempotente: no toca una BD ya poblada.
if (freshDb) { try { db.exec(fs.readFileSync(path.join(__dirname, '..', 'data-layer', 'schema.sql'), 'utf8')); } catch (e) { console.error('  [schema inicial]:', e.message); } }
initAppSchema(db);
const lyrics = require('../data-layer/lyrics');
let scrobCfg = null;
const SCROBBLE_PATH = path.join(__dirname, 'scrobble.json');
function loadScrobbleCfg() { try { scrobCfg = fs.existsSync(SCROBBLE_PATH) ? JSON.parse(fs.readFileSync(SCROBBLE_PATH, 'utf8')) : null; } catch (e) { scrobCfg = null; } return scrobCfg; }
loadScrobbleCfg();
// Guarda scrobble.json fusionando (conserva lo no tocado, p. ej. la sessionKey de Last.fm).
function saveScrobbleCfg(patch) {
  const cfg = scrobCfg || { listenbrainz: {}, lastfm: {} };
  if (patch.listenbrainz) cfg.listenbrainz = Object.assign({}, cfg.listenbrainz, patch.listenbrainz);
  if (patch.lastfm) cfg.lastfm = Object.assign({}, cfg.lastfm, patch.lastfm);
  fs.writeFileSync(SCROBBLE_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  scrobCfg = cfg; return cfg;
}
// Llamada firmada a la API de auth de Last.fm (auth.getToken / auth.getSession).
async function lfmAuthCall(method, extra) {
  const lf = (scrobCfg && scrobCfg.lastfm) || {};
  if (!lf.apiKey || !lf.apiSecret) throw new Error('Faltan la API key y el secret de Last.fm');
  const params = Object.assign({ method, api_key: lf.apiKey }, extra || {});
  params.api_sig = scrobble.lastfmSig(params, lf.apiSecret);
  params.format = 'json';
  const r = await scrobble.post('https://ws.audioscrobbler.com/2.0/', { form: true, body: params });
  let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
  if (r.status !== 200 || j.error) throw new Error('Last.fm ' + (j.error || r.status) + ': ' + (j.message || '').slice(0, 160));
  return j;
}

const coverfetch = require('../data-layer/coverfetch');   // descarga perezosa de portadas (Cover Art Archive)
const acoustidLib = require('../data-layer/acoustid');     // identificación automática por huella (AcoustID)
// Config de AcoustID (clave gratuita de acoustid.org + ruta opcional de fpcalc/Chromaprint). Fichero en app/.
const ACOUSTID_PATH = path.join(__dirname, 'acoustid.json');
let acoustidCfg = null;
function loadAcoustid() { try { acoustidCfg = fs.existsSync(ACOUSTID_PATH) ? JSON.parse(fs.readFileSync(ACOUSTID_PATH, 'utf8')) : null; } catch (e) { acoustidCfg = null; } return acoustidCfg; }
loadAcoustid();
function acoustidKey() { return (acoustidCfg && acoustidCfg.key) || ''; }
function acoustidFpcalc() { return (acoustidCfg && acoustidCfg.fpcalcPath) || ''; }
function saveAcoustid(key, fpcalcPath) {
  const k = String(key || '').trim(), fp = String(fpcalcPath || '').trim();
  if (k || fp) fs.writeFileSync(ACOUSTID_PATH, JSON.stringify({ key: k, fpcalcPath: fp }, null, 2) + '\n', 'utf8');
  else { try { if (fs.existsSync(ACOUSTID_PATH)) fs.unlinkSync(ACOUSTID_PATH); } catch (e) {} }
  loadAcoustid();
}
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

// ── Puente a Liderarrr (completismo/adquisición): la URL se configura por UI, nunca hardcodeada ──
const LIDERARRR_PATH = path.join(__dirname, 'liderarrr.json');
let liderarrrCfg = null;
function loadLiderarrr() { try { liderarrrCfg = fs.existsSync(LIDERARRR_PATH) ? JSON.parse(fs.readFileSync(LIDERARRR_PATH, 'utf8')) : null; } catch (e) { liderarrrCfg = null; } return liderarrrCfg; }
loadLiderarrr();
function liderarrrUrl() { const u = liderarrrCfg && liderarrrCfg.url; return u ? String(u).replace(/\/+$/, '') : ''; }
// Liderarrr usa Basic Auth OPCIONAL (env LIDERARRR_AUTH="usuario:contraseña", o solo contraseña → usuario
// "liderarrr"). Si el usuario guarda una contraseña, mandamos Authorization: Basic base64(usuario:contraseña).
function liderarrrAuth() {
  const pass = liderarrrCfg && liderarrrCfg.pass;
  if (!pass) return null;
  const user = (liderarrrCfg && liderarrrCfg.user) || 'liderarrr';
  return 'Basic ' + Buffer.from(user + ':' + pass, 'utf8').toString('base64');
}
function saveLiderarrr(url, user, pass) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean) {
    const prev = liderarrrCfg || {};
    const cfg = { url: clean };
    // Si no se escribe contraseña nueva, se conserva la guardada (p. ej. al solo actualizar la URL).
    const finalPass = (pass != null && String(pass) !== '') ? String(pass) : prev.pass;
    if (finalPass) { cfg.user = ((user != null && String(user).trim() !== '') ? String(user).trim() : prev.user) || 'liderarrr'; cfg.pass = finalPass; }
    fs.writeFileSync(LIDERARRR_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } else { try { if (fs.existsSync(LIDERARRR_PATH)) fs.unlinkSync(LIDERARRR_PATH); } catch (e) {} }
  loadLiderarrr(); return liderarrrUrl();
}
// Reenvía una petición a la API de Liderarrr (misma BD → cambios bidireccionales).
function liderarrrFetch(method, apipath, body) {
  return new Promise((resolve, reject) => {
    const base = liderarrrUrl(); if (!base) return reject(new Error('Liderarrr no configurado'));
    let u; try { u = new URL(base + apipath); } catch (e) { return reject(new Error('URL de Liderarrr inválida')); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body != null ? JSON.stringify(body) : null;
    const auth = liderarrrAuth();
    const req = lib.request(u, { method, headers: Object.assign({ Accept: 'application/json' }, auth ? { Authorization: auth } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { let j = b; try { j = b ? JSON.parse(b) : null; } catch (e) {} resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}
// matchKey de Liderarrr replicado (sin dependencias) para cruzar su wanted/retos con la biblioteca local.
function lidNormName(s) { return String(s || '').normalize('NFD').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
const LID_EDITION_RE = /(deluxe|expanded|remaster|anniversary|edition|reissue|re-?master|mono|stereo|bonus|special|version|explicit|flac|mp3|vinyl|\d{2,3}\s*bit|\d{2,3}(\.\d)?\s*khz|hi-?res|24-?96|16-?44)/i;
function lidCleanTitle(t) { t = String(t || '').trim(); for (;;) { const m = t.match(/[\[(]([^\])]*)[)\]]\s*$/); if (!m || (!/\d{4}/.test(m[1]) && !LID_EDITION_RE.test(m[1]))) break; t = t.slice(0, m.index).trim(); } t = t.replace(/\s+[-–—]\s*\d{4}\s*$/, '').trim(); return lidNormName(t); }
function lidMatchKey(artist, title) { return lidNormName(artist) + '::' + lidCleanTitle(title); }
// índice biblioteca: matchKey → release_group id (cacheado) para saber qué posees/puedes reproducir
let _lidOwned = { at: 0, map: null };
function lidOwnedIndex() { if (_lidOwned.map && Date.now() - _lidOwned.at < 15000) return _lidOwned.map; const map = new Map(); for (const a of db.prepare('SELECT id, artist, title FROM v_album').all()) map.set(lidMatchKey(a.artist, a.title), a.id); _lidOwned = { at: Date.now(), map }; return map; }
function resolveOwnedPairs(pairs) { const idx = lidOwnedIndex(); return (pairs || []).map(p => ({ artist: p.artist, album: p.album, rg_id: idx.get(lidMatchKey(p.artist, p.album)) ?? null })); }

// ── Diagnóstico del puente Liderarrr: sondea su API (solo lectura) y devuelve un JSON copiable ──
// Pensado para que un betatester (p. ej. Serge, en Docker) nos pase qué responde SU instancia cuando el
// import sale a cero: forma de /api/library, si los álbumes traen MBID, estado de /api/artists, etc.
async function liderarrrDiag() {
  const out = { url: liderarrrUrl(), when: new Date().toISOString(), local_albums: 0, local_identified: 0, probes: {} };
  try { out.local_albums = db.prepare('SELECT COUNT(*) n FROM release_group').get().n; } catch (e) {}
  try { out.local_identified = db.prepare('SELECT COUNT(*) n FROM release_group WHERE mbid IS NOT NULL').get().n; } catch (e) {}
  const probe = async (label, apipath) => {
    try {
      const r = await liderarrrFetch('GET', apipath);
      const b = r.body;
      const arr = (b && (b.albums || b.items || b.data || b.results)) || (Array.isArray(b) ? b : null);
      const info = { http: r.status, body_type: Array.isArray(b) ? 'array' : typeof b,
        keys: (b && typeof b === 'object' && !Array.isArray(b)) ? Object.keys(b).slice(0, 16) : null };
      if (Array.isArray(arr)) {
        info.count = arr.length;
        info.total = (b && b.total != null) ? b.total : null;
        if (arr[0]) { info.first_item_keys = Object.keys(arr[0]).slice(0, 24); info.first_item = arr[0]; }
      }
      out.probes[label] = info;
    } catch (e) { out.probes[label] = { error: String(e.message) }; }
  };
  await probe('library', '/api/library?limit=3&offset=0');
  await probe('artists', '/api/artists?limit=3');
  await probe('challenges', '/api/challenges');
  // ¿qué campo lleva el MBID de release-group en SU biblioteca? (clave para que el import empareje)
  try {
    const lib = out.probes.library, it = lib && lib.first_item;
    if (it) {
      const CANDS = ['rg_mbid', 'release_group_mbid', 'rgMbid', 'mbid', 'musicbrainz_id', 'mb_release_group'];
      lib.mbid_field = CANDS.find(k => it[k]) || null;
      lib.first_item_has_mbid = !!lib.mbid_field;
    }
  } catch (e) {}
  return out;
}

// ── Importar la identificación de MusicBrainz ya hecha en Liderarrr (para no re-identificar aquí) ──
// Liderarrr ya empareja su biblioteca contra MusicBrainz y expone rg_mbid por álbum (/api/library) y mbid
// por artista (/api/artists). Adoptamos esos MBID en los álbumes/artistas locales que aún NO los tienen:
// "tus datos mandan" (nunca pisamos un MBID tuyo) y respetamos el UNIQUE (si otro registro ya usa ese MBID,
// no lo duplicamos). Procedencia source='liderarrr' para el distintivo "identificado vía Liderarrr" en la app.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function syncLiderarrrIdentify() {
  if (!liderarrrUrl()) throw new Error('Liderarrr no está configurado');
  const rep = { albums_scanned: 0, albums_with_mbid: 0, albums_adopted: 0, albums_already: 0, albums_no_local: 0, albums_conflict: 0,
                artists_scanned: 0, artists_adopted: 0, artists_already: 0, artists_no_local: 0, artists_conflict: 0, total: 0, diag: null };
  const idx = lidOwnedIndex();   // matchKey(artista,título) → rg_id local (cacheado)
  const getRgMbid = db.prepare('SELECT mbid FROM release_group WHERE id=?');
  const setRgMbid = db.prepare("UPDATE release_group SET mbid=?, updated_at=datetime('now') WHERE id=?");
  const provUp = db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at)
      VALUES(?,?,'mbid','liderarrr',?,datetime('now'))
      ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source='liderarrr', source_ref=excluded.source_ref, fetched_at=datetime('now')`);
  // Tolerante a variantes de Liderarrr: la lista puede venir como {albums|items|data} o como array suelto;
  // el MBID como rg_mbid|release_group_mbid|mbid|musicbrainz_id; artista/título con nombres alternativos.
  const albumsOf = (b) => (b && (b.albums || b.items || b.data || b.results)) || (Array.isArray(b) ? b : null);
  const mbidOf = (a) => String(a.rg_mbid || a.release_group_mbid || a.rgMbid || a.mbid || a.musicbrainz_id || a.mb_release_group || '').trim().toLowerCase();
  const artistOf = (a) => a.album_artist || a.albumartist || a.artist || a.artist_name || '';
  const titleOf = (a) => a.title || a.album || a.name || '';
  // 1) Álbumes — pagina /api/library y adopta rg_mbid donde el álbum local no tenga MBID.
  const LIMIT = 500; let offset = 0, total = Infinity, guard = 0, pages = 0;
  while (offset < total && guard++ < 400) {
    const r = await liderarrrFetch('GET', '/api/library?limit=' + LIMIT + '&offset=' + offset);
    const albums = r ? albumsOf(r.body) : null;
    if (!Array.isArray(albums)) {   // forma inesperada o error: deja constancia para diagnosticar
      if (offset === 0) { rep.diag = { stage: 'library', http: r && r.status, body_type: typeof (r && r.body), body_keys: (r && r.body && typeof r.body === 'object') ? Object.keys(r.body).slice(0, 12) : null };
        console.log('[liderarrr-sync] /api/library sin lista de álbumes:', JSON.stringify(rep.diag)); }
      break;
    }
    if (offset === 0) console.log('[liderarrr-sync] /api/library http', r.status, '| álbumes pág.1', albums.length, '| total', (r.body && r.body.total), '| 1er álbum campos:', albums[0] ? Object.keys(albums[0]).join(',') : '—');
    pages++;
    total = (r.body && r.body.total != null) ? r.body.total : (offset + albums.length);
    rep.total = total;
    if (offset === 0 && albums[0]) rep.diag = { stage: 'library', sample_keys: Object.keys(albums[0]).slice(0, 16) };   // forma real del primer álbum
    for (const al of albums) {
      rep.albums_scanned++;
      const mb = mbidOf(al);
      if (!UUID_RE.test(mb)) continue;
      rep.albums_with_mbid++;
      const rgId = idx.get(lidMatchKey(artistOf(al), titleOf(al)));
      if (!rgId) { rep.albums_no_local++; continue; }
      const cur = getRgMbid.get(rgId);
      if (cur && cur.mbid) { rep.albums_already++; continue; }          // ya identificado (tuyo o previo) → no tocar
      // Modelo de versiones: adoptamos el mbid aunque OTRO álbum local ya lo tenga (copias = versiones).
      try { setRgMbid.run(mb, rgId); provUp.run('release_group', rgId, mb); rep.albums_adopted++; } catch (e) { rep.albums_conflict++; }
    }
    if (albums.length < LIMIT) break;
    offset += LIMIT;
  }
  rep.pages = pages;
  // 2) Artistas — /api/artists (nombre → mbid). Solo match por nombre normalizado y ÚNICO (evita falsos positivos).
  try {
    const r = await liderarrrFetch('GET', '/api/artists');
    const arr = Array.isArray(r.body) ? r.body : ((r.body && (r.body.artists || r.body.items)) || []);
    if (arr.length) {
      const localByName = new Map();   // normName → [id,…] (solo artistas locales SIN mbid)
      for (const a of db.prepare('SELECT id, name, mbid FROM artist').all()) {
        if (a.mbid) continue; const k = lidNormName(a.name); if (!k) continue;
        if (!localByName.has(k)) localByName.set(k, []); localByName.get(k).push(a.id);
      }
      const usedMbid = db.prepare('SELECT id FROM artist WHERE mbid=?');
      const setArtMbid = db.prepare('UPDATE artist SET mbid=? WHERE id=?');
      for (const a of arr) {
        const mb = String(a.mbid || '').trim().toLowerCase(); if (!UUID_RE.test(mb)) continue;
        rep.artists_scanned++;
        const ids = localByName.get(lidNormName(a.name));
        if (!ids || ids.length !== 1) { rep.artists_no_local++; continue; }   // sin match local o ambiguo
        if (usedMbid.get(mb)) { rep.artists_conflict++; continue; }
        try { setArtMbid.run(mb, ids[0]); provUp.run('artist', ids[0], mb); rep.artists_adopted++; localByName.delete(lidNormName(a.name)); } catch (e) { rep.artists_conflict++; }
      }
    }
  } catch (e) { rep.artists_error = String(e.message); }
  _lidOwned = { at: 0, map: null };   // invalida el índice (los MBID no cambian el matchKey, pero por higiene)
  console.log('[liderarrr-sync] resultado:', JSON.stringify(rep));
  sseBroadcast('library');
  return rep;
}
// Proxy fino de escucharrr → Liderarrr (evita CORS; 'resolve' lo resuelve escucharrr localmente).
async function handleLiderarrr(req, res, u) {
  const sub = u.pathname.slice('/api/liderarrr/'.length);
  if (sub === 'resolve' && req.method === 'POST') { const b = await readBody(req); return sendJSON(res, { ok: true, owned: resolveOwnedPairs(b.pairs || []) }); }
  if (!liderarrrUrl()) return sendJSON(res, { ok: false, error: 'Liderarrr no está configurado (ponlo en Ajustes → Servicios).' });
  if (sub === 'diag' && req.method === 'GET') {   // diagnóstico (solo lectura) para depurar qué devuelve SU Liderarrr
    try { const diag = await liderarrrDiag(); console.log('[liderarrr-diag]', JSON.stringify(diag)); return sendJSON(res, { ok: true, diag }); }
    catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
  }
  if (sub === 'sync-identify' && req.method === 'POST') {   // adopta la identificación MusicBrainz ya hecha en Liderarrr
    try {
      const report = await syncLiderarrrIdentify();
      spawnCoversBackfill('liderarrr');   // baja en 2º plano las portadas que falten (una sola instancia)
      return sendJSON(res, { ok: true, report });
    } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
  }
  try {
    const body = (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT') ? await readBody(req) : null;
    const r = await liderarrrFetch(req.method, '/api/' + sub + (u.search || ''), body);
    res.writeHead(r.status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });   // datos en vivo de Liderarrr: que el navegador no los cachee nunca
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  } catch (e) { sendJSON(res, { ok: false, error: 'No se pudo contactar con Liderarrr: ' + e.message }); }
}
// URIs de redirección (que el usuario registra en Spotify / que Last.fm usa de callback)
const SPOTIFY_REDIRECT = 'http://127.0.0.1:' + PORT + '/api/spotify/callback';
const LASTFM_CALLBACK = 'http://127.0.0.1:' + PORT + '/api/lastfm/callback';
// Guarda spotify.json (clientId/clientSecret) con la Redirect URI fija; borra el token si cambian las claves.
function saveSpotifyCfg(clientId, clientSecret) {
  const changed = !spotifyCfg || spotifyCfg.clientId !== clientId || spotifyCfg.clientSecret !== clientSecret;
  const cfg = { clientId, clientSecret, redirectUri: SPOTIFY_REDIRECT };
  fs.writeFileSync(path.join(__dirname, 'spotify.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  if (changed) { try { if (fs.existsSync(SPOTIFY_TOKEN_PATH)) fs.unlinkSync(SPOTIFY_TOKEN_PATH); } catch (e) {} }
  loadSpotify(); return cfg;
}
async function spotifyAccessToken() {
  if (!spotifyConfigured() || !spotifyTok) return null;
  if (spotify.expired(spotifyTok)) { try { saveSpotifyTok(await spotify.refresh(spotifyCfg, spotifyTok.refresh_token)); } catch (e) { return null; } }
  return spotifyTok.access_token;
}

function buildQ(db) { return {
  genresOf: db.prepare(`SELECT group_concat(g.name,'|') gs FROM release_group_genre rgg JOIN genre g ON g.id=rgg.genre_id WHERE rgg.release_group_id=?`),
  formatOf: db.prepare(`SELECT rel.format f FROM "release" rel WHERE rel.release_group_id=? LIMIT 1`),
  rgsByMbid: db.prepare(`SELECT id, title, substr(first_release,1,4) year FROM release_group WHERE mbid=?`),   // versiones: mismo release-group
  trackCountOf: db.prepare(`SELECT COUNT(*) n FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE rel.release_group_id=?`),
  albumFilePaths: db.prepare(`SELECT lf.path, COALESCE(tr.title, r.title) title FROM local_file lf
     JOIN track tr ON tr.id=lf.track_id JOIN recording r ON r.id=tr.recording_id
     JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
     WHERE rel.release_group_id=? AND lf.path IS NOT NULL ORDER BY m.position, tr.position`),
  // Versión acotada a UN release (una copia): reproducir/listar la copia primaria, no todas las versiones juntas.
  albumFilePathsRel: db.prepare(`SELECT lf.path, COALESCE(tr.title, r.title) title FROM local_file lf
     JOIN track tr ON tr.id=lf.track_id JOIN recording r ON r.id=tr.recording_id
     JOIN medium m ON m.id=tr.medium_id
     WHERE m.release_id=? AND lf.path IS NOT NULL ORDER BY m.position, tr.position`),
  // Releases (copias físicas = versiones, estilo Roon) de un álbum, con nº de pistas y discos de cada uno.
  releasesOfRg: db.prepare(`SELECT rel.id, rel.date, rel.format, rel.source_dir,
       (SELECT COUNT(*) FROM medium m JOIN track t ON t.medium_id=m.id WHERE m.release_id=rel.id) tracks,
       (SELECT COUNT(DISTINCT m.id) FROM medium m WHERE m.release_id=rel.id) discs
     FROM "release" rel WHERE rel.release_group_id=? ORDER BY rel.id`),
  // Metadatos de TODOS los releases (para elegir la copia primaria en bloque en la lista de biblioteca).
  relMeta: db.prepare(`SELECT rel.id, rel.release_group_id rg, rel.date, rel.format,
       (SELECT COUNT(*) FROM medium m JOIN track t ON t.medium_id=m.id WHERE m.release_id=rel.id) tracks,
       (SELECT COUNT(DISTINCT m.id) FROM medium m WHERE m.release_id=rel.id) discs
     FROM "release" rel`),
  primaryOverrides: db.prepare(`SELECT subject_id rg, value rel FROM user_edit WHERE subject_type='release_group' AND field='primary_release'`),
  primaryOverride: db.prepare(`SELECT value rel FROM user_edit WHERE subject_type='release_group' AND subject_id=? AND field='primary_release'`),
  albumTrackIdsRel: db.prepare(`SELECT tr.id FROM track tr JOIN medium m ON m.id=tr.medium_id WHERE m.release_id=? ORDER BY m.position, tr.position`),
  // Lista de biblioteca: columnas base baratas. listen_later/has_audio/played/géneros/formato/tags
  // se resuelven en conjunto (ver libraryList), no con subconsultas correladas por fila.
  library: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.tier_rank,
      (SELECT label FROM tier WHERE key=a.tier_key) tier_label, a.album_stars, a.is_favorite
     FROM v_album a ORDER BY a.title`),
  // ── índices en conjunto para la lista (una pasada cada uno, no N+1) ──
  // audio + especificación por álbum (profundidad de bits y canales máximos) en una pasada
  audioSpec: db.prepare(`SELECT rel.release_group_id id, MAX(lf.bit_depth) bd, MAX(lf.channels) ch, MAX(lf.sample_rate) sr FROM local_file lf JOIN track tr ON (tr.id=lf.track_id OR tr.recording_id=lf.recording_id) JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id GROUP BY rel.release_group_id`),
  // estadísticas de escucha por álbum (nº de reproducciones + último play) para las facetas de Roon
  playStats: db.prepare(`SELECT rel.release_group_id id, COUNT(*) pc, MAX(p.played_at) lp FROM play p JOIN track tr ON (p.track_id=tr.id OR p.recording_id=tr.recording_id) JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id GROUP BY rel.release_group_id`),
  mediaCount: db.prepare(`SELECT rel.release_group_id id, COUNT(m.id) mc FROM "release" rel JOIN medium m ON m.release_id=rel.id GROUP BY rel.release_group_id`),   // nº de discos (Inspector: multidisco)
  addedAll:  db.prepare(`SELECT id, created_at FROM release_group`),
  mbidIds:   db.prepare(`SELECT id FROM release_group WHERE mbid IS NOT NULL`),   // "identificado" (Inspector de Roon)
  playedIds: db.prepare(`SELECT DISTINCT rel.release_group_id id FROM play p JOIN track tr ON (p.track_id=tr.id OR p.recording_id=tr.recording_id) JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id`),
  laterIds:  db.prepare(`SELECT subject_id id FROM flag WHERE subject_type='release_group' AND flag='listen_later'`),
  hiddenIds: db.prepare(`SELECT subject_id id FROM flag WHERE subject_type='release_group' AND flag='hidden'`),
  genresAll: db.prepare(`SELECT rgg.release_group_id id, group_concat(g.name,'|') gs FROM release_group_genre rgg JOIN genre g ON g.id=rgg.genre_id GROUP BY rgg.release_group_id`),
  formatAll: db.prepare(`SELECT release_group_id id, format f FROM "release" WHERE format IS NOT NULL GROUP BY release_group_id`),
  countryAll: db.prepare(`SELECT release_group_id id, country c FROM "release" WHERE country IS NOT NULL GROUP BY release_group_id`),
  labelAll: db.prepare(`SELECT rel.release_group_id id, l.name c FROM "release" rel JOIN label l ON l.id=rel.label_id GROUP BY rel.release_group_id`),
  tagsAll:   db.prepare(`SELECT ti.subject_id id, group_concat(t.name,'|') gs FROM tag_item ti JOIN tag t ON t.id=ti.tag_id WHERE ti.subject_type='release_group' GROUP BY ti.subject_id`),
  album: db.prepare(`SELECT a.id,a.title,a.orig_title,a.artist,a.orig_artist,a.year,a.primary_type,a.tier_key,a.tier_rank,
      (SELECT label FROM tier WHERE key=a.tier_key) tier_label, a.album_stars, a.is_favorite,
      EXISTS(SELECT 1 FROM flag f WHERE f.subject_type='release_group' AND f.subject_id=a.id AND f.flag='listen_later') listen_later,
      (SELECT acn.artist_id FROM artist_credit_name acn JOIN release_group rg ON rg.artist_credit_id=acn.artist_credit_id
         WHERE rg.id=a.id ORDER BY acn.position LIMIT 1) artist_id
     FROM v_album a WHERE a.id=?`),
  about: db.prepare(`SELECT value v FROM user_edit WHERE subject_type='release_group' AND subject_id=? AND field='about'`),
  aboutExt: db.prepare(`SELECT about v FROM release_group WHERE id=?`),   // reseña editorial externa (Wikipedia)
  coverOf: db.prepare(`SELECT cover_path, cover_mime, mbid FROM release_group WHERE id=?`),   // carátula cacheada (Cover Art Archive) + mbid (para la descarga perezosa)
  coverTried: db.prepare(`SELECT 1 FROM provenance WHERE subject_type='release_group' AND subject_id=? AND field='cover'`),   // ¿ya se consultó la portada en CAA? (hubo o no)
  coverPref: db.prepare(`SELECT value FROM user_edit WHERE subject_type='release_group' AND subject_id=? AND field='cover_pref'`),   // preferencia de fuente de portada (Roon: use_file/use_meta/use_best/clear)
  flagGet: db.prepare(`SELECT 1 FROM flag WHERE subject_type=? AND subject_id=? AND flag=? LIMIT 1`),
  // ficheros FLAC del álbum, para extraer el arte embebido (como Roon lee de los propios ficheros)
  filesForAlbum: db.prepare(`SELECT lf.path FROM local_file lf
     JOIN track tr ON (tr.id=lf.track_id OR tr.recording_id=lf.recording_id)
     JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
     WHERE rel.release_group_id=? AND lf.format IN ('FLAC','MP3','M4A','AAC','AIFF','AIF','OGG','OGA','OPUS')
     ORDER BY CASE lf.format WHEN 'FLAC' THEN 0 ELSE 1 END LIMIT 8`),
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
  // ── presets de DSP (EQ paramétrico + convolución), estilo Roon ──
  dspList: db.prepare(`SELECT id, name, state FROM dsp_preset ORDER BY name`),
  dspSave: db.prepare(`INSERT INTO dsp_preset(name, state) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET state=excluded.state`),
  dspDelete: db.prepare(`DELETE FROM dsp_preset WHERE id=?`),
  // ── emisoras de radio por internet (stream en vivo + metadatos ICY) ──
  radioList: db.prepare(`SELECT id, name, url, homepage, favicon FROM radio_station ORDER BY name`),
  radioGet: db.prepare(`SELECT id, name, url, homepage, favicon FROM radio_station WHERE id=?`),
  radioAdd: db.prepare(`INSERT INTO radio_station(name, url, homepage, favicon) VALUES(?, ?, ?, ?)`),
  radioDelete: db.prepare(`DELETE FROM radio_station WHERE id=?`),
  prov: db.prepare(`SELECT field,source,source_ref FROM provenance WHERE subject_type='release_group' AND subject_id=?`),
  editions: db.prepare(`SELECT rel.format, rel.date, rel.country, rel.barcode, l.name label FROM "release" rel LEFT JOIN label l ON l.id=rel.label_id WHERE rel.release_group_id=? ORDER BY rel.date`),
  // versiones/ediciones del álbum = release_groups hermanos (mismo artista + título base), estilo Roon
  albumMainArtist: db.prepare(`SELECT acn.name FROM artist_credit_name acn JOIN release_group rg ON rg.artist_credit_id=acn.artist_credit_id WHERE rg.id=? AND acn.position=1 LIMIT 1`),
  rgsByArtistName: db.prepare(`SELECT rg.id, rg.title, substr(rg.first_release,1,4) year FROM release_group rg JOIN artist_credit_name acn ON acn.artist_credit_id=rg.artist_credit_id AND acn.position=1 WHERE acn.name=?`),
  tracks: db.prepare(`SELECT tr.id trackId, tr.recording_id, m.position disc, tr.position pos, tr.title, tr.length_ms,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=tr.artist_credit_id ORDER BY acn.position LIMIT 1) artist,
      (SELECT acn.artist_id FROM artist_credit_name acn WHERE acn.artist_credit_id=tr.artist_credit_id ORDER BY acn.position LIMIT 1) artist_id,
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
  // Igual que `tracks` pero acotado a UN release (una copia/versión concreta, estilo Roon): la página de álbum
  // muestra las pistas de la copia primaria (o la seleccionada), no las de todas las versiones concatenadas.
  tracksRel: db.prepare(`SELECT tr.id trackId, tr.recording_id, m.position disc, tr.position pos, tr.title, tr.length_ms,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=tr.artist_credit_id ORDER BY acn.position LIMIT 1) artist,
      (SELECT acn.artist_id FROM artist_credit_name acn WHERE acn.artist_credit_id=tr.artist_credit_id ORDER BY acn.position LIMIT 1) artist_id,
      EXISTS(SELECT 1 FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id) playable,
      (SELECT lf.gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) gain_db,
      (SELECT lf.peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) peak_dbfs,
      (SELECT lf.album_gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) album_gain_db,
      (SELECT lf.album_peak_dbfs FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) album_peak_dbfs,
      (SELECT work_id FROM recording WHERE id=tr.recording_id) work_id,
      (SELECT w.title FROM work w WHERE w.id=(SELECT work_id FROM recording WHERE id=tr.recording_id)) work,
      (SELECT group_concat(DISTINCT a.name) FROM credit c JOIN artist a ON a.id=c.artist_id WHERE c.entity_type='work' AND c.entity_id=(SELECT work_id FROM recording WHERE id=tr.recording_id) AND c.role='composición') composers
     FROM track tr JOIN medium m ON m.id=tr.medium_id
     WHERE m.release_id=? ORDER BY m.position,tr.position`),
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
  artistBioEdProv: db.prepare(`SELECT source,source_ref FROM provenance WHERE subject_type='artist' AND subject_id=? AND field='bio_editorial'`),   // procedencia de la bio editorial (separada de la del usuario)
  artistBioEdit: db.prepare(`SELECT value v FROM user_edit WHERE subject_type='artist' AND subject_id=? AND field='bio'`),
  setArtistBio: db.prepare(`UPDATE artist SET bio=?, updated_at=datetime('now') WHERE id=?`),   // bio editorial (Wikipedia) bajo demanda
  setBioProv: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at) VALUES(?,?,?,?,?,datetime('now')) ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`),
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
  artistGenreIds: db.prepare(`SELECT rgg.genre_id, count(*) n FROM release_group rg
     JOIN artist_credit_name acn ON acn.artist_credit_id=rg.artist_credit_id
     JOIN release_group_genre rgg ON rgg.release_group_id=rg.id
     WHERE acn.artist_id=? GROUP BY rgg.genre_id ORDER BY n DESC LIMIT 12`),
  // ── editar / unir artistas ──
  artistAlbumCount: db.prepare(`SELECT COUNT(DISTINCT rg.id) n FROM artist_credit_name acn JOIN release_group rg ON rg.artist_credit_id=acn.artist_credit_id WHERE acn.artist_id=?`),
  artistDupes: db.prepare(`SELECT a.id, a.name, a.disambiguation, a.mbid FROM artist a WHERE a.id!=? AND lower(trim(a.name))=lower(trim(?)) ORDER BY a.name`),
  artistSearch: db.prepare(`SELECT a.id, a.name, a.disambiguation FROM artist a WHERE a.id!=? AND a.name LIKE ? ORDER BY (lower(a.name)=lower(?)) DESC, a.name LIMIT 20`),
  // ── género ──
  genreAlbums: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a JOIN release_group_genre rgg ON rgg.release_group_id=a.id
     JOIN genre g ON g.id=rgg.genre_id WHERE g.name=? ORDER BY a.first_release DESC, a.title`),
  genreRelated: db.prepare(`SELECT g2.name, count(*) n FROM release_group_genre x
     JOIN release_group_genre y ON y.release_group_id=x.release_group_id AND y.genre_id!=x.genre_id
     JOIN genre g1 ON g1.id=x.genre_id JOIN genre g2 ON g2.id=y.genre_id
     WHERE g1.name=? GROUP BY g2.id ORDER BY n DESC, g2.name LIMIT 10`),
  allGenres: db.prepare(`SELECT g.name, count(*) n FROM genre g JOIN release_group_genre rgg ON rgg.genre_id=g.id GROUP BY g.id ORDER BY n DESC, g.name`),
  // portada representativa por género crudo: prefiere un álbum CON portada descargada, si no, cualquiera
  genreRepByRaw: db.prepare(`SELECT g.name raw,
     (SELECT rgg.release_group_id FROM release_group_genre rgg JOIN release_group rg ON rg.id=rgg.release_group_id WHERE rgg.genre_id=g.id AND rg.cover_path IS NOT NULL ORDER BY rg.first_release DESC LIMIT 1) rg_cover,
     (SELECT rgg.release_group_id FROM release_group_genre rgg WHERE rgg.genre_id=g.id ORDER BY rgg.release_group_id DESC LIMIT 1) rg_any
     FROM genre g JOIN release_group_genre x ON x.genre_id=g.id GROUP BY g.id`),
  // ── descubrir (recomendaciones sobre el grafo local) ──
  discUnrated: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a WHERE a.tier_key IS NULL ORDER BY a.first_release DESC, a.title LIMIT 18`),
  discUnratedCount: db.prepare(`SELECT count(*) n FROM v_album WHERE tier_key IS NULL`),
  // "Vuelve a estos" (muy valorados que no has reproducido): el conjunto de álbumes reproducidos
  // es diminuto, así que lo calculamos una vez con NOT IN en vez de un NOT EXISTS correlado por fila.
  discRevisit: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a
     WHERE a.tier_rank>=4 AND a.id NOT IN (
       SELECT rel.release_group_id FROM play p JOIN track tr ON (p.track_id=tr.id OR p.recording_id=tr.recording_id)
       JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id)
     ORDER BY a.tier_rank DESC, RANDOM() LIMIT 12`),
  discRandom: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a ORDER BY RANDOM() LIMIT 6`),
  // "En este día" (estilo Plexamp music.anniversary.releases): álbumes cuyo día-mes de
  // lanzamiento coincide con hoy, de años anteriores. years_ago = añoActual − año. Necesita
  // fecha COMPLETA (YYYY-MM-DD); las fechas solo-año de MusicBrainz no cuentan (no tienen día).
  discOnThisDay: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite,
       (? - CAST(substr(a.first_release,1,4) AS INT)) AS years_ago
     FROM v_album a
     WHERE length(a.first_release) >= 10 AND substr(a.first_release,6,5) = ?
       AND CAST(substr(a.first_release,1,4) AS INT) < ?
     ORDER BY (a.tier_rank IS NULL), a.tier_rank DESC, years_ago DESC, a.title LIMIT 24`),
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
  // ── historial de escucha (reproducciones cronológicas, estilo "History" de Roon) ──
  historyCount: db.prepare(`SELECT count(*) n FROM play`),
  historyList: db.prepare(`SELECT p.id, p.played_at, p.ms_played, p.source, p.zone, p.track_id, p.recording_id,
       COALESCE(tr.title, r.title, 'Pista') AS title,
       (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=COALESCE(tr.artist_credit_id, r.artist_credit_id) ORDER BY acn.position LIMIT 1) AS artist,
       (SELECT rel.release_group_id FROM track t2 JOIN medium m2 ON m2.id=t2.medium_id JOIN "release" rel ON rel.id=m2.release_id
          WHERE t2.id=p.track_id OR t2.recording_id=COALESCE(p.recording_id, tr.recording_id) LIMIT 1) AS album_id
     FROM play p
     LEFT JOIN track tr ON tr.id=p.track_id
     LEFT JOIN recording r ON r.id=COALESCE(p.recording_id, tr.recording_id)
     ORDER BY p.played_at DESC, p.id DESC LIMIT ? OFFSET ?`),
  rgTitle: db.prepare(`SELECT title FROM release_group WHERE id=?`),
  // ── edición/corrección de metadatos ("tus datos mandan": el valor de usuario GANA) ──
  edSetTier: db.prepare(`INSERT INTO rating_tier(subject_type,subject_id,tier_key,source,updated_at) VALUES(?,?,?,'user',datetime('now')) ON CONFLICT(subject_type,subject_id) DO UPDATE SET tier_key=excluded.tier_key, source='user', updated_at=datetime('now')`),
  edDelTier: db.prepare(`DELETE FROM rating_tier WHERE subject_type=? AND subject_id=?`),
  edSetStars: db.prepare(`INSERT INTO rating(subject_type,subject_id,stars,source,updated_at) VALUES(?,?,?,'user',datetime('now')) ON CONFLICT(subject_type,subject_id) DO UPDATE SET stars=excluded.stars, source='user', updated_at=datetime('now')`),
  edDelStars: db.prepare(`DELETE FROM rating WHERE subject_type=? AND subject_id=?`),
  edEvent: db.prepare(`INSERT INTO rating_event(subject_type,subject_id,kind,value,source) VALUES(?,?,?,?,'user')`),
  edSetFlag: db.prepare(`INSERT OR IGNORE INTO flag(subject_type,subject_id,flag) VALUES(?,?,?)`),
  edDelFlag: db.prepare(`DELETE FROM flag WHERE subject_type=? AND subject_id=? AND flag=?`),
  edSetUserEdit: db.prepare(`INSERT INTO user_edit(subject_type,subject_id,field,value,updated_at) VALUES(?,?,?,?,datetime('now')) ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`),
  edDelUserEdit: db.prepare(`DELETE FROM user_edit WHERE subject_type=? AND subject_id=? AND field=?`),
  edSetProv: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at) VALUES(?,?,?,'user',NULL,datetime('now')) ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source='user', source_ref=NULL, fetched_at=datetime('now')`),
  edDelProv: db.prepare(`DELETE FROM provenance WHERE subject_type=? AND subject_id=? AND field=?`),
  // ── escribir de vuelta en la nota de Obsidian (son .md): localizar nota, espejar estado ──
  noteForSubject: db.prepare(`SELECT n.id, n.path FROM obsidian_link l JOIN obsidian_note n ON n.id=l.note_id WHERE l.subject_type=? AND l.subject_id=? LIMIT 1`),
  albumName: db.prepare(`SELECT title, artist FROM v_album WHERE id=?`),
  artistName: db.prepare(`SELECT name FROM artist WHERE id=?`),
  noteUpsert: db.prepare(`INSERT INTO obsidian_note(vault,path,mtime,frontmatter_json,body_md) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, frontmatter_json=excluded.frontmatter_json, body_md=excluded.body_md RETURNING id`),
  noteLink: db.prepare(`INSERT OR REPLACE INTO obsidian_link(note_id,subject_type,subject_id,match_by,match_conf) VALUES(?,?,?,'manual',1.0)`),
  edSetProvObs: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at) VALUES(?,?,?,'obsidian',?,datetime('now')) ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source='obsidian', source_ref=excluded.source_ref, fetched_at=datetime('now')`),
  tierKeys: db.prepare(`SELECT key, label, rank FROM tier ORDER BY rank DESC`),
  // ── Descubrir: "escuchar más tarde" (flag) y "hace tiempo que no suena" (último play antiguo) ──
  discListenLater: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite
     FROM v_album a JOIN flag f ON f.subject_type='release_group' AND f.subject_id=a.id AND f.flag='listen_later'
     ORDER BY f.set_at DESC LIMIT 18`),
  // "Hace tiempo que no suena": arrancamos desde play (pocas filas) y agrupamos por álbum,
  // luego unimos a v_album por PK. Evita calcular un MAX correlado por cada álbum de la biblioteca.
  discNotRecent: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.primary_type,a.tier_key,a.album_stars,a.is_favorite, lp.last_played
     FROM (SELECT rel.release_group_id rgid, MAX(p.played_at) last_played
             FROM play p JOIN track tr ON (p.track_id=tr.id OR p.recording_id=tr.recording_id)
             JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
             GROUP BY rel.release_group_id) lp
     JOIN v_album a ON a.id = lp.rgid
     WHERE lp.last_played < datetime('now', ?) ORDER BY lp.last_played ASC LIMIT 12`),
  // "Sigue escuchando": álbumes con reproducción más reciente (para retomar)
  homeRecentlyPlayed: db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.tier_key, lp.last_played
     FROM (SELECT rel.release_group_id rgid, MAX(p.played_at) last_played
             FROM play p JOIN track tr ON (p.track_id=tr.id OR p.recording_id=tr.recording_id)
             JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
             GROUP BY rel.release_group_id) lp
     JOIN v_album a ON a.id = lp.rgid ORDER BY lp.last_played DESC LIMIT 12`),
}; }
let Q = buildQ(db);
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
       AND NOT EXISTS(SELECT 1 FROM flag f2 WHERE f2.subject_type='recording' AND f2.subject_id=tr.recording_id AND f2.flag='bad_for_radio')
     GROUP BY tr.recording_id
     ORDER BY shared DESC, COALESCE((SELECT tier_rank FROM v_album WHERE id=rg.id),0) DESC, RANDOM() LIMIT ?`;
  const rows = db.prepare(sql).all(...genreIds, ...ex, n);
  return rows.map(t => ({ trackId: t.trackId, recording_id: t.recording_id, title: t.title, artist: t.artist, albumId: t.albumId, length_ms: t.length_ms, playable: true, gain_db: t.gain_db, peak_dbfs: t.peak_dbfs, album_gain_db: t.album_gain_db, album_peak_dbfs: t.album_peak_dbfs }));
}
// ── Instant Mix / "más como esto": lista grande y DIVERSA por afinidad (géneros + artista) ──
// kind: 'album' | 'artist' | 'track'. Mismo núcleo de similitud que la radio, pero devuelve ~40
// pistas con tope por artista/álbum para que no domine uno. Excluye lo marcado bad_for_radio.
function mix(kind, id, n) {
  n = Math.min(Math.max(parseInt(n, 10) || 40, 5), 80);
  let genreIds = [], artistName = null;
  if (kind === 'album') { genreIds = Q.albumGenreIds.all(id).map(r => r.genre_id); artistName = (Q.albumMainArtist.get(id) || {}).name || null; }
  else if (kind === 'track') { const sa = Q.trackAlbum.get(id); if (sa) { genreIds = Q.albumGenreIds.all(sa.id).map(r => r.genre_id); artistName = (Q.albumMainArtist.get(sa.id) || {}).name || null; } }
  else if (kind === 'artist') { genreIds = Q.artistGenreIds.all(id).map(r => r.genre_id); artistName = (Q.artistName.get(id) || {}).name || null; }
  if (!genreIds.length && !artistName) return [];
  const gp = genreIds.length ? genreIds.map(() => '?').join(',') : 'NULL';
  const over = Math.min(n * 4, 320);
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
     WHERE EXISTS(SELECT 1 FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id)
       AND NOT EXISTS(SELECT 1 FROM flag f2 WHERE f2.subject_type='recording' AND f2.subject_id=tr.recording_id AND f2.flag='bad_for_radio')
       AND (EXISTS(SELECT 1 FROM release_group_genre g2 WHERE g2.release_group_id=rg.id AND g2.genre_id IN (${gp}))
            OR (SELECT acn3.name FROM artist_credit_name acn3 WHERE acn3.artist_credit_id=rg.artist_credit_id AND acn3.position=1)=?)
     GROUP BY tr.recording_id
     ORDER BY shared DESC, COALESCE((SELECT tier_rank FROM v_album WHERE id=rg.id),0) DESC, RANDOM() LIMIT ?`;
  const rows = db.prepare(sql).all(...genreIds, ...genreIds, artistName || '\u0000', over);
  const perArtist = {}, perAlbum = {}, out = [];
  for (const t of rows) {                                                       // diversidad: máx 3 por artista, 2 por álbum
    const a = (t.artist || '').toLowerCase();
    if ((perArtist[a] || 0) >= 3 || (perAlbum[t.albumId] || 0) >= 2) continue;
    perArtist[a] = (perArtist[a] || 0) + 1; perAlbum[t.albumId] = (perAlbum[t.albumId] || 0) + 1;
    out.push({ trackId: t.trackId, recording_id: t.recording_id, title: t.title, artist: t.artist, albumId: t.albumId, length_ms: t.length_ms, playable: true, gain_db: t.gain_db, peak_dbfs: t.peak_dbfs, album_gain_db: t.album_gain_db, album_peak_dbfs: t.album_peak_dbfs });
    if (out.length >= n) break;
  }
  return out;
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
// álbumes afines a un conjunto de géneros (overview "porque escuchaste X"), excluye al propio artista
function albumsByGenreIds(gids, excludeArtist, n) {
  if (!gids || !gids.length) return [];
  const gp = gids.map(() => '?').join(',');
  const sql = `SELECT a.id,a.title,a.artist,a.year,a.tier_key,
       count(*) shared FROM v_album a JOIN release_group_genre rgg ON rgg.release_group_id=a.id
     WHERE rgg.genre_id IN (${gp})${excludeArtist ? ' AND a.artist <> ?' : ''}
     GROUP BY a.id ORDER BY shared DESC, a.first_release DESC LIMIT ?`;
  const args = excludeArtist ? [...gids, excludeArtist, n] : [...gids, n];
  return db.prepare(sql).all(...args);
}
function home() {
  const base = {
    counts: { artists: Q.cArtists.get().n, albums: Q.cAlbums.get().n, tracks: Q.cTracks.get().n, genres: Q.cGenres.get().n },
    recent: Q.recent.all(),
    tiers: Q.tiers.all(),
    genres: gmAgg(Q.allGenres.all()).slice(0, 8),
    listening: {
      total: Q.totalPlays.get(),
      daily: Q.daily.all(),
      topArtists: Q.topArtists.all(),
      topReleases: Q.topReleases.all(),
    },
  };
  // ── overview curado (estilo Goverview_*): retomar, redescubrir, porque escuchaste X ──
  base.resume = Q.homeRecentlyPlayed.all();                       // Sigue escuchando
  base.rediscover = Q.discNotRecent.all('-90 days');              // Redescubre (sin sonar >90 días)
  const ta = base.listening.topArtists[0];
  if (ta && ta.aid) {
    const gids = Q.artistGenreIds.all(ta.aid).map(r => r.genre_id);
    base.becauseArtist = ta.artist;
    base.because = albumsByGenreIds(gids, ta.artist, 12);
  }
  return base;
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

// ── versiones/ediciones de un álbum (release_groups hermanos: mismo artista + título base) ──
const VER_DISC_RE = /\b(disc|cd|vol(?:ume)?)\s*\.?\s*\d|\[\s*disc|\(\s*disc/i;   // box sets: cada disco es distinto, no una "versión"
function baseTitle(t) {
  let s = String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[\[(][^\])]*(flac|bit|khz|mp3|aac|vinyl|wav|lossless)[^\])]*[\])]/gi, ' ');   // [FLAC 16bit 44.1kHz]
  s = s.replace(/[\[(](?:19|20)\d\d[\])]/g, ' ');                                               // (2020) [1995]
  s = s.replace(/[\[(][^\])]*(deluxe|expanded|remaster|anniversary|special|bonus|collector|definitive|extended|\bedition\b|\bversion\b|mfsl|udcd|\buk\b|\bus\b|mono|stereo)[^\])]*[\])]/gi, ' ');
  s = s.replace(/\s[-:]\s*\d+(?:st|nd|rd|th)\s+anniversary.*$/i, ' ');                          // - 40th anniversary ...
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  return s;
}
const _FMT_RANK = { FLAC: 0, ALAC: 1, WAV: 2, AIFF: 3, AIF: 3, APE: 4, WV: 5, DSF: 1, DFF: 1, M4A: 6, AAC: 7, OGG: 8, OGA: 8, OPUS: 9, MP3: 10 };
function formatRank(f) { const r = _FMT_RANK[String(f || '').toUpperCase()]; return r == null ? 50 : r; }
// ── Release PRIMARIO de un álbum (estilo Roon): varias copias/carpetas = varios `release`; una es la «Principal»
// que la página de álbum muestra por defecto. Criterio: mejor formato (lossless>lossy) → más pistas → más reciente
// → id más bajo. El usuario puede fijarla (user_edit 'primary_release'); esa manda. Un álbum con una sola copia
// (o releases antiguos sin source_dir) devuelve esa copia — comportamiento idéntico al de antes del modelo.
function cmpRelease(a, b) {
  return formatRank(a.format) - formatRank(b.format)
      || (b.tracks || 0) - (a.tracks || 0)
      || String(b.date || '').localeCompare(String(a.date || ''))
      || a.id - b.id;
}
function pickPrimaryRelease(rels, overrideRel) {
  if (!rels || !rels.length) return null;
  if (overrideRel) { const r = rels.find(x => x.id === overrideRel); if (r) return r.id; }
  return rels.slice().sort(cmpRelease)[0].id;
}
function primaryReleaseId(rg) {
  const ov = Q.primaryOverride.get(rg);
  return pickPrimaryRelease(Q.releasesOfRg.all(rg), ov ? parseInt(ov.rel, 10) : null);
}
// Etiqueta corta de una copia (versión) para la lista: nombre de la carpeta (distingue copias) si lo hay, si no el formato.
function copyLabel(r) {
  if (r.source_dir) { const b = String(r.source_dir).split(/[\\/]/).filter(Boolean).pop(); if (b) return b; }
  return r.format || 'Copia';
}
// Grupo de VERSIONES (estilo Roon): copias locales del mismo lanzamiento. Señal fuerte = mismo MBID de
// release-group; para no identificados, heurística de título (mismo artista + título base). Marca la «Primary»
// (más pistas → mejor formato → id más bajo). Devuelve TODO el grupo (incluido el actual), enriquecido.
function versionGroup(id, mbid, title) {
  const ids = new Map();
  if (mbid) for (const c of Q.rgsByMbid.all(mbid)) ids.set(c.id, c);
  const art = Q.albumMainArtist.get(id);
  if (art && !VER_DISC_RE.test(title || '')) {
    const base = baseTitle(title);
    if (base.length >= 2) for (const c of Q.rgsByArtistName.all(art.name)) if (!VER_DISC_RE.test(c.title) && baseTitle(c.title) === base) ids.set(c.id, c);
  }
  ids.set(id, ids.get(id) || { id, title, year: null });
  const list = [...ids.values()].map(c => ({ id: c.id, title: c.title, year: c.year || null, format: (Q.formatOf.get(c.id) || {}).f || null, tracks: (Q.trackCountOf.get(c.id) || {}).n || 0 }));
  list.sort((a, b) => b.tracks - a.tracks || formatRank(a.format) - formatRank(b.format) || a.id - b.id);
  if (list.length) list[0].primary = true;
  return list;
}
// Mapea una carpeta absoluta del disco (p. ej. release.source_dir) a {root, rel} para el navegador de
// Carpetas (folders.html / /api/folders): root = índice de la raíz configurada, rel = ruta relativa dentro.
// Devuelve null si la carpeta no cuelga de ninguna raíz vigilada. Comparación normalizada (Windows).
// Normaliza SIN path.resolve: source_dir ya viene colapsado a una barra (\diskstation\…) y resolve lo
// reinterpretaría como C:\… (relativo a disco). Solo colapsamos separadores y bajamos a minúsculas, igual
// en los dos lados de la comparación (raíz UNC y ruta del álbum).
function _nrmPath(p) { return String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase(); }
function folderTarget(absDir) {
  if (!absDir) return null;
  const roots = (watchConfig() && watchConfig().music) || [];
  const na = _nrmPath(absDir);
  // segmentos de la ruta en su CASE ORIGINAL (el share puede ser case-sensitive: el rel debe ir con el case
  // real, no en minúsculas, o readdir da ENOENT).
  const parts = String(absDir).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').split('\\').filter(Boolean);
  for (let i = 0; i < roots.length; i++) {
    const nr = _nrmPath(roots[i]);
    if (na === nr) return { root: i, rel: '', path: absDir };
    const pref = nr.endsWith('\\') ? nr : nr + '\\';
    if (na.startsWith(pref)) {
      const relSegs = na.slice(pref.length).split('\\').filter(Boolean).length;   // cuántos segmentos tras la raíz
      const rel = parts.slice(parts.length - relSegs).join('\\');                  // esos segmentos, en case original
      return { root: i, rel, path: absDir };
    }
  }
  return null;
}
// Abre una carpeta en el Explorador del SO (Windows). Seguridad: SOLO rutas que cuelgan de una carpeta de
// música configurada (nunca una ruta arbitraria del cliente). No mueve ni cambia nada: solo la muestra.
async function handleReveal(req, res) {
  const body = await readBody(req);
  const p = String(body.path || '').trim();
  if (!p) return sendJSON(res, { ok: false, error: 'falta la ruta' });
  const roots = (watchConfig() && watchConfig().music) || [];
  const np = _nrmPath(p);
  const allowed = roots.some(r => { const nr = _nrmPath(r); return np === nr || np.startsWith(nr.endsWith('\\') ? nr : nr + '\\'); });
  if (!allowed) return sendJSON(res, { ok: false, error: 'la ruta no está dentro de tus carpetas de música' });
  if (process.platform !== 'win32') return sendJSON(res, { ok: false, error: 'abrir en el explorador solo está disponible en Windows' });
  try {
    const win = p.replace(/\//g, '\\');
    cp.spawn('explorer.exe', [win], { detached: true, stdio: 'ignore' }).unref();   // explorer suele devolver 1; no es error
    return sendJSON(res, { ok: true });
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}
function album(id, relId) {
  const a = Q.album.get(id); if (!a) return null;
  a.genres = gmList((Q.genresOf.get(id).gs || '').split('|').filter(Boolean));
  a.format = (Q.formatOf.get(id) || {}).f || null;
  // Reseñas: TODAS las fuentes disponibles (para el selector estilo Roon). La editable (tuya/Obsidian)
  // va primera y es la que "manda"; la editorial externa (Wikipedia) se ofrece como alternativa.
  const prov = Q.prov.all(id);
  a.reviews = [];
  const ab = Q.about.get(id);
  if (ab && ab.v) { const p = prov.find(x => x.field === 'about'); const src = (p && p.source) || 'user';
    a.reviews.push({ source: src, label: src === 'obsidian' ? 'Nota de Obsidian' : 'Tu reseña', editable: true, text: ab.v, ref: (p && p.source_ref) || null }); }
  const ext = Q.aboutExt.get(id);
  if (ext && ext.v) { const p = prov.find(x => x.field === 'about_editorial');
    a.reviews.push({ source: 'editorial', label: 'Editorial', editable: false, text: ext.v, ref: (p && p.source_ref) || null }); }
  // compat: about/about_source = la fuente preferida (la primera)
  if (a.reviews.length) { a.about = a.reviews[0].text; a.about_source = { source: a.reviews[0].source, source_ref: a.reviews[0].ref }; }
  else { a.about = null; a.about_source = null; }
  a.editions = Q.editions.all(id);
  a.mbid = (db.prepare('SELECT mbid FROM release_group WHERE id=?').get(id) || {}).mbid || null;   // ¿identificado? (para el wizard)
  a.mbid_source = a.mbid ? ((prov.find(x => x.field === 'mbid') || {}).source || null) : null;   // 'liderarrr' | 'user-identify' | … (para el distintivo de procedencia)
  a.cover_pref = (Q.coverPref.get(id) || {}).value || 'auto';   // fuente de portada elegida (auto/file/download/none)
  a.hidden = Q.flagGet.get('release_group', id, 'hidden') ? 1 : 0;
  // Copias físicas (versiones por carpeta, estilo Roon): cada carpeta/formato es un `release` bajo este álbum.
  // La página muestra la copia PRIMARIA por defecto (o la seleccionada por ?rel=); las demás van en "Versiones".
  const rels = Q.releasesOfRg.all(id);
  const ovRel = Q.primaryOverride.get(id);
  const primId = pickPrimaryRelease(rels, ovRel ? parseInt(ovRel.rel, 10) : null);
  const selRel = (relId && rels.some(r => r.id === relId)) ? relId : primId;
  a.release_id = selRel;
  const selMeta = rels.find(r => r.id === selRel) || null;
  if (selMeta && selMeta.format) a.format = selMeta.format;   // formato de la copia mostrada
  // Carpeta en disco de la copia mostrada (para «Ir a la carpeta», estilo Roon — útil en discos sin
  // identificar). Tomamos el directorio de un fichero REAL de la copia (ruta con mayúsculas y UNC correcto,
  // a diferencia de source_dir que viene normalizado). Si es una carpeta de disco (CD1/CD2…), subimos al
  // álbum. Así «Abrir en el Explorador» recibe una ruta válida y las migas muestran la ruta de verdad.
  a.folder = null;
  if (selRel) {
    try {
      // Varias rutas por si la copia tiene ficheros en más de una ubicación (p. ej. C: y el NAS): nos
      // quedamos con la PRIMERA que cuelga de una raíz vigilada (folderTarget devuelve null si no mapea).
      const files = db.prepare('SELECT DISTINCT lf.path FROM local_file lf JOIN track tr ON tr.id=lf.track_id JOIN medium m ON m.id=tr.medium_id WHERE m.release_id=? AND lf.path IS NOT NULL LIMIT 12').all(selRel);
      for (const f of files) {
        let d = path.dirname(f.path);
        if (/^(cd|dis[ck]|disco|disque|vol(ume)?|digital\s*media)\s*\.?\s*\d/i.test(path.basename(d))) d = path.dirname(d);   // carpeta de disco → sube al álbum
        const t = folderTarget(d);
        if (t) { a.folder = t; break; }
      }
    } catch (e) {}
  }
  // versiones hermanas (otros release_groups con el mismo título base / mbid): otros álbumes "versión".
  const sib = versionGroup(id, a.mbid, a.title).filter(v => v.id !== id)
    .map(v => ({ id: v.id, title: v.title, year: v.year, format: v.format, tracks: v.tracks, primary: v.primary ? 1 : 0 }));
  // otras COPIAS de este mismo álbum (distintas de la mostrada): se enlazan con ?id=<rg>&rel=<release>.
  const copies = rels.filter(r => r.id !== selRel).map(r => ({
    id, rel: r.id, title: copyLabel(r), year: r.date ? String(r.date).slice(0, 4) : null,
    format: r.format, tracks: r.tracks, discs: r.discs, primary: r.id === primId ? 1 : 0, copy: 1 }));
  a.versions = copies.concat(sib);
  a.version_count = 1 + a.versions.length;                 // esta copia + las demás (copias + hermanas)
  a.is_primary = (selRel && selRel === primId) ? 1 : 0;
  a.copy_count = rels.length;                              // nº de copias físicas (carpetas) de este álbum
  a.tracks = selRel ? Q.tracksRel.all(selRel) : Q.tracks.all(id);
  a.has_audio = a.tracks.some(t => t.playable) ? 1 : 0;   // ¿hay ficheros locales que (re)analizar?
  a.reanalyzing = _reanalyzing.has(id) ? 1 : 0;            // ¿corre ahora un reanálisis de loudness/waveform?
  a.credits = Q.credits.all(id).map(c => ({ role: c.role, instrument: c.instrument, artists: (c.artists || '').split(',') }));
  a.tags = Q.tagsOfAlbum.all(id).map(r => r.name);   // etiquetas de usuario
  // Más del artista (su discografía en tu biblioteca) — para profundizar, estilo Roon. Los «artistas
  // similares» van aparte (carga perezosa vía Last.fm): el género local es demasiado grueso (85% de los
  // álbumes tienen un solo género) para dar afinidad fiable.
  a.more_albums = a.artist_id ? Q.artistAlbums.all(a.artist_id).filter(x => x.id !== id).slice(0, 14) : [];
  const sp = Q.spotifyOf.get(id) || {};   // ¿este disco está en tu biblioteca de Spotify?
  a.spotify_enabled = spotifyConfigured() && !!spotifyTok;
  a.spotify_saved = !!sp.spotify_album_id;
  a.spotify_url = sp.spotify_url || null;
  return a;
}
// ── Artistas similares vía Last.fm (editorial; el género local es demasiado grueso) ──
// Solo necesita la API key pública de Last.fm (no sesión). Caché en memoria por artista.
let _simCache = new Map();   // nombreNorm → { at, list }
function lfmApiKey() { return (scrobCfg && scrobCfg.lastfm && scrobCfg.lastfm.apiKey) || ''; }
async function lastfmSimilar(name) {
  const key = lidNormName(name); if (!key) return [];
  const c = _simCache.get(key); if (c && Date.now() - c.at < 6 * 3600e3) return c.list;
  if (!lfmApiKey()) return null;   // null = Last.fm sin configurar (distinto de "sin resultados")
  try {
    const r = await scrobble.post('https://ws.audioscrobbler.com/2.0/', { form: true,
      body: { method: 'artist.getsimilar', artist: name, api_key: lfmApiKey(), format: 'json', limit: 24, autocorrect: 1 } });
    const j = JSON.parse(r.body || '{}');
    const arr = (j.similarartists && j.similarartists.artist) || [];
    const list = arr.map(x => ({ name: x.name, match: parseFloat(x.match) || 0 })).filter(x => x.name);
    _simCache.set(key, { at: Date.now(), list });
    return list;
  } catch (e) { return []; }
}
// índice nombre normalizado → id de artista local (para marcar los que ya tienes)
let _artIdx = { at: 0, map: null };
function artistNameIndex() {
  if (_artIdx.map && Date.now() - _artIdx.at < 15000) return _artIdx.map;
  const m = new Map();
  for (const a of db.prepare('SELECT id, name FROM artist').all()) { const k = lidNormName(a.name); if (k && !m.has(k)) m.set(k, a.id); }
  _artIdx = { at: Date.now(), map: m }; return m;
}
async function handleAlbumSimilar(req, res, u) {
  try {
    const rg = parseInt(u.searchParams.get('rg'), 10);
    const art = rg ? Q.albumMainArtist.get(rg) : null;
    if (!art) return sendJSON(res, { ok: true, configured: !!lfmApiKey(), artists: [] });
    const sim = await lastfmSimilar(art.name);
    if (sim === null) return sendJSON(res, { ok: true, configured: false, artists: [] });
    const idx = artistNameIndex();
    const out = sim.map(s => { const id = idx.get(lidNormName(s.name)); return { name: s.name, id: id || null, owned: !!id }; });
    out.sort((a, b) => (b.owned - a.owned));   // primero los que tienes
    return sendJSON(res, { ok: true, configured: true, artists: out.slice(0, 16) });
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}
// Identificación automática por HUELLA (AcoustID) de UN álbum: huella de sus pistas → recording → release-group
// por consenso → fija el mbid (modelo de versiones; provenance 'acoustid') y encadena enrich + portada.
async function handleAlbumAcoustid(req, res, u) {
  try {
    const b = (req.method === 'POST') ? await readBody(req) : {};
    const rg = parseInt(b.rg || u.searchParams.get('rg'), 10);
    if (!rg) return sendJSON(res, { ok: false, error: 'falta rg' });
    if (!(await acoustidLib.fpcalcAvailable(acoustidFpcalc()))) return sendJSON(res, { ok: false, reason: 'fpcalc', error: 'Falta fpcalc (Chromaprint). Instálalo y, si hace falta, pon su ruta en Ajustes → Servicios.' });
    if (!acoustidKey()) return sendJSON(res, { ok: false, reason: 'key', error: 'Falta la API key de AcoustID (gratis en acoustid.org) — ponla en Ajustes → Servicios.' });
    const _pr = primaryReleaseId(rg);
    const tracks = _pr ? Q.albumFilePathsRel.all(_pr) : Q.albumFilePaths.all(rg);   // muestrea la copia primaria
    if (!tracks.length) return sendJSON(res, { ok: false, error: 'El álbum no tiene ficheros locales que analizar.' });
    const r = await acoustidLib.identifyAlbumByFingerprint(db, tracks, acoustidKey(), { mb: identifyAlbum.makeMb(), fpcalcPath: acoustidFpcalc() });
    if (!r.ok) return sendJSON(res, { ok: false, reason: r.reason, scanned: r.scanned || 0, error: r.reason === 'nomatch' ? 'AcoustID no reconoció el álbum (' + (r.scanned || 0) + ' pistas con huella válida).' : 'No se pudo identificar por huella.' });
    db.prepare("UPDATE release_group SET mbid=?, updated_at=datetime('now') WHERE id=?").run(r.rg_mbid, rg);
    db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at) VALUES('release_group',?,'mbid','acoustid',?,datetime('now'))
       ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source='acoustid', source_ref=excluded.source_ref, fetched_at=datetime('now')`).run(rg, r.rg_mbid);
    sseBroadcast('library');
    _spawnIngest([path.join(_DL, 'enrich.js'), '--db', DB_PATH, '--rg', String(rg)]).then(() => sseBroadcast('library')).catch(() => {});
    _spawnIngest([path.join(_DL, 'covers.js'), '--db', DB_PATH, '--rg', String(rg)]).then(() => sseBroadcast('library')).catch(() => {});
    return sendJSON(res, { ok: true, rg_mbid: r.rg_mbid, title: r.title, votes: r.votes, scanned: r.scanned, score: r.score, candidates: r.candidates });
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}
function libraryList() {
  const rows = Q.library.all();
  // una pasada por índice (set-based) en vez de 3+ consultas por álbum: O(n) total, no O(n) por fila
  const spec = Q.audioSpec.all();
  const audio = new Set(spec.map(r => r.id));
  const bitdepth = new Map(spec.map(r => [r.id, r.bd]));
  const channels = new Map(spec.map(r => [r.id, r.ch]));
  const samplerate = new Map(spec.map(r => [r.id, r.sr]));
  const pstats = new Map(Q.playStats.all().map(r => [r.id, r]));
  // nº de discos = los del release PRIMARIO de cada álbum (no la suma de todas las copias; si no, un álbum
  // con 2 copias de 1 disco saldría como "multidisco"). Elegimos la copia primaria en bloque (mismo criterio
  // que la página de álbum: override de usuario → mejor formato → más pistas → más reciente → id).
  const relsByRg = new Map();
  for (const r of Q.relMeta.all()) { let g = relsByRg.get(r.rg); if (!g) { g = []; relsByRg.set(r.rg, g); } g.push(r); }
  const primOv = new Map(Q.primaryOverrides.all().map(o => [o.rg, parseInt(o.rel, 10)]));
  const mediacount = new Map(), copycount = new Map();
  for (const [rg, list] of relsByRg) {
    copycount.set(rg, list.length);
    const pid = pickPrimaryRelease(list, primOv.get(rg));
    const p = list.find(x => x.id === pid);
    mediacount.set(rg, p ? p.discs : 1);
  }
  const added = new Map(Q.addedAll.all().map(r => [r.id, r.created_at]));
  const identified = new Set(Q.mbidIds.all().map(r => r.id));
  const played = new Set(Q.playedIds.all().map(r => r.id));
  const later = new Set(Q.laterIds.all().map(r => r.id));
  const hidden = new Set(Q.hiddenIds.all().map(r => r.id));
  const genres = new Map(Q.genresAll.all().map(r => [r.id, (r.gs || '').split('|').filter(Boolean)]));
  const format = new Map(Q.formatAll.all().map(r => [r.id, r.f]));
  const country = new Map(Q.countryAll.all().map(r => [r.id, r.c]));   // país de edición (MusicBrainz) → faceta Focus
  const label = new Map(Q.labelAll.all().map(r => [r.id, r.c]));       // sello discográfico → faceta Focus
  const tags = new Map(Q.tagsAll.all().map(r => [r.id, (r.gs || '').split('|').filter(Boolean)]));
  for (const a of rows) {
    a.genres = gmList(genres.get(a.id) || []);
    a.format = format.get(a.id) || null;
    a.country = country.get(a.id) || null;
    a.label = label.get(a.id) || null;
    a.tags = tags.get(a.id) || [];
    a.listen_later = later.has(a.id) ? 1 : 0;
    a.hidden = hidden.has(a.id) ? 1 : 0;
    a.has_audio = audio.has(a.id) ? 1 : 0;
    a.played = played.has(a.id) ? 1 : 0;
    a.bit_depth = bitdepth.get(a.id) || null;   // como el Focus de Roon por profundidad/canales
    a.channels = channels.get(a.id) || null;
    a.sample_rate = samplerate.get(a.id) || null;   // frecuencia de muestreo (faceta Roon)
    const ps = pstats.get(a.id);
    a.play_count = ps ? ps.pc : 0;               // nº de reproducciones (más/veces reproducido)
    a.last_played = ps ? ps.lp : null;           // último play (faceta "last played" de Roon)
    a.added = added.get(a.id) || null;           // fecha de alta en la biblioteca (sort/facet "añadido")
    a.identified = identified.has(a.id) ? 1 : 0;  // tiene MBID (Inspector: identificado)
    a.media_count = mediacount.get(a.id) || 1;    // nº de discos del release primario (Inspector: multidisco)
    a.has_versions = (copycount.get(a.id) || 1) > 1 ? 1 : 0;   // varias copias (carpetas) = versiones; +abajo las hermanas por título
  }
  // "con otras versiones": agrupa por artista + título base (misma lógica que versionsOf) y marca
  // los que tienen hermanos. Set-based en una pasada sobre las filas ya cargadas.
  const vgroups = new Map();
  for (const a of rows) {
    if (VER_DISC_RE.test(a.title || '')) continue;
    const b = baseTitle(a.title); if (b.length < 2) continue;
    const k = String(a.artist || '').toLowerCase() + '||' + b;
    let g = vgroups.get(k); if (!g) { g = []; vgroups.set(k, g); } g.push(a);
  }
  for (const g of vgroups.values()) if (g.length > 1) for (const a of g) a.has_versions = 1;
  return rows;
}
// ── Inspector (facetas de SALUD de la biblioteca, como el inspector_* de Roon) ──
// Audita la colección con datos que ya tenemos: identificado (MBID), sin género, sin audio
// local, sin portada cacheada, multidisco y posibles duplicados (mismo artista+título). Barato
// y set-based. Los "sin identificar" enlazan a la ficha, donde vive el wizard de identificación.
const INSPECTOR_BUCKETS = {
  unidentified: { label: 'Sin identificar', hint: 'Sin MBID: no reciben créditos/portada/obra del enriquecido. Identifícalos desde su ficha.',
    where: 'rg.mbid IS NULL' },
  no_genre: { label: 'Sin género', hint: 'No tienen ningún género asignado.',
    where: `NOT EXISTS (SELECT 1 FROM release_group_genre g WHERE g.release_group_id=a.id)` },
  no_audio: { label: 'Sin audio local', hint: 'Álbum en el grafo sin ningún fichero reproducible (p. ej. tras perder el montaje).',
    where: `NOT EXISTS (SELECT 1 FROM "release" rel JOIN medium m ON m.release_id=rel.id JOIN track tr ON tr.medium_id=m.id JOIN local_file lf ON (lf.track_id=tr.id OR lf.recording_id=tr.recording_id) WHERE rel.release_group_id=a.id)` },
  multidisc: { label: 'Multidisco', hint: 'Más de un disco (box sets, dobles).',
    // discos del release con MÁS pistas (proxy de la copia primaria), no la suma de todas las copias/versiones.
    where: `(SELECT COUNT(DISTINCT m.id) FROM medium m WHERE m.release_id=(
        SELECT r2.id FROM "release" r2 WHERE r2.release_group_id=a.id
        ORDER BY (SELECT COUNT(*) FROM medium mm JOIN track t ON t.medium_id=mm.id WHERE mm.release_id=r2.id) DESC, r2.date DESC, r2.id ASC LIMIT 1)) > 1` },
};
function inspectorCounts() {
  const rows = db.prepare('SELECT a.id, a.title, a.artist FROM v_album a').all();
  const total = rows.length;
  const out = { total, buckets: {} };
  for (const [key, def] of Object.entries(INSPECTOR_BUCKETS)) {
    out.buckets[key] = { label: def.label, hint: def.hint, count: db.prepare(`SELECT COUNT(*) n FROM v_album a JOIN release_group rg ON rg.id=a.id WHERE ${def.where}`).get().n };
  }
  // identificados (complemento de sin identificar)
  out.buckets.identified = { label: 'Identificados', hint: 'Con MBID: reciben créditos, obra, sello y portada del enriquecido.', count: total - out.buckets.unidentified.count, positive: true };
  // posibles duplicados: mismo artista + título exactos en más de un álbum (importación doble)
  const dupGroups = db.prepare(`SELECT lower(artist)||'||'||lower(title) k, COUNT(*) n FROM v_album GROUP BY k HAVING n>1`).all();
  out.buckets.duplicates = { label: 'Posibles duplicados', hint: 'Mismo artista y título en varios álbumes (importación doble). Revisa y, si procede, oculta uno.', count: dupGroups.reduce((s, g) => s + g.n, 0), computed: 'dup' };
  return out;
}
function inspectorBucket(bucket, limit, offset) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  offset = Math.max(parseInt(offset, 10) || 0, 0);
  if (bucket === 'duplicates') {
    // agrupa por artista+título exactos; devuelve los álbumes de los grupos con >1, juntos
    const rows = db.prepare(`SELECT a.id,a.title,a.artist,a.year, lower(a.artist)||'||'||lower(a.title) k
      FROM v_album a WHERE lower(a.artist)||'||'||lower(a.title) IN
        (SELECT lower(artist)||'||'||lower(title) FROM v_album GROUP BY 1 HAVING COUNT(*)>1)
      ORDER BY k, a.year`).all();
    return { bucket, total: rows.length, items: rows.slice(offset, offset + limit).map(r => ({ id: r.id, title: r.title, artist: r.artist, year: r.year })) };
  }
  if (bucket === 'identified') {
    const total = db.prepare(`SELECT COUNT(*) n FROM v_album a JOIN release_group rg ON rg.id=a.id WHERE rg.mbid IS NOT NULL`).get().n;
    const items = db.prepare(`SELECT a.id,a.title,a.artist,a.year FROM v_album a JOIN release_group rg ON rg.id=a.id WHERE rg.mbid IS NOT NULL ORDER BY a.title LIMIT ? OFFSET ?`).all(limit, offset);
    return { bucket, total, items };
  }
  const def = INSPECTOR_BUCKETS[bucket]; if (!def) return { bucket, total: 0, items: [] };
  const total = db.prepare(`SELECT COUNT(*) n FROM v_album a JOIN release_group rg ON rg.id=a.id WHERE ${def.where}`).get().n;
  const items = db.prepare(`SELECT a.id,a.title,a.artist,a.year FROM v_album a JOIN release_group rg ON rg.id=a.id WHERE ${def.where} ORDER BY a.title LIMIT ? OFFSET ?`).all(limit, offset);
  return { bucket, total, items };
}
// Explorador de pistas (como el trackbrowser de Roon). Con 254k pistas va en el servidor:
// búsqueda + orden + paginación. Una pista por fila (join a un único local_file) para no duplicar.
function tracksList(opts) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 200);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const q = String(opts.q || '').trim();
  const dir = opts.dir === 'desc' ? 'DESC' : 'ASC';
  const orderExpr = opts.sort === 'album' ? 'alb' : opts.sort === 'duration' ? 'len' : 'r.title';   // título (indexado) por defecto
  // filtros de faceta Focus de pista (sobre local_file; join por track_id, que cubre el 99,6%)
  const lfConds = [], lfArgs = [];
  if (opts.format) { lfConds.push('lf.format=?'); lfArgs.push(String(opts.format)); }
  if (opts.bitdepth) { lfConds.push('lf.bit_depth=?'); lfArgs.push(parseInt(opts.bitdepth, 10)); }
  if (opts.samplerate) { lfConds.push('lf.sample_rate=?'); lfArgs.push(parseInt(opts.samplerate, 10)); }
  if (opts.channels) { lfConds.push('lf.channels=?'); lfArgs.push(parseInt(opts.channels, 10)); }
  const hasLf = lfConds.length > 0;
  const base = `FROM track tr JOIN recording r ON r.id=tr.recording_id`
    + (hasLf ? ` JOIN local_file lf ON lf.track_id=tr.id` : ``)
    + ` JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id JOIN release_group rg ON rg.id=rel.release_group_id`;
  const conds = [], args = [];
  if (q) { const like = '%' + q + '%'; conds.push(`(COALESCE(tr.title,r.title) LIKE ? OR rg.title LIKE ? OR EXISTS(SELECT 1 FROM artist_credit_name acn WHERE acn.artist_credit_id=COALESCE(tr.artist_credit_id,r.artist_credit_id) AND acn.name LIKE ?))`); args.push(like, like, like); }
  if (hasLf) { conds.push(...lfConds); args.push(...lfArgs); }
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
  // 1ª pasada: la página de pistas (sin datos de fichero, para que el ORDER BY/LIMIT no los recorra)
  const sel = `SELECT tr.id trackId, tr.recording_id rid,
       COALESCE(tr.title, r.title) title,
       (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=COALESCE(tr.artist_credit_id, r.artist_credit_id) ORDER BY acn.position LIMIT 1) artist,
       rg.id albumId, rg.title album, COALESCE(tr.length_ms, r.length_ms) length_ms
     ${base}${where} ORDER BY ${orderExpr} ${dir}, tr.id LIMIT ? OFFSET ?`;
  const rows = db.prepare(sel).all(...args, limit, offset);
  const total = (q || hasLf) ? db.prepare(`SELECT COUNT(*) n ${base}${where}`).get(...args).n : Q.cTracks.get().n;
  // 2ª pasada: datos de fichero (formato/reproducible/ganancia) SOLO de las pistas devueltas
  if (rows.length) {
    const tids = rows.map(r => r.trackId), rids = rows.map(r => r.rid).filter(x => x != null);
    const ph = n => Array(n).fill('?').join(',');
    const lfs = db.prepare(`SELECT track_id, recording_id, format, gain_db, peak_dbfs, album_gain_db, album_peak_dbfs FROM local_file WHERE track_id IN (${ph(tids.length)})${rids.length ? ' OR recording_id IN (' + ph(rids.length) + ')' : ''}`).all(...tids, ...rids);
    const byTid = new Map(), byRid = new Map();
    for (const f of lfs) { if (f.track_id != null && !byTid.has(f.track_id)) byTid.set(f.track_id, f); if (f.recording_id != null && !byRid.has(f.recording_id)) byRid.set(f.recording_id, f); }
    for (const r of rows) { const f = byTid.get(r.trackId) || byRid.get(r.rid) || null; r.format = f ? f.format : null; r.playable = !!f; r.gain_db = f ? f.gain_db : null; r.peak_dbfs = f ? f.peak_dbfs : null; r.album_gain_db = f ? f.album_gain_db : null; r.album_peak_dbfs = f ? f.album_peak_dbfs : null; }
  }
  const items = rows.map(t => ({ trackId: t.trackId, recording_id: t.rid, title: t.title, artist: t.artist, albumId: t.albumId, album: t.album, length_ms: t.length_ms, format: t.format, playable: t.playable, gain_db: t.gain_db, peak_dbfs: t.peak_dbfs, album_gain_db: t.album_gain_db, album_peak_dbfs: t.album_peak_dbfs }));
  return { total, offset, limit, items };
}
// ── Navegador de carpetas (folderbrowser): explora la biblioteca por la estructura real de
// carpetas del disco/NAS, derivada de local_file.path. Extrae el segmento siguiente en SQL
// (rango por el índice único de path) para no traer 250k rutas al proceso.
let _folderCache = new Map();   // listados de carpetas por nivel (solo cambian al reescanear)
function folderList(opts) {
  const cfg = watchConfig(); const roots = (cfg && cfg.music) || [];
  const ck = (opts.root || 0) + '|' + (opts.path || '');
  if (_folderCache.has(ck)) return _folderCache.get(ck);
  const rootsInfo = roots.map((r, i) => ({ i, name: r.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || r, path: r }));
  const ri = Math.max(0, Math.min(parseInt(opts.root, 10) || 0, roots.length - 1));
  const root = roots[ri];
  if (!root) return { roots: rootsInfo, root: ri, rel: '', entries: [] };
  const sep = root.includes('/') && !root.includes('\\') ? '/' : '\\';
  const rel = String(opts.path || '').replace(/^[\\/]+|[\\/]+$/g, '');
  const prefix = root.replace(/[\\/]+$/, '') + sep + (rel ? rel + sep : '');
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);   // límite superior del rango
  const plen = prefix.length;
  const SEP = sep === '\\' ? 92 : 47;
  const rows = db.prepare(`SELECT seg, MAX(isdir) isdir, COUNT(*) n, MIN(track_id) trackId FROM (
       SELECT CASE WHEN instr(sub, char(?))>0 THEN substr(sub,1,instr(sub,char(?))-1) ELSE sub END seg,
              CASE WHEN instr(sub, char(?))>0 THEN 1 ELSE 0 END isdir, track_id
       FROM (SELECT substr(path, ?) sub, track_id FROM local_file WHERE path >= ? AND path < ?)
     ) GROUP BY seg ORDER BY isdir DESC, seg`).all(SEP, SEP, SEP, plen + 1, prefix, upper);
  const entries = rows.map(r => ({ name: r.seg, dir: !!r.isdir, count: r.n, trackId: r.isdir ? null : r.trackId }));
  const out = { roots: rootsInfo, root: ri, rel, sep, entries };
  _folderCache.set(ck, out);
  return out;
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
  // Biografía con selector de FUENTE (como las reseñas de álbum): tu bio (editable; manda) + editorial de
  // Wikipedia (por defecto en inglés). artist.bio = texto editorial; user_edit = el tuyo.
  const editorialBio = a.bio;
  const userBio = Q.artistBioEdit.get(id);
  // procedencia de la editorial: preferentemente 'bio_editorial'; si no, la vieja 'bio' cuando NO es del usuario
  const edProv = Q.artistBioEdProv.get(id) || (() => { const p = Q.artistBioProv.get(id); return (p && p.source && p.source !== 'user') ? p : null; })();
  a.bios = [];
  if (userBio && userBio.v) a.bios.push({ source: 'user', label: 'Tu bio', editable: true, text: userBio.v, ref: null });
  if (editorialBio) a.bios.push({ source: (edProv && edProv.source) || 'editorial', label: (edProv && edProv.source === 'wikipedia') ? 'Wikipedia' : 'Editorial', editable: false, text: editorialBio, ref: (edProv && edProv.source_ref) || null });
  a.rawUserBio = (userBio && userBio.v) || '';
  a.bio = a.bios.length ? a.bios[0].text : null;                                   // compat: la primera (tu bio manda)
  a.bio_source = a.bios.length ? { source: a.bios[0].source, source_ref: a.bios[0].ref } : null;
  a.has_editorial = a.bios.some(b => b.source !== 'user');
  a.tier_key = (Q.artistTier.get(id) || {}).tier_key || null;
  a.genres = gmAgg(Q.artistGenres.all(id));
  a.albums = Q.artistAlbums.all(id);
  const own = new Set(a.albums.map(x => x.id));
  a.appears = Q.artistAppears.all(id)
    .filter(x => !own.has(x.id))
    .map(x => ({ id: x.id, title: x.title, year: x.year, artist: x.artist, roles: (x.roles || '').split(',').filter(Boolean) }));
  a.album_count = (Q.artistAlbumCount.get(id) || {}).n || 0;
  // duplicados exactos de nombre (p. ej. 4 «blink-182») para ofrecer unirlos, con su nº de álbumes
  a.dupes = Q.artistDupes.all(id, a.name).map(d => ({ id: d.id, name: d.name, disambiguation: d.disambiguation, mbid: d.mbid, album_count: (Q.artistAlbumCount.get(d.id) || {}).n || 0 }));
  return a;
}
// ── Biografía editorial del artista desde Wikipedia (INGLÉS por defecto), bajo demanda ──
const WIKI_UA = 'escucharrr/0.1 ( https://github.com/probertoj/escucharrr )';
async function wikiSummary(lang, title) {
  try {
    const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { headers: { 'User-Agent': WIKI_UA, 'Accept': 'application/json' } });
    if (!r.ok) return null; const j = await r.json();
    if (!j || !j.extract || j.type === 'disambiguation') return null;
    const url = (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    return { extract: j.extract.trim(), url, lang };
  } catch (e) { return null; }
}
async function fetchArtistBio(a) {
  if (a.mbid) {
    try {
      const mb = await mbFetch('artist/' + a.mbid + '?inc=url-rels&fmt=json');   // mbFetch limita a ~1/s
      const rels = (mb && mb.relations) || []; let qid = null, wikiUrl = null;
      for (const rel of rels) { const u = rel.url && rel.url.resource; if (!u) continue; if (rel.type === 'wikidata') { const m = u.match(/(Q\d+)/); if (m) qid = m[1]; } else if (rel.type === 'wikipedia') wikiUrl = u; }
      if (qid) {
        try {
          const wr = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, { headers: { 'User-Agent': WIKI_UA } });
          if (wr.ok) { const wj = await wr.json(); const sl = (wj.entities && wj.entities[qid] && wj.entities[qid].sitelinks) || {};
            if (sl.enwiki) { const s = await wikiSummary('en', sl.enwiki.title); if (s) return s; }   // inglés primero
            const any = Object.keys(sl).find(k => /wiki$/.test(k) && !/(wikiquote|wikisource|commons|wikinews|wikivoyage|wiktionary)/.test(k));
            if (any) { const s = await wikiSummary(any.replace(/wiki$/, ''), sl[any].title); if (s) return s; }
          }
        } catch (e) {}
      }
      if (wikiUrl) { const m = wikiUrl.match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/); if (m) { const s = await wikiSummary(m[1], decodeURIComponent(m[2])); if (s) return s; } }
    } catch (e) {}
  }
  return await wikiSummary('en', a.name);   // sin MBID / sin artículo: en.wikipedia por nombre
}
async function handleArtistEditorial(req, res, u) {
  try {
    const id = parseInt(u.searchParams.get('id'), 10);
    const a = Q.artist.get(id); if (!a) return sendJSON(res, { ok: false, error: 'artista no encontrado' });
    const prov = Q.artistBioEdProv.get(id);
    if (a.bio && prov) return sendJSON(res, { ok: true, bio: a.bio, source: prov.source, source_ref: prov.source_ref, cached: true });   // ya cacheada
    const ed = await fetchArtistBio(a);
    if (!ed) return sendJSON(res, { ok: true, bio: null });
    Q.setArtistBio.run(ed.extract, id);
    Q.setBioProv.run('artist', id, 'bio_editorial', 'wikipedia', ed.url);
    sseBroadcast('library');
    return sendJSON(res, { ok: true, bio: ed.extract, source: 'wikipedia', source_ref: ed.url });
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}
// ── Unir artistas (Roon merge): reasigna álbumes/créditos de los duplicados al artista destino y
// borra los duplicados. El vínculo artista→álbum es acn.artist_id; los roles de pista, credit.artist_id.
function mergeArtists(into, fromIds) {
  into = parseInt(into, 10);
  const ids = [...new Set((fromIds || []).map(x => parseInt(x, 10)).filter(x => x && x !== into))];
  if (!Number.isFinite(into) || !Q.artist.get(into)) throw new Error('artista destino inválido');
  if (!ids.length) throw new Error('no hay duplicados que unir');
  const ph = ids.map(() => '?').join(',');
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE artist_credit_name SET artist_id=? WHERE artist_id IN (${ph})`).run(into, ...ids);
    db.prepare(`UPDATE credit SET artist_id=? WHERE artist_id IN (${ph})`).run(into, ...ids);
    // filas por-sujeto (bio, flags, tier, notas…): mover al destino si no choca, y limpiar el resto
    for (const t of ['user_edit', 'provenance', 'flag', 'rating_tier', 'rating', 'rating_event', 'obsidian_link']) {
      try { db.prepare(`UPDATE OR IGNORE ${t} SET subject_id=? WHERE subject_type='artist' AND subject_id IN (${ph})`).run(into, ...ids); } catch (e) {}
      try { db.prepare(`DELETE FROM ${t} WHERE subject_type='artist' AND subject_id IN (${ph})`).run(...ids); } catch (e) {}
    }
    db.prepare(`DELETE FROM artist WHERE id IN (${ph})`).run(...ids);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { into, merged: ids.length };
}
async function handleArtistMerge(req, res) {
  try { const b = await readBody(req); const r = mergeArtists(b.into, b.from); sseBroadcast('library'); return sendJSON(res, { ok: true, ...r }); }
  catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}
// Renombrar un artista: cambia artist.name y, por defecto, los nombres de crédito que coincidían
// (para que el cambio se vea en los álbumes, cuyo "artista" sale de artist_credit_name.name).
async function handleArtistEdit(req, res) {
  try {
    const b = await readBody(req);
    const id = parseInt(b.id, 10); const cur = Q.artist.get(id);
    if (!cur) return sendJSON(res, { ok: false, error: 'artista no encontrado' });
    const name = String(b.name == null ? cur.name : b.name).trim();
    if (!name) return sendJSON(res, { ok: false, error: 'el nombre no puede estar vacío' });
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE artist SET name=?, sort_name=COALESCE(?,sort_name), updated_at=datetime('now') WHERE id=?`).run(name, b.sort_name != null ? String(b.sort_name).trim() : null, id);
      if (name !== cur.name) db.prepare(`UPDATE artist_credit_name SET name=? WHERE artist_id=? AND name=?`).run(name, id, cur.name);   // propaga a los créditos que usaban el nombre viejo
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    sseBroadcast('library');
    return sendJSON(res, { ok: true, id, name });
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}
// ── discografía "ideal" del artista (MusicBrainz) con huecos (lo que NO tienes) → para «Quiero» ──
// Modelo de Roon (Ideal discography): se lista TODO lo que editó el artista y se marcan los huecos.
let _mbLastReq = 0;
async function mbFetch(q) {
  const wait = 1100 - (Date.now() - _mbLastReq); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _mbLastReq = Date.now();
  const res = await fetch('https://musicbrainz.org/ws/2/' + q, { headers: { 'User-Agent': 'escucharrr/0.1 ( https://github.com/probertoj/escucharrr )', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('MB ' + res.status);
  return res.json();
}
const _discogCache = new Map();   // artistId → { at, items }
async function artistDiscography(artistId) {
  const a = db.prepare('SELECT mbid, name FROM artist WHERE id=?').get(artistId);
  if (!a) return { ok: false, error: 'artista no encontrado' };
  if (!a.mbid) return { ok: false, needsMbid: true, error: 'El artista no está identificado en MusicBrainz.' };
  const c = _discogCache.get(artistId);
  if (c && Date.now() - c.at < 6 * 3600e3) return { ok: true, name: a.name, items: c.items };
  let rgs = [];
  try {
    for (let off = 0; off < 200; off += 100) {   // hasta 200 release-groups (álbum/EP), paginado
      const j = await mbFetch('release-group?artist=' + encodeURIComponent(a.mbid) + '&type=album|ep&limit=100&offset=' + off + '&fmt=json');
      const page = j['release-groups'] || [];
      rgs = rgs.concat(page);
      if (page.length < 100) break;
    }
  } catch (e) { return { ok: false, error: 'No se pudo consultar MusicBrainz: ' + e.message }; }
  const ownByMbid = db.prepare('SELECT id FROM release_group WHERE mbid=?');
  const idx = lidOwnedIndex();   // matchKey(artista,título) → rg_id local
  const items = rgs.map(rg => {
    const sec = rg['secondary-types'] || [];
    const title = rg.title, date = rg['first-release-date'] || '', year = date ? parseInt(date.slice(0, 4), 10) || null : null;
    let rid = (ownByMbid.get(rg.id) || {}).id || null;
    if (!rid) rid = idx.get(lidMatchKey(a.name, title)) || null;
    return { title, year, mbid: rg.id, primary: rg['primary-type'] || 'Album', secondary: sec, owned: !!rid, rg_id: rid };
  }).sort((x, y) => (y.year || 0) - (x.year || 0) || x.title.localeCompare(y.title));
  _discogCache.set(artistId, { at: Date.now(), items });
  return { ok: true, name: a.name, items };
}
// ── listas inteligentes: reglas → SQL sobre v_album (+ agregado de plays) que se autoactualiza ──
function albumPlaysMap() {
  const m = new Map();
  for (const r of db.prepare(`SELECT rel.release_group_id rgid, COUNT(*) n, MAX(p.played_at) last
     FROM play p JOIN track tr ON (p.track_id=tr.id OR p.recording_id=tr.recording_id)
     JOIN medium md ON md.id=tr.medium_id JOIN "release" rel ON rel.id=md.release_id
     GROUP BY rel.release_group_id`).all()) m.set(r.rgid, { n: r.n, last: r.last });
  return m;
}
const SMART_TR = { excel: 5, si: 4, ok: 3, meh: 2, no: 1 };
function evalSmart(rules) {
  rules = rules || {}; const conds = Array.isArray(rules.rules) ? rules.rules : [];
  const frags = [], params = [];
  for (const c of conds) {
    const f = c.field, v = c.value;
    if (f === 'genre') { frags.push(`EXISTS(SELECT 1 FROM release_group_genre g JOIN genre gn ON gn.id=g.genre_id WHERE g.release_group_id=a.id AND gn.name=?)`); params.push(String(v)); }
    else if (f === 'decade') { const d = parseInt(v, 10) || 0; frags.push(`CAST(a.year AS INT) BETWEEN ? AND ?`); params.push(d, d + 9); }
    else if (f === 'year') { frags.push(`CAST(a.year AS INT) BETWEEN ? AND ?`); params.push(parseInt((v && v[0]) || 0, 10), parseInt((v && v[1]) || 9999, 10)); }
    else if (f === 'tier') { frags.push(`a.tier_key=?`); params.push(String(v)); }
    else if (f === 'stars') { frags.push(`a.album_stars>=?`); params.push(parseFloat(v) || 0); }
    else if (f === 'favorite') { frags.push(`a.is_favorite=1`); }
    else if (f === 'type') { frags.push(`a.primary_type=?`); params.push(String(v)); }
    else if (f === 'added') { frags.push(`EXISTS(SELECT 1 FROM release_group rg WHERE rg.id=a.id AND rg.created_at>=datetime('now','-'||?||' days'))`); params.push(parseInt(v, 10) || 30); }
  }
  const where = frags.length ? ('WHERE ' + frags.join(rules.match === 'any' ? ' OR ' : ' AND ')) : '';
  let rows = db.prepare(`SELECT a.id,a.title,a.artist,a.year,a.tier_key,a.album_stars,a.is_favorite,a.primary_type FROM v_album a ${where}`).all(...params);
  const playRules = conds.filter(c => c.field === 'plays' || c.field === 'notplayed');   // se aplican en JS (AND), sobre el agregado
  if (playRules.length) {
    const pm = albumPlaysMap();
    rows = rows.filter(a => { const p = pm.get(a.id) || { n: 0, last: null };
      return playRules.every(c => {
        if (c.field === 'plays') { const n = parseInt(c.value, 10) || 0; return c.op === 'lte' ? p.n <= n : p.n >= n; }
        const days = parseInt(c.value, 10) || 90; if (!p.last) return true; return Date.parse(p.last.replace(' ', 'T') + 'Z') < (Date.now() - days * 864e5);
      }); });
  }
  const s = rules.sort || 'title';
  rows.sort((a, b) => s === 'year' ? (b.year || 0) - (a.year || 0) : s === 'tier' ? ((SMART_TR[b.tier_key] || 0) - (SMART_TR[a.tier_key] || 0)) : s === 'rating' ? ((b.album_stars || 0) - (a.album_stars || 0)) : s === 'random' ? (Math.random() - 0.5) : String(a.title || '').localeCompare(String(b.title || '')));
  const lim = parseInt(rules.limit, 10) || 0;
  return lim > 0 ? rows.slice(0, lim) : rows;
}
// pistas reproducibles de un conjunto de álbumes (para «reproducir todo» de una lista inteligente)
function tracksForAlbums(ids, cap) {
  ids = (ids || []).slice(0, 200); if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT tr.id trackId, tr.recording_id, COALESCE(tr.title,r.title) title,
       (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=COALESCE(tr.artist_credit_id,r.artist_credit_id) ORDER BY acn.position LIMIT 1) artist,
       rg.id albumId, COALESCE(tr.length_ms,r.length_ms) length_ms,
       (SELECT lf.gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) gain_db,
       (SELECT lf.album_gain_db FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id LIMIT 1) album_gain_db
     FROM track tr JOIN recording r ON r.id=tr.recording_id JOIN medium m ON m.id=tr.medium_id
     JOIN "release" rel ON rel.id=m.release_id JOIN release_group rg ON rg.id=rel.release_group_id
     WHERE rg.id IN (${ph}) AND EXISTS(SELECT 1 FROM local_file lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id)
     ORDER BY rg.id, m.position, tr.position LIMIT ?`).all(...ids, parseInt(cap, 10) || 800);
  return rows.map(t => ({ trackId: t.trackId, recording_id: t.recording_id, title: t.title, artist: t.artist, albumId: t.albumId, length_ms: t.length_ms, playable: true, gain_db: t.gain_db, album_gain_db: t.album_gain_db }));
}
async function handleSmart(req, res, u) {
  try {
    if (u.pathname === '/api/smartlists') {
      if (req.method === 'GET') return sendJSON(res, { ok: true, items: db.prepare('SELECT id, name, created_at FROM smart_playlist ORDER BY created_at DESC, id DESC').all() });
      const b = await readBody(req); const name = String(b.name || '').trim(); if (!name) return sendJSON(res, { ok: false, error: 'falta nombre' });
      const r = db.prepare('INSERT INTO smart_playlist(name, rules) VALUES(?,?)').run(name, JSON.stringify(b.rules || {}));
      return sendJSON(res, { ok: true, id: Number(r.lastInsertRowid) });
    }
    if (u.pathname === '/api/smartlist/preview') { const b = await readBody(req); return sendJSON(res, { ok: true, albums: evalSmart(b.rules || {}) }); }
    if (u.pathname === '/api/smartlist') {
      const id = parseInt(u.searchParams.get('id'), 10); const p = db.prepare('SELECT id,name,rules FROM smart_playlist WHERE id=?').get(id);
      if (!p) { res.writeHead(404); return res.end('{}'); }
      let rules = {}; try { rules = JSON.parse(p.rules); } catch (e) {}
      const albums = evalSmart(rules);
      const resp = { ok: true, playlist: { id: p.id, name: p.name, rules }, albums };
      if (u.searchParams.get('play') === '1') resp.tracks = tracksForAlbums(albums.map(a => a.id));
      return sendJSON(res, resp);
    }
    const sub = u.pathname.slice('/api/smartlist/'.length); const b = await readBody(req);
    if (sub === 'update') { const id = parseInt(b.id, 10); db.prepare('UPDATE smart_playlist SET name=COALESCE(?,name), rules=COALESCE(?,rules) WHERE id=?').run(b.name || null, b.rules ? JSON.stringify(b.rules) : null, id); return sendJSON(res, { ok: true }); }
    if (sub === 'delete') { db.prepare('DELETE FROM smart_playlist WHERE id=?').run(parseInt(b.id, 10)); return sendJSON(res, { ok: true }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}
async function handleGenreMap(req, res, u) {
  try {
    if (req.method === 'GET') {
      const rows = Q.allGenres.all().map(r => { const m = _gmap.get(String(r.name).toLowerCase()) || {}; return { raw: r.name, n: r.n, canonical: m.canonical || '', hidden: !!m.hidden }; });
      return sendJSON(res, { ok: true, genres: rows, canon: gmAgg(Q.allGenres.all()).map(g => g.name) });
    }
    const b = await readBody(req); const raw = String(b.raw || '').trim(); if (!raw) return sendJSON(res, { ok: false, error: 'falta raw' });
    const canonical = String(b.canonical || '').trim(), hidden = b.hidden ? 1 : 0;
    if (!canonical && !hidden) db.prepare('DELETE FROM genre_map WHERE raw=?').run(raw);
    else db.prepare('INSERT INTO genre_map(raw,canonical,hidden) VALUES(?,?,?) ON CONFLICT(raw) DO UPDATE SET canonical=excluded.canonical, hidden=excluded.hidden').run(raw, canonical || null, hidden);
    loadGenreMap();
    try { sseBroadcast('library'); } catch (e) {}
    return sendJSON(res, { ok: true });
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}
// ── mapeo de géneros: renombrar etiquetas crudas a un canónico u ocultarlas (ruido) ──
let _gmap = new Map();   // raw(min) → { canonical, hidden }
function loadGenreMap() { _gmap = new Map(); try { for (const r of db.prepare('SELECT raw, canonical, hidden FROM genre_map').all()) _gmap.set(String(r.raw).toLowerCase(), { canonical: r.canonical, hidden: !!r.hidden }); } catch (e) {} }
function gmOne(name) { const m = _gmap.get(String(name || '').toLowerCase()); if (!m) return name; if (m.hidden) return null; return m.canonical || name; }
function gmList(arr) { const out = [], seen = new Set(); for (const g of arr || []) { const n = gmOne(g); if (n == null) continue; const k = n.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(n); } return out; }
function gmAgg(rows) { const m = new Map(); for (const r of rows || []) { const n = gmOne(r.name); if (n == null) continue; m.set(n, (m.get(n) || 0) + (r.n || 0)); } return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)); }
loadGenreMap();   // carga inicial del mapa (ya existen db y la tabla)
function genre(name) {
  const raws = db.prepare('SELECT DISTINCT g.name FROM genre g JOIN release_group_genre rgg ON rgg.genre_id=g.id').all().map(r => r.name).filter(g => gmOne(g) === name);
  if (!raws.length) return null;
  const seen = new Set(), albums = [];
  for (const raw of raws) for (const a of Q.genreAlbums.all(raw)) if (!seen.has(a.id)) { seen.add(a.id); albums.push(a); }
  if (!albums.length) return null;
  albums.sort((x, y) => String(y.year || '').localeCompare(String(x.year || '')) || String(x.title).localeCompare(String(y.title)));
  const related = gmAgg([].concat(...raws.map(r => Q.genreRelated.all(r)))).filter(g => g.name !== name).slice(0, 10);
  return { name, albums, related };
}
// Mosaico de géneros estilo Roon: los géneros canónicos más grandes, cada uno con una portada
// representativa. Mapea la portada de cada género crudo a su canónico (una por canónico).
function genreTiles(limit) {
  const rep = new Map();   // canónico → { rg, hasCover }
  for (const r of Q.genreRepByRaw.all()) {
    const c = gmOne(r.raw); if (c == null) continue;
    const rg = r.rg_cover || r.rg_any; if (!rg) continue;
    const prev = rep.get(c);
    if (!prev || (r.rg_cover && !prev.hasCover)) rep.set(c, { rg, hasCover: !!r.rg_cover });
  }
  return gmAgg(Q.allGenres.all()).slice(0, limit || 30).map(g => ({ name: g.name, n: g.n, rg: (rep.get(g.name) || {}).rg || null }));
}
function discover(opts) {
  let tg = gmAgg(Q.allGenres.all());
  let sel = tg.filter(g => g.n >= 2);
  if (!sel.length) sel = tg.slice(0, 3);
  const byGenre = sel.slice(0, 4).map(g => ({ name: g.name, n: g.n, albums: Q.genreAlbums.all(g.name).slice(0, 12) }));
  // "En este día": hoy (local) o un MM-DD de prueba (?day=MM-DD)
  const now = new Date();
  const curYear = now.getFullYear();
  let md = (opts && /^\d{2}-\d{2}$/.test(opts.day || '')) ? opts.day
    : String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const onThisDay = Q.discOnThisDay.all(curYear, md, curYear);
  const nrDays = (opts && parseInt(opts.notRecentDays, 10)) || 45;   // "hace tiempo que no suena": umbral en días (?nrdays= para probar)
  return {
    unrated: Q.discUnrated.all(),
    unratedCount: Q.discUnratedCount.get().n,
    revisit: Q.discRevisit.all(),
    random: Q.discRandom.all(),
    byGenre,
    onThisDay, onThisDayDate: md,
    listenLater: Q.discListenLater.all(),
    notRecent: Q.discNotRecent.all('-' + nrDays + ' days'), notRecentDays: nrDays,
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const AUDIO_MIME = { '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff' };

// Streaming del fichero real con soporte de Range (necesario para seek y para que
// Chromium arranque FLAC). Resuelve la pista -> su local_file (por track o por grabación).
function streamAudio(req, res, trackId) {
  if (!trackId) { res.writeHead(400); res.end('falta ?track'); return; }
  let row = Q.fileByTrack.get(trackId);
  if (!row) { const t = Q.trackInfo.get(trackId); if (t && t.recording_id) row = Q.fileByRec.get(t.recording_id); }
  if (!row || !fs.existsSync(row.path)) { res.writeHead(404); res.end('sin fichero local'); return; }
  const stat = fs.statSync(row.path);
  const ext = path.extname(row.path).toLowerCase();
  // DSD (.dsf/.dff): los navegadores no lo decodifican → transcodificamos a FLAC al vuelo
  // (88.2 kHz 24-bit, familia de DSD64; sin Range/seek). El motor NATIVO sí lo toca directo (ffmpeg→PCM).
  if (ext === '.dsf' || ext === '.dff') {
    // DSD necesita ffmpeg para que el navegador lo oiga. Sin ffmpeg degradamos con un aviso claro
    // (415) en vez de spawnear y fallar en silencio — el resto de formatos siguen reproduciéndose.
    if (!FFMPEG) { res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Este fichero es DSD y necesita ffmpeg para reproducirse en el navegador. Instala ffmpeg o indícalo en Ajustes.'); }
    res.writeHead(200, { 'Content-Type': 'audio/flac', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    const ff = cp.spawn(FFMPEG, ['-nostdin', '-v', 'error', '-i', row.path, '-f', 'flac', '-ar', '88200', '-sample_fmt', 's32', '-'], { windowsHide: true });
    ff.stdout.pipe(res); ff.stderr.resume();
    ff.on('error', () => { try { res.end(); } catch (e) {} });
    req.on('close', () => { try { ff.kill(); } catch (e) {} });
    return;
  }
  const type = AUDIO_MIME[ext] || 'application/octet-stream';
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
      if (body.peq) opts.peq = body.peq;
      if (body.conv) opts.conv = { on: !!body.conv.on, path: body.conv.file ? impulsePath(body.conv.file) : (body.conv.path || '') };
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
    if (sub === 'peq') return sendJSON(res, { ok: true, state: P.setPeq(!!body.on, Array.isArray(body.bands) ? body.bands : []) });
    if (sub === 'conv') return sendJSON(res, { ok: true, state: P.setConv(!!body.on, body.file ? impulsePath(body.file) : (body.path || '')) });
    if (sub === 'output') { if (body.deviceId !== undefined) P.setDevice(body.deviceId || null); if (body.exclusive !== undefined) P.setExclusive(!!body.exclusive); return sendJSON(res, { ok: true, state: P.state }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── salida de red UPnP/DLNA: el servidor controla el renderer (mismo patrón que la zona nativa) ──
let _upnpDevs = { at: 0, items: [] };
let _upnp = { renderer: null, dev: null, trackId: null, nextTrackId: null, nextUrl: '', durationSec: 0, playing: false, paused: false };
// Grupo de zonas (multi-sala, estilo Roon dialog_group_zones): miembros SECUNDARIOS DLNA que reproducen
// la misma URL a la vez que el primario (_upnp). Sincronía aproximada (cada equipo descarga por su cuenta;
// no es sample-exact — eso requeriría un transporte con reloj tipo RAAT, propietario). Las mutaciones
// (pause/resume/stop/seek/volume/setnext) se reparten al primario y a todos los secundarios.
let _upnpGroup = [];
async function upnpGroupTeardown() { for (const g of _upnpGroup) { try { await g.renderer.stop(); } catch (e) {} } _upnpGroup = []; }
async function upnpGroupEach(fn) { for (const g of _upnpGroup) { try { await fn(g.renderer, g.dev); } catch (e) {} } }
async function upnpGroupPrimeNext(trackId) {   // ceba la siguiente en cada miembro (gapless best-effort)
  if (!_upnpGroup.length) return;
  const meta = trackId ? upnpMetaOf(trackId) : null; if (!meta) return;
  for (const g of _upnpGroup) {
    try { const gbase = 'http://' + UPNP.lanIp(g.dev.ip) + ':' + PORT;
      await g.renderer.setNextUri({ url: gbase + '/api/stream?track=' + trackId, mime: meta.mime, title: meta.title, artist: meta.artist, album: meta.album, durationSec: meta.durationSec, coverUrl: meta.albumId ? gbase + '/api/cover?rg=' + meta.albumId : '' });
    } catch (e) {}
  }
}
let _cast = { sender: null, dev: null, trackId: null, durationSec: 0, playing: false, paused: false };   // sesión Chromecast activa
function castLight() { const s = _cast; return { kind: 'cast', playing: !!s.sender && s.playing && !s.paused, paused: !!s.paused, device: s.dev ? s.dev.name : null, deviceId: s.dev ? s.dev.id : null, trackId: s.trackId, durationSec: s.durationSec, positionSec: 0, advanced: false }; }
function castTeardown() { if (_cast.sender) { try { _cast.sender.close(); } catch (e) {} } _cast = { sender: null, dev: null, trackId: null, durationSec: 0, playing: false, paused: false }; }
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
      const [items, cast] = await Promise.all([   // DLNA (SSDP) y Chromecast/AirPlay (mDNS) en paralelo
        upnpDevices(u.searchParams.get('refresh') === '1'),
        MDNS ? MDNS.discover({ timeoutMs: 2500 }).catch(() => []) : Promise.resolve([]),
      ]);
      const dlna = items.map(d => ({ id: d.id, name: d.name, manufacturer: d.manufacturer, model: d.model, ip: d.ip, kind: 'dlna', castable: true }));
      return sendJSON(res, { ok: true, items: dlna.concat(cast) });
    }
    if (req.method === 'GET' && sub === 'state') {
      if (_cast.sender) { let st = {}; try { st = await _cast.sender.getState(); } catch (e) {} _cast.playing = !!st.playing; _cast.paused = !!st.paused; return sendJSON(res, { ok: true, state: { kind: 'cast', playing: _cast.playing, paused: _cast.paused, device: _cast.dev.name, deviceId: _cast.dev.id, trackId: _cast.trackId, durationSec: st.durationSec || _cast.durationSec, positionSec: st.positionSec || 0, state: st.state, advanced: false } }); }
      return sendJSON(res, { ok: true, state: await upnpState() });
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (sub === 'play') {
      // destino Chromecast (id mdns: + kind chromecast): protocolo CASTV2, misma URL http que DLNA
      if (CAST && body.deviceId && body.deviceId.startsWith('mdns:')) {
        const meta = upnpMetaOf(body.track_id);
        if (!meta) return sendJSON(res, { ok: false, error: 'pista sin fichero local' });
        const cast = MDNS ? await MDNS.discover({ timeoutMs: 2500 }).catch(() => []) : [];
        const dev = cast.find(d => d.id === body.deviceId);
        if (!dev || dev.kind !== 'chromecast') return sendJSON(res, { ok: false, error: 'por ahora solo se reproduce en Chromecast (AirPlay aún no)' });
        if (!dev.ip) return sendJSON(res, { ok: false, error: 'el Chromecast no anunció su IP todavía; reintenta' });
        castTeardown(); await upnpGroupTeardown(); if (_upnp.renderer) { try { await _upnp.renderer.stop(); } catch (e) {} _upnp.renderer = null; }
        const ip = UPNP.lanIp(dev.ip), base = 'http://' + ip + ':' + PORT, seek = body.seekSec || 0;
        const sender = new CAST.CastSender(dev);
        await sender.connect();
        await sender.load({ url: base + '/api/stream?track=' + body.track_id, mime: meta.mime, title: meta.title, artist: meta.artist, album: meta.album, durationSec: meta.durationSec, coverUrl: meta.albumId ? base + '/api/cover?rg=' + meta.albumId : '', seekSec: seek });
        _cast = { sender, dev, trackId: body.track_id, durationSec: meta.durationSec, playing: true, paused: false };
        logPlay({ track_id: body.track_id, source: 'cast', zone: dev.name });
        return sendJSON(res, { ok: true, state: castLight() });
      }
      castTeardown();   // cambiar a DLNA cierra cualquier sesión de cast
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
      // grupo multi-sala: arranca los miembros secundarios (mismo stream, mismo seek), best-effort
      await upnpGroupTeardown();
      if (Array.isArray(body.groupDeviceIds) && body.groupDeviceIds.length) {
        for (const gid of body.groupDeviceIds) {
          if (!gid || gid === dev.id) continue;
          const gd = items.find(d => d.id === gid); if (!gd || !gd.ip) continue;
          try {
            const gbase = 'http://' + UPNP.lanIp(gd.ip) + ':' + PORT, gr = new UPNP.UpnpRenderer(gd);
            await gr.setUriAndPlay({ url: gbase + '/api/stream?track=' + body.track_id, mime: meta.mime, title: meta.title, artist: meta.artist, album: meta.album, durationSec: meta.durationSec, coverUrl: meta.albumId ? gbase + '/api/cover?rg=' + meta.albumId : '' });
            if (seek) { try { await gr.seek(seek); } catch (e) {} }
            _upnpGroup.push({ renderer: gr, dev: gd });
          } catch (e) {}
        }
      }
      if (body.next_track_id) { try { await upnpPrimeNext(body.next_track_id); } catch (e) {} }   // ceba la siguiente → gapless
      logPlay({ track_id: body.track_id, source: 'upnp', zone: dev.name + (_upnpGroup.length ? ' +' + _upnpGroup.length : '') });
      return sendJSON(res, { ok: true, state: upnpLight() });
    }
    if (sub === 'setnext') { if (_cast.sender) return sendJSON(res, { ok: false });   // Chromecast no cebamos siguiente (no hay gapless propio aquí)
      const ok = await upnpPrimeNext(body.track_id || null); await upnpGroupPrimeNext(body.track_id || null); return sendJSON(res, { ok }); }
    // ── sesión Chromecast activa: las mutaciones van al CastSender ──
    if (_cast.sender) {
      const C = _cast.sender;
      if (sub === 'pause') { try { await C.pause(); } catch (e) {} _cast.paused = true; _cast.playing = false; return sendJSON(res, { ok: true, state: castLight() }); }
      if (sub === 'resume') { try { await C.play(); } catch (e) {} _cast.paused = false; _cast.playing = true; return sendJSON(res, { ok: true, state: castLight() }); }
      if (sub === 'stop') { try { await C.stop(); } catch (e) {} castTeardown(); return sendJSON(res, { ok: true, state: castLight() }); }
      if (sub === 'seek') { try { await C.seek(Number(body.sec) || 0); } catch (e) {} return sendJSON(res, { ok: true, state: castLight() }); }
      if (sub === 'volume') { const pct = body.pct != null ? Number(body.pct) : (body.v != null ? Math.round(Number(body.v) * 100) : null); if (pct != null) { try { await C.setVolume(pct); } catch (e) {} } return sendJSON(res, { ok: true, state: castLight() }); }
    }
    const R = _upnp.renderer;
    if (sub === 'pause') { if (R) { try { await R.pause(); } catch (e) {} _upnp.paused = true; _upnp.playing = false; } await upnpGroupEach(r => r.pause()); return sendJSON(res, { ok: true, state: upnpLight() }); }
    if (sub === 'resume') { if (R) { try { await R.play(); } catch (e) {} _upnp.paused = false; _upnp.playing = true; } await upnpGroupEach(r => r.play()); return sendJSON(res, { ok: true, state: upnpLight() }); }
    if (sub === 'stop') { if (R) { try { await R.stop(); } catch (e) {} } await upnpGroupTeardown(); _upnp = { renderer: null, dev: _upnp.dev, trackId: null, nextTrackId: null, nextUrl: '', durationSec: 0, playing: false, paused: false }; return sendJSON(res, { ok: true, state: upnpLight() }); }
    if (sub === 'seek') { const sec = Number(body.sec) || 0; if (R) { try { await R.seek(sec); } catch (e) {} } await upnpGroupEach(r => r.seek(sec)); return sendJSON(res, { ok: true, state: upnpLight() }); }
    if (sub === 'volume') { const pct = body.pct != null ? Number(body.pct) : (body.v != null ? Math.round(Number(body.v) * 100) : null); if (pct != null) { if (R) { try { await R.setVolume(pct); } catch (e) {} } await upnpGroupEach(r => r.setVolume(pct)); } return sendJSON(res, { ok: true, state: upnpLight() }); }
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

// ── Last.fm: conectar por web (auth.getToken → autorizar → auth.getSession) ──
async function handleLastfm(req, res, u) {
  const sub = u.pathname.slice('/api/lastfm/'.length);
  try {
    if (sub === 'connect') {
      if (!(scrobCfg && scrobCfg.lastfm && scrobCfg.lastfm.apiKey && scrobCfg.lastfm.apiSecret)) { res.writeHead(302, { Location: '/settings.html?lastfm=noconfig' }); return res.end(); }
      // con cb, Last.fm devuelve a nuestro callback con ?token=... (sin guardar nada en memoria)
      const url = 'https://www.last.fm/api/auth/?api_key=' + encodeURIComponent(scrobCfg.lastfm.apiKey) + '&cb=' + encodeURIComponent(LASTFM_CALLBACK);
      res.writeHead(302, { Location: url }); return res.end();
    }
    if (sub === 'callback') {
      const token = u.searchParams.get('token');
      if (!token) { res.writeHead(302, { Location: '/settings.html?lastfm=error' }); return res.end(); }
      try { const j = await lfmAuthCall('auth.getSession', { token }); saveScrobbleCfg({ lastfm: { sessionKey: j.session.key } }); }
      catch (e) { res.writeHead(302, { Location: '/settings.html?lastfm=error' }); return res.end(); }
      res.writeHead(302, { Location: '/settings.html?lastfm=ok' }); return res.end();
    }
    res.writeHead(404); res.end('{}');
  } catch (e) { res.writeHead(302, { Location: '/settings.html?lastfm=error' }); res.end(); }
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
  if (b.album_id) {
    // Reproducir álbum = reproducir su copia PRIMARIA (o la indicada en b.rel), no todas las versiones juntas.
    const rgId = parseInt(b.album_id, 10);
    const rels = Q.releasesOfRg.all(rgId);
    const ov = Q.primaryOverride.get(rgId);
    let pr = (b.rel && rels.some(r => r.id === parseInt(b.rel, 10))) ? parseInt(b.rel, 10)
      : pickPrimaryRelease(rels, ov ? parseInt(ov.rel, 10) : null);
    trackIds = (pr ? Q.albumTrackIdsRel.all(pr) : Q.albumTrackIds.all(rgId)).map(r => r.id);
  } else if (Array.isArray(b.track_ids)) trackIds = b.track_ids.map(Number).filter(Boolean);
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
  // no-cache = "revalida siempre antes de reutilizar": sin ETags en este servidor, garantiza que una
  // actualización de HTML/JS/CSS/icono se recoja sin vaciar caché a mano (clave para el .exe y para que
  // el service worker, que cachea el shell con su propia versión, no sirva un shell viejo tras actualizar).
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
// Arte embebido en FLAC (bloque METADATA tipo 6 PICTURE): como Roon, la portada sale del
// propio fichero, sin red. El bloque está al principio del archivo, así que leerlo es barato
// aun por SMB (no se carga el audio). Devuelve {mime, ext, data} o null.
const ART_MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
function flacPicture(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4); if (fs.readSync(fd, magic, 0, 4, 0) < 4 || magic.toString('latin1') !== 'fLaC') return null;
    let off = 4;
    for (;;) {
      const h = Buffer.alloc(4); if (fs.readSync(fd, h, 0, 4, off) < 4) break; off += 4;
      const last = (h[0] & 0x80) !== 0, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
      if (type === 6) {                                 // PICTURE
        const b = Buffer.alloc(len); if (fs.readSync(fd, b, 0, len, off) < len) return null;
        let p = 0; const u = () => { const v = b.readUInt32BE(p); p += 4; return v; };
        u();                                            // tipo de imagen (portada=3, etc.)
        const ml = u(); const mime = b.toString('latin1', p, p + ml).toLowerCase(); p += ml;
        const dl = u(); p += dl;                         // descripción (saltar)
        p += 16;                                         // ancho/alto/profundidad/colores
        const imglen = u();
        if (p + imglen > b.length) return null;
        return { mime, ext: ART_MIME_EXT[mime] || 'bin', data: b.subarray(p, p + imglen) };
      }
      off += len;
      if (last) break;
    }
    return null;
  } finally { fs.closeSync(fd); }
}
const ART_DIR = path.join(__dirname, 'cache', 'art');
function tryDownloadedCover(res, row) {   // portada descargada (Cover Art Archive)
  if (row && row.cover_path) {
    const p = path.join(__dirname, row.cover_path);
    if (p.startsWith(__dirname) && fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': row.cover_mime || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(p).pipe(res); return true;
    }
  }
  return false;
}
function tryEmbeddedCover(res, id) {   // arte embebido en los FLAC (cacheado en disco)
  try {
    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const c = path.join(ART_DIR, id + '.' + ext);
      if (fs.existsSync(c)) { res.writeHead(200, { 'Content-Type': 'image/' + (ext === 'jpg' ? 'jpeg' : ext), 'Cache-Control': 'public, max-age=86400' }); fs.createReadStream(c).pipe(res); return true; }
    }
    if (!fs.existsSync(path.join(ART_DIR, id + '.none'))) {   // marcador: ya buscamos y no había, no reintentar
      try { fs.mkdirSync(ART_DIR, { recursive: true }); } catch (e) {}
      let pic = null;
      for (const f of Q.filesForAlbum.all(id)) {   // arte embebido según el formato del fichero
        const fx = path.extname(f.path).slice(1).toLowerCase();
        try { pic = fx === 'flac' ? flacPicture(f.path) : fx === 'mp3' ? TAGS.mp3Picture(f.path) : (fx === 'm4a' || fx === 'aac') ? TAGS.mp4Picture(f.path) : (fx === 'aiff' || fx === 'aif') ? TAGS.aiffPicture(f.path) : (fx === 'ogg' || fx === 'oga' || fx === 'opus') ? TAGS.oggPicture(f.path) : null; } catch (e) { pic = null; }
        if (pic) break;
      }
      if (pic) {
        try { fs.writeFileSync(path.join(ART_DIR, id + '.' + pic.ext), pic.data); } catch (e) {}
        res.writeHead(200, { 'Content-Type': pic.mime, 'Cache-Control': 'public, max-age=86400' });
        res.end(pic.data); return true;
      }
      try { fs.writeFileSync(path.join(ART_DIR, id + '.none'), ''); } catch (e) {}
    }
  } catch (e) {}
  return false;
}
// ── Descarga PEREZOSA de portadas desde Cover Art Archive ──────────────────────────────────────
// Un álbum identificado (con MBID) pero sin portada cacheada ni arte embebido mostraba el placeholder,
// aunque CAA tuviera la carátula: identificar fija el MBID pero no bajaba la portada. Ahora, al pedir
// su portada, si falta se encola una descarga en segundo plano (no bloquea: se sirve el placeholder ya
// y la próxima carga trae la real). Dedup + poca concurrencia + marcador negativo (provenance 'cover').
const _coverTried = new Set();      // rg ids ya intentados en caliente (evita reconsultar la provenance)
const _coverQueue = [];             // cola de { id, mbid }
let _coverActive = 0;
const COVER_CONC = 3;
// Backfill de portadas de TODA la biblioteca (covers.js) — UNA sola instancia a la vez. Sin esta guardia,
// cada llamada al sync de Liderarrr lanzaba un proceso nuevo: varios a la vez saturan CAA/archive.org y la
// BD (y llegaron a atascar la descarga perezosa). covers.js ya salta los álbumes con provenance 'cover'.
let _coversBackfillRunning = false;
function spawnCoversBackfill(tag) {
  if (_coversBackfillRunning) { console.log('  [' + tag + '] backfill de portadas ya en marcha — no relanzo'); return false; }
  _coversBackfillRunning = true;
  _spawnIngest([path.join(_DL, 'covers.js'), '--db', DB_PATH])
    .then(o => { if (o) console.log('  [' + tag + '] portadas:', o); sseBroadcast('library'); })
    .catch(() => {})
    .finally(() => { _coversBackfillRunning = false; });
  return true;
}
function queueCoverFetch(id, mbid) {
  if (!mbid || _coverTried.has(id)) return;
  if (Q.coverTried.get(id)) { _coverTried.add(id); return; }   // ya consultado alguna vez (hubo o no portada)
  if (_coverQueue.some(x => x.id === id)) return;
  _coverTried.add(id);
  _coverQueue.push({ id, mbid });
  pumpCoverQueue();
}
function pumpCoverQueue() {
  while (_coverActive < COVER_CONC && _coverQueue.length) {
    const job = _coverQueue.shift(); _coverActive++;
    coverfetch.fetchCoverFor(db, { id: job.id, mbid: job.mbid, appDir: __dirname })
      .then(r => { if (r && r.found) sseBroadcast('library'); else if (r && !r.miss && r.status) _coverTried.delete(job.id); })   // error transitorio → reintentable luego
      .catch(() => { _coverTried.delete(job.id); })
      .finally(() => { _coverActive--; setTimeout(pumpCoverQueue, 350); });   // cortesía con CAA/archive.org
  }
}
// Portada según la preferencia del usuario por álbum (Roon: archivo/metadatos/mejor/ninguna).
// Por defecto 'auto' = descargada > embebida > SVG. El SVG de respaldo no se cachea.
function serveCover(res, id) {
  if (!Number.isFinite(id)) { res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(coverSvg(id)); }
  const row = Q.coverOf.get(id);
  const pref = (Q.coverPref.get(id) || {}).value || 'auto';
  if (pref === 'none') { /* a SVG */ }
  else if (pref === 'file') { if (tryEmbeddedCover(res, id)) return; }
  else if (pref === 'download') { if (tryDownloadedCover(res, row)) return; if (row && row.mbid) queueCoverFetch(id, row.mbid); }
  else { if (tryDownloadedCover(res, row)) return; if (tryEmbeddedCover(res, id)) return; if (row && row.mbid) queueCoverFetch(id, row.mbid); }   // auto: descargada > embebida > (bajar de CAA en 2º plano) > SVG
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
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
function sseBroadcast(type) { if (type === 'library') { _trackFacetsCache = null; _folderCache = new Map(); } const line = `data: ${JSON.stringify({ type, t: Date.now() })}\n\n`; for (const r of sseClients) { try { r.write(line); } catch (e) {} } }
// Facetas del explorador de pistas (formato/profundidad/frecuencia/canales). Se calculan sobre
// local_file en una pasada y se cachean (solo cambian al reescanear).
let _trackFacetsCache = null;
function trackFacets() {
  if (_trackFacetsCache) return _trackFacetsCache;
  const rows = db.prepare(`SELECT format, bit_depth, sample_rate, channels, COUNT(*) n FROM local_file WHERE track_id IS NOT NULL GROUP BY format, bit_depth, sample_rate, channels`).all();
  const acc = { format: new Map(), bitdepth: new Map(), samplerate: new Map(), channels: new Map() };
  const add = (m, k, n) => { if (k == null || k === '') return; m.set(k, (m.get(k) || 0) + n); };
  for (const r of rows) { add(acc.format, r.format, r.n); add(acc.bitdepth, r.bit_depth, r.n); add(acc.samplerate, r.sample_rate, r.n); add(acc.channels, r.channels, r.n); }
  const toArr = m => [...m.entries()].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n);
  _trackFacetsCache = { format: toArr(acc.format), bitdepth: toArr(acc.bitdepth), samplerate: toArr(acc.samplerate), channels: toArr(acc.channels) };
  return _trackFacetsCache;
}
const _DL = path.join(__dirname, '..', 'data-layer');
const _AUD = /\.(flac|wav|mp3|m4a|ogg|opus|aiff?|dsf|dff)$/i;
let _watchers = [];
// ── vigilado por SONDEO para carpetas de red (SMB/UNC): fs.watch recursivo no va en
// shares de red en Windows, así que esas carpetas se sondean por firma de cambios. ──
let _pollRoots = new Map();   // root -> última firma
let _pollTimer = null, _polling = false;
const POLL_MS = 30000;
const _fsp = fs.promises;
function isUnc(p) { return /^\\\\/.test(String(p)) || /^\/\//.test(String(p)); }
// Firma barata de cambios (nº de audios + Σmtime + Σtamaño), ASÍNCRONA: una carpeta de red
// grande (NAS) tiene miles de ficheros; un recorrido SÍNCRONO bloquearía el event loop y
// congelaría el servidor (en el arranque y en cada sondeo). fs.promises cede el control.
async function pollSignatureAsync(root) {
  let n = 0, mt = 0, sz = 0;
  async function walk(dir) {
    let ents; try { ents = await _fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (_AUD.test(e.name)) { try { const st = await _fsp.stat(p); n++; mt += st.mtimeMs; sz += st.size; } catch (x) {} }
    }
  }
  await walk(root);
  return n + ':' + Math.round(mt) + ':' + sz;
}
function addPoll(root) {   // registra una carpeta para sondeo; el baseline se fija en el 1er tick (no bloquea el arranque)
  if (!_pollRoots.has(root)) { _pollRoots.set(root, null); console.log('biblioteca en vivo: sondeando (red) ' + root); }
  startPolling();
}
function startPolling() {
  if (_pollTimer || !_pollRoots.size) return;
  _pollTimer = setInterval(async () => {
    if (_polling) return; _polling = true;
    try {
      for (const root of _pollRoots.keys()) {
        if (!fs.existsSync(root)) continue;
        let sig; try { sig = await pollSignatureAsync(root); } catch (e) { continue; }
        const prev = _pollRoots.get(root);
        _pollRoots.set(root, sig);
        if (prev != null && sig !== prev) { console.log('  [poll] cambio detectado en', root); _ingSchedule('music'); }   // prev=null = fijar baseline sin disparar
      }
    } finally { _polling = false; }
  }, POLL_MS);
  if (_pollTimer.unref) _pollTimer.unref();
}
function stopPolling() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } _pollRoots.clear(); }
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
const _reanalyzing = new Set();   // release_group_ids con un reanálisis (loudness + waveform) en curso
let _ingPending = new Set(), _ingTimer = null, _ingRunning = false;
function _ingSchedule(kind) { _ingPending.add(kind); clearTimeout(_ingTimer); _ingTimer = setTimeout(_ingRun, 1500); }   // debounce 1.5 s
// Sync INCREMENTAL de una sola nota (cuando cambia un .md en el vault): obsidian-sync --only,
// que evita el pase completo del vault y el rebuild de FTS (no bloquea la BD como el full).
const _ingNotePending = new Map();
function _ingNote(f) {
  const base = path.basename(f); clearTimeout(_ingNotePending.get(base));
  _ingNotePending.set(base, setTimeout(async () => {
    _ingNotePending.delete(base);
    const c = watchConfig(); if (!c || !c.obsidianConfig) return;
    try { const out = await _spawnIngest([path.join(_DL, 'obsidian-sync.js'), '--db', DB_PATH, '--config', c.obsidianConfig, '--only', base]); if (out) console.log('  [watch] nota:', out); sseBroadcast('library'); } catch (e) {}
  }, 1500));
}
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
// Supresión de escrituras propias: cuando la app escribe una nota (write-back a Obsidian) ya
// espeja el estado en la BD, así que el re-sync que dispararía el watcher es redundante y encima
// bloquea la BD. Marcamos el fichero al escribirlo y el watcher lo ignora durante una ventana.
const _selfWrites = new Map();   // basename en minúsculas -> expiry (ms)
function markSelfWrite(relPath) { try { _selfWrites.set(path.basename(relPath).toLowerCase(), Date.now() + 10000); } catch (e) {} }
function isSelfWrite(f) {
  if (!f) return false;
  const k = path.basename(f).toLowerCase();
  const exp = _selfWrites.get(k);
  if (exp == null) return false;
  if (exp > Date.now()) return true;
  _selfWrites.delete(k); return false;
}
function stopWatching() { for (const w of _watchers) { try { w.close(); } catch (e) {} } _watchers = []; stopPolling(); }
// Vigila una carpeta con fs.watch, pero CAPTURA el evento 'error' asíncrono: en rutas de red
// (UNC/SMB, p. ej. un NAS) el watch recursivo lanza UNKNOWN de forma asíncrona y, sin este
// handler, tumba el proceso. Si falla, se cierra ese watcher y se avisa — la carpeta SIGUE
// escaneándose a mano ("Reescanear ahora") aunque el vigilado en vivo no funcione ahí.
function safeWatch(root, label, onChange) {
  let w;
  try { w = fs.watch(root, { recursive: true }, onChange); }
  catch (e) { console.error('no se pudo vigilar', root, e.code || e.message, '(se escanea a mano)'); return; }
  w.on('error', e => { console.error('aviso: fs.watch falló en', root, '(' + (e.code || e.message) + '); cambio a sondeo'); try { w.close(); } catch (x) {} _watchers = _watchers.filter(x => x !== w); addPoll(root); });
  _watchers.push(w);
  console.log('biblioteca en vivo: vigilando ' + label, root);
}
function startWatching() {   // (re)aplica el watcher según la config actual; se puede llamar tras editarla
  stopWatching();
  const c = watchConfig();
  if (!c) { console.log('biblioteca en vivo: desactivada (crea app/watch.json a partir de watch.example.json, o configúrala en Ajustes)'); return; }
  for (const root of c.music) if (fs.existsSync(root)) { if (isUnc(root)) addPoll(root); else safeWatch(root, 'música', (ev, f) => { if (!f || _AUD.test(f)) _ingSchedule('music'); }); }
  if (c.vault && fs.existsSync(c.vault)) { if (isUnc(c.vault)) addPoll(c.vault); else safeWatch(c.vault, 'vault', (ev, f) => { if (isSelfWrite(f)) return; if (f && /\.md$/i.test(f)) _ingNote(f); else if (!f) _ingSchedule('vault'); }); }
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
  let empty = false; try { empty = !db.prepare('SELECT 1 FROM release_group LIMIT 1').get(); } catch (e) {}
  return { active: !!c, folders: (c && c.music) || [], obsidian: (c && c.obs) ? { vault: c.vault, albumsFolder: c.obs.albumsFolder || '' } : null,
    // standalone: estado del entorno para Ajustes y el onboarding del primer arranque.
    ffmpeg: !!FFMPEG, ffmpegPath: FFMPEG && FFMPEG !== 'ffmpeg' ? FFMPEG : '', empty, firstRun: freshDb };
}
// Diálogo NATIVO de selección de carpeta de Windows (standalone en Win11): el servidor
// corre en la máquina del usuario, así que abre un FolderBrowserDialog del Explorador y
// devuelve la RUTA ABSOLUTA real (la File System Access API del navegador no da la ruta de disco).
function pickFolder(opts = {}) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'El selector nativo de carpeta solo está disponible en Windows.' });
    const ps = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.Show() | Out-Null; $owner.Activate()',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = $env:ESC_DESC; $d.ShowNewFolderButton = $true',
      'if ($env:ESC_INIT) { try { $d.SelectedPath = $env:ESC_INIT } catch {} }',
      '$r = $d.ShowDialog($owner); $owner.Close()',
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
    ].join('\n');
    const env = Object.assign({}, process.env, {
      ESC_DESC: String(opts.desc || 'Elige una carpeta'),
      ESC_INIT: String(opts.init || ''),
    });
    let out = '', done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const p = cp.spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', ps], { env, windowsHide: true });
      p.stdout.on('data', d => { out += d.toString('utf8'); });
      p.on('error', e => finish({ ok: false, error: String(e.message) }));
      p.on('close', () => { const sel = out.trim(); finish({ ok: true, path: sel, cancelled: !sel }); });
    } catch (e) { finish({ ok: false, error: String(e.message) }); }
  });
}
async function handleBrowse(req, res) {
  const body = await readBody(req);
  const r = await pickFolder({ desc: body.desc, init: body.init });
  return sendJSON(res, r);
}
// Explorador de carpetas CROSS-PLATFORM para la web (el selector nativo solo va en Windows). Sin ruta
// devuelve raíces/atajos (discos en Windows; /music /mnt /media /data… en Linux/Docker); con ruta, las
// subcarpetas. Solo lectura. Así un usuario headless (Docker/NAS) puede dar de alta su carpeta de música.
function listDirs(p) {
  p = String(p || '').trim();
  if (!p) {
    const roots = [];
    if (process.platform === 'win32') {
      for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) roots.push({ name: String.fromCharCode(c) + ':', path: d }); } catch (e) {} }
    } else {
      for (const d of ['/music', '/media', '/mnt', '/data', '/Volumes', '/home', '/']) { try { if (fs.existsSync(d) && fs.statSync(d).isDirectory()) roots.push({ name: d, path: d }); } catch (e) {} }
    }
    return { ok: true, path: '', parent: null, roots: true, dirs: roots };
  }
  let abs; try { abs = path.resolve(p); } catch (e) { return { ok: false, error: 'ruta inválida' }; }
  let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { const par = path.dirname(abs); return { ok: false, error: 'No se puede leer (' + (e.code || e.message) + ')', path: abs, parent: par === abs ? null : par }; }
  const dirs = [];
  for (const e of ents) {
    let isDir = false; try { isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(abs, e.name)).isDirectory()); } catch (x) {}
    if (isDir && !e.name.startsWith('.')) dirs.push({ name: e.name, path: path.join(abs, e.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const par = path.dirname(abs);
  return { ok: true, path: abs, parent: par === abs ? null : par, dirs };
}
async function handleConfig(req, res, u) {
  const sub = u.pathname.slice('/api/config'.length).replace(/^\//, '');
  try {
    if (req.method === 'GET' && sub === '') return sendJSON(res, { ok: true, ...configInfo() });
    if (sub === 'browse') return void handleBrowse(req, res);
    if (req.method === 'GET' && sub === 'listdirs') return sendJSON(res, listDirs(u.searchParams.get('path') || ''));
    // estado de las integraciones (sin exponer secretos: sólo apiKey/clientId y booleanos)
    if (req.method === 'GET' && sub === 'services') {
      const lf = (scrobCfg && scrobCfg.lastfm) || {}, lb = (scrobCfg && scrobCfg.listenbrainz) || {};
      return sendJSON(res, { ok: true,
        listenbrainz: { connected: !!lb.token },
        lastfm: { apiKey: lf.apiKey || '', hasSecret: !!lf.apiSecret, connected: !!lf.sessionKey, callbackUri: LASTFM_CALLBACK },
        spotify: { configured: spotifyConfigured(), authorized: !!spotifyTok, clientId: (spotifyCfg && spotifyCfg.clientId) || '', redirectUri: SPOTIFY_REDIRECT, matched: Q.spotifyCount.get().n },
        liderarrr: { url: liderarrrUrl(), connected: !!liderarrrUrl(), hasAuth: !!(liderarrrCfg && liderarrrCfg.pass), user: (liderarrrCfg && liderarrrCfg.user) || '' },
        acoustid: { hasKey: !!acoustidKey(), fpcalcPath: acoustidFpcalc(), fpcalc: await acoustidLib.fpcalcAvailable(acoustidFpcalc()) },
        enabled: scrobble.enabledServices(scrobCfg || {}), pending: scrobble.pendingCount(db, scrobCfg || {}) });
    }
    const body = await readBody(req);
    // ListenBrainz: valida el token y lo guarda (o lo quita). Last.fm: guarda apiKey/secret (o quita todo).
    if (sub === 'scrobble') {
      if (body.clear === 'listenbrainz') { saveScrobbleCfg({ listenbrainz: { token: '' } }); return sendJSON(res, { ok: true, enabled: scrobble.enabledServices(scrobCfg || {}) }); }
      if (body.clear === 'lastfm') { saveScrobbleCfg({ lastfm: { apiKey: '', apiSecret: '', sessionKey: '' } }); return sendJSON(res, { ok: true, enabled: scrobble.enabledServices(scrobCfg || {}) }); }
      if (body.listenbrainz && typeof body.listenbrainz.token === 'string') {
        const token = body.listenbrainz.token.trim();
        if (!token) { saveScrobbleCfg({ listenbrainz: { token: '' } }); return sendJSON(res, { ok: true, enabled: scrobble.enabledServices(scrobCfg || {}) }); }
        const r = await scrobble.post('https://api.listenbrainz.org/1/validate-token', { body: JSON.stringify({}), headers: { Authorization: 'Token ' + token } });
        let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
        if (r.status === 200 && j.valid) { saveScrobbleCfg({ listenbrainz: { token } }); return sendJSON(res, { ok: true, user: j.user_name, enabled: scrobble.enabledServices(scrobCfg || {}) }); }
        return sendJSON(res, { ok: false, error: 'Token de ListenBrainz no válido.' });
      }
      if (body.lastfm) { saveScrobbleCfg({ lastfm: { apiKey: String(body.lastfm.apiKey || '').trim(), apiSecret: String(body.lastfm.apiSecret || '').trim() } }); return sendJSON(res, { ok: true, needsConnect: !((scrobCfg.lastfm || {}).sessionKey), enabled: scrobble.enabledServices(scrobCfg || {}) }); }
      return sendJSON(res, { ok: false, error: 'Nada que guardar.' });
    }
    // Spotify: guarda clientId/clientSecret (la Redirect URI es fija y se muestra para registrarla)
    if (sub === 'spotify') {
      const clientId = String(body.clientId || '').trim(), clientSecret = String(body.clientSecret || '').trim();
      if (body.clear) { try { if (fs.existsSync(path.join(__dirname, 'spotify.json'))) fs.unlinkSync(path.join(__dirname, 'spotify.json')); if (fs.existsSync(SPOTIFY_TOKEN_PATH)) fs.unlinkSync(SPOTIFY_TOKEN_PATH); } catch (e) {} loadSpotify(); return sendJSON(res, { ok: true, configured: false }); }
      if (!clientId || !clientSecret) return sendJSON(res, { ok: false, error: 'Hacen falta el Client ID y el Client Secret.' });
      saveSpotifyCfg(clientId, clientSecret);
      return sendJSON(res, { ok: true, configured: spotifyConfigured(), redirectUri: SPOTIFY_REDIRECT });
    }
    // Liderarrr: guarda la URL (cualquiera puede apuntar a su instancia) y la valida llamando a su API
    if (sub === 'liderarrr') {
      if (body.clear) { saveLiderarrr(''); return sendJSON(res, { ok: true, connected: false }); }
      const url = String(body.url || '').trim(); if (!url) return sendJSON(res, { ok: false, error: 'Pon la URL de tu Liderarrr (p. ej. http://192.168.1.50:3861).' });
      saveLiderarrr(url, body.user, body.pass);   // credencial opcional (Basic Auth de Liderarrr)
      try {
        const r = await liderarrrFetch('GET', '/api/wanted/keys', null);
        if (r.status >= 200 && r.status < 300) return sendJSON(res, { ok: true, connected: true, url: liderarrrUrl() });
        saveLiderarrr('');
        if (r.status === 401 || r.status === 403) return sendJSON(res, { ok: false, error: 'Liderarrr responde ' + r.status + ': requiere autenticación. Tu Liderarrr tiene LIDERARRR_AUTH activado — pon la contraseña (y el usuario si no es «liderarrr»).' });
        return sendJSON(res, { ok: false, error: 'Responde con HTTP ' + r.status + ' (¿es la URL correcta?).' });
      } catch (e) { saveLiderarrr(''); return sendJSON(res, { ok: false, error: 'No responde: ' + e.message }); }
    }
    if (sub === 'acoustid') {   // identificación por huella: clave de acoustid.org + ruta opcional de fpcalc
      if (body.clear) { saveAcoustid('', ''); return sendJSON(res, { ok: true, hasKey: false }); }
      saveAcoustid(String(body.key || '').trim(), String(body.fpcalcPath || '').trim());
      const fpcalc = await acoustidLib.fpcalcAvailable(acoustidFpcalc());
      return sendJSON(res, { ok: true, hasKey: !!acoustidKey(), fpcalc, fpcalcPath: acoustidFpcalc(),
        warn: fpcalc ? '' : 'No encuentro fpcalc (Chromaprint). Instálalo o indica su ruta para poder identificar por huella.' });
    }
    if (sub === 'folders') { writeWatchFolders(Array.isArray(body.folders) ? body.folders : []); startWatching(); if (watchConfig() && watchConfig().music.length) _ingSchedule('music'); return sendJSON(res, { ok: true, ...configInfo() }); }
    if (sub === 'obsidian') { writeObsidian(String(body.vault || '').trim(), String(body.albumsFolder || '').trim()); startWatching(); _ingSchedule('vault'); return sendJSON(res, { ok: true, ...configInfo() }); }
    if (sub === 'rescan') { const r = await rescanNow(Array.isArray(body.what) ? body.what : ['music', 'vault']); return sendJSON(res, { ok: true, ...r }); }
    // Reparar renombrados/movimientos SIN re-escanear toda la biblioteca: rebind por identidad de contenido
    // (tamaño) de los ficheros huérfanos (carpeta renombrada) a su nueva ruta, y fusión de duplicados. Solo
    // BD; disco en solo-lectura. Se ejecuta como proceso hijo (como el escaneo) para no bloquear el servidor.
    if (sub === 'repair') {
      const c = watchConfig(); const roots = (c && c.music) || [];
      if (!roots.length) return sendJSON(res, { ok: false, error: 'No hay carpetas configuradas.' });
      const args = [path.join(_DL, 'rebind.js'), '--db', DB_PATH, '--apply'];
      for (const r of roots) args.push('--root', r);
      const out = await new Promise((resolve) => {
        const p = cp.spawn(process.execPath, args, { cwd: _DL });
        let so = '', se = '';
        p.stdout.on('data', (d) => (so += d)); p.stderr.on('data', (d) => (se += d));
        p.on('error', (e) => resolve({ ok: false, error: String(e.message) }));
        p.on('close', () => { try { resolve(JSON.parse(so.trim().split('\n').pop())); } catch (e) { resolve({ ok: false, error: 'salida no parseable: ' + se.slice(-200) }); } });
      });
      if (out.ok) sseBroadcast('library');
      return sendJSON(res, out);
    }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── DSP avanzado: impulsos de convolución (ficheros) + presets (EQ paramétrico + convolución) ──
const _IMP = path.join(__dirname, 'impulses');
function ensureImpDir() { try { if (!fs.existsSync(_IMP)) fs.mkdirSync(_IMP, { recursive: true }); } catch (e) {} }
function impulsePath(file) { const base = path.basename(String(file || '')); const p = path.join(_IMP, base); return (base && fs.existsSync(p)) ? p : ''; }
function listImpulses() { ensureImpDir(); try { return fs.readdirSync(_IMP).filter(f => /\.wav$/i.test(f)).map(f => { let size = 0; try { size = fs.statSync(path.join(_IMP, f)).size; } catch (e) {} return { file: f, size }; }); } catch (e) { return []; } }
function serveImpulse(res, file) { const p = impulsePath(file); if (!p) { res.writeHead(404); return res.end('{}'); } try { const b = fs.readFileSync(p); res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': b.length, 'Cache-Control': 'no-cache' }); res.end(b); } catch (e) { res.writeHead(500); res.end('{}'); } }
// selector NATIVO de FICHERO de Windows (OpenFileDialog) para elegir un impulso WAV
function pickFile(opts = {}) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'El selector nativo solo está disponible en Windows.' });
    const ps = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.Show() | Out-Null; $owner.Activate()',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      '$d.Title = $env:ESC_DESC; $d.Filter = $env:ESC_FILTER; $d.CheckFileExists = $true',
      'if ($env:ESC_INIT) { try { $d.InitialDirectory = $env:ESC_INIT } catch {} }',
      '$r = $d.ShowDialog($owner); $owner.Close()',
      'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
    ].join('\n');
    const env = Object.assign({}, process.env, { ESC_DESC: String(opts.desc || 'Elige un fichero'), ESC_FILTER: String(opts.filter || 'Todos (*.*)|*.*'), ESC_INIT: String(opts.init || '') });
    let out = '', done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const p = cp.spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', ps], { env, windowsHide: true });
      p.stdout.on('data', d => { out += d.toString('utf8'); });
      p.on('error', e => finish({ ok: false, error: String(e.message) }));
      p.on('close', () => { const sel = out.trim(); finish({ ok: true, path: sel, cancelled: !sel }); });
    } catch (e) { finish({ ok: false, error: String(e.message) }); }
  });
}
async function handleDsp(req, res, u) {
  const sub = u.pathname.slice('/api/dsp/'.length);
  try {
    if (req.method === 'GET' && sub === 'presets') return sendJSON(res, { ok: true, presets: Q.dspList.all().map(r => ({ id: r.id, name: r.name, state: JSON.parse(r.state || '{}') })) });
    if (req.method === 'GET' && sub === 'impulses') return sendJSON(res, { ok: true, impulses: listImpulses() });
    if (req.method === 'GET' && sub === 'impulse') return serveImpulse(res, u.searchParams.get('f'));
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (sub === 'preset') { const name = String(body.name || '').trim().slice(0, 60); if (!name) { res.writeHead(400); return res.end('{}'); } Q.dspSave.run(name, JSON.stringify(body.state || {})); return sendJSON(res, { ok: true, presets: Q.dspList.all().map(r => ({ id: r.id, name: r.name, state: JSON.parse(r.state || '{}') })) }); }
    if (sub === 'preset/delete') { Q.dspDelete.run(parseInt(body.id, 10)); return sendJSON(res, { ok: true }); }
    if (sub === 'impulse/browse') {
      const r = await pickFile({ desc: 'Elige un impulso de convolución (WAV)', filter: 'WAV (*.wav)|*.wav|Todos (*.*)|*.*' });
      if (!r.ok) return sendJSON(res, r);
      if (r.cancelled) return sendJSON(res, { ok: true, cancelled: true });
      ensureImpDir();
      const dest = path.basename(r.path);
      try { fs.copyFileSync(r.path, path.join(_IMP, dest)); } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
      return sendJSON(res, { ok: true, file: dest, impulses: listImpulses() });
    }
    if (sub === 'impulse/delete') { const p = impulsePath(body.file); if (p) { try { fs.unlinkSync(p); } catch (e) {} } return sendJSON(res, { ok: true, impulses: listImpulses() }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── RADIO POR INTERNET: proxy de stream con lectura de metadatos ICY (SHOUTcast/Icecast) ──
// RE de Roon: un stream en vivo se modela con `is_live` (sin duración/seek) y el "ahora suena"
// viene por ICY. El navegador no puede leer ICY de un <audio>, así que el servidor abre el
// stream con Icy-MetaData:1, extrae StreamTitle, lo QUITA del audio que reenvía, y publica el
// título por SSE (evento 'radio'). También sirve al motor nativo (ffmpeg lee este proxy).
const _radioNow = new Map();   // id -> { name, title }
function radioInfo() { const items = []; for (const [id, v] of _radioNow) items.push({ id, ...v }); return items; }
function httpGetStream(url, headers, onResponse, onError, maxRedirects = 5) {
  let u; try { u = new URL(url); } catch (e) { return onError(new Error('URL inválida')); }
  const mod = u.protocol === 'https:' ? https : http;
  const req = mod.request(u, { method: 'GET', headers }, upRes => {
    if ([301, 302, 303, 307, 308].includes(upRes.statusCode) && upRes.headers.location && maxRedirects > 0) {
      upRes.resume();
      return httpGetStream(new URL(upRes.headers.location, u).toString(), headers, onResponse, onError, maxRedirects - 1);
    }
    onResponse(upRes, req);
  });
  req.on('error', onError);
  req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  req.end();
  return req;
}
// Separa audio de metadatos ICY: cada metaint bytes de audio, 1 byte de longitud×16, luego
// "StreamTitle='...';". Llama onAudio(buf) con SOLO el audio y onTitle(str) al cambiar el título.
function makeIcyParser(metaint, onAudio, onTitle) {
  let audioLeft = metaint, metaLeft = 0, metaExpect = -1, metaBuf = Buffer.alloc(0), lastTitle = null;
  return function (chunk) {
    let i = 0;
    while (i < chunk.length) {
      if (metaExpect === 0) { metaExpect = chunk[i] * 16; i++; metaLeft = metaExpect; metaBuf = Buffer.alloc(0); if (metaExpect === 0) { audioLeft = metaint; metaExpect = -1; } continue; }
      if (metaExpect > 0) {
        const take = Math.min(metaLeft, chunk.length - i);
        metaBuf = Buffer.concat([metaBuf, chunk.subarray(i, i + take)]); i += take; metaLeft -= take;
        if (metaLeft === 0) { const m = /StreamTitle='((?:[^']|\\')*)'/.exec(metaBuf.toString('utf8')); if (m && m[1] !== lastTitle) { lastTitle = m[1]; onTitle(m[1]); } audioLeft = metaint; metaExpect = -1; }
        continue;
      }
      const take = Math.min(audioLeft, chunk.length - i);
      onAudio(chunk.subarray(i, i + take)); i += take; audioLeft -= take;
      if (audioLeft === 0) metaExpect = 0;
    }
  };
}
function radioProxy(req, res, station) {
  const headers = { 'Icy-MetaData': '1', 'User-Agent': 'escucharrr/0.1', 'Accept': '*/*' };
  httpGetStream(station.url, headers, (upRes, upReq) => {
    if (upRes.statusCode >= 400) { res.writeHead(502); return res.end('upstream ' + upRes.statusCode); }
    const metaint = parseInt(upRes.headers['icy-metaint'], 10) || 0;
    const ctype = upRes.headers['content-type'] || 'audio/mpeg';
    res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'no-cache', 'Connection': 'close' });
    const cur = _radioNow.get(station.id);
    _radioNow.set(station.id, { name: station.name, title: cur ? cur.title : '' });
    const setTitle = t => { _radioNow.set(station.id, { name: station.name, title: t }); sseBroadcast('radio'); };
    if (metaint > 0) { const parse = makeIcyParser(metaint, buf => { try { res.write(buf); } catch (e) {} }, setTitle); upRes.on('data', c => { try { parse(c); } catch (e) {} }); }
    else upRes.pipe(res, { end: false });
    upRes.on('end', () => { try { res.end(); } catch (e) {} });
    upRes.on('error', () => { try { res.end(); } catch (e) {} });
    const cleanup = () => { try { upReq.destroy(); } catch (e) {} };
    req.on('close', cleanup); res.on('close', cleanup);
  }, err => { if (!res.headersSent) res.writeHead(502); try { res.end('error: ' + err.message); } catch (e) {} });
}
async function handleRadio(req, res, u) {
  const sub = u.pathname.slice('/api/radio/'.length);
  try {
    if (req.method === 'GET' && sub === 'stations') return sendJSON(res, { ok: true, stations: Q.radioList.all(), now: radioInfo() });
    if (req.method === 'GET' && sub === 'stream') { const st = Q.radioGet.get(parseInt(u.searchParams.get('id'), 10)); if (!st) { res.writeHead(404); return res.end('{}'); } return radioProxy(req, res, st); }
    if (req.method === 'GET' && sub === 'nowplaying') { const id = parseInt(u.searchParams.get('id'), 10); const v = _radioNow.get(id); return sendJSON(res, { ok: true, title: v ? v.title : '', name: v ? v.name : '' }); }
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (sub === 'station') { const name = String(body.name || '').trim().slice(0, 120); const url = String(body.url || '').trim(); if (!name || !/^https?:\/\//i.test(url)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'Nombre y URL http(s) obligatorios' })); } const r = Q.radioAdd.run(name, url, String(body.homepage || '').trim() || null, String(body.favicon || '').trim() || null); return sendJSON(res, { ok: true, id: Number(r.lastInsertRowid), stations: Q.radioList.all() }); }
    if (sub === 'station/delete') { const id = parseInt(body.id, 10); Q.radioDelete.run(id); _radioNow.delete(id); return sendJSON(res, { ok: true, stations: Q.radioList.all() }); }
    // pulgar abajo de la Radio: marca la grabación como bad_for_radio para que el motor la excluya (body.on===false la rehabilita)
    if (sub === 'thumbdown') { const rid = parseInt(body.recording_id, 10); if (!rid) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'recording_id obligatorio' })); } if (body.on === false) Q.edDelFlag.run('recording', rid, 'bad_for_radio'); else Q.edSetFlag.run('recording', rid, 'bad_for_radio'); return sendJSON(res, { ok: true, bad: body.on !== false }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── HISTORIAL DE ESCUCHA (reproducciones cronológicas, estilo "History" de Roon) ──
function history(limit, offset) {
  limit = Math.min(Math.max(1, limit || 50), 200); offset = Math.max(0, offset || 0);
  const rows = Q.historyList.all(limit, offset);
  for (const r of rows) { if (r.album_id) { const t = Q.rgTitle.get(r.album_id); r.album = t ? t.title : null; } }
  return { total: Q.historyCount.get().n, plays: rows, limit, offset };
}

// ── COPIA DE SEGURIDAD (estilo "Backup" de Roon): snapshot de la BD con VACUUM INTO, ──
// conserva las últimas N, restaura reabriendo la conexión en vivo (db/Q son re-asignables).
const _BK = path.join(__dirname, 'backups');
const BACKUP_KEEP = 12;
function ensureBackupDir() { try { if (!fs.existsSync(_BK)) fs.mkdirSync(_BK, { recursive: true }); } catch (e) {} }
function listBackups() {
  ensureBackupDir();
  try { return fs.readdirSync(_BK).filter(f => /\.db$/i.test(f)).map(f => { let st = {}; try { st = fs.statSync(path.join(_BK, f)); } catch (e) {} return { file: f, size: st.size || 0, mtime: st.mtimeMs || 0 }; }).sort((a, b) => b.mtime - a.mtime); } catch (e) { return []; }
}
function pruneBackups() { for (const b of listBackups().slice(BACKUP_KEEP)) { try { fs.unlinkSync(path.join(_BK, b.file)); } catch (e) {} } }
function backupNow() {
  ensureBackupDir();
  const ts = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
  const name = 'escucharrr-' + ts + '.db';
  const dest = path.join(_BK, name).replace(/\\/g, '/');
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);   // snapshot consistente de la BD abierta
  pruneBackups();
  return { file: name };
}
function backupPath(file) { const base = path.basename(String(file || '')); const p = path.join(_BK, base); return (base && /\.db$/i.test(base) && fs.existsSync(p)) ? p : ''; }
function restoreBackup(file) {
  const src = backupPath(file); if (!src) throw new Error('copia no encontrada');
  try { backupNow(); } catch (e) {}                         // red de seguridad: copia del estado actual antes de restaurar
  try { stopWatching(); } catch (e) {}
  try { db.close(); } catch (e) {}
  for (const ext of ['', '-wal', '-shm']) { try { if (fs.existsSync(DB_PATH + ext)) fs.unlinkSync(DB_PATH + ext); } catch (e) {} }
  fs.copyFileSync(src, DB_PATH);
  db = new DatabaseSync(DB_PATH); initAppSchema(db); Q = buildQ(db);   // reabre en vivo y re-prepara las sentencias
  try { startWatching(); } catch (e) {}
  sseBroadcast('library');
}
function autoBackupIfStale() {   // "programado": una copia al arrancar si la más reciente tiene > 20 h
  try { const l = listBackups(); const last = l[0] ? l[0].mtime : 0; if (Date.now() - last > 20 * 3600 * 1000) { backupNow(); console.log('copia de seguridad automática creada'); } } catch (e) {}
}
async function handleBackup(req, res, u) {
  const sub = u.pathname.slice('/api/backup/'.length);
  try {
    if (req.method === 'GET' && sub === 'list') return sendJSON(res, { ok: true, backups: listBackups(), keep: BACKUP_KEEP });
    if (req.method === 'GET' && sub === 'download') { const p = backupPath(u.searchParams.get('f')); if (!p) { res.writeHead(404); return res.end('{}'); } const b = fs.readFileSync(p); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + path.basename(p) + '"', 'Content-Length': b.length }); return res.end(b); }
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (sub === 'now') { const r = backupNow(); return sendJSON(res, { ok: true, ...r, backups: listBackups() }); }
    if (sub === 'restore') { restoreBackup(body.file); return sendJSON(res, { ok: true, restored: body.file, backups: listBackups() }); }
    if (sub === 'delete') { const p = backupPath(body.file); if (p) { try { fs.unlinkSync(p); } catch (e) {} } return sendJSON(res, { ok: true, backups: listBackups() }); }
    res.writeHead(404); res.end('{}');
  } catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── EDICIÓN/CORRECCIÓN de metadatos (el valor de USUARIO gana sobre el externo, estilo "prefer" de Roon) ──
const EDIT_SUBJECTS = new Set(['release_group', 'artist', 'track', 'recording']);
const EDIT_TEXT_FIELDS = new Set(['about', 'bio']);
function handleEditSync(body) {
  const st = String(body.subject_type || '');
  const sid = parseInt(body.subject_id, 10);
  const field = String(body.field || '');
  if (!EDIT_SUBJECTS.has(st) || !sid) throw new Error('sujeto inválido');
  if (field === 'tier') {
    const v = (body.value == null || body.value === '') ? null : String(body.value);
    if (v) { if (!Q.tierKeys.all().some(t => t.key === v)) throw new Error('tier inválido'); Q.edSetTier.run(st, sid, v); Q.edEvent.run(st, sid, 'tier', v); Q.edSetProv.run(st, sid, 'tier'); }
    else { Q.edDelTier.run(st, sid); Q.edDelProv.run(st, sid, 'tier'); }
    return { field, value: v };
  }
  if (field === 'stars') {
    const n = Number(body.value);
    const v = (body.value == null || body.value === '' || n <= 0 || Number.isNaN(n)) ? null : Math.min(5, n);   // 0/vacío = quitar valoración
    if (v == null) { Q.edDelStars.run(st, sid); Q.edDelProv.run(st, sid, 'stars'); }
    else { Q.edSetStars.run(st, sid, v); Q.edEvent.run(st, sid, 'stars', String(v)); Q.edSetProv.run(st, sid, 'stars'); }
    return { field, value: v };
  }
  if (field === 'favorite' || field === 'listen_later' || field === 'hidden') {
    const on = !!body.value;
    if (on) Q.edSetFlag.run(st, sid, field); else Q.edDelFlag.run(st, sid, field);
    return { field, value: on };
  }
  if (field === 'title') {   // renombrar álbum: override en user_edit (v_album.title lo prioriza); rg.title queda intacto para que el reescaneo no duplique
    if (st !== 'release_group') throw new Error('solo se puede editar el título de un álbum');
    const v = body.value == null ? '' : String(body.value).trim();
    if (v === '') { Q.edDelUserEdit.run(st, sid, 'title'); Q.edDelProv.run(st, sid, 'title'); return { field, value: null }; }
    Q.edSetUserEdit.run(st, sid, 'title', v); Q.edSetProv.run(st, sid, 'title');
    return { field, value: v };
  }
  if (field === 'album_artist') {   // corregir el artista del álbum (p. ej. mal etiquetado como «download»): override en user_edit (v_album.artist lo prioriza); los tags del fichero no se tocan, estilo Roon
    if (st !== 'release_group') throw new Error('solo se puede editar el artista de un álbum');
    const v = body.value == null ? '' : String(body.value).trim();
    if (v === '') { Q.edDelUserEdit.run(st, sid, 'album_artist'); Q.edDelProv.run(st, sid, 'album_artist'); return { field, value: null }; }
    Q.edSetUserEdit.run(st, sid, 'album_artist', v); Q.edSetProv.run(st, sid, 'album_artist');
    return { field, value: v };
  }
  if (EDIT_TEXT_FIELDS.has(field)) {
    const v = body.value == null ? '' : String(body.value);
    if (v.trim() === '') { Q.edDelUserEdit.run(st, sid, field); Q.edDelProv.run(st, sid, field); return { field, value: null }; }
    Q.edSetUserEdit.run(st, sid, field, v); Q.edSetProv.run(st, sid, field);
    return { field, value: v };
  }
  if (field === 'cover_pref') {   // fuente de portada: auto/file/download/none (Roon: use_best/use_file/use_meta/clear)
    const v = String(body.value || 'auto');
    if (!['auto', 'file', 'download', 'none'].includes(v)) throw new Error('preferencia de portada inválida');
    if (v === 'auto') Q.edDelUserEdit.run(st, sid, 'cover_pref'); else Q.edSetUserEdit.run(st, sid, 'cover_pref', v);
    return { field, value: v };
  }
  throw new Error('campo no editable');
}
async function handleEdit(req, res) {
  try { const r = handleEditSync(await readBody(req)); sseBroadcast('library'); return sendJSON(res, { ok: true, ...r }); }
  catch (e) { sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── IDENTIFICAR un álbum sin MBID (wizard estilo Roon) ──────────────────────────
// GET  /api/identify?rg=ID         → candidatos de MusicBrainz puntuados por duración (red, ~1,1 s/candidato)
// POST /api/identify/apply {rg, release_mbid, enrich?} → fija el MBID (y, opcional, encadena enrich --rg)
async function handleIdentifySuggest(req, res, u) {
  try {
    const rg = parseInt(u.searchParams.get('rg'), 10);
    if (!rg) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'falta rg' })); }
    const r = await identifyAlbum.suggest(db, rg);
    return sendJSON(res, { ok: true, profile: r.profile, candidates: r.candidates });
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}
async function handleIdentifyApply(req, res) {
  try {
    const b = await readBody(req);
    const rg = parseInt(b.rg, 10);
    const mbid = String(b.release_mbid || '').trim();
    if (!rg || !/^[0-9a-f-]{36}$/i.test(mbid)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'rg o release_mbid inválido' })); }
    const r = await identifyAlbum.applyMbid(db, rg, mbid);
    sseBroadcast('library');
    // Como Roon, identificar debería traer también los metadatos: encadena enrich SOLO de este álbum
    // (proceso aparte, como el watcher; WAL + busy_timeout sostienen al escritor extra). Fire-and-forget.
    if (b.enrich !== false) {
      _spawnIngest([path.join(_DL, 'enrich.js'), '--db', DB_PATH, '--rg', String(rg)])
        .then((out) => { if (out) console.log('  [identify] enrich rg', rg, '→', out); sseBroadcast('library'); })
        .catch(() => {});
    }
    // …y la portada de Cover Art Archive de ese disco (antes solo se bajaba en un paso aparte).
    _spawnIngest([path.join(_DL, 'covers.js'), '--db', DB_PATH, '--rg', String(rg)])
      .then((out) => { if (out) console.log('  [identify] portada rg', rg, '→', out); sseBroadcast('library'); })
      .catch(() => {});
    return sendJSON(res, { ok: true, releaseMbid: r.releaseMbid, rgMbid: r.rgMbid, enriching: b.enrich !== false });
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── REANALIZAR un álbum desde la UI (estilo Roon edit_album_reanalyze) ───────────
// POST /api/album/reanalyze {rg} → recalcula loudness/ReplayGain (analyze.js) y la barra
// de onda (waveform.js) SOLO de ese disco, con --force, en procesos aparte (WAL + busy_timeout
// sostienen al escritor extra). Fire-and-forget: responde al momento y avisa por SSE al terminar.
async function handleReanalyze(req, res) {
  try {
    const b = await readBody(req);
    const rg = parseInt(b.rg, 10);
    if (!rg) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'falta rg' })); }
    if (_reanalyzing.has(rg)) return sendJSON(res, { ok: true, running: true, already: true });
    _reanalyzing.add(rg);
    sseBroadcast('library');   // refleja el estado «analizando» en la ficha al instante
    (async () => {
      try {
        const lo = await _spawnIngest([path.join(_DL, 'analyze.js'), '--db', DB_PATH, '--rg', String(rg), '--force']);
        if (lo) console.log('  [reanalyze] loudness rg', rg, '→', lo);
        const wf = await _spawnIngest([path.join(_DL, 'waveform.js'), '--db', DB_PATH, '--rg', String(rg), '--force']);
        if (wf) console.log('  [reanalyze] waveform rg', rg, '→', wf);
      } catch (e) { console.log('  [reanalyze] error rg', rg, String(e.message)); }
      finally { _reanalyzing.delete(rg); sseBroadcast('library'); }
    })();
    return sendJSON(res, { ok: true, running: true });
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
}

// ── Guardar la reseña/bio DE VUELTA en la nota de Obsidian (son .md) ──────────────
// Preserva el frontmatter tal cual y reemplaza solo el cuerpo; escritura atómica
// (fichero temporal + rename) dentro del vault; espeja el estado en la BD como hace el sync.
function sanitizeName(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180); }
function splitFrontmatter(text) {   // devuelve {head: bloque --- crudo con su salto, fm: objeto}
  if (!text.startsWith('---')) return { head: '', fm: {} };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { head: '', fm: {} };
  const block = text.slice(3, end);
  const head = text.slice(0, end + 4) + '\n';   // incluye el cierre ---
  const fm = {};
  for (const line of block.split(/\r?\n/)) { const m = line.match(/^\s*([^:#][^:]*?)\s*:\s*(.*)$/); if (m) fm[m[1].trim().toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, ''); }
  return { head, fm };
}
async function writeObsidianNote(subjectType, subjectId, field, value) {
  if (!['release_group', 'artist'].includes(subjectType) || !subjectId) throw new Error('sujeto inválido');
  const text = String(value == null ? '' : value);
  if (!text.trim()) throw new Error('escribe algo antes de guardarlo en la nota');
  const c = watchConfig();
  if (!c || !c.vault || !fs.existsSync(c.vault)) throw new Error('Obsidian no está configurado (añade el vault en Ajustes)');
  const vault = c.vault;
  const existing = Q.noteForSubject.get(subjectType, subjectId);
  let relPath, absPath, created = false;
  if (existing && existing.path) {
    relPath = existing.path;
    absPath = path.join(vault, relPath);
  } else {                                           // crear nota nueva
    let fname;
    if (subjectType === 'release_group') { const a = Q.albumName.get(subjectId); if (!a) throw new Error('álbum no encontrado'); fname = sanitizeName((a.artist ? a.artist + ' - ' : '') + a.title) + '.md'; }
    else { const a = Q.artistName.get(subjectId); if (!a) throw new Error('artista no encontrado'); fname = sanitizeName(a.name) + '.md'; }
    const af = (c.obs && c.obs.albumsFolder && fs.existsSync(path.join(vault, c.obs.albumsFolder))) ? c.obs.albumsFolder : '';
    relPath = af ? path.join(af, fname) : fname;
    absPath = path.join(vault, relPath);
    created = true;
  }
  // guard: dentro del vault y .md
  const rp = path.resolve(absPath);
  if (!rp.startsWith(path.resolve(vault) + path.sep) || !/\.md$/i.test(rp)) throw new Error('ruta de nota inválida');
  // construir contenido: conservar frontmatter existente; si es nueva, frontmatter mínimo para re-emparejar
  let head = '';
  if (fs.existsSync(absPath)) { head = splitFrontmatter(fs.readFileSync(absPath, 'utf8')).head; }
  else if (subjectType === 'release_group') { const a = Q.albumName.get(subjectId); head = `---\nartist: ${a.artist || ''}\nalbum: ${a.title || ''}\n---\n\n`; }
  const content = head + text + '\n';
  // Escritura directa con reintentos. En vaults de OneDrive el rename sobre un fichero existente
  // falla (EPERM: el fichero está bloqueado mientras se sincroniza) y dejaría temporales huérfanos;
  // la escritura directa in-place sí funciona, y reintentamos ante bloqueos transitorios.
  try { fs.mkdirSync(path.dirname(absPath), { recursive: true }); } catch (e) {}
  let werr = null;
  for (let i = 0; i < 4; i++) {
    try { fs.writeFileSync(absPath, content, 'utf8'); werr = null; break; }
    catch (e) { werr = e; if (!/EPERM|EBUSY|EACCES/i.test(e.code || '')) throw e; await new Promise(r => setTimeout(r, 250)); }
  }
  if (werr) throw new Error('no se pudo escribir la nota (¿bloqueada por OneDrive?): ' + werr.message);
  markSelfWrite(relPath);   // que el watcher no dispare un re-sync completo por nuestra propia escritura
  // espejar estado en la BD (como el sync): nota + enlace + about/bio con procedencia obsidian
  const fm = splitFrontmatter(content).fm;
  const noteId = Number(Q.noteUpsert.get(c.obs ? (c.obs.vault || vault) : vault, relPath, String(fs.statSync(absPath).mtimeMs), JSON.stringify(fm), text).id);
  Q.noteLink.run(noteId, subjectType, subjectId);
  Q.edSetUserEdit.run(subjectType, subjectId, field, text);
  Q.edSetProvObs.run(subjectType, subjectId, field, relPath);
  return { ok: true, path: relPath, created };
}
async function handleObsidianWrite(req, res) {
  try {
    const b = await readBody(req);
    const r = await writeObsidianNote(String(b.subject_type || ''), parseInt(b.subject_id, 10), String(b.field || 'about'), b.value);
    sseBroadcast('library');
    return sendJSON(res, r);
  } catch (e) { return sendJSON(res, { ok: false, error: String(e.message) }); }
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
  if (u.pathname.startsWith('/api/lastfm/')) return void handleLastfm(req, res, u);
  if (u.pathname.startsWith('/api/liderarrr/')) return void handleLiderarrr(req, res, u);
  if (u.pathname === '/api/config' || u.pathname.startsWith('/api/config/')) return void handleConfig(req, res, u);
  if (u.pathname.startsWith('/api/dsp/')) return void handleDsp(req, res, u);
  if (u.pathname.startsWith('/api/radio/')) return void handleRadio(req, res, u);
  if (u.pathname.startsWith('/api/backup/')) return void handleBackup(req, res, u);
  if (u.pathname === '/api/history') return sendJSON(res, history(parseInt(u.searchParams.get('n'), 10), parseInt(u.searchParams.get('offset'), 10)));
  if (req.method === 'POST' && u.pathname === '/api/edit') return void handleEdit(req, res);
  if (req.method === 'POST' && u.pathname === '/api/album/make-primary') return void (async () => {
    try {
      const b = await readBody(req); const rg = parseInt(b.rg, 10), rel = parseInt(b.rel, 10);
      if (!rg || !rel) throw new Error('rg/rel requeridos');
      if (!Q.releasesOfRg.all(rg).some(r => r.id === rel)) throw new Error('esa copia no pertenece a este álbum');
      Q.edSetUserEdit.run('release_group', rg, 'primary_release', String(rel));   // la copia primaria la elige el usuario (gana sobre la heurística)
      sseBroadcast('library'); return sendJSON(res, { ok: true, release_id: rel });
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
  })();
  if (req.method === 'POST' && u.pathname === '/api/obsidian/write') return void handleObsidianWrite(req, res);
  if (u.pathname.startsWith('/api/scrobble/')) return void handleScrobble(req, res, u);
  if (u.pathname === '/api/lyrics') return void getLyrics(parseInt(u.searchParams.get('track'), 10)).then(r => sendJSON(res, r)).catch(() => sendJSON(res, { found: false }));
  if (u.pathname === '/api/identify' && req.method === 'GET') return void handleIdentifySuggest(req, res, u);
  if (u.pathname === '/api/identify/apply' && req.method === 'POST') return void handleIdentifyApply(req, res);
  if (u.pathname === '/api/artist/merge' && req.method === 'POST') return void handleArtistMerge(req, res);
  if (u.pathname === '/api/artist/edit' && req.method === 'POST') return void handleArtistEdit(req, res);
  if (u.pathname === '/api/artist/editorial' && req.method === 'GET') return void handleArtistEditorial(req, res, u);
  if (u.pathname === '/api/artist/search' && req.method === 'GET') { const id = parseInt(u.searchParams.get('id'), 10) || 0; const q = (u.searchParams.get('q') || '').trim(); if (q.length < 2) return sendJSON(res, { ok: true, items: [] }); return sendJSON(res, { ok: true, items: Q.artistSearch.all(id, '%' + q + '%', q).map(a => ({ id: a.id, name: a.name, disambiguation: a.disambiguation, album_count: (Q.artistAlbumCount.get(a.id) || {}).n || 0 })) }); }
  if (u.pathname === '/api/album/reanalyze' && req.method === 'POST') return void handleReanalyze(req, res);
  if (u.pathname === '/api/reveal' && req.method === 'POST') return void handleReveal(req, res);   // abrir carpeta en el Explorador del SO
  if (u.pathname === '/api/playlists' || u.pathname === '/api/playlist' || u.pathname.startsWith('/api/playlist/')) return void handlePlaylists(req, res, u);
  if (u.pathname === '/api/smartlists' || u.pathname === '/api/smartlist' || u.pathname.startsWith('/api/smartlist/')) return void handleSmart(req, res, u);
  try {
    if (u.pathname === '/api/stream') return streamAudio(req, res, parseInt(u.searchParams.get('track'), 10));
    if (u.pathname === '/api/cover') return serveCover(res, parseInt(u.searchParams.get('rg'), 10));
    if (u.pathname === '/api/album/similar') return void handleAlbumSimilar(req, res, u);
    if (u.pathname === '/api/album/acoustid') return void handleAlbumAcoustid(req, res, u);
    if (u.pathname === '/api/covers/backfill') {   // descarga de CAA todas las portadas que falten (una sola instancia)
      if (req.method === 'POST') { const started = spawnCoversBackfill('manual'); return sendJSON(res, { ok: true, started, running: _coversBackfillRunning }); }
      const pending = db.prepare(`SELECT COUNT(*) n FROM release_group rg WHERE rg.mbid IS NOT NULL AND rg.cover_path IS NULL AND NOT EXISTS(SELECT 1 FROM provenance p WHERE p.subject_type='release_group' AND p.subject_id=rg.id AND p.field='cover')`).get().n;
      const cached = db.prepare('SELECT COUNT(*) n FROM release_group WHERE cover_path IS NOT NULL').get().n;
      return sendJSON(res, { ok: true, running: _coversBackfillRunning, pending, cached });
    }
    if (u.pathname === '/api/peaks') { const pk = peaksOf(parseInt(u.searchParams.get('track'), 10)); return pk ? sendJSON(res, { peaks: pk }) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/trackinfo') {   // espec técnico + loudness de la pista (ruta de señal / nerd stats)
      const t = parseInt(u.searchParams.get('track'), 10);
      const cols = 'format, bit_depth, sample_rate, channels, loudness_lufs, gain_db, peak_dbfs, album_gain_db, album_peak_dbfs, size_bytes, duration_ms';
      let r = t ? db.prepare(`SELECT ${cols} FROM local_file WHERE track_id=? LIMIT 1`).get(t) : null;
      if (!r && t) r = db.prepare(`SELECT ${cols} FROM local_file WHERE recording_id=(SELECT recording_id FROM track WHERE id=?) LIMIT 1`).get(t);
      return sendJSON(res, r || {});
    }
    if (u.pathname === '/api/settings') return sendJSON(res, settingsInfo());
    if (u.pathname === '/api/library') return sendJSON(res, libraryList());
    if (u.pathname === '/api/tracks') return sendJSON(res, tracksList({ q: u.searchParams.get('q'), sort: u.searchParams.get('sort'), dir: u.searchParams.get('dir'), offset: u.searchParams.get('offset'), limit: u.searchParams.get('limit'), format: u.searchParams.get('format'), bitdepth: u.searchParams.get('bitdepth'), samplerate: u.searchParams.get('samplerate'), channels: u.searchParams.get('channels') }));
    if (u.pathname === '/api/tracks/facets') return sendJSON(res, trackFacets());
    if (u.pathname === '/api/folders') return sendJSON(res, folderList({ root: u.searchParams.get('root'), path: u.searchParams.get('path') }));
    if (u.pathname === '/api/works') return sendJSON(res, { items: db.prepare(`SELECT w.id, w.title, w.type, (SELECT group_concat(DISTINCT a.name) FROM credit c JOIN artist a ON a.id=c.artist_id WHERE c.entity_type='work' AND c.entity_id=w.id AND c.role='composición') composer, (SELECT COUNT(DISTINCT tr.id) FROM recording r JOIN track tr ON tr.recording_id=r.id WHERE r.work_id=w.id) perf FROM work w ORDER BY w.title`).all() });
    if (u.pathname === '/api/skipped') { let total = 0, items = []; try { total = db.prepare('SELECT COUNT(*) n FROM skipped_file').get().n; items = db.prepare('SELECT path, reason FROM skipped_file ORDER BY path LIMIT 500').all(); } catch (e) {} return sendJSON(res, { total, items }); }
    if (u.pathname === '/api/album') { const rel = parseInt(u.searchParams.get('rel'), 10) || null; const a = album(parseInt(u.searchParams.get('id'), 10), rel); return a ? sendJSON(res, a) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/search') return sendJSON(res, search(u.searchParams.get('q'), Math.min(parseInt(u.searchParams.get('n') || '20', 10) || 20, 100)));
    if (u.pathname === '/api/artist') { const a = artist(parseInt(u.searchParams.get('id'), 10)); return a ? sendJSON(res, a) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/artist/discography') { artistDiscography(parseInt(u.searchParams.get('id'), 10)).then(r => sendJSON(res, r)).catch(e => sendJSON(res, { ok: false, error: String(e.message) })); return; }
    if (u.pathname === '/api/work') { const w = work(parseInt(u.searchParams.get('id'), 10)); return w ? sendJSON(res, w) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/genre') { const g = genre(u.searchParams.get('name')); return g ? sendJSON(res, g) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/genres') return sendJSON(res, gmAgg(Q.allGenres.all()));
    if (u.pathname === '/api/genres/tiles') return sendJSON(res, { tiles: genreTiles(parseInt(u.searchParams.get('limit'), 10) || 30) });
    if (u.pathname === '/api/genremap') return void handleGenreMap(req, res, u);
    if (u.pathname === '/api/bookmarks') return sendJSON(res, { items: Q.bmList.all().map(b => ({ id: b.id, name: b.name, state: (() => { try { return JSON.parse(b.state || '{}'); } catch (e) { return {}; } })() })) });
    if (u.pathname === '/api/tags') return sendJSON(res, Q.allTags.all());
    if (u.pathname === '/api/tag') { const name = u.searchParams.get('name'); const albums = Q.tagAlbums.all(name); return albums.length ? sendJSON(res, { name, albums }) : (res.writeHead(404), res.end('{}')); }
    if (u.pathname === '/api/discover') return sendJSON(res, discover({ day: u.searchParams.get('day'), notRecentDays: u.searchParams.get('nrdays') }));
    if (u.pathname === '/api/radio') { const seed = parseInt(u.searchParams.get('seed'), 10); const ex = (u.searchParams.get('exclude') || '').split(',').map(x => parseInt(x, 10)).filter(Boolean); return sendJSON(res, { tracks: seed ? radio(seed, ex, u.searchParams.get('n')) : [] }); }
    if (u.pathname === '/api/mix') { const al = parseInt(u.searchParams.get('album'), 10), ar = parseInt(u.searchParams.get('artist'), 10), tr = parseInt(u.searchParams.get('track'), 10), nn = u.searchParams.get('n'); const kind = al ? 'album' : ar ? 'artist' : tr ? 'track' : null; const kid = al || ar || tr; return sendJSON(res, { tracks: kind ? mix(kind, kid, nn) : [] }); }
    if (u.pathname === '/api/home') return sendJSON(res, home());
    if (u.pathname === '/api/inspector') { const bk = u.searchParams.get('bucket'); return sendJSON(res, bk ? inspectorBucket(bk, u.searchParams.get('limit'), u.searchParams.get('offset')) : inspectorCounts()); }
    // SPA: una navegación a cualquier .html sirve el shell persistente (app.html); el router pide
    // el contenido real con ?__frag=1 (→ fichero raw). Así el reproductor nunca se recarga.
    const isFrag = u.searchParams.get('__frag') === '1';
    if (!isFrag && (u.pathname === '/' || u.pathname === '' || (/\.html$/.test(u.pathname) && u.pathname !== '/app.html'))) return sendFile(res, 'app.html');
    if (u.pathname === '/' || u.pathname === '') return sendFile(res, 'index.html');
    return sendFile(res, u.pathname.replace(/^\//, ''));
  } catch (e) { res.writeHead(500); res.end(String(e.message)); }
}).listen(PORT, () => {
  console.log('escucharrr en http://localhost:' + PORT);
  console.log('ffmpeg:', FFMPEG ? ('disponible (' + FFMPEG + ')') : 'NO encontrado — DSD/transcode desactivados (define ESC_FFMPEG o pon ffmpeg en el PATH)');
  maybeOpenBrowser();
  startWatching();
  autoBackupIfStale();   // copia de seguridad "programada": una al arrancar si la última es antigua
  const svc = scrobble.enabledServices(scrobCfg || {});
  if (svc.length) { console.log('scrobbling activo:', svc.join(', ')); setInterval(() => scrobble.drain(db, scrobCfg, console.log).catch(() => {}), 30000); }
  else console.log('scrobbling: desactivado (crea app/scrobble.json a partir de scrobble.example.json)');
});
