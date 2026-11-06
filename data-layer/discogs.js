'use strict';
// escucharrr — Discogs como 2ª fuente de FECHAS de lanzamiento (cuando Spotify no tiene el disco).
// SOLO lectura y SOLO sugerencia: no reproduce, no sincroniza y no escribe nada en ninguna parte.
// Sin dependencias (node:https). El token es opcional (sube el límite de peticiones); sin token se
// consulta sin autenticar, que Discogs permite con un User-Agent propio (más limitado de ritmo).

const https = require('node:https');
const { URLSearchParams } = require('node:url');

const API = 'api.discogs.com';
const UA = 'escucharrr/0.1 +https://github.com/probertoj/escucharrr';

function req(path, token) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': UA, 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Discogs token=' + token;
    const r = https.request({ host: API, path, method: 'GET', headers }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.setTimeout(20000, () => r.destroy());
    r.end();
  });
}

// Fecha de lanzamiento de un álbum según Discogs. Busca la edición por artista+título, ordena por año
// ascendente y abre las más antiguas hasta dar con una que tenga DÍA (o mes). Devuelve la más temprana
// con fecha completa → el lanzamiento original. {date, precision:'day'|'month', url, name} o null.
async function albumDate(token, { artist, title } = {}) {
  const p = new URLSearchParams({ type: 'release', artist: String(artist || ''), release_title: String(title || ''), per_page: '25' });
  const s = await req('/database/search?' + p.toString(), token);
  if (s.status !== 200 || !s.json || !Array.isArray(s.json.results)) return null;
  const items = s.json.results
    .map(it => ({ id: it.id, year: parseInt(it.year, 10), title: it.title }))
    .filter(it => it.id && Number.isFinite(it.year))
    .sort((a, b) => a.year - b.year);
  let best = null;                                                 // la mejor fecha mes-precisión, por si no hay día
  for (const it of items.slice(0, 5)) {                            // tope de 5 aperturas para no abusar del ritmo
    const r = await req('/releases/' + it.id + (token ? '?token=' + encodeURIComponent(token) : ''), token);
    if (r.status === 429) break;                                   // límite de ritmo: paramos con lo que haya
    const rel = (r.status === 200 && r.json && r.json.released) ? String(r.json.released) : '';
    const url = 'https://www.discogs.com/release/' + it.id;
    if (/^\d{4}-\d{2}-\d{2}/.test(rel)) return { date: rel.slice(0, 10), precision: 'day', url, name: it.title };
    if (/^\d{4}-\d{2}$/.test(rel) && !best) best = { date: rel, precision: 'month', url, name: it.title };
  }
  return best;
}

module.exports = { albumDate };
