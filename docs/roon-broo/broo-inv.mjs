import fs from 'node:fs';
import zlib from 'node:zlib';
let b = fs.readFileSync(process.argv[2]);
if (!(b[0] === 0x42 && b[1] === 0x52 && b[2] === 0x4f && b[3] === 0x4f)) b = zlib.gunzipSync(b);   // 'BROO' crudo o gzip
let p = 0;
const i32 = () => { const v = b.readInt32LE(p); p += 4; return v; };
const flex = () => { let first = b[p]; if (first < 128) { p++; return first; } let num = 0 >>> 0; for (;;) { const c = b[p++]; num = (num | (c & 0x7f)) >>> 0; if ((c & 0x80) === 0) break; num = (num << 7) >>> 0; } return num; };
const strAt = (ptr) => { if (!ptr) return null; let q = ptr; let first = b[q]; let len; if (first < 128) { q++; len = first; } else { let n = 0; for (;;) { const c = b[q++]; n = (n | (c & 0x7f)) >>> 0; if ((c & 0x80) === 0) break; n = (n << 7) >>> 0; } len = n; } if (len < 0 || len > 4000) return null; return b.toString('utf8', q, q + len); };
p = 4; i32(); p = 32; const dirptr = i32(); p = dirptr;
const count = flex();
const OT = { 1: 'String', 2: 'Scope', 3: 'Code', 4: 'ModuleRef', 5: 'MethodRef', 6: 'TypeRef', 7: 'Function' };
const entries = [];
for (let i = 0; i < count; i++) { const nsPtr = flex(), keyPtr = flex(), type = b[p++], objPtr = flex(); entries.push({ ns: strAt(nsPtr) || '', key: strAt(keyPtr) || '', type: OT[type] || type, ptr: objPtr }); }

const mode = process.argv[3] || 'components';
if (mode === 'ns') {
  const byNs = {}; for (const e of entries) byNs[e.ns] = (byNs[e.ns] || 0) + 1;
  for (const [ns, n] of Object.entries(byNs).sort((a, c) => c[1] - a[1])) console.log(n + '\t' + ns);
} else if (mode === 'components') {
  // todas las claves component_* / dialog_* / view_* / settings_* / browser / edit_
  const re = /component_|dialog_|view_all|settings_|_browser|^edit_|browse|screen|overlay|popup|_menu|wizard/i;
  const hits = entries.filter(e => re.test(e.key) || re.test(e.ns));
  const seen = new Set();
  for (const e of hits) { const k = (e.ns + '::' + e.key); if (seen.has(k)) continue; seen.add(k); console.log(e.key + '   [' + e.ns + ']'); }
  console.log('--- total hits:', seen.size);
} else if (mode === 'grep') {
  const pat = new RegExp(process.argv[4], 'i');
  for (const e of entries) if (pat.test(e.key) || pat.test(e.ns)) console.log(e.key + '   [' + e.ns + ' / ' + e.type + ']');
} else if (mode === 'comp') {
  for (const e of entries.filter(e => e.ns === 'component').sort((a, c) => a.key.localeCompare(c.key))) console.log(e.key);
} else if (mode === 'strings') {
  for (const e of entries.filter(e => e.ns === 'string').sort((a, c) => a.key.localeCompare(c.key))) { const v = e.type === 'String' ? strAt(e.ptr) : null; console.log(e.key + '\t' + (v || '').replace(/\n/g, ' ')); }
}
