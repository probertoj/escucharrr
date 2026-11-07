'use strict';
// escucharrr — identificación automática por HUELLA de audio (AcoustID), estilo Roon.
// Replica el enfoque de Liderarrr: fpcalc (Chromaprint) saca la huella del audio real (no de las
// etiquetas), AcoustID la resuelve a un recording de MusicBrainz, y por CONSENSO de varias pistas se
// deduce el release-group del álbum (el que aparece en más pistas). Sin npm: node:child_process + fetch.
//
// Requisitos (externos, como ffmpeg): el binario `fpcalc` (Chromaprint) en PATH o en FPCALC_PATH, y una
// API key gratuita de acoustid.org. Si faltan, degrada con elegancia (no identifica, pero no rompe).
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);

const UA = 'escucharrr/0.1 ( https://github.com/probertoj/escucharrr )';
const ACOUSTID_API = 'https://api.acoustid.org/v2/lookup';
const MB = 'https://musicbrainz.org/ws/2/';

let _fpcalcOk = null;   // null = sin comprobar
function fpcalcBin(fpcalcPath) { return fpcalcPath || process.env.FPCALC_PATH || 'fpcalc'; }
async function fpcalcAvailable(fpcalcPath) {
  const bin = fpcalcBin(fpcalcPath);
  if (_fpcalcOk && _fpcalcOk.bin === bin) return _fpcalcOk.ok;
  let ok = false;
  try { await execFileP(bin, ['-version'], { timeout: 5000 }); ok = true; } catch (e) { ok = false; }
  _fpcalcOk = { bin, ok };
  return ok;
}

// Huella de UN fichero (cacheada en local_file.fingerprint). Devuelve { fingerprint, duration } o null.
async function fingerprint(db, filePath, fpcalcPath) {
  try {
    const row = db.prepare('SELECT fingerprint, duration_ms FROM local_file WHERE path=?').get(filePath);
    if (row && row.fingerprint) return { fingerprint: row.fingerprint, duration: Math.round((row.duration_ms || 0) / 1000) || null };
  } catch (e) {}
  if (!(await fpcalcAvailable(fpcalcPath))) return null;
  try {
    const { stdout } = await execFileP(fpcalcBin(fpcalcPath), ['-json', filePath], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(stdout);
    if (!j.fingerprint) return null;
    const dur = Math.round(j.duration || 0) || null;
    try { db.prepare('UPDATE local_file SET fingerprint=? WHERE path=?').run(j.fingerprint, filePath); } catch (e) {}
    return { fingerprint: j.fingerprint, duration: dur };
  } catch (e) { return null; }
}

// Resuelve una huella contra AcoustID → mejor recording MBID con score. Guarda acoustid en local_file.
let _lastAcoustid = 0;
async function lookupRecording(db, filePath, fp, apiKey) {
  if (!apiKey || !fp || !fp.fingerprint) return null;
  const wait = 350 - (Date.now() - _lastAcoustid); if (wait > 0) await new Promise(r => setTimeout(r, wait));   // ≤3 req/s
  _lastAcoustid = Date.now();
  const params = new URLSearchParams({ client: apiKey, duration: String(fp.duration || 0), fingerprint: fp.fingerprint, meta: 'recordingids' });
  let data;
  try {
    const res = await fetch(ACOUSTID_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: params, signal: AbortSignal.timeout(20000) });
    data = await res.json();   // AcoustID devuelve JSON con {status:'error',error} también en 4xx (p. ej. clave inválida → 400)
  } catch (e) { return null; }
  if (data.status !== 'ok') {
    const msg = data.error && data.error.message;   // p. ej. «invalid API key»
    return { error: /invalid.*api key|missing.*api key|invalid user/i.test(String(msg)) ? 'badkey' : 'apierr', message: String(msg || 'error de AcoustID') };
  }
  let best = null;
  for (const r of data.results || []) {
    const rec = (r.recordings || [])[0];
    if (rec && rec.id && (!best || r.score > best.score)) best = { acoustid: r.id, mb_recording_id: rec.id, score: r.score };
  }
  if (best) { try { db.prepare('UPDATE local_file SET acoustid=? WHERE path=?').run(best.acoustid, filePath); } catch (e) {} }
  return best;
}

// Release-groups en los que aparece una grabación (MusicBrainz). Devuelve [{rg_mbid, title, primary_type, artist_mbid}].
async function recordingReleaseGroups(mb, recMbid) {
  let j; try { j = await mb('recording/' + recMbid + '?inc=releases+release-groups&fmt=json'); } catch (e) { return []; }
  const seen = new Map();
  for (const rel of j.releases || []) {
    const rg = rel['release-group']; if (!rg || !rg.id) continue;
    if (!seen.has(rg.id)) seen.set(rg.id, { rg_mbid: rg.id, title: rg.title || rel.title || null, primary_type: rg['primary-type'] || null, artist_mbid: null });
  }
  return [...seen.values()];
}

// Identifica un ÁLBUM por huella: por cada pista, huella → AcoustID → recording → release-groups, y vota.
// Gana el release-group que aparece en MÁS pistas (consenso). mb = función makeMb(); onProgress(frac,msg).
async function identifyAlbumByFingerprint(db, tracks, apiKey, opts = {}) {
  const mb = opts.mb, fpcalcPath = opts.fpcalcPath, onP = opts.onProgress || (() => {});
  if (!(await fpcalcAvailable(fpcalcPath))) return { ok: false, reason: 'fpcalc' };
  if (!apiKey) return { ok: false, reason: 'key' };
  const votes = new Map();   // rg_mbid → { count, rg }
  let scanned = 0, bestScore = 0;
  const sample = tracks.slice(0, Math.min(tracks.length, opts.maxTracks || 8));   // muestra: no hace falta toda la lista
  for (let i = 0; i < sample.length; i++) {
    const t = sample[i];
    onP(i / sample.length, 'Huella de ' + (t.title || 'pista ' + (i + 1)));
    const fp = await fingerprint(db, t.path, fpcalcPath); if (!fp) continue;
    const hit = await lookupRecording(db, t.path, fp, apiKey);
    if (hit && hit.error) return { ok: false, reason: hit.error, message: hit.message, scanned };   // clave inválida/API caída: no sigas gastando llamadas
    if (!hit || !hit.mb_recording_id) continue;
    scanned++; bestScore = Math.max(bestScore, hit.score || 0);
    const rgs = await recordingReleaseGroups(mb, hit.mb_recording_id);
    for (const rg of rgs) { const v = votes.get(rg.rg_mbid) || { count: 0, rg }; v.count++; votes.set(rg.rg_mbid, v); }
  }
  // Consenso: el RG votado por más pistas; desempate por menos ediciones ganaría, pero aquí por count y score.
  const ranked = [...votes.values()].sort((a, b) => b.count - a.count);
  const top = ranked[0] || null;
  if (!top || !scanned) return { ok: false, reason: 'nomatch', scanned };
  return { ok: true, rg_mbid: top.rg.rg_mbid, title: top.rg.title, primary_type: top.rg.primary_type, votes: top.count, scanned, score: bestScore,
           candidates: ranked.slice(0, 5).map(v => ({ rg_mbid: v.rg.rg_mbid, title: v.rg.title, votes: v.count })) };
}

module.exports = { fpcalcAvailable, fingerprint, lookupRecording, recordingReleaseGroups, identifyAlbumByFingerprint };
