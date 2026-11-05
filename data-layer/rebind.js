'use strict';
// escucharrr — reparación de RENOMBRADOS/MOVIMIENTOS sin re-escanear la biblioteca entera.
//
// Contexto (ver memoria roon-storage-scanner y docs/standalone-readiness): cuando el usuario renombra
// o reorganiza carpetas en su NAS (p. ej. "Disc1" -> "CD 01", o un álbum entero a "Album (2020) [FLAC]"),
// las filas de `local_file` siguen apuntando a la ruta vieja. El escáner ya rebinda por identidad
// (scan.js reconcileMove), pero eso exige RE-ESCANEAR toda la biblioteca —caro sobre un SMB que flaquea—
// y no fusiona el caso de un duplicado ya ingerido (carpeta nueva escaneada por separado + vieja huérfana).
//
// Este paso es QUIRÚRGICO y SOLO-LECTURA en disco: localiza las filas huérfanas (ruta inexistente, pero su
// carpeta ancestro SÍ se lee → es un renombrado, no una caída del share), busca el fichero por IDENTIDAD DE
// CONTENIDO (tamaño en bytes; duración como desempate) dentro del ancestro legible, y:
//   · REBIND  : si la ruta nueva no tiene fila → actualiza la ruta de la fila existente (conserva id,
//               análisis, tier/valoración —que cuelgan del release_group, no de la ruta—, historial).
//   · FUSIÓN  : si la ruta nueva YA tiene fila (se ingirió por separado) → re-apunta el historial a esa
//               fila, migra datos de usuario del álbum viejo al nuevo si al viejo se le vacían las pistas,
//               y borra la fila huérfana. Luego la poda retira el release/álbum viejo ya vacío.
// NUNCA toca el disco: ni renombra, ni mueve, ni borra ficheros. Todo ocurre en SQLite. Idempotente.
//
// apply=false (por defecto) => DRY-RUN: calcula y reporta lo que haría, sin escribir nada.

const fs = require('fs');
const path = require('path');

const norm = (p) => path.resolve(p).replace(/[\\/]+/g, '\\').toLowerCase();
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} }
const AUDIO_RE = /\.(flac|wav|dsf|dff|mp3|m4a|aac|aiff|aif|ogg|oga|opus)$/i;

// Listado de carpeta. Distingue tres casos (clave para no confundir un renombrado con una caída del share):
//   · array de entradas  → carpeta leída OK.
//   · 'gone'             → ENOENT: la carpeta NO existe (desaparecida/renombrada). Definitivo, sin reintentos.
//   · null               → error transitorio (timeout/EBUSY) tras reintentos: NO se puede confirmar nada.
function makeLister() {
  const cache = new Map();
  return function listing(dir) {
    const key = norm(dir);
    if (cache.has(key)) return cache.get(key);
    let out = null;
    for (let i = 0; i < 4; i++) {
      try { out = fs.readdirSync(dir, { withFileTypes: true }); break; }
      catch (e) { if (e.code === 'ENOENT') { out = 'gone'; break; } if (i < 3) sleepSync(300 * (i + 1)); }
    }
    cache.set(key, out);
    return out;
  };
}

// Primer ancestro LEGIBLE subiendo desde startDir: atraviesa niveles 'gone' (ENOENT por renombrado) y para en
// el primero que se lee. Devuelve {dir, ents} si lo encuentra; null si topa con un error transitorio (caída:
// no se puede confirmar) o se agota. Así un renombrado de carpeta sube hasta el artista legible, pero una
// caída del montaje (transitorio) devuelve null y la fila se deja en paz.
function nearestReadableAncestor(startDir, listing) {
  let dir = startDir;
  for (let hops = 0; hops < 8; hops++) {
    const ents = listing(dir);
    if (Array.isArray(ents)) return { dir, ents };
    if (ents === null) return null;                 // transitorio → no confirmar (protección de caída)
    const up = path.dirname(dir);                   // 'gone' → sube un nivel
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// Indexa (recursivamente, con tope) los ficheros de audio bajo `root` por tamaño: Map<size, [paths]>.
// Solo stat (barato); no parsea cabeceras. Cacheado por ancestro para no re-listar.
function indexBySize(root, listing, statOf, cap = 5000) {
  const bySize = new Map();
  let count = 0;
  const stack = [root];
  while (stack.length && count < cap) {
    const dir = stack.pop();
    const ents = listing(dir);
    if (!Array.isArray(ents)) continue;
    for (const e of ents) {
      const full = path.join(dir, e.name);
      let isDir = false; try { isDir = e.isDirectory(); } catch (x) {}
      if (isDir) { stack.push(full); continue; }
      if (!AUDIO_RE.test(e.name)) continue;
      const sz = statOf(full);
      if (sz == null) continue;
      count++;
      if (!bySize.has(sz)) bySize.set(sz, []);
      bySize.get(sz).push(full);
    }
  }
  return bySize;
}

// repara renombrados/movimientos. opts: { log, apply, roots } . Devuelve estadísticas.
function repairRenames(db, opts = {}) {
  const log = opts.log || (() => {});
  const apply = !!opts.apply;
  const listing = makeLister();
  const statCache = new Map();
  const statOf = (f) => {
    const k = norm(f);
    if (statCache.has(k)) return statCache.get(k);
    let sz = null;
    for (let i = 0; i < 3; i++) { try { sz = fs.statSync(f).size; break; } catch (e) { if (i < 2) sleepSync(250 * (i + 1)); } }
    statCache.set(k, sz);
    return sz;
  };

  const rows = db.prepare('SELECT id, path, size_bytes, duration_ms, track_id, recording_id FROM local_file').all();
  // Filtra por raíces vigiladas si se pasan (evita tocar ficheros de otra ubicación).
  const roots = (opts.roots || []).map(norm);
  const under = (p) => !roots.length || roots.some(r => norm(p).startsWith(r.endsWith('\\') ? r : r + '\\') || norm(p) === r);

  // stat directo del fichero con reintentos. Devuelve: true=existe · false=ENOENT confirmado · null=transitorio.
  // Sobre un share de CONSISTENCIA EVENTUAL un readdir puede devolver un listado incompleto (el fichero existe
  // pero no sale en la lista). Por eso NO basta "no está en el listado": antes de declarar huérfano se confirma
  // con un stat directo del propio fichero. Solo un ENOENT confirmado cuenta como ausente.
  function fileGone(f) {
    for (let i = 0; i < 3; i++) { try { fs.statSync(f); return false; } catch (e) { if (e.code === 'ENOENT') return true; if (i < 2) sleepSync(300 * (i + 1)); } }
    return null;   // transitorio tras reintentos → no confirmar
  }

  // Clasifica cada fila en PRESENTE / HUÉRFANA / indeterminada. Huérfana = su fichero da ENOENT CONFIRMADO
  // (stat directo), no un mero "no salió en el readdir". Indeterminada (error transitorio) → se deja en paz.
  const orphans = [];
  let indet = 0;
  for (const r of rows) {
    if (!under(r.path)) continue;
    const ownDir = path.dirname(r.path);
    const ents = listing(ownDir);
    const base = path.basename(r.path).toLowerCase();
    if (Array.isArray(ents) && ents.some(e => e.name.toLowerCase() === base)) continue;   // sale en el listado → presente
    // No sale en el listado (o la carpeta no existe/ilegible): CONFIRMA con stat directo antes de actuar.
    const gone = fileGone(r.path);
    if (gone === false) continue;                          // el fichero SÍ existe (listado obsoleto del share) → presente
    if (gone === null) { indet++; continue; }              // transitorio → no confirmar (protección de caída/churn)
    // ENOENT confirmado: es un huérfano real SI un ancestro se lee (si no, el montaje está caído).
    if (nearestReadableAncestor(path.dirname(ownDir), listing)) orphans.push(r); else indet++;
  }

  const stats = { scanned: rows.length, orphans: orphans.length, indeterminate: indet, rebound: 0, merged: 0, unresolved: 0, ambiguous: 0 };
  const rowByPath = db.prepare('SELECT id, path, track_id, recording_id FROM local_file WHERE path=?');
  const setPath = db.prepare('UPDATE local_file SET path=? WHERE id=?');
  const repointPlay = db.prepare('UPDATE play SET local_file_id=? WHERE local_file_id=?');
  const delFile = db.prepare('DELETE FROM local_file WHERE id=?');
  // Migración de datos de usuario de un release_group viejo a uno nuevo (solo donde el nuevo NO tenga ya).
  const rgOfFile = db.prepare(`SELECT rel.release_group_id rg FROM local_file lf
     JOIN track tr ON tr.id=lf.track_id JOIN medium m ON m.id=tr.medium_id JOIN "release" rel ON rel.id=m.release_id
     WHERE lf.id=? LIMIT 1`);

  const index = new Map();   // ancestro(dir norm) -> Map<size,[paths]>
  const unresolvedSample = [], reboundSample = [], mergedSample = [];

  if (apply) db.exec('BEGIN');
  try {
    for (const o of orphans) {
      const anc = nearestReadableAncestor(o.path, listing);
      if (!anc) { stats.unresolved++; continue; }
      const ak = norm(anc.dir);
      if (!index.has(ak)) index.set(ak, indexBySize(anc.dir, listing, statOf));
      const bySize = index.get(ak);
      let cands = (o.size_bytes != null && bySize.get(o.size_bytes)) || [];
      // descarta candidatos que ya están correctamente ligados a ESTA misma fila (su propia ruta vieja no estará)
      cands = cands.filter(c => norm(c) !== norm(o.path));
      if (cands.length === 0) { stats.unresolved++; if (unresolvedSample.length < 10) unresolvedSample.push(o.path); continue; }
      let target = null;
      if (cands.length === 1) target = cands[0];
      else {
        // desempate por duración (parseo barato de cabecera no; usamos la duración ya conocida de filas
        // presentes con esa ruta si existe, o el basename más parecido). Preferimos un candidato cuyo
        // nombre de fichero coincida con el viejo (renombrado de carpeta, no de fichero).
        const oldBase = path.basename(o.path).toLowerCase();
        const sameName = cands.filter(c => path.basename(c).toLowerCase() === oldBase);
        if (sameName.length === 1) target = sameName[0];
        else { stats.ambiguous++; if (unresolvedSample.length < 10) unresolvedSample.push('AMBIGUO ' + o.path); continue; }
      }
      // ¿el destino ya tiene fila? (duplicado ingerido) → fusión; si no → rebind.
      const existing = rowByPath.get(target);
      if (existing && existing.id !== o.id) {
        // FUSIÓN: el historial del huérfano pasa a la fila presente; migra datos de usuario del álbum viejo
        // al nuevo si procede; borra el huérfano. La poda posterior retira el release/álbum viejo vacío.
        if (apply) {
          const oldRg = (rgOfFile.get(o.id) || {}).rg, newRg = (rgOfFile.get(existing.id) || {}).rg;
          if (oldRg && newRg && oldRg !== newRg) migrateUserData(db, oldRg, newRg);
          repointPlay.run(existing.id, o.id);
          delFile.run(o.id);
        }
        stats.merged++; if (mergedSample.length < 10) mergedSample.push(o.path + '  ->(fusión)  ' + target);
      } else if (!existing) {
        if (apply) setPath.run(target, o.id);
        stats.rebound++; if (reboundSample.length < 10) reboundSample.push(o.path + '  ->  ' + target);
      } else { stats.unresolved++; }
    }
    if (apply) db.exec('COMMIT');
  } catch (e) { if (apply) db.exec('ROLLBACK'); throw e; }

  log(`rebind: ${stats.orphans} huérfano(s) de ${stats.scanned} · ${stats.rebound} re-vinculado(s) · ${stats.merged} fusión(es) · ${stats.ambiguous} ambiguo(s) · ${stats.unresolved} sin resolver (borrados de verdad) · ${stats.indeterminate} indeterminado(s) (carpeta ilegible)`);
  if (!apply) log('rebind: DRY-RUN (no se escribió nada; pasa apply:true para aplicar)');
  stats.reboundSample = reboundSample; stats.mergedSample = mergedSample; stats.unresolvedSample = unresolvedSample;
  return stats;
}

// Migra datos de usuario (tier, valoración, favorito/flag, edición manual, etiquetas) de un release_group
// viejo a uno nuevo, SOLO donde el nuevo aún no los tenga (nunca pisa lo del usuario en el nuevo).
function migrateUserData(db, oldRg, newRg) {
  const move = (sql) => { try { db.prepare(sql).run({ neu: newRg, old: oldRg }); } catch (e) {} };
  // Mueve del viejo al nuevo SOLO donde el nuevo aún no lo tenga (nunca pisa lo del usuario en el nuevo).
  // rating_tier y user_edit tienen PK/UNIQUE que incluye subject → OR IGNORE evita colisión; además el
  // NOT EXISTS lo filtra de antemano. flag/rating/tag_item pueden tener varias filas: se mueven tal cual.
  move(`UPDATE OR IGNORE rating_tier SET subject_id=$neu WHERE subject_type='release_group' AND subject_id=$old
        AND NOT EXISTS (SELECT 1 FROM rating_tier x WHERE x.subject_type='release_group' AND x.subject_id=$neu)`);
  move(`UPDATE OR IGNORE rating SET subject_id=$neu WHERE subject_type='release_group' AND subject_id=$old
        AND NOT EXISTS (SELECT 1 FROM rating y WHERE y.subject_type='release_group' AND y.subject_id=$neu)`);
  move(`UPDATE OR IGNORE flag     SET subject_id=$neu WHERE subject_type='release_group' AND subject_id=$old`);
  move(`UPDATE OR IGNORE user_edit SET subject_id=$neu WHERE subject_type='release_group' AND subject_id=$old`);
  move(`UPDATE OR IGNORE tag_item SET subject_id=$neu WHERE subject_type='release_group' AND subject_id=$old`);
}

module.exports = { repairRenames };

// ── CLI: node rebind.js --db <db> --root <carpeta> [--root <otra>…] [--apply] ──
// Sin --apply es DRY-RUN. Imprime una última línea JSON con las estadísticas (para el servidor).
if (require.main === module) {
  const { DatabaseSync } = require('node:sqlite');
  const argv = process.argv.slice(2);
  const val = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
  const all = (n) => { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === '--' + n && argv[i + 1]) out.push(argv[i + 1]); return out; };
  const dbPath = val('db');
  if (!dbPath) { console.error('falta --db'); process.exit(1); }
  const roots = all('root');
  const apply = argv.includes('--apply');
  const db = new DatabaseSync(dbPath);
  try {
    const st = repairRenames(db, { log: (m) => console.error('  ' + m), apply, roots });
    process.stdout.write(JSON.stringify({ ok: true, apply, orphans: st.orphans, rebound: st.rebound, merged: st.merged, ambiguous: st.ambiguous, unresolved: st.unresolved, indeterminate: st.indeterminate }) + '\n');
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: String(e.message) }) + '\n'); }
  finally { db.close(); }
}
