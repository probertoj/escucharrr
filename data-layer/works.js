'use strict';
// escucharrr — OBRAS y COMPOSITORES desde MusicBrainz (el modelo obra/interpretación por
// el que Roon brilla, sobre todo en clásica, pero aplica a toda la música). Para cada
// release_group con mbid: resuelve una edición, enlaza cada grabación con su OBRA
// (relación 'performance') y, por obra, trae su COMPOSITOR/letrista/arreglista. Sin
// dependencias; respeta el límite de MusicBrainz (1 req/s) + User-Agent.
//   node works.js --db ../app/escucharrr.db [--limit N] [--rg ID] [--force]

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', path.join(__dirname, '..', 'app', 'escucharrr.db'));
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const ONE_RG = arg('rg', null) != null ? parseInt(arg('rg'), 10) : null;
const FORCE = process.argv.includes('--force');
const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
const MB = 'https://musicbrainz.org/ws/2/';

const db = new DatabaseSync(DB_PATH);
require('./migrate').migrate(db);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastReq = 0;
async function mb(q) {
  const wait = 1100 - (Date.now() - lastReq); if (wait > 0) await sleep(wait);
  lastReq = Date.now();
  let res = await fetch(MB + q, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (res.status === 503) { await sleep(2000); res = await fetch(MB + q, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }); lastReq = Date.now(); }
  if (!res.ok) throw new Error('MB ' + res.status + ' en ' + q);
  return res.json();
}

const S = {
  rgs: db.prepare(`SELECT id, mbid, title FROM release_group WHERE mbid IS NOT NULL${ONE_RG != null ? ' AND id=?' : ''} ORDER BY id`),
  recByPos: db.prepare(`SELECT tr.recording_id rid FROM track tr JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id WHERE rel.release_group_id=? AND m.position=? AND tr.position=?`),
  recMbid: db.prepare('SELECT mbid, work_id FROM recording WHERE id=?'),
  setRecMbid: db.prepare('UPDATE recording SET mbid=? WHERE id=? AND mbid IS NULL'),
  setRecWork: db.prepare('UPDATE recording SET work_id=? WHERE id=?'),
  workByMbid: db.prepare('SELECT id FROM work WHERE mbid=?'),
  insWork: db.prepare('INSERT INTO work(mbid,title,type) VALUES(?,?,?)'),
  artistByMbid: db.prepare('SELECT id FROM artist WHERE mbid=?'),
  artistByName: db.prepare('SELECT id, mbid FROM artist WHERE name=?'),
  insArtist: db.prepare('INSERT INTO artist(name,sort_name,mbid) VALUES(?,?,?)'),
  setArtistMbid: db.prepare('UPDATE artist SET mbid=? WHERE id=? AND mbid IS NULL'),
  delWorkCredits: db.prepare("DELETE FROM credit WHERE entity_type='work' AND entity_id=? AND (source='musicbrainz' OR source IS NULL)"),
  insCredit: db.prepare("INSERT INTO credit(entity_type,entity_id,artist_id,role,instrument,detail,source,position) VALUES('work',?,?,?,NULL,NULL,'musicbrainz',?)"),
};
function ensureArtist(name, mbid) {
  if (mbid) { const r = S.artistByMbid.get(mbid); if (r) return r.id; }
  const byName = S.artistByName.get(name);
  if (byName) { if (mbid && !byName.mbid) S.setArtistMbid.run(mbid, byName.id); return byName.id; }
  return Number(S.insArtist.run(name, name, mbid || null).lastInsertRowid);
}
function ensureWork(w) {
  const ex = S.workByMbid.get(w.id); if (ex) return ex.id;
  return Number(S.insWork.run(w.id, w.title || '(obra)', w.type || null).lastInsertRowid);
}
const ROLE = { composer: 'composición', lyricist: 'letra', writer: 'escritura', arranger: 'arreglos', orchestrator: 'orquestación', librettist: 'libreto', translator: 'traducción', 'revised by': 'revisión' };

async function run() {
  const rgs = ONE_RG != null ? S.rgs.all(ONE_RG) : S.rgs.all();
  const workMbids = new Map();   // mbid -> workId (para traer compositores después)
  let linked = 0, done = 0;
  for (const rg of rgs) {
    if (LIMIT && done >= LIMIT) break; done++;
    let release = null;
    try {
      const rgf = await mb(`release-group/${rg.mbid}?inc=releases&fmt=json`);
      const rels = rgf.releases || [];
      release = rels.find(r => r.status === 'Official') || rels[0];
    } catch (e) { console.warn('  release-group', rg.title, e.message); continue; }
    if (!release) { console.log(`  —  ${rg.title} (sin edición en MB)`); continue; }
    let rf = null;
    try { rf = await mb(`release/${release.id}?inc=recordings+recording-level-rels+work-rels&fmt=json`); } catch (e) { console.warn('  release', rg.title, e.message); continue; }
    let rgLinked = 0;
    for (const m of (rf.media || [])) for (const tk of (m.tracks || [])) {
      const our = S.recByPos.get(rg.id, m.position, tk.position); if (!our) continue;
      const rec = tk.recording || {};
      if (rec.id) { const cur = S.recMbid.get(our.rid); if (cur && !cur.mbid) S.setRecMbid.run(rec.id, our.rid); }   // backfill mbid de grabación
      const perf = (rec.relations || []).find(r => r.type === 'performance' && r.work);
      if (!perf) continue;
      const wId = ensureWork(perf.work);
      S.setRecWork.run(wId, our.rid);
      workMbids.set(perf.work.id, wId);
      rgLinked++; linked++;
    }
    console.log(`  ${rgLinked ? '✓' : '·'}  ${rg.title}: ${rgLinked} grabación(es) con obra`);
  }

  // compositores por obra (y letristas/arreglistas)
  let comps = 0, works = 0;
  for (const [wmbid, wId] of workMbids) {
    if (!FORCE) { /* idempotente: borramos y reponemos igualmente para reflejar cambios */ }
    let wf = null; try { wf = await mb(`work/${wmbid}?inc=artist-rels&fmt=json`); } catch (e) { continue; }
    works++;
    S.delWorkCredits.run(wId);
    let pos = 0;
    for (const r of (wf.relations || [])) {
      if (r['target-type'] !== 'artist' || !r.artist) continue;
      const role = ROLE[r.type]; if (!role) continue;
      S.insCredit.run(wId, ensureArtist(r.artist.name, r.artist.id), role, pos++);
      comps++;
    }
  }
  console.log(`\nObras: ${linked} grabación(es) enlazadas a obra, ${works} obra(s) consultada(s), ${comps} crédito(s) de composición/letra -> ${DB_PATH}`);
  db.close();
}
run();
