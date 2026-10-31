'use strict';
// escucharrr — scrobbling local-first a Last.fm y ListenBrainz.
//
// La escucha que supera el umbral se encola en `scrobble_queue` (instantánea de
// metadata) y un drenador la envía a cada servicio configurado con reintentos y
// backoff, tolerando estar sin conexión. Sin claves, no hace nada. Sin paquetes
// externos (node:https + node:crypto). Las URLs base son sobreescribibles por
// config (cfg.*.url) para poder probar contra un stub local.
//
// ListenBrainz: token de usuario (Authorization: Token ...), sin OAuth.
// Last.fm: api_key + secret + session key (se obtiene con scrobble-auth.js),
//          cada llamada firmada md5(params ordenados + secret).

const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const LBZ_URL = 'https://api.listenbrainz.org';
const LFM_URL = 'https://ws.audioscrobbler.com/2.0/';
const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

// Firma de Last.fm: md5 de la concatenación de nombre+valor de los parámetros
// ordenados alfabéticamente (excepto `format` y `callback`) + el secreto.
function lastfmSig(params, secret) {
  const keys = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort();
  return md5(keys.map(k => k + params[k]).join('') + secret);
}

// POST genérico; devuelve { status, body }. form=true -> x-www-form-urlencoded.
function post(url, { headers = {}, body = '', form = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const data = form ? new URLSearchParams(body).toString() : body;
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

function hasLbz(cfg) { return !!(cfg && cfg.listenbrainz && cfg.listenbrainz.token); }
function hasLfm(cfg) { return !!(cfg && cfg.lastfm && cfg.lastfm.apiKey && cfg.lastfm.apiSecret && cfg.lastfm.sessionKey); }
function enabledServices(cfg) { const s = []; if (hasLbz(cfg)) s.push('listenbrainz'); if (hasLfm(cfg)) s.push('lastfm'); return s; }

// ── ListenBrainz ──
function lbzPayload(meta) {
  const ai = { submission_client: 'escucharrr' };
  if (meta.recording_mbid) ai.recording_mbid = meta.recording_mbid;
  if (meta.release_mbid) ai.release_mbid = meta.release_mbid;
  if (meta.duration_ms) ai.duration_ms = meta.duration_ms;
  const tm = { artist_name: meta.artist, track_name: meta.title, additional_info: ai };
  if (meta.album) tm.release_name = meta.album;
  return tm;
}
async function lbzSubmit(cfg, meta, type /* 'single' | 'playing_now' */) {
  const listen = { track_metadata: lbzPayload(meta) };
  if (type === 'single') listen.listened_at = meta.listened_at;
  const base = (cfg.listenbrainz.url || LBZ_URL).replace(/\/$/, '');
  const r = await post(base + '/1/submit-listens', {
    headers: { Authorization: 'Token ' + cfg.listenbrainz.token },
    body: JSON.stringify({ listen_type: type, payload: [listen] }),
  });
  if (r.status !== 200) throw new Error('ListenBrainz ' + r.status + ': ' + r.body.slice(0, 200));
  return true;
}

// ── Last.fm ──
async function lfmCall(cfg, method, extra) {
  const params = { method, api_key: cfg.lastfm.apiKey, sk: cfg.lastfm.sessionKey, ...extra };
  params.api_sig = lastfmSig(params, cfg.lastfm.apiSecret);
  params.format = 'json';
  const base = cfg.lastfm.url || LFM_URL;
  const r = await post(base, { form: true, body: params });
  let j = {}; try { j = JSON.parse(r.body); } catch (e) {}
  if (r.status !== 200 || j.error) throw new Error('Last.fm ' + (j.error || r.status) + ': ' + (j.message || r.body.slice(0, 200)));
  return j;
}
function lfmTrackParams(meta, withTs) {
  const p = { artist: meta.artist, track: meta.title };
  if (meta.album) p.album = meta.album;
  if (meta.album_artist && meta.album_artist !== meta.artist) p.albumArtist = meta.album_artist;
  if (meta.recording_mbid) p.mbid = meta.recording_mbid;
  if (meta.duration_ms) p.duration = Math.round(meta.duration_ms / 1000);
  if (withTs) p.timestamp = meta.listened_at;
  return p;
}
const lfmScrobble = (cfg, meta) => lfmCall(cfg, 'track.scrobble', lfmTrackParams(meta, true));
const lfmNowPlaying = (cfg, meta) => lfmCall(cfg, 'track.updateNowPlaying', lfmTrackParams(meta, false));

// ── "sonando ahora" (efímero, best-effort, sin cola) ──
async function nowPlaying(cfg, meta) {
  const out = {};
  if (hasLbz(cfg)) out.listenbrainz = await lbzSubmit(cfg, meta, 'playing_now').then(() => true).catch(e => e.message);
  if (hasLfm(cfg)) out.lastfm = await lfmNowPlaying(cfg, meta).then(() => true).catch(e => e.message);
  return out;
}

// ── cola ──
function enqueue(db, meta) {
  db.prepare(`INSERT INTO scrobble_queue(recording_id,track_id,artist,title,album,album_artist,recording_mbid,release_mbid,duration_ms,listened_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    meta.recording_id || null, meta.track_id || null, meta.artist, meta.title, meta.album || null,
    meta.album_artist || null, meta.recording_mbid || null, meta.release_mbid || null,
    meta.duration_ms || null, meta.listened_at);
}

function backoffMinutes(attempts) { return Math.min(60, Math.pow(2, Math.max(0, attempts))); }   // 1,2,4,…,60 min

// Drena la cola: envía a cada servicio configurado lo que aún no se ha enviado.
async function drain(db, cfg, log = () => {}) {
  const services = enabledServices(cfg);
  if (!services.length) return { enabled: false, sent: 0 };
  const lbz = hasLbz(cfg), lfm = hasLfm(cfg);
  // filas con algún servicio configurado pendiente y cuyo backoff ya venció
  const rows = db.prepare(`SELECT * FROM scrobble_queue
     WHERE ((lbz_done=0 AND ?) OR (lastfm_done=0 AND ?))
       AND (next_try IS NULL OR next_try<=datetime('now'))
     ORDER BY listened_at LIMIT 50`).all(lbz ? 1 : 0, lfm ? 1 : 0);
  let sent = 0;
  for (const row of rows) {
    const meta = row;
    let lbzDone = row.lbz_done, lfmDone = row.lastfm_done, err = null;
    if (lbz && !lbzDone) { try { await lbzSubmit(cfg, meta, 'single'); lbzDone = 1; sent++; } catch (e) { err = 'LBZ: ' + e.message; } }
    if (lfm && !lfmDone) { try { await lfmScrobble(cfg, meta); lfmDone = 1; sent++; } catch (e) { err = (err ? err + ' | ' : '') + 'LFM: ' + e.message; } }
    if (err) {
      const attempts = row.attempts + 1;
      db.prepare(`UPDATE scrobble_queue SET lbz_done=?, lastfm_done=?, attempts=?, next_try=datetime('now','+'||?||' minutes'), last_error=? WHERE id=?`)
        .run(lbzDone, lfmDone, attempts, backoffMinutes(attempts), err, row.id);
      log(`  scrobble ${row.id} reintento #${attempts} (${backoffMinutes(attempts)} min): ${err}`);
    } else {
      db.prepare('UPDATE scrobble_queue SET lbz_done=?, lastfm_done=?, last_error=NULL WHERE id=?').run(lbzDone, lfmDone, row.id);
      log(`  scrobble ${row.id} enviado a [${services.join(', ')}]: ${meta.artist} — ${meta.title}`);
    }
  }
  return { enabled: true, services, processed: rows.length, sent };
}

function pendingCount(db, cfg) {
  const lbz = hasLbz(cfg), lfm = hasLfm(cfg);
  if (!lbz && !lfm) return 0;
  return db.prepare('SELECT count(*) n FROM scrobble_queue WHERE (lbz_done=0 AND ?) OR (lastfm_done=0 AND ?)').get(lbz ? 1 : 0, lfm ? 1 : 0).n;
}

module.exports = { md5, lastfmSig, enabledServices, hasLbz, hasLfm, nowPlaying, enqueue, drain, pendingCount, lbzSubmit, lfmScrobble, lfmCall, post };
