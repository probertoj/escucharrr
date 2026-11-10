'use strict';
// escucharrr — número de pista (y de disco) a partir del NOMBRE del fichero.
// Solo se usa cuando el fichero no trae una etiqueta TRACKNUMBER válida (WAV/FLAC sin etiquetar, pista «0»,
// vinilos etiquetados «A1»…). Antes el escáner ponía ahí su contador global de ficheros: posiciones como
// 237516, distintas en cada escaneo. Sin dependencias; funciones puras (testeables sin BD).

const SEP = '[-–—]';   // guion, raya corta o larga

// base: nombre del fichero (con o sin extensión). Devuelve null si no se deduce nada, o:
//   { kind: 'disco-pista', disc, track, rest }   «01 - 05 - Título», «4-05 Título»
//   { kind: 'inicial', track }                   «06 Título», «14. Título», «05-título»
//   { kind: 'vinilo', side, n, rest }            «B1 Título», «A2 - Título», caras A–L  (la posición sale de vinylOrder)
//   { kind: 'intermedio', track }                «Artista - Álbum - 05 - Título», «Artista_Álbum_05_Título»
// `rest` = el nombre sin la numeración, para deducir el título cuando tampoco hay etiqueta TITLE.
function fromName(base) {
  const n = String(base || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  let m;
  // disco - pista - título (dos números separados por guion con espacios, y luego otro guion)
  if ((m = new RegExp('^\\s*(\\d{1,2})\\s+' + SEP + '\\s+(\\d{1,3})\\s+' + SEP + '\\s+(\\S.*)$').exec(n)) && +m[1] >= 1 && +m[1] <= 20 && +m[2] <= 199)
    return { kind: 'disco-pista', disc: +m[1], track: +m[2], rest: m[3] };
  // disco-pista pegados: «4-05 Título»
  if ((m = /^\s*(\d{1,2})-(\d{2})[\s._-]+(\S.*)$/.exec(n)) && +m[1] >= 1 && +m[1] <= 20)
    return { kind: 'disco-pista', disc: +m[1], track: +m[2], rest: m[3] };
  // número inicial: «06 Título», «14. Título», «05-título», «07_título», «3) Título»
  if ((m = new RegExp('^\\s*(\\d{1,3})\\s*(?:[._)]|' + SEP + '|\\s)\\s*\\S').exec(n)) && +m[1] <= 199)
    return { kind: 'inicial', track: +m[1] };
  // solo el número: «06.mp3»
  if ((m = /^\s*(\d{1,3})\s*$/.exec(n)) && +m[1] <= 199)
    return { kind: 'inicial', track: +m[1] };
  // vinilo: cara + número («A1», «b2»); hasta la cara L (cajas de 6 LP)
  if ((m = new RegExp('^\\s*([A-La-l])(\\d{1,2})\\s*(?:[._)]|' + SEP + '|\\s)\\s*(\\S.*)$').exec(n)) && +m[2] >= 1 && +m[2] <= 30)
    return { kind: 'vinilo', side: m[1].toUpperCase(), n: +m[2], rest: m[3] };
  // número en medio, entre separadores: «… - 05 - Título», «…_05_Título»
  if ((m = new RegExp('(?:\\s' + SEP + '\\s|_)(\\d{1,3})(?:\\s' + SEP + '\\s|_)\\S').exec(n)) && +m[1] <= 199)
    return { kind: 'intermedio', track: +m[1] };
  // «Artista - 05 Título» (exactamente dos cifras tras « - »)
  if ((m = new RegExp('\\s' + SEP + '\\s(\\d{2})\\s+\\S').exec(n)))
    return { kind: 'intermedio', track: +m[1] };
  return null;
}

// Posición de las pistas de vinilo de UNA carpeta: A1, A2, B1… → 1, 2, 3… (orden por cara y número).
// names: nombres de fichero de la carpeta. Devuelve Map<nombre, posición> solo para los de tipo vinilo.
function vinylOrder(names) {
  const v = [];
  for (const nm of names) { const r = fromName(nm); if (r && r.kind === 'vinilo') v.push({ nm, side: r.side, n: r.n }); }
  v.sort((a, b) => a.side < b.side ? -1 : a.side > b.side ? 1 : a.n - b.n || (a.nm < b.nm ? -1 : 1));
  const out = new Map();
  v.forEach((x, i) => out.set(x.nm, i + 1));
  return out;
}

// Etiqueta TRACKNUMBER válida = entero entre 1 y 999 («5», «05», «5/12»). «0», vacía, «A1» o un número
// disparatado («143512», que algún gestor escribió en la etiqueta) no lo son.
function tagNumber(tag) { const k = parseInt(tag, 10); return Number.isFinite(k) && k >= 1 && k <= 999 ? k : null; }

module.exports = { fromName, vinylOrder, tagNumber };
