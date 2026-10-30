'use strict';
// escucharrr — identificación de grabaciones por identificadores fuertes.
// Dos pasadas, de lo barato (offline-ish) a lo caro (huella acústica):
//   1. ISRC  -> MusicBrainz  (barato, sin binario ni key; usa los ISRC leídos por scan.js)
//   2. huella Chromaprint -> AcoustID -> MusicBrainz  (necesita fpcalc + API key de AcoustID)
// No modifica los ficheros de audio. Respeta el límite de MusicBrainz (1 req/s).
//
//   node identify.js --db escucharrr.db [--isrc|--acoustid] [--limit N] [--demo]
//                    [--acoustid-key KEY]   (o env ACOUSTID_API_KEY)
//                    [--fpcalc C:\\ruta\\fpcalc.exe]  (si no está en el PATH)

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { migrate } = require('./migrate');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', 'escucharrr.db');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;              // 0 = sin límite
const ONLY = process.argv.includes('--isrc') ? 'isrc'
  : process.argv.includes('--acoustid') ? 'acoustid' : 'all';
const DEMO = process.argv.includes('--demo');
const ACOUSTID_KEY = arg('acoustid-key') || process.env.ACOUSTID_API_KEY || process.env.ACOUSTID_KEY || null;
const FPCALC = arg('fpcalc') || 'fpcalc';
const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
const MB = 'https://musicbrainz.org/ws/2/';
const ACOUSTID = 'https://api.acoustid.org/v2/lookup';

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
migrate(db);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastMb = 0;
async function mb(q) {
  const wait = 1100 - (Date.now() - lastMb); if (wait > 0) await sleep(wait);
  lastMb = Date.now();
  const res = await fetch(MB + q, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('MB ' + res.status);
  return res.json();
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const trySet = (stmt, ...a) => { try { return stmt.run(...a); } catch (e) { if (!/UNIQUE/i.test(e.message)) throw e; return null; } };
const mbidInUse = db.prepare('SELECT 1 FROM recording WHERE mbid=? AND id<>?');

const S = {
  setRecMbid: db.prepare('UPDATE recording SET mbid=? WHERE id=? AND mbid IS NULL'),
  setRecAcoustid: db.prepare('UPDATE recording SET acoustid=COALESCE(acoustid,?) WHERE id=?'),
  markFiles: db.prepare('UPDATE local_file SET match_by=?, match_conf=? WHERE recording_id=? AND (match_conf IS NULL OR match_conf < ?)'),
  setFileAcoustid: db.prepare('UPDATE local_file SET acoustid=COALESCE(acoustid,?), fingerprint=COALESCE(fingerprint,?) WHERE id=?'),
  prov: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at) VALUES('recording',?,'mbid',?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`),
};

// ── Pasada 1: ISRC -> MusicBrainz ───────────────────────────────────────────────
async function passIsrc() {
  const recs = db.prepare(`SELECT id, isrc, title FROM recording WHERE isrc IS NOT NULL AND mbid IS NULL ORDER BY id${LIMIT ? ' LIMIT ' + LIMIT : ''}`).all();
  if (!recs.length) { console.log('ISRC: nada pendiente (sin ISRC o ya resueltos).'); return { tried: 0, ok: 0 }; }
  console.log(`ISRC -> MusicBrainz: resolviendo ${recs.length} grabación(es)…`);
  let ok = 0;
  for (const r of recs) {
    try {
      const j = await mb(`isrc/${encodeURIComponent(r.isrc)}?fmt=json&inc=artist-credits`);
      const cands = j.recordings || [];
      if (!cands.length) { console.log(`  · ${r.isrc} (${r.title}): sin match`); continue; }
      // preferimos el que coincide en título; si no, el primero
      const best = cands.find(c => norm(c.title) === norm(r.title)) || cands[0];
      if (mbidInUse.get(best.id, r.id)) { console.log(`  · ${r.isrc} (${r.title}): mbid ya en uso, omito`); continue; }
      const res = trySet(S.setRecMbid, best.id, r.id);
      if (res && res.changes) {
        S.prov.run(r.id, 'isrc', best.id);
        S.markFiles.run('isrc', 0.9, r.id, 0.9);
        ok++;
        console.log(`  ✓ ${r.isrc}  ${r.title}  ->  ${best.id}${norm(best.title) !== norm(r.title) ? '  (título MB: ' + best.title + ')' : ''}`);
      }
    } catch (e) { console.log(`  ✗ ${r.isrc} (${r.title}): ${e.message}`); }
  }
  return { tried: recs.length, ok };
}

// ── Pasada 2: huella Chromaprint -> AcoustID -> MusicBrainz ──────────────────────
function fpcalcAvailable() {
  try { const r = cp.spawnSync(FPCALC, ['-version'], { encoding: 'utf8' }); return !r.error && r.status === 0; }
  catch { return false; }
}
function computeFingerprint(file) {
  const r = cp.spawnSync(FPCALC, ['-json', '-length', '120', file], { encoding: 'utf8', maxBuffer: 8 << 20 });
  if (r.error || r.status !== 0) throw new Error('fpcalc: ' + (r.error ? r.error.message : (r.stderr || '').trim()));
  const j = JSON.parse(r.stdout);
  return { fingerprint: j.fingerprint, duration: Math.round(j.duration) };
}
let lastAc = 0;
async function acoustidLookup(fingerprint, duration) {
  const wait = 350 - (Date.now() - lastAc); if (wait > 0) await sleep(wait);
  lastAc = Date.now();
  const body = new URLSearchParams({ client: ACOUSTID_KEY, duration: String(duration), fingerprint, meta: 'recordings' });
  const res = await fetch(ACOUSTID, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error('AcoustID ' + res.status);
  const j = await res.json();
  if (j.status !== 'ok') throw new Error('AcoustID: ' + (j.error && j.error.message || j.status));
  return (j.results || [])[0] || null;
}

async function passAcoustid() {
  // candidatos: ficheros ya mapeados a una grabación sin mbid confirmado, con huella en tag o calculable
  const files = db.prepare(`SELECT lf.id, lf.path, lf.recording_id, lf.fingerprint, lf.duration_ms, r.title, r.mbid
     FROM local_file lf JOIN recording r ON r.id=lf.recording_id
     WHERE lf.recording_id IS NOT NULL AND r.mbid IS NULL ORDER BY lf.id${LIMIT ? ' LIMIT ' + LIMIT : ''}`).all();
  if (!files.length) { console.log('AcoustID: nada pendiente (sin ficheros mapeados sin mbid).'); return { tried: 0, ok: 0 }; }

  const haveKey = !!ACOUSTID_KEY;
  const haveFp = fpcalcAvailable();
  const needCompute = files.some(f => !f.fingerprint);
  if (!haveKey) {
    console.log(`AcoustID: ${files.length} fichero(s) elegibles, pero falta la API key.`);
    console.log('  → consíguela gratis en https://acoustid.org/new-application y pásala con --acoustid-key o la variable ACOUSTID_API_KEY.');
    if (needCompute && !haveFp) console.log(`  → además, ${files.filter(f => !f.fingerprint).length} no traen huella en el tag; necesitarás fpcalc (Chromaprint) en el PATH o --fpcalc.`);
    return { tried: 0, ok: 0, skipped: files.length };
  }
  if (needCompute && !haveFp) console.log('AcoustID: aviso — fpcalc no disponible; solo usaré huellas ya presentes en los tags.');

  console.log(`Huella -> AcoustID: ${files.length} fichero(s)…`);
  let ok = 0, tried = 0;
  for (const f of files) {
    try {
      let fp = f.fingerprint, dur = f.duration_ms ? Math.round(f.duration_ms / 1000) : null;
      if (!fp) { if (!haveFp) continue; const c = computeFingerprint(f.path); fp = c.fingerprint; dur = c.duration; S.setFileAcoustid.run(null, fp, f.id); }
      if (!fp || !dur) continue;
      tried++;
      const r = await acoustidLookup(fp, dur);
      if (!r) { console.log(`  · ${f.title}: sin match`); continue; }
      S.setFileAcoustid.run(r.id, fp, f.id);
      S.setRecAcoustid.run(r.id, f.recording_id);
      const rec = (r.recordings || []).find(x => norm(x.title) === norm(f.title)) || (r.recordings || [])[0];
      if (rec && rec.id && !mbidInUse.get(rec.id, f.recording_id)) {
        const res = trySet(S.setRecMbid, rec.id, f.recording_id);
        if (res && res.changes) { S.prov.run(f.recording_id, 'acoustid', r.id); S.markFiles.run('acoustid', 0.92, f.recording_id, 0.92); }
      }
      ok++;
      console.log(`  ✓ ${f.title}  AcoustID=${r.id}  score=${(r.score || 0).toFixed(2)}${rec ? '  mbid=' + rec.id : ''}`);
    } catch (e) { console.log(`  ✗ ${f.title}: ${e.message}`); }
  }
  return { tried, ok };
}

(async () => {
  console.log(`BD: ${DB_PATH}`);
  if (ONLY === 'isrc' || ONLY === 'all') { db.exec('BEGIN'); try { await passIsrc(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  if (ONLY === 'acoustid' || ONLY === 'all') { db.exec('BEGIN'); try { await passAcoustid(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }

  if (DEMO) {
    console.log('\n== Grabaciones identificadas (mbid) ==');
    db.prepare(`SELECT r.title, r.isrc, r.mbid, lf.match_by FROM recording r
       LEFT JOIN local_file lf ON lf.recording_id=r.id WHERE r.mbid IS NOT NULL ORDER BY r.id LIMIT 12`).all()
      .forEach(r => console.log(`  ${r.match_by || '—'}  ${r.title}  ${r.isrc || ''}  ${r.mbid}`));
  }
  db.close();
})();
