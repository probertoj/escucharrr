'use strict';
// escucharrr — sincroniza un vault de Obsidian al grafo canónico (SQLite).
// Sin dependencias: usa node:sqlite (Node >= 22.5 / 24). Idempotente.
//   node obsidian-sync.js --db escucharrr.db --config config.example.json [--demo]
// Las notas de Obsidian MANDAN: tier/rating/bio se marcan con source='obsidian'
// y quedan en user_edit/provenance.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? (process.argv[i + 1] || true) : def; }
const DB_PATH = arg('db', 'escucharrr.db');
const CFG_PATH = arg('config', 'config.example.json');
const DEMO = process.argv.includes('--demo');
const PRUNE = !process.argv.includes('--no-prune');   // poda notas ausentes + GC del grafo

const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ── frontmatter (YAML plano: key: value, y listas inline [a, b]) ──────────────
function parseNote(text) {
  if (!text.startsWith('---')) return { fm: {}, body: text.trim() };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: text.trim() };
  const block = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\s*\r?\n/, '').trim();
  const fm = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:#][^:]*?)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else val = val.replace(/^["']|["']$/g, '');
    fm[key] = val;
  }
  return { fm, body };
}
const pick = (fm, keys) => { for (const k of keys || []) if (fm[k] != null && fm[k] !== '') return fm[k]; return null; };
function parseFilename(base) {
  const sep = ' - ';
  const i = base.indexOf(sep);
  return i > 0 ? { artist: base.slice(0, i).trim(), album: base.slice(i + sep.length).trim() } : { artist: null, album: base };
}
const normTier = (v) => v == null ? null : (cfg.tierMap[String(v).trim().toLowerCase()] || null);

// ── statements ────────────────────────────────────────────────────────────────
const S = {
  artistByName: db.prepare('SELECT id FROM artist WHERE name = ?'),
  insArtist: db.prepare('INSERT INTO artist(name, sort_name) VALUES(?, ?)'),
  creditForArtist: db.prepare(`SELECT acn.artist_credit_id AS id FROM artist_credit_name acn
     WHERE acn.position=1 AND acn.artist_id=? AND acn.name=?
       AND (SELECT COUNT(*) FROM artist_credit_name x WHERE x.artist_credit_id=acn.artist_credit_id)=1 LIMIT 1`),
  insCredit: db.prepare('INSERT INTO artist_credit DEFAULT VALUES'),
  insCreditName: db.prepare('INSERT INTO artist_credit_name(artist_credit_id,position,artist_id,name,join_phrase) VALUES(?,1,?,?,\'\')'),
  rgByTitleCredit: db.prepare('SELECT id FROM release_group WHERE title=? AND artist_credit_id=?'),
  insRg: db.prepare('INSERT INTO release_group(title, artist_credit_id, primary_type, first_release) VALUES(?,?,?,?)'),
  updRg: db.prepare('UPDATE release_group SET first_release=?, updated_at=datetime(\'now\') WHERE id=?'),
  genreByName: db.prepare('SELECT id FROM genre WHERE name=?'),
  insGenre: db.prepare('INSERT INTO genre(name) VALUES(?)'),
  linkGenre: db.prepare('INSERT OR IGNORE INTO release_group_genre(release_group_id,genre_id) VALUES(?,?)'),
  getTier: db.prepare('SELECT tier_key FROM rating_tier WHERE subject_type=? AND subject_id=?'),
  setTier: db.prepare(`INSERT INTO rating_tier(subject_type,subject_id,tier_key,source,updated_at)
     VALUES(?,?,?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id) DO UPDATE SET tier_key=excluded.tier_key, source=excluded.source, updated_at=datetime('now')`),
  getRating: db.prepare('SELECT stars FROM rating WHERE subject_type=? AND subject_id=?'),
  setRating: db.prepare(`INSERT INTO rating(subject_type,subject_id,stars,source,updated_at)
     VALUES(?,?,?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id) DO UPDATE SET stars=excluded.stars, source=excluded.source, updated_at=datetime('now')`),
  event: db.prepare('INSERT INTO rating_event(subject_type,subject_id,kind,value,source) VALUES(?,?,?,?,?)'),
  prov: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at)
     VALUES(?,?,?,?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`),
  edit: db.prepare(`INSERT INTO user_edit(subject_type,subject_id,field,value,updated_at)
     VALUES(?,?,?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`),
  setBio: db.prepare('UPDATE release_group SET updated_at=datetime(\'now\') WHERE id=?'),
  note: db.prepare(`INSERT INTO obsidian_note(vault,path,mtime,frontmatter_json,body_md)
     VALUES(?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, frontmatter_json=excluded.frontmatter_json, body_md=excluded.body_md
     RETURNING id`),
  link: db.prepare('INSERT OR REPLACE INTO obsidian_link(note_id,subject_type,subject_id,match_by,match_conf) VALUES(?,?,?,?,?)'),
};

function ensureArtist(name) {
  const r = S.artistByName.get(name);
  if (r) return r.id;
  return Number(S.insArtist.run(name, name).lastInsertRowid);
}
function ensureCredit(artistId, name) {
  const r = S.creditForArtist.get(artistId, name);
  if (r) return r.id;
  const cid = Number(S.insCredit.run().lastInsertRowid);
  S.insCreditName.run(cid, artistId, name);
  return cid;
}
function ensureRg(title, creditId, type, year) {
  const r = S.rgByTitleCredit.get(title, creditId);
  if (r) { if (year) S.updRg.run(year, r.id); return r.id; }
  return Number(S.insRg.run(title, creditId, type, year).lastInsertRowid);
}
function ensureGenre(name) {
  const r = S.genreByName.get(name);
  return r ? r.id : Number(S.insGenre.run(name).lastInsertRowid);
}

// ── sync ────────────────────────────────────────────────────────────────────
const vaultRoot = path.resolve(path.dirname(CFG_PATH), cfg.vault);
let dir = path.join(vaultRoot, cfg.albumsFolder || '');
// Si la carpeta de álbumes configurada no existe, cae a la RAÍZ del vault (caso común: las
// notas están directamente en el vault). Evita el crash por ENOENT y "arregla" la config.
if (cfg.albumsFolder && !fs.existsSync(dir)) {
  console.warn('  aviso: la carpeta de álbumes "' + cfg.albumsFolder + '" no existe en el vault; uso la raíz del vault');
  cfg.albumsFolder = ''; dir = vaultRoot;
}
let files = [];
try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')); }
catch (e) { console.error('  no se puede leer la carpeta del vault:', dir, '(' + (e.code || e.message) + '); 0 notas'); }
let n = 0;
db.exec('BEGIN');
try {
  for (const file of files) {
    const abs = path.join(dir, file);
    const text = fs.readFileSync(abs, 'utf8');
    const { fm, body } = parseNote(text);
    const base = file.replace(/\.md$/i, '');
    const fromName = parseFilename(base);
    const artist = pick(fm, cfg.fields.artist) || fromName.artist;
    const album = pick(fm, cfg.fields.album) || fromName.album;
    if (!artist || !album) { console.warn('  (saltada, sin artista/álbum):', file); continue; }
    const year = pick(fm, cfg.fields.year);
    const tier = normTier(pick(fm, cfg.fields.tier));
    let rating = pick(fm, cfg.fields.rating); rating = rating == null ? null : parseFloat(rating);
    let genres = pick(fm, cfg.fields.genre) || [];
    if (typeof genres === 'string') genres = [genres];

    const artistId = ensureArtist(artist);
    const creditId = ensureCredit(artistId, artist);
    const rgId = ensureRg(album, creditId, 'album', year ? String(year) : null);

    for (const g of genres) if (g) S.linkGenre.run(rgId, ensureGenre(g));

    const rel = path.join(cfg.albumsFolder, file);
    if (tier) {
      const cur = S.getTier.get('release_group', rgId);
      S.setTier.run('release_group', rgId, tier, 'obsidian');
      if (!cur || cur.tier_key !== tier) S.event.run('release_group', rgId, 'tier', tier, 'obsidian');
      S.prov.run('release_group', rgId, 'tier', 'obsidian', rel);
      S.edit.run('release_group', rgId, 'tier', tier);
    }
    if (rating != null && !Number.isNaN(rating)) {
      const cur = S.getRating.get('release_group', rgId);
      S.setRating.run('release_group', rgId, rating, 'obsidian');
      if (!cur || cur.stars !== rating) S.event.run('release_group', rgId, 'stars', String(rating), 'obsidian');
      S.prov.run('release_group', rgId, 'rating', 'obsidian', rel);
    }
    if (body) { S.edit.run('release_group', rgId, 'about', body); S.prov.run('release_group', rgId, 'about', 'obsidian', rel); }

    const noteId = Number(S.note.get(cfg.vault, rel, String(fs.statSync(abs).mtimeMs), JSON.stringify(fm), body).id);
    S.link.run(noteId, 'release_group', rgId, fm.mbid ? 'frontmatter_mbid' : 'artist_title', fm.mbid ? 1.0 : 0.9);
    n++;
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

// Poda: si una nota del vault ya no existe, deshaz JUSTO lo que aportó (según la procedencia:
// tier/rating/"acerca de" con source='obsidian') y quita la nota; luego recoge la basura del
// grafo (un álbum que solo existía por su nota desaparece). Así "tus notas mandan" también al
// borrar. Solo poda si la carpeta del vault existe (evita vaciados si el vault no está montado).
if (PRUNE && fs.existsSync(dir)) {
  const prune = require('./prune');
  const inFolder = (relPath) => {
    const p = relPath.replace(/\\/g, '/').toLowerCase();
    const pre = cfg.albumsFolder.replace(/\\/g, '/').toLowerCase();
    return p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/');
  };
  const provOf = db.prepare("SELECT subject_type, subject_id, field FROM provenance WHERE source='obsidian' AND source_ref=?");
  const delTier = db.prepare("DELETE FROM rating_tier WHERE subject_type=? AND subject_id=? AND source='obsidian'");
  const delRating = db.prepare("DELETE FROM rating WHERE subject_type=? AND subject_id=? AND source='obsidian'");
  const delEdit = db.prepare('DELETE FROM user_edit WHERE subject_type=? AND subject_id=? AND field=?');
  const delProv = db.prepare('DELETE FROM provenance WHERE subject_type=? AND subject_id=? AND field=?');
  const delNote = db.prepare('DELETE FROM obsidian_note WHERE id=?');   // CASCADE → obsidian_link
  let gone = 0;
  db.exec('BEGIN');
  try {
    for (const nt of db.prepare('SELECT id, path FROM obsidian_note').all()) {
      if (!inFolder(nt.path)) continue;                                  // nota de otra carpeta no sincronizada ahora
      let exists = false; try { exists = fs.existsSync(path.join(vaultRoot, nt.path)); } catch (e) {}
      if (exists) continue;
      for (const pr of provOf.all(nt.path)) {                            // deshacer lo aportado por la nota
        if (pr.field === 'tier') delTier.run(pr.subject_type, pr.subject_id);
        else if (pr.field === 'rating') delRating.run(pr.subject_type, pr.subject_id);
        delEdit.run(pr.subject_type, pr.subject_id, pr.field);
        delProv.run(pr.subject_type, pr.subject_id, pr.field);
      }
      delNote.run(nt.id); gone++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (gone) console.log(`  poda: ${gone} nota(s) ausente(s) quitada(s)`);
  prune.pruneGraph(db, (m) => console.log('  ' + m));
}

// Reconstruir el índice de búsqueda (instantánea = prefijo FTS5; completa = bm25)
db.exec('DELETE FROM search_fts');
db.exec(`INSERT INTO search_fts(name,kind,subject_type,subject_id)
  SELECT name,'artist','artist',id FROM artist`);
db.exec(`INSERT INTO search_fts(name,kind,subject_type,subject_id)
  SELECT title,'album','release_group',id FROM release_group`);
db.exec(`INSERT INTO search_fts(name,kind,subject_type,subject_id)
  SELECT title,'track','recording',id FROM recording`);

console.log(`Sincronizadas ${n} notas -> ${DB_PATH}`);

// ── demo: demuestra que tier/rating son consultables ──────────────────────────
if (DEMO) {
  const show = (label, rows) => { console.log('\n== ' + label + ' =='); rows.forEach(r => console.log('  ' + Object.values(r).join('  |  '))); };
  show('Excel sin valorar (tier=Excel y sin estrellas)',
    db.prepare(`SELECT artist, title FROM v_album WHERE tier_key='excel' AND album_stars IS NULL ORDER BY title`).all());
  show('4 estrellas o mas',
    db.prepare(`SELECT artist, title, round(album_stars,1) AS stars FROM v_album WHERE album_stars >= 4 ORDER BY album_stars DESC`).all());
  show('Conteo por tier (faceta del Focus)',
    db.prepare(`SELECT label, n FROM v_focus_tier`).all());
  show("Busqueda instantanea por prefijo: 'mar'",
    db.prepare(`SELECT kind, name FROM search_fts WHERE search_fts MATCH 'mar*' ORDER BY kind`).all());
  show('Procedencia del tier de "Marea baja"',
    db.prepare(`SELECT p.field, p.source, p.source_ref FROM provenance p
       JOIN release_group rg ON rg.id=p.subject_id AND p.subject_type='release_group'
       WHERE rg.title='Marea baja'`).all());
}
db.close();
