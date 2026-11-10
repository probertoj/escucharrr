'use strict';
// Firma BARATA de cambios de una carpeta de música para el sondeo de carpetas de red (SMB/UNC),
// donde fs.watch recursivo no funciona y hay que preguntar periódicamente «¿ha cambiado algo?».
//
// Por qué así: la firma anterior hacía readdir de cada carpeta Y stat de CADA fichero de audio
// (Σmtime+Σtamaño). En un NAS con ~280.000 audios eso son ~280.000 round-trips SMB por pasada,
// cada 30 s → el share quedaba saturado de forma sostenida (y el Diskstation se cae bajo esa carga).
//
// Esta firma solo lista carpetas (readdir con tipos) y resume los NOMBRES: carpetas y ficheros de
// audio, por carpeta. Detecta lo que importa a la biblioteca —añadir, borrar, mover y renombrar
// ficheros o carpetas a cualquier profundidad— con ~0 stats (una pasada = tantos readdir como
// carpetas, ~75.000 en vez de ~350.000 operaciones). Limitación asumida: una modificación EN SITIO
// (retaguear un fichero sin cambiar su nombre) no cambia la firma; para eso está «Reescanear ahora».
//
// Carpetas ILEGIBLES: un readdir que falla se devuelve en `failed` (ruta + código) y entra en la firma
// como token «!código»; `complete=false` avisa de que hubo fallos y `failedKey` identifica el conjunto.
// El llamador (server.js) las pone en CUARENTENA: en las pasadas siguientes van en `opts.ignore`, así que
// su nombre sigue contando en la carpeta madre pero no se desciende a ellas. Resultado: que una carpeta
// flaquee (ilegible una vez, legible la siguiente) no cambia la firma ni dispara reescaneos; arreglarla
// de verdad en el NAS (renombrar/fusionar) sí, porque cambian los nombres de la carpeta madre.
// Colisiones de mayúsculas: nombres que solo difieren en mayúsculas dentro de la misma carpeta se
// reportan (`collisions`, lista COMPLETA hasta MAX_LIST) porque son la causa típica de esas carpetas
// ilegibles (un NAS Linux las distingue; el cliente SMB de Windows resuelve la ruta a una sola y la otra
// da ENOENT) y el usuario puede arreglarlas en el NAS.
const path = require('path');
const crypto = require('crypto');

const AUDIO_RE = /\.(flac|wav|mp3|m4a|ogg|oga|opus|aiff?|dsf|dff|aac)$/i;
const MAX_LIST = 20000;   // tope de entradas devueltas en failed/collisions (los contadores son completos)

// Normalización IGUAL que scan.js/server.js nrm(): clave de ignored_dir (release.source_dir).
function nrmDefault(p) { return path.resolve(p).replace(/[\\/]+/g, '\\').toLowerCase(); }

/**
 * dirSignature(root, opts) → { sig, complete, failed, failedCount, failedKey, collisions, collisionCount, dirs, files, ms }
 *   sig        : sha1 (hex) de nombres (+ tokens de fallo); null solo si la pasada se abortó (opts.signal)
 *   complete   : true si TODOS los readdir respondieron
 *   failed     : [{dir, code}] carpetas ilegibles (hasta MAX_LIST); failedCount: total; failedKey: sha1 del conjunto (null si ninguna)
 *   collisions : [{dir, names:[{name, isDir}]}] grupos de nombres que solo difieren en mayúsculas en la misma carpeta (hasta MAX_LIST); collisionCount: total de grupos
 *   dirs/files : carpetas listadas / audios vistos; ms: duración
 * opts.ignore  : Set de carpetas normalizadas (nrm) a NO DESCENDER (copias quitadas por el usuario, carpetas en cuarentena);
 *                su nombre sigue contando en la carpeta madre
 * opts.nrm     : normalizador (por defecto el de scan.js)
 * opts.fsp     : fs.promises inyectable (tests / conteo de operaciones)
 * opts.audioRe : regex de audio (por defecto la de arriba)
 * opts.signal  : {aborted:boolean} opcional para cortar la pasada
 */
async function dirSignature(root, opts = {}) {
  const fsp = opts.fsp || require('fs').promises;
  const nrm = opts.nrm || nrmDefault;
  const ignore = opts.ignore || null;
  const audioRe = opts.audioRe || AUDIO_RE;
  const h = crypto.createHash('sha1');
  const t0 = Date.now();
  let dirs = 0, files = 0, aborted = false, failedCount = 0, collisionCount = 0;
  const failed = [], collisions = [];
  const rootAbs = path.resolve(root);

  async function walk(dir, rel) {
    if (opts.signal && opts.signal.aborted) { aborted = true; return; }
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) {   // carpeta ilegible: se devuelve para que el llamador la ponga en cuarentena
      const code = (e && e.code) || 'ERR';
      failedCount++; if (failed.length < MAX_LIST) failed.push({ dir, code });
      h.update(rel + '\0!' + code + '\n');
      return;
    }
    dirs++;
    // Orden determinista: Samba/NTFS no garantizan el mismo orden entre llamadas.
    const subdirs = [], names = [];
    for (const e of ents) {
      let isDir = false; try { isDir = e.isDirectory(); } catch (x) {}
      if (isDir) { subdirs.push(e.name); }
      else if (audioRe.test(e.name)) { names.push(e.name); files++; }
    }
    subdirs.sort(); names.sort();
    h.update(rel + '\0d:' + subdirs.join('\u0001') + '\0f:' + names.join('\u0001') + '\n');
    // Colisiones de mayúsculas entre hermanos (carpetas y audios): en un NAS Linux pueden convivir; Windows solo «ve» una.
    const low = new Map();
    for (const n of subdirs) { const k = n.toLowerCase(); if (!low.has(k)) low.set(k, []); low.get(k).push({ name: n, isDir: true }); }
    for (const n of names) { const k = n.toLowerCase(); if (!low.has(k)) low.set(k, []); low.get(k).push({ name: n, isDir: false }); }
    for (const g of low.values()) if (g.length > 1) { collisionCount++; if (collisions.length < MAX_LIST) collisions.push({ dir, names: g }); }
    for (const name of subdirs) {
      const p = path.join(dir, name);
      if (ignore && ignore.has(nrm(p))) continue;                      // copia quitada / cuarentena → no se desciende
      await walk(p, rel + '/' + name);
    }
  }
  await walk(rootAbs, '');
  const complete = failedCount === 0 && !aborted;
  const failedKey = failedCount ? crypto.createHash('sha1').update(failed.map(f => f.dir + '|' + f.code).sort().join('\n') + '\n#' + failedCount).digest('hex') : null;
  return { sig: aborted ? null : h.digest('hex'), complete, failed, failedCount, failedKey, collisions, collisionCount, dirs, files, ms: Date.now() - t0 };
}

// Texto de un grupo de colisión para logs/UI: «…\carpeta\A ↔ a».
function collisionText(c) { return path.join(c.dir, c.names[0].name) + c.names.slice(1).map(n => ' ↔ ' + n.name).join(''); }

module.exports = { dirSignature, collisionText, AUDIO_RE, nrm: nrmDefault, MAX_LIST };
