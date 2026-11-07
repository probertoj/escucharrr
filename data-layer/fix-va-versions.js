'use strict';
// escucharrr — repara los recopilatorios (Various Artists) que versiones-por-carpeta
// sobre-dividió en N «versiones» falsas.
//
// Causa: una MISMA compilación cuyas pistas están repartidas en carpetas (por artista de
// cada pista, o por disco), más alguna copia duplicada, crea un `release` por carpeta. Un
// comp de 18 pistas filetadas por artista aparecía como 18 «versiones» de un álbum de 18.
//
// Arreglo (solo grupos cuyo artista de álbum es Various Artists): ensamblar UN solo release
// por release_group, con un `medium` por número de disco, reuniendo las pistas de todas las
// carpetas. Las pistas duplicadas (misma grabación en el mismo disco: copias repetidas) se
// funden y sus ficheros se reapuntan a la pista superviviente. No borra ficheros ni toca el
// disco; solo reescribe filas release/medium/track y reapunta local_file.track_id.
//
// Uso:  node data-layer/fix-va-versions.js --db <ruta> [--apply] [--dry-run]
//   Por defecto es dry-run (no escribe). --apply ejecuta dentro de una transacción.
//   El servidor NO debe correr contra la misma BD al aplicar.

const { DatabaseSync } = require('node:sqlite');

function parseArgs(argv) {
  const a = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--db') a.db = argv[++i];
    else if (v === '--apply') a.apply = true;
    else if (v === '--dry-run') a.apply = false;
  }
  return a;
}

function run(dbPath, apply, log = console.log) {
  const db = new DatabaseSync(dbPath);
  const vaCredits = db.prepare(`SELECT DISTINCT acn.artist_credit_id id
      FROM artist_credit_name acn JOIN artist a ON a.id=acn.artist_id
      WHERE a.name IN ('Various Artists','Varios Artistas','VA')`).all().map(r => r.id);
  if (!vaCredits.length) { log('No hay crédito «Various Artists»; nada que hacer.'); db.close(); return { groups: 0 }; }
  const ph = vaCredits.map(() => '?').join(',');
  const groups = db.prepare(`SELECT rg.id, rg.title,
      (SELECT COUNT(*) FROM "release" r WHERE r.release_group_id=rg.id) nrel
    FROM release_group rg WHERE rg.artist_credit_id IN (${ph})`).all(...vaCredits)
    .filter(g => g.nrel > 1);

  const Q = {
    rels: db.prepare('SELECT id, source_dir, date, format FROM "release" WHERE release_group_id=? ORDER BY id'),
    trkCount: db.prepare('SELECT COUNT(*) n FROM track t JOIN medium m ON m.id=t.medium_id WHERE m.release_id=?'),
    media: db.prepare('SELECT id, position, format FROM medium WHERE release_id=? ORDER BY position, id'),
    tracks: db.prepare('SELECT id, position, recording_id FROM track WHERE medium_id=? ORDER BY position, id'),
    tgtTrackByRec: db.prepare('SELECT id FROM track WHERE medium_id=? AND recording_id=? LIMIT 1'),
    maxPos: db.prepare('SELECT COALESCE(MAX(position),0) p FROM track WHERE medium_id=?'),
    posTaken: db.prepare('SELECT id FROM track WHERE medium_id=? AND position=? LIMIT 1'),
    insMed: db.prepare('INSERT INTO medium(release_id,position,format) VALUES(?,?,?)'),
    moveTrack: db.prepare('UPDATE track SET medium_id=?, position=? WHERE id=?'),
    repointFiles: db.prepare('UPDATE local_file SET track_id=? WHERE track_id=?'),
    delTrack: db.prepare('DELETE FROM track WHERE id=?'),
    delMedium: db.prepare('DELETE FROM medium WHERE id=?'),
    delRelease: db.prepare('DELETE FROM "release" WHERE id=?'),
    firstDate: db.prepare(`SELECT date FROM "release" WHERE release_group_id=? AND date IS NOT NULL AND date<>'' ORDER BY length(date) DESC, date LIMIT 1`),
    setRelDate: db.prepare('UPDATE "release" SET date=? WHERE id=?'),
  };

  let merged = 0, releasesRemoved = 0, tracksDeduped = 0, mediaCreated = 0;
  if (apply) db.exec('BEGIN');
  try {
    for (const g of groups) {
      const rels = Q.rels.all(g.id);
      if (rels.length < 2) continue;
      // release objetivo = el de más pistas (desempate: id menor)
      let target = rels[0], targetN = Q.trkCount.get(target.id).n;
      for (const r of rels) { const n = Q.trkCount.get(r.id).n; if (n > targetN) { target = r; targetN = n; } }
      const tgtMediaByDisc = new Map();
      for (const m of Q.media.all(target.id)) if (!tgtMediaByDisc.has(m.position)) tgtMediaByDisc.set(m.position, m.id);

      for (const r of rels) {
        if (r.id === target.id) continue;
        for (const m of Q.media.all(r.id)) {
          let tgtMed = tgtMediaByDisc.get(m.position);
          if (!tgtMed) {
            if (apply) tgtMed = Number(Q.insMed.run(target.id, m.position, m.format || target.format).lastInsertRowid);
            else tgtMed = -1 - mediaCreated; // id ficticio en dry-run
            tgtMediaByDisc.set(m.position, tgtMed);
            mediaCreated++;
          }
          for (const t of Q.tracks.all(m.id)) {
            const dup = apply ? Q.tgtTrackByRec.get(tgtMed, t.recording_id) : null;
            if (dup) {
              // misma grabación ya en el disco destino: funde y reapunta ficheros
              Q.repointFiles.run(dup.id, t.id);
              Q.delTrack.run(t.id);
              tracksDeduped++;
            } else if (apply) {
              let pos = t.position;
              if (Q.posTaken.get(tgtMed, pos)) pos = Q.maxPos.get(tgtMed).p + 1;
              Q.moveTrack.run(tgtMed, pos, t.id);
            }
          }
          if (apply) Q.delMedium.run(m.id);
        }
        if (apply) Q.delRelease.run(r.id);
        releasesRemoved++;
      }
      // fecha del release objetivo: la más completa del grupo (para «En este día»)
      if (apply) { const d = Q.firstDate.get(g.id); if (d && d.date) Q.setRelDate.run(d.date, target.id); }
      merged++;
    }
    if (apply) db.exec('COMMIT');
  } catch (e) { if (apply) db.exec('ROLLBACK'); db.close(); throw e; }

  const out = { groups: groups.length, merged, releasesRemoved, tracksDeduped, mediaCreated };
  log(`${apply ? 'APLICADO' : 'DRY-RUN'}: grupos VA con >1 release=${out.groups}; fusionados=${out.merged}; releases retirados=${out.releasesRemoved}; pistas duplicadas fundidas=${out.tracksDeduped}; medios creados=${out.mediaCreated}`);
  db.close();
  return out;
}

if (require.main === module) {
  const a = parseArgs(process.argv);
  if (!a.db) { console.error('Falta --db <ruta>'); process.exit(2); }
  run(a.db, a.apply);
}
module.exports = { run };
