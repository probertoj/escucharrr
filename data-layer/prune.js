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
// Robusto ante unidades desmontadas: si la raíz entera no existe no poda nada bajo ella (evita
// vaciar la biblioteca cuando un disco está desconectado), y cada fichero se confirma ausente
// individualmente con fs.existsSync antes de borrarlo.
function pruneMissingFiles(db, roots, log) {
  const live = (roots || []).filter(r => { try { return r && fs.existsSync(r); } catch (e) { return false; } });
  if (!live.length) return 0;
  const del = db.prepare('DELETE FROM local_file WHERE id=?');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const row of db.prepare('SELECT id, path FROM local_file').all()) {
      if (!live.some(r => isUnder(row.path, r))) continue;      // fichero de otra raíz no vigilada ahora
      let gone = false; try { gone = !fs.existsSync(row.path); } catch (e) { gone = false; }
      if (gone) { del.run(row.id); n++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (n && log) log(`poda: ${n} fichero(s) ausente(s) quitado(s)`);
  return n;
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
               EXISTS (SELECT 1 FROM local_file   lf WHERE lf.track_id=tr.id OR lf.recording_id=tr.recording_id)
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

module.exports = { pruneMissingFiles, pruneGraph, isUnder };
