'use strict';
// escucharrr — comparar la biblioteca LOCAL con la biblioteca de Spotify del usuario.
// NO reproduce nada: usa la Web API (scope user-library-read) para traer tus "álbumes
// guardados" y marcar qué discos locales ya tienes en Spotify. Sin dependencias (node:https).
//
// Requiere una app propia en developer.spotify.com (clientId/secret) y el OK del usuario
// (OAuth Authorization Code). El token se guarda en app/.spotify-token (gitignored).

const https = require('node:https');
const { URLSearchParams } = require('node:url');

const AUTH = 'accounts.spotify.com';
const API = 'api.spotify.com';
const SCOPE = 'user-library-read';

function req(host, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const r = https.request({ host, path, method, headers }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (e) {} resolve({ status: res.statusCode, json: j, body: b }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, body: '' }));
    r.setTimeout(20000, () => r.destroy());
    if (body) r.write(body);
    r.end();
  });
}

// ── OAuth (Authorization Code) ──
function authorizeUrl(cfg, state) {
  const p = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, scope: SCOPE, redirect_uri: cfg.redirectUri, state: state || '' });
  return 'https://' + AUTH + '/authorize?' + p.toString();
}
function basic(cfg) { return 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64'); }
async function exchangeCode(cfg, code) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }).toString();
  const r = await req(AUTH, '/api/token', { method: 'POST', headers: { 'Authorization': basic(cfg), 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body });
  if (r.status !== 200 || !r.json) throw new Error('intercambio de código falló (' + r.status + ')');
  return { access_token: r.json.access_token, refresh_token: r.json.refresh_token, expires_in: r.json.expires_in, obtained_at: Math.floor(Date.now() / 1000) };
}
async function refresh(cfg, refreshToken) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString();
  const r = await req(AUTH, '/api/token', { method: 'POST', headers: { 'Authorization': basic(cfg), 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body });
  if (r.status !== 200 || !r.json) throw new Error('refresh del token falló (' + r.status + ')');
  return { access_token: r.json.access_token, expires_in: r.json.expires_in, refresh_token: r.json.refresh_token || refreshToken, obtained_at: Math.floor(Date.now() / 1000) };
}
function expired(tok) { return !tok || !tok.obtained_at || (Date.now() / 1000) > (tok.obtained_at + (tok.expires_in || 3600) - 60); }

// ── biblioteca guardada del usuario (paginada) ──
async function fetchSavedAlbums(accessToken, onProgress) {
  const out = [];
  let path = '/v1/me/albums?limit=50';
  while (path) {
    const r = await req(API, path, { headers: { 'Authorization': 'Bearer ' + accessToken } });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1500)); continue; }   // rate limit
    if (r.status !== 200 || !r.json) throw new Error('GET me/albums falló (' + r.status + ')');
    for (const it of (r.json.items || [])) {
      const al = it.album || {};
      out.push({ id: al.id, name: al.name, artists: (al.artists || []).map(a => a.name), artist: (al.artists && al.artists[0] && al.artists[0].name) || '', upc: al.external_ids && al.external_ids.upc, url: al.external_urls && al.external_urls.spotify });
    }
    if (onProgress) onProgress(out.length, r.json.total || 0);
    const next = r.json.next;                                 // URL absoluta o null
    path = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
  }
  return out;
}

// ── emparejado local ↔ Spotify ──
function norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')          // quita diacríticos
    .replace(/\(.*?\)|\[.*?\]/g, ' ')                          // quita (...) y [...]
    .replace(/\b(remaster(ed)?|deluxe|edition|edición|expanded|anniversary|mono|stereo|bonus|version|versión)\b.*$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function artistKey(name) {
  return norm(name).replace(/^(the|los|las|el|la)\s+/, '');     // ignora el artículo inicial
}
function keyOf(artist, title) { return artistKey(artist) + '|' + norm(title); }

// índice de los álbumes guardados por clave artista|título (y por UPC)
function indexSaved(saved) {
  const byKey = new Map(), byUpc = new Map();
  for (const s of saved) {
    for (const a of (s.artists && s.artists.length ? s.artists : [s.artist])) { const k = keyOf(a, s.name); if (!byKey.has(k)) byKey.set(k, s); }
    if (s.upc) byUpc.set(String(s.upc).replace(/^0+/, ''), s);
  }
  return { byKey, byUpc };
}
// Empareja filas locales {id, title, artist, barcode?} → [{id, spotify_album_id, spotify_url}]
function matchLocal(localRows, saved) {
  const idx = indexSaved(saved);
  return localRows.map(r => {
    let m = null;
    if (r.barcode) m = idx.byUpc.get(String(r.barcode).replace(/^0+/, '')) || null;
    if (!m) m = idx.byKey.get(keyOf(r.artist, r.title)) || null;
    return { id: r.id, spotify_album_id: m ? m.id : null, spotify_url: m ? (m.url || null) : null };
  });
}

module.exports = { authorizeUrl, exchangeCode, refresh, expired, fetchSavedAlbums, matchLocal, indexSaved, keyOf, norm, SCOPE };
