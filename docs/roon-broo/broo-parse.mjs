import fs from 'node:fs';
import zlib from 'node:zlib';

const gz = fs.readFileSync(process.argv[2]);
const b = zlib.gunzipSync(gz);
console.log('descomprimido:', b.length, 'bytes');

let p = 0;
const i32 = () => { const v = b.readInt32LE(p); p += 4; return v; };
const i64 = () => { const v = b.readBigInt64LE(p); p += 8; return v; };
// FlexInt: big-endian base-128, bit alto = continuación (según Broo.Runtime.BinaryHelper._ReadFlexInt)
const flex = () => {
  let first = b[p];
  if (first < 128) { p++; return first; }
  let num = 0 >>> 0;
  for (;;) { const c = b[p++]; num = (num | (c & 0x7f)) >>> 0; if ((c & 0x80) === 0) break; num = (num << 7) >>> 0; }
  return num;
};
// Runtime string: FlexInt length + UTF-8 (en offset absoluto)
const strAt = (ptr) => { if (!ptr) return null; let q = ptr; let first = b[q]; let len; if (first < 128) { q++; len = first; } else { let n = 0; for (;;) { const c = b[q++]; n = (n | (c & 0x7f)) >>> 0; if ((c & 0x80) === 0) break; n = (n << 7) >>> 0; } len = n; } if (len < 0) return null; return b.toString('utf8', q, q + len); };

// Header
const magic = b.toString('ascii', 0, 4); p = 4;
const version = i32();
const tsRaw = i64();
const guid = b.subarray(16, 32).toString('hex');
p = 32;
const dirptr = i32();
console.log('magic:', JSON.stringify(magic), '| version:', version, '| build_guid:', guid, '| dirptr:', dirptr);
// DateTime.FromBinary: los 2 bits altos son kind; el resto, ticks desde 0001-01-01
const ticks = tsRaw & 0x3fffffffffffffffn;
const ms = Number(ticks / 10000n) - 62135596800000;
console.log('build_timestamp:', new Date(ms).toISOString());

// Directory
p = dirptr;
const count = flex();
console.log('directorio: ', count, 'entradas');
const OT = { 1: 'String', 2: 'Scope', 3: 'Code', 4: 'ModuleRef', 5: 'MethodRef', 6: 'TypeRef', 7: 'Function' };
const entries = [];
for (let i = 0; i < count; i++) {
  const nsPtr = flex(), keyPtr = flex(), type = b[p++], objPtr = flex();
  entries.push({ ns: strAt(nsPtr), key: strAt(keyPtr), type: OT[type] || type, ptr: objPtr });
}
// Resumen: namespaces y conteo por tipo
const byType = {}; const nss = new Set();
for (const e of entries) { byType[e.type] = (byType[e.type] || 0) + 1; nss.add(e.ns); }
console.log('por tipo:', JSON.stringify(byType));
console.log('namespaces (' + nss.size + '):', [...nss].slice(0, 40).join(', '));
console.log('=== 25 entradas de muestra ===');
for (const e of entries.slice(0, 25)) console.log('  ' + e.ns + ' :: ' + e.key + '  [' + e.type + ' @' + e.ptr + ']');
// buscar una pantalla conocida
const hit = entries.filter(e => /album|artist|home|search|queue/i.test((e.ns || '') + (e.key || ''))).slice(0, 12);
console.log('=== entradas de pantallas conocidas ===');
for (const e of hit) console.log('  ' + e.ns + ' :: ' + e.key + '  [' + e.type + ']');
