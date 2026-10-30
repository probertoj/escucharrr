'use strict';
// escucharrr — enriquecimiento desde MusicBrainz (metadatos públicos, factual).
// Para cada release_group sin mbid: resuelve mbid + tipo + fecha + géneros, y trae
// los créditos tipados (intérpretes/roles) a nivel de grabación -> tabla credit.
// Respeta el límite de MusicBrainz (1 req/s) y envía User-Agent.
//   node enrich.js --db escucharrr.db [--limit 1] [--demo]

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', 'escucharrr.db');
const LIMIT = parseInt(arg('limit', '1'), 10);
const RG_ID = arg('rg') ? parseInt(arg('rg'), 10) : null;   // enriquecer SOLO este release_group (aunque ya tenga mbid)
const DEMO = process.argv.includes('--demo');
const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
const MB = 'https://musicbrainz.org/ws/2/';

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastReq = 0;
async function mb(q) {
  const wait = 1100 - (Date.now() - lastReq); if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  const res = await fetch(MB + q, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('MB ' + res.status + ' en ' + q);
  return res.json();
}
const esc = (s) => String(s).replace(/["\\]/g, '\\$&');

// ── helpers de grafo ──────────────────────────────────────────────────────────
const S = {
  rgsNoMbid: db.prepare(`SELECT rg.id, rg.title, rg.mbid,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1) AS artist
     FROM release_group rg WHERE rg.mbid IS NULL ORDER BY rg.id LIMIT ?`),
  rgById: db.prepare(`SELECT rg.id, rg.title, rg.mbid,
      (SELECT acn.name FROM artist_credit_name acn WHERE acn.artist_credit_id=rg.artist_credit_id ORDER BY acn.position LIMIT 1) AS artist
     FROM release_group rg WHERE rg.id=?`),
  setRgMbid: db.prepare('UPDATE release_group SET mbid=?, primary_type=COALESCE(?,primary_type), first_release=COALESCE(?,first_release), updated_at=datetime(\'now\') WHERE id=?'),
  artistByMbid: db.prepare('SELECT id FROM artist WHERE mbid=?'),
  artistByName: db.prepare('SELECT id, mbid FROM artist WHERE name=?'),
  insArtist: db.prepare('INSERT INTO artist(name,sort_name,mbid) VALUES(?,?,?)'),
  setArtistMbid: db.prepare('UPDATE artist SET mbid=? WHERE id=? AND mbid IS NULL'),
  genreByName: db.prepare('SELECT id FROM genre WHERE name=?'),
  insGenre: db.prepare('INSERT INTO genre(name) VALUES(?)'),
  linkGenre: db.prepare('INSERT OR IGNORE INTO release_group_genre(release_group_id,genre_id) VALUES(?,?)'),
  recByPos: db.prepare(`SELECT tr.recording_id FROM track tr JOIN medium m ON m.id=tr.medium_id
      JOIN "release" rel ON rel.id=m.release_id WHERE rel.release_group_id=? AND m.position=? AND tr.position=?`),
  delCredits: db.prepare('DELETE FROM credit WHERE entity_type=? AND entity_id=?'),
  insCredit: db.prepare('INSERT INTO credit(entity_type,entity_id,artist_id,role,instrument,detail,position) VALUES(?,?,?,?,?,?,?)'),
  prov: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at) VALUES(?,?,?,?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`),
};
function ensureArtist(name, mbid) {
  if (mbid) { const r = S.artistByMbid.get(mbid); if (r) return r.id; }
  const byName = S.artistByName.get(name);
  if (byName) { if (mbid && !byName.mbid) S.setArtistMbid.run(mbid, byName.id); return byName.id; }
  return Number(S.insArtist.run(name, name, mbid || null).lastInsertRowid);
}
function ensureGenre(name) { const r = S.genreByName.get(name); return r ? r.id : Number(S.insGenre.run(name).lastInsertRowid); }

// MB relation.type -> rol legible
const ROLE = { instrument: 'instrumento', vocal: 'voz', performer: 'interpretación', producer: 'producción', mix: 'mezcla', mastering: 'masterización', engineer: 'ingeniería', recording: 'grabación', composer: 'composición', writer: 'escritura', lyricist: 'letra', arranger: 'arreglos' };
const mapRole = (t) => ROLE[t] || t;

async function enrichRg(rg) {
  // 1) resolver release-group (si ya tiene mbid —p. ej. fijado por identify.js— lo reutilizamos)
  let cand;
  if (rg.mbid) {
    cand = { id: rg.mbid };
  } else {
    const q = `release-group?query=artist:"${esc(rg.artist)}" AND releasegroup:"${esc(rg.title)}"&fmt=json&limit=5`;
    const sr = await mb(q);
    cand = (sr['release-groups'] || [])[0];
    if (!cand) { console.log(`  · ${rg.artist} — ${rg.title}: sin match en MB`); return { credits: 0 }; }
    S.setRgMbid.run(cand.id, cand['primary-type'] || null, cand['first-release-date'] || null, rg.id);
    S.prov.run('release_group', rg.id, 'mbid', 'musicbrainz', cand.id);
  }

  // 2) géneros + una edición
  const rgf = await mb(`release-group/${cand.id}?inc=genres+releases&fmt=json`);
  for (const g of (rgf.genres || [])) { S.linkGenre.run(rg.id, ensureGenre(g.name)); }
  if ((rgf.genres || []).length) S.prov.run('release_group', rg.id, 'genre', 'musicbrainz', cand.id);
  const rel = (rgf.releases || []).find(r => r.status === 'Official') || (rgf.releases || [])[0];
  if (!rel) return { mbid: cand.id, genres: (rgf.genres || []).map(g => g.name), credits: 0 };

  // 3) créditos a nivel de grabación
  const rf = await mb(`release/${rel.id}?inc=recordings+recording-level-rels+artist-rels+work-rels&fmt=json`);
  let nCredits = 0;
  for (const m of (rf.media || [])) {
    for (const tk of (m.tracks || [])) {
      const ourRec = S.recByPos.get(rg.id, m.position, tk.position);
      if (!ourRec) continue;
      const recId = ourRec.recording_id;
      S.delCredits.run('recording', recId);
      const rels = (tk.recording && tk.recording.relations) || [];
      let pos = 0;
      for (const r of rels) {
        if (r['target-type'] !== 'artist' || !r.artist) continue;
        const aid = ensureArtist(r.artist.name, r.artist.id);
        const instrument = (r.attributes || []).join(', ') || null;
        S.insCredit.run('recording', recId, aid, mapRole(r.type), instrument, r.direction === 'backward' ? null : null, pos++);
        nCredits++;
      }
    }
  }
  return { mbid: cand.id, type: cand['primary-type'], date: cand['first-release-date'], genres: (rgf.genres || []).map(g => g.name), credits: nCredits };
}

(async () => {
  const rgs = RG_ID ? [S.rgById.get(RG_ID)].filter(Boolean) : S.rgsNoMbid.all(LIMIT);
  if (!rgs.length) { console.log(RG_ID ? `No existe el release_group ${RG_ID}.` : 'Nada que enriquecer (todos los álbumes ya tienen mbid).'); db.close(); return; }
  console.log(`Enriqueciendo ${rgs.length} álbum(es) desde MusicBrainz…`);
  for (const rg of rgs) {
    try {
      const r = await enrichRg(rg);
      if (r.mbid) console.log(`  ✓ ${rg.artist} — ${rg.title}  [${r.type || '?'} ${r.date || ''}]  mbid=${r.mbid}  géneros=${(r.genres || []).join(', ') || '—'}  créditos=${r.credits}`);
    } catch (e) { console.log(`  ✗ ${rg.artist} — ${rg.title}: ${e.message}`); }
  }

  if (DEMO) {
    console.log('\n== Créditos por rol del álbum (desde MusicBrainz) ==');
    const rows = db.prepare(`SELECT role, group_concat(DISTINCT artist_name) artistas FROM v_album_credits
       WHERE release_group_id=(SELECT id FROM release_group WHERE mbid IS NOT NULL ORDER BY id LIMIT 1)
       GROUP BY role ORDER BY role`).all();
    rows.forEach(r => console.log('  ' + r.role + ': ' + r.artistas));
  }
  db.close();
})();
