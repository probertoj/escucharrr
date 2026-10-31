'use strict';
// escucharrr — editorial desde fuentes ABIERTAS: bio del artista + contexto/reseña del álbum
// desde Wikipedia (texto) resuelta por Wikidata vía MusicBrainz. Sin clave, sin dependencias
// (node:https + node:sqlite). Cacheado en local con PROCEDENCIA (provenance) visible en la UI.
// "Tus notas de Obsidian mandan": esto solo rellena lo externo; el user_edit sigue ganando al leer.
//
//   node editorial.js --db ../app/escucharrr.db [--lang es] [--limit N]
//        [--artists] [--albums]   (por defecto ambos)   [--rg ID] [--artist ID] [--force]
//
// Cadena por entidad con MBID:
//   MusicBrainz (inc=url-rels, 1 req/s + User-Agent) -> relación 'wikidata' (Q…)
//   Wikidata (Special:EntityData/Q….json) -> sitelink al idioma preferido (es, luego en)
//   Wikipedia REST (api/rest_v1/page/summary/<título>) -> extracto en texto + URL canónica
// Entidades sin MBID se saltan (identificador fuerte; no adivinamos por nombre).

const { DatabaseSync } = require('node:sqlite');
const https = require('node:https');
const path = require('path');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || true) : d; }
const DB_PATH = arg('db', path.join(__dirname, '..', 'app', 'escucharrr.db'));
const LANG = String(arg('lang', 'es'));                 // idioma preferido de Wikipedia
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;     // 0 = sin límite
const ONE_RG = arg('rg', null) != null ? parseInt(arg('rg'), 10) : null;
const ONE_ARTIST = arg('artist', null) != null ? parseInt(arg('artist'), 10) : null;
const FORCE = process.argv.includes('--force');
// por defecto ambos; si se pide uno explícito, solo ese
let DO_ARTISTS = process.argv.includes('--artists');
let DO_ALBUMS = process.argv.includes('--albums');
if (!DO_ARTISTS && !DO_ALBUMS && ONE_RG == null && ONE_ARTIST == null) { DO_ARTISTS = DO_ALBUMS = true; }
if (ONE_RG != null) DO_ALBUMS = true;
if (ONE_ARTIST != null) DO_ARTISTS = true;

const UA = 'escucharrr/0.1 (https://github.com/probertoj/escucharrr)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getJson(url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, res => {
      // sigue redirecciones simples (Wikipedia normaliza títulos con 301)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(getJson(new URL(res.headers.location, url).toString()));
      }
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(20000, () => req.destroy());
  });
}

// MusicBrainz: devuelve el Q-id de Wikidata (y una URL de Wikipedia directa si la hubiera).
async function mbWikidata(kind, mbid) {
  const ep = kind === 'artist' ? 'artist' : 'release-group';
  const url = `https://musicbrainz.org/ws/2/${ep}/${mbid}?inc=url-rels&fmt=json`;
  let r = await getJson(url);
  await sleep(1100);                                    // cortesía MB: ~1 req/s
  if (r.status === 503 || !r.json) { await sleep(2000); r = await getJson(url); await sleep(1100); }  // un reintento ante 503/vacío
  const rels = (r.json && r.json.relations) || [];
  let qid = null, wiki = null;
  for (const rel of rels) {
    const u = rel.url && rel.url.resource;
    if (!u) continue;
    if (rel.type === 'wikidata') { const m = u.match(/(Q\d+)/); if (m) qid = m[1]; }
    else if (rel.type === 'wikipedia') wiki = u;        // fallback: p. ej. https://es.wikipedia.org/wiki/Título
  }
  return { qid, wiki };
}

// Wikidata: del Q-id al (idioma, título) del sitelink preferido.
async function wikidataSitelink(qid) {
  const r = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  const ent = r.json && r.json.entities && r.json.entities[qid];
  const sl = (ent && ent.sitelinks) || {};
  for (const lang of [LANG, 'en']) if (sl[lang + 'wiki']) return { lang, title: sl[lang + 'wiki'].title };
  // si no está en es/en, toma el primer sitelink de Wikipedia que haya
  const any = Object.keys(sl).find(k => k.endsWith('wiki') && !/wikiquote|wikisource|commons|wikinews|wikivoyage|wiktionary/.test(k));
  return any ? { lang: any.replace(/wiki$/, ''), title: sl[any].title } : null;
}

// Wikipedia REST: extracto en texto plano + URL canónica. Descarta desambiguaciones.
async function wikipediaSummary(lang, title) {
  const r = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  const j = r.json;
  if (!j || !j.extract || j.type === 'disambiguation') return null;
  const url = (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  return { extract: j.extract.trim(), url, lang };
}

// Resuelve el texto editorial de una entidad (o null si no hay artículo).
async function resolveEditorial(kind, mbid) {
  const { qid, wiki } = await mbWikidata(kind, mbid);
  if (qid) {
    const sl = await wikidataSitelink(qid);
    if (sl) { const s = await wikipediaSummary(sl.lang, sl.title); if (s) return s; }
  }
  // fallback: URL de Wikipedia directa de MB (extrae idioma + título de la URL)
  if (wiki) {
    const m = wiki.match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/);
    if (m) { const s = await wikipediaSummary(m[1], decodeURIComponent(m[2])); if (s) return s; }
  }
  return null;
}

// ── main ──────────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
require('./migrate').migrate(db);                       // garantiza release_group.about

const S = {
  artists: db.prepare(`SELECT id, name, mbid FROM artist WHERE mbid IS NOT NULL${ONE_ARTIST != null ? ' AND id=?' : ''} ORDER BY id`),
  albums: db.prepare(`SELECT id, title, mbid FROM release_group WHERE mbid IS NOT NULL${ONE_RG != null ? ' AND id=?' : ''} ORDER BY id`),
  provGet: db.prepare('SELECT 1 FROM provenance WHERE subject_type=? AND subject_id=? AND field=?'),
  setBio: db.prepare("UPDATE artist SET bio=?, updated_at=datetime('now') WHERE id=?"),
  setAbout: db.prepare("UPDATE release_group SET about=?, updated_at=datetime('now') WHERE id=?"),
  prov: db.prepare(`INSERT INTO provenance(subject_type,subject_id,field,source,source_ref,fetched_at)
     VALUES(?,?,?,?,?,datetime('now'))
     ON CONFLICT(subject_type,subject_id,field) DO UPDATE SET source=excluded.source, source_ref=excluded.source_ref, fetched_at=datetime('now')`),
};

async function run() {
  let found = 0, miss = 0, skip = 0, done = 0;
  const targets = [];
  if (DO_ARTISTS) for (const a of (ONE_ARTIST != null ? S.artists.all(ONE_ARTIST) : S.artists.all())) targets.push({ kind: 'artist', field: 'bio', id: a.id, name: a.name, mbid: a.mbid });
  if (DO_ALBUMS) for (const a of (ONE_RG != null ? S.albums.all(ONE_RG) : S.albums.all())) targets.push({ kind: 'release_group', field: 'about_editorial', id: a.id, name: a.title, mbid: a.mbid });

  for (const t of targets) {
    if (LIMIT && done >= LIMIT) break;
    if (!FORCE && S.provGet.get(t.kind, t.id, t.field)) { skip++; continue; }   // ya cacheado
    done++;
    let ed = null; try { ed = await resolveEditorial(t.kind === 'artist' ? 'artist' : 'rg', t.mbid); } catch (e) { console.warn('  error', t.name, e.message); }
    if (!ed) { miss++; console.log(`  —  ${t.kind === 'artist' ? 'artista' : 'álbum'}: ${t.name} (sin artículo)`); continue; }
    const src = 'wikipedia';                              // texto de Wikipedia (resuelto vía Wikidata/MB)
    if (t.kind === 'artist') S.setBio.run(ed.extract, t.id); else S.setAbout.run(ed.extract, t.id);
    S.prov.run(t.kind, t.id, t.field, src, ed.url);
    found++;
    console.log(`  ✓  ${t.kind === 'artist' ? 'artista' : 'álbum'}: ${t.name} → ${ed.url} [${ed.lang}]`);
  }

  // refrescar FTS no hace falta (no cambian títulos/nombres); el texto editorial no se indexa.
  console.log(`\nEditorial: ${found} con artículo, ${miss} sin artículo, ${skip} ya en caché (de ${targets.length} con MBID) -> ${DB_PATH}`);
  db.close();
}
run();
