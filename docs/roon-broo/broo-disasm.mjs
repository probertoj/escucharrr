import fs from 'node:fs';
import zlib from 'node:zlib';
const b = zlib.gunzipSync(fs.readFileSync(process.argv[2]));
const want = process.argv[3] || 'component::component_artist_details';
const maxIns = +(process.argv[4] || 40);

let p = 0;
const u8 = () => b[p++];
const i32 = () => { const v = b.readInt32LE(p); p += 4; return v; };
const flexAt = (o) => { let q = o; let f = b[q]; if (f < 128) return [f, q + 1]; let n = 0; for (;;) { const c = b[q++]; n = (n | (c & 0x7f)) >>> 0; if ((c & 0x80) === 0) break; n = (n << 7) >>> 0; } return [n, q]; };
const flex = () => { const [v, q] = flexAt(p); p = q; return v; };
const strAt = (ptr) => { if (!ptr) return null; let [len, q] = flexAt(ptr); return b.toString('utf8', q, q + len); };

// header + directory
p = 32; const dirptr = i32(); p = dirptr; const count = flex();
const OT = { 1: 'String', 2: 'Scope', 3: 'Code', 4: 'ModuleRef', 5: 'MethodRef', 6: 'TypeRef', 7: 'Function' };
const dir = new Map();
for (let i = 0; i < count; i++) { const ns = strAt(flex()), key = strAt(flex()); const t = u8(); const ptr = flex(); dir.set(ns + '::' + key, { type: OT[t], ptr }); }

let ent = /^@\d+$/.test(want)? {type:'Code',ptr:+want.slice(1)} : dir.get(want);
if (!ent) { console.error('no encontrado:', want); process.exit(1); }
console.log('entrada:', want, '→', ent.type, '@', ent.ptr);

// BrooxCode
p = ent.ptr; const regs = i32(); const len = i32(); const initialPC = p; const end = p + len;
console.log('RegisterCount:', regs, '| bytecode len:', len, 'bytes');

// nombres de opcode
const NAME = { 129:'OR',130:'AND',131:'EQ',132:'NE',133:'LE',134:'GE',135:'LT',136:'GT',137:'CONCAT',138:'ADD',139:'SUB',140:'MULT',141:'DIV',142:'MOD',143:'BITAND',
65:'BITOR',66:'NOT',67:'NEGATE',68:'ID',69:'BITNOT',70:'ENUM_GETENUMERATOR',71:'ENUM_MOVENEXT',72:'ENUM_CURRENT',
193:'LIT_INT',194:'LIT_DOUBLE',195:'LIT_TRUE',196:'LIT_FALSE',197:'LIT_STRING',198:'LIT_CUSTOMVAL',199:'LIT_UNDEFINED',200:'LIT_LIST',201:'LIT_TUPLE',202:'LIT_MAP',203:'LIT_FUNC',204:'LIT_EQUATION',205:'LIT_ACTION',206:'LIT_TEMPLATE',
207:'MOV',208:'LOAD',209:'STORE',210:'DEREF_CALL',211:'DEREF_SUBSCRIPT',212:'DEREF_MEMBER',213:'ASSIGN_SUBSCRIPT',214:'ASSIGN_MEMBER',215:'CALL_STATIC',216:'NEWOBJ_STATIC',217:'LAZY_VAL',218:'LOAD_DYNAMIC',219:'STORE_DYNAMIC',220:'ADD_TO_BROOLIST',
1:'LOAD_ARG',2:'BEGIN_ARGS',3:'PUSH_ARG',4:'PUSH_NAMED_ARG',5:'POP_ARGS',6:'EXEC',7:'PUSH_SCOPE',8:'POP_SCOPE',9:'BR_TRUE',10:'BR_FALSE',11:'BR',12:'RETURN',13:'RETURN_UNDEFINED',14:'PUSH_NODEPS',15:'POP_NODEPS',31:'DEBUG_LOC' };

const R = n => 'r' + n, S = p => JSON.stringify(strAt(p)), P = p => '@' + p;
let n = 0;
while (p < end && n < maxIns) {
  const at = p - initialPC; const op = u8(); const tag = op & 0xc0; let args = '';
  if (tag === 0x80) { const a = flex(), c = flex(), d = flex(); args = `${R(a)}, ${R(c)} -> ${R(d)}`; }
  else if (tag === 0x40) { const s = flex(), d = flex(); args = `${R(s)} -> ${R(d)}`; }
  else switch (op) {
    case 193: { const v = flex(), d = flex(); args = `${v} -> ${R(d)}`; break; }
    case 194: { p += 8; const d = flex(); args = `<double> -> ${R(d)}`; break; }
    case 195: case 196: case 199: case 200: case 201: case 202: { const d = flex(); args = `-> ${R(d)}`; break; }
    case 197: { const s = flex(), d = flex(); args = `${S(s)} -> ${R(d)}`; break; }
    case 198: { const s = flex(); p += 4; const d = flex(); args = `${P(s)} -> ${R(d)}`; break; }
    case 203: { const f = flex(), d = flex(); args = `fn${P(f)} -> ${R(d)}`; break; }
    case 204: case 205: { const rc = flex(), cp = flex(), d = flex(); args = `regs=${rc} code${P(cp)} -> ${R(d)}`; break; }
    case 206: { const tr = flex(), rc = flex(), cp = flex(), d = flex(); args = `type${P(tr)} regs=${rc} code${P(cp)} -> ${R(d)}`; break; }
    case 207: { const s = flex(), d = flex(); args = `${R(s)} -> ${R(d)}`; break; }
    case 208: { const sc = flex(), sl = flex(), d = flex(); args = `scope[${sc}].slot[${sl}] -> ${R(d)}`; break; }
    case 209: { const sc = flex(), sl = flex(), s = flex(); args = `${R(s)} -> scope[${sc}].slot[${sl}]`; break; }
    case 210: { const o = flex(), d = flex(); args = `${R(o)}(args) -> ${R(d)}`; break; }
    case 211: { const o = flex(), k = flex(), d = flex(); args = `${R(o)}[${R(k)}] -> ${R(d)}`; break; }
    case 212: { const o = flex(), nm = flex(), d = flex(); args = `${R(o)}.${S(nm)} -> ${R(d)}`; break; }
    case 213: { const o = flex(), k = flex(), v = flex(); args = `${R(o)}[${R(k)}] = ${R(v)}`; break; }
    case 214: { const o = flex(), nm = flex(), v = flex(); args = `${R(o)}.${S(nm)} = ${R(v)}`; break; }
    case 215: { const s = flex(), m = flex(), d = flex(); args = `self=${R(s)} method${P(m)}(args) -> ${R(d)}`; break; }
    case 216: { const m = flex(), d = flex(); args = `new method${P(m)} -> ${R(d)}`; break; }
    case 217: { const cp = flex(), d = flex(); args = `lazy code${P(cp)} -> ${R(d)}`; break; }
    case 218: { const nm = flex(), d = flex(); args = `dyn ${S(nm)} -> ${R(d)}`; break; }
    case 219: { const nm = flex(), s = flex(); args = `${R(s)} -> dyn ${S(nm)}`; break; }
    case 220: { const l = flex(), v = flex(); args = `${R(l)} += ${R(v)}`; break; }
    case 1: { const a = flex(), d = flex(); args = `arg[${a}] -> ${R(d)}`; break; }
    case 2: { const c = flex(); args = `n=${c}`; break; }
    case 3: { const s = flex(); args = `${R(s)}`; break; }
    case 4: { const nm = flex(), s = flex(); args = `${S(nm)}=${R(s)}`; break; }
    case 5: case 8: case 13: case 14: case 15: args = ''; break;
    case 6: { const sc = flex(), cp = flex(), d = flex(); args = `scope${P(sc)} code${P(cp)} -> ${R(d)}`; break; }
    case 7: { const sc = flex(); args = `scope${P(sc)}`; break; }
    case 9: case 10: { const c = flex(); const t = i32(); args = `if ${R(c)} -> +${t}`; break; }
    case 11: { const t = i32(); args = `-> +${t}`; break; }
    case 12: { const r = flex(); args = `${R(r)}`; break; }
    case 31: { const s = flex(), ln = flex(); args = `${S(s)}:${ln}`; break; }
    default: args = '??'; break;
  }
  console.log('  ' + String(at).padStart(5) + ': ' + (NAME[op] || ('0x' + op.toString(16))).padEnd(16) + ' ' + args);
  n++;
}
console.log(p < end ? '  … (' + (end - p) + ' bytes más)' : '  (fin)');
