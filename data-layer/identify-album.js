'use strict';
// escucharrr — wizard de IDENTIFICACIÓN de álbum (modelo Roon; ver docs/roon-parity-gaps.md, §5 "RE
// profundo"). Roon identifica el álbum ENTERO emparejando por nº de pistas + PERFIL DE DURACIONES
// (+ barcode/catálogo como refuerzo), no por búsqueda de texto artista+título — que es ruidosa.
// Esto replica ese enfoque contra MusicBrainz para los release_group SIN mbid.
//
// Sin dependencias (node:sqlite + fetch nativo). Reutiliza el throttle 1,1 s + User-Agent de enrich.js.
//   node identify-album.js --db escucharrr.db --rg <id>                 # lista sugerencias puntuadas
//   node identify-album.js --db escucharrr.db --rg <id> --apply <release-mbid>  # fija el mbid y lo deja listo para enriquecer
//
// Exporta buildProfile / durScore / scoreCandidate / suggest / applyMbid para el servidor y los tests.
// Las funciones de scoring son PURAS (sin red ni DB): testables en aislamiento.

const { DatabaseSync } = require('node:sqlite');

const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
const MB = 'https://musicbrainz.org/ws/2/';
const DUR_TOL_MS = 5000;        // tolerancia por pista: ±5 s = misma pista (remaster/gap difieren poco)
const CANDIDATE_FETCHES = 8;    // nº máx de ediciones candidatas a las que pedir duraciones (a 1,1 s c/u)

// ── scoring PURO (sin red ni DB) ───────────────────────────────────────────────
// Compara dos perfiles de duraciones (arrays de ms en orden de pista). Devuelve 0..1:
// 1 = todas las pistas casan dentro de la tolerancia y hay el mismo nº de pistas.
function durScore(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let acc = 0, matched = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x == null || y == null) continue;
    matched++;
    acc += Math.max(0, 1 - Math.abs(x - y) / DUR_TOL_MS);
  }
  if (!matched) return 0;
  const lenPenalty = 1 - Math.abs(a.length - b.length) / Math.max(a.length, b.length);   // penaliza distinto nº de pistas
  return (acc / matched) * lenPenalty;
}
// Solape de tokens (Jaccard) entre dos títulos — desempate pequeño.
function tokenOverlap(x, y) {
  const toks = (s) => new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean));
  const A = toks(x), B = toks(y); if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
const digits = (s) => String(s || '').replace(/\D/g, '');
// Puntúa un candidato de MB contra el perfil local. score alto = mejor. parts explica el desglose.
function scoreCandidate(profile, cand) {
  let score = durScore(profile.durations, cand.durations);
  const parts = { dur: +score.toFixed(3) };
  if (cand.trackCount && cand.trackCount === profile.trackCount) { score += 0.10; parts.trackCount = 0.10; }
  if (profile.barcode && cand.barcode && digits(profile.barcode) && digits(profile.barcode) === digits(cand.barcode)) { score += 0.50; parts.barcode = 0.50; }
  const t = tokenOverlap(profile.title, cand.title); if (t > 0) { const b = +(0.05 * t).toFixed(3); score += b; parts.title = b; }
  return { score: +score.toFixed(4), parts };
}

// ── perfil local (DB) ───────────────────────────────────────────────────────────
// Construye el perfil del release_group: artista, título, barcode y el vector de duraciones por
// pista (en orden medium/pista). Las duraciones vienen del escaneo (track/recording length_ms).
function buildProfile(db, rgId) {
  // Prioriza el título/artista EDITADO por el usuario (user_edit) sobre el tag original: si corrigió el nombre
  // del álbum o el artista mal etiquetado («download»), identificamos con ESO, no con el valor viejo (bug matutino #2).
  const rg = db.prepare(`SELECT rg.id,
      COALESCE((SELECT ue.value FROM user_edit ue WHERE ue.subject_type='release_group' AND ue.subject_id=rg.id AND ue.field='title'), rg.title) AS title,
      COALESCE((SELECT ue.value FROM user_edit ue WHERE ue.subject_type='release_group' AND ue.subject_id=rg.id AND ue.field='album_artist'),
               (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1)) AS artist
     FROM release_group rg WHERE rg.id=?`).get(rgId);
  if (!rg) return null;
  const rel = db.prepare('SELECT barcode FROM "release" WHERE release_group_id=? ORDER BY id LIMIT 1').get(rgId) || {};
  const rows = db.prepare(`SELECT COALESCE(tr.length_ms, r.length_ms) AS len
     FROM "release" rel JOIN medium m ON m.release_id=rel.id JOIN track tr ON tr.medium_id=m.id
     JOIN recording r ON r.id=tr.recording_id
     WHERE rel.release_group_id=? ORDER BY m.position, tr.position`).all(rgId);
  const durations = rows.map(r => (r.len == null ? null : Number(r.len)));
  return { rgId: rg.id, title: rg.title, artist: rg.artist || '', barcode: rel.barcode || null, trackCount: durations.length, durations };
}

// ── cliente MusicBrainz (throttle 1,1 s/req + User-Agent), igual que enrich.js ──
function makeMb() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let last = 0;
  return async function mb(q) {
    const wait = 1100 - (Date.now() - last); if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(MB + q, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('MB ' + res.status + ' en ' + q);
    return res.json();
  };
}
// Duraciones (ms) de una edición de MB, en orden medium/pista. Fallback a recording.length.
function mbReleaseDurations(rel) {
  const media = (rel.media || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  const out = [];
  for (const m of media) for (const t of (m.tracks || [])) out.push(t.length != null ? t.length : (t.recording && t.recording.length != null ? t.recording.length : null));
  return out;
}

// ── sugerencias (DB + red) ──────────────────────────────────────────────────────
// Devuelve candidatos puntuados, mejor primero. onProgress(frac, msg) opcional para la UI.
async function suggest(db, rgId, opts = {}) {
  const profile = buildProfile(db, rgId);
  if (!profile) throw new Error('release_group ' + rgId + ' no existe');
  const mb = opts.mb || makeMb();
  const onProgress = opts.onProgress || (() => {});
  const maxFetches = opts.candidateFetches || CANDIDATE_FETCHES;   // el lote «identificar todos» baja esto para ir más rápido
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
  // 1) buscar ediciones candidatas por artista+título (barato: una petición; sin duraciones aún)
  const query = `artist:"${esc(profile.artist)}" AND release:"${esc(profile.title)}"`;
  onProgress(0.05, 'Buscando candidatos en MusicBrainz…');
  const sr = await mb('release?query=' + encodeURIComponent(query) + '&limit=25');
  let cands = (sr.releases || []).map(r => ({
    mbid: r.id, title: r.title,
    artist: (r['artist-credit'] || []).map(a => (a.name || (a.artist && a.artist.name) || '')).join(''),
    date: r.date || null, country: r.country || null, barcode: r.barcode || null,
    trackCount: r['track-count'] != null ? r['track-count'] : (r.media || []).reduce((s, m) => s + (m['track-count'] || 0), 0),
    searchScore: r.score || 0,
  }));
  // 2) prefiltro: prioriza nº de pistas cercano y buen score de texto; pide duraciones solo a los mejores.
  cands.sort((a, b) => (Math.abs((a.trackCount || 0) - profile.trackCount) - Math.abs((b.trackCount || 0) - profile.trackCount)) || (b.searchScore - a.searchScore));
  const top = cands.slice(0, maxFetches);
  // 3) traer duraciones de cada candidato y puntuar
  const scored = [];
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    onProgress(0.1 + 0.85 * (i / top.length), `Cotejando duraciones (${i + 1}/${top.length})…`);
    try {
      const rel = await mb('release/' + c.mbid + '?inc=recordings+media');
      c.durations = mbReleaseDurations(rel);
      if (!c.trackCount) c.trackCount = c.durations.length;
    } catch (e) { c.durations = []; c.error = e.message; }
    const { score, parts } = scoreCandidate(profile, c);
    scored.push({ ...c, score, parts });
  }
  scored.sort((a, b) => b.score - a.score);
  onProgress(1, 'Listo');
  return { profile, candidates: scored };
}

// ── aplicar la elección: fija el mbid de la edición y del release_group, con procedencia ──
// Deja el álbum "identificado" para que enrich.js (--rg / --have-mbid) complete el resto.
async function applyMbid(db, rgId, releaseMbid, opts = {}) {
  const mb = opts.mb || makeMb();
  const rel = await mb('release/' + releaseMbid + '?inc=release-groups');
  const rgMbid = rel['release-group'] && rel['release-group'].id;
  // Modelo de VERSIONES (estilo Roon): varias copias locales pueden compartir el MBID del release-group; ya no
  // se rechaza. (El UNIQUE de release_group.mbid se quitó en la migración; se agrupan como versiones.)
  // UNIQUE de release.mbid: no pisar si esa edición ya está en otra release local.
  const relClash = db.prepare('SELECT id FROM "release" WHERE mbid=? AND release_group_id!=?').get(releaseMbid, rgId);
  const tx = db;
  tx.exec('BEGIN');
  try {
    const our = tx.prepare('SELECT id FROM "release" WHERE release_group_id=? ORDER BY id LIMIT 1').get(rgId);
    if (our && !relClash) tx.prepare('UPDATE "release" SET mbid=? WHERE id=?').run(releaseMbid, our.id);
    // SET (no COALESCE): reidentificar puede CAMBIAR un mbid ya puesto; el conflicto ya se comprobó arriba.
    if (rgMbid) tx.prepare('UPDATE release_group SET mbid=?, updated_at=datetime(\'now\') WHERE id=?').run(rgMbid, rgId);
    tx.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at)
       VALUES('release_group',?,'mbid','user-identify',?,datetime('now'))
       ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source='user-identify', source_ref=excluded.source_ref, fetched_at=datetime('now')`).run(rgId, releaseMbid);
    tx.exec('COMMIT');
  } catch (e) { tx.exec('ROLLBACK'); throw e; }
  return { releaseMbid, rgMbid };
}

// Enlace MANUAL por release-group (lo que pide Serge: pegar el release-group de MusicBrainz, como Liderarrr).
// Valida el RG contra MB y fija release_group.mbid + procedencia 'user-identify'. La edición concreta
// (release.mbid) se deja para enrich/identify por edición: no se adivina para no mal-etiquetar.
async function applyRgMbid(db, rgId, rgMbid, opts = {}) {
  const mb = opts.mb || makeMb();
  await mb('release-group/' + rgMbid);   // valida: lanza si el MBID no existe en MusicBrainz
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE release_group SET mbid=?, updated_at=datetime(\'now\') WHERE id=?').run(rgMbid, rgId);
    db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at)
       VALUES('release_group',?,'mbid','user-identify',?,datetime('now'))
       ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source='user-identify', source_ref=excluded.source_ref, fetched_at=datetime('now')`).run(rgId, rgMbid);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { rgMbid, releaseMbid: null };
}

module.exports = { buildProfile, durScore, tokenOverlap, scoreCandidate, suggest, applyMbid, applyRgMbid, mbReleaseDurations, DUR_TOL_MS, makeMb };

// ── CLI ──────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; };
  const DB_PATH = arg('db', 'escucharrr.db');
  const RG = parseInt(arg('rg'), 10);
  const APPLY = arg('apply');
  if (!RG) { console.error('Falta --rg <id del release_group>'); process.exit(1); }
  const db = new DatabaseSync(DB_PATH);
  (async () => {
    if (APPLY) {
      const r = await applyMbid(db, RG, String(APPLY));
      console.log(`Identificado rg ${RG}: release ${r.releaseMbid}` + (r.rgMbid ? `, release-group ${r.rgMbid}` : '') + '. Ahora: node enrich.js --db <db> --rg ' + RG);
      return;
    }
    const { profile, candidates } = await suggest(db, RG, { onProgress: (f, m) => process.stderr.write(`\r[${Math.round(f * 100)}%] ${m}            `) });
    process.stderr.write('\n');
    console.log(`\nÁlbum local: "${profile.title}" — ${profile.artist}  (${profile.trackCount} pistas${profile.barcode ? ', barcode ' + profile.barcode : ''})`);
    console.log('Sugerencias (mejor primero):');
    for (const c of candidates.slice(0, 8)) {
      console.log(`  ${c.score.toFixed(3)}  ${c.mbid}  "${c.title}" — ${c.artist} [${c.date || '?'} ${c.country || ''}] ${c.trackCount}p  ${JSON.stringify(c.parts)}`);
    }
    console.log('\nPara fijar: node identify-album.js --db <db> --rg ' + RG + ' --apply <release-mbid>');
  })().catch(e => { console.error('error:', e.message); process.exit(1); });
}
