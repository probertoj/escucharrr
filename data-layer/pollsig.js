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
// carpetas, ~36.000 en vez de ~316.000 operaciones). Limitación asumida: una modificación EN SITIO
// (retaguear un fichero sin cambiar su nombre) no cambia la firma; para eso está «Reescanear ahora».
//
// Semántica de completitud (clave en SMB flojo): si algún readdir falla, la firma NO es fiable
// (sería un subconjunto distinto cada vez → falsos «cambios» en bucle). Devuelve sig=null y
// complete=false; el llamador lo trata como «no concluyente» (ni baseline ni disparo).
const path = require('path');
const crypto = require('crypto');

const AUDIO_RE = /\.(flac|wav|mp3|m4a|ogg|oga|opus|aiff?|dsf|dff|aac)$/i;

// Normalización IGUAL que scan.js/server.js nrm(): clave de ignored_dir (release.source_dir).
function nrmDefault(p) { return path.resolve(p).replace(/[\\/]+/g, '\\').toLowerCase(); }

/**
 * dirSignature(root, opts) → { sig, complete, dirs, files, ms, failed }
 *   sig       : hash sha1 (hex) de nombres (null si la pasada no fue completa)
 *   complete  : true si TODOS los readdir respondieron
 *   dirs      : carpetas listadas; files: audios vistos; ms: duración; failed: carpetas ilegibles (máx. 5 rutas)
 * opts.ignore : Set de carpetas normalizadas (nrm) a SALTAR (copias quitadas por el usuario: sus cambios
 *               no deben disparar reescaneos, igual que el escáner no las re-añade)
 * opts.nrm    : normalizador (por defecto el de scan.js)
 * opts.fsp    : fs.promises inyectable (tests / conteo de operaciones)
 * opts.audioRe: regex de audio (por defecto la de arriba)
 * opts.signal : {aborted:boolean} opcional para cortar la pasada
 */
async function dirSignature(root, opts = {}) {
  const fsp = opts.fsp || require('fs').promises;
  const nrm = opts.nrm || nrmDefault;
  const ignore = opts.ignore || null;
  const audioRe = opts.audioRe || AUDIO_RE;
  const h = crypto.createHash('sha1');
  const t0 = Date.now();
  let dirs = 0, files = 0, complete = true;
  const failed = [];
  const rootAbs = path.resolve(root);

  async function walk(dir, rel) {
    if (opts.signal && opts.signal.aborted) { complete = false; return; }
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (e) { complete = false; if (failed.length < 5) failed.push(dir); return; }   // carpeta ilegible (NAS flojo) → pasada incompleta
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
    for (const name of subdirs) {
      const p = path.join(dir, name);
      if (ignore && ignore.has(nrm(p))) continue;                      // copia quitada → fuera de la firma
      await walk(p, rel + '/' + name);
    }
  }
  await walk(rootAbs, '');
  return { sig: complete ? h.digest('hex') : null, complete, dirs, files, ms: Date.now() - t0, failed };
}

module.exports = { dirSignature, AUDIO_RE, nrm: nrmDefault };
