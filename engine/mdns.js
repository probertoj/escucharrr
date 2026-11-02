'use strict';
// escucharrr — descubrimiento mDNS (multicast DNS) SIN dependencias, para ver los dispositivos
// Chromecast (_googlecast._tcp) y AirPlay (_airplay._tcp / _raop._tcp) de la red local, como
// Roon muestra sus zonas. Solo DESCUBRE (nombre/ip/puerto); reproducir en ellos usa protocolos
// propietarios (cast/airplay) que no se implementan aquí. DLNA/UPnP se descubre aparte (SSDP).
const dgram = require('dgram');

const SERVICES = [
  { q: '_googlecast._tcp.local', kind: 'chromecast' },
  { q: '_airplay._tcp.local', kind: 'airplay' },
  { q: '_raop._tcp.local', kind: 'airplay' },
];

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bufs = parts.map(p => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}
function buildQuery() {
  const header = Buffer.alloc(12); header.writeUInt16BE(SERVICES.length, 4);   // qdcount
  const qs = SERVICES.map(s => { const n = encodeName(s.q); const t = Buffer.alloc(4); t.writeUInt16BE(12, 0); t.writeUInt16BE(0x8001, 2); return Buffer.concat([n, t]); });   // PTR, QU+IN
  return Buffer.concat([header, ...qs]);
}
// lee un nombre DNS (con compresión por punteros)
function readName(buf, off) {
  const labels = []; let jumped = false, end = off, guard = 0;
  while (guard++ < 128) {
    const len = buf[off];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) { const ptr = ((len & 0x3f) << 8) | buf[off + 1]; if (!jumped) end = off + 2; off = ptr; jumped = true; continue; }
    if (len === 0) { if (!jumped) end = off + 1; break; }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len)); off += 1 + len; if (!jumped) end = off;
  }
  return { name: labels.join('.'), off: end };
}
function parse(buf) {
  const recs = [];
  try {
    const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
    let off = 12;
    for (let i = 0; i < qd; i++) { const r = readName(buf, off); off = r.off + 4; }
    const total = an + ns + ar;
    for (let i = 0; i < total; i++) {
      const nm = readName(buf, off); off = nm.off;
      const type = buf.readUInt16BE(off); const rdlen = buf.readUInt16BE(off + 8); const rdoff = off + 10;
      const rec = { name: nm.name, type };
      if (type === 12) rec.ptr = readName(buf, rdoff).name;                         // PTR -> instancia
      else if (type === 1) rec.a = `${buf[rdoff]}.${buf[rdoff + 1]}.${buf[rdoff + 2]}.${buf[rdoff + 3]}`;   // A -> ip
      else if (type === 33) { rec.port = buf.readUInt16BE(rdoff + 4); rec.target = readName(buf, rdoff + 6).name; }   // SRV
      recs.push(rec); off = rdoff + rdlen;
    }
  } catch (e) {}
  return recs;
}

function discover({ timeoutMs = 2500 } = {}) {
  return new Promise(resolve => {
    const byInstance = new Map();   // instancia -> {name, kind, port, target}
    const aByHost = new Map();      // host -> ip
    const kindOf = n => SERVICES.find(s => n.endsWith(s.q)) || null;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return; done = true; try { sock.close(); } catch (e) {}
      const out = [];
      for (const [inst, d] of byInstance) {
        const ip = d.target && aByHost.get(d.target) || null;
        const label = inst.replace(/\._(googlecast|airplay|raop)\._tcp\.local$/i, '').replace(/\\032/g, ' ');
        out.push({ id: 'mdns:' + inst, name: label || inst, kind: d.kind, ip, port: d.port || null, castable: d.kind === 'chromecast' });
      }
      resolve(out);
    };
    sock.on('message', msg => {
      for (const r of parse(msg)) {
        const k = kindOf(r.name);
        if (r.type === 12 && r.ptr && k) { if (!byInstance.has(r.ptr)) byInstance.set(r.ptr, { kind: k.kind }); }
        else if (r.type === 33) { const e = byInstance.get(r.name); if (e) { e.port = r.port; e.target = r.target; } }
        else if (r.type === 1) aByHost.set(r.name, r.a);
      }
    });
    sock.on('error', () => finish());   // p. ej. 5353 ocupado (otro servicio mDNS): devolvemos lo que haya
    // Bindear a 5353 (con reuseAddr) y unirse al grupo para captar las respuestas multicast.
    sock.bind(5353, () => {
      try { sock.setMulticastTTL(255); } catch (e) {}
      try { sock.addMembership('224.0.0.251'); } catch (e) {}
      const q = buildQuery();
      const send = () => { try { sock.send(q, 5353, '224.0.0.251'); } catch (e) {} };
      send(); setTimeout(send, 450); setTimeout(send, 1100);
      setTimeout(finish, timeoutMs);
    });
  });
}
module.exports = { discover };
