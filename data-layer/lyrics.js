'use strict';
// escucharrr — cliente de letras de LRCLIB (fuente abierta, sin clave).
// https://lrclib.net/docs — GET /api/get (coincidencia exacta) con fallback a /api/search.
// Devuelve { found, instrumental, plain, synced }. Sin dependencias (node:https).

const https = require('node:https');
const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';

function getJson(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(15000, () => req.destroy());
  });
}

function fromRecord(j) {
  return { found: true, instrumental: !!j.instrumental, plain: j.plainLyrics || null, synced: j.syncedLyrics || null };
}

// Busca la letra de una pista por sus metadatos. meta: {artist, title, album, duration_ms}.
async function fetchLyrics(meta) {
  const dur = Math.round((meta.duration_ms || 0) / 1000);
  // 1) coincidencia exacta (artista + título + álbum + duración)
  const q = new URLSearchParams({ artist_name: meta.artist || '', track_name: meta.title || '', album_name: meta.album || '' });
  if (dur) q.set('duration', String(dur));
  let r = await getJson('https://lrclib.net/api/get?' + q.toString());
  if (r.status === 200 && r.json && r.json.id) return fromRecord(r.json);
  // 2) búsqueda difusa por artista + título; elige por título/artista y, si hay, duración parecida
  const sq = new URLSearchParams({ track_name: meta.title || '', artist_name: meta.artist || '' });
  r = await getJson('https://lrclib.net/api/search?' + sq.toString());
  if (r.status === 200 && Array.isArray(r.json) && r.json.length) {
    const cands = r.json;
    let best = cands.find(c => dur && c.duration && Math.abs(c.duration - dur) <= 3 && (c.syncedLyrics || c.plainLyrics))
      || cands.find(c => c.syncedLyrics) || cands.find(c => c.plainLyrics) || cands[0];
    if (best) return fromRecord(best);
  }
  return { found: false, instrumental: false, plain: null, synced: null };
}

module.exports = { fetchLyrics, getJson };
