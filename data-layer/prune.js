'use strict';
// escucharrr — poda del grafo: cierra el ciclo de la biblioteca en vivo.
// scan.js / obsidian-sync.js solo AÑADEN o ACTUALIZAN; aquí RESTAMOS: cuando desaparece
// un fichero de música o una nota del vault, hay que quitar del grafo lo que ya no sostiene
// nada. Conservador por diseño: nunca borra algo que todavía sostiene un fichero, una nota,
// datos del usuario (tier/rating/favorito/edición) o una lista. El historial de escucha se
// CONSERVA (se desvincula poniendo el id a NULL, no se borra la fila de `play`).
// Sin dependencias (node:fs/path + node:sqlite del llamador).

const fs = require('fs');
const path = require('path');

// Normaliza una ruta absoluta para comparar bajo Windows (separadores + minúsculas).
function norm(p) { return path.resolve(p).replace(/[\\/]+/g, '\\').toLowerCase(); }
function isUnder(file, root) {
  const f = norm(file), r = norm(root);
  return f === r || f.startsWith(r.endsWith('\\') ? r : r + '\\');
}

// Quita las filas `local_file` cuyo fichero ya no existe en disco, SOLO bajo las raíces dadas.
// Modelo Roon (ver memoria roon-storage-scanner): NUNCA equipara "no lo vi" con "ya no está".
//  - La AUTORIDAD es el recorrido del escaneo, no una segunda lectura aquí: `opts.okDirs` son las
//    carpetas enumeradas con éxito y `opts.seenPaths` todos los ficheros vistos en disco. Un fichero
//    solo es candidato a retirar si su carpeta está en okDirs (la leímos) y su ruta NO está en
//    seenPaths. Si su carpeta no se pudo leer (SMB caído), se conserva: no se confirma ausencia.
//  - LÁPIDA: un candidato no se borra de golpe; se marca `missing_since`/`missing_count++` y solo se
//    retira tras `missThreshold` escaneos limpios consecutivos sin verlo (un fallo transitorio nunca
//    basta). Verlo de nuevo limpia la lápida (lo hace el upsert de scan.js).
//  - GATE DE MONTAJE: si el montaje no está sano (raíz no enumerada o 0 ficheros), no se poda nada.
// Sin opts (compatibilidad), cae a la confirmación conservadora por listado de carpeta (con reintentos).
function pruneMissingFiles(db, roots, log, opts) {
  const live = (roots || []).filter(r => { try { return r && fs.existsSync(r); } catch (e) { return false; } });
  if (!live.length) return 0;
  const nf = (opts && opts.nrm) || norm;
  if (opts && opts.seenPaths && opts.okDirs) {
    if (opts.mountHealthy === false) { if (log) log('poda: OMITIDA (montaje no sano)'); return 0; }
    const thr = opts.missThreshold || 2;
    const del = db.prepare('DELETE FROM local_file WHERE id=?');
    const tomb = db.prepare("UPDATE local_file SET missing_since=COALESCE(missing_since, datetime('now')), missing_count=COALESCE(missing_count,0)+1 WHERE id=?");
    let removed = 0, tombed = 0, unreadable = 0;
    db.exec('BEGIN');
    try {
      for (const row of db.prepare('SELECT id, path, missing_count FROM local_file').all()) {
        if (!live.some(r => isUnder(row.path, r))) continue;             // fichero de otra raíz no vigilada ahora
        if (opts.seenPaths.has(nf(row.path))) continue;                  // visto en disco → presente (el upsert ya limpió la lápida)
        if (!opts.okDirs.has(nf(path.dirname(row.path)))) { unreadable++; continue; }  // carpeta no leída este escaneo → no confirmar ausencia
        // carpeta leída OK y fichero no visto → genuinamente ausente: lápida, y retira al llegar al umbral
        if ((row.missing_count || 0) + 1 >= thr) { del.run(row.id); removed++; }
        else { tomb.run(row.id); tombed++; }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (removed && log) log(`poda: ${removed} fichero(s) ausente(s) retirado(s) (tras ${thr} escaneo(s) limpios)`);
    if (tombed && log) log(`poda: ${tombed} fichero(s) marcado(s) ausente(s) por 1ª vez (lápida, aún no retirados)`);
    if (unreadable && log) log(`poda: ${unreadable} fichero(s) conservado(s) (carpeta no leída este escaneo)`);
    return removed;
  }
  // ── Camino de compatibilidad (sin opts): confirma por listado de carpeta con reintentos. ──
  const del = db.prepare('DELETE FROM local_file WHERE id=?');
  const dirCache = new Map();
  function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} }
  function listing(dir) {
    const key = norm(dir);
    if (dirCache.has(key)) return dirCache.get(key);
    let names = null;
    for (let i = 0; i < 4; i++) {   // reintentos ante fallo transitorio de SMB: 400/800/1200ms
      try { names = new Set(fs.readdirSync(dir).map(x => x.toLowerCase())); break; }
      catch (e) { if (i < 3) sleepSync(400 * (i + 1)); }
    }
    dirCache.set(key, names);
    return names;
  }
  let n = 0, kept = 0;
  db.exec('BEGIN');
  try {
    for (const row of db.prepare('SELECT id, path FROM local_file').all()) {
      if (!live.some(r => isUnder(row.path, r))) continue;      // fichero de otra raíz no vigilada ahora
      const names = listing(path.dirname(row.path));
      if (names === null) { kept++; continue; }                 // carpeta ilegible: no se confirma ausencia
      if (!names.has(path.basename(row.path).toLowerCase())) { del.run(row.id); n++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (n && log) log(`poda: ${n} fichero(s) ausente(s) quitado(s)`);
  if (kept && log) log(`poda: ${kept} fichero(s) conservado(s) (carpeta ilegible, no se confirma ausencia)`);
  return n;
}

// Limpia copias/versiones y discos que ya no sostienen ningún fichero. Al reagrupar por carpeta (modelo de
// versiones, estilo Roon) un reescaneo reasigna cada fichero al release/medio de SU carpeta; lo que queda del
// reparto antiguo (una copia "fundida", o discos sobrantes dentro de una copia adoptada) se queda sin ficheros
// y debe retirarse (si no, saldrían versiones o discos vacíos). Poda de ABAJO ARRIBA y conservadora: pista sin
// fichero (ni en lista) → medio sin pistas → release sin medios. NOTA: las pistas SOLO las crea el escaneo a
// partir de ficheros (el enriquecido no añade tracklist canónico), así que una pista sin fichero es siempre
// resto del reparto viejo. Conserva el historial: desvincula play.track_id antes de borrar. Se ejecuta ANTES
// de pruneGraph (que recoge grabaciones/álbumes ya huérfanos).
function pruneEmptyReleases(db, log) {
  const r = { track: 0, medium: 0, release: 0 };
  db.exec('BEGIN');
  try {
    // 1) pistas sin fichero (directo o por grabación sin pista) y que no estén en ninguna lista.
    const tracks = db.prepare(`
      SELECT tr.id FROM track tr WHERE
        NOT EXISTS (SELECT 1 FROM local_file   lf WHERE lf.track_id=tr.id OR (lf.recording_id=tr.recording_id AND lf.track_id IS NULL))
        AND NOT EXISTS (SELECT 1 FROM playlist_item pi WHERE pi.track_id=tr.id OR pi.recording_id=tr.recording_id)`).all();
    const nullPlay = db.prepare('UPDATE play SET track_id=NULL WHERE track_id=?');
    const delTrack = db.prepare('DELETE FROM track WHERE id=?');
    for (const t of tracks) { nullPlay.run(t.id); delTrack.run(t.id); r.track++; }
    // 2) medios que se quedaron sin pistas.
    r.medium = db.prepare('DELETE FROM medium WHERE NOT EXISTS (SELECT 1 FROM track tr WHERE tr.medium_id=medium.id)').run().changes;
    // 3) releases que se quedaron sin medios.
    r.release = db.prepare('DELETE FROM "release" WHERE NOT EXISTS (SELECT 1 FROM medium m WHERE m.release_id="release".id)').run().changes;
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const tot = r.track + r.medium + r.release;
  if (tot && log) log(`limpieza de copias: ${r.release} release(s), ${r.medium} disco(s), ${r.track} pista(s) sin fichero retirados`);
  return r;
}

// Recoge la basura del grafo: borra entidades que ya no ancla nada que el usuario quiera
// conservar. De arriba abajo (álbum → grabación → género/crédito/artista).
function pruneGraph(db, log) {
  const r = { release_group: 0, recording: 0, genre: 0, artist: 0 };
  db.exec('BEGIN');
  try {
    // 1) release_groups no anclados: sin nota de Obsidian, sin datos de usuario y sin ninguna
    //    pista que tenga fichero o esté en una lista.
    const rgs = db.prepare(`
      SELECT rg.id FROM release_group rg
      WHERE NOT EXISTS (SELECT 1 FROM obsidian_link ol WHERE ol.subject_type='release_group' AND ol.subject_id=rg.id)
        AND NOT EXISTS (SELECT 1 FROM rating_tier x WHERE x.subject_type='release_group' AND x.subject_id=rg.id)
        AND NOT EXISTS (SELECT 1 FROM rating      x WHERE x.subject_type='release_group' AND x.subject_id=rg.id)
        AND NOT EXISTS (SELECT 1 FROM flag        x WHERE x.subject_type='release_group' AND x.subject_id=rg.id)
        AND NOT EXISTS (SELECT 1 FROM user_edit   x WHERE x.subject_type='release_group' AND x.subject_id=rg.id)
        AND NOT EXISTS (
          SELECT 1 FROM "release" rel JOIN medium m ON m.release_id=rel.id JOIN track tr ON tr.medium_id=m.id
          WHERE rel.release_group_id=rg.id AND (
               -- fichero asignado a esta pista (directo), o fichero SIN pista que casa por grabación.
               -- El guard lf.track_id IS NULL evita que un fichero ya reasignado a OTRO album (al reagrupar
               -- multi-disco/versiones) ancle en falso al album viejo por compartir la grabacion.
               EXISTS (SELECT 1 FROM local_file   lf WHERE lf.track_id=tr.id OR (lf.recording_id=tr.recording_id AND lf.track_id IS NULL))
            OR EXISTS (SELECT 1 FROM playlist_item pi WHERE pi.track_id=tr.id OR pi.recording_id=tr.recording_id)
          ))`).all();
    // Antes de borrar (el CASCADE arrastra release→medium→track), conserva el historial:
    // desvincula play.track_id de las pistas que van a caer (play tiene FK a track).
    const nullPlayTr = db.prepare(`UPDATE play SET track_id=NULL WHERE track_id IN (
        SELECT tr.id FROM "release" rel JOIN medium m ON m.release_id=rel.id JOIN track tr ON tr.medium_id=m.id
        WHERE rel.release_group_id=?)`);
    const delRg = db.prepare('DELETE FROM release_group WHERE id=?');  // CASCADE → release/medium/track + release_group_genre
    for (const row of rgs) { nullPlayTr.run(row.id); delRg.run(row.id); r.release_group++; }

    // 2) grabaciones huérfanas: sin pista, sin fichero, sin lista y sin datos de usuario.
    const recs = db.prepare(`
      SELECT id FROM recording rec
      WHERE NOT EXISTS (SELECT 1 FROM track         t  WHERE t.recording_id=rec.id)
        AND NOT EXISTS (SELECT 1 FROM local_file    lf WHERE lf.recording_id=rec.id)
        AND NOT EXISTS (SELECT 1 FROM playlist_item pi WHERE pi.recording_id=rec.id)
        AND NOT EXISTS (SELECT 1 FROM rating    x WHERE x.subject_type='recording' AND x.subject_id=rec.id)
        AND NOT EXISTS (SELECT 1 FROM flag      x WHERE x.subject_type='recording' AND x.subject_id=rec.id)
        AND NOT EXISTS (SELECT 1 FROM user_edit x WHERE x.subject_type='recording' AND x.subject_id=rec.id)`).all();
    const nullPlayRec = db.prepare('UPDATE play SET recording_id=NULL WHERE recording_id=?');
    const delLyr = db.prepare('DELETE FROM lyrics WHERE recording_id=?');
    const delCr = db.prepare("DELETE FROM credit WHERE entity_type='recording' AND entity_id=?");
    const delRec = db.prepare('DELETE FROM recording WHERE id=?');
    for (const row of recs) { nullPlayRec.run(row.id); delLyr.run(row.id); delCr.run(row.id); delRec.run(row.id); r.recording++; }

    // 3) géneros ya sin ningún álbum enlazado.
    r.genre = db.prepare('DELETE FROM genre WHERE NOT EXISTS (SELECT 1 FROM release_group_genre g WHERE g.genre_id=genre.id)').run().changes;

    // 4) créditos de artista que no usa ninguna entidad (el CASCADE limpia sus nombres).
    db.prepare(`DELETE FROM artist_credit WHERE
         NOT EXISTS (SELECT 1 FROM release_group x WHERE x.artist_credit_id=artist_credit.id)
         AND NOT EXISTS (SELECT 1 FROM "release"  x WHERE x.artist_credit_id=artist_credit.id)
         AND NOT EXISTS (SELECT 1 FROM recording  x WHERE x.artist_credit_id=artist_credit.id)
         AND NOT EXISTS (SELECT 1 FROM track      x WHERE x.artist_credit_id=artist_credit.id)`).run();

    // 5) artistas sin crédito, sin rol y sin datos de usuario.
    r.artist = db.prepare(`DELETE FROM artist WHERE
         NOT EXISTS (SELECT 1 FROM artist_credit_name x WHERE x.artist_id=artist.id)
         AND NOT EXISTS (SELECT 1 FROM credit        x WHERE x.artist_id=artist.id)
         AND NOT EXISTS (SELECT 1 FROM rating_tier   x WHERE x.subject_type='artist' AND x.subject_id=artist.id)
         AND NOT EXISTS (SELECT 1 FROM flag          x WHERE x.subject_type='artist' AND x.subject_id=artist.id)
         AND NOT EXISTS (SELECT 1 FROM user_edit     x WHERE x.subject_type='artist' AND x.subject_id=artist.id)`).run().changes;

    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const tot = r.release_group + r.recording + r.genre + r.artist;
  if (tot && log) log(`poda del grafo: ${r.release_group} álbum(es), ${r.recording} grabación(es), ${r.genre} género(s), ${r.artist} artista(s)`);
  return r;
}

// Repara "discos fantasma" de rips con TPOS roto: algunos rips etiquetan DISCNUMBER = TRACKNUMBER, así que
// cada pista cae en SU PROPIO disco (N medios de 1 pista) y el álbum sale partido en N discos de una canción
// (p. ej. Coldplay "Ghost Stories" con 9 discos de 1 tema). Roon lo arregla identificando contra su nube;
// aquí lo detectamos por una FIRMA INEQUÍVOCA y conservadora para no tocar multidisco legítimo:
//   · el release tiene >1 medio y CADA medio tiene exactamente 1 pista (nº de discos == nº de pistas), y
//   · TODOS sus ficheros están en UNA sola carpeta (plana, sin subcarpetas de disco CD1/CD2…).
// Un multidisco real tiene varias pistas por disco (nº pistas > nº discos) o vive en subcarpetas → nunca casa.
// (Un 2-CD real con 1 tema por CD en carpeta plana es rarísimo; ese caso lo resolvería la identificación.)
// Colapsa: mueve todas las pistas al primer medio y borra los medios que quedan vacíos. Idempotente.
const _DISC_DIR_RE_P = /^(?:cd|dis[ck]|disco|disque|volume|vol)\s*\.?\s*0*(\d{1,2})$/i;
function collapseBogusDiscs(db, log) {
  const path = require('path');
  // Candidatos por el grafo: releases con >1 medio y una pista por medio (nº medios == nº pistas).
  const cand = db.prepare(`
    SELECT rel.id rel, COUNT(DISTINCT m.id) media, COUNT(tr.id) tracks
    FROM "release" rel JOIN medium m ON m.release_id=rel.id JOIN track tr ON tr.medium_id=m.id
    GROUP BY rel.id HAVING media>1 AND media=tracks`).all();
  if (!cand.length) return 0;
  const dirsOf = db.prepare(`SELECT DISTINCT lf.path FROM medium m JOIN track tr ON tr.medium_id=m.id
     JOIN local_file lf ON lf.track_id=tr.id WHERE m.release_id=?`);
  const mediaOf = db.prepare(`SELECT id, position FROM medium WHERE release_id=? ORDER BY position`);
  const moveTracks = db.prepare('UPDATE track SET medium_id=? WHERE medium_id=?');
  const delMed = db.prepare('DELETE FROM medium WHERE id=?');
  let fixed = 0;
  db.exec('BEGIN');
  try {
    for (const c of cand) {
      const paths = dirsOf.all(c.rel).map(r => r.path);
      if (!paths.length) continue;
      const dirs = new Set(paths.map(p => path.dirname(p).toLowerCase()));
      if (dirs.size !== 1) continue;                               // más de una carpeta → no es la firma (posible multidisco/versión)
      const only = path.basename([...dirs][0]);
      if (_DISC_DIR_RE_P.test(only)) continue;                     // la carpeta ES un disco (CD1…) → multidisco real
      const meds = mediaOf.all(c.rel);
      if (meds.length < 2) continue;
      const target = meds[0].id;                                   // primer medio (menor posición) = destino
      for (const m of meds.slice(1)) { moveTracks.run(target, m.id); delMed.run(m.id); }  // junta pistas y borra medios vacíos
      fixed++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (fixed && log) log(`discos fantasma reparados (TPOS roto, colapsados a 1 disco): ${fixed} álbum(es)`);
  return fixed;
}

module.exports = { pruneMissingFiles, pruneEmptyReleases, pruneGraph, collapseBogusDiscs, isUnder };
