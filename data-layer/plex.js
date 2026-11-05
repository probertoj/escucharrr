'use strict';
// Conector Plex de SOLO LECTURA: su único trabajo es leer las fechas de edición (originallyAvailableAt)
// de un Plex Media Server para que escucharrr rellene las fechas que le faltan. No reproduce, no sincroniza,
// no escribe NADA en Plex. Sin dependencias: node:http/https. El token (X-Plex-Token) lo pone el usuario.
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

function cleanUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

// GET a la API de Plex con el token. Plex devuelve JSON si pides Accept: application/json.
function plexGet(cfg, apipath) {
  return new Promise((resolve, reject) => {
    const base = cleanUrl(cfg && cfg.url);
    if (!base) return reject(new Error('Plex no configurado'));
    let u;
    try { u = new URL(base + apipath); } catch (e) { return reject(new Error('URL de Plex inválida')); }
    if (cfg && cfg.token) u.searchParams.set('X-Plex-Token', cfg.token);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Plex-Token': (cfg && cfg.token) || '' },
      // Plex local suele ir con certificado autofirmado: no abortamos por eso en una lectura a tu propia red.
      rejectUnauthorized: false,
    }, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch (e) {}
        resolve({ status: r.statusCode, body: j, raw: b });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Comprueba que la URL+token responden (y que es un Plex). GET /identity es barato y no requiere biblioteca.
async function ping(cfg) {
  const r = await plexGet(cfg, '/identity');
  return { ok: r.status >= 200 && r.status < 300, status: r.status,
    machineId: r.body && r.body.MediaContainer && r.body.MediaContainer.machineIdentifier || null };
}

// Secciones de música de la biblioteca (type === 'artist').
async function musicSections(cfg) {
  const r = await plexGet(cfg, '/library/sections');
  const dirs = (r.body && r.body.MediaContainer && r.body.MediaContainer.Directory) || [];
  return dirs.filter(d => d && d.type === 'artist').map(d => ({ key: d.key, title: d.title }));
}

// Normaliza un item de álbum de Plex (type 9) a {artist, title, date}.
function normAlbumItem(m) {
  if (!m) return null;
  const title = m.title || '';
  const artist = m.parentTitle || '';   // el artista del álbum en Plex
  if (!title || !artist) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(m.originallyAvailableAt || '') ? m.originallyAvailableAt : null;
  return { artist, title, date, year: m.year || null };
}

// Todos los álbumes (type 9) de todas las secciones de música, con su fecha de edición si Plex la tiene.
// PAGINADO (X-Plex-Container-Start/Size): una biblioteca grande puede tener decenas de miles de álbumes y
// pedirlos de golpe son muchos MB y se pasa del timeout. onProgress(cargados,total) es opcional.
async function listMusicAlbums(cfg, opts) {
  const pageSize = (opts && opts.pageSize) || 800;
  const onProgress = opts && opts.onProgress;
  const secs = await musicSections(cfg);
  const out = [];
  for (const s of secs) {
    let start = 0, total = Infinity;
    for (;;) {
      const r = await plexGet(cfg, '/library/sections/' + encodeURIComponent(s.key) +
        '/all?type=9&X-Plex-Container-Start=' + start + '&X-Plex-Container-Size=' + pageSize);
      const mc = (r.body && r.body.MediaContainer) || {};
      const items = mc.Metadata || [];
      if (mc.totalSize != null) total = mc.totalSize;
      for (const m of items) { const a = normAlbumItem(m); if (a) out.push(a); }
      start += items.length;
      if (onProgress) try { onProgress(start, total); } catch (e) {}
      if (!items.length || start >= total || start > 500000) break;
    }
  }
  return out;
}

module.exports = { cleanUrl, plexGet, ping, musicSections, listMusicAlbums, normAlbumItem };
