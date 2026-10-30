'use strict';
// escucharrr — enriquecimiento de CRÉDITOS POR PISTA desde Discogs.
// Discogs suele tener el personal por pista (intérpretes/roles) de sellos pequeños que
// MusicBrainz no cubre. Resuelve una edición por búsqueda de texto, trae sus extraartists
// (a nivel de release con rango `tracks`, y a nivel de pista) y los mapea a nuestras
// grabaciones por posición -> tabla `credit` (source='discogs').
// Funciona sin token (25 req/min); con token sube a 60 req/min.
//   node discogs.js --db escucharrr.db [--rg <id>] [--limit N] [--demo]
//                   [--discogs-token TOKEN]   (o env DISCOGS_TOKEN)
//                   [--no-genres]             (no importar géneros/estilos)

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { migrate } = require('./migrate');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', 'escucharrr.db');
const RG_ID = arg('rg') ? parseInt(arg('rg'), 10) : null;
const LIMIT = parseInt(arg('limit', '100'), 10);
const DEMO = process.argv.includes('--demo');
const NO_GENRES = process.argv.includes('--no-genres');
const TOKEN = arg('discogs-token') || process.env.DISCOGS_TOKEN || null;
const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
const API = 'https://api.discogs.com';

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
migrate(db);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastReq = 0;
const SPACING = TOKEN ? 1100 : 2500;             // 60/min con token, 25/min sin él
async function dg(url) {
  const wait = SPACING - (Date.now() - lastReq); if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  const u = url + (TOKEN ? (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : '');
  const res = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (res.status === 429) { await sleep(60000); return dg(url); }   // rate limit: espera y reintenta
  if (!res.ok) throw new Error('Discogs ' + res.status);
  return res.json();
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const cleanName = (n) => String(n || '').replace(/\s*\(\d+\)\s*$/, '').trim();          // quita el (N) de desambiguación

// ── mapeo de roles Discogs -> vocabulario propio (ES) ──────────────────────────
const PROD = {
  'producer': 'producción', 'co-producer': 'producción', 'produced by': 'producción', 'additional production': 'producción',
  'mixed by': 'mezcla', 'mix': 'mezcla', 'remix': 'mezcla',
  'mastered by': 'masterización',
  'engineer': 'ingeniería', 'recording engineer': 'ingeniería', 'mixing engineer': 'ingeniería', 'mix engineer': 'ingeniería', 'assistant engineer': 'ingeniería',
  'recorded by': 'grabación',
  'written-by': 'composición', 'written by': 'composición', 'composed by': 'composición', 'music by': 'composición', 'music': 'composición',
  'lyrics by': 'letra', 'words by': 'letra', 'lyrics': 'letra', 'lyrics by, music by': 'composición',
  'arranged by': 'arreglos', 'arrangement': 'arreglos', 'strings arranged by': 'arreglos',
  'conductor': 'dirección', 'directed by': 'dirección',
};
const SKIP = new Set(['artwork', 'design', 'design by', 'photography', 'photography by', 'illustration', 'layout', 'liner notes', 'art direction', 'management', 'cover', 'sleeve', 'mastered at', 'lacquer cut by', 'lacquer cut', 'pressed by', 'distributed by', 'copyright', 'phonographic copyright', 'a&r', 'executive-producer', 'executive producer', 'translated by', 'edited by', 'coordinator']);
function mapRole(raw) {
  const r = raw.replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!r || SKIP.has(r)) return null;
  if (r === 'featuring' || r === 'feat.' || r === 'feat') return { role: 'interpretación', instrument: null, detail: 'featuring' };
  if (r === 'vocals' || r === 'voice' || r === 'lead vocals') return { role: 'voz', instrument: null };
  if (r === 'backing vocals' || r === 'chorus' || r === 'choir') return { role: 'voz', instrument: 'coros' };
  if (PROD[r]) return { role: PROD[r], instrument: null };
  // por defecto lo tratamos como instrumento (Bass, Guitar, Cello, Trombone [Tenor], …)
  const inst = raw.replace(/\s*\[([^\]]+)\]/g, ' ($1)').replace(/\s*\(\d+\)\s*$/, '').replace(/\s+/g, ' ').trim();
  return { role: 'instrumento', instrument: inst };
}

// ── statements ─────────────────────────────────────────────────────────────────
const S = {
  rgById: db.prepare(`SELECT rg.id, rg.title, rg.mbid,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1) AS artist
     FROM release_group rg WHERE rg.id=?`),
  rgsAll: db.prepare(`SELECT rg.id, rg.title, rg.mbid,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1) AS artist
     FROM release_group rg ORDER BY rg.id LIMIT ?`),
  recsOfRg: db.prepare(`SELECT tr.recording_id AS rec FROM track tr JOIN medium m ON m.id=tr.medium_id
      JOIN "release" rel ON rel.id=m.release_id WHERE rel.release_group_id=? ORDER BY m.position, tr.position`),
  artistByName: db.prepare('SELECT id FROM artist WHERE name=?'),
  insArtist: db.prepare('INSERT INTO artist(name,sort_name) VALUES(?,?)'),
  delDiscogs: db.prepare("DELETE FROM credit WHERE entity_type='recording' AND entity_id=? AND source='discogs'"),
  insCredit: db.prepare("INSERT INTO credit(entity_type,entity_id,artist_id,role,instrument,detail,source,position) VALUES('recording',?,?,?,?,?,'discogs',?)"),
  genreByName: db.prepare('SELECT id FROM genre WHERE name=?'),
  insGenre: db.prepare('INSERT INTO genre(name) VALUES(?)'),
  linkGenre: db.prepare('INSERT OR IGNORE INTO release_group_genre(release_group_id,genre_id) VALUES(?,?)'),
  prov: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at) VALUES('recording',?,'credits','discogs',?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`),
};
const ensureArtist = (name) => { const r = S.artistByName.get(name); return r ? r.id : Number(S.insArtist.run(name, name).lastInsertRowid); };
const ensureGenre = (name) => { const r = S.genreByName.get(name); return r ? r.id : Number(S.insGenre.run(name).lastInsertRowid); };

// elige la edición correcta: exige que el título contenga el artista Y todas las
// palabras del álbum. Sin caer en results[0] (evita colar recopilaciones).
function pickRelease(results, rg) {
  const a = norm(rg.artist), toks = norm(rg.title).split(' ').filter(Boolean);
  const ok = results.filter(x => x.id).filter(x => { const t = norm(x.title); return t.includes(a) && toks.every(w => t.includes(w)); });
  return ok[0] || null;
}

// expande el campo `tracks` de Discogs ("", "1", "7 to 10", "1 to 5, 7 to 15") a índices
function expandTracks(spec, posIndex, n) {
  if (!spec || !String(spec).trim()) return [...Array(n).keys()];       // vacío = todas
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(.+?)\s+to\s+(.+)$/i);
    if (m) { const a = posIndex[m[1].trim()], b = posIndex[m[2].trim()]; if (a != null && b != null) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i); }
    else { const i = posIndex[part.trim()]; if (i != null) out.add(i); }
  }
  return [...out];
}

async function enrichRg(rg) {
  // 1) buscar la edición (query sin acentos/signos: Discogs falla con "Nº" y similares)
  const sr = await dg(`${API}/database/search?type=release&per_page=10&q=` + encodeURIComponent(norm(rg.artist) + ' ' + norm(rg.title)));
  const hit = pickRelease(sr.results || [], rg);
  if (!hit) { console.log(`  · ${rg.artist} — ${rg.title}: sin match en Discogs`); return { credits: 0 }; }
  const rel = await dg(`${API}/releases/${hit.id}`);

  // 2) géneros + estilos (en minúscula, convención de MusicBrainz, para no duplicar)
  const genres = [...(rel.genres || []), ...(rel.styles || [])].map(g => g.toLowerCase());
  if (!NO_GENRES) { for (const g of genres) S.linkGenre.run(rg.id, ensureGenre(g)); }

  // 3) nuestras grabaciones en orden, y las pistas "reales" de Discogs en orden
  const recs = S.recsOfRg.all(rg.id).map(r => r.rec);
  const dtracks = (rel.tracklist || []).filter(t => !t.type_ || t.type_ === 'track');
  const posIndex = {}; dtracks.forEach((t, i) => { if (t.position) posIndex[String(t.position).trim()] = i; });
  const n = Math.min(recs.length, dtracks.length);
  if (!n) { console.log(`  · ${rg.artist} — ${rg.title}: encontrado (Discogs ${hit.id}) pero sin pistas emparejables`); return { credits: 0, releaseId: hit.id }; }

  // 4) acumular créditos por grabación (índice i -> recs[i]); dedup por (artista,rol,instrumento)
  const perRec = recs.map(() => ({ seen: new Set(), list: [] }));
  const add = (i, name, mapped) => {
    if (i < 0 || i >= n || !mapped) return;
    const aid = ensureArtist(cleanName(name));
    const key = aid + '|' + mapped.role + '|' + (mapped.instrument || '');
    if (perRec[i].seen.has(key)) return;
    perRec[i].seen.add(key);
    perRec[i].list.push({ aid, role: mapped.role, instrument: mapped.instrument || null, detail: mapped.detail || null });
  };
  const addAll = (ea, indices) => { for (const roleRaw of String(ea.role || '').split(',')) { const mr = mapRole(roleRaw); if (mr) for (const i of indices) add(i, ea.name, mr); } };

  // 4a) créditos a nivel de pista
  dtracks.forEach((t, i) => { for (const ea of (t.extraartists || [])) addAll(ea, [i]); });
  // 4b) créditos a nivel de release con rango `tracks`
  for (const ea of (rel.extraartists || [])) addAll(ea, expandTracks(ea.tracks, posIndex, n));

  // 5) persistir (borra solo los de discogs de esas grabaciones)
  let nCredits = 0, recsWith = 0;
  for (let i = 0; i < n; i++) {
    const recId = recs[i];
    S.delDiscogs.run(recId);
    if (!perRec[i].list.length) continue;
    let pos = 0;
    for (const c of perRec[i].list) { S.insCredit.run(recId, c.aid, c.role, c.instrument, c.detail, pos++); nCredits++; }
    S.prov.run(recId, String(hit.id));
    recsWith++;
  }
  return { credits: nCredits, recsWith, releaseId: hit.id, genres };
}

(async () => {
  const rgs = RG_ID ? [S.rgById.get(RG_ID)].filter(Boolean) : S.rgsAll.all(LIMIT);
  if (!rgs.length) { console.log(RG_ID ? `No existe el release_group ${RG_ID}.` : 'No hay álbumes.'); db.close(); return; }
  console.log(`Discogs${TOKEN ? ' (con token)' : ' (sin token, 25 req/min)'}: ${rgs.length} álbum(es)…`);
  for (const rg of rgs) {
    db.exec('BEGIN');
    try {
      const r = await enrichRg(rg);
      db.exec('COMMIT');
      if (r.releaseId) console.log(`  ✓ ${rg.artist} — ${rg.title}  [Discogs ${r.releaseId}]  créditos=${r.credits} en ${r.recsWith || 0} pista(s)  géneros=${(r.genres || []).join(', ') || '—'}`);
    } catch (e) { db.exec('ROLLBACK'); console.log(`  ✗ ${rg.artist} — ${rg.title}: ${e.message}`); }
  }

  if (DEMO) {
    console.log('\n== Créditos por rol (desde Discogs) del primer álbum con créditos ==');
    const rgid = db.prepare(`SELECT rel.release_group_id rg FROM credit c JOIN track tr ON tr.recording_id=c.entity_id JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE c.source='discogs' LIMIT 1`).get();
    if (rgid) {
      db.prepare(`SELECT c.role, c.instrument, group_concat(DISTINCT a.name) artistas
         FROM credit c JOIN artist a ON a.id=c.artist_id
         JOIN track tr ON tr.recording_id=c.entity_id JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
         WHERE rel.release_group_id=? AND c.source='discogs' GROUP BY c.role, c.instrument ORDER BY c.role`).all(rgid.rg)
        .forEach(r => console.log('  ' + r.role + (r.instrument ? ' (' + r.instrument + ')' : '') + ': ' + r.artistas));
    }
  }
  db.close();
})();
